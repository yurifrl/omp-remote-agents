/**
 * Apple `container` adapter: runs the remote omp inside an Apple Container
 * VM. Stages the host agent config into a temp dir mounted as the container
 * HOME (read-only host cwd is NOT assumed — the workdir mounts read-write so
 * the remote agent can do work), captures stdout as the final `-p` output.
 */

import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ContainerRunnerConfig } from "../config.ts";
import { collectOmpAgentFiles, resolvePassthroughEnv } from "../registry.ts";
import { runCommand } from "../subprocess.ts";
import type { RemoteRunner, RunnerResult, RunnerSpawnSpec, SpawnOptions } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMMAND = ["bun", "x", "@oh-my-pi/pi-coding-agent@latest"];
const DEFAULT_PASSTHROUGH = ["*_API_KEY", "API_KEY", "*_TOKEN"];

/** Keep only characters Apple container names accept; keep it short. */
export function containerName(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
    return `omp-remote-${safe}`;
}

export function createContainerRunner(cfg: ContainerRunnerConfig, home: string): RemoteRunner {
    return {
        type: "container",
        async spawn(spec: RunnerSpawnSpec, opts: SpawnOptions = {}): Promise<RunnerResult> {
            const runId = randomUUID().slice(0, 8);
            const name = containerName(`${spec.id || runId}`);
            const timeoutMs = spec.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

            // Stage agent config at <tmp>/.omp/agent so it lands at $HOME/.omp/agent
            // inside the container (HOME=/agent).
            const stage = mkdtempSync(join(tmpdir(), "omp-remote-"));
            try {
                const agentDir = join(stage, ".omp", "agent");
                // Container user uid differs from host uid; grant world access so the
                // remote omp can write its session/logs state (PoC tradeoff).
                chmodSync(stage, 0o777);
                mkdirSync(agentDir, { recursive: true, mode: 0o777 });
                const files = collectOmpAgentFiles(home);
                if (!Object.keys(files).length) {
                    throw new Error("remote-agents: no agent config files found to stage (is ~/.omp/agent set up?)");
                }
                for (const [rel, content] of Object.entries(files)) {
                    const target = join(agentDir, rel);
                    mkdirSync(join(target, ".."), { recursive: true, mode: 0o777 });
                    writeFileSync(target, content, { mode: 0o666 });
                }

                const argv = [
                    "container",
                    "run",
                    "--rm",
                    "--name", name,
                    "--memory", cfg.memory ?? "4G",
                    "--cpus", String(cfg.cpus ?? 4),
                    "-e", "HOME=/agent",
                    "-e", "TERM=dumb",
                    "-v", `${stage}:/agent`,
                    "-v", `${spec.cwd}:/work`,
                    "-w", "/work",
                ];
                for (const [key, value] of Object.entries(resolvePassthroughEnv(cfg.envPassthrough ?? DEFAULT_PASSTHROUGH))) {
                    argv.push("-e", `${key}=${value}`);
                }
                argv.push(cfg.image, ...(cfg.command ?? DEFAULT_COMMAND));
                if (spec.model) argv.push("-m", spec.model);
                argv.push("-p", spec.task);

                opts.onUpdate?.(`remote-agents: starting container ${name} (${cfg.image})`);
                const res = await runCommand(argv, {
                    signal: opts.signal,
                    timeoutMs,
                    cwd: spec.cwd,
                    onStdoutChunk: opts.onUpdate,
                    onStderrChunk: opts.onUpdate,
                });
                opts.onUpdate?.(res.exitCode === 0 ? "remote-agents: container run finished" : `remote-agents: container run exited with code ${res.exitCode}`);
                return {
                    id: runId,
                    exitCode: res.exitCode,
                    output: res.stdout,
                    stderr: res.stderr,
                    ok: res.exitCode === 0 && !res.timedOut,
                    killed: res.killed,
                    timedOut: res.timedOut,
                };
            } finally {
                rmSync(stage, { recursive: true, force: true });
            }
        },
    };
}
