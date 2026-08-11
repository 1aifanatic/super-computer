import { getWorkspace } from "@cloudflare/computer";
import { ARG_PARSE_ERROR, type ToolSchema } from "./models";
import { loadSkillBody, resolveSkillName } from "./skills";
import type { Env, ToolCall } from "./types";

/**
 * The full tool surface (ADR-0008). `load_skill` arrives with Skills in M3 and
 * is the last addition -- this list is a ceiling, not a starting point. Cheap
 * models degrade as the surface grows, so if MiniMax starts mis-calling tools
 * the fix is removing one, never adding a prompt telling it to be careful.
 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the Workspace. Returns numbered lines. Use offset/limit for large files rather than reading everything.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, e.g. /workspace/notes.md" },
        offset: { type: "number", description: "1-based first line to return. Optional." },
        limit: { type: "number", description: "Maximum lines to return. Optional, defaults to 500." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or completely overwrite a file. For changing part of an existing file, prefer edit_file -- it is far cheaper.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path" },
        content: { type: "string", description: "Full file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match the file byte-for-byte including indentation, and must be unique unless replace_all is true. This is the preferred way to change existing code.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Text to replace it with" },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_dir",
    description: "List the immediate contents of a directory, marking which entries are directories.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute directory path, e.g. /workspace" } },
      required: ["path"],
    },
  },
  {
    name: "glob",
    description: "Find files by name pattern, recursively. Use this to locate files when you do not know the path.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Filename pattern, e.g. *.ts" },
        path: { type: "string", description: "Directory to search from. Defaults to /workspace." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents for a pattern, recursively. Returns matching lines with file and line number.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or regular expression to find" },
        path: { type: "string", description: "Directory or file to search. Defaults to /workspace." },
        ignore_case: { type: "boolean", description: "Case-insensitive search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the Workspace. Available: ls, cat, grep, sed, awk, find, sort, wc, head, tail, cut, tr, diff, jq, pipes, redirects, loops, conditionals, and real git (clone, status, diff, add, commit, log, branch, checkout; HTTPS only). NOT available: node, npm, python, or any other native binary -- you cannot install packages, build, or run tests.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command" } },
      required: ["command"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a public web page or API over HTTPS and return it as text. Use for documentation lookups.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute https:// URL" } },
      required: ["url"],
    },
  },
  {
    name: "load_skill",
    description:
      "Load the full instructions for one of the available Skills listed in your system prompt. Call this as soon as a Skill's description matches the task, before starting work.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Exact Skill name from the available Skills list" } },
      required: ["name"],
    },
  },
];

/**
 * The Council Member surface (ADR-0004): Members advise, they never act.
 *
 * `bash` is excluded outright rather than filtered, because a shell that can
 * redirect (`echo x > f`) is a write tool wearing a read tool's name. That
 * leaves Members unable to change a single byte of the Workspace, which is the
 * whole guarantee -- several agents writing to one filesystem is a conflict
 * problem with no good answer.
 */
export const READ_ONLY_TOOL_NAMES = ["read_file", "list_dir", "glob", "grep", "web_fetch", "load_skill"] as const;

export const READ_ONLY_TOOL_SCHEMAS: ToolSchema[] = TOOL_SCHEMAS.filter((t) =>
  (READ_ONLY_TOOL_NAMES as readonly string[]).includes(t.name),
);

/** ADR-0007: truncate at source. Tool output is where agent context actually goes. */
const MAX_TOOL_OUTPUT = 8000;
const DEFAULT_READ_LINES = 500;

function truncate(text: string, note = "Narrow the command or read a specific range."): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  const kept = text.slice(0, MAX_TOOL_OUTPUT);
  const dropped = text.slice(MAX_TOOL_OUTPUT).split("\n").length;
  return `${kept}\n...truncated, ${dropped} more lines. ${note}`;
}

/**
 * web_fetch is the only tool that can reach off the Workspace, so it is the
 * only one with an egress problem. Blocking private and link-local hosts stops
 * the model being talked into reading cloud metadata or an internal service.
 */
function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) URLs are allowed");
  const h = url.hostname.toLowerCase();
  const blocked =
    h === "localhost" ||
    h === "0.0.0.0" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === "[::1]";
  if (blocked) throw new Error("refusing to fetch a private or link-local address");
  return url;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export async function runTool(
  env: Env,
  workspaceId: string,
  call: ToolCall,
  /** Council Members pass true. Enforced here as well as by the schema, so a
   *  model that hallucinates a write tool still cannot reach one. */
  readOnly = false,
): Promise<string> {
  const args = call.arguments ?? {};

  // Truncated tool call: the model ran out of output budget mid-JSON, almost
  // always because it tried to write a large file in one go. Say so, and give
  // it a strategy -- otherwise it retries the identical oversized call.
  if (ARG_PARSE_ERROR in args) {
    return [
      `Your ${call.name} call was cut off mid-way and its arguments could not be parsed`,
      `(${args[ARG_PARSE_ERROR]} characters, incomplete). This means the content was too long for one call.`,
      ``,
      `Do not repeat the same call. Instead:`,
      `- Write the file in several smaller pieces: write_file for the first part, then append the rest`,
      `  with bash (e.g. cat >> /path <<'EOF' ... EOF), or use edit_file to add sections one at a time.`,
      `- Keep each individual call well under a few thousand words.`,
    ].join("\n");
  }

  if (readOnly && !(READ_ONLY_TOOL_NAMES as readonly string[]).includes(call.name)) {
    return `Error: ${call.name} is not available to a Council Member. Council Members advise; they do not modify the Workspace.`;
  }

  // load_skill reads from D1, not the Workspace.
  if (call.name === "load_skill") {
    const name = String(args.name ?? "").toLowerCase().trim();
    if (!name) return "Error: name is required.";

    const { id, suggestion, available } = await resolveSkillName(env, name);
    if (id) {
      const body = await loadSkillBody(env, id);
      if (body) return body;
    }

    // Phrased to end the retry loop. A bare "not found" invites the model to
    // try the identical call again, which is exactly how a Turn was lost.
    return [
      `No skill named "${name}" is available. Do NOT call load_skill with that name again.`,
      suggestion ? `Closest match: "${suggestion}" — call load_skill with that name if it fits.` : null,
      `All available skills: ${available.join(", ") || "(none)"}.`,
      `If none fit, continue without a skill and complete the task directly.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // web_fetch never touches the Workspace, so it does not open one.
  if (call.name === "web_fetch") {
    try {
      const url = assertPublicUrl(String(args.url ?? ""));
      const res = await fetch(url.toString(), {
        headers: { "user-agent": "simple-lite-cloudaiharness/1.0" },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.text();
      const type = res.headers.get("content-type") ?? "";
      const text = type.includes("html") ? htmlToText(body) : body;
      return truncate(`HTTP ${res.status} ${url}\n\n${text}`, "Fetch a more specific page.");
    } catch (e: any) {
      return `Error: ${String(e?.message ?? e).slice(0, 400)}`;
    }
  }

  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  // getWorkspace's WorkspaceHandle and the generated DurableObjectStub type do
  // not line up in @cloudflare/computer 0.2.0 -- a typings gap, not a runtime
  // one (Spike A exercised this path live). Cast is confined to this line.
  using ws: any = await getWorkspace(stub as any);

  try {
    switch (call.name) {
      case "read_file": {
        const path = String(args.path ?? "");
        if (!path.startsWith("/")) return "Error: path must be absolute.";
        const raw = String(await ws.fs.readFile(path, "utf8"));
        const lines = raw.split("\n");
        const offset = Math.max(1, Number(args.offset ?? 1));
        const limit = Math.max(1, Number(args.limit ?? DEFAULT_READ_LINES));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
        const more = lines.length - (offset - 1 + slice.length);
        return truncate(numbered + (more > 0 ? `\n...${more} more lines. Use offset/limit.` : ""));
      }

      case "write_file": {
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!path.startsWith("/")) return "Error: path must be absolute.";
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (dir) await ws.fs.mkdir(dir, { recursive: true });
        await ws.fs.writeFile(path, content);
        return `Wrote ${content.length} bytes to ${path}.`;
      }

      case "edit_file": {
        const path = String(args.path ?? "");
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        if (!path.startsWith("/")) return "Error: path must be absolute.";
        if (!oldStr) return "Error: old_string must not be empty. Use write_file to create a file.";

        const current = String(await ws.fs.readFile(path, "utf8"));
        const occurrences = current.split(oldStr).length - 1;
        if (occurrences === 0) {
          return "Error: old_string was not found. It must match the file exactly, including indentation.";
        }
        if (occurrences > 1 && args.replace_all !== true) {
          return `Error: old_string appears ${occurrences} times. Include more surrounding context to make it unique, or set replace_all.`;
        }
        const updated = args.replace_all === true ? current.split(oldStr).join(newStr) : current.replace(oldStr, newStr);
        await ws.fs.writeFile(path, updated);
        return `Edited ${path} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`;
      }

      case "list_dir": {
        const path = String(args.path ?? "/workspace");
        const entries = await ws.fs.readdir(path);
        if (!entries.length) return `${path} is empty.`;
        return truncate(
          entries
            .map((e: any) => (e.isDirectory ? `d ${e.name}/` : `f ${e.name}`))
            .sort()
            .join("\n"),
        );
      }

      case "glob": {
        const pattern = String(args.pattern ?? "*");
        const root = String(args.path ?? "/workspace");
        using run: any = await ws.runtime.exec(`find ${shellQuote(root)} -name ${shellQuote(pattern)}`, {
          encoding: "utf8",
        });
        const { stdout } = await run.result();
        const out = String(stdout ?? "").trim();
        return out ? truncate(out) : `No files matching ${pattern} under ${root}.`;
      }

      case "grep": {
        const pattern = String(args.pattern ?? "");
        const root = String(args.path ?? "/workspace");
        if (!pattern) return "Error: pattern is required.";
        const flags = args.ignore_case === true ? "-rni" : "-rn";
        using run: any = await ws.runtime.exec(`grep ${flags} ${shellQuote(pattern)} ${shellQuote(root)}`, {
          encoding: "utf8",
        });
        const { stdout, exitCode } = await run.result();
        const out = String(stdout ?? "").trim();
        // grep exits 1 on "no matches", which is an answer, not a failure.
        if (!out) return exitCode === 1 ? `No matches for ${pattern} in ${root}.` : "(no output)";
        return truncate(out);
      }

      case "bash": {
        const command = String(args.command ?? "");
        if (!command.trim()) return "Error: empty command.";
        using run: any = await ws.runtime.exec(command, { encoding: "utf8" });
        const { stdout, stderr, exitCode } = await run.result();
        const body = [String(stdout ?? "").trim(), String(stderr ?? "").trim()].filter(Boolean).join("\n");
        return truncate(exitCode === 0 ? body || "(no output)" : `exit ${exitCode}\n${body}`);
      }

      default:
        return `Error: unknown tool ${call.name}.`;
    }
  } catch (e: any) {
    // Tool failures are information for the model, not crashes. Returning the
    // message lets it correct course instead of dying mid-Turn.
    return `Error: ${String(e?.message ?? e).slice(0, 500)}`;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
