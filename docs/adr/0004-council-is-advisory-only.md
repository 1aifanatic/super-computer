# Council members advise; they never act

A Council runs N Model Profiles in parallel on the same prompt, each with read-only tools, and a cheap Chair Profile synthesises their independent answers into one. Council members cannot write a file or execute a command — all mutation stays with the single ordinary agent. N agents writing to one Workspace filesystem is a write-conflict problem with no good resolution, and granting it would buy little over one competent writer acting on synthesised advice.

We rejected debate (members revise over rounds) because it multiplies cost by round count for benefit that is hard to demonstrate, and judge-picks-one because it discards most of what was paid for.

## Consequences

Council is opt-in per Turn and never the default, because it directly contradicts the Harness's cheap-by-default cost goal. Estimated cost is shown before the Turn runs, not after.

`bash` is excluded from the Member tool surface outright rather than filtered, because a shell that can redirect (`echo x > f`) is a write tool wearing a read tool's name. Members hold `read_file`, `list_dir`, `glob`, `grep`, `web_fetch` and `load_skill`. The restriction is enforced twice — once by the schema they are given, once inside the tool dispatcher — so a model that hallucinates a write tool still cannot reach one.

## Verified, 2026-08-11

A Council of MiniMax M2.7 and Workers AI gpt-oss-120b was explicitly instructed to create a file. Both Members reported having no such capability, the Chair reported the request could not be fulfilled, no forbidden tool appeared in the trace, and a subsequent ordinary Turn confirmed the file did not exist. The guarantee holds in practice, not just on paper.

One Member failing does not fail the Council: results are gathered with `Promise.allSettled`, the failure is surfaced as an event, and the Chair synthesises whatever came back. That is the point of asking several.

**Known inaccuracy in cost reporting.** The estimate ran ~2.7x high on a real Turn ($0.0032 estimated, $0.0012 actual), which is the safe direction to be wrong. But the Workers AI profile carries zero prices because its billing is in neurons rather than tokens and no reliable conversion exists, so any Council including it under-reports true cost. Fix that before Workers AI is used for anything routine.
