import { useCallback, useEffect, useRef, useState } from "react";
import SkillsPanel from "./Skills";
import ModelsPanel from "./Models";
import WorkspacePanel from "./Workspace";
import Markdown from "./Markdown";
import Working from "./Working";
import SlashMenu, { filterSkills, type SkillManifest } from "./SlashMenu";
import Artifacts, { artifactsFromTrace } from "./Artifacts";

type TurnEvent =
  | { type: "turn_start"; turnId: string; seq: number }
  | { type: "iteration"; n: number }
  | { type: "tool_start"; tool: string; input: string; path?: string }
  | { type: "tool_end"; tool: string; output: string; path?: string }
  | { type: "turn_end"; turn: TurnSummary }
  | { type: "error"; message: string }
  | { type: "synced"; running: boolean }
  | { type: "council_start"; members: string[]; chair: string }
  | { type: "member_done"; member: string; answer: string; cost_usd: number }
  | { type: "chair_start" };

interface TurnSummary {
  turnId: string;
  seq: number;
  assistant_message: string;
  usage: { input_tokens: number; cached_tokens: number; output_tokens: number };
  cost_usd: number;
  tool_calls: number;
  duration_ms: number;
  stop_reason: string;
  model_profile_id: string;
}

interface Profile {
  id: string;
  label: string;
  is_default: boolean;
}

interface ToolRun {
  tool: string;
  input: string;
  output?: string;
  /** Set by the server for writes. Never derived from the truncated `input`. */
  path?: string;
}

interface Entry {
  role: "user" | "assistant";
  text: string;
  tools?: ToolRun[];
  summary?: TurnSummary;
  error?: string;
  council?: { members: string[]; chair: string };
  memberAnswers?: { member: string; answer: string; cost_usd: number }[];
  chairWorking?: boolean;
}

const uuid = () => crypto.randomUUID();

export default function App() {
  // The credential lives in an HttpOnly cookie the server sets, so this is
  // only "has the server accepted us", never the token itself.
  // `null` means "not checked yet" and must not render the gate -- flashing a
  // login screen at an already-authenticated Operator is the bug this replaced.
  const [authed, setAuthed] = useState<boolean | null>(null);
  // Persisted so a refresh rejoins the same Conversation rather than silently
  // abandoning a Turn that is still running in the Durable Object.
  const [conversationId, setConversationId] = useState(() => {
    const saved = localStorage.getItem("harnessConversationId");
    if (saved) return saved;
    const fresh = uuid();
    localStorage.setItem("harnessConversationId", fresh);
    return fresh;
  });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [spend, setSpend] = useState<{ cost_usd: number; cap_usd: number; turns: number } | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState(Date.now());
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<null | "skills" | "models" | "workspace">(null);
  const [councilOn, setCouncilOn] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [chairId, setChairId] = useState("");
  const [estimate, setEstimate] = useState<{ total_usd: number } | null>(null);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [slashActive, setSlashActive] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Lets onclose reach the latest connect() without making connect depend on
  // itself, which would recreate the socket on every render.
  const connectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, running]);

  const refreshState = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch("/api/state");
    } catch {
      // A network blip is not a logout. Leave the session alone.
      return;
    }

    if (res.status === 401) {
      // One 401 is not proof the session is gone -- it used to be, and a single
      // transient failure would wipe the credential permanently. Confirm with a
      // second attempt before sending the Operator back to the gate.
      await new Promise((r) => setTimeout(r, 800));
      const retry = await fetch("/api/state").catch(() => null);
      if (!retry || retry.status === 401) setAuthed(false);
      else if (retry.ok) {
        const s = await retry.json();
        setAuthed(true);
        setProfiles(s.profiles);
        setSpend(s.month_to_date);
      }
      return;
    }
    if (!res.ok) return;

    const s = await res.json();
    setAuthed(true);
    setProfiles(s.profiles);
    // Fallback so the "/" picker never silently has nothing to show: an older
    // cached bundle, or a state payload predating the skills field, would
    // otherwise leave it empty with no explanation.
    if (Array.isArray(s.skills) && s.skills.length) {
      setSkills(s.skills);
    } else {
      fetch("/api/skills")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.skills) {
            setSkills(
              d.skills
                .filter((x: { status: string }) => x.status === "approved")
                .map((x: { name: string; description: string }) => ({ name: x.name, description: x.description })),
            );
          }
        })
        .catch(() => {});
    }
    setProfileId((p) => p || s.profiles.find((x: Profile) => x.is_default)?.id || s.profiles[0]?.id || "");
    setSpend(s.month_to_date);
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  // Completed Turns come from history; only a Turn still in flight is replayed
  // over the socket. Together they reconstruct the screen after a refresh or a
  // suspend. Only replaces the transcript when the server has more than we do,
  // so it never wipes the live Turn being streamed in front of the Operator.
  const loadHistory = useCallback(async () => {
    const res = await fetch(`/api/history?conversationId=${conversationId}`).catch(() => null);
    if (!res?.ok) return;
    const { messages } = (await res.json()) as { messages: { role: string; content: string }[] };
    const rebuilt = (messages ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", text: m.content }));
    if (!rebuilt.length) return;
    setEntries((prev) => (rebuilt.length >= prev.filter((e) => e.text).length ? rebuilt : prev));
  }, [conversationId]);

  useEffect(() => {
    if (!authed) return;
    loadHistory();
  }, [authed, loadHistory]);

  const apply = useCallback(
    (ev: TurnEvent) => {
      setEntries((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        switch (ev.type) {
          case "turn_start":
            if (!last || last.role !== "assistant" || last.summary) next.push({ role: "assistant", text: "", tools: [] });
            return next;
          case "tool_start":
            if (last?.role === "assistant")
              last.tools = [...(last.tools ?? []), { tool: ev.tool, input: ev.input, path: ev.path }];
            return next;
          case "tool_end":
            if (last?.role === "assistant" && last.tools?.length) {
              const t = last.tools[last.tools.length - 1];
              if (!t.output) t.output = ev.output;
              // tool_end carries the path only when the write actually
              // succeeded, so it supersedes whatever tool_start guessed.
              t.path = ev.path;
            }
            return next;
          case "council_start":
            if (last?.role === "assistant") {
              last.council = { members: ev.members, chair: ev.chair };
              last.memberAnswers = [];
            }
            return next;
          case "member_done":
            if (last?.role === "assistant")
              last.memberAnswers = [...(last.memberAnswers ?? []), { member: ev.member, answer: ev.answer, cost_usd: ev.cost_usd }];
            return next;
          case "chair_start":
            if (last?.role === "assistant") last.chairWorking = true;
            return next;
          case "turn_end":
            if (last?.role === "assistant") {
              last.text = ev.turn.assistant_message;
              last.summary = ev.turn;
              last.chairWorking = false;
            }
            return next;
          case "error":
            if (last?.role === "assistant") last.error = ev.message;
            return next;
          default:
            return next;
        }
      });
      if (ev.type === "synced") setRunning(ev.running);
      if (ev.type === "turn_end") {
        setRunning(false);
        refreshState();
      }
    },
    [refreshState],
  );

  const connect = useCallback(() => {
    if (!authed) return;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // No credential in the URL. A same-origin WebSocket upgrade carries cookies
    // automatically, so the session travels the same way as every other request
    // instead of ending up in logs and referrers as a query parameter.
    const ws = new WebSocket(
      `${proto}://${location.host}/api/ws?conversationId=${conversationId}&workspaceId=default`,
    );
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Dropping while the app is open should heal itself; the wake handlers
      // only cover coming back from the background.
      setTimeout(() => {
        if (document.visibilityState === "visible" && !wsRef.current) connectRef.current?.();
      }, 1500);
    };
    ws.onmessage = (e) => {
      try {
        apply(JSON.parse(e.data) as TurnEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
  }, [authed, conversationId, apply]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  /**
   * Reconnect whenever the app comes back to life.
   *
   * iOS suspends a backgrounded PWA and kills its WebSocket. The Turn keeps
   * running in the Durable Object — that part works — but the client was only
   * ever connecting on mount, so returning to the app showed a dead screen
   * until it was force-quit and relaunched. Waking on visibility, focus and
   * network recovery closes that gap; `loadHistory` then pulls in any Turn
   * that finished while we were away.
   */
  useEffect(() => {
    if (!authed) return;

    const wake = () => {
      if (document.visibilityState === "hidden") return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        wsRef.current = null;
        connect();
      }
      loadHistory();
      refreshState();
    };

    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    // Backstop for the case where every event above is missed.
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && !wsRef.current) wake();
    }, 5000);

    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      clearInterval(poll);
    };
  }, [authed, connect, loadHistory, refreshState]);

  // Cost is shown before the Turn runs, not after (ADR-0004). Debounced so
  // typing does not hammer the endpoint.
  useEffect(() => {
    if (!councilOn || !draft.trim() || !memberIds.length) {
      setEstimate(null);
      return;
    }
    const t = setTimeout(async () => {
      const res = await fetch("/api/council/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message: draft, memberIds, chairId: chairId || profileId }),
      });
      if (res.ok) setEstimate(await res.json());
    }, 500);
    return () => clearTimeout(t);
  }, [councilOn, draft, memberIds, chairId, profileId, conversationId]);

  function send() {
    const text = draft.trim();
    if (!text || running) return;
    if (councilOn && !memberIds.length) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
      return;
    }
    setEntries((p) => [...p, { role: "user", text }]);
    setDraft("");
    setTurnStartedAt(Date.now());
    setRunning(true);
    ws.send(
      JSON.stringify({
        type: "turn",
        message: text,
        workspaceId: "default",
        profileId,
        council: councilOn && memberIds.length ? { memberIds, chairId: chairId || profileId } : null,
      }),
    );
  }

  /**
   * The picker opens only while the draft is a bare "/token" with no space —
   * that is the position where a Skill invocation is meaningful. Once the
   * Operator starts writing the actual request it gets out of the way.
   */
  const slashQuery = (() => {
    const m = /^\/([a-z0-9_-]*)$/i.exec(draft);
    return m ? m[1] : null;
  })();
  const slashMatches = slashQuery === null ? [] : filterSkills(skills, slashQuery);
  const slashOpen = slashQuery !== null && !slashDismissed && !running;

  function pickSkill(name: string) {
    setDraft(`/${name} `);
    setSlashActive(0);
    inputRef.current?.focus();
  }

  function newConversation() {
    wsRef.current?.close();
    wsRef.current = null;
    setEntries([]);
    setRunning(false);
    const fresh = uuid();
    localStorage.setItem("harnessConversationId", fresh);
    setConversationId(fresh);
  }

  // Undetermined is not unauthenticated: render nothing rather than flash a
  // login screen at someone who already has a valid session.
  if (authed === null) return <div className="h-full" />;
  if (authed === false) return <TokenGate onDone={() => refreshState()} />;

  const pct = spend ? Math.min(100, (spend.cost_usd / spend.cap_usd) * 100) : 0;
  const overCap = spend ? spend.cost_usd >= spend.cap_usd : false;

  return (
    <div className="flex h-full flex-col">
      <header className="app-header flex flex-wrap items-center gap-2.5 border-b border-[var(--edge)] bg-[var(--paper)]/85 px-5 py-3 backdrop-blur">
        <span className="display text-[17px] font-semibold">Super</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-[var(--ok)]" : "bg-[var(--danger)]"}`}
          title={connected ? "connected" : "reconnecting"}
        />

        <div className="flex-1" />

        <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="field w-auto">
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        {spend && (
          <div className="flex items-center gap-2" title={`${spend.turns} turns this month`}>
            <div className="h-1 w-20 overflow-hidden rounded-full bg-[var(--edge)]">
              <div className="h-full rounded-full bg-[var(--clay)]" style={{ width: `${Math.max(pct, 1)}%` }} />
            </div>
            <span className="mono text-[var(--muted)]">${spend.cost_usd.toFixed(4)}</span>
          </div>
        )}

        <button className="btn" onClick={() => setPanel("workspace")}>Workspace</button>
        <button className="btn" onClick={() => setPanel("skills")}>Skills</button>
        <button className="btn" onClick={() => setPanel("models")}>Models</button>
        <button className="btn" onClick={newConversation}>New</button>
      </header>

      {panel === "skills" && <SkillsPanel onClose={() => setPanel(null)} />}
      {panel === "models" && <ModelsPanel onClose={() => { setPanel(null); refreshState(); }} />}
      {panel === "workspace" && <WorkspacePanel onClose={() => setPanel(null)} />}

      <main className="flex-1 overflow-y-auto px-5 py-10">
        <div className="mx-auto max-w-[46rem]">
          {entries.length === 0 && <Empty skills={skills} onPick={pickSkill} />}
          {entries.map((e, i) => (
            <Message key={i} entry={e} />
          ))}
          {running && (
            <Working
              // The tool still awaiting output is what it is doing right now;
              // no pending tool means it is between steps, thinking.
              activity={(() => {
                const tools = entries[entries.length - 1]?.tools;
                const pending = tools?.find((t) => t.output === undefined);
                return pending?.tool ?? null;
              })()}
              startedAt={turnStartedAt}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <footer className="composer-footer px-5 pb-6">
        <div className="mx-auto max-w-[46rem]">
          <div className="card relative overflow-visible p-1.5">
            {slashOpen && (
              <SlashMenu
                skills={slashMatches}
                query={slashQuery ?? ""}
                active={slashActive}
                onHover={setSlashActive}
                onPick={pickSkill}
              />
            )}
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setSlashActive(0);
                // Re-arm the picker whenever a fresh "/" is typed, so
                // dismissing it once does not disable it for the session.
                if (!e.target.value.startsWith("/")) setSlashDismissed(false);
              }}
              onKeyDown={(e) => {
                if (slashOpen && slashMatches.length) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashActive((i) => (i + 1) % slashMatches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashActive((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                    return;
                  }
                  // Enter picks rather than sends while the menu is open;
                  // sending a bare "/name" was never the intent.
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    pickSkill(slashMatches[slashActive].name);
                    return;
                  }
                }
                if (e.key === "Escape" && slashOpen) {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Ask Super to read, write, refactor or search /workspace…  Type / for skills"
              className="max-h-52 min-h-[52px] w-full resize-none bg-transparent px-3 py-2.5 text-[15px] outline-none placeholder:text-[var(--muted)]"
            />
            <div className="flex items-center gap-2 px-2 pb-1">
              <button
                onClick={() => setCouncilOn((v) => !v)}
                className={`pill ${councilOn ? "pill-accent" : ""} cursor-pointer`}
                title="Ask several models in parallel and have a chair synthesise"
              >
                Council
              </button>

              {councilOn && (
                <>
                  {profiles.map((p) => (
                    <button
                      key={p.id}
                      onClick={() =>
                        setMemberIds((ids) => (ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id]))
                      }
                      className={`pill cursor-pointer ${
                        memberIds.includes(p.id) ? "border-[var(--clay)] text-[var(--clay)]" : ""
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                  {estimate && <span className="mono text-[var(--muted)]">~${estimate.total_usd.toFixed(4)}</span>}
                </>
              )}

              <div className="flex-1" />
              {running ? (
                <button onClick={() => wsRef.current?.send(JSON.stringify({ type: "stop" }))} className="btn">
                  Stop
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!draft.trim() || overCap || (councilOn && !memberIds.length)}
                  className="btn btn-primary"
                  title={overCap ? "Monthly spend cap reached" : undefined}
                >
                  Send
                </button>
              )}
            </div>
          </div>
          <p className="mt-2.5 text-center text-xs text-[var(--muted)]">
            Reads, writes and uses real git — but cannot run <code className="mono">node</code>,{" "}
            <code className="mono">npm</code>, <code className="mono">python</code> or your tests, so it cannot verify
            its own work.
          </p>
        </div>
      </footer>
    </div>
  );
}

function Empty({ skills, onPick }: { skills: SkillManifest[]; onPick: (name: string) => void }) {
  return (
    <div className="mt-20 text-center">
      <h1 className="display mb-3 text-[27px] leading-tight">What are we working on?</h1>
      <p className="mx-auto max-w-md text-[var(--muted)]">
        A lightweight coding harness on a persistent workspace. It searches, edits and commits — and tells you plainly
        when it cannot verify something.
      </p>
      {skills.length > 0 && (
        <>
          {/* Real skills, not a hardcoded list that goes stale the moment one
              is installed. Clicking inserts the invocation. */}
          <div className="mt-7 flex flex-wrap justify-center gap-1.5">
            {skills.map((s) => (
              <button key={s.name} className="pill mono cursor-pointer hover:border-[var(--clay)]" title={s.description} onClick={() => onPick(s.name)}>
                /{s.name}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Type <code className="mono">/</code> in the box below to search them.
          </p>
        </>
      )}
    </div>
  );
}

function Message({ entry }: { entry: Entry }) {
  if (entry.role === "user") {
    return (
      <div className="mb-8 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[var(--clay-soft)] px-4 py-2.5 text-[15px] whitespace-pre-wrap">
          {entry.text}
        </div>
      </div>
    );
  }

  const s = entry.summary;
  return (
    <div className="mb-9">
      {entry.council && (
        <div className="mb-3 rounded-xl border border-[var(--edge)] bg-[var(--panel)] p-2.5">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            Council · {entry.council.members.length} members · chair {entry.council.chair}
          </div>
          {entry.council.members.map((m) => {
            const done = entry.memberAnswers?.find((a) => a.member === m);
            return (
              <details key={m} className="mb-1 rounded-lg border border-[var(--edge)] bg-[var(--surface)]">
                <summary className="mono flex items-center gap-2 px-2.5 py-1.5">
                  <span className={done ? "" : "breathe"}>{done ? "✓" : "○"}</span>
                  {m}
                  {done && <span className="text-[var(--muted)]">${done.cost_usd.toFixed(5)}</span>}
                </summary>
                {done && <div className="px-2.5 pb-2.5 text-[13px] whitespace-pre-wrap">{done.answer}</div>}
              </details>
            );
          })}
          {entry.chairWorking && <div className="breathe text-[11px] text-[var(--muted)]">chair synthesising…</div>}
        </div>
      )}

      {entry.tools?.map((t, i) => (
        <details key={i} className="mb-1.5 rounded-lg border border-[var(--edge)] bg-[var(--panel)]">
          <summary className="mono flex items-center gap-2 px-2.5 py-1.5 text-[var(--muted)]">
            <span className={t.output === undefined ? "breathe" : ""}>{t.output === undefined ? "○" : "✓"}</span>
            <span className="text-[var(--ink-soft)]">{t.tool}</span>
            <span className="truncate">{t.input}</span>
          </summary>
          <pre className="mono mx-2.5 mb-2.5 max-h-72 overflow-auto rounded-md border border-[var(--edge)] bg-[var(--surface)] p-2.5 whitespace-pre-wrap">
            {t.output ?? "running…"}
          </pre>
        </details>
      ))}

      {entry.text && (
        <div className="mt-3">
          <Markdown text={entry.text} />
        </div>
      )}

      <Artifacts files={artifactsFromTrace(entry.tools)} workspaceId="default" />
      {entry.error && <div className="mt-2 text-sm text-[var(--danger)]">{entry.error}</div>}

      {s && (
        <div className="mono mt-3 text-[var(--muted)]">
          {s.model_profile_id} · {s.usage.input_tokens} in
          {/* Surfaced deliberately: the visible signal that the frozen prompt
              prefix is intact. If it collapses to zero, something broke it. */}
          <span title="tokens served from the model's prompt cache"> ({s.usage.cached_tokens} cached)</span> ·{" "}
          {s.usage.output_tokens} out · ${s.cost_usd.toFixed(5)} · {s.tool_calls} tools ·{" "}
          {(s.duration_ms / 1000).toFixed(1)}s
          {s.stop_reason !== "complete" && <span className="text-[var(--danger)]"> · {s.stop_reason}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Only rendered when the Worker actually rejects us, which happens only if
 * HARNESS_BOOTSTRAP_TOKEN is set. The token is exchanged once for an HttpOnly
 * session cookie; the page never stores or re-reads it.
 */
function TokenGate({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!v.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: v.trim() }),
      });
      if (res.ok) onDone();
      else setErr(((await res.json()) as { error?: string }).error ?? "Sign-in failed.");
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-5">
      <div className="card w-full max-w-sm p-6">
        <h1 className="display mb-1.5 text-xl">Super</h1>
        <p className="mb-5 text-sm text-[var(--muted)]">This workspace is protected. Enter the access token to continue.</p>
        <input
          type="password"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="field mb-3"
          placeholder="token"
          autoFocus
        />
        {err && <p className="mb-3 text-sm text-[var(--danger)]">{err}</p>}
        <button onClick={submit} disabled={busy || !v.trim()} className="btn btn-primary w-full justify-center">
          {busy ? "Checking…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
