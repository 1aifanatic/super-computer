import { callModel, costOf } from "./models";
import { READ_ONLY_TOOL_SCHEMAS, runTool } from "./tools";
import type { ChatMessage, Env, ModelProfile, TraceEntry, TurnEvent, Usage } from "./types";

/**
 * A Council (ADR-0004): several Model Profiles answer the same question
 * independently and in parallel, and a cheap Chair synthesises one reply.
 *
 * Members hold read-only tools and cannot write a byte. They produce opinions;
 * the ordinary single agent does all execution. Debate was rejected because it
 * multiplies cost by round count for benefit that is hard to demonstrate, and
 * judge-picks-one because it throws away most of what was paid for.
 */

/** Members are bounded harder than the main loop: they research, not build. */
const MEMBER_MAX_ITERATIONS = 6;

export interface CouncilOutcome {
  answer: string;
  usage: Usage;
  cost_usd: number;
  trace: TraceEntry[];
  stopReason: string;
}

interface MemberResult {
  profile: ModelProfile;
  answer: string;
  usage: Usage;
  cost_usd: number;
  trace: TraceEntry[];
}

const MEMBER_PREAMBLE = [
  "You are one member of a council of independent advisors. Several models are answering this same",
  "question separately, and a chair will merge the answers.",
  "",
  "You have read-only tools. You cannot write, edit, or run shell commands, and you must not claim to have",
  "changed anything. Investigate if it helps, then give your own answer.",
  "",
  "Be direct and specific. State your reasoning briefly and flag anything you are unsure about -- a",
  "disagreement you surface is more useful to the chair than false confidence.",
].join("\n");

const CHAIR_PREAMBLE = [
  "You are the chair of a council. Several models answered the same question independently and their",
  "answers are below.",
  "",
  "Produce one answer for the Operator. Where the members agree, state it once, plainly. Where they",
  "disagree, say so explicitly and give your judgement on which is right and why -- do not average them",
  "into mush, and do not simply concatenate them.",
  "",
  "Do not mention that you are a chair or describe the process. Just give the answer.",
].join("\n");

export async function runCouncil(
  env: Env,
  opts: {
    frozenPrefix: string;
    history: ChatMessage[];
    question: string;
    members: ModelProfile[];
    chair: ModelProfile;
    workspaceId: string;
    emit: (event: TurnEvent) => Promise<void>;
  },
): Promise<CouncilOutcome> {
  const { frozenPrefix, history, question, members, chair, workspaceId, emit } = opts;

  await emit({ type: "council_start", members: members.map((m) => m.id), chair: chair.id });

  // Members run concurrently. Each is independent by design -- a Member that
  // sees another's answer is a debate, which this deliberately is not.
  const settled = await Promise.allSettled(
    members.map((profile) => runMember(env, { profile, frozenPrefix, history, question, workspaceId, emit })),
  );

  const succeeded: MemberResult[] = [];
  const usage: Usage = { input_tokens: 0, cached_tokens: 0, output_tokens: 0 };
  const trace: TraceEntry[] = [];
  let cost = 0;

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      succeeded.push(outcome.value);
      usage.input_tokens += outcome.value.usage.input_tokens;
      usage.cached_tokens += outcome.value.usage.cached_tokens;
      usage.output_tokens += outcome.value.usage.output_tokens;
      cost += outcome.value.cost_usd;
      trace.push(...outcome.value.trace);
    } else {
      // One Member failing is not the Council failing. Note it and carry on
      // with the rest -- that is the entire point of asking several.
      await emit({
        type: "error",
        message: `Council member ${members[i].label} failed: ${String(outcome.reason?.message ?? outcome.reason).slice(0, 200)}`,
      });
    }
  }

  if (!succeeded.length) {
    return { answer: "Every Council member failed. Nothing to synthesise.", usage, cost_usd: cost, trace, stopReason: "failed: all council members errored" };
  }

  await emit({ type: "chair_start" });

  const transcript = succeeded
    .map((r, i) => `### Member ${i + 1} (${r.profile.label})\n\n${r.answer}`)
    .join("\n\n");

  const chairReply = await callModel(
    env,
    chair,
    [
      { role: "system", content: CHAIR_PREAMBLE },
      { role: "user", content: `## Question\n\n${question}\n\n## Member answers\n\n${transcript}` },
    ],
    [],
  );

  usage.input_tokens += chairReply.usage.input_tokens;
  usage.cached_tokens += chairReply.usage.cached_tokens;
  usage.output_tokens += chairReply.usage.output_tokens;
  cost += costOf(chair, chairReply.usage);

  return {
    answer: chairReply.content || succeeded[0].answer,
    usage,
    cost_usd: cost,
    trace,
    stopReason: succeeded.length === members.length ? "complete" : `complete (${members.length - succeeded.length} member(s) failed)`,
  };
}

async function runMember(
  env: Env,
  opts: {
    profile: ModelProfile;
    frozenPrefix: string;
    history: ChatMessage[];
    question: string;
    workspaceId: string;
    emit: (event: TurnEvent) => Promise<void>;
  },
): Promise<MemberResult> {
  const { profile, frozenPrefix, history, question, workspaceId, emit } = opts;

  // The frozen prefix stays first and byte-identical so it still hits cache;
  // the Council instructions ride in the user message instead of mutating it.
  const messages: ChatMessage[] = [
    { role: "system", content: frozenPrefix },
    ...history,
    { role: "user", content: `${MEMBER_PREAMBLE}\n\n---\n\n${question}` },
  ];

  const usage: Usage = { input_tokens: 0, cached_tokens: 0, output_tokens: 0 };
  const trace: TraceEntry[] = [];
  let answer = "";

  for (let i = 0; i < MEMBER_MAX_ITERATIONS; i++) {
    const reply = await callModel(env, profile, messages, READ_ONLY_TOOL_SCHEMAS);
    usage.input_tokens += reply.usage.input_tokens;
    usage.cached_tokens += reply.usage.cached_tokens;
    usage.output_tokens += reply.usage.output_tokens;

    if (!reply.tool_calls.length) {
      answer = reply.content;
      break;
    }

    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      const output = await runTool(env, workspaceId, call, true);
      trace.push({ tool: `${profile.id}:${call.name}`, input: JSON.stringify(call.arguments).slice(0, 200), output: output.slice(0, 300) });
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }

    if (i === MEMBER_MAX_ITERATIONS - 1) {
      answer = reply.content || "(reached the member iteration cap without concluding)";
    }
  }

  const cost_usd = costOf(profile, usage);
  await emit({ type: "member_done", member: profile.id, answer: answer.slice(0, 4000), cost_usd });
  return { profile, answer, usage, cost_usd, trace };
}

/**
 * Pre-flight cost estimate. Council must never be a surprise on the bill
 * (ADR-0004), so the Operator sees a number before committing, not after.
 *
 * Approximate by construction: token counts come from a chars/4 heuristic and
 * output length is assumed. Labelled as an estimate everywhere it is shown.
 */
export function estimateCouncilCost(opts: {
  prefixChars: number;
  historyChars: number;
  questionChars: number;
  members: ModelProfile[];
  chair: ModelProfile;
}): { total_usd: number; per_member: { id: string; label: string; usd: number }[]; chair_usd: number } {
  const tok = (chars: number) => Math.ceil(chars / 4);
  const ASSUMED_MEMBER_OUTPUT = 700;
  const ASSUMED_CHAIR_OUTPUT = 600;
  // Members usually take a couple of research passes, and each pass re-sends
  // the context, so a single-pass estimate would read far too low.
  const ASSUMED_PASSES = 2;

  const inputTokens = tok(opts.prefixChars + opts.historyChars + opts.questionChars);

  const per_member = opts.members.map((m) => {
    const input = (inputTokens * m.price_in_per_mtok) / 1e6;
    const output = (ASSUMED_MEMBER_OUTPUT * m.price_out_per_mtok) / 1e6;
    return { id: m.id, label: m.label, usd: (input + output) * ASSUMED_PASSES };
  });

  const chairInput = tok(opts.questionChars + ASSUMED_MEMBER_OUTPUT * 4 * opts.members.length);
  const chair_usd =
    (chairInput * opts.chair.price_in_per_mtok) / 1e6 + (ASSUMED_CHAIR_OUTPUT * opts.chair.price_out_per_mtok) / 1e6;

  return { total_usd: per_member.reduce((a, b) => a + b.usd, 0) + chair_usd, per_member, chair_usd };
}
