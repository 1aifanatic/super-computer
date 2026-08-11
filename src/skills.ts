import { gunzip, readTar } from "./tar";
import type { Env } from "./types";

import codeSearch from "../skills/code-search/SKILL.md";
import refactor from "../skills/refactor/SKILL.md";
import jsonWrangling from "../skills/json-wrangling/SKILL.md";
import docWriter from "../skills/doc-writer/SKILL.md";
import skillAuthor from "../skills/skill-author/SKILL.md";

const PRELOADED = [codeSearch, refactor, jsonWrangling, docWriter, skillAuthor];

/** Bundled files beyond SKILL.md, per Skill. A guard against pulling a repo in. */
const MAX_BUNDLED_FILES = 20;

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  origin: "preloaded" | "github";
  source_url: string | null;
  source_ref: string | null;
  status: "pending" | "approved";
  installed_at: number;
  approved_at: number | null;
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Frontmatter parser for the two fields that matter.
 *
 * Deliberately not a YAML implementation: a Skill's frontmatter carries `name`
 * and `description`, and pulling in a parser to read two strings would be more
 * attack surface than value. Supports plain, quoted and folded-onto-one-line
 * values, which is everything real Skills use.
 */
export function parseSkill(raw: string): ParsedSkill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^﻿/, ""));
  if (!match) return null;

  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1].toLowerCase();
      fields[currentKey] = kv[2].trim();
    } else if (currentKey && /^\s+\S/.test(line)) {
      // Continuation of a wrapped value.
      fields[currentKey] = `${fields[currentKey]} ${line.trim()}`.trim();
    }
  }

  const unquote = (s: string) => s.replace(/^["']|["']$/g, "").trim();
  const name = unquote(fields.name ?? "");
  const description = unquote(fields.description ?? "");
  if (!name || !description) return null;

  return { name: name.toLowerCase(), description, body: body.trim() };
}

/**
 * Idempotent. Preloaded Skills are approved by definition -- we wrote them.
 *
 * Guarded on count by default so the hot path (every /api/state refresh) costs
 * one cheap read instead of ten writes. `force` is used by the Skills panel,
 * which is also how an edited Preloaded Skill gets picked up after a deploy.
 */
export async function syncPreloaded(env: Env, force = false): Promise<void> {
  if (!force) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM skills WHERE origin = 'preloaded'`).first<{ n: number }>();
    if ((row?.n ?? 0) === PRELOADED.length) return;
  }

  const statements = [];
  for (const raw of PRELOADED) {
    const parsed = parseSkill(raw);
    if (!parsed) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO skills (id, name, description, origin, status, installed_at, approved_at)
         VALUES (?,?,?,'preloaded','approved', unixepoch(), unixepoch())
         ON CONFLICT (id) DO UPDATE SET description = excluded.description`,
      ).bind(parsed.name, parsed.name, parsed.description),
      env.DB.prepare(
        `INSERT INTO skill_files (skill_id, path, content) VALUES (?,'SKILL.md',?)
         ON CONFLICT (skill_id, path) DO UPDATE SET content = excluded.content`,
      ).bind(parsed.name, parsed.body),
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function listSkills(env: Env): Promise<SkillRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM skills ORDER BY status, name`).all<SkillRow>();
  return results ?? [];
}

/**
 * The Manifests that sit in every system prompt. Only approved Skills, and
 * only name + description -- the body loads on demand (ADR-0001).
 */
export async function loadManifests(env: Env): Promise<{ name: string; description: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, description FROM skills WHERE status = 'approved' ORDER BY name`,
  ).all<{ name: string; description: string }>();
  return results ?? [];
}

/**
 * Resolves a Skill name the way a human means it rather than the way they
 * typed it.
 *
 * Real failure that motivated this: a Skill named `diagram-design` invoked as
 * `/design-diagram`. Exact matching returned nothing, the invocation silently
 * did nothing, and the model then retried `load_skill` with the bad name until
 * the repeated-call cap killed the Turn. Word order and separators are not
 * worth losing a Turn over.
 *
 * Returns the matched id, plus a suggestion when nothing matched well enough.
 */
export async function resolveSkillName(
  env: Env,
  query: string,
): Promise<{ id: string | null; suggestion: string | null; available: string[] }> {
  const names = (await loadManifests(env)).map((m) => m.name);
  const q = query.toLowerCase().trim();

  // Order-insensitive key: "design-diagram" and "diagram-design" collapse to
  // the same thing, as do underscore and space separated variants.
  const key = (s: string) => s.toLowerCase().split(/[-_\s]+/).filter(Boolean).sort().join("-");
  const qKey = key(q);

  const exact = names.find((n) => n.toLowerCase() === q);
  if (exact) return { id: exact, suggestion: null, available: names };

  const reordered = names.find((n) => key(n) === qKey);
  if (reordered) return { id: reordered, suggestion: null, available: names };

  const partial = names.filter((n) => n.includes(q) || q.includes(n));
  if (partial.length === 1) return { id: partial[0], suggestion: null, available: names };

  // Nothing confident enough to act on. Offer the nearest name instead of
  // silently doing nothing.
  const overlap = (n: string) => {
    const a = new Set(q.split(/[-_\s]+/));
    return n.split(/[-_\s]+/).filter((t) => a.has(t)).length;
  };
  const best = [...names].sort((a, b) => overlap(b) - overlap(a))[0];
  return { id: null, suggestion: best && overlap(best) > 0 ? best : null, available: names };
}

export async function loadSkillBody(env: Env, name: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT f.content FROM skill_files f
       JOIN skills s ON s.id = f.skill_id
      WHERE s.id = ? AND s.status = 'approved' AND f.path = 'SKILL.md'`,
  )
    .bind(name.toLowerCase())
    .first<{ content: string }>();
  if (!row) return null;

  const extras = await env.DB.prepare(
    `SELECT path FROM skill_files WHERE skill_id = ? AND path != 'SKILL.md' ORDER BY path`,
  )
    .bind(name.toLowerCase())
    .all<{ path: string }>();

  const bundled = (extras.results ?? []).map((r) => r.path);
  return bundled.length
    ? `${row.content}\n\n---\nBundled files available in this Skill: ${bundled.join(", ")}. Ask for one by name if needed.`
    : row.content;
}

export async function approveSkill(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE skills SET status = 'approved', approved_at = unixepoch() WHERE id = ? AND origin = 'github'`,
  )
    .bind(id.toLowerCase())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function deleteSkill(env: Env, id: string): Promise<boolean> {
  // Preloaded Skills are part of the build; deleting one would just come back
  // on the next sync, so refuse rather than pretend.
  const res = await env.DB.batch([
    env.DB.prepare(`DELETE FROM skill_files WHERE skill_id = (SELECT id FROM skills WHERE id = ? AND origin = 'github')`).bind(id.toLowerCase()),
    env.DB.prepare(`DELETE FROM skills WHERE id = ? AND origin = 'github'`).bind(id.toLowerCase()),
  ]);
  return (res[1].meta?.changes ?? 0) > 0;
}

// ---- GitHub install ----

interface GithubTarget {
  owner: string;
  repo: string;
  ref?: string;
  subpath?: string;
}

export function parseGithubUrl(input: string): GithubTarget | null {
  const cleaned = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/.exec(cleaned);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3], subpath: m[4]?.replace(/\/SKILL\.md$/i, "") };
}

export interface InstallResult {
  ok: boolean;
  /** Populated when the repo holds several Skills and the Operator must choose. */
  choices?: string[];
  skill?: { id: string; name: string; description: string; body: string };
  error?: string;
}

export async function installFromGithub(env: Env, url: string): Promise<InstallResult> {
  const target = parseGithubUrl(url);
  if (!target) return { ok: false, error: "Not a recognised GitHub URL. Expected https://github.com/owner/repo[/tree/ref/path]." };

  const api = `https://api.github.com/repos/${target.owner}/${target.repo}/tarball${target.ref ? `/${target.ref}` : ""}`;
  const headers: Record<string, string> = {
    "user-agent": "simple-lite-cloudaiharness/1.0",
    accept: "application/vnd.github+json",
  };
  // Optional: lets private repos and a higher rate limit work if the secret exists.
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const res = await fetch(api, { headers, redirect: "follow" });
  if (!res.ok) {
    return {
      ok: false,
      error: `GitHub returned ${res.status}${res.status === 404 ? " (repo, branch or path not found, or it is private)" : ""}.`,
    };
  }

  let entries;
  try {
    entries = readTar(await gunzip(await res.arrayBuffer()));
  } catch (e: any) {
    return { ok: false, error: `Could not read the repository archive: ${String(e?.message ?? e)}` };
  }

  // Every path in a GitHub tarball is prefixed with `{repo}-{sha}/`.
  const stripped = entries.map((e) => ({ ...e, path: e.path.split("/").slice(1).join("/") }));
  const manifests = stripped.filter((e) => /(^|\/)SKILL\.md$/i.test(e.path));
  if (!manifests.length) return { ok: false, error: "No SKILL.md found in that repository." };

  let chosen = manifests[0];
  if (target.subpath) {
    const wanted = manifests.find((e) => e.path.toLowerCase() === `${target.subpath!.toLowerCase()}/skill.md`);
    if (!wanted) {
      return { ok: false, error: `No SKILL.md at ${target.subpath}. Found: ${manifests.map((m) => m.path).join(", ")}` };
    }
    chosen = wanted;
  } else if (manifests.length > 1) {
    // A collection repo. Installing all of them silently would be a surprise.
    return { ok: false, choices: manifests.map((m) => m.path.replace(/\/?SKILL\.md$/i, "") || "."), error: "This repository contains several Skills. Re-install with the URL of the one you want." };
  }

  const parsed = parseSkill(chosen.content);
  if (!parsed) return { ok: false, error: "SKILL.md is missing valid frontmatter with `name` and `description`." };

  const folder = chosen.path.replace(/\/?SKILL\.md$/i, "");
  const bundled = stripped
    .filter((e) => e.path !== chosen.path && (folder ? e.path.startsWith(`${folder}/`) : true) && !/(^|\/)SKILL\.md$/i.test(e.path))
    .slice(0, MAX_BUNDLED_FILES);

  // Installed as 'pending'. A Skill body is instructions the model will obey,
  // so nothing reaches a prompt before the Operator has read it (ADR-0001).
  const statements = [
    env.DB.prepare(
      `INSERT INTO skills (id, name, description, origin, source_url, source_ref, status, installed_at)
       VALUES (?,?,?,'github',?,?, 'pending', unixepoch())
       ON CONFLICT (id) DO UPDATE SET
         description = excluded.description,
         source_url  = excluded.source_url,
         source_ref  = excluded.source_ref,
         status      = 'pending',
         approved_at = NULL,
         installed_at = unixepoch()`,
    ).bind(parsed.name, parsed.name, parsed.description, url, target.ref ?? null),
    env.DB.prepare(`DELETE FROM skill_files WHERE skill_id = ?`).bind(parsed.name),
    env.DB.prepare(`INSERT INTO skill_files (skill_id, path, content) VALUES (?,'SKILL.md',?)`).bind(parsed.name, parsed.body),
    ...bundled.map((f) =>
      env.DB.prepare(`INSERT OR IGNORE INTO skill_files (skill_id, path, content) VALUES (?,?,?)`).bind(
        parsed.name,
        folder ? f.path.slice(folder.length + 1) : f.path,
        f.content,
      ),
    ),
  ];
  await env.DB.batch(statements);

  return { ok: true, skill: { id: parsed.name, name: parsed.name, description: parsed.description, body: parsed.body } };
}
