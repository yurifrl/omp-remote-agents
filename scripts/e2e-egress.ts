// E2E probe: exercises the full ax-runner path with the pre-created egress
// policy — apply → policy → resume → payload staged → guest fetches the
// configured hostnames → result parsed.
import { createAxRunner } from "../src/runners/ax.ts";

// Defaults to the public ax-task-runner image (the global runner config's
// image); override with E2E_IMAGE for cluster-local mirrors.
const image = process.env.E2E_IMAGE ?? "ghcr.io/yurifrl/ax/ax-task-runner@sha256:dfb764969ee8f9dbdf59f681bf07cba01a14bfd64d9753ad860fc64a336a8ac9";

const runner = createAxRunner({
    type: "ax",
    image,
    // TLS passthrough only — no gateway CA trust needed in the guest.
    egress: {
        rules: [{ hostnames: ["api.anthropic.com", "api.openai.com", "registry.npmjs.org"], ports: [443] }],
    },
});

const res = await runner.spawn(
    {
        id: "egress-e2e",
        agent: "remote-ax",
        name: "egress-e2e",
        cwd: "/tmp/egress-e2e-cwd",
        command: `python3 -c 'import httpx\nfor u in ["https://api.anthropic.com/v1/messages","https://api.openai.com/v1/models","https://registry.npmjs.org/bun/latest"]:\n    try:\n        r = httpx.post(u, json={}, timeout=15)\n        print(u, "->", r.status_code)\n    except Exception as e:\n        print(u, "-> ERR", type(e).__name__, str(e)[:120])'`,
        timeoutMs: 10 * 60_000,
    },
    { onUpdate: (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`) },
);

console.log("--- result ---");
console.log("exitCode:", res.exitCode);
console.log(res.output);
if (res.stderr) console.log("stderr:", res.stderr);
process.exit(res.exitCode === 0 ? 0 : 1);
