/**
 * ax adapter: runs the remote omp as an ax Task on the agent-substrate
 * platform (gvisor sandbox actors on the home Talos cluster). Lifecycle:
 * `ax apply -f <stub>` (Task → Suspended, actor provisioned) → `ax resume task`
 * (Running; ax-task-runner execs spec.command) → payload staged via one
 * `ax ssh` stdin stream → output polled via `ax ssh -- cat <file>` →
 * `ax delete task` cleanup in finally.
 *
 * The applied manifest is a tiny fixed stub. Substrate guards every
 * ActorTemplate `EnvVar.value` at 32768 chars, and ax's reconciler embeds the
 * whole Task YAML (spec.command included) into the actor's AX_TASK_YAML env —
 * so anything sizeable in the manifest is rejected server-side. The payload
 * (workdir tar + entry script) therefore travels as a single tar.gz streamed
 * over `ax ssh` stdin: guest exec copies stdin and closes it at EOF, no env
 * guardrail applies. The stub boot script waits for the staged marker, then
 * execs the entry script.
 *
 * Output plumbing: ax has no log capture, so the entry script writes its
 * result to /workspace/omp-result.txt with sentinel delimiters; the adapter
 * polls ssh cat until the sentinel appears. The ax-task-runner keeps the
 * sandbox alive after the command exits, so late polls still succeed before
 * delete.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AxRunnerConfig } from "../config.ts";
import { runCommand, shq } from "../subprocess.ts";
import type { RemoteRunner, RunnerResult, RunnerSpawnSpec, SpawnOptions } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const RESULT_FILE = "/workspace/omp-result.txt";
const RESULT_DONE = "OMP_RESULT_DONE";
/** Poll cadence for status and result checks; OMP_AX_POLL_MS overrides for offline smokes. */
const POLL_INTERVAL_MS = Number(process.env.OMP_AX_POLL_MS ?? 5_000);

/** Stage archive path inside the guest, plus the ready marker the boot stub waits on. */
const STAGE_TGZ = "/workspace/omp-staged.tgz";
const STAGE_READY = "/workspace/omp-staged-ready";

/** Fixed boot script shipped in the Task manifest (kept tiny: it lands inside AX_TASK_YAML). */
const BOOT_STUB = `
i=0
while [ ! -f ${STAGE_READY} ] && [ "$i" -lt 600 ]; do
  sleep 1
  i=$((i + 1))
done
if [ ! -f /workspace/omp-entry.sh ]; then
  printf '__OMP_EXIT__=1\\n'
  { echo '===OMP_RESULT==='; echo 'staging timeout: payload never arrived'; echo 'OMP_RESULT_DONE'; } > ${RESULT_FILE}
  exit 1
fi
sh /workspace/omp-entry.sh
`;

/** Remote side of the staging ssh: consume the archive from stdin, extract, mark ready. */
const STAGE_REMOTE = `cat > ${STAGE_TGZ} && tar -xzf ${STAGE_TGZ} -C /workspace --no-same-owner && touch ${STAGE_READY}`;

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

function delay(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

/**
 * The entry script delivered inside the stage archive: exports passthrough
 * env, unpacks the staged workdir tarball, runs headless omp, then writes a
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
        "tar -xzf /workspace/workdir.tgz -C /workspace/omp-work --no-same-owner",
        "cd /workspace/omp-work",
        envExports,
        `bun x @oh-my-pi/pi-coding-agent@latest -p ${shq(task)}${model ? ` --model ${shq(model)}` : ""} > /workspace/omp-stdout.txt 2> /workspace/omp-stderr.txt`,
        "code=$?",
        `printf '__OMP_EXIT__=%s\\n' "$code" >> /workspace/omp-stdout.txt`,
        `{ echo '===OMP_RESULT==='; tail -c 12000 /workspace/omp-stdout.txt; echo '===OMP_STDERR==='; tail -c 3000 /workspace/omp-stderr.txt; echo '${RESULT_DONE}'; } > ${RESULT_FILE}`,
        "exit $code",
    ].join("\n");
}

export function createAxRunner(cfg: AxRunnerConfig): RemoteRunner {
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
            const payload = join(stage, "payload");
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
                // Pack the host cwd (the sandbox has no access to host paths)
                // and bundle it with the entry script into one archive.
                throttled(`packing workdir ${spec.cwd}`);
                mkdirSync(payload, { recursive: true });
                const workdirTgz = join(payload, "workdir.tgz");
                const tarRes = await runCommand(
                    ["env", "COPYFILE_DISABLE=1", "tar", "--no-xattrs", "-czf", workdirTgz, "-C", spec.cwd, "."],
                    { timeoutMs: 120_000, signal: opts.signal },
                );
                if (tarRes.exitCode !== 0) {
                    return fail(tarRes, `tar of ${spec.cwd} failed`);
                }
                writeFileSync(join(payload, "omp-entry.sh"), buildScript(env, model, spec.task), { mode: 0o755 });
                const stageTgz = join(stage, "omp-staged.tgz");
                const packRes = await runCommand(["tar", "-czf", stageTgz, "-C", payload, "."], {
                    timeoutMs: 120_000,
                    signal: opts.signal,
                });
                if (packRes.exitCode !== 0) return fail(packRes, "staging archive packing failed");

                // Tiny manifest: command is the fixed BOOT_STUB, never the payload.
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
                    "    - |-",
                    ...BOOT_STUB.trim().split("\n").map((line) => `      ${line}`),
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

                // Wait for the phase gate: ssh requires phase Running.
                // resume completes asynchronously on the server (wakeup probe,
                // golden restore), so poll until the actor is up.
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

                // Stage the payload: one ssh exec whose stdin is the archive;
                // EOF closes the remote `cat`, which then extracts and marks
                // the stub boot script ready to run the entry script. Each
                // `ax` invocation may spin up an ephemeral tunnel whose
                // health check races the connection (transient), so retry
                // with fresh bytes until it sticks.
                const stageBytes = new Uint8Array(await Bun.file(stageTgz).arrayBuffer());
                throttled(`staging payload (${(stageBytes.byteLength / 1e6).toFixed(1)} MB) via ax ssh`);
                let stageRes = await runCommand([...axBase, "ssh", taskName, "--", "sh", "-c", STAGE_REMOTE], {
                    stdin: stageBytes,
                    timeoutMs: 300_000,
                    signal: opts.signal,
                });
                for (let attempt = 1; attempt < 3 && stageRes.exitCode !== 0; attempt++) {
                    throttled("staging failed; retrying");
                    await delay(2_000);
                    stageRes = await runCommand([...axBase, "ssh", taskName, "--", "sh", "-c", STAGE_REMOTE], {
                        stdin: stageBytes,
                        timeoutMs: 300_000,
                        signal: opts.signal,
                    });
                }
                if (stageRes.exitCode !== 0) return fail(stageRes, "staging payload via ax ssh failed");

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
