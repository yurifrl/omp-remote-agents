# omp-remote-agents

omp extension: run delegated subagent work on the **ax substrate** (agent-substrate
gVisor actors on the home Talos cluster) while keeping omp's native `task`
experience — agent rows in the Tern UI, background execution, `agent://`
output, parent steering.

## How it works

Native `task` stays in charge. This package adds two things:

1. **`remote_run` tool** — executes the assignment as an ax Task running a
   headless omp inside the sandbox actor.
2. **`remote-ax` proxy agent** — a native task agent whose only job is to
   forward its assignment to `remote_run` and relay the result. Delegating to
   it via `task` gives you a real subagent: Tern agent row, live progress,
   `agent://` output, steerable.

## Install

```bash
# 1. Module: symlink the package into the auto-discovered extensions dir
ln -s /path/to/omp-remote-agents ~/.omp/agent/extensions/omp-remote-agents

# 2. Proxy agent: symlink into the user agents dir
ln -s /path/to/omp-remote-agents/agents/remote-ax.md ~/.omp/agent/agents/remote-ax.md
```

(Instead of step 2, the whole package dir can be listed in the settings
`extensions:` array — extension packages' `agents/` dirs are discovered from
those roots. The explicit user-agents-dir symlink is the reliable path.)

## Configuration

Global: `~/.omp/agent/remote-agents.json`. Project overlay:
`./.omp/remote-agents.json` (runners merge by name, project `defaultRunner`
wins).

```jsonc
{
    "defaultRunner": "ax",
    "runners": {
        "ax": {
            "type": "ax",
            // Task-runner image the actor boots (must contain ax-task-runner).
            "image": "ghcr.io/yurifrl/ax/ax-task-runner@sha256:a249fde…",
            "ax": ["--context", "admin@talos-default"], // optional argv prefix for ax CLI
            "namespace": "ax-system",                   // where ax-server runs
            "atespace": "default",                      // Task atespace
            "envPassthrough": ["*_API_KEY", "*_TOKEN"],
            "model": "google/gemini-2.5-pro",           // default model; per-item spec.model wins
            "timeoutMs": 1200000
        }
    }
}
```

`remote_run` runner resolution: explicit `runner` param → `defaultRunner` →
the single configured runner. Anything else errors listing the configured
names.

## What runs inside the actor

An ax `ax.io/v1alpha1 Task` is applied with a tiny fixed boot-stub command
(agent-substrate actors, gVisor sandbox), resumed, then the payload — host-cwd
tarball plus a generated entry script — is staged via a single `ax ssh` stdin
stream (the stub extracts it to `/workspace` and executes the entry script).
Output is polled via `ax ssh -- cat` until the entry script writes the
sentinel-delimited result to `/workspace/omp-result.txt`; the task is then
deleted. The payload must ride ssh, never the Task manifest: ax's reconciler
embeds the whole Task YAML in the actor template's `AX_TASK_YAML` env, and
substrate caps every env value at 32 KiB. Env passthrough is therefore
expanded inside the entry script, not declared as Task env; the host cwd is
unavailable inside the sandbox (staged config only — config.yml, models.yml,
settings.json, auth/*).

## Command mode

`remote_run` accepts an optional `command` (mutually exclusive with `task`): a
plain shell command runs in the sandbox instead of a remote omp session — same
staging, result-file, and cleanup plumbing, no `bun`/model-API dependency. The
`remote-ax` proxy agent treats assignments starting with `!` as command mode.

`scripts/run.ts` is a CLI wrapper over the same runner, for use when the
loaded extension is stale (schema has no `command` yet):

```bash
bun run scripts/run.ts --command 'uname -a'   # or --task '<prompt>'
```

It prints the remote output on stdout and lifecycle progress on stderr.

## Verification

```bash
bun run smoke:load   # offline: remote_run registers, schema parses, full ax lifecycle runs against a stub `ax` CLI
bun run e2e:egress   # live: apply → policy → resume → stage → guest HTTPS probe (set KUBECONFIG; E2E_IMAGE overrides the image)
```

## Egress

The ax runner provisions the spawned actor's Substrate `default`
`EgressPolicy` between `ax apply` and the first resume (Substrate reads it
once at the guest's first DNS query and caches it for the actor's lifetime;
a policy created after boot is never picked up). Rules are **TLS
passthrough by SNI hostname** — TLS is forwarded without decryption, so the
guest's stock trust store works; no gateway-CA provisioning in the image is
needed. (Per the substrate contract the egress gateway first requires an
actor-identity client cert from the worker's atunnel — see Known gaps for
the observed behavior on the current chart build.)

```jsonc
// ~/.omp/agent/remote-agents.json
{
    "runners": {
        "ax": {
            "type": "ax",
            "image": "ghcr.io/yurifrl/task-arch-probe:v1",
            "egress": {
                "rules": [
                    { "hostnames": ["api.anthropic.com", "api.openai.com"] },
                    { "hostnames": ["*.example.com"], "ports": [443] }
                ]
            }
        }
    }
}
```

Implementation: a minimal hand-rolled protobuf encoder speaks directly to
the `ateapi.Control` gRPC service through a kubectl port-forward, with the
`ax-server` ServiceAccount token minted via `kubectl create token`
(`src/egress.ts`). Any hostname not in a rule stays denied — Substrate is
deny-by-default.

## Known gaps

- Setup notes for this cluster: the `atelet` DaemonSet must run on the
  worker's node (worker reports capacity through `ateom-support.sock`); the
  `ax` CLI hardcodes a 15 s resume deadline that races cold provisioning
  (~80 s first boot, template + golden restore) — use `~/.local/bin/axresume`
  (120 s deadline, ships separately) or tolerate `DeadlineExceeded` and poll
  the task phase; the atenet-router lazily caches actor routes (restart the
  deployment or retry if `ax ssh` reports `error resuming actor` right after
  boot).
- **Egress data path (verified on `admin@talos-default-lan`, agentgateway
  `v1.7.0-alpha.1`)**: policy management works end-to-end (token →
  port-forward → `CreateActorEgressPolicy` OK for live actors), the policy
  is read at the guest's first DNS query (principal
  `spiffe://…/sa/atelet`, all rules returned), and DNS lifts (guest resolves
  all policy hostnames). The TLS hop then fails: the egress gateway's 8443
  bind requires client mTLS against the **Actor Identity CA** — by design;
  the connection must carry an actor cert minted via atelet's
  `MintActorCertificate` and presented by **atunnel** in the worker pod
  (`substrate@v0.5.0 docs/network-egress.md`), with identity verified
  *before* any `GetActorEgressPolicy` call. Our guests present no valid
  actor-identity cert (gateway aborts handshakes with
  `TLSV13_ALERT_CERTIFICATE_REQUIRED`, zero gateway-originated policy
  lookups in ate-api logs; outbound DNS+TCP from the egress pod's netns
  works), so `substrateEgressActorResolution` never runs and the guest sees
  `[Errno 104] Connection reset by peer`. Root cause is upstream of the
  gateway: the guest image / worker path never runs the substrate egress
  preparation (`PrepareEgress` → `MintActorCertificate`), so nothing dials
  the gateway with the required `spiffe://substrate-actor.local/worker-for-actor/…`
  identity. Note the "dynamic MITM CA" on the bind is the intercept side of
  this same config (the design doc's TLS passthrough applies to the
  allowed-hostname leg once identity passes). Runner wiring is correct;
  unblocking guest HTTPS needs a guest/runtime whose worker presents the
  actor cert (bun-capable image on the substrate ateom runtime, or a chart
  version whose golden actor path wires atunnel egress).
- The `ghcr.io/yurifrl/ax/ax-task-runner` image ships **no bun** (Python
  3.12-based). Remote-omp mode (`bun x @oh-my-pi/pi-coding-agent`) needs a
  bun-capable image on this cluster; command mode works with this image.
- No orphan cleanup if the host dies mid-run: ax cleanup is in the `finally`
  path only.
- A runner-side timeout kills the CLI but the actor keeps running until the
  Task's own bounds.
