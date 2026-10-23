/**
 * Minimal Bun.spawn wrapper: capture stdout/stderr, honor abort signal and
 * timeout, optional stdin payload. Env defaults to the parent environment
 * (runner CLIs like `ax` need the caller's credentials).
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
    /** String or binary payload piped to the child's stdin (closed at EOF). */
    stdin?: string | Uint8Array;
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
                // Bun's stdin is a FileSink, not a web WritableStream.
                if (typeof opts.stdin === "string") {
                    proc.stdin.write(new TextEncoder().encode(opts.stdin));
                } else {
                    proc.stdin.write(opts.stdin);
                }
                await proc.stdin.end();
            })().catch(() => {}) // stdin failures don't matter once the child is dying
            : undefined;
        const [stdout, stderr] = await Promise.all([
            new Response(opts.onStdoutChunk ? streamStdout(proc.stdout, opts.onStdoutChunk) : proc.stdout).text(),
            new Response(opts.onStderrChunk ? streamStdout(proc.stderr, opts.onStderrChunk) : proc.stderr).text(),
            writePromise,
        ]);
        const exitCode = await proc.exited;
        return { exitCode, stdout, stderr, killed, timedOut };
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
    }
}

/** Decoded-readable passthrough that forwards each chunk to `onChunk`. */
function streamStdout(source: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const wrapped = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            onChunk(decoder.decode(chunk, { stream: true }));
            controller.enqueue(chunk);
        },
        flush(controller) {
            const rest = decoder.decode();
            if (rest) onChunk(rest);
            controller.terminate();
        },
    }));
    return wrapped;
}

/** POSIX single-quote escape for embedding strings in `sh -c` scripts. */
export function shq(value: string): string {
    return `'` + value.replaceAll(`'`, `'\\''`) + `'`;
}
