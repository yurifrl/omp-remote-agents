/**
 * Generic `command` adapter: runs argv locally with {task} {model} {cwd} {id}
 * token substitution, or pipes the task on stdin. The escape hatch for
 * runtimes that have no dedicated adapter yet — the future unknown runtime
 * plugs in via config, not code.
 */

import type { GenericRunnerConfig } from "../config.ts";
import { runCommand } from "../subprocess.ts";
import type { RemoteRunner, RunnerResult, RunnerSpawnSpec, SpawnOptions } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function createGenericRunner(cfg: GenericRunnerConfig): RemoteRunner {
    return {
        type: "command",
        async spawn(spec: RunnerSpawnSpec, opts: SpawnOptions = {}): Promise<RunnerResult> {
            const timeoutMs = spec.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const argv = cfg.command.map((token) =>
                token
                    .replaceAll("{task}", spec.task)
                    .replaceAll("{model}", spec.model ?? "")
                    .replaceAll("{cwd}", spec.cwd)
                    .replaceAll("{id}", spec.id),
            );
            const res = await runCommand(argv, {
                cwd: cfg.promptStdin ? undefined : spec.cwd,
                stdin: cfg.promptStdin ? spec.task : undefined,
                timeoutMs,
                signal: opts.signal,
            });
            const timedOut = Boolean(res.timedOut) || res.exitCode === null && Boolean(res.killed);
            return {
                id: spec.id,
                exitCode: res.exitCode,
                output: res.stdout || res.stderr,
                stderr: res.stderr,
                ok: res.exitCode === 0 && !timedOut,
                killed: Boolean(res.killed),
                timedOut,
            };
        },
    };
}
