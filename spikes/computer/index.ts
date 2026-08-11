/**
 * M0 / Spike A — does @cloudflare/computer's worker-shell backend actually
 * work in a *deployed* Worker, and do python3 / sqlite3 survive there?
 *
 * ADR-0002 records these as unverified: just-bash documents python3, sqlite3
 * and js-exec as requiring Node.js and unavailable in browsers, and a Workers
 * isolate is neither. This spike answers that with evidence rather than
 * inference. Throwaway code — not the shape M1 will take.
 */
import { withWorkspace, getWorkspace } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import pythonModules from "@cloudflare/computer/shell/python";
import sqliteModules from "@cloudflare/computer/shell/sqlite";
import jqModules from "@cloudflare/computer/shell/jq";
import { DurableObject } from "cloudflare:workers";

// The worker-shell backend spawns a Dynamic Worker that calls back into this
// Workspace. It resolves that callback through `ctx.exports`, which only sees
// named exports of the *entry* module — so these must be re-exported here or
// exec() fails with "ctx.exports.WorkspaceServiceProxy is not a function".
// Undocumented in the package README as of 0.2.0.
export { WorkspaceServiceProxy, WorkspaceProxy } from "@cloudflare/computer";

interface Env {
  Agent: DurableObjectNamespace;
  LOADER: unknown;
}

export class Agent extends withWorkspace(
  class extends DurableObject<Env> {},
  (self: any) => ({
    storage: self.ctx.storage,
    backends: [
      new WorkerShellBackend({
        loader: self.env.LOADER,
        workspace: { binding: "Agent", id: self.ctx.id.toString() },
        ctx: self.ctx,
        commands: [pythonModules, sqliteModules, jqModules],
      }),
    ],
  }),
) {}

type Probe = {
  name: string;
  cmd: string;
  /** What we expect stdout to contain. Absent means "just report it". */
  expect?: string;
  /** True when this probe is expected to FAIL — proving the ADR-0002 ceiling. */
  expectFailure?: boolean;
};

const PROBES: Probe[] = [
  // Core shell — the floor. If these fail, the backend is unusable.
  { name: "echo", cmd: "echo hello-harness", expect: "hello-harness" },
  { name: "ls", cmd: "ls /workspace", expect: "probe.txt" },
  { name: "cat", cmd: "cat /workspace/probe.txt", expect: "alpha" },

  // Text surgery — the tools the Harness actually lives on (ADR-0002).
  { name: "grep", cmd: "grep -n beta /workspace/probe.txt", expect: "beta" },
  { name: "sed", cmd: "sed 's/alpha/ALPHA/' /workspace/probe.txt", expect: "ALPHA" },
  { name: "awk", cmd: "awk '{print NR\": \"$1}' /workspace/probe.txt", expect: "1:" },
  { name: "find", cmd: "find /workspace -name '*.txt'", expect: "probe.txt" },
  { name: "sort+wc", cmd: "sort /workspace/probe.txt | wc -l", expect: "3" },
  { name: "pipeline", cmd: "cat /workspace/probe.txt | grep -c ." , expect: "3" },
  { name: "redirect", cmd: "echo written > /workspace/out.txt && cat /workspace/out.txt", expect: "written" },
  { name: "for-loop", cmd: "for i in 1 2 3; do echo n$i; done", expect: "n3" },

  // Optional feature groups — the actual open question from ADR-0002.
  { name: "jq", cmd: "echo '{\"a\":{\"b\":42}}' | jq '.a.b'", expect: "42" },
  { name: "python3", cmd: "python3 -c \"print(6*7)\"", expect: "42" },
  {
    name: "sqlite3",
    cmd: "sqlite3 /workspace/t.db 'create table x(v int); insert into x values(42); select v from x;'",
    expect: "42",
  },

  // The ceiling. These SHOULD fail — ADR-0002 depends on them failing,
  // and a surprise pass would mean the whole "authoring not verifying"
  // framing needs revisiting.
  { name: "node (expect absent)", cmd: "node --version", expectFailure: true },
  { name: "npm (expect absent)", cmd: "npm --version", expectFailure: true },
  { name: "git (expect absent)", cmd: "git --version", expectFailure: true },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const id = env.Agent.idFromName("spike-" + (new URL(request.url).searchParams.get("ws") ?? "default"));
    using ws: any = await getWorkspace(env.Agent.get(id) as any);

    const results: Record<string, unknown>[] = [];
    let fsOk = false;
    let fsError: string | null = null;

    // Probe 0: the filesystem itself, with no execution backend involved.
    try {
      await ws.fs.mkdir("/workspace", { recursive: true });
      await ws.fs.writeFile("/workspace/probe.txt", "alpha\nbeta\ngamma\n");
      const back = await ws.fs.readFile("/workspace/probe.txt", "utf8");
      fsOk = back === "alpha\nbeta\ngamma\n";
    } catch (e: any) {
      fsError = String(e?.stack ?? e);
    }

    for (const probe of PROBES) {
      const t0 = Date.now();
      try {
        using run = await ws.runtime.exec(probe.cmd, { encoding: "utf8" });
        const { stdout, stderr, exitCode } = await run.result();
        const out = String(stdout ?? "").trim();
        const ran = exitCode === 0;
        const matched = probe.expect ? out.includes(probe.expect) : ran;

        results.push({
          probe: probe.name,
          // A "pass" for a ceiling probe means it correctly refused to run.
          pass: probe.expectFailure ? !ran : ran && matched,
          exitCode,
          stdout: out.slice(0, 300),
          stderr: String(stderr ?? "").trim().slice(0, 300),
          ms: Date.now() - t0,
        });
      } catch (e: any) {
        results.push({
          probe: probe.name,
          pass: probe.expectFailure === true,
          threw: String(e?.message ?? e).slice(0, 300),
          ms: Date.now() - t0,
        });
      }
    }

    const capabilities = results.filter((r) => !String(r.probe).includes("expect absent"));
    const ceiling = results.filter((r) => String(r.probe).includes("expect absent"));

    return Response.json(
      {
        spike: "A — @cloudflare/computer worker-shell in a deployed Worker",
        packageVersion: "0.2.0",
        filesystem: { ok: fsOk, error: fsError },
        summary: {
          capabilitiesPassed: `${capabilities.filter((r) => r.pass).length}/${capabilities.length}`,
          ceilingHeld: `${ceiling.filter((r) => r.pass).length}/${ceiling.length}`,
          totalMs: Date.now() - started,
        },
        results,
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
} satisfies ExportedHandler<Env>;
