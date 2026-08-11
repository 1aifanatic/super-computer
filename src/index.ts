import { getWorkspace } from "@cloudflare/computer";
import { estimateCouncilCost } from "./council";
import { loadProfiles } from "./models";
import { approveSkill, deleteSkill, installFromGithub, listSkills, loadManifests, syncPreloaded } from "./skills";
import type { ChatMessage, Env } from "./types";

export { WorkspaceDO } from "./workspace";
export { ConversationDO } from "./conversation";

/**
 * The worker-shell backend spawns a Dynamic Worker that calls back into the
 * Workspace, resolving that callback through `ctx.exports` -- which only sees
 * named exports of the *entry* module. Without these two re-exports every
 * exec() throws "ctx.exports.WorkspaceServiceProxy is not a function".
 * Undocumented in @cloudflare/computer 0.2.0; found the hard way in Spike A.
 */
export { WorkspaceServiceProxy, WorkspaceProxy } from "@cloudflare/computer";

/**
 * Identity. Three modes, in order of preference:
 *
 *  - **Cloudflare Access** terminates upstream and hands us a verified email.
 *    This is the real door, costs no code, and is free below 50 users.
 *  - **A shared token**, when `HARNESS_BOOTSTRAP_TOKEN` is set. Exchanged once
 *    for an HttpOnly session cookie via /api/login.
 *  - **Open**, when neither is configured.
 *
 * Open mode is a deliberate choice by the Operator, not an oversight, so the
 * code permits it rather than failing closed. It does mean an unauthenticated
 * endpoint in front of a paid model, which is why `spendGuard` enforces the
 * monthly ceiling in code regardless of how the request authenticated.
 */
const SESSION_COOKIE = "harness_session";

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function authenticate(request: Request, env: Env): { email: string } | null {
  const accessEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (accessEmail) return { email: accessEmail };

  // No token configured means the Operator has chosen open access.
  const token = env.HARNESS_BOOTSTRAP_TOKEN;
  if (!token) return { email: "operator@open" };

  // Cookie first: it is what the browser uses, it is sent automatically on the
  // WebSocket upgrade, and being HttpOnly it is not readable by page scripts.
  // The header remains for curl and scripts. The `?token=` query parameter was
  // removed deliberately -- credentials in a URL end up in logs and referrers.
  const provided = readCookie(request, SESSION_COOKIE) ?? request.headers.get("x-harness-token");
  if (provided && timingSafeEqual(provided, token)) return { email: "operator@bootstrap" };
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Embeds the GitHub token in the URL for a single operation.
 *
 * isomorphic-git takes credentials through an `onAuth` callback that the CLI
 * surface does not expose, so URL userinfo is the available channel. Built per
 * call and never written to `.git/config`, so the token stays out of the
 * Workspace filesystem the model can read.
 */
function authedUrl(repoUrl: string, env: Env): string {
  if (!env.GITHUB_TOKEN) return repoUrl;
  return repoUrl.replace(/^https:\/\//, `https://x-access-token:${env.GITHUB_TOKEN}@`);
}

/** The month-to-date ceiling. Also reported to the UI as `cap_usd`. */
const MONTHLY_CAP_USD = 20;

/**
 * Hard spend ceiling, enforced in code.
 *
 * This was meant to live at AI Gateway, which does not exist yet, and it
 * matters more now that the Harness can run without a credential: an open
 * endpoint in front of a paid model needs a floor under the worst case. Checked
 * before a Turn starts, so the overshoot is bounded by one Turn.
 */
async function spendGuard(env: Env): Promise<Response | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM turns WHERE created_at >= unixepoch('now', 'start of month')`,
  ).first<{ total: number }>();
  const total = row?.total ?? 0;
  if (total < MONTHLY_CAP_USD) return null;
  return json(
    {
      error: `Monthly spend cap reached: $${total.toFixed(4)} of $${MONTHLY_CAP_USD}. Raise MONTHLY_CAP_USD to continue.`,
      month_to_date: total,
      cap_usd: MONTHLY_CAP_USD,
    },
    429,
  );
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // Exchange the bootstrap token for a session cookie, once. Everything
    // afterwards rides on the cookie, so the browser never holds the
    // credential in JavaScript-readable storage.
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { token } = (await request.json().catch(() => ({}))) as { token?: string };
      const expected = env.HARNESS_BOOTSTRAP_TOKEN;
      if (!expected) return json({ error: "HARNESS_BOOTSTRAP_TOKEN is not set on the Worker." }, 500);
      if (!token || !timingSafeEqual(token.trim(), expected)) return json({ error: "Incorrect token." }, 401);

      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(expected)}; Path=/; Max-Age=${60 * 60 * 24 * 90}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    // The UI shell is public; every endpoint that can spend money is not.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const operator = authenticate(request, env);
    if (!operator) {
      return json(
        {
          error: "Unauthorized",
          detail:
            "Provide a Cloudflare Access session, or an x-harness-token header matching HARNESS_BOOTSTRAP_TOKEN.",
        },
        401,
      );
    }

    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        // Cheap and guarded: makes Manifests exist before the first
        // Conversation even if the Operator never opens the Skills panel.
        await syncPreloaded(env);
        const profiles = await loadProfiles(env);
        const spend = await env.DB.prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS turns
             FROM turns WHERE created_at >= unixepoch('now', 'start of month')`,
        ).first<{ total: number; turns: number }>();

        return json({
          operator: operator.email,
          // Approved Skills ride along so the composer's "/" picker needs no
          // second request. Only approved ones: an unapproved Skill cannot be
          // invoked, so offering it would be a dead end.
          skills: await loadManifests(env),
          profiles: profiles.map((p) => ({
            id: p.id,
            label: p.label,
            is_default: !!p.is_default,
            price_in: p.price_in_per_mtok,
            price_out: p.price_out_per_mtok,
            price_cached: p.price_cached_per_mtok,
          })),
          month_to_date: { cost_usd: spend?.total ?? 0, turns: spend?.turns ?? 0, cap_usd: MONTHLY_CAP_USD },
        });
      }

      // WebSocket transport (ADR-0009: events, not tokens). Browsers cannot set
      // headers on a WebSocket, so the credential travels as ?token= and is
      // checked by the same authenticate() above before we ever upgrade.
      if (url.pathname === "/api/ws") {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) return json({ error: "conversationId is required" }, 400);
        const capped = await spendGuard(env);
        if (capped) return capped;
        const workspaceId = url.searchParams.get("workspaceId") || "default";

        await ensureRows(env, operator.email, workspaceId, conversationId);
        const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));
        await stub.setConversationId(conversationId);
        return stub.fetch(new Request("https://do/ws", request));
      }

      if (url.pathname === "/api/stop" && request.method === "POST") {
        const { conversationId } = (await request.json()) as { conversationId?: string };
        if (!conversationId) return json({ error: "conversationId is required" }, 400);
        const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));
        await stub.requestStop();
        return json({ ok: true });
      }

      if (url.pathname === "/api/turn-status" && request.method === "GET") {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) return json({ error: "conversationId is required" }, 400);
        const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));
        return json(await stub.getTurnStatus());
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        const body = (await request.json()) as {
          message?: string;
          conversationId?: string;
          workspaceId?: string;
          profileId?: string | null;
          council?: { memberIds: string[]; chairId: string } | null;
        };

        const message = (body.message ?? "").trim();
        if (!message) return json({ error: "message is required" }, 400);
        const capped = await spendGuard(env);
        if (capped) return capped;

        const workspaceId = body.workspaceId || "default";
        const conversationId = body.conversationId || crypto.randomUUID();

        await ensureRows(env, operator.email, workspaceId, conversationId);

        const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId));
        await stub.setConversationId(conversationId);
        // The Durable Object owns the Turn and flushes it to D1 itself
        // (ADR-0006). Writing the row here too would be the synchronous
        // dual-write that ADR explicitly rejects.
        const turn = await stub.runTurn({
          workspaceId,
          profileId: body.profileId ?? null,
          message,
          council: body.council ?? null,
        });

        return json({ conversationId, ...turn });
      }

      // ---- Workspace Binding (M5) ----
      //
      // Raw git passthrough. Deliberately thin: the git client is a real one,
      // so wrapping each subcommand in a bespoke endpoint would add surface
      // without adding capability.
      if (url.pathname === "/api/workspace/git" && request.method === "POST") {
        const body = (await request.json()) as { workspaceId?: string; argv?: string[]; cwd?: string };
        if (!body.argv?.length) return json({ error: "argv is required" }, 400);

        const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(body.workspaceId || "default"));
        using ws: any = await getWorkspace(stub as any);

        // Credentials never travel in the argv the caller supplies. A token in
        // a command string ends up in logs, traces and the model's context;
        // this injects it into the environment at the last moment instead.
        const gitEnv: Record<string, string> = {};
        if (env.GITHUB_TOKEN) {
          gitEnv.GIT_USERNAME = "x-access-token";
          gitEnv.GIT_PASSWORD = env.GITHUB_TOKEN;
          gitEnv.GITHUB_TOKEN = env.GITHUB_TOKEN;
        }

        const result = await ws.git.cli({ argv: body.argv, cwd: body.cwd ?? "/workspace", env: gitEnv });
        return json({
          argv: body.argv,
          exitCode: result.exitCode,
          stdout: String(result.stdout ?? "").slice(0, 20000),
          stderr: String(result.stderr ?? "").slice(0, 4000),
        });
      }

      /**
       * Serves a file out of the Workspace so work the agent produced can
       * actually leave it. Two modes: `download=1` streams the bytes as an
       * attachment (correct for binaries), otherwise the text is returned as
       * JSON for in-app preview.
       *
       * Model-generated HTML is never served as HTML from this origin -- it
       * would run as first-party script against our own API. Downloads go out
       * as octet-stream, and preview happens inside a sandboxed iframe.
       */
      if (url.pathname === "/api/workspace/file" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId") || "default";
        const path = url.searchParams.get("path") ?? "";
        if (!path.startsWith("/")) return json({ error: "path must be absolute" }, 400);

        const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
        using ws: any = await getWorkspace(stub as any);
        const filename = path.split("/").pop() || "download";

        try {
          if (url.searchParams.get("download") === "1") {
            const stream = await ws.fs.readFile(path);
            return new Response(stream, {
              headers: {
                "content-type": "application/octet-stream",
                "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
                "cache-control": "no-store",
              },
            });
          }
          const content = String(await ws.fs.readFile(path, "utf8"));
          return json({ path, filename, size: content.length, content });
        } catch (e: any) {
          return json({ error: `Could not read ${path}: ${String(e?.message ?? e).slice(0, 200)}` }, 404);
        }
      }

      if (url.pathname === "/api/workspace/binding" && request.method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId") || "default";
        const row = await env.DB.prepare(`SELECT * FROM workspace_bindings WHERE workspace_id = ?`)
          .bind(workspaceId)
          .first();
        return json({ binding: row ?? null, can_push: Boolean(env.GITHUB_TOKEN) });
      }

      if (url.pathname === "/api/workspace/bind" && request.method === "POST") {
        const body = (await request.json()) as { workspaceId?: string; repoUrl?: string; ref?: string };
        const workspaceId = body.workspaceId || "default";
        const repoUrl = (body.repoUrl ?? "").trim();
        if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repoUrl)) {
          return json({ error: "Expected an https://github.com/owner/repo URL. There is no SSH transport." }, 400);
        }

        const name = repoUrl.replace(/\.git$/, "").split("/").pop()!;
        const dir = `/workspace/${name}`;

        const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
        using ws: any = await getWorkspace(stub as any);

        const argv = ["clone", authedUrl(repoUrl, env), dir];
        if (body.ref) argv.splice(1, 0, "--branch", body.ref);
        const result = await ws.git.cli({ argv, cwd: "/workspace" });
        if (result.exitCode !== 0) {
          return json({ error: `clone failed: ${String(result.stderr || result.stdout).slice(0, 600)}` }, 400);
        }

        await env.DB.prepare(
          `INSERT INTO workspace_bindings (workspace_id, repo_url, ref, dir, bound_at)
           VALUES (?,?,?,?, unixepoch())
           ON CONFLICT (workspace_id) DO UPDATE SET
             repo_url = excluded.repo_url, ref = excluded.ref, dir = excluded.dir, bound_at = unixepoch()`,
        )
          .bind(workspaceId, repoUrl, body.ref ?? null, dir)
          .run();

        return json({ ok: true, dir, repoUrl });
      }

      if (url.pathname === "/api/workspace/push" && request.method === "POST") {
        const body = (await request.json()) as { workspaceId?: string; message?: string };
        const workspaceId = body.workspaceId || "default";
        const message = (body.message ?? "").trim() || "Changes from the AI Coding Harness";
        if (!env.GITHUB_TOKEN) {
          return json({ error: "GITHUB_TOKEN is not set. Run: wrangler secret put GITHUB_TOKEN" }, 400);
        }

        const binding = await env.DB.prepare(`SELECT * FROM workspace_bindings WHERE workspace_id = ?`)
          .bind(workspaceId)
          .first<{ dir: string; repo_url: string }>();
        if (!binding) return json({ error: "This Workspace is not bound to a repository." }, 400);

        const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
        using ws: any = await getWorkspace(stub as any);
        const run = async (argv: string[]) => ws.git.cli({ argv, cwd: binding.dir });

        const steps: { argv: string[]; exitCode: number; out: string }[] = [];
        for (const argv of [
          ["add", "."],
          ["commit", "-m", message],
          // The credential is injected into the remote URL at push time rather
          // than stored in .git/config, so it never lands in the Workspace
          // filesystem where the model could read it back.
          ["push", authedUrl(binding.repo_url, env)],
        ]) {
          const r = await run(argv);
          steps.push({ argv, exitCode: r.exitCode, out: String(r.stdout || r.stderr).slice(0, 800) });
          // "nothing to commit" is exit-nonzero but is not a failure worth aborting on.
          if (r.exitCode !== 0 && !/nothing to commit|no changes added/i.test(String(r.stdout) + String(r.stderr))) {
            return json({ ok: false, steps }, 400);
          }
        }

        await env.DB.prepare(`UPDATE workspace_bindings SET last_push_at = unixepoch() WHERE workspace_id = ?`)
          .bind(workspaceId)
          .run();
        return json({ ok: true, steps });
      }

      // ---- Model Profiles (ADR-0005) ----

      if (url.pathname === "/api/profiles" && request.method === "GET") {
        const { results } = await env.DB.prepare(`SELECT * FROM model_profiles ORDER BY is_default DESC, label`).all<
          Record<string, unknown>
        >();
        // A profile fails at call time when its secret is missing, which looks
        // like a mysterious provider error. Surfacing presence (never the
        // value) turns that into an obvious, fixable state in the UI.
        return json({
          profiles: (results ?? []).map((p) => ({
            ...p,
            secret_present: p.secret_name ? Boolean(env[p.secret_name as string]) : true,
          })),
        });
      }

      if (url.pathname === "/api/profiles/save" && request.method === "POST") {
        const p = (await request.json()) as Record<string, any>;
        if (!p.id || !p.label || !p.model_id) return json({ error: "id, label and model_id are required" }, 400);
        if (p.provider_kind !== "openai_compatible" && p.provider_kind !== "workers_ai") {
          return json({ error: "provider_kind must be openai_compatible or workers_ai" }, 400);
        }
        await env.DB.prepare(
          `INSERT INTO model_profiles
             (id, label, provider_kind, base_url, secret_name, model_id,
              price_in_per_mtok, price_out_per_mtok, price_cached_per_mtok, is_default, enabled, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,0,?, unixepoch())
           ON CONFLICT (id) DO UPDATE SET
             label = excluded.label, provider_kind = excluded.provider_kind,
             base_url = excluded.base_url, secret_name = excluded.secret_name,
             model_id = excluded.model_id,
             price_in_per_mtok = excluded.price_in_per_mtok,
             price_out_per_mtok = excluded.price_out_per_mtok,
             price_cached_per_mtok = excluded.price_cached_per_mtok,
             enabled = excluded.enabled`,
        )
          .bind(
            String(p.id).toLowerCase(),
            p.label,
            p.provider_kind,
            p.base_url ?? null,
            p.secret_name ?? null,
            p.model_id,
            Number(p.price_in_per_mtok ?? 0),
            Number(p.price_out_per_mtok ?? 0),
            Number(p.price_cached_per_mtok ?? 0),
            p.enabled === false ? 0 : 1,
          )
          .run();
        return json({ ok: true });
      }

      if (url.pathname === "/api/profiles/default" && request.method === "POST") {
        const { id } = (await request.json()) as { id?: string };
        if (!id) return json({ error: "id is required" }, 400);
        await env.DB.batch([
          env.DB.prepare(`UPDATE model_profiles SET is_default = 0`),
          env.DB.prepare(`UPDATE model_profiles SET is_default = 1, enabled = 1 WHERE id = ?`).bind(id),
        ]);
        return json({ ok: true });
      }

      if (url.pathname === "/api/profiles/delete" && request.method === "POST") {
        const { id } = (await request.json()) as { id?: string };
        if (!id) return json({ error: "id is required" }, 400);
        const row = await env.DB.prepare(`SELECT is_default FROM model_profiles WHERE id = ?`).bind(id).first<{ is_default: number }>();
        if (row?.is_default) return json({ ok: false, error: "Cannot delete the Default Profile. Make another profile default first." });
        await env.DB.prepare(`DELETE FROM model_profiles WHERE id = ?`).bind(id).run();
        return json({ ok: true });
      }

      // ---- Council (ADR-0004) ----

      if (url.pathname === "/api/council/estimate" && request.method === "POST") {
        const body = (await request.json()) as {
          conversationId?: string;
          message?: string;
          memberIds?: string[];
          chairId?: string;
        };
        const all = await loadProfiles(env);
        const members = (body.memberIds ?? []).map((id) => all.find((p) => p.id === id)).filter(Boolean) as typeof all;
        const chair = all.find((p) => p.id === body.chairId) ?? all.find((p) => p.is_default) ?? all[0];
        if (!members.length || !chair) return json({ error: "select at least one member and a chair" }, 400);

        let historyChars = 0;
        if (body.conversationId) {
          const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(body.conversationId));
          const history: ChatMessage[] = await stub.getHistory();
          historyChars = history.reduce((n: number, m: ChatMessage) => n + m.content.length, 0);
        }

        return json(
          estimateCouncilCost({
            // The frozen prefix is roughly this size once Manifests are in it.
            prefixChars: 2400,
            historyChars,
            questionChars: (body.message ?? "").length,
            members,
            chair,
          }),
        );
      }

      // ---- Skills (ADR-0001) ----

      if (url.pathname === "/api/skills" && request.method === "GET") {
        await syncPreloaded(env, true);
        return json({ skills: await listSkills(env) });
      }

      if (url.pathname === "/api/skills/install" && request.method === "POST") {
        const { url: repoUrl } = (await request.json()) as { url?: string };
        if (!repoUrl) return json({ error: "url is required" }, 400);
        const result = await installFromGithub(env, repoUrl);
        // Not an error the Operator caused -- the repo holds several Skills and
        // they need to pick. 409 rather than 400 so the UI can tell them apart.
        if (!result.ok) return json(result, result.choices ? 409 : 400);
        return json(result);
      }

      if (url.pathname === "/api/skills/approve" && request.method === "POST") {
        const { id } = (await request.json()) as { id?: string };
        if (!id) return json({ error: "id is required" }, 400);
        return json({ ok: await approveSkill(env, id) });
      }

      if (url.pathname === "/api/skills/delete" && request.method === "POST") {
        const { id } = (await request.json()) as { id?: string };
        if (!id) return json({ error: "id is required" }, 400);
        const ok = await deleteSkill(env, id);
        return json(ok ? { ok } : { ok, error: "Preloaded Skills ship with the build and cannot be deleted." });
      }

      if (url.pathname === "/api/skills/body" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "id is required" }, 400);
        // Reads the row directly rather than via loadSkillBody, which is
        // approved-only -- reviewing a pending Skill is the whole point.
        const row = await env.DB.prepare(
          `SELECT content FROM skill_files WHERE skill_id = ? AND path = 'SKILL.md'`,
        )
          .bind(id.toLowerCase())
          .first<{ content: string }>();
        if (!row) return json({ error: "not found" }, 404);
        const files = await env.DB.prepare(
          `SELECT path FROM skill_files WHERE skill_id = ? ORDER BY path`,
        )
          .bind(id.toLowerCase())
          .all<{ path: string }>();
        return json({ id, body: row.content, files: (files.results ?? []).map((f) => f.path) });
      }

      if (url.pathname === "/api/history" && request.method === "GET") {
        const id = url.searchParams.get("conversationId");
        if (!id) return json({ error: "conversationId is required" }, 400);
        const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
        return json({ conversationId: id, messages: await stub.getHistory() });
      }

      return json({ error: "Not found" }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 1200) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function ensureRows(env: Env, email: string, workspaceId: string, conversationId: string) {
  const operatorId = `op_${email}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO operators (id, email, created_at) VALUES (?,?, unixepoch())`).bind(
      operatorId,
      email,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO workspaces (id, operator_id, name, created_at) VALUES (?,?,?, unixepoch())`,
    ).bind(workspaceId, operatorId, workspaceId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO conversations (id, workspace_id, operator_id, created_at, updated_at)
       VALUES (?,?,?, unixepoch(), unixepoch())`,
    ).bind(conversationId, workspaceId, operatorId),
    env.DB.prepare(`UPDATE conversations SET updated_at = unixepoch() WHERE id = ?`).bind(conversationId),
  ]);
}
