# omp-remote-agents

omp extension: run delegated subagent work in **remote runtimes** (Apple
Containers, Kubernetes, generic commands) while keeping omp's native `task`
experience — agent rows in the Tern UI, background execution, `agent://`
output, parent steering.

## How it works

Native `task` stays in charge. This package adds two things:

1. **`remote_run` tool** — resolves a runner from config and executes the
   assignment as a headless `omp -p <task>` session inside the runtime.
2. **`remote-*` proxy agents** (`remote-container`, `remote-k8s`,
   `remote-command`) — native task agents whose only job is to forward their
   assignment to `remote_run` and relay the result. Delegating to one of them
   via `task` gives you a real subagent: Tern agent row, live progress,
   `agent://` output, steerable.

The runner is a port (`RemoteRunner`), not a hardcoded backend — plugging a
future runtime means implementing one interface, never touching the extension
core.

## Install

```bash
# 1. Module: symlink the package into the auto-discovered extensions dir
ln -s /path/to/omp-remote-agents ~/.omp/agent/extensions/omp-remote-agents

# 2. Proxy agents: symlink the shipped agents/ into the user agents dir
ln -s /path/to/omp-remote-agents/agents/remote-container.md ~/.omp/agent/agents/remote-container.md
ln -s /path/to/omp-remote-agents/agents/remote-k8s.md ~/.omp/agent/agents/remote-k8s.md
ln -s /path/to/omp-remote-agents/agents/remote-command.md ~/.omp/agent/agents/remote-command.md
```

(Instead of step 2, the whole package dir can be listed in the settings
`extensions:` array — extension packages' `agents/` dirs are discovered from
those roots. The explicit user-agents-dir symlinks are the reliable path.)

## Configuration

Global: `~/.omp/agent/remote-agents.json`. Project overlay:
`./.omp/remote-agents.json` (runners merge by name, project `defaultRunner`
wins).

```jsonc
{
    "defaultRunner": "container",   // optional: runner used when remote_run omits `runner`
    "runners": {
        "container": {
            "type": "container",
            "image": "oven/bun:1",
            // optional: argv before `-p <task>`. Default:
            "command": ["bun", "x", "@oh-my-pi/pi-coding-agent@latest"],
            // optional: env names/globs passed into the runtime (default:
            // ["*_API_KEY", "API_KEY", "*_TOKEN"]) — secrets stay in host env,
            // never baked into images
            "envPassthrough": ["*_API_KEY", "*_TOKEN"],
            "memory": "4G",                  // container VM memory; default 4G — bun install of omp needs more than the VM default
            "cpus": 4,                       // container VM CPUs; default 4
            "timeoutMs": 900000
        },
        "k8s": {
            "type": "k8s",
            "image": "oven/bun:1",
            "namespace": "default",       // ConfigMap + pod land here
            "kubectl": ["kubectl"],       // or full argv prefix for kubectl flags
            "memory": "4Gi",              // pod memory request/limit (request 2Gi / limit 4Gi default)
            "cpus": 4,                    // pod CPU request/limit (request 2 / limit 4 default)
            "timeoutMs": 900000
        },
        "ax": {
            "type": "ax",
            // Task-runner image the actor boots (must contain ax-task-runner).
            "image": "ghcr.io/yurifrl/ax/ax-task-runner@sha256:a249fde…",
            "ax": ["--context", "admin@talos-default"], // optional argv prefix for ax CLI
            "namespace": "ax-system",                   // where ax-server runs
            "atespace": "default",                      // Task atespace
            "envPassthrough": ["*_API_KEY", "*_TOKEN"],
            "timeoutMs": 1200000
        },
        "anything": {
            "type": "command",
            // {task} {model} {cwd} {id} tokens are substituted; or set
            // promptStdin to pass the task on stdin instead
            "command": ["/path/to/my-runtime-launcher", "--task", "{task}"],
            "timeoutMs": 600000
        }
    }
}
```

`remote_run` runner resolution: explicit `runner` param → `defaultRunner` →
the single configured runner. Anything else errors listing the configured
names.

## What runs inside the runtime

`omp -p <task>` headless with the host's agent config staged in:

- `container` — stages `~/.omp/agent` (config.yml, models.yml, settings.json,
  agents/*.md, auth/*) into a temp dir mounted at `/agent`; host cwd is
  bind-mounted read-write at `/work` (the remote agent can do real work).
  Model comes from staged `models.yml` unless `-m` is passed. stdout/stderr
  stream back as live tool progress.
- `k8s` — stages flat config files as a ConfigMap, runs the pod with resource
  limits, streams logs as output; cleans up pod + ConfigMap afterwards.
  Cannot mount the host cwd.
- `ax` — applies an `ax.io/v1alpha1 Task` to the ax-server (agent-substrate
  actors, gvisor sandbox), resumes it, polls via `ax ssh` until the staged
  command writes the result marker to `/workspace/.omp-remote-result`, then
  deletes the task. Env passthrough flows as Task env; workdir is unavailable
  inside the sandbox (staged config only).
- `command` — no staging; you own the environment.

## Verification

```bash
bun run smoke:load              # offline: remote_run registers, schema parses, command runner executes, proxy agents parse
bun run smoke:container         # stage-1: staging/mount/perms/capture in real Apple container
bun run smoke:container -- --e2e # stage-2: full omp-in-container turn (slow first run)
```

## Known gaps

- k8s adapter untested against a live cluster.
- k8s pods cannot mount the host cwd — workdir contents are unavailable
  inside the pod.
- **ax runner verified live** (2026-10-23): applied → resumed → gvisor actor
  executed omp → result read via `ax ssh`. Setup notes for this cluster: the
  `atelet` DaemonSet must run on the worker's node (worker reports capacity
  through `ateom-support.sock`); the `ax` CLI hardcodes a 15 s resume deadline
  that races cold provisioning (~80 s first boot, template + golden restore) —
  use `~/.local/bin/axresume` (120 s deadline, ships separately) or tolerate
  `DeadlineExceeded` and poll the task phase; the atenet-router lazily caches
  actor routes (restart the deployment or retry if `ax ssh` reports
  `error resuming actor` right after boot).
- No orphan cleanup if the host dies mid-run: `container run --rm` cleanup
  relies on the CLI process surviving; k8s/ax cleanup is in the `finally`
  path.
- Runner-side timeouts kill the CLI but remote pids inside an
  already-created VM/pod are only bounded by the runtime itself.
