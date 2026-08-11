import { useCallback, useEffect, useState } from "react";

export interface Profile {
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
  secret_present: boolean;
}

const BLANK: Profile = {
  id: "",
  label: "",
  provider_kind: "openai_compatible",
  base_url: "https://api.example.com/v1",
  secret_name: "",
  model_id: "",
  price_in_per_mtok: 0,
  price_out_per_mtok: 0,
  price_cached_per_mtok: 0,
  is_default: 0,
  enabled: 1,
  secret_present: false,
};

export default function Models({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Auth rides on the session cookie, sent automatically on same-origin fetch.
  const headers = { "content-type": "application/json" };

  const load = useCallback(async () => {
    const res = await fetch("/api/profiles", { headers });
    if (res.ok) setProfiles((await res.json()).profiles);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function post(path: string, body: unknown) {
    const res = await fetch(`/api/profiles/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json();
    setNote(data.error ?? null);
    await load();
    return data;
  }

  return (
    <div className="drawer" onClick={onClose}>
      <div className="drawer-body" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-[var(--edge)] px-5 py-3.5">
          <h2 className="display text-[17px] font-semibold">Models</h2>
          <div className="flex-1" />
          <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}>Add</button>
          <button className="btn" onClick={onClose}>Close</button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {note && (
            <div className="mb-4 rounded-xl border border-[var(--danger)] px-3 py-2 text-sm text-[var(--danger)]">{note}</div>
          )}

          {editing && (
            <Editor
              profile={editing}
              onCancel={() => setEditing(null)}
              onSave={async (p) => {
                await post("save", p);
                setEditing(null);
              }}
            />
          )}

          <div className="space-y-2">
            {profiles.map((p) => (
              <div key={p.id} className="card p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-[14px]">{p.label}</b>
                  {!!p.is_default && <span className="pill pill-accent">default</span>}
                  {!p.enabled && <span className="pill">disabled</span>}
                  {/* A missing secret is the likeliest reason a profile errors at
                      call time, so it is stated rather than left to be discovered. */}
                  {!p.secret_present && <span className="pill pill-warn">{p.secret_name} missing</span>}
                  <div className="flex-1" />
                  <button className="btn btn-ghost" onClick={() => setEditing(p)}>edit</button>
                  {!p.is_default && (
                    <button className="btn btn-ghost" onClick={() => post("default", { id: p.id })}>make default</button>
                  )}
                  {!p.is_default && (
                    <button className="btn btn-ghost" onClick={() => post("delete", { id: p.id })}>delete</button>
                  )}
                </div>
                <div className="mono mt-1 text-[var(--muted)]">
                  {p.provider_kind} · {p.model_id} · ${p.price_in_per_mtok}/M in · ${p.price_out_per_mtok}/M out · $
                  {p.price_cached_per_mtok}/M cached
                </div>
              </div>
            ))}
          </div>

          <p className="mt-5 text-xs text-[var(--muted)]">
            Credentials are never stored here — a profile names a Worker secret, and you set its value with{" "}
            <code className="mono">wrangler secret put NAME</code>. Anything speaking the OpenAI chat-completions shape
            works, so adding a provider is a row rather than a code change.
          </p>
        </div>
      </div>
    </div>
  );
}

function Editor({ profile, onSave, onCancel }: { profile: Profile; onSave: (p: Profile) => void; onCancel: () => void }) {
  const [p, setP] = useState(profile);
  const set = (k: keyof Profile, v: unknown) => setP({ ...p, [k]: v });

  return (
    <div className="card mb-5 border-[var(--clay)] p-4">
      <div className="grid grid-cols-2 gap-3">
        <L t="id (slug)"><input className="field" value={p.id} onChange={(e) => set("id", e.target.value)} placeholder="deepseek-v3" /></L>
        <L t="label"><input className="field" value={p.label} onChange={(e) => set("label", e.target.value)} placeholder="DeepSeek V3" /></L>
        <L t="provider">
          <select className="field" value={p.provider_kind} onChange={(e) => set("provider_kind", e.target.value)}>
            <option value="openai_compatible">openai_compatible</option>
            <option value="workers_ai">workers_ai</option>
          </select>
        </L>
        <L t="model id"><input className="field" value={p.model_id} onChange={(e) => set("model_id", e.target.value)} placeholder="deepseek-chat" /></L>
        {p.provider_kind === "openai_compatible" && (
          <>
            <L t="base url"><input className="field" value={p.base_url ?? ""} onChange={(e) => set("base_url", e.target.value)} /></L>
            <L t="secret name"><input className="field" value={p.secret_name ?? ""} onChange={(e) => set("secret_name", e.target.value)} placeholder="DEEPSEEK_API_KEY" /></L>
          </>
        )}
        <L t="$/M input"><input className="field" type="number" step="0.01" value={p.price_in_per_mtok} onChange={(e) => set("price_in_per_mtok", +e.target.value)} /></L>
        <L t="$/M output"><input className="field" type="number" step="0.01" value={p.price_out_per_mtok} onChange={(e) => set("price_out_per_mtok", +e.target.value)} /></L>
        <L t="$/M cached"><input className="field" type="number" step="0.01" value={p.price_cached_per_mtok} onChange={(e) => set("price_cached_per_mtok", +e.target.value)} /></L>
        <L t="state">
          <select className="field" value={p.enabled ? "1" : "0"} onChange={(e) => set("enabled", +e.target.value)}>
            <option value="1">enabled</option>
            <option value="0">disabled</option>
          </select>
        </L>
      </div>
      <div className="mt-3.5 flex gap-2">
        <button className="btn btn-primary" onClick={() => onSave(p)}>Save</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function L({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{t}</span>
      {children}
    </label>
  );
}
