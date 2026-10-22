/**
 * Runner port: the seam between omp's task delegation and any remote runtime.
 * Adapters implement `RemoteRunner`; the extension maps configured agent names
 * to runners. Adding a future runtime = implementing this interface (or using
 * the `command` generic adapter via config), never touching the extension core.
 */

export interface RunnerSpawnSpec {
    /** Unique run id (used as container/pod name suffix). */
    id: string;
    /** Agent name from remote-agents.json (e.g. "remote-container"). */
    agent: string;
    /** Display label (task item `name`, falls back to agent name). */
    name: string;
    /** The task prompt handed to the remote omp process. */
    task: string;
    /** Optional model override passed to the remote `omp -p --model`. */
    model?: string;
    /** Host working directory made available to the remote runtime. */
    cwd: string;
    /** Per-run timeout override (ms). */
    timeoutMs?: number;
}

export interface RunnerResult {
    id: string;
    exitCode: number | null;
    /** Remote agent stdout (final message plus any non-JSON noise). */
    output: string;
    stderr: string;
    ok: boolean;
    killed: boolean;
    timedOut: boolean;
}

export interface SpawnOptions {
    onUpdate?: (message: string) => void;
    signal?: AbortSignal;
}

export interface RemoteRunner {
    /** Adapter kind, mirrors RunnerConfig.type. */
    readonly type: string;
    spawn(spec: RunnerSpawnSpec, opts?: SpawnOptions): Promise<RunnerResult>;
}
