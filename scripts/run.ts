/**
 * CLI wrapper around the ax runner: `bun run scripts/run.ts [--command "sh"] [--task prompt]`.
 * Bypasses omp's extension host so runner changes take effect without an omp
 * restart (the host caches the extension and its registered tool schema).
 */

import { homedir } from "node:os";
import { loadRemoteAgentsConfig } from "../src/config.ts";
import { createAxRunner } from "../src/runners/ax.ts";
import type { RunnerSpawnSpec } from "../src/types.ts";

function usage(): never {
    console.error("usage: bun run scripts/run.ts (--task <prompt> | --command <sh>) [--model <id>]");
    process.exit(2);
}

const argv = process.argv.slice(2);
let task: string | undefined;
let command: string | undefined;
let model: string | undefined;
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task") task = argv[++i];
    else if (argv[i] === "--command") command = argv[++i];
    else if (argv[i] === "--model") model = argv[++i];
    else usage();
}
if ((task ? 1 : 0) + (command ? 1 : 0) !== 1) usage();

const cfg = loadRemoteAgentsConfig(process.cwd(), homedir());
if (!cfg) throw new Error("remote-agents: no configuration at ~/.omp/agent/remote-agents.json");
const runnerKey = cfg.defaultRunner ?? Object.keys(cfg.runners)[0];
const runnerCfg = cfg.runners[runnerKey!];
if (!runnerCfg) throw new Error(`remote-agents: unknown runner "${runnerKey}"`);

const spec: RunnerSpawnSpec = {
    id: Math.random().toString(36).slice(2, 10),
    agent: runnerKey!,
    name: runnerKey!,
    task,
    command,
    model,
    cwd: process.cwd(),
};
const res = await createAxRunner(runnerCfg).spawn(spec, {
    onUpdate: (msg) => console.error(`[runner] ${msg}`),
});
console.log(`--- exit: ${res.exitCode ?? "null"} ---`);
console.log(res.output.trim());
if (res.stderr.trim()) {
    console.log("--- stderr (tail) ---");
    console.log(res.stderr.trim());
}
process.exit(res.ok ? 0 : 1);
