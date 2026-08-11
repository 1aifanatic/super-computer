import { useCallback, useEffect, useState } from "react";

interface Skill {
  id: string;
  name: string;
  description: string;
  origin: "preloaded" | "github";
  source_url: string | null;
  status: "pending" | "approved";
}

export default function Skills({ onClose }: { onClose: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [reviewing, setReviewing] = useState<{ id: string; body: string; files: string[] } | null>(null);

  // Auth rides on the session cookie, sent automatically on same-origin fetch.
  const headers = { "content-type": "application/json" };

  const load = useCallback(async () => {
    const res = await fetch("/api/skills", { headers });
    if (res.ok) setSkills((await res.json()).skills);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function review(id: string) {
    const res = await fetch(`/api/skills/body?id=${encodeURIComponent(id)}`, { headers });
    if (res.ok) setReviewing(await res.json());
  }

  async function install() {
    if (!url.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/skills/install", { method: "POST", headers, body: JSON.stringify({ url: url.trim() }) });
      const data = await res.json();
      if (!res.ok) {
        setMessage({
          kind: "error",
          text: data.choices?.length ? `${data.error} Found: ${data.choices.join(", ")}` : data.error || `HTTP ${res.status}`,
        });
      } else {
        setUrl("");
        setMessage({ kind: "info", text: `Installed "${data.skill.name}". Read it and approve it before it can be used.` });
        await load();
        await review(data.skill.id);
      }
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/skills/${path}`, { method: "POST", headers, body: JSON.stringify({ id }) });
      const data = await res.json();
      if (data.error) setMessage({ kind: "error", text: data.error });
      setReviewing(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const pending = skills.filter((s) => s.status === "pending");
  const approved = skills.filter((s) => s.status === "approved");

  return (
    <div className="drawer" onClick={onClose}>
      <div className="drawer-body" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-[var(--edge)] px-5 py-3.5">
          <h2 className="display text-[17px] font-semibold">Skills</h2>
          <span className="pill">
            {approved.length} available{pending.length ? ` · ${pending.length} to review` : ""}
          </span>
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>Close</button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="card mb-5 p-4">
            <div className="label">Install from GitHub</div>
            <div className="flex gap-2">
              <input
                className="field"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && install()}
                placeholder="https://github.com/owner/repo/tree/main/skills/name"
              />
              <button className="btn btn-primary" onClick={install} disabled={busy || !url.trim()}>
                Install
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">
              A skill is instructions your model will obey, so nothing from GitHub is usable until you have read it and
              approved it.
            </p>
          </div>

          {message && (
            <div
              className={`mb-4 rounded-xl border px-3 py-2 text-sm ${
                message.kind === "error" ? "border-[var(--danger)] text-[var(--danger)]" : "border-[var(--edge)] bg-[var(--panel)]"
              }`}
            >
              {message.text}
            </div>
          )}

          {reviewing && (
            <div className="card mb-5 border-[var(--clay)] p-4">
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <b className="display text-[15px]">{reviewing.id}</b>
                <div className="flex-1" />
                <button className="btn btn-primary" disabled={busy} onClick={() => act("approve", reviewing.id)}>
                  Approve
                </button>
                <button className="btn" disabled={busy} onClick={() => act("delete", reviewing.id)}>
                  Delete
                </button>
                <button className="btn btn-ghost" onClick={() => setReviewing(null)}>✕</button>
              </div>
              {reviewing.files.length > 1 && (
                <div className="mono mb-2 text-[var(--muted)]">bundled: {reviewing.files.join(", ")}</div>
              )}
              <pre className="mono max-h-[26rem] overflow-auto rounded-xl border border-[var(--edge)] bg-[var(--surface)] p-3 whitespace-pre-wrap">
                {reviewing.body}
              </pre>
            </div>
          )}

          {pending.length > 0 && (
            <>
              <div className="label mt-1">Awaiting your review</div>
              <div className="mb-5 space-y-2">
                {pending.map((s) => <Row key={s.id} skill={s} onReview={() => review(s.id)} />)}
              </div>
            </>
          )}

          <div className="label">Available</div>
          <div className="space-y-2">
            {approved.map((s) => <Row key={s.id} skill={s} onReview={() => review(s.id)} />)}
          </div>

          <p className="mt-5 text-xs text-[var(--muted)]">
            Newly approved skills appear in the <b>next</b> conversation — the system prompt is frozen once a
            conversation starts so it keeps hitting the model's cache. Invoke one directly with{" "}
            <code className="mono">/skill-name</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ skill, onReview }: { skill: Skill; onReview: () => void }) {
  return (
    <div className="card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="mono text-[13px] font-semibold text-[var(--ink)]">{skill.name}</code>
        <span className="pill">{skill.origin}</span>
        {skill.status === "pending" && <span className="pill pill-warn">unapproved</span>}
        <div className="flex-1" />
        <button className="btn btn-ghost" onClick={onReview}>view</button>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">{skill.description}</p>
    </div>
  );
}
