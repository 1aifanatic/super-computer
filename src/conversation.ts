import { DurableObject } from "cloudflare:workers";
import { runCouncil } from "./council";
import { callModel, costOf, loadProfiles, resolveProfile } from "./models";
import { loadManifests, loadSkillBody, resolveSkillName } from "./skills";
import { TOOL_SCHEMAS, runTool } from "./tools";
import type { ChatMessage, Env, ModelProfile, TraceEntry, TurnEvent, TurnSummary, Usage } from "./types";

export interface CouncilConfig {
  memberIds: string[];
  chairId: string;
}

/**
 * ADR-0008's four caps. Whichever trips first ends the Turn with a named
 * reason. These sit inside the AI Gateway spend ceiling, which is the backstop
 * for everything.
 */
const CAPS = {
  iterations: 25,
  costUsd: 0.25,
  wallClockMs: 10 * 60 * 1000,
  identicalCalls: 3,
};

/** Watchdog cadence. A Turn that stalls longer than this is resumed. */
const WATCHDOG_MS = 60_000;

/**
 * Frozen for the life of the Conversation (ADR-0007). No timestamps, no
 * reordering, no per-Turn injection. Spike B measured 98.9% of a stable prefix
 * served from cache at a fifth of the input price.
 */
const SYSTEM_PROMPT = [
  "You are a lightweight AI coding harness operating on a persistent Workspace filesystem.",
  "",
  "Work in /workspace. Read before you write. Prefer edit_file over write_file for existing files:",
  "rewriting a whole file to change one line is expensive and loses context.",
  "",
  "Your shell is a simulated bash with real text tools: ls, cat, grep, sed, awk, find, sort, wc, head,",
  "tail, cut, tr, diff, jq, pipes, redirects, loops and conditionals.",
  "",
  "You DO have real git: clone, status, diff, add, commit, log, branch, checkout. Use it to understand",
  "history and to stage your work. It is HTTPS-only and there is no SSH.",
  "",
  "You cannot run node, npm, python, or any other native binary. You cannot install packages, run a build,",
  "or run a test suite. This means you cannot verify your own work by executing it. Say so plainly when it",
  "matters rather than implying code has been tested.",
  "",
  "Work in small steps and stop as soon as the task is done. When finished, reply with a short summary of",
  "what changed. Do not narrate every tool call -- the Operator can see them.",
].join("\n");

/**
 * Builds the frozen prefix: base instructions plus Skill Manifests.
 *
 * Manifests are name + description only -- roughly 30 tokens each, so all of
 * them fit comfortably below the ~50-100 Skill mark, and the body loads on
 * demand via load_skill (ADR-0001). Ordering is alphabetical and fixed by the
 * query, because reordering between calls would invalidate the cache.
 */
async function buildSystemPrompt(env: Env): Promise<string> {
  const manifests = await loadManifests(env);
  if (!manifests.length) return SYSTEM_PROMPT;
  return [
    SYSTEM_PROMPT,
    "",
    "## Available Skills",
    "",
    "Each Skill below is a set of instructions for a kind of task. When one matches what you have been",
    "asked to do, call load_skill with its name before starting, and follow what it says.",
    "",
    ...manifests.map((m) => `- ${m.name}: ${m.description}`),
  ].join("\n");
}

export type { TurnEvent, TurnSummary } from "./types";

interface TurnState {
  turnId: string;
  seq: number;
  status: "running" | "finished";
  workspaceId: string;
  profileId: string | null;
  operatorMessage: string;
  messages: ChatMessage[];
  iteration: number;
  usage: Usage;
  toolCalls: number;
  answer: string;
  stopReason: string;
  startedAt: number;
  lastProgressAt: number;
  recentCalls: string[];
  trace: TraceEntry[];
  council: CouncilConfig | null;
}

/**
 * Stop lives in its own storage key, never inside TurnState.
 *
 * The loop persists the whole TurnState at the end of each iteration. If the
 * stop flag lived in that object, a stop arriving mid-iteration would be
 * written by the socket handler and then immediately overwritten by the loop's
 * stale in-memory copy -- a lost update that silently ignores the Operator.
 * Observed doing exactly that before this was split out. The loop only ever
 * reads this key; only the socket handler writes it.
 */
const STOP_KEY = "stopRequested";

export class ConversationDO extends DurableObject<Env> {
  /** Events for the Turn in flight, replayed to any client that (re)connects. */
  private live: TurnEvent[] = [];

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ws")) {
      const pair = new WebSocketPair();
      // Hibernation API, deliberately. Durable Object duration bills at 128 MB
      // for as long as the object stays in memory, and a plain server.accept()
      // socket holds it there for up to 15 minutes per connection with no
      // traffic at all -- one browser tab left open 8h/day is roughly 108,000
      // GB-s/month, over a quarter of the entire monthly allowance, for doing
      // nothing. acceptWebSocket + a webSocketMessage handler lets the object
      // hibernate while idle. Do not "simplify" this: the behaviour looks
      // identical and only the bill changes.
      this.ctx.acceptWebSocket(pair[1]);

      // Replay only a Turn that is still running: that is the case a refresh
      // must survive. Replaying a *finished* Turn would make a fresh client
      // believe stale work were live -- completed Turns belong to /api/history.
      const state = await this.ctx.storage.get<TurnState>("turn");
      const running = state?.status === "running";
      if (running) {
        const replay = (await this.ctx.storage.get<TurnEvent[]>("events")) ?? [];
        for (const e of replay) pair[1].send(JSON.stringify(e));
      }
      pair[1].send(JSON.stringify({ type: "synced", running } satisfies TurnEvent));

      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    if (msg.type === "stop") {
      await this.ctx.storage.put(STOP_KEY, true);
      return;
    }

    if (msg.type === "turn") {
      const existing = await this.ctx.storage.get<TurnState>("turn");
      if (existing && existing.status === "running") {
        this.broadcast({ type: "error", message: "A Turn is already running in this Conversation." });
        return;
      }
      await this.beginTurn({
        workspaceId: String(msg.workspaceId ?? "default"),
        profileId: msg.profileId ?? null,
        message: String(msg.message ?? ""),
        council: msg.council ?? null,
      });
    }
  }

  /**
   * The watchdog. A Turn keeps running when the client disconnects, so nothing
   * about the runtime naturally notices a stall -- if the object was evicted
   * mid-Turn this picks the loop back up from persisted state.
   */
  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<TurnState>("turn");
    if (!state || state.status !== "running") return;
    if (Date.now() - state.lastProgressAt < WATCHDOG_MS) {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      return;
    }
    await this.pump();
  }

  async beginTurn(input: {
    workspaceId: string;
    profileId: string | null;
    message: string;
    council?: CouncilConfig | null;
  }): Promise<void> {
    const history = (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];
    const seq = ((await this.ctx.storage.get<number>("seq")) ?? 0) + 1;

    // Built once, on the first Turn, then reused byte-for-byte (ADR-0007).
    // A Skill installed mid-Conversation deliberately does not appear until
    // the next one -- mutating the prefix would cost 5x on every later call.
    let systemPrompt = await this.ctx.storage.get<string>("systemPrompt");
    if (!systemPrompt) {
      systemPrompt = await buildSystemPrompt(this.env);
      await this.ctx.storage.put("systemPrompt", systemPrompt);
    }

    // Explicit invocation (Q12): "/refactor rename X to Y" loads that Skill
    // directly. When the Operator already knows which Skill they want, paying
    // a model to guess is waste. Goes into the user message, never the prefix.
    let message = input.message;
    const slash = /^\/([a-z0-9][a-z0-9_-]*)\s*([\s\S]*)$/i.exec(input.message.trim());
    if (slash) {
      const [, requested, rest] = slash;
      const { id, suggestion, available } = await resolveSkillName(this.env, requested);
      const body = id ? await loadSkillBody(this.env, id) : null;

      if (body) {
        message = `The Operator explicitly invoked the "${id}" Skill. Follow it.\n\n<skill name="${id}">\n${body}\n</skill>\n\n${rest.trim()}`;
      } else {
        // Previously this fell through silently, leaving the raw "/name" in
        // the prompt. The model would then hunt for the skill via load_skill,
        // fail identically each time, and lose the Turn to the repetition cap.
        message = [
          `The Operator typed "/${requested}", but no such skill exists.`,
          suggestion ? `The closest available skill is "${suggestion}".` : null,
          `Available skills: ${available.join(", ") || "(none)"}.`,
          `Do not call load_skill with "${requested}" — it does not exist.`,
          suggestion
            ? `Either load "${suggestion}" if it fits the request, or just do the task directly.`
            : `Complete the request directly without a skill.`,
          ``,
          rest.trim(),
        ]
          .filter((l) => l !== null)
          .join("\n");
      }
    }

    const state: TurnState = {
      turnId: crypto.randomUUID(),
      seq,
      status: "running",
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      operatorMessage: input.message,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message },
      ],
      iteration: 0,
      usage: { input_tokens: 0, cached_tokens: 0, output_tokens: 0 },
      toolCalls: 0,
      answer: "",
      stopReason: "complete",
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      recentCalls: [],
      trace: [],
      council: input.council ?? null,
    };

    this.live = [];
    await this.ctx.storage.delete(STOP_KEY);
    await this.ctx.storage.put("turn", state);
    await this.ctx.storage.put("events", []);
    await this.emit({ type: "turn_start", turnId: state.turnId, seq });
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);

    await this.pump();
  }

  /** Runs the loop to completion, persisting after every iteration. */
  private async pump(): Promise<void> {
    for (;;) {
      const state = await this.ctx.storage.get<TurnState>("turn");
      if (!state || state.status !== "running") return;

      const profile = await resolveProfile(this.env, state.profileId);
      const stop = await this.checkCaps(state);
      if (stop) {
        await this.finish(state, profile.id, stop);
        return;
      }

      // A Council is a single bounded pass, not an iterative loop: Members
      // advise in parallel and the Chair synthesises once (ADR-0004).
      if (state.council) {
        await this.runCouncilTurn(state, profile);
        return;
      }

      state.iteration += 1;
      await this.emit({ type: "iteration", n: state.iteration });

      let reply;
      try {
        reply = await callModel(this.env, profile, state.messages, TOOL_SCHEMAS);
      } catch (e: any) {
        await this.emit({ type: "error", message: String(e?.message ?? e).slice(0, 500) });
        await this.finish(state, profile.id, `failed: ${String(e?.message ?? e).slice(0, 200)}`);
        return;
      }

      state.usage.input_tokens += reply.usage.input_tokens;
      state.usage.cached_tokens += reply.usage.cached_tokens;
      state.usage.output_tokens += reply.usage.output_tokens;
      state.lastProgressAt = Date.now();

      if (!reply.tool_calls.length) {
        state.answer = reply.content;
        await this.finish(state, profile.id, "complete");
        return;
      }

      state.messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });

      for (const call of reply.tool_calls) {
        // Checked between tool calls too: a Turn can spend tens of seconds
        // inside one iteration, and waiting for the next one to stop feels
        // like the button did nothing.
        if (await this.ctx.storage.get<boolean>(STOP_KEY)) {
          await this.ctx.storage.put("turn", state);
          await this.finish(state, profile.id, "stopped by the Operator");
          return;
        }

        const fingerprint = `${call.name}:${JSON.stringify(call.arguments)}`;
        const priorIdentical = state.recentCalls.filter((c) => c === fingerprint).length;
        state.recentCalls.push(fingerprint);
        if (state.recentCalls.length > CAPS.identicalCalls * 2) state.recentCalls.shift();

        const input = JSON.stringify(call.arguments).slice(0, 300);
        await this.emit({ type: "tool_start", tool: call.name, input });

        // Repetition used to be fatal on sight. Killing a Turn is a worse
        // outcome than telling the model it is stuck, so the first repeat is
        // intercepted with a correction instead of being executed again --
        // re-running an identical call cannot produce a different answer.
        let output: string;
        if (priorIdentical >= 1) {
          output =
            `You already made this exact call and got the same result. Repeating it will not help.\n` +
            `Change your approach: use different arguments, a different tool, or answer with what you have.`;
        } else {
          output = await runTool(this.env, state.workspaceId, call);
        }
        state.toolCalls += 1;
        state.lastProgressAt = Date.now();

        await this.emit({ type: "tool_end", tool: call.name, output: output.slice(0, 2000) });
        // Kept short: this rides in the response and in DO storage, and a
        // 25-iteration Turn would otherwise carry a lot of dead weight.
        state.trace.push({ tool: call.name, input, output: output.slice(0, 400) });
        state.messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }

      await this.ctx.storage.put("turn", state);
    }
  }

  private async runCouncilTurn(state: TurnState, fallback: ModelProfile): Promise<void> {
    const council = state.council!;
    const all = await loadProfiles(this.env);
    const members = council.memberIds.map((id) => all.find((p) => p.id === id)).filter(Boolean) as ModelProfile[];
    const chair = all.find((p) => p.id === council.chairId) ?? fallback;

    if (!members.length) {
      await this.finish(state, fallback.id, "failed: no valid Council members selected");
      return;
    }

    const systemPrompt = (await this.ctx.storage.get<string>("systemPrompt")) ?? "";
    const history = (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];

    try {
      const outcome = await runCouncil(this.env, {
        frozenPrefix: systemPrompt,
        history,
        question: state.operatorMessage,
        members,
        chair,
        workspaceId: state.workspaceId,
        emit: (e) => this.emit(e),
      });

      state.answer = outcome.answer;
      state.usage = outcome.usage;
      state.trace = outcome.trace;
      state.toolCalls = outcome.trace.length;
      // Council cost is summed per Member and Chair against their own prices,
      // so it is passed through rather than recomputed from one profile.
      await this.finish(state, chair.id, outcome.stopReason, outcome.cost_usd);
    } catch (e: any) {
      await this.emit({ type: "error", message: String(e?.message ?? e).slice(0, 400) });
      await this.finish(state, chair.id, `failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  private async checkCaps(state: TurnState): Promise<string | null> {
    if (await this.ctx.storage.get<boolean>(STOP_KEY)) return "stopped by the Operator";
    if (state.iteration >= CAPS.iterations) return `stopped: hit the ${CAPS.iterations}-iteration cap`;
    if (Date.now() - state.startedAt > CAPS.wallClockMs) return "stopped: hit the 10-minute wall-clock cap";

    // Cheap models fail by repetition far more often than dramatically. The
    // model now gets corrected on the first repeat, so reaching this point
    // means it ignored the correction and is genuinely stuck.
    const counts = new Map<string, number>();
    for (const c of state.recentCalls) counts.set(c, (counts.get(c) ?? 0) + 1);
    for (const [call, n] of counts) {
      if (n >= CAPS.identicalCalls) {
        const tool = call.split(":")[0];
        return `stopped: kept repeating the same ${tool} call and could not make progress`;
      }
    }
    return null;
  }

  private async finish(
    state: TurnState,
    profileId: string,
    stopReason: string,
    /** Council supplies its own total; each Member billed at its own prices. */
    precomputedCost?: number,
  ): Promise<void> {
    const profile = (await loadProfiles(this.env)).find((p) => p.id === profileId) ?? (await resolveProfile(this.env, state.profileId));
    const cost = precomputedCost ?? costOf(profile, state.usage);

    // The cost cap is checked here too: a Turn can only overshoot by one
    // iteration, never silently run up a bill.
    const reason = cost > CAPS.costUsd && stopReason === "complete" ? "stopped: hit the $0.25 per-Turn cap" : stopReason;

    state.status = "finished";
    state.stopReason = reason;
    if (!state.answer) {
      state.answer =
        reason === "complete" ? "(no answer produced)" : `Turn ended before an answer: ${reason}.`;
    }

    const history = (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];
    // Only the conversational spine is carried forward. Replaying every tool
    // result into the next Turn is the fastest way to burn a context window.
    await this.ctx.storage.put("history", [
      ...history,
      { role: "user", content: state.operatorMessage },
      { role: "assistant", content: state.answer },
    ] satisfies ChatMessage[]);
    await this.ctx.storage.put("seq", state.seq);
    await this.ctx.storage.put("turn", state);
    await this.ctx.storage.deleteAlarm();

    const summary: TurnSummary = {
      turnId: state.turnId,
      seq: state.seq,
      operator_message: state.operatorMessage,
      assistant_message: state.answer,
      usage: state.usage,
      cost_usd: cost,
      tool_calls: state.toolCalls,
      duration_ms: Date.now() - state.startedAt,
      stop_reason: reason,
      model_profile_id: profile.id,
      trace: state.trace,
    };

    await this.ctx.storage.put("lastSummary", summary);
    await this.emit({ type: "turn_end", turn: summary });
    await this.flushToD1(summary);
  }

  /** ADR-0006: the Durable Object is the write path, D1 is the read model. */
  private async flushToD1(t: TurnSummary): Promise<void> {
    const conversationId = (await this.ctx.storage.get<string>("conversationId")) ?? this.ctx.id.toString();
    try {
      await this.env.DB.prepare(
        `INSERT INTO turns (id, conversation_id, seq, operator_message, assistant_message,
                            model_profile_id, input_tokens, cached_tokens, output_tokens,
                            cost_usd, tool_calls, duration_ms, stop_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, unixepoch())
         ON CONFLICT (conversation_id, seq) DO NOTHING`,
      )
        .bind(
          t.turnId,
          conversationId,
          t.seq,
          t.operator_message,
          t.assistant_message,
          t.model_profile_id,
          t.usage.input_tokens,
          t.usage.cached_tokens,
          t.usage.output_tokens,
          t.cost_usd,
          t.tool_calls,
          t.duration_ms,
          t.stop_reason,
        )
        .run();
    } catch (e) {
      // A dropped flush loses a Turn from history and from the spend total, so
      // it is worth a log even though it must not fail the Turn.
      console.error("D1 flush failed", e);
    }
  }

  private async emit(event: TurnEvent): Promise<void> {
    this.live.push(event);
    const stored = (await this.ctx.storage.get<TurnEvent[]>("events")) ?? [];
    stored.push(event);
    await this.ctx.storage.put("events", stored);
    this.broadcast(event);
  }

  private broadcast(event: TurnEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // A dead socket is not this Turn's problem.
      }
    }
  }

  // ---- called over RPC from the Worker ----

  async setConversationId(id: string): Promise<void> {
    await this.ctx.storage.put("conversationId", id);
  }

  /**
   * Synchronous entry point. `beginTurn` already drives the loop to completion,
   * so this just surfaces the result -- it exists so the Harness stays testable
   * with curl and does not depend on a browser to be exercised.
   */
  async runTurn(input: {
    workspaceId: string;
    profileId: string | null;
    message: string;
    council?: CouncilConfig | null;
  }): Promise<TurnSummary> {
    await this.beginTurn(input);
    const summary = await this.ctx.storage.get<TurnSummary>("lastSummary");
    if (!summary) throw new Error("Turn produced no summary.");
    return summary;
  }

  async getHistory(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];
  }

  async getTurnStatus(): Promise<{ status: string; events: TurnEvent[] }> {
    const state = await this.ctx.storage.get<TurnState>("turn");
    return {
      status: state?.status ?? "idle",
      events: (await this.ctx.storage.get<TurnEvent[]>("events")) ?? [],
    };
  }

  async requestStop(): Promise<void> {
    await this.ctx.storage.put(STOP_KEY, true);
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.live = [];
  }
}
