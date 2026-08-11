---
name: doc-writer
description: Write or revise README files, API documentation, changelogs, architecture notes and code comments. Use when asked to document existing code or improve writing that already exists.
---

# Writing documentation

Read the code first. Documentation invented from the request rather than the source is confidently wrong, and confidently wrong docs are worse than none.

## Before writing

1. `list_dir` and `glob` to find what already exists — never duplicate a README that is there.
2. `read_file` the entry points and public interfaces. Document what the code *does*, not what the name suggests.
3. `grep` for existing terminology and match it. Introducing a synonym for a concept the codebase already names is how glossaries rot.

## What earns its place

- **What it is and why it exists**, in the first two sentences.
- **How to actually run it**, with real commands copied from config, not invented.
- **The non-obvious.** Anything a competent reader would get wrong by guessing.
- **Limits and gotchas.** What it deliberately does not do.

## What does not

- Restating a function signature in prose.
- "This elegant, powerful, robust solution." Adjectives about quality are the author's opinion, not documentation.
- Sections with nothing in them, kept for symmetry.
- Copying the code into a fenced block and calling it an example.

## Style

Plain declarative sentences. Present tense. Second person for instructions. Prefer a short concrete example over a long abstract description. If a table is clearer than a paragraph, use a table.

State uncertainty rather than papering over it: "the retry count is not configurable as far as I can tell" is more useful than silence, and far more useful than a guess presented as fact.

## Verification

You cannot run the commands you document. When you write install or build instructions, take them from the actual config files — `package.json` scripts, the Makefile, the CI workflow — and say which file you took them from, so the Operator can check.
