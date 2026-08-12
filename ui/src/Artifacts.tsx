import { useState } from "react";

/**
 * Files a Turn produced, surfaced as things you can actually take away.
 *
 * The harness was writing a 27KB diagram and then telling the Operator a
 * filesystem path inside a Durable Object — somewhere they had no way to reach.
 * Work that cannot leave the Workspace may as well not exist.
 */

const PREVIEWABLE = /\.(html?|svg|md|txt|json|css|js|ts|tsx|jsx|yml|yaml|csv|sh|sql)$/i;
const RENDERABLE = /\.(html?|svg)$/i;

export interface Artifact {
  path: string;
}

export default function Artifacts({ files, workspaceId }: { files: Artifact[]; workspaceId: string }) {
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  if (!files.length) return null;

  const href = (path: string) =>
    `/api/workspace/file?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}&download=1`;

  async function open(path: string) {
    setLoading(path);
    try {
      const res = await fetch(
        `/api/workspace/file?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`,
      );
      const d = await res.json();
      setPreview(res.ok ? { path, content: d.content } : { path, content: d.error ?? "Could not read file." });
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      <div className="artifacts">
        {files.map((f) => {
          const name = f.path.split("/").pop() ?? f.path;
          return (
            <div key={f.path} className="artifact">
              <span className="artifact-icon">{RENDERABLE.test(name) ? "◫" : "▤"}</span>
              <span className="artifact-name mono" title={f.path}>{name}</span>
              <div className="flex-1" />
              {PREVIEWABLE.test(name) && (
                <button className="btn btn-ghost" onClick={() => open(f.path)} disabled={loading === f.path}>
                  {loading === f.path ? "opening…" : "open"}
                </button>
              )}
              {/* A plain link, so mobile browsers use their own download UI. */}
              <a className="btn btn-ghost" href={href(f.path)} download={name}>
                download
              </a>
            </div>
          );
        })}
      </div>

      {preview && (
        <div className="drawer" onClick={() => setPreview(null)}>
          <div className="drawer-body" onClick={(e) => e.stopPropagation()}>
            <header className="flex items-center gap-3 border-b border-[var(--edge)] px-5 py-3.5">
              <h2 className="display truncate text-[16px] font-semibold">{preview.path.split("/").pop()}</h2>
              <div className="flex-1" />
              <a className="btn" href={href(preview.path)} download>Download</a>
              <button className="btn" onClick={() => setPreview(null)}>Close</button>
            </header>
            <div className="flex-1 overflow-auto p-0">
              {RENDERABLE.test(preview.path) ? (
                // Sandboxed without allow-same-origin: model-generated markup
                // renders, but cannot touch this origin, its cookies or its API.
                <iframe
                  title="preview"
                  className="preview-frame"
                  sandbox="allow-scripts allow-popups"
                  srcDoc={preview.content}
                />
              ) : (
                <pre className="mono m-4 whitespace-pre-wrap">{preview.content}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Paths a Turn wrote, de-duplicated, in the order they were written.
 *
 * Uses the `path` the server carries on the event. It used to parse `input`,
 * which is truncated to 300 characters for display — so a large file, the one
 * most worth downloading, produced invalid JSON and silently no card at all.
 * Parsing remains only as a fallback for short calls from older sessions.
 */
export function artifactsFromTrace(
  trace: { tool: string; input: string; path?: string }[] | undefined,
): Artifact[] {
  if (!trace?.length) return [];
  const seen = new Set<string>();
  const out: Artifact[] = [];

  for (const t of trace) {
    if (t.tool !== "write_file" && t.tool !== "edit_file") continue;

    let path = t.path;
    if (!path) {
      try {
        const parsed = JSON.parse(t.input)?.path;
        if (typeof parsed === "string") path = parsed;
      } catch {
        // Truncated input and no explicit path: nothing reliable to offer.
      }
    }

    if (path && !seen.has(path)) {
      seen.add(path);
      out.push({ path });
    }
  }
  return out;
}
