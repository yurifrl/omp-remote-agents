/**
 * remote-agents — registers the `remote_run` tool and ships `remote-*` proxy
 * agents that the native task subsystem discovers from this package's agents/
 * dir. A proxy agent forwards its assignment to a configured runner (Apple
 * Containers, Kubernetes, or a generic command); native task owns spawning,
 * backgrounding, agent:// output, and the Tern agent UI. This module only
 * resolves the runner and shapes the run result.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadRemoteAgentsConfig } from "../src/config.ts";
import { createRunner } from "../src/registry.ts";

const SUMMARY_LIMIT = 8_000;
const UPDATE_INTERVAL_MS = 1_000;

function tail(text: string, limit = SUMMARY_LIMIT): string {
    return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

export default function (pi: ExtensionAPI) {
    const z = pi.zod;

    pi.registerTool({
        name: "remote_run",
        label: "Remote Run",
        description: [
            "Run one headless omp session on a remote runtime (Apple Container VM, Kubernetes pod, or generic command).",
            "Internal to the remote-* proxy agents — delegate work via the task tool with agent `remote-container` (or `remote-k8s`/`remote-command`) instead of calling this directly.",
        ].join(" "),
        parameters: z.object({
            runner: z.string().optional().describe(
                "Runner name from remote-agents.json; defaults to defaultRunner, or the only configured runner",
            ),
            task: z.string().min(1).describe("Complete task prompt handed to the remote omp session"),
        }),
        async execute(_toolCallId, params, signal, onUpdate, _ctx) {
            const cfg = loadRemoteAgentsConfig(process.cwd(), homedir());
            if (!cfg) {
                throw new Error("remote_run: no configuration at ~/.omp/agent/remote-agents.json (or project .omp/remote-agents.json)");
            }

            const runnerKey = params.runner
                ?? cfg.defaultRunner
                ?? (Object.keys(cfg.runners).length === 1 ? Object.keys(cfg.runners)[0] : undefined);
            const runnerCfg = cfg.runners[runnerKey ?? ""];
            if (!runnerCfg) {
                throw new Error(
                    `remote_run: unknown runner "${params.runner}" (configured: ${Object.keys(cfg.runners).join(", ") || "none"})`,
                );
            }

            const runId = randomUUID().slice(0, 8);
            const runner = createRunner(runnerCfg, homedir());

            let lastEmit = 0;
            let buffer = "";
            const throttledUpdate = (chunk: string) => {
                buffer = `${buffer}${chunk}`;
                const now = Date.now();
                if (now - lastEmit < UPDATE_INTERVAL_MS) return;
                lastEmit = now;
                const recent = buffer.slice(-500);
                onUpdate?.({ content: [{ type: "text", text: `[${runnerKey}] ${recent}` }] });
            };

            const res = await runner.spawn(
                {
                    id: runId,
                    agent: runnerKey!,
                    name: runnerKey!,
                    task: params.task,
                    cwd: process.cwd(),
                },
                { signal, onUpdate: throttledUpdate },
            );

            const status = res.ok
                ? "ok"
                : res.timedOut
                ? "timed out"
                : res.killed
                ? "cancelled"
                : `failed (exit ${res.exitCode ?? "null"})`;
            const header = `[remote-agent ${runnerKey}/${runId}] ${status}`;
            const stderr = !res.ok && res.stderr.trim() ? `\n\nstderr (tail):\n${tail(res.stderr.trim())}` : "";
            const body = `${tail(res.output.trim())}${stderr}`;

            if (!res.ok) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `${header}\n\n${body}` }],
                    details: { runner: runnerKey, runId, exitCode: res.exitCode, timedOut: res.timedOut },
                };
            }
            return {
                content: [{ type: "text", text: body }],
                details: { runner: runnerKey, runId, exitCode: res.exitCode },
            };
        },
    });
}
