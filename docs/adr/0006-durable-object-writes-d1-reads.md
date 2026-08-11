# The Durable Object is the write path; D1 is the read model

The Harness has two SQLite stores — each Conversation's Durable Object has its own, and D1 sits alongside it. The Durable Object is authoritative for a live Conversation, because the agent loop runs inside it and nothing else can own state that is being mutated mid-loop without a network hop on every step. When a Turn completes, the Durable Object flushes it to D1 as an append-only record. D1 then serves everything cross-cutting — Conversation lists, history search, cost rollups — plus the Operator-global tables (Skills, Model Profiles, the Workspace registry) that never belonged inside a single object.

We explicitly rejected synchronous dual-write. Two writers plus one partition leaves both stores untrustworthy with no way to tell which is correct.

## Consequences

D1 lags the Durable Object by up to one Turn. Any read path that must be current — anything inside the agent loop — reads from the Durable Object, never from D1. A failed flush must be retried rather than dropped, or D1 silently loses a Turn.
