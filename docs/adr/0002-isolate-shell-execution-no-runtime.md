# Execution runs in an isolate shell, so the Harness cannot run the code it writes

Execution goes through `@cloudflare/computer` using its Isolate Shell backend (`just-bash` in a Dynamic Worker over a Durable-Object-owned SQLite filesystem), pinned to an exact version and reached only through a four-method internal interface (`exec`, `readFile`, `writeFile`, `listDir`). We chose this over the Container backend and over the stable Sandbox SDK because keeping the Harness lightweight — no containers, no cold starts, no per-container billing — was the defining constraint.

Two costs were accepted knowingly. First, `@cloudflare/computer` is explicitly preview software: its README states the APIs are unstable and that it is not suitable for production. The four-method wrapper and the pinned version are the entire mitigation — an upstream break must land in one file. Second, `just-bash` cannot execute `node`, `npm`, `git`, or any native binary, and cannot spawn processes.

## Consequences

The Harness is an **authoring** tool, not a verifying one. It can read, write, refactor, and reason about code using `grep`, `sed`, `awk`, `find`, `jq`, `sqlite3`, `rg`, and `diff`, but it cannot install dependencies, run a build, or run a test suite. Every change it makes is unverified until a human runs it elsewhere. This is a real capability gap against terminal-based agents and was accepted deliberately, not overlooked.

The UI must surface this rather than fail opaquely: when a Skill's bundled script needs a runtime the backend cannot provide, the Harness says so by name. A Container-backed "Heavy Mode" is a future second implementation of the same four-method interface, not a rewrite.

## Verified by Spike A (2026-08-11, deployed Worker, `@cloudflare/computer@0.2.0`)

The ceiling is real and slightly lower than assumed. Measured live, not inferred:

**Works** — the Durable-Object-backed filesystem, and `echo`, `ls`, `cat`, `grep`, `sed`, `awk`, `find`, `sort`, `wc`, `jq`, pipelines, redirection, and `for` loops. Execution latency was 47–124 ms per command after a 490 ms first call, which comfortably supports the lightweight thesis.

**Does not work** — `python3` fails with *"command not available in browser environments"*, confirming the caveat this ADR flagged as unverified. `sqlite3` fails with *"sqlite3 worker not found. Run 'pnpm build' to compile the worker."* The published package contains no `.wasm` artifacts at all, so both optional feature groups ship their JavaScript wrappers without the compiled runtimes behind them. `sqlite3` looks like a packaging defect that may be fixed upstream; `python3` looks like a genuine platform limit.

**Ceiling holds** — `node` and `npm` return exit 127, command not found.

Two undocumented requirements, neither in the 0.2.0 README: the entry module must re-export `WorkspaceServiceProxy` and `WorkspaceProxy` from `@cloudflare/computer`, or every `exec()` throws `ctx.exports.WorkspaceServiceProxy is not a function`; and the README's instruction to set the `experimental` compatibility flag is wrong — Cloudflare rejects that flag on deploy, and `enable_ctx_exports` has been default-on since 2025-11-17, so neither flag should be set.

Consequence for Preloaded Skills: the planned `data-wrangling` Skill was premised on `jq` **and** `sqlite3`. Only `jq` is available.
