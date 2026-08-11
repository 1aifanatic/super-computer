<div align="center">

<img src="ui/public/icon.svg" width="88" alt="Super" />

# Super

**A lightweight AI coding agent that lives entirely on Cloudflare.**
Chat with it, and it reads, writes, refactors and commits real code in a persistent workspace.

Cheap by default · Bring any model · Ask a council of them · Install skills from GitHub

[Quick start](#quick-start) · [What it costs](#what-it-costs) · [Architecture](#architecture) · [Contributing](CONTRIBUTING.md)

</div>

---

## What this is

Super is a ChatGPT-style interface in front of a real coding agent. The agent has a **persistent filesystem**, a **real shell**, and **real git** — all running inside Cloudflare's edge, with no server to manage and nothing to install locally.

It is deliberately small. The whole thing is a single Cloudflare Worker, two Durable Object classes, one D1 database and a React app.

> ### ⚠️ Read this before you get excited
>
> **Super cannot run the code it writes.** There is no `node`, no `npm`, no `python`, no build step and no test runner. It is an *authoring* tool, not a verifying one — every change it makes is unverified until you run it yourself.
>
> This is a deliberate trade for staying lightweight, not an oversight. It is documented in [ADR-0002](docs/adr/0002-isolate-shell-execution-no-runtime.md), and the UI says so on every screen. If you need an agent that runs your test suite, use one that runs on a real machine.

## The crux: Cloudflare Computer

Super is built on **[`@cloudflare/computer`](https://github.com/cloudflare/computer)** — the piece that makes all of this possible.

It provides a SQLite-backed virtual filesystem inside a Durable Object, with a pluggable execution layer. Super uses its **worker-shell** backend: [just-bash](https://github.com/vercel-labs/just-bash) running in a [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/), which means a real shell with **no container, no Docker and no cold start** — measured at **47–124 ms per command**.

Configuring its git client also switches on a real `git` in that shell, so the agent gets clone, status, diff, commit, branch and log through the tool it already had.

> `@cloudflare/computer` is **preview software** — its own README says the APIs are unstable and it is not production-ready. Super pins an exact version and reaches it through a four-method wrapper so an upstream break lands in one file. If you build on it, do the same.

## Highlights

### 💸 Cheapest-model-first, on purpose

The default model is **[MiniMax M2.7](https://www.minimax.io/)** at **$0.30 / $1.20 per million** input/output tokens — roughly an order of magnitude below frontier pricing, while being genuinely good at tool use.

MiniMax also does **automatic prompt caching at $0.06/M** — a fifth of the input price. Super is built around that: the system prompt is *frozen* for the life of a conversation so it keeps hitting the cache. Measured on a real 9,051-token prefix:

| | Tokens | Cost |
|---|---|---|
| Without caching | 9,051 fresh | $0.00272 |
| **With a stable prefix** | **8,955 cached (98.9%)** | **$0.00057** |

That is a **4.8× saving on every single iteration** of an agent loop, and it is why [ADR-0007](docs/adr/0007-frozen-prompt-prefix.md) forbids touching the system prompt mid-conversation. The UI shows the cached-token count on every turn so you can see the moment someone breaks it.

### 🏛️ Council of LLMs

Ask several models the same question at once and have a cheap **Chair** synthesise one answer. Inspired by the *LLM council* pattern popularised by Andrej Karpathy's [`karpathy/llm-council`](https://github.com/karpathy/llm-council).

Two deliberate differences from the original:

- **No peer-review round.** Karpathy's council has models review and rank each other before the chairman synthesises. Super skips that — it multiplies token cost by the number of rounds for a benefit that is hard to demonstrate. Members answer independently, the Chair merges.
- **Members cannot act.** They hold read-only tools and cannot write a byte. `bash` is excluded outright, because a shell that can redirect (`echo x > f`) is a write tool wearing a read tool's name. Several agents writing to one filesystem is a conflict problem with no good answer. See [ADR-0004](docs/adr/0004-council-is-advisory-only.md).

Council is **opt-in per turn** and shows an estimated cost *before* it runs, because it directly contradicts the cheap-by-default goal.

### 🔌 Any model is a row, not a code change

Adding a provider means inserting a **Model Profile** — base URL, secret name, model id, prices. Anything speaking the OpenAI chat-completions shape works: MiniMax, DeepSeek, Groq, Kimi, Together, OpenRouter. Cloudflare Workers AI is supported as a second, genuinely different dialect, which is what proves the abstraction rather than merely asserting it.

Credentials are never stored in the database — a profile names a Worker secret, and the UI tells you when that secret is missing.

### 🧩 Skills, installable from GitHub

Skills use the open **Agent Skills** format: a folder with a `SKILL.md` carrying `name` and `description` frontmatter. Paste a GitHub URL and Super fetches the tarball, unpacks it *inside the Worker* and installs it.

Only `name` + `description` (~30 tokens each) sit in the system prompt; the body loads on demand via `load_skill`. **Nothing installed from GitHub can run until you have read it and approved it** — a skill body is instructions your model will obey, which is a prompt-injection vector wearing a helpful hat.

Five skills ship built in: `code-search`, `refactor`, `json-wrangling`, `doc-writer`, `skill-author`.

### 🐙 Real git

Bind a workspace to a GitHub repo and it is cloned with genuine history — branches, diffs, log, commit. HTTPS only; there is no SSH transport. See [ADR-0010](docs/adr/0010-workspaces-use-real-git.md).

### 📱 Installable PWA

Offline-capable, generated icon set, safe-area aware, and turns survive being backgrounded — the agent keeps working in the Durable Object while your phone sleeps.

---

## What it costs

Short version: **$5/month, plus tokens.** Everything else fits inside Cloudflare's paid-plan allowances at single-user scale, and it is not close.

### Fixed

| Item | Cost | Why |
|---|---|---|
| **Cloudflare Workers Paid** | **$5 / month** | Required — Dynamic Workers (the shell) are Paid-plan only |
| Custom domain | optional | `*.workers.dev` is free |

### Cloudflare usage — all inside the included allowances

Projected at 600 turns/month, which is ~20 a day:

| Service | Included | Our usage | Cost |
|---|---|---|---|
| Dynamic Workers | 1,000 unique/mo | ~30–90 (one per workspace per day) | **$0** |
| Durable Objects — duration | 400,000 GB-s | ~6,000 GB-s (1.5%) | **$0** |
| Durable Objects — requests | 1M | ~20,000 | **$0** |
| Durable Objects — SQLite | 5 GB | text files | **$0** |
| D1 | 25B reads / 50M writes / 5 GB | **1 row per turn** | **$0** |
| Workers requests / CPU | 10M / 30M CPU-ms | LLM waits are I/O, not CPU | **$0** |
| Static assets | unlimited | ~230 KB bundle | **$0** |
| AI Gateway | free | — | **$0** |
| Cloudflare Access | free ≤ 50 users | 1 | **$0** |

You would need roughly **1,300 turns per day** to exhaust the Durable Object duration allowance.

> **One trap worth knowing.** An open WebSocket bills Durable Object duration for up to 15 minutes *even with no traffic* — one browser tab left open 8 hours a day is ~108,000 GB-s/month, over a quarter of the allowance, for doing nothing. Super uses the **Hibernation API**, so idle sockets stop billing. If you fork this, do not "simplify" `ctx.acceptWebSocket()` into `server.accept()`: it looks identical and only the bill changes.

### Model tokens — measured, not estimated

With MiniMax M2.7 as the default:

| Workload | Tool calls | Cost |
|---|---|---|
| Simple question | 0 | **$0.0002** |
| Typical edit (write + verify) | 2 | **$0.0006** |
| Multi-step task | 4 | **$0.0010** |
| Heavy 21-iteration run | 20 | **$0.0073** |
| Generating a 27 KB HTML architecture diagram | 7 | **$0.0196** |
| Two-member council + chair | — | **$0.0012** |

**Total spend across all development and testing of this project: about $0.15.**

A hard monthly ceiling (`MONTHLY_CAP_USD`, default $20) is enforced in code before every turn, plus per-turn caps on iterations, spend, wall clock and repeated calls.

---

## Quick start

**Prerequisites:** Node 20+, a Cloudflare account on the **Workers Paid** plan, and an API key for at least one model.

```bash
git clone https://github.com/ai-fanatic/super-computer.git
cd super-computer
npm install
```

Create your own D1 database and put its id in `wrangler.jsonc`:

```bash
npx wrangler d1 create super
# copy database_id into wrangler.jsonc, then:
npx wrangler d1 migrations apply super --remote
```

Add your model key (the name must match the profile's `secret_name`):

```bash
npx wrangler secret put MINIMAX_API_KEY
```

Deploy:

```bash
npm run deploy
```

That builds the UI and pushes the Worker. Open the URL it prints.

### Locking it down

Out of the box there is **no authentication**. Two ways to add it, no code change either way:

```bash
# A shared token, exchanged once for an HttpOnly session cookie
npx wrangler secret put HARNESS_BOOTSTRAP_TOKEN
```

Or enable **Cloudflare Access** on the route (free under 50 users) — Super reads the verified email header automatically. This is the better option.

### Optional

```bash
npx wrangler secret put GITHUB_TOKEN   # private-repo skills, and git push
```

---

## Architecture

```
Browser (React PWA)
   │  WebSocket — turn events, not tokens
   ▼
Worker  ──────────────►  D1  (read model: turns, skills, profiles, bindings)
   │
   ├── ConversationDO   the agent loop, one per conversation
   │                    survives client disconnect via chained alarms
   │
   └── WorkspaceDO      @cloudflare/computer workspace
                        SQLite filesystem + just-bash in a Dynamic Worker + git
```

**The Durable Object is the write path; D1 is the read model.** The loop runs inside the DO, so nothing else can own live state; completed turns are flushed to D1 for history and cost rollups. Synchronous dual-write was rejected outright — see [ADR-0006](docs/adr/0006-durable-object-writes-d1-reads.md).

**Events stream, tokens do not.** MiniMax drops the prompt-cache field from `usage` when `stream: true`, so token-streaming would cost exactly the number the whole cost model depends on. Super streams *events* — iteration started, tool called, tool returned — which keeps the UI alive without going blind on spend ([ADR-0009](docs/adr/0009-stream-events-not-tokens.md)).

### The tool surface

Nine tools, and that is a ceiling rather than a starting point — small cheap models degrade as the surface grows:

`read_file` · `write_file` · `edit_file` · `list_dir` · `glob` · `grep` · `bash` · `web_fetch` · `load_skill`

### Design decisions

Every significant decision is written down in [`docs/adr/`](docs/adr/), including the ones that turned out to be **wrong** — [ADR-0003](docs/adr/0003-workspaces-sync-files-not-git.md) argued for file sync over git and is kept, superseded, with the evidence that overturned it. [`CONTEXT.md`](CONTEXT.md) is the glossary.

---

## Contributing

Issues and pull requests are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for how the project is organised, what makes a good PR, and the house rules — the most important of which is: **if you claim something works, say how you tested it.**

Good first issues are labelled [`good first issue`](https://github.com/ai-fanatic/super-computer/labels/good%20first%20issue).

## Acknowledgements

- **[`@cloudflare/computer`](https://github.com/cloudflare/computer)** — the filesystem and execution layer this is built on.
- **[just-bash](https://github.com/vercel-labs/just-bash)** — the shell.
- **[`karpathy/llm-council`](https://github.com/karpathy/llm-council)** — the council pattern.
- **[Agent Skills](https://github.com/anthropics/skills)** — the skill format.

## License

[MIT](LICENSE)
