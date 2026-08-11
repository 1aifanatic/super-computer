---
name: json-wrangling
description: Inspect, query, reshape and validate JSON with jq. Use for API responses, config files, package manifests, log lines, and turning JSON into readable tables or CSV.
---

# Working with JSON

`jq` is available in the shell. Use it rather than reading a JSON file and reasoning about it by eye — it is cheaper and it does not make arithmetic mistakes.

## Understand the shape first

Never assume a structure. Ask:

```
jq 'keys' /workspace/data.json
jq 'type' /workspace/data.json
jq '.[0] | keys' /workspace/list.json
jq -r 'paths(scalars) | join(".")' /workspace/data.json | sort -u
```

That last one prints every leaf path in the document and is the fastest way to learn an unfamiliar payload.

## Everyday queries

```
jq '.version' package.json
jq -r '.dependencies | to_entries[] | "\(.key)@\(.value)"' package.json
jq '[.items[] | select(.active)] | length' data.json
jq -r '.records[] | [.id, .name, .total] | @csv' data.json
jq 'map(.amount) | add' orders.json
jq -s 'group_by(.status) | map({status: .[0].status, n: length})' events.json
```

## Validation

`jq` exits non-zero on malformed input, which makes it a validator:

```
jq empty /workspace/config.json && echo valid
```

## Editing JSON

To change a value, prefer `jq` to hand-editing — it cannot produce invalid JSON:

```
jq '.version = "2.0.0"' config.json > /workspace/.tmp.json && mv /workspace/.tmp.json config.json
```

Note `jq` cannot write in place, so route through a temporary file as above.

## Not available

There is no `sqlite3`, no `python`, and no `node` in this Workspace — the packaged builds ship without their compiled runtimes. For anything beyond `jq`, use `awk`, `sed`, `sort`, `cut` and `join`, which are all present. If a task genuinely needs a database or a real script interpreter, say so rather than improvising something fragile.
