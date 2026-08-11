import type { WorkspaceDO } from "./workspace";
import type { ConversationDO } from "./conversation";

export interface Env {
  DB: D1Database;
  AI: { run(model: string, input: unknown): Promise<any> };
  ASSETS: { fetch(request: Request): Promise<Response> };
  LOADER: unknown;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CONVERSATION: DurableObjectNamespace<ConversationDO>;

  /** Set with `wrangler secret put`. Alternative credential to Cloudflare Access. */
  HARNESS_BOOTSTRAP_TOKEN?: string;
  /** Named by a Model Profile's `secret_name` column, never read directly. */
  MINIMAX_API_KEY?: string;
  /** Optional. Raises the GitHub rate limit and allows private-repo Skills. */
  GITHUB_TOKEN?: string;
  [key: string]: unknown;
}

export interface ModelProfile {
  id: string;
  label: string;
  provider_kind: "openai_compatible" | "workers_ai";
  base_url: string | null;
  secret_name: string | null;
  model_id: string;
  price_in_per_mtok: number;
  price_out_per_mtok: number;
  price_cached_per_mtok: number;
  is_default: number;
  enabled: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Usage {
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
}

export interface ModelReply {
  content: string;
  tool_calls: ToolCall[];
  usage: Usage;
}

export interface TraceEntry {
  tool: string;
  input: string;
  output: string;
}

export interface TurnSummary {
  turnId: string;
  seq: number;
  operator_message: string;
  assistant_message: string;
  usage: Usage;
  cost_usd: number;
  tool_calls: number;
  duration_ms: number;
  stop_reason: string;
  model_profile_id: string;
  trace: TraceEntry[];
}

export type TurnEvent =
  | { type: "turn_start"; turnId: string; seq: number }
  | { type: "iteration"; n: number }
  | { type: "tool_start"; tool: string; input: string }
  | { type: "tool_end"; tool: string; output: string }
  | { type: "turn_end"; turn: TurnSummary }
  | { type: "error"; message: string }
  /** Sent once per connection, after any replay, so the client knows the
   *  backlog has been delivered and everything after this point is live. */
  | { type: "synced"; running: boolean }
  // ---- Council (ADR-0004) ----
  | { type: "council_start"; members: string[]; chair: string }
  | { type: "member_done"; member: string; answer: string; cost_usd: number }
  | { type: "chair_start" };
