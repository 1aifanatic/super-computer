# The system prompt is frozen for the life of a Conversation

Once a Conversation starts, its system prompt — instructions plus Skill Manifests in a fixed order — is never modified. No timestamps, no reordering, no per-Turn injection, no appending newly installed Skills to an in-flight Conversation. New Skills become visible in the *next* Conversation.

This exists for cost, not tidiness. MiniMax M2.7 caches context automatically with no configuration, charging $0.06/M for cache reads against $0.30/M for fresh input. An agent loop re-sends its entire prefix on every iteration, so a stable prefix is read at cache rates and a mutated one is not. Any cosmetic change to the prefix — inserting the current time, sorting Skills differently between calls — raises the cost of every subsequent iteration fivefold, invisibly.

## Consequences

This is a rule a future contributor will otherwise "fix" by adding something helpful to the system prompt. The per-Turn UI shows the cached-token count separately precisely so that breaking this becomes visible immediately.

Context pressure is handled without touching the prefix: tool results are truncated aggressively at source with an explicit `…truncated, N more lines` marker, and only past roughly 70% of the 205K window is the *middle* of the conversation compacted into a summary, keeping the frozen prefix and the most recent Turns verbatim. Compaction invalidates the cache from that point forward, which is why it is the last resort rather than the first. Dropping the oldest messages was rejected outright: it discards the original task statement, and the agent then continues confidently without knowing what it was asked to do.
