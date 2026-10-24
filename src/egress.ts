/**
 * Actor egress policy management for ax Tasks.
 *
 * Substrate sandboxes have no network egress until an Actor's singleton
 * `default` EgressPolicy exists; the gvisor worker resolves this lazily at
 * the first DNS query and caches the answer for the actor's lifetime. A
 * policy created after boot is never re-read (the sandbox may not issue
 * another DNS query), so the runner MUST create the policy in the window
 * between `ax apply` (actor exists, suspended, no traffic) and the first
 * resume — see src/runners/ax.ts.
 *
 * Transport: direct gRPC to the ate-api Control service. Rules use TLS
 * passthrough (SNI forwarding, no MITM) so guests keep their stock trust
 * store — no gateway-CA distribution needed. Reachability from the host is
 * via `kubectl port-forward` to the ate-api `api` Service; the forwarded TLS
 * chain is a short-lived servicedns leaf the host cannot verify, hence the
 * default-off certificate check (documented, loopback-tunnel-only).
 *
 * Protobuf is hand-encoded (field numbers pinned against
 * substrate/pkg/proto/ateapipb/ateapi.proto, v0.5.0) to keep the runner
 * dependency-free.
 *
 * Wire shapes used:
 *   CreateActorEgressPolicyRequest { ObjectRef actor=1; EgressPolicy egress_policy=2; }
 *   GetActorEgressPolicyRequest    { ObjectRef actor=1; string name=2; }
 *   UpdateActorEgressPolicyRequest { ObjectRef actor=1; EgressPolicy egress_policy=2; }
 *   DeleteActorEgressPolicyRequest { ObjectRef actor=1; string name=2; }
 *   EgressPolicy  { ResourceMetadata metadata=1; repeated EgressRule rules=2; }
 *   ResourceMetadata { string atespace=1; string name=2; ... }
 *   EgressRule  { HttpRule http=1; HttpsRule https=2; TlsPassthroughRule tls_passthrough=3; }
 *   HttpRule    { repeated string hostnames=1; Ports ports=2; }
 *   HttpsRule   { repeated string hostnames=1; Ports ports=2; }
 *   TlsPassthroughRule { repeated string hostnames=1; Ports ports=2; }
 *   Ports       { AllPorts all=1; repeated int32 numbers=2; }
 *   ObjectRef   { string atespace=1; string name=2; }
 */

import http2 from "node:http2";

/** One egress rule: passthrough TLS to the given SNI hostnames (and ports). */
export interface EgressTlsPassthroughRule {
    hostnames: string[];
    /** Destination ports; omit for every port. */
    ports?: number[];
}

export interface EgressPolicySpec {
    rules: EgressTlsPassthroughRule[];
}

interface EgressClientOptions {
    /** Loopback address of the kubectl port-forward to ate-api:443. */
    endpoint: string;
    /** Bearer token presented to ate-api (SA token minted for ax-server). */
    token: string;
    /** Skip TLS verification; required for the loopback tunnel (leaf-only chain). */
    rejectUnauthorized?: boolean;
    timeoutMs?: number;
}

/** `kubectl -n ate-system create token ax-server --audience=api.ate-system.svc --duration=1h`.
 * axBase is `[kubectl, --context=X]`; namespace is prepended before the verb. */
export function ateApiToken(axBase: string[], signal?: AbortSignal): Promise<string> {
    return import("node:child_process").then(({ execFile }) =>
        new Promise<string>((resolve, reject) => {
            execFile(
                axBase[0]!,
                [...axBase.slice(1), "-n", "ax-system", "create", "token", "ax-server", "--audience=api.ate-system.svc", "--duration=1h"],
                { timeout: 30_000, signal },
                (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim())),
            );
        }),
    );
}

// --- protobuf wire encoding -------------------------------------------------

function varint(n: number): number[] {
    const out: number[] = [];
    let v = n;
    for (;;) {
        if (v < 0x80) {
            out.push(v);
            return out;
        }
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
}

function tagged(field: number, wire: number, payload: number[]): number[] {
    return [field << 3 | wire, ...varint(payload.length), ...payload];
}

function str(field: number, value: string): number[] {
    return tagged(field, 2, [...Buffer.from(value, "utf8")]);
}

function msg(field: number, bytes: Uint8Array): number[] {
    return tagged(field, 2, [...bytes]);
}

function u32(field: number, value: number): number[] {
    return [field << 3 | 0, ...varint(value)];
}

function objectRef(atespace: string, name: string): Uint8Array {
    return Uint8Array.from([...str(1, atespace), ...str(2, name)]);
}

function ports(numbers?: number[]): Uint8Array {
    // No numbers given → AllPorts (field 1, empty message); otherwise repeated numbers.
    return numbers?.length ? Uint8Array.from(numbers.flatMap((n) => u32(2, n))) : Uint8Array.from([1 << 3 | 2, 0]);
}

function egressPolicy(atespace: string, rules: EgressTlsPassthroughRule[], uid?: string, version?: number): Uint8Array {
    // ResourceMetadata { atespace=1, name=2, uid=3, version=4 } — uid/version are
    // update preconditions, omitted on create.
    const meta = Uint8Array.from([
        ...str(1, atespace),
        ...str(2, "default"),
        ...(uid !== undefined ? str(3, uid) : []),
        ...(version !== undefined ? u32(4, version) : []),
    ]);
    // EgressRule { tls_passthrough = 3: TlsPassthroughRule { hostnames = 1; ports = 2 } }
    const ruleBytes = rules.map((rule) => {
        const hostnames = rule.hostnames.flatMap((h) => str(1, h));
        const tls = Uint8Array.from([...hostnames, ...msg(2, ports(rule.ports))]);
        return Uint8Array.from(msg(3, tls));
    });
    return Uint8Array.from([...msg(1, meta), ...ruleBytes.flatMap((r) => msg(2, r))]);
}

function createRequest(atespace: string, actor: string, rules: EgressTlsPassthroughRule[]): Uint8Array {
    return Uint8Array.from([...msg(1, objectRef(atespace, actor)), ...msg(2, egressPolicy(atespace, rules))]);
}

function updateRequest(atespace: string, actor: string, uid: string, version: number, rules: EgressTlsPassthroughRule[]): Uint8Array {
    return Uint8Array.from([...msg(1, objectRef(atespace, actor)), ...msg(2, egressPolicy(atespace, rules, uid, version))]);
}

/** Pull the update preconditions (metadata.uid, metadata.version) out of a GET
 * EgressPolicy response. ResourceMetadata: atespace=1, name=2, uid=3, version=4. */
function readPreconditions(payload: Buffer | null): { uid: string; version: number } {
    if (!payload || payload.length === 0 || payload[0] !== 0x0a) throw new Error("GetActorEgressPolicy returned no metadata; cannot build update preconditions");
    const metaLen = payload[1]!;
    const meta = payload.subarray(2, 2 + metaLen);
    let uid = "";
    let version = 0;
    let p = 0;
    while (p < meta.length) {
        const tag = meta[p++]!;
        const field = tag >> 3;
        const wire = tag & 7;
        if (wire === 2) {
            const len = meta[p++]!;
            const val = meta.subarray(p, p + len);
            p += len;
            if (field === 3) uid = val.toString();
        } else if (wire === 0) {
            let shift = 0;
            let n = 0;
            let b;
            do {
                b = meta[p++]!;
                n |= (b & 127) << shift;
                shift += 7;
            } while (b & 128);
            if (field === 4) version = n;
        } else {
            throw new Error(`unexpected wire type ${wire} in metadata; cannot build update preconditions`);
        }
    }
    if (!uid || !version) throw new Error(`GetActorEgressPolicy metadata missing uid/version (uid=${uid}, version=${version})`);
    return { uid, version };
}

function getRequest(atespace: string, actor: string): Uint8Array {
    return Uint8Array.from([...msg(1, objectRef(atespace, actor)), ...str(2, "default")]);
}

/** Grpc framed message: 1 byte compressed flag + 4-byte big-endian length + payload. */
function grpcFrame(payload: Uint8Array): Buffer {
    const frame = Buffer.alloc(5 + payload.length);
    frame.writeUInt32BE(payload.length, 1);
    Buffer.from(payload).copy(frame, 5);
    return frame;
}

/** Single grpc framed message → { payload, grpcStatus, grpcMessage }. */
function grpcUnframe(chunks: Buffer[]): { payload: Buffer | null; grpcStatus?: string; grpcMessage?: string } {
    const buf = Buffer.concat(chunks);
    if (buf.length < 5) return { payload: null };
    return { payload: buf.subarray(5, 5 + buf.readUInt32BE(1)) };
}

// --- gRPC over node:http2 ---------------------------------------------------

interface CallResult {
    grpcStatus?: string;
    grpcMessage?: string;
    payload: Buffer | null;
}

function call(client: http2.ClientHttp2Session, path: string, token: string, payload: Uint8Array, timeoutMs: number): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const req = client.request({
            ":method": "POST",
            ":path": path,
            "content-type": "application/grpc",
            te: "trailers",
            authorization: `Bearer ${token}`,
            "grpc-timeout": `${Math.ceil(timeoutMs / 1000)}S`,
        });
        const chunks: Buffer[] = [];
        const result: CallResult = { payload: null };
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            req.close();
            fn();
        };
        req.on("response", (h: Record<string, string | string[]>) => {
            // Trailers-only replies carry grpc-status on the response headers.
            if (h["grpc-status"] !== undefined && result.grpcStatus === undefined) {
                result.grpcStatus = String(h["grpc-status"]);
                result.grpcMessage = String(h["grpc-message"] ?? "");
            }
        }); // grpc-status normally arrives on trailers, not headers
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("trailers", (t: Record<string, string>) => {
            result.grpcStatus = String(t["grpc-status"] ?? "");
            result.grpcMessage = String(t["grpc-message"] ?? result.grpcMessage ?? "");
        });
        req.on("end", () => finish(() => resolve({ ...result, ...grpcUnframe(chunks) })));
        req.on("error", (e: Error) => finish(() => reject(e)));
        req.end(grpcFrame(payload));
        setTimeout(() => finish(() => reject(new Error(`ate-api call ${path} timed out after ${timeoutMs}ms`))), timeoutMs);
    });
}

// --- public operations ------------------------------------------------------

function connect(endpoint: string, rejectUnauthorized: boolean): Promise<http2.ClientHttp2Session> {
    return new Promise((resolve, reject) => {
        const client = http2.connect(`https://${endpoint}`, rejectUnauthorized ? undefined : { rejectUnauthorized: false });
        client.on("error", reject);
        client.on("connect", () => resolve(client));
    });
}

/** Create or replace the actor's singleton `default` egress policy. */
export async function ensureEgressPolicy(
    opts: EgressClientOptions & { atespace: string; actor: string; policy: EgressPolicySpec },
): Promise<void> {
    const timeout = opts.timeoutMs ?? 15_000;
    const client = await connect(opts.endpoint, opts.rejectUnauthorized ?? false);
    try {
        const get = await call(client, "/ateapi.Control/GetActorEgressPolicy", opts.token, getRequest(opts.atespace, opts.actor), timeout);
        if (get.grpcStatus === "" || get.grpcStatus === "0") {
            // Update is a full replacement with UID+version preconditions; both
            // are read back from the GET response (ResourceMetadata fields 3/4).
            const { uid, version } = readPreconditions(get.payload);
            const upd = await call(
                client,
                "/ateapi.Control/UpdateActorEgressPolicy",
                opts.token,
                updateRequest(opts.atespace, opts.actor, uid, version, opts.policy.rules),
                timeout,
            );
            if (upd.grpcStatus !== "" && upd.grpcStatus !== "0") throw new Error(`UpdateActorEgressPolicy failed: ${upd.grpcMessage || upd.grpcStatus}`);
            return;
        }
        if (get.grpcStatus === "5") {
            // NotFound → create. Any other status is an error worth surfacing.
            const created = await call(
                client,
                "/ateapi.Control/CreateActorEgressPolicy",
                opts.token,
                createRequest(opts.atespace, opts.actor, opts.policy.rules),
                timeout,
            );
            if (created.grpcStatus !== "" && created.grpcStatus !== "0") throw new Error(`CreateActorEgressPolicy failed: ${created.grpcMessage || created.grpcStatus}`);
            return;
        }
        throw new Error(`GetActorEgressPolicy failed: ${get.grpcMessage || get.grpcStatus}`);
    } finally {
        client.close();
    }
}

/**
 * One-shot convenience for the runner: mint an ax-server SA token, open a
 * `kubectl port-forward` tunnel to the ate-api Service, ensure the policy,
 * then kill the tunnel. Rejects on any failure; the port-forward child is
 * always reaped.
 */
export async function ensureActorEgress(opts: {
    atespace: string;
    actor: string;
    policy: EgressPolicySpec;
    /** kubectl argv prefix (e.g. ["kubectl", "--context=my-cluster"]). */
    kubectl?: string[];
    /** ate-system namespace; default "ate-system". */
    ateNamespace?: string;
    signal?: AbortSignal;
}): Promise<void> {
    const { execFile, spawn } = await import("node:child_process");
    const kubectl = opts.kubectl ?? ["kubectl"];
    const ns = opts.ateNamespace ?? "ate-system";

    const token = await ateApiToken(kubectl, opts.signal);

    const pf = spawn(kubectl[0]!, [...kubectl.slice(1), "-n", ns, "port-forward", "svc/api", `0:443`], {
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
    });
    const pfOut: Buffer[] = [];
    pf.stdout!.on("data", (c: Buffer) => pfOut.push(c));
    pf.stderr!.on("data", (c: Buffer) => pfOut.push(c));
    try {
        // kubectl binds an ephemeral local port ("0:443"); it announces the
        // actual port on stdout. Wait for that line (bind failure → early
        // exit → surfaced by the exit check below).
        const deadline = Date.now() + 30_000;
        for (;;) {
            if (pf.exitCode !== null) throw new Error(`kubectl port-forward exited early with ${pf.exitCode}`);
            if (Date.now() >= deadline) throw new Error("kubectl port-forward never announced its local port");
            const m = Buffer.concat(pfOut).toString("utf8").match(/Forwarding from 127\.0\.0\.1:(\d+)/);
            if (m) {
                await ensureEgressPolicy({
                    endpoint: `127.0.0.1:${m[1]}`,
                    token,
                    atespace: opts.atespace,
                    actor: opts.actor,
                    policy: opts.policy,
                    rejectUnauthorized: false,
                });
                break;
            }
            await delay(250);
        }
    } finally {
        pf.kill("SIGTERM");
        await new Promise<void>((resolve) => {
            pf.once("exit", () => resolve());
            const t = setTimeout(resolve, 2_000);
            if (typeof t === "object" && t !== null && "unref" in t) t.unref();
        });
    }
}

function delay(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}
