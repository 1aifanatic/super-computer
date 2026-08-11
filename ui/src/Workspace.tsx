import { useCallback, useEffect, useState } from "react";

interface Binding {
  workspace_id: string;
  repo_url: string;
  ref: string | null;
  dir: string;
  bound_at: number;
  last_push_at: number | null;
}

export default function Workspace({ onClose }: { onClose: () => void }) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [canPush, setCanPush] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [ref, setRef] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [output, setOutput] = useState<string>("");

  // Auth rides on the session cookie, sent automatically on same-origin fetch.
  const headers = { "content-type": "application/json" };

  const load = useCallback(async () => {
    const res = await fetch("/api/workspace/binding?workspaceId=default", { headers });
    if (res.ok) {
      const d = await res.json();
      setBinding(d.binding);
      setCanPush(d.can_push);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function git(argv: string[]) {
    setBusy(argv[0]);
    setNote(null);
    try {
      const res = await fetch("/api/workspace/git", {
        method: "POST",
        headers,
        body: JSON.stringify({ workspaceId: "default", argv, cwd: binding?.dir ?? "/workspace" }),
      });
      const d = await res.json();
      setOutput(`$ git ${argv.join(" ")}\n\n${d.stdout || d.stderr || "(no output)"}`);
    } finally {
      setBusy(null);
    }
  }

  async function bind() {
    if (!repoUrl.trim()) return;
    setBusy("bind");
    setNote(null);
    try {
      const res = await fetch("/api/workspace/bind", {
        method: "POST",
        headers,
        body: JSON.stringify({ workspaceId: "default", repoUrl: repoUrl.trim(), ref: ref.trim() || undefined }),
      });
      const d = await res.json();
      if (!res.ok) setNote({ kind: "error", text: d.error });
      else {
        setNote({ kind: "ok", text: `Cloned into ${d.dir}` });
        setRepoUrl("");
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  async function push() {
    setBusy("push");
    setNote(null);
    try {
      const res = await fetch("/api/workspace/push", {
        method: "POST",
        headers,
        body: JSON.stringify({ workspaceId: "default", message: commitMessage.trim() || undefined }),
      });
      const d = await res.json();
      setOutput((d.steps ?? []).map((s: any) => `$ git ${s.argv.join(" ")}  [exit ${s.exitCode}]\n${s.out}`).join("\n\n"));
      setNote(d.ok ? { kind: "ok", text: "Pushed." } : { kind: "error", text: d.error ?? "Push failed — see output." });
      if (d.ok) {
        setCommitMessage("");
        await load();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="drawer" onClick={onClose}>
      <div className="drawer-body" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-[var(--edge)] px-5 py-3.5">
          <h2 className="display text-[17px] font-semibold">Workspace</h2>
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>Close</button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {note && (
            <div
              className={`mb-4 rounded-xl border px-3 py-2 text-sm ${
                note.kind === "error"
                  ? "border-[var(--danger)] text-[var(--danger)]"
                  : "border-[var(--edge)] bg-[var(--panel)]"
              }`}
            >
              {note.text}
            </div>
          )}

          {binding ? (
            <div className="card mb-5 p-4">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="pill pill-accent">bound</span>
                <a href={binding.repo_url} target="_blank" rel="noreferrer" className="text-sm font-medium underline">
                  {binding.repo_url.replace("https://github.com/", "")}
                </a>
                {binding.ref && <span className="pill mono">{binding.ref}</span>}
              </div>
              <div className="mono mb-3 text-[var(--muted)]">
                {binding.dir}
                {binding.last_push_at ? ` · last push ${new Date(binding.last_push_at * 1000).toLocaleString()}` : " · never pushed"}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button className="btn" disabled={!!busy} onClick={() => git(["status"])}>Status</button>
                <button className="btn" disabled={!!busy} onClick={() => git(["diff"])}>Diff</button>
                <button className="btn" disabled={!!busy} onClick={() => git(["log", "--oneline"])}>Log</button>
                <button className="btn" disabled={!!busy} onClick={() => git(["branch"])}>Branches</button>
              </div>
            </div>
          ) : (
            <p className="mb-4 text-sm text-[var(--muted)]">
              This workspace is not bound to a repository. Binding clones it with real git, so history, branches and
              diffs all work.
            </p>
          )}

          <div className="card mb-5 p-4">
            <div className="label">{binding ? "Re-bind to a different repository" : "Bind a repository"}</div>
            <div className="flex gap-2">
              <input
                className="field"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
              />
              <input className="field w-32" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="branch" />
              <button className="btn btn-primary" disabled={busy === "bind" || !repoUrl.trim()} onClick={bind}>
                {busy === "bind" ? "Cloning…" : "Clone"}
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">HTTPS only — isomorphic-git has no SSH transport.</p>
          </div>

          {binding && (
            <div className="card mb-5 p-4">
              <div className="label">Commit and push</div>
              <div className="flex gap-2">
                <input
                  className="field"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Commit message"
                />
                <button className="btn btn-primary" disabled={busy === "push" || !canPush} onClick={push}>
                  {busy === "push" ? "Pushing…" : "Commit & push"}
                </button>
              </div>
              {!canPush && (
                <p className="mt-2 text-xs text-[var(--danger)]">
                  Push is disabled: <code className="mono">GITHUB_TOKEN</code> is not set. Run{" "}
                  <code className="mono">wrangler secret put GITHUB_TOKEN</code>.
                </p>
              )}
            </div>
          )}

          {output && (
            <div>
              <div className="label">Output</div>
              <pre className="mono max-h-96 overflow-auto rounded-xl border border-[var(--edge)] bg-[var(--surface)] p-3 whitespace-pre-wrap">
                {output}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
