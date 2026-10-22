/**
 * remote-agents.json configuration: global (~/.omp/agent/remote-agents.json)
 * with optional project overlay (./.omp/remote-agents.json). Project agents
 * are appended, runners merge by name, defaultRunner prefers the project.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentEntry {
    name: string;
    description: string;
    runner: string;
    /** Default model passed to the remote omp run when the task omits one. */
    model?: string;
}

export interface ContainerRunnerConfig {
    type: "container";
    image: string;
    /** argv launched inside the container before `-p <task>`; default: bun x @oh-my-pi/pi-coding-agent@latest */
    command?: string[];
    envPassthrough?: string[];
    timeoutMs?: number;
    /** Container VM memory (e.g. "4G"); default 4G — bun install of omp needs more than the 1G VM default. */
    memory?: string;
    /** Container VM CPUs; default 4. */
    cpus?: number;
}

export interface K8sRunnerConfig {
    type: "k8s";
    image: string;
    namespace?: string;
    kubectl?: string[];
    command?: string[];
    envPassthrough?: string[];
    timeoutMs?: number;
    /** Pod memory resources (e.g. "4Gi"); default requests 2Gi / limits 4Gi — bun install needs headroom. */
    memory?: string;
    /** Pod CPU resources; default requests 2 / limits 4. */
    cpus?: number;
}

export interface GenericRunnerConfig {
    type: "command";
    /** argv with {task} {model} {cwd} {id} token substitution (caller owns quoting). */
    command: string[];
    /** Pass the task on stdin instead of token substitution. */
    promptStdin?: boolean;
    timeoutMs?: number;
}

export type RunnerConfig = ContainerRunnerConfig | K8sRunnerConfig | GenericRunnerConfig;

export interface RemoteAgentsConfig {
    defaultRunner?: string;
    agents: AgentEntry[];
    runners: Record<string, RunnerConfig>;
}

const RUNNER_TYPES: Record<string, true> = { container: true, k8s: true, command: true };

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
    if (!Array.isArray(cfg.agents)) throw new Error(`remote-agents: ${path} must define agents: []`);
    if (!cfg.runners || typeof cfg.runners !== "object") throw new Error(`remote-agents: ${path} must define runners: {}`);
    for (const agent of cfg.agents) {
        if (!agent?.name || !agent.runner) throw new Error(`remote-agents: each agent needs { name, runner } in ${path}`);
        if (!cfg.runners[agent.runner]) {
            throw new Error(`remote-agents: agent "${agent.name}" references unknown runner "${agent.runner}" in ${path}`);
        }
    }
    for (const [name, runner] of Object.entries(cfg.runners)) {
        if (typeof runner?.type !== "string" || !RUNNER_TYPES[runner.type]) {
            throw new Error(
                `remote-agents: runner "${name}" needs a known type (one of: ${Object.keys(RUNNER_TYPES).join(", ")}) in ${path}`,
            );
        }
    }
    return { defaultRunner: cfg.defaultRunner, agents: cfg.agents as AgentEntry[], runners: cfg.runners as Record<string, RunnerConfig> };
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
            agents: [...cfg.agents, ...project.agents],
            runners: { ...cfg.runners, ...project.runners },
        };
    }
    return cfg;
}
