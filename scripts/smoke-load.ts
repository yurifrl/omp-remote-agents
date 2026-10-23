/**
 * Offline smoke: the extension factory loads under a mock host API, the
 * remote_run schema validates, unknown runners are rejected, and the ax
 * runner completes a full lifecycle (apply → resume → get → ssh-poll →
 * delete) against a stub `ax` CLI on PATH — no cluster required.
 *
 * Two stages because Bun caches os.homedir() at process start: stage 1
 * prepares a temp HOME (with remote-agents.json) plus a stub bin dir, then
 * re-execs this file with HOME/SMOKE_CHILD set; stage 2 runs the checks.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB_AX = `#!/bin/sh
# Emulates the ax CLI verbs the runner exercises.
verb=
for a in "$@"; do
  case "$a" in
    apply|resume|get|ssh|delete) verb="$a"; break ;;
  esac
done
case "$verb" in
  apply) exit 0 ;;
  resume) exit 0 ;;
  get) printf 'phase: Running\\n' ;;
  ssh) printf 'ax-noise\\n===OMP_RESULT===\\nsmoke-ok\\n__OMP_EXIT__=0\\n===OMP_STDERR===\\nno-stderr\\nOMP_RESULT_DONE\\n' ;;
  delete) printf 'deleted %s\\n' "$*" >> "\${SMOKE_AX_LOG:?}"; exit 0 ;;
  *) printf 'stub ax: unexpected argv: %s\\n' "$*" >&2; exit 99 ;;
esac
`;

if (!process.env.SMOKE_CHILD) {
    const home = mkdtempSync(join(tmpdir(), "omp-smoke-home-"));
    const stubDir = mkdtempSync(join(tmpdir(), "omp-smoke-bin-"));
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(
        join(home, ".omp", "agent", "remote-agents.json"),
        JSON.stringify({ defaultRunner: "ax", runners: { ax: { type: "ax", image: "stub-image:smoke" } } }, null, 2),
    );
    writeFileSync(join(stubDir, "ax"), STUB_AX, { mode: 0o755 });
    const axLog = join(home, "ax-stub.log");
    const child = Bun.spawn(["bun", import.meta.path], {
        env: {
            ...process.env,
            HOME: home,
            SMOKE_CHILD: "1",
            SMOKE_AX_LOG: axLog,
            PATH: `${stubDir}:${process.env.PATH ?? ""}`,
            OMP_AX_POLL_MS: "50",
        },
        stdout: "inherit",
        stderr: "inherit",
    });
    const code = await child.exited;
    rmSync(home, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
    if (code !== 0) throw new Error(`smoke child exited ${code}`);
    process.exit(0);
}

const assert = (await import("node:assert/strict")).default;
const { z } = await import("zod");
const { default: factory } = await import("../extensions/remote-agents.ts");

interface ToolResult {
    isError?: boolean;
    content: { type: string; text: string }[];
    details: { runner: string; exitCode: number | null };
}

interface RegisteredTool {
    name: string;
    parameters: z.ZodType;
    execute(
        toolCallId: string,
        params: { task: string; runner?: string },
        signal: undefined,
        onUpdate: ((update: unknown) => void) | undefined,
        ctx: undefined,
    ): Promise<ToolResult>;
}

// The mock host API is cast to the extension's declared API surface
// (ExtensionAPI lives in @oh-my-pi/pi-coding-agent, not this package's deps).
type ExtensionApi = Parameters<typeof factory>[0];
let captured: RegisteredTool | undefined;
const mockApi = {
    zod: z,
    registerTool(tool: unknown) {
        // Shape is trusted here: this capture mirrors what the real host registers.
        captured = tool as RegisteredTool;
    },
} satisfies Partial<ExtensionApi>;
factory(mockApi as ExtensionApi);
const tool = captured!;
assert.equal(tool.name, "remote_run");
assert.equal(tool.parameters.safeParse({ task: "ping" }).success, true);
assert.equal(tool.parameters.safeParse({}).success, false);
assert.equal(tool.parameters.safeParse({ task: "" }).success, false);

// 2. Unknown runner rejected before any spawn.
await assert.rejects(
    tool.execute("smoke", { task: "ping", runner: "container" }, undefined, () => {}, undefined),
    /unknown runner "container"/,
);

// 3. Full ax lifecycle against the stub CLI: explicit runner + default runner.
const updates: unknown[] = [];
for (const params of [{ task: "ping", runner: "ax" }, { task: "ping" }]) {
    const res = await tool.execute("smoke", params, undefined, (u: unknown) => updates.push(u), undefined);
    assert.equal(res.isError, undefined, JSON.stringify(res));
    assert.match(res.content[0].text, /smoke-ok/);
    assert.equal(res.details.runner, "ax");
    assert.equal(res.details.exitCode, 0);
}

// 4. Cleanup ran: the stub recorded the delete verb.
assert.match(readFileSync(process.env.SMOKE_AX_LOG!, "utf8"), /deleted/);

// 5. Shipped proxy agent parses and references remote_run.
const agentsDir = join(import.meta.dir, "..", "agents");
const { readdirSync } = await import("node:fs");
assert.deepEqual(readdirSync(agentsDir), ["remote-ax.md"]);
const md = readFileSync(join(agentsDir, "remote-ax.md"), "utf8");
assert.match(md, /^---\nname: remote-ax\n/);
assert.match(md, /remote_run/);

console.log("smoke:load OK — remote_run registered, schema validated, ax lifecycle ran against stub CLI, cleanup verified, remote-ax agent present");
