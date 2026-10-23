/**
 * ax adapter: runs the remote omp as an ax Task on the agent-substrate
 * platform (gvisor sandbox actors on the home Talos cluster). Lifecycle:
 * `ax apply -f -` (Task → Suspended, actor provisioned) → `ax resume task`
 * (Running; ax-task-runner execs spec.command) → output polled via
 * `ax ssh -- cat <file>` → `ax delete task` cleanup in finally.
 *
 * Output plumbing: ax has no log capture, so the command writes its result
 * to /workspace/omp-result.txt with sentinel delimiters; the adapter polls
 * ssh cat until the sentinel appears. The command itself is base64-embedded
 * shell (the task prompt contains arbitrary text — never interpolated raw
 * into the YAML manifest). The ax-task-runner keeps the sandbox alive after
 * the command exits, so late polls still succeed before delete.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AxRunnerConfig } from "../config.ts";
import { resolvePassthroughEnv } from "../registry.ts";
import { runCommand, shq } from "../subprocess.ts";
import type { RemoteRunner, RunnerResult, RunnerSpawnSpec, SpawnOptions } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const RESULT_FILE = "/workspace/omp-result.txt";
const RESULT_DONE = "OMP_RESULT_DONE";
const POLL_INTERVAL_MS = 5_000;
/** env-embedded tarball ceiling; beyond this the manifest becomes unwieldy. */
const MAX_WORKDIR_B64 = 6 * 1024 * 1024;

function b64(text: string): string {
    return Buffer.from(text, "utf8").toString("base64");
}

function delay(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

/**
 * The shell executed inside the sandbox: exports passthrough env, unpacks
 * the staged workdir tarball, runs headless omp, then writes a
 * sentinel-delimited result file (stdout tail + stderr tail + exit code).
 */
function buildScript(env: Record<string, string>, model: string | undefined, task: string): string {
    const envExports = Object.entries(env)
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("\n");
    return [
        "set -u",
        "mkdir -p /workspace/omp-work /agent-home",
        "export HOME=/agent-home",
        "tar -xzf /workspace/omp-workdir.tgz -C /workspace/omp-work",
        "cd /workspace/omp-work",
        envExports,
        `bun x @oh-my-pi/pi-coding-agent@latest -p ${shq(task)}${model ? ` --model ${shq(model)}` : ""} > /workspace/omp-stdout.txt 2> /workspace/omp-stderr.txt`,
        "code=$?",
        `printf '__OMP_EXIT__=%s\\n' "$code" >> /workspace/omp-stdout.txt`,
        `{ echo '===OMP_RESULT==='; tail -c 12000 /workspace/omp-stdout.txt; echo '===OMP_STDERR==='; tail -c 3000 /workspace/omp-stderr.txt; echo '${RESULT_DONE}'; } > ${RESULT_FILE}`,
        "exit $code",
    ].join("\n");
}

export function createAxRunner(cfg: AxRunnerConfig, home: string): RemoteRunner {
    const axBase = ["ax", ...(cfg.ax ?? []), "-n", cfg.namespace ?? "ax-system"];

    return {
        type: "ax",
        async spawn(spec: RunnerSpawnSpec, opts: SpawnOptions = {}): Promise<RunnerResult> {
            const runId = (spec.id || randomUUID().slice(0, 8)).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
            const taskName = `omp-remote-${runId}`;
            const timeoutMs = spec.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const env = resolvePassthroughEnv(cfg.envPassthrough ?? ["*_API_KEY", "API_KEY", "*_TOKEN"]);
            const model = spec.model ?? cfg.model;

            const stage = mkdtempSync(join(tmpdir(), "omp-ax-"));
            const onUpdate = opts.onUpdate;
            let lastEmit = 0;
            const throttled = (msg: string) => {
                const now = Date.now();
                if (now - lastEmit >= 1_000) {
                    lastEmit = now;
                    onUpdate?.(`remote-agents: ${msg}`);
                }
            };

            try {
                // Stage the host cwd as a tarball embedded in the command
                // (the sandbox has no access to host paths).
                throttled(`packing workdir ${spec.cwd}`);
                const workdirTgz = join(stage, "workdir.tgz");
                const tarRes = await runCommand(["tar", "-czf", workdirTgz, "-C", spec.cwd, "."], {
                    timeoutMs: 120_000,
                    signal: opts.signal,
                });
                if (tarRes.exitCode !== 0) {
                    return fail(tarRes, `tar of ${spec.cwd} failed`);
                }
                const workdirB64 = readFileSync(workdirTgz).toString("base64");
                if (workdirB64.length > MAX_WORKDIR_B64) {
                    return fail({ stderr: `workdir ${spec.cwd} too large to stage (${(workdirB64.length / 1e6).toFixed(1)} MB base64 > 6 MB cap)`, stdout: "", exitCode: null });
                }

                const script = buildScript(env, model, spec.task);
                const commandPayload = b64(
                    [
                        `echo ${shq(workdirB64)} | base64 -d > /workspace/omp-workdir.tgz`,
                        `echo ${shq(b64(script))} | base64 -d > /workspace/omp-entry.sh`,
                        "sh /workspace/omp-entry.sh",
                    ].join("\n"),
                );

                const manifest = [
                    "---",
                    "apiVersion: ax.io/v1alpha1",
                    "kind: Task",
                    "metadata:",
                    `  name: ${taskName}`,
                    `  atespace: ${cfg.atespace ?? "default"}`,
                    "spec:",
                    `  image: ${cfg.image}`,
                    "  command:",
                    "    - /bin/sh",
                    "    - -c",
                    "    - |",
                    ...commandPayload.split("\n").map((line) => `      ${line}`),
                    "  debug: true",
                    "",
                ].join("\n");
                const manifestPath = join(stage, "task.yaml");
                writeFileSync(manifestPath, manifest, { mode: 0o600 });

                throttled(`applying ax task ${taskName}`);
                const applyRes = await runCommand([...axBase, "apply", "-f", manifestPath], {
                    timeoutMs: 60_000,
                    signal: opts.signal,
                });
                if (applyRes.exitCode !== 0) return fail(applyRes);

                // Resume. `ax resume`'s CLI hardcodes a 15s context that races
                // the substrate workflow (template reconcile + golden restore
                // can take ~80s cold) — a cancelled RPC kills the status
                // write, leaving the Task Suspended with a live actor.
                // `axresume` (long-deadline direct gRPC) avoids the race; the
                // CLI fallback tolerates DeadlineExceeded because the resume
                // completes server-side anyway.
                throttled("resuming task");
                const resumeArgv = existsSync(join(homedir(), ".local", "bin", "axresume"))
                    ? ["axresume", `127.0.0.1:${await axServerPort(axBase)}`, taskName]
                    : [...axBase, "resume", "task", taskName];
                const resumeRes = await runCommand(resumeArgv, {
                    timeoutMs: 240_000,
                    signal: opts.signal,
                });
                if (
                    resumeRes.exitCode !== 0 &&
                    !/DeadlineExceeded|deadline/i.test(`${resumeRes.stderr}${resumeRes.stdout}`)
                ) {
                    return fail(resumeRes);
                }

                // Poll for the sentinel via ax ssh (guest exec over atenet).
                // ssh requires phase Running: resume completes asynchronously
                // on the server (wakeup probe, golden restore), so first wait
                // for the phase gate.
                const deadline = Date.now() + timeoutMs;
                let running = false;
                let resumed = false;
                while (Date.now() < deadline) {
                    if (opts.signal?.aborted) return cancelled(runId, opts);
                    await delay(POLL_INTERVAL_MS);
                    const status = await runCommand([...axBase, "get", "task", taskName, "-o", "yaml"], {
                        timeoutMs: 30_000,
                        signal: opts.signal,
                    });
                    if (/phase:\s*Running/.test(status.stdout)) {
                        running = true;
                        break;
                    }
                    if (/phase:\s*Failed/.test(status.stdout)) {
                        // Wakeup-probe timeouts poison the first attempt; a
                        // re-resume boots the actor from a warm path.
                        if (!resumed && /wakeup probe|restore/i.test(status.stdout + status.stderr)) {
                            resumed = true;
                            throttled("actor boot failed; retrying resume");
                            await runCommand(resumeArgv, { timeoutMs: 240_000, signal: opts.signal });
                            continue;
                        }
                        break;
                    }
                    throttled("waiting for actor to reach Running");
                }
                if (!running) {
                    return {
                        id: runId,
                        exitCode: null,
                        output: "",
                        stderr: "ax task never reached Running (see ax-server logs)",
                        ok: false,
                        killed: false,
                        timedOut: true,
                    };
                }
                let resultText = "";
                let exitCode: number | null = null;
                let stderrTail = "";
                while (Date.now() < deadline) {
                    if (opts.signal?.aborted) return cancelled(runId, opts);
                    await delay(POLL_INTERVAL_MS);
                    throttled("polling remote result");
                    const sshRes = await runCommand([...axBase, "ssh", taskName, "--", "cat", RESULT_FILE], {
                        timeoutMs: 30_000,
                        signal: opts.signal,
                    });
                    if (sshRes.exitCode === 0 && sshRes.stdout.includes(RESULT_DONE)) {
                        const parsed = parseResult(sshRes.stdout);
                        resultText = parsed.body;
                        exitCode = parsed.code;
                        stderrTail = parsed.stderr;
                        break;
                    }
                }

                if (exitCode === null) {
                    return {
                        id: runId,
                        exitCode: null,
                        output: resultText,
                        stderr: stderrTail || `timed out after ${timeoutMs}ms waiting for ${RESULT_FILE}`,
                        ok: false,
                        killed: false,
                        timedOut: true,
                    };
                }
                return {
                    id: runId,
                    exitCode,
                    output: resultText,
                    stderr: stderrTail,
                    ok: exitCode === 0,
                    killed: false,
                    timedOut: false,
                };
            } finally {
                // Delete the Task: removes the actor and its sandbox.
                throttled("deleting ax task");
                await runCommand([...axBase, "delete", "task", taskName], { timeoutMs: 60_000 }).catch(() => undefined);
                rmSync(stage, { recursive: true, force: true });
            }
        },
    };
}

/** Parse the sentinel-delimited result file content (leading ax CLI noise tolerated). */
function parseResult(raw: string): { body: string; code: number | null; stderr: string } {
    const resultIdx = raw.lastIndexOf("===OMP_RESULT===");
    if (resultIdx === -1) return { body: raw, code: null, stderr: "" };
    const rest = raw.slice(resultIdx + "===OMP_RESULT===".length);
    const stderrIdx = rest.indexOf("===OMP_STDERR===");
    const doneIdx = rest.indexOf(RESULT_DONE);
    const stdoutPart = stderrIdx === -1 ? rest.slice(0, doneIdx === -1 ? undefined : doneIdx) : rest.slice(0, stderrIdx);
    const stderrPart = stderrIdx === -1 ? "" : rest.slice(stderrIdx + "===OMP_STDERR===".length, doneIdx === -1 ? undefined : doneIdx);
    const exitMatch = stdoutPart.match(/__OMP_EXIT__=(-?\d+)/);
    const body = stdoutPart
        .replace(/__OMP_EXIT__=-?\d+\n?/, "")
        .trim();
    return { body, code: exitMatch ? Number(exitMatch[1]) : null, stderr: stderrPart.trim() };
}

function fail(res: { stderr: string; stdout: string; exitCode: number | null }, note?: string): RunnerResult {
    return {
        id: "ax",
        exitCode: res.exitCode,
        output: "",
        stderr: [note, res.stderr.trim(), res.stdout.trim()].filter(Boolean).join("\n").slice(-4000),
        ok: false,
        killed: false,
        timedOut: false,
    };
}

function cancelled(runId: string, opts: SpawnOptions): RunnerResult {
    return { id: runId, exitCode: null, output: "", stderr: "aborted", ok: false, killed: true, timedOut: false };
}

/** Discover the local ax-server gRPC port from an active `ax tunnel` (its
 * `list` JSON carries localPort); falls back to 18080/18082 conventions. */
async function axServerPort(axBase: string[]): Promise<number> {
    const list = await runCommand([...axBase, "tunnel", "list"], { timeoutMs: 20_000 });
    const match = list.stdout.match(/"localPort":\s*(\d+)/) ?? list.stdout.match(/localPort[":\s]+(\d+)/);
    return match ? Number(match[1]) : 18080;
}
