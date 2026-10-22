/**
 * Offline smoke: extension factory loads under a mock host API, shadows the
 * `task` tool, and its schema/routing behave without any real runtimes.
 * Runs with HOME pointed at a temp dir so host remote-agents.json cannot
 * influence results; the expected fallback is the native delegation path.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/remote-agents.ts";
import { z } from "zod";

process.env.HOME = mkdtempSync(join(tmpdir(), "omp-ra-home-"));

interface RegisteredTool {
    name: string;
    parameters: z.ZodType;
    execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ((u: unknown) => void) | undefined, ctx: unknown) => Promise<{ content?: Array<{ type?: string; text?: string }>; details?: unknown }>;
}

const registered: RegisteredTool[] = [];

factory({
    zod: z,
    registerTool: (def: RegisteredTool) => registered.push(def),
    sendMessage: () => assert.fail("sendMessage must not be called during load"),
});

const task = registered.find((t) => t.name === "task");
assert.ok(task, "task tool is registered");
assert.equal(registered.length, 1, "only the task shadow is registered");

// 1. Schema accepts a remote-routed payload and passes unknown keys through.
const parsed = task.parameters.parse({
    context: "shared ctx",
    tasks: [{ task: "do it", solutionSpace: "how", agent: "researcher", async: true, effort: "hi" }],
});
assert.equal(parsed.tasks[0].agent, "researcher");

// 2. Schema rejects an empty task list.
assert.throws(() => task.parameters.parse({ tasks: [] }), /too small/i);

// 3. Routing with no config: configured-agent names fall through to native
//    delegation, which cannot exist under the mock ctx -> expect our error.
await assert.rejects(
    task.execute("smoke-1", { tasks: [{ task: "t", solutionSpace: "s", agent: "researcher" }] }, undefined, undefined, {}),
    /invokeTool/,
    "unknown agent must reach the native fallback",
);

// 4. Agentless item without defaultRunner: same native fallback.
await assert.rejects(
    task.execute("smoke-2", { tasks: [{ task: "t", solutionSpace: "s" }] }, undefined, undefined, {}),
    /invokeTool/,
    "agentless without defaultRunner must reach the native fallback",
);

console.log("smoke:load OK — task shadow registered, schema validated, routing falls back to native without config");
