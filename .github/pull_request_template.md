# What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem, or a link to the issue. -->

## How you tested it

<!--
The house rule: if you claim it works, say how you know.

A typecheck is not a test here — this talks to a live model, a real filesystem
and a real git remote. Tell us what you actually ran and what came back.

Good: "Deployed to my Worker; the turn completed in 12s with 3 tool calls and
the file was written. Also confirmed it still stops correctly on an unknown skill."
-->

- [ ] `npm run typecheck` passes
- [ ] Deployed and exercised against a real Worker
- [ ] Checked the turn footer looks sane (cached tokens are not zero on a long conversation)

## Decisions

- [ ] This does not contradict anything in `docs/adr/`
- [ ] …or it does, and I have added/updated an ADR explaining why

<!--
Things that look wrong but are deliberate — check before "fixing" them:
  · the system prompt is frozen mid-conversation (prompt cache, 5x cost)
  · we do not stream tokens (streaming drops the cache field from usage)
  · ctx.acceptWebSocket(), never server.accept() (idle-tab billing)
  · council members get no write tools, and no bash at all
  · model-generated HTML is never served as HTML from our origin
-->
