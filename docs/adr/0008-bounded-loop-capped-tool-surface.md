# The tool surface is capped at eight and every Turn is bounded

The model gets exactly eight tools — `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash`, `load_skill`, `web_fetch` — and eight is a ceiling, not a starting point. Every Turn is bounded by four caps, whichever trips first, each ending the Turn with a named reason: 25 tool iterations, $0.25 spend, 10 minutes wall clock, and 3 consecutive identical tool calls.

Both constraints exist because the Harness is built around a deliberately cheap Default Profile. Small models degrade as the tool surface grows — they call the wrong tool and then loop — so if MiniMax M2.7 struggles the correct response is fewer tools, not a longer prompt. And because a Turn survives client disconnection by design (chained Durable Object alarms), nothing about the runtime naturally bounds a runaway; wall clock is unlimited while the loop keeps itself alive.

`edit_file` performs exact string replacement rather than whole-file rewrite. Rewriting a file to change one line bills the whole file as output tokens on every edit, which is the wrong trade at this price point.

## Consequences

The Stop control is load-bearing rather than a convenience: with alarm-driven continuation, closing the tab does not halt a Turn, so an explicit flag checked between steps is the only way to stop one.

The consecutive-identical-call cap is the most valuable of the four. Cheap models fail by repetition far more often than dramatically, and this catches it in seconds instead of at the spend ceiling.

These caps sit inside the $20/month AI Gateway ceiling, which remains the backstop for everything.
