/**
 * Minimal Bun.spawn wrapper: capture stdout/stderr, honor abort signal and
 * timeout, optional stdin payload. Env defaults to the parent environment
 * (runner CLIs like `container`/`kubectl` need the caller's credentials).
 */

export interface ExecResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    killed: boolean;
    timedOut: boolean;
}

export interface ExecOptions {
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    stdin?: string;
}

export async function runCommand(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const proc = Bun.spawn(argv, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdin: opts.stdin !== undefined ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });

    let killed = false;
    let timedOut = false;
    const kill = () => {
        killed = true;
        try {
            proc.kill();
        } catch {
            // already exited
        }
    };

    const onAbort = () => kill();
    if (opts.signal?.aborted) kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            kill();
        }, opts.timeoutMs)
        : undefined;

    try {
        const writePromise = opts.stdin !== undefined
            ? (async () => {
                const writer = proc.stdin.getWriter();
                await writer.write(new TextEncoder().encode(opts.stdin!));
                await writer.close();
            })().catch(() => {}) // stdin failures don't matter once the child is dying
            : undefined;
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            writePromise,
        ]);
        const exitCode = await proc.exited;
        return { exitCode, stdout, stderr, killed, timedOut };
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
    }
}

/** POSIX single-quote escape for embedding strings in `sh -c` scripts. */
export function shq(value: string): string {
    return `'` + value.replaceAll(`'`, `'\\''`) + `'`;
}
