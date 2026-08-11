import type { ChatMessage, Env, ModelProfile, ModelReply, ToolCall } from "./types";

/**
 * Model Profiles (ADR-0005). Adding a provider is a row, not a code change --
 * but "OpenAI-shaped" needs one genuine second implementation to be more than
 * an assertion, so Workers AI is here too and speaks a different dialect.
 */

export async function loadProfiles(env: Env): Promise<ModelProfile[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM model_profiles WHERE enabled = 1 ORDER BY is_default DESC, label`,
  ).all<ModelProfile>();
  return results ?? [];
}

export async function resolveProfile(env: Env, id?: string | null): Promise<ModelProfile> {
  const profiles = await loadProfiles(env);
  if (profiles.length === 0) throw new Error("No enabled Model Profiles.");
  return profiles.find((p) => p.id === id) ?? profiles.find((p) => p.is_default === 1) ?? profiles[0];
}

/** Cost in USD. Cached tokens bill at their own, much lower rate. */
export function costOf(profile: ModelProfile, u: { input_tokens: number; cached_tokens: number; output_tokens: number }): number {
  const fresh = Math.max(0, u.input_tokens - u.cached_tokens);
  return (
    (fresh * profile.price_in_per_mtok) / 1e6 +
    (u.cached_tokens * profile.price_cached_per_mtok) / 1e6 +
    (u.output_tokens * profile.price_out_per_mtok) / 1e6
  );
}

/**
 * MiniMax M2.7 is a reasoning model and wraps its scratchpad in <think> tags.
 * That is working memory, not an answer, and showing it to the Operator as
 * though it were the reply is worse than dropping it.
 */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/g, "").trim();
}

const MAX_OUTPUT_TOKENS = 16384;

/**
 * Marker left on a tool call whose `arguments` were not valid JSON.
 *
 * Previously a parse failure quietly became `{}`, so a truncated call arrived
 * looking like a deliberate empty one and the model was told "path must be
 * absolute" -- advice it could not act on, so it repeated the call verbatim
 * until the Turn died. Naming the real failure lets it recover.
 */
export const ARG_PARSE_ERROR = "__argumentsUnparseable";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export async function callModel(
  env: Env,
  profile: ModelProfile,
  messages: ChatMessage[],
  tools: ToolSchema[],
): Promise<ModelReply> {
  return profile.provider_kind === "workers_ai"
    ? callWorkersAI(env, profile, messages, tools)
    : callOpenAICompatible(env, profile, messages, tools);
}

async function callOpenAICompatible(
  env: Env,
  profile: ModelProfile,
  messages: ChatMessage[],
  tools: ToolSchema[],
): Promise<ModelReply> {
  if (!profile.secret_name) throw new Error(`Profile ${profile.id} has no secret_name.`);
  const key = env[profile.secret_name] as string | undefined;
  if (!key) throw new Error(`Secret ${profile.secret_name} is not set. Run: wrangler secret put ${profile.secret_name}`);

  const res = await fetch(`${profile.base_url}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: profile.model_id,
      messages: messages.map(toWireMessage),
      // Generous on purpose. MiniMax M2.7 is a reasoning model and spends
      // completion tokens thinking before it answers, so a small budget gets
      // exhausted mid-thought -- or worse, mid-tool-call, truncating the
      // arguments JSON so the call arrives empty. Observed doing exactly that
      // when writing a large file at 4096. Only tokens actually produced bill.
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
        : {}),
    }),
  });

  if (!res.ok) throw new Error(`${profile.label} returned ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json: any = await res.json();
  const choice = json.choices?.[0]?.message ?? {};
  const u = json.usage ?? {};

  return {
    content: stripReasoning(String(choice.content ?? "")),
    tool_calls: (choice.tool_calls ?? []).map(
      (tc: any): ToolCall => ({
        id: String(tc.id ?? crypto.randomUUID()),
        name: tc.function?.name ?? "",
        arguments: safeParse(tc.function?.arguments),
      }),
    ),
    usage: {
      input_tokens: Number(u.prompt_tokens ?? 0),
      // Verified live on MiniMax M2.7: the standard OpenAI field is populated,
      // which is what makes ADR-0007's frozen prefix measurable rather than
      // merely believed.
      cached_tokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: Number(u.completion_tokens ?? 0),
    },
  };
}

async function callWorkersAI(
  env: Env,
  profile: ModelProfile,
  messages: ChatMessage[],
  tools: ToolSchema[],
): Promise<ModelReply> {
  const out: any = await env.AI.run(profile.model_id, {
    messages: messages.map(toWireMessage),
    ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })) } : {}),
  });

  // Workers AI answers in two different shapes depending on the model, so
  // normalise both back to the OpenAI shape the rest of the loop expects.
  const choice = out?.choices?.[0]?.message;
  const rawCalls = choice?.tool_calls ?? out?.tool_calls ?? [];
  const u = out?.usage ?? {};

  return {
    content: stripReasoning(String(choice?.content ?? out?.response ?? "")),
    tool_calls: rawCalls.map(
      (tc: any): ToolCall => ({
        id: String(tc.id ?? crypto.randomUUID()),
        name: tc.function?.name ?? tc.name ?? "",
        arguments: safeParse(tc.function?.arguments ?? tc.arguments),
      }),
    ),
    usage: {
      input_tokens: Number(u.prompt_tokens ?? 0),
      cached_tokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: Number(u.completion_tokens ?? 0),
    },
  };
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  if (m.tool_calls?.length) {
    return {
      role: m.role,
      content: m.content || null,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function safeParse(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  const raw = String(v ?? "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Do not pretend this was an empty call. Carry the failure forward so the
    // tool layer can tell the model what actually went wrong.
    return { [ARG_PARSE_ERROR]: raw.length };
  }
}
