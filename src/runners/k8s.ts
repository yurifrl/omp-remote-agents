/**
 * Kubernetes adapter: builds a Pod manifest (restartPolicy: Never,
 * activeDeadlineSeconds = timeout) plus a ConfigMap with the host agent
 * config, applies both via kubectl, waits for the pod to terminate, streams
 * logs, and reads the container exit code. Nested agent dirs are skipped
 * (ConfigMap keys are flat); remote auth relies on env passthrough.
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { K8sRunnerConfig } from "../config.ts";
import { collectOmpAgentFiles, resolvePassthroughEnv } from "../registry.ts";
import { runCommand, shq } from "../subprocess.ts";
import type { RemoteRunner, RunnerResult, RunnerSpawnSpec, SpawnOptions } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMMAND = ["bun", "x", "@oh-my-pi/pi-coding-agent@latest"];
const DEFAULT_PASSTHROUGH = ["*_API_KEY", "API_KEY", "*_TOKEN"];
const FLAT_FILES = ["config.yml", "models.yml", "settings.json"];

/** RFC1123 pod names: lowercase alnum + '-', dots only between labels. */
export function podName(id: string): string {
    return `omp-remote-${id.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase().slice(0, 48)}`;
}

export function createK8sRunner(cfg: K8sRunnerConfig, home: string): RemoteRunner {
    return {
        type: "k8s",
        async spawn(spec: RunnerSpawnSpec, opts: SpawnOptions = {}): Promise<RunnerResult> {
            const runId = randomUUID().slice(0, 8);
            const pod = podName(spec.id || runId);
            const cm = `${pod}-agentcfg`;
            const namespace = cfg.namespace ?? "default";
            const timeoutMs = spec.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const kubectl = ["kubectl", ...(cfg.kubectl ?? []), "-n", namespace];

            const stage = mkdtempSync(join(tmpdir(), "omp-remote-"));
            const created: string[] = [];
            let phase = "";
            let exitCode: number | null = null;
            let stdout = "";
            let stderr = "";
            let timedOut = false;
            try {
                // Flat agent config only (ConfigMap keys can't nest).
                const cfgDir = join(stage, "config");
                mkdirSync(cfgDir, { recursive: true });
                const files = collectOmpAgentFiles(home, { agentsDir: false });
                for (const name of FLAT_FILES) {
                    if (files[name] !== undefined) writeFileSync(join(cfgDir, name), files[name]);
                }
                const staged = FLAT_FILES.filter((n) => existsSync(join(cfgDir, n)));
                if (!staged.length) {
                    throw new Error("remote-agents: no flat agent config files found to stage (is ~/.omp/agent set up?)");
                }

                const fromFile = staged.map((n) => ["--from-file", `${n}=${join(cfgDir, n)}`]).flat();
                opts.onUpdate?.(`remote-agents: creating ConfigMap ${cm}`);
                const cmRes = await runCommand([...kubectl, "create", "configmap", cm, ...fromFile], { signal: opts.signal });
                if (cmRes.exitCode !== 0) throw new Error(`remote-agents: configmap create failed: ${cmRes.stderr.trim()}`);
                created.push(cm);

                const command = cfg.command ?? DEFAULT_COMMAND;
                const modelFlag = spec.model ? ` -m ${shq(spec.model)}` : "";
                const copyScript = [
                    `mkdir -p "$HOME/.omp/agent"`,
                    `cp /config/* "$HOME/.omp/agent/"`,
                    `exec ${command.map(shq).join(" ")}${modelFlag} -p ${shq(spec.task)}`,
                ].join(" && ");

                const env = Object.entries(resolvePassthroughEnv(cfg.envPassthrough ?? DEFAULT_PASSTHROUGH)).map(
                    ([name, value]) => ({ name, value }),
                );
                const podManifest = {
                    apiVersion: "v1",
                    kind: "Pod",
                    metadata: { name: pod },
                    spec: {
                        restartPolicy: "Never",
                        activeDeadlineSeconds: Math.ceil(timeoutMs / 1000),
                        containers: [
                            {
                                name: "agent",
                                image: cfg.image,
                                command: ["sh", "-c", copyScript],
                                env: [...env, { name: "HOME", value: "/work" }, { name: "TERM", value: "dumb" }],
                                workingDir: "/work",
                                resources: {
                                    requests: { memory: cfg.memory ?? "2Gi", cpu: String(cfg.cpus ?? 2) },
                                    limits: { memory: cfg.memory ?? "4Gi", cpu: String(cfg.cpus ?? 4) },
                                },
                                volumeMounts: [{ name: "agentcfg", mountPath: "/config", readOnly: true }],
                            },
                        ],
                        volumes: [{ name: "agentcfg", configMap: { name: cm } }],
                    },
                };
                opts.onUpdate?.(`remote-agents: creating Pod ${pod} (${cfg.image})`);
                const podRes = await runCommand([...kubectl, "create", "-f", "-"], {
                    stdin: JSON.stringify(podManifest),
                    signal: opts.signal,
                });
                if (podRes.exitCode !== 0) throw new Error(`remote-agents: pod create failed: ${podRes.stderr.trim()}`);
                created.push(pod);

                opts.onUpdate?.("remote-agents: waiting for pod to finish");
                const waitRes = await runCommand(
                    [...kubectl, "wait", `pod/${pod}`, "--for=jsonpath='{.status.phase}'=Succeeded", `--timeout=${Math.ceil(timeoutMs / 1000)}s`],
                    { signal: opts.signal, timeoutMs: timeoutMs + 30_000 },
                );
                timedOut = waitRes.killed || waitRes.timedOut;

                const probe = await runCommand(
                    [...kubectl, "get", `pod/${pod}`, "-o", "jsonpath={.status.phase} {.status.containerStatuses[0].state.terminated.exitCode}"],
                    { signal: opts.signal },
                );
                const [gotPhase, gotExit] = probe.stdout.trim().split(/\s+/);
                phase = gotPhase ?? "Unknown";
                exitCode = gotExit !== undefined && /^\d+$/.test(gotExit) ? Number(gotExit) : null;

                const logs = await runCommand([...kubectl, "logs", `pod/${pod}`, "--all-containers"], { signal: opts.signal });
                stdout = logs.stdout;
                stderr = logs.stderr;
                if (waitRes.exitCode !== 0) {
                    stderr += `\nremote-agents: pod ended in phase "${phase}", exitCode=${String(exitCode)} (kubectl wait said: ${waitRes.stderr.trim()})`;
                }
                return {
                    id: runId,
                    exitCode,
                    output: stdout,
                    stderr,
                    ok: phase === "Succeeded" && exitCode === 0 && !timedOut,
                    killed: Boolean(waitRes.killed),
                    timedOut,
                };
            } finally {
                rmSync(stage, { recursive: true, force: true });
                for (const name of [...created].reverse()) {
                    await runCommand([...kubectl, "delete", cm === name ? "configmap" : "pod", name, "--ignore-not-found", "--wait=false"], { timeoutMs: 30_000 });
                }
            }
        },
    };
}
