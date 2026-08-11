# Contributing to Super

Thanks for looking. Issues and pull requests are genuinely welcome — this is a small project and it is easy to get a change in.

## The one house rule

**If you claim something works, say how you tested it.**

Super talks to a live model, a real filesystem and a real git remote. A green typecheck proves almost nothing here. Nearly every bug in this repo's history got through because something looked right rather than because it was checked — a stop button that silently did nothing for 40 seconds, an empty `write_file` caused by a truncated JSON argument, a login screen that flashed at authenticated users.

So in your PR, tell us what you actually ran. "Deployed to my Worker and the turn completed in 12s with 3 tool calls" is worth more than any amount of description.

## Getting set up

```bash
npm install
npx wrangler d1 create super          # put the id in wrangler.jsonc
npx wrangler d1 migrations apply super --remote
npx wrangler secret put MINIMAX_API_KEY
npm run deploy
```

You need a Cloudflare account on the **Workers Paid** plan. Dynamic Workers — which run the shell — are not available on the free plan, so there is no way around this.

```bash
npm run typecheck   # Worker + UI
npm run build       # builds the React app into web/
npm run dev         # local Worker
npm run ui:dev      # Vite against a local Worker on :8787
node scripts/test-skill-filter.ts   # the "/" picker's ranking
node scripts/make-icons.mjs         # regenerate the PWA icon set
```

## How the code is laid out

```
src/                Worker
  index.ts          routes, auth, spend guard
  conversation.ts   ConversationDO — the agent loop, caps, WebSocket, alarms
  workspace.ts      WorkspaceDO — @cloudflare/computer workspace + git
  models.ts         Model Profiles and provider adapters
  tools.ts          the nine tools
  skills.ts         skill parsing, GitHub install, approval
  council.ts        parallel members + chair
ui/src/             React app
skills/             Preloaded skills as real SKILL.md files
migrations/         D1
docs/adr/           why things are the way they are
```

## Before you change something surprising

Read [`docs/adr/`](docs/adr/) first. A lot of what looks odd is deliberate and load-bearing:

- **The system prompt is frozen mid-conversation** ([ADR-0007](docs/adr/0007-frozen-prompt-prefix.md)). Adding anything to it — a timestamp, a re-sorted list — costs 5× on every subsequent call by breaking the prompt cache. This is the rule most likely to be "helpfully" broken.
- **We do not stream tokens** ([ADR-0009](docs/adr/0009-stream-events-not-tokens.md)). MiniMax drops the cache field from `usage` when streaming.
- **`ctx.acceptWebSocket()`, never `server.accept()`.** Hibernation is what stops idle tabs billing Durable Object duration.
- **Council members get no write tools, and `bash` is excluded entirely** ([ADR-0004](docs/adr/0004-council-is-advisory-only.md)).
- **The tool surface is capped at nine** ([ADR-0008](docs/adr/0008-bounded-loop-capped-tool-surface.md)). If a cheap model struggles, the fix is fewer tools, not a longer prompt.
- **Model-generated HTML is never served as HTML from our origin.** Downloads go out as `octet-stream`; previews run in a sandboxed iframe without `allow-same-origin`.

If you think an ADR is wrong, say so in an issue. One of them already was — [ADR-0003](docs/adr/0003-workspaces-sync-files-not-git.md) argued against real git and got superseded when someone actually tested it. Being wrong in writing is fine; being wrong silently is not.

## Writing a new Skill

Skills are folders under `skills/` with a `SKILL.md`. The `description` is the entire selection mechanism — it is a *trigger*, not a summary, so say **when** to use the skill, not just what it does. Read [`skills/skill-author/SKILL.md`](skills/skill-author/SKILL.md); it is both the guide and the worked example.

Remember what the shell can and cannot do. A skill whose procedure needs `npm` or a test runner cannot work here.

## Pull requests

- Branch from `main`, keep the change focused.
- Run `npm run typecheck` before pushing.
- Update the ADR or add a new one if you change a decision, not just the code.
- Comments should explain *why*, not restate the code. Match the surrounding style.

## Reporting bugs

Include the model you used, what you asked, and what the turn's footer said — the token counts, cost and stop reason are usually enough to diagnose it. A `cached` count of zero on a long conversation, for example, means the prompt prefix got broken somewhere.

## Security

Do not open a public issue for a vulnerability. Email the maintainer instead. Things worth reporting: anything that lets an installed skill read secrets, escape the sandboxed preview, or reach the API as the operator.

## Code of conduct

Be decent. Assume good faith, critique the code rather than the person, and remember that most contributors are doing this in their spare time.
