/**
 * Runner factory + shared helpers. Built-in adapter kinds: `container`,
 * `k8s`, `command`. Unknown kinds are rejected by config validation, so the
 * factory's default branch is a safety net only. Adding a future runtime =
 * implementing RemoteRunner (or using the `command` adapter via config).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerConfig } from "./config.ts";
import type { RemoteRunner } from "./types.ts";
import { createContainerRunner } from "./runners/container.ts";
import { createK8sRunner } from "./runners/k8s.ts";
import { createGenericRunner } from "./runners/generic.ts";

export const BUILTIN_RUNNER_TYPES = ["container", "k8s", "command"] as const;

/** Resolve env-passthrough patterns (exact name or `*` glob, e.g. `*_API_KEY`) against the parent env. */
export function resolvePassthroughEnv(patterns: string[], env = process.env): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(env)) {
        for (const pattern of patterns) {
            const [prefix, suffix] = pattern.split("*", 2);
            const matches = pattern.includes("*") ? key.startsWith(prefix) && key.endsWith(suffix) : key === pattern;
            if (matches) {
                out[key] = env[key]!;
                break;
            }
        }
    }
    return out;
}

export function createRunner(cfg: RunnerConfig, home: string): RemoteRunner {
    switch (cfg.type) {
        case "container":
            return createContainerRunner(cfg, home);
        case "k8s":
            return createK8sRunner(cfg, home);
        case "command":
            return createGenericRunner(cfg);
        default:
            // Unreachable for validated configs; keeps the switch exhaustive.
            throw new Error(`remote-agents: unsupported runner type; built-ins: ${BUILTIN_RUNNER_TYPES.join(", ")}`);
    }
}

/**
 * Collect host omp agent config for a remote run: config.yml, models.yml,
 * settings.json, agents/*.md, auth/*. `agentsDir: false` skips agent
 * definitions (k8s ConfigMap keys don't preserve nested layout needs the
 * same way). Callers write the returned map into their runtime's mount
 * (temp dir or ConfigMap) — avoids sharing the host session/history SQLite.
 */
export function collectOmpAgentFiles(home: string, opts: { agentsDir?: boolean } = {}): Record<string, string> {
    const agentDir = join(home, ".omp", "agent");
    const files: Record<string, string> = {};
    for (const name of ["config.yml", "models.yml", "settings.json"]) {
        const p = join(agentDir, name);
        if (existsSync(p)) files[name] = readFileSync(p, "utf8");
    }
    if (opts.agentsDir !== false) {
        const agentsDir = join(agentDir, "agents");
        if (existsSync(agentsDir)) {
            for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.endsWith(".md")) {
                    files[`agents/${entry.name}`] = readFileSync(join(agentsDir, entry.name), "utf8");
                }
            }
        }
    }
    const authDir = join(agentDir, "auth");
    if (existsSync(authDir)) {
        for (const entry of readdirSync(authDir, { withFileTypes: true })) {
            if (entry.isFile()) {
                files[`auth/${entry.name}`] = readFileSync(join(authDir, entry.name), "utf8");
            }
        }
    }
    return files;
}
