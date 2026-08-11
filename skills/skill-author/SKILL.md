---
name: skill-author
description: Write a new Skill for this harness, or improve an existing one. Use when the Operator wants to teach the harness a repeatable procedure, capture a workflow, or turn a set of instructions into something reusable.
---

# Writing a Skill

A Skill is a folder containing `SKILL.md`: YAML frontmatter with `name` and `description`, then a markdown body. This file is itself an example — read it as the reference.

## The frontmatter carries the weight

```yaml
---
name: kebab-case-name
description: What this does, and specifically when to use it.
---
```

Only `name` and `description` sit in the model's context at all times. The body loads only when the Skill is chosen. So **the description is the entire selection mechanism** — it is not a summary, it is a trigger.

Write descriptions that say *when*, not just *what*:

- Weak: "Helps with databases."
- Strong: "Query, reshape and validate JSON with jq. Use for API responses, config files, package manifests and log lines."

The weak one never gets picked, because nothing in a real request looks like it.

## The body is instructions, not documentation

Write to the model that will execute it, in the imperative. Give it an order of operations, concrete commands, and the traps. Skip motivation and background — it has already been chosen by the time the body loads.

Good bodies contain:

- A short procedure, numbered, in the order it should happen.
- Real commands that work in this Workspace.
- The failure modes and what to do instead.
- An explicit statement of what the Skill cannot do.

## Know the Workspace's limits

Available: `ls`, `cat`, `grep`, `sed`, `awk`, `find`, `sort`, `wc`, `head`, `tail`, `cut`, `tr`, `diff`, `jq`, pipes, redirects, loops and conditionals — plus real `git` (clone, status, diff, add, commit, log, branch, checkout; HTTPS only, no SSH).

Not available: `node`, `npm`, `python`, `sqlite3`, or any other native binary. A Skill whose procedure depends on running a build or a test suite cannot work here — do not write one, and say so if asked.

## Keep it short

A Skill body is loaded into a live context window and paid for in tokens. Two hundred well-chosen lines beat a thousand thorough ones. If it is growing past that, it is probably two Skills.

## Before finishing

Re-read the description as though you were the model seeing only it and a user request. Would you pick this Skill? If not, rewrite the description, not the body.
