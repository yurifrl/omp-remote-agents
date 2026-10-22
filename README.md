# omp-remote-agents

omp extension: shadows the native `task` tool and routes configured subagents to
**remote runtimes** (Apple Containers, Kubernetes, generic commands) behind a
swappable runner port.

## Why

omp's native `task` tool spawns subagents in-process. This extension keeps the
exact same model-facing surface (same tool name, same `tasks[]` schema, same
`agent://`-style delegation flow) but executes delegated work inside an
isolated runtime of your choice. The runner is a port (`RemoteRunner`), not a
hardcoded backend — plugging a future runtime means implementing one interface
or adding one config entry, never touching the extension core.

## Install

```bash
ln -s /Users/yuri/DotFiles/pi-extentions/omp-remote-agents ~/.omp/agent/extensions/omp-remote-agents
```

Discovery is via the package manifest (`package.json#omp.extensions`). The
global toggle file `~/.omp/agent/extensions/remote-agents.json` (pre-existing)
is unrelated loose JSON and is ignored by auto-discovery.

## Configuration

Global: `~/.omp/agent/remote-agents.json`. Project overlay: `./.omp/remote-agents.json`
(agents append, runners merge by name, `defaultRunner` prefers the project).

```jsonc
{
    "defaultRunner": "container",   // optional: route agentless task items remotely
    "agents": [
        {
            "name": "scout",              // native agent name in ~/.omp/agent/agents/
            "description": "fast recon",  // surface in tool description docs
            "runner": "container",        // which runner entry to use
            "model": "zai/glm-5.3-flash"  // optional default model for its runs
        }
    ],
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

## Routing

Per `task` item:

1. `item.agent` names a configured agent → that agent's runner.
2. No agent, but `defaultRunner` set → default runner (remote becomes the
   default delegation target).
3. Anything else (unknown agent, no config file) → native `task` behavior via
   `ctx.invokeTool` delegation.

`item.async: true` detaches the run: the tool returns immediately with a run id
and the result arrives later as a steered `remote-agents-result` message
(`deliverAs: "nextTurn", triggerTurn: true` — wakes an idle parent, queues
behind a streaming one).

## What runs inside the runtime

`omp -p <task>` headless with the host's agent config staged in:

- `container` — stages `~/.omp/agent` (config.yml, models.yml, settings.json,
  agents/*.md, auth/*) into a temp dir mounted at `/agent`; host cwd is
  bind-mounted read-write at `/work` (the remote agent can do real work).
  Model comes from staged `models.yml` unless `-m` is passed.
- `k8s` — stages flat config files as a ConfigMap, runs the pod, streams logs
  as output; cleans up pod + ConfigMap afterwards. Cannot mount the host cwd
  (PoC limitation).
- `command` — no staging; you own the environment.

## Verification

```bash
bun run smoke:load              # offline: factory loads, task shadow registers, schema parses
bun run smoke:container         # stage-1: staging/mount/perms/capture in real Apple container
bun run smoke:container -- --e2e # stage-2: full omp-in-container turn (slow first run)
```

Verified live (2026-10-21):

- session loads with extension; model sees the shadow's tool description
- `bun run smoke:container -- --e2e` — omp inside `oven/bun` answered `pong`
- headless delegation through the shadow to agent `container-echo`

## Known gaps (PoC)

- `agent`-kind background rows: the extension streams progress via tool-card
  `details`, but cannot synthesize native bus events — async runs render as
  tool-card rows, not native Agent Hub rows.
- No orphan cleanup if the host dies mid-run: `container run --rm` cleanup
  relies on the CLI process surviving; k8s cleanup is in the `finally` path.
- k8s adapter cannot mount the host cwd — workdir contents are unavailable
  inside the pod.
- Extension `task` replacement covers the common path; runner-side timeouts
  kill the CLI but remote pids inside an already-created VM/pod are only
  bounded by the runtime itself.
