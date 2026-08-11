---
name: refactor
description: Make the same change across many files safely. Use when renaming a symbol, changing a call signature, moving a pattern, or applying a consistent edit to a whole codebase.
---

# Systematic multi-file edits

The danger in a refactor is not the edit, it is the edit you did not know you needed to make. Find the full blast radius before changing anything.

## Always, in this order

1. **Enumerate.** `grep -rn "oldName" /workspace` — every occurrence, before touching one.
2. **Count.** `grep -rc "oldName" /workspace` per file, so you know when you are done.
3. **Classify.** Definitions, call sites, imports, strings, comments and tests need different treatment. A blind replace corrupts the ones that are not code.
4. **Edit** with `edit_file`, one occurrence at a time with enough surrounding context to be unique.
5. **Verify.** `grep -rn "oldName" /workspace` again. Zero results, or only the ones you deliberately left.

## Use edit_file, not write_file

Rewriting a file to change one line bills the whole file as output tokens and risks losing anything you did not carry across. `edit_file` fails loudly when `old_string` is not unique, which is a feature: that error is telling you the change is ambiguous and needs more context.

When a change genuinely is uniform across a file, `replace_all` is correct — but check the count first so you know what you are agreeing to.

## Partial-word traps

`grep` matches substrings. Renaming `user` will also hit `username`, `userId` and `superuser`. Anchor the pattern:

```
grep -rnw "user" /workspace
grep -rn "\buser\b" /workspace
```

## The limit you must state

You cannot run the tests, the build, or the type checker. A refactor that looks complete is unverified. When you finish, say so plainly — "renamed 14 occurrences across 6 files; not compiled or tested" — rather than implying the change is known good.
