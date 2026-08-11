---
name: code-search
description: Find where something lives in an unfamiliar Workspace. Use when asked where a function, symbol, config value, or piece of behaviour is defined, or when you need to understand a codebase's layout before changing it.
---

# Finding things in a Workspace

Search before you read. Reading whole files to locate one symbol wastes context you will need later for the actual work.

## Order of operations

1. `list_dir /workspace` first. Layout tells you where to look and stops you searching the whole tree.
2. `glob` when you know roughly what the file is called — `*.config.*`, `*test*`, `*.md`.
3. `grep` when you know what the code *says* rather than where it lives.
4. `read_file` last, and with `offset`/`limit` once grep has told you the line number.

## Patterns that pay off

Find a definition rather than every mention:

```
grep -rn "function handlePayment" /workspace
grep -rn "class .*Repository" /workspace
grep -rn "export (const|function|class) name" /workspace
```

Find callers, then narrow:

```
grep -rn "handlePayment(" /workspace
```

Find configuration and constants:

```
grep -rni "timeout|retry|max_|limit" /workspace
```

Get the shape of a file cheaply before reading it:

```
grep -n "^(export |function |class |def |const )" /workspace/src/thing.ts
```

## When a search returns too much

Do not read all of it. Narrow instead: add a directory, add context to the pattern, or count first with `grep -rc pattern /workspace` to see whether the search was even the right one.

## Reporting

Answer with file paths and line numbers, not prose summaries of code the Operator can read. `src/billing.ts:412` is more useful than three sentences describing what happens there.
