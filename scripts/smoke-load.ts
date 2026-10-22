/**
 * Offline smoke: extension factory loads under a mock host API, registers the
 * `remote_run` tool, schema validation and runner routing behave without any
 * real runtimes (the `command` runner executes a local /bin/echo).
 *
 * Two stages because Bun caches os.homedir() at process start: stage 1
 * prepares a temp HOME with its own remote-agents.json, then re-execs this
 * file with HOME/SMOKE_CHILD set; stage 2 runs the assertions.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.SMOKE_CHILD) {
    const home = mkdtempSync(join(tmpdir(), "omp-ra-home-"));
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(
        join(home, ".omp", "agent", "remote-agents.json"),
        JSON.stringify({
            defaultRunner: "echo",
            runners: {
                echo: { type: "command", command: ["/bin/echo", "ran:{task}"] },
                fail: { type: "command", command: ["/bin/sh", "-c", "echo oops >&2; exit 3"] },
            },
        }),
    );
    const proc = Bun.spawn(["bun", "run", import.meta.path], {
        env: { ...process.env, HOME: home, SMOKE_CHILD: "1" },
        stdout: "inherit",
        stderr: "inherit",
    });
    process.exit(await proc.exited);
}

const { default: factory } = await import("../extensions/remote-agents.ts");
const assert = (await import("node:assert/strict")).default;
const { z } = await import("zod");

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

const remoteRun = registered.find((t) => t.name === "remote_run");
assert.ok(remoteRun, "remote_run tool is registered");
assert.equal(registered.length, 1, "only remote_run is registered");

// 1. Schema accepts a plain run.
const parsed = remoteRun.parameters.parse({ runner: "echo", task: "hello world" });
assert.equal(parsed.runner, "echo");

// 2. Schema rejects an empty task; runner is optional by design.
assert.throws(() => remoteRun.parameters.parse({ runner: "echo", task: "" }), /too small|at least/i);

// 3. Unknown runner → error names the configured runners.
await assert.rejects(
    remoteRun.execute("smoke-1", { runner: "nope", task: "t" }, undefined, undefined, {}),
    /unknown runner "nope" \(configured: echo, fail\)/,
);

// 3b. Omitted runner falls back to defaultRunner.
const fallback = await remoteRun.execute("smoke-1b", { task: "hello world" }, undefined, undefined, {});
assert.match(fallback.content?.map((c) => c.text ?? "").join("") ?? "", /ran:hello world/);

// 4. Valid command runner executes locally with {task} substitution.
const updates: unknown[] = [];
const res = await remoteRun.execute("smoke-2", { runner: "echo", task: "hello world" }, undefined, (u) => updates.push(u), {});
const text = res.content?.map((c) => c.text ?? "").join("");
assert.doesNotMatch(text ?? "", /\[remote-agent/, "success body is the clean remote output, no wrapper header");
assert.match(text ?? "", /ran:hello world/, "command output captured with {task} substituted");
assert.equal((res.details as { exitCode?: number }).exitCode, 0);

// 5. Failing runner → isError with header and stderr tail.
const failed = await remoteRun.execute("smoke-3", { runner: "fail", task: "boom" }, undefined, undefined, {});
assert.equal(failed.isError, true);
const failedText = failed.content?.map((c) => c.text ?? "").join("");
assert.match(failedText ?? "", /\[remote-agent fail\/\w+\] failed \(exit 3\)/);
assert.match(failedText ?? "", /stderr \(tail\):\noops/);

// 6. Shipped proxy agents parse and reference remote_run.
const agentsDir = join(import.meta.dir, "..", "agents");
const { readdirSync, readFileSync } = await import("node:fs");
for (const entry of readdirSync(agentsDir)) {
    const md = readFileSync(join(agentsDir, entry), "utf8");
    assert.match(md, /^---\nname: remote-/, `${entry} has frontmatter`);
    assert.match(md, /remote_run/, `${entry} instructs remote_run`);
}

console.log("smoke:load OK — remote_run registered, schema validated, command runner executed, proxy agents present");
