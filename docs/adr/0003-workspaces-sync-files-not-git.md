---
status: superseded by ADR-0010
---

> **Superseded on 2026-08-11 by [ADR-0010](./0010-workspaces-use-real-git.md).** The premise below — no `git` binary — is true, but the conclusion drawn from it was wrong: `@cloudflare/computer` ships a full isomorphic-git client, and real git was verified working end to end. Kept for the reasoning trail.

# A Workspace syncs files with GitHub; it does not do git

A Workspace is a named, persistent filesystem owned by one Durable Object, and many Conversations attach to it — the Workspace is the durable thing, Conversations are disposable. A Workspace may bind to a GitHub repository, importing it by fetching a tarball and exporting changes as commits through the GitHub API.

There is no git. The execution backend has no `git` binary, so the binding is deliberately file sync: no branches, no history, no merges, no conflict resolution. If the repository changes elsewhere, the Operator re-imports. We rejected emulating git semantics on top of the GitHub API because a shallow model that is honestly shallow is safer than one that is subtly wrong about history.

## Consequences

Concurrent editing outside the Harness is an unhandled case that the Operator must manage by re-importing. Anything requiring branch-aware workflow belongs outside this tool.

## Challenged by Spike A (2026-08-11)

The premise of this ADR — "the execution backend has no `git` binary" — is true but misleading, and the conclusion drawn from it may be wrong.

`@cloudflare/computer` ships a full JavaScript git client at `@cloudflare/computer/git`, wired in by passing `createGitClient()` as `WorkspaceOptions.git`. Its exported surface includes `clone`, `commit`, `branch`, `checkout`, `merge`, `push`, `pull`, `fetch`, `tag`, `stash`, `diff`, `log`, `status`, `add`, `rm`, `reset`, `revParse`, `lsTree`, `catFile`, remote management, and auth callbacks. The spike confirmed it is reachable: `git --version` in the shell fails with *"Workspace git is not configured. Import createGitClient from @cloudflare/computer/git"* — a configuration error, not an absence.

That is real git with real history, not file sync. If adopted, this ADR's central trade-off disappears and Bindings gain branches, history, and merges. Not yet tested end-to-end against a real GitHub remote, and it is preview software, so the capability is credible but unproven.

**This decision is the Operator's and has not been made.** Until it is, the file-sync model above stands.
