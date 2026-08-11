# Skills use the open Agent Skills format, not a bespoke one

A Skill is a folder containing `SKILL.md` — YAML frontmatter with `name` and `description`, plus body instructions and optional bundled scripts. We adopt this existing open format rather than inventing a JSON prompt-template schema, because it makes "paste a GitHub link and install it" genuinely work against the large body of Skills already published in that shape, and because its progressive-disclosure design (only the Skill Manifest sits in the system prompt; the body loads on selection) keeps per-turn token cost near the floor we need for a cheap default model.

## Consequences

We inherit the format's constraints, including its assumption that bundled scripts can be executed. Our execution backend may not be able to honour that half of the contract, so a Skill can be installed and still be only partially usable. The Harness must detect this and say so rather than failing opaquely.

## Measured, 2026-08-11

The format works as advertised: `https://github.com/anthropics/skills` resolved to 18 installable Skills, and installing one by URL parsed its frontmatter and 19KB body without special-casing. That is the payoff for not inventing a schema.

Auto-selection is good but **not reliable**: across four prompts each written to match one Manifest strongly, the model loaded the right Skill 3 times out of 4, and when it did, `load_skill` was always its *first* tool call. The miss was `doc-writer` — asked to write a README, the model went straight to exploring the directory instead. Selection quality is a property of how well each `description` states *when* to use the Skill, and Skills installed from GitHub have descriptions written by strangers for someone else's harness. This is precisely why explicit `/skill-name` invocation exists alongside auto-selection rather than instead of it: when the Operator already knows, no guessing is involved.

