/**
 * Container adapter smoke.
 * Stage 1 (default): stages the real agent config, runs `alpine sh -c` inside
 *   Apple `container`, and asserts the staged files are visible/writable —
 *   proves staging, mount, perms, argv assembly, and result capture.
 * Stage 2 (--e2e): full loop — `oven/bun:1` + `bun x oh-my-pi@latest -p` with
 *   the default model and env passthrough. Slow on first run (image + npm).
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { createContainerRunner } from "../src/runners/container.ts";

const e2e = process.argv.includes("--e2e");

if (!e2e) {
    const runner = createContainerRunner(
        { type: "container", image: "alpine", command: ["sh", "-c", "ls /agent/.omp/agent && touch /agent/.omp/agent/.smoke-write && echo STAGED-OK"] },
        homedir(),
    );
    const updates: string[] = [];
    const res = await runner.spawn({ id: "smoke-stage", task: "unused", cwd: process.cwd() }, { onUpdate: (m) => updates.push(m) });
    assert.equal(res.ok, true, `stage smoke failed (exit ${res.exitCode}): ${res.stderr}`);
    assert.match(res.output, /STAGED-OK/);
    assert.match(res.output, /config\.yml|settings\.json|agents/, "staged agent config must be visible");
    assert.ok(updates.length > 0, "onUpdate progress must fire");
    console.log("smoke:container stage-1 OK — staging + mount + write + capture verified");
    process.exit(0);
}

const runner = createContainerRunner(
    { type: "container", image: "oven/bun:1", timeoutMs: 10 * 60_000 },
    homedir(),
);
const res = await runner.spawn({
    id: "smoke-e2e",
    task: "Reply with exactly the word: pong",
    cwd: process.cwd(),
});
console.log("exit:", res.exitCode, "ok:", res.ok, "timedOut:", res.timedOut);
if (res.stderr.trim()) console.log("--- stderr ---\n" + res.stderr.slice(-2000));
console.log("--- output ---\n" + res.output.slice(-2000));
assert.equal(res.ok, true, `e2e failed (exit ${res.exitCode}): ${res.stderr.slice(-2000)}`);
assert.match(res.output, /pong/i, "remote omp must answer the prompt");
console.log("smoke:container stage-2 (e2e) OK — omp answered from inside the container");
