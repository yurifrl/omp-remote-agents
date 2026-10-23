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

An ax `ax.io/v1alpha1 Task` is applied to the ax-server (agent-substrate
actors, gVisor sandbox), resumed, and polled via `ax ssh` until the staged
command writes the result marker to `/workspace/.omp-remote-result`, then the
task is deleted. Env passthrough flows as Task env; the host cwd is
unavailable inside the sandbox (staged config only — config.yml, models.yml,
settings.json, auth/*).

## Verification

```bash
bun run smoke:load   # offline: remote_run registers, schema parses, full ax lifecycle runs against a stub `ax` CLI
```

## Known gaps

- Headless omp inside the actor cannot reach model APIs yet: sandbox egress
  TLS through the atunnel → atenet-router → atenet-egress path fails after
  ClientHello. Lifecycle (apply → resume → run → result → cleanup) is
  verified live (2026-10-23); the model round-trip is blocked on the
  substrate egress fix.
- Setup notes for this cluster: the `atelet` DaemonSet must run on the
  worker's node (worker reports capacity through `ateom-support.sock`); the
  `ax` CLI hardcodes a 15 s resume deadline that races cold provisioning
  (~80 s first boot, template + golden restore) — use `~/.local/bin/axresume`
  (120 s deadline, ships separately) or tolerate `DeadlineExceeded` and poll
  the task phase; the atenet-router lazily caches actor routes (restart the
  deployment or retry if `ax ssh` reports `error resuming actor` right after
  boot).
- No orphan cleanup if the host dies mid-run: ax cleanup is in the `finally`
  path only.
- A runner-side timeout kills the CLI but the actor keeps running until the
  Task's own bounds.
