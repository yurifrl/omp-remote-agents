/**
 * remote-agents.json configuration: global (~/.omp/agent/remote-agents.json)
 * with optional project overlay (./.omp/remote-agents.json). Runners merge by
 * name; the project value wins. This file maps runner names to runtime
 * configs only — model-facing agents (remote-*) ship with the package in
 * agents/ and are discovered by the native task subsystem.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AxRunnerConfig {
    type: "ax";
    /** Task-runner image the actor boots (must contain ax-task-runner + runtime deps). */
    image: string;
    /** ax CLI argv prefix (e.g. ["--context", "admin@talos-default"]); default bare `ax`. */
    ax?: string[];
    /** Kubernetes namespace where ax-server runs; default ax-system. */
    namespace?: string;
    /** ax atespace for Tasks; default "default". */
    atespace?: string;
    envPassthrough?: string[];
    timeoutMs?: number;
    /** Default model forwarded to the remote omp (`--model`); per-item spec.model wins. */
    model?: string;
}

export interface RemoteAgentsConfig {
    defaultRunner?: string;
    runners: Record<string, AxRunnerConfig>;
}

const RUNNER_TYPES: Record<string, true> = { ax: true };

export function ompAgentDir(home = homedir()): string {
    return join(home, ".omp", "agent");
}

function readJson(path: string): RemoteAgentsConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
        throw new Error(`remote-agents: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const cfg = parsed as Partial<RemoteAgentsConfig>;
    if (!cfg || typeof cfg !== "object") throw new Error(`remote-agents: ${path} must be an object`);
    if (!cfg.runners || typeof cfg.runners !== "object") throw new Error(`remote-agents: ${path} must define runners: {}`);
    for (const [name, runner] of Object.entries(cfg.runners)) {
        if (typeof runner?.type !== "string" || !RUNNER_TYPES[runner.type]) {
            throw new Error(
                `remote-agents: runner "${name}" needs a known type (one of: ${Object.keys(RUNNER_TYPES).join(", ")}) in ${path}`,
            );
        }
    }
    return { defaultRunner: cfg.defaultRunner, runners: cfg.runners as Record<string, AxRunnerConfig> };
}

export function loadRemoteAgentsConfig(cwd = process.cwd(), home = homedir()): RemoteAgentsConfig | undefined {
    const globalPath = join(ompAgentDir(home), "remote-agents.json");
    if (!existsSync(globalPath)) return undefined;
    const cfg = readJson(globalPath);

    const projectPath = join(cwd, ".omp", "remote-agents.json");
    if (existsSync(projectPath)) {
        const project = readJson(projectPath);
        return {
            defaultRunner: project.defaultRunner ?? cfg.defaultRunner,
            runners: { ...cfg.runners, ...project.runners },
        };
    }
    return cfg;
}
