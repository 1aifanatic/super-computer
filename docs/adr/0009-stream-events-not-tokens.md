# The Harness streams events, not tokens

The UI updates live by receiving Turn *events* over a WebSocket — iteration started, tool called, tool returned, Turn finished — not by streaming the model's text token by token. Model calls themselves are made non-streamed.

This is forced by a measured trade-off, not preference. MiniMax M2.7 reports prompt-cache hits in `usage.prompt_tokens_details.cached_tokens` when called normally, but **drops that field entirely when `stream: true`**. Verified 2026-08-11 with an identical 9,051-token prefix: non-streamed returned `cached_tokens: 8955`; streamed returned `usage` with `prompt_tokens: 9051`, `completion_tokens_details.reasoning_tokens`, and no `prompt_tokens_details` at all. Token streaming therefore costs exactly the number ADR-0007 exists to keep visible.

We chose cost visibility. In an agent loop, perceived latency is dominated by how many steps a Turn takes, not by how fast text appears within one step — a measured model call is ~1.4s while a Turn runs many of them — so event-level granularity keeps the interface alive without going blind on spend.

## Consequences

The final answer appears at once rather than typing itself out, which reads as less responsive than a chat product and is a deliberate cost of knowing what we spend. Tool activity streaming in real time is what carries the sense of progress instead.

If MiniMax later includes `prompt_tokens_details` in streamed responses, this decision should be revisited immediately — it exists solely because of that gap.

Separately observed and worth remembering: M2.7 is a reasoning model that spends `completion_tokens` on thinking before answering. With `max_tokens` set too low it exhausts the budget mid-thought and returns an empty answer with `finish_reason: "length"`. Output budgets must be generous.
