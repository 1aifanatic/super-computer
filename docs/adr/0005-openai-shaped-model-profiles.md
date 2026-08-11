# Every model is an OpenAI-shaped Model Profile row, routed through AI Gateway

Adding or swapping an LLM provider means inserting a Model Profile — base URL, secret name, model identifier, price — not writing code. All providers are addressed through the OpenAI-compatible chat-completions shape, which MiniMax, DeepSeek, Groq, Kimi, Together, and OpenRouter all speak natively. Every call is routed through Cloudflare AI Gateway for per-request cost logging, caching, retries, and a hard spend ceiling ($20/month cap, warning at $10). The Default Profile is MiniMax M2.7, called directly rather than through an aggregator to avoid the markup.

Model Profiles store the *name* of a Worker secret, never a credential, so D1 holds nothing worth stealing.

## Consequences

Providers with genuinely native request shapes — Anthropic and Gemini in particular — are reached through their OpenAI-compatible endpoints, which means some native tool-calling and caching behaviour is unavailable until a per-provider shim is written. This was accepted to keep provider swapping a data change.

The spend ceiling lives at the Gateway rather than in application code, so it holds even if the agent loop misbehaves.
