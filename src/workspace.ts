import { withWorkspace } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createGitClient } from "@cloudflare/computer/git";
import jqModules from "@cloudflare/computer/shell/jq";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * A Workspace: a persistent filesystem that many Conversations attach to.
 *
 * Deliberately thin. Callers reach the filesystem and shell through
 * `getWorkspace(stub)` rather than through methods here, which is the shape
 * @cloudflare/computer is built around and the one Spike A verified live.
 *
 * Feature groups are opt-in and only `jq` is loaded: Spike A proved `python`
 * and `sqlite` ship their JavaScript wrappers with no compiled runtime behind
 * them, so importing either only inflates the bundle. See ADR-0002.
 */
export class WorkspaceDO extends withWorkspace(
  class extends DurableObject<Env> {},
  (self: any) => ({
    storage: self.ctx.storage,
    // Configuring git does two things at once: it exposes a full client over
    // RPC *and* it turns on the shell's `git` command, so the agent reaches
    // real git through the bash tool it already has. isomorphic-git under the
    // hood, so HTTPS only -- there is no SSH transport.
    git: createGitClient(),
    defaultGitIdentity: { name: "AI Coding Harness", email: "harness@users.noreply.github.com" },
    backends: [
      new WorkerShellBackend({
        loader: self.env.LOADER,
        workspace: { binding: "WORKSPACE", id: self.ctx.id.toString() },
        ctx: self.ctx,
        commands: [jqModules],
      }),
    ],
  }),
) {}
