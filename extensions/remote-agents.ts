/**
 * remote-agents — shadows the native `task` tool and routes configured agents
 * to remote runtimes (Apple container, k8s, generic command). Agents not
 * present in remote-agents.json delegate to the native task tool via
 * ctx.invokeTool, so built-in agent behavior is preserved untouched.
 *
 * Routing rules (first match wins):
 *   1. task.agent matches an `agents[].name` entry → that entry's runner.
 *   2. no agent (or unknown agent → native) and `defaultRunner` set → default runner.
 *   3. otherwise → native task tool.
 *
 * Per task item `async: true` detaches the run: the tool returns immediately
 * with a spawned-id row, and the finished output is steered back into the
 * session as an agent message (queued behind streaming, starts a turn when idle).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentEntry, RemoteAgentsConfig, RunnerConfig } from "../src/config.ts";
import { loadRemoteAgentsConfig } from "../src/config.ts";
import { createRunner } from "../src/registry.ts";
import type { RemoteRunner, RunnerResult } from "../src/types.ts";

const STEER_CUSTOM_TYPE = "remote-agents-result";
const SUMMARY_LIMIT = 8_000;

interface RemoteTaskItem {
    task: string;
    solutionSpace: string;
    name?: string;
    agent?: string;
    model?: string;
    async?: boolean;
}

interface RunRow {
    id: string;
    agent: string;
    runner: string;
    mode: "inline" | "async" | "native";
    ok: boolean;
    exitCode: number | null;
    timedOut: boolean;
}

function tail(text: string, limit = SUMMARY_LIMIT): string {
    return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

function composePrompt(item: RemoteTaskItem): string {
    const parts = [item.task.trim()];
    if (item.solutionSpace?.trim()) {
        parts.push(`# Solution space\n${item.solutionSpace.trim()}`);
    }
    return parts.join("\n\n");
}

function resultText(res: RunnerResult): string {
    const status = res.ok ? "ok" : res.timedOut ? "timed out" : res.killed ? "cancelled" : `failed (exit ${res.exitCode ?? "null"})`;
    const stderr = !res.ok && res.stderr.trim() ? `\n\nstderr (tail):\n${tail(res.stderr.trim())}` : "";
    return `[remote-agent ${res.id}] finished: ${status}\n\n${tail(res.output.trim())}${stderr}`;
}

function textFromResult(result: { content?: Array<{ type?: string; text?: string }> }): string {
    return (result.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n");
}

function pickRunner(
    cfg: RemoteAgentsConfig | undefined,
    entry: AgentEntry | undefined,
    runnerName: string,
): RemoteRunner {
    if (!cfg || !cfg.runners[runnerName]) {
        throw new Error(`remote-agents: agent "${entry?.name ?? runnerName}" references unknown runner "${runnerName}"`);
    }
    const rc: RunnerConfig = cfg.runners[runnerName];
    return createRunner(rc, homedir());
}

/** Detached completion pump: result is steered back as an agent message. */
function spawnAsync(
    pi: ExtensionAPI,
    runner: RemoteRunner,
    runId: string,
    prompt: string,
    model: string | undefined,
    cwd: string,
): void {
    void runner
        .spawn({ id: runId, task: prompt, model, cwd })
        .then((res) =>
            pi.sendMessage(
                { customType: STEER_CUSTOM_TYPE, content: resultText(res) },
                { deliverAs: "nextTurn", triggerTurn: true, attribution: "agent" },
            ),
        )
        .catch((err: unknown) =>
            pi.sendMessage(
                {
                    customType: STEER_CUSTOM_TYPE,
                    content: `[remote-agent ${runId}] runner crashed: ${err instanceof Error ? err.message : String(err)}`,
                },
                { deliverAs: "nextTurn", triggerTurn: true, attribution: "agent" },
            ),
        );
}

export default function (pi: ExtensionAPI) {
    const z = pi.zod;

    const taskItem = z
        .object({
            task: z.string(),
            solutionSpace: z.string(),
            name: z.string().optional(),
            agent: z.string().optional(),
            model: z.string().optional(),
            effort: z.enum(["lo", "med", "hi"]).optional(),
            async: z.boolean().optional(),
        })
        .passthrough();

    pi.registerTool({
        name: "task",
        label: "Task",
        description:
            "Delegate work to subagent(s). Configured agents (remote-agents.json) run on remote runtimes; " +
            "unknown agents fall through to the native task tool. Use `async: true` per item to detach a run " +
            "and receive its output as a steered message on completion.",
        parameters: z
            .object({
                context: z.string().optional(),
                tasks: z.array(taskItem).min(1),
                i: z.string().optional(),
            })
            .passthrough(),

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const cfg = loadRemoteAgentsConfig(process.cwd());
            const cwd = process.cwd();
            const rows: RunRow[] = [];
            const sections: string[] = [];
            const context = typeof params.context === "string" ? params.context : undefined;

            for (const raw of params.tasks as RemoteTaskItem[]) {
                // Route: configured agent entry → its runner; agentless → defaultRunner
                // when set (remote becomes the default delegation target); else native.
                const entry = raw.agent ? cfg?.agents.find((a) => a.name === raw.agent) : undefined;
                const runnerName = entry?.runner ?? (raw.agent ? undefined : cfg?.defaultRunner);
                const label = raw.name ?? raw.agent ?? runnerName ?? "task";
                const prompt = context ? `${context.trim()}\n\n${composePrompt(raw)}` : composePrompt(raw);

                if (runnerName) {
                    const runId = `ra-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
                    const runner = pickRunner(cfg, entry, runnerName);
                    const model = raw.model ?? entry?.model;
                    if (raw.async) {
                        spawnAsync(pi, runner, runId, prompt, model, cwd);
                        rows.push({ id: runId, agent: label, runner: runnerName, mode: "async", ok: true, exitCode: null, timedOut: false });
                        sections.push(`- ${label}: spawned remotely (${runnerName}) as \`${runId}\`; output arrives as a message when done`);
                        continue;
                    }
                    onUpdate?.({ content: [{ type: "text", text: `→ ${label}: running remotely on ${runnerName} (${runId})…` }] });
                    const res = await runner.spawn({ id: runId, task: prompt, model, cwd }, { signal });
                    rows.push({ id: res.id, agent: label, runner: runnerName, mode: "inline", ok: res.ok, exitCode: res.exitCode, timedOut: res.timedOut });
                    sections.push(resultText(res));
                    continue;
                }

                // Native fallthrough (unknown/omitted agent, or no remote config at all).
                if (!ctx.invokeTool) {
                    throw new Error("remote-agents: invokeTool unavailable — cannot delegate to native task tool");
                }
                const native = await ctx.invokeTool({ ...params, tasks: [raw] }, { signal, onUpdate });
                rows.push({ id: `native-${randomUUID().slice(0, 6)}`, agent: raw.agent ?? "native", runner: "native", mode: "native", ok: true, exitCode: 0, timedOut: false });
                const text = textFromResult(native as { content?: Array<{ type?: string; text?: string }> });
                sections.push(text || "native task returned no text");
            }

            return {
                content: [{ type: "text", text: sections.join("\n\n") }],
                details: { runs: rows },
            };
        },
    });
}
