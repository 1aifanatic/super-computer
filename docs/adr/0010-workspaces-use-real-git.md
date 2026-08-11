---
status: accepted — supersedes ADR-0003
---

# Workspaces use real git, not file sync

A Workspace binds to a GitHub repository by cloning it with a real git implementation, and keeps real history: commits, branches, diffs and log. This replaces ADR-0003's file-sync model entirely.

ADR-0003 reasoned from a true premise to a wrong conclusion. It is correct that the execution backend has no `git` *binary* — but `@cloudflare/computer` ships a full isomorphic-git client, and configuring it as `WorkspaceOptions.git` does two things at once: it exposes a client over RPC, and it enables the shell's `git` command, so the agent reaches git through the `bash` tool it already had. No new tool was needed.

Verified end to end on 2026-08-11 against `github.com/octocat/Hello-World`: clone succeeded and carried genuine upstream history (`7fd1a60 Merge pull request #6…`), the agent edited a file through its own shell, `git status` reported `1 M README`, `git diff` produced a correct unified diff, and `add` + `commit` stacked a new commit onto real history.

## Consequences

The file-sync tarpit is gone — no re-importing when the repo changes elsewhere, and branch-aware workflows become possible.

**HTTPS only.** isomorphic-git has no SSH transport, so `git@github.com:...` URLs are rejected at the API boundary with a message saying why.

**Credentials never touch the Workspace.** The CLI surface does not expose isomorphic-git's `onAuth` callback, so the token is injected as URL userinfo for the duration of a single operation and is never written to `.git/config`. If it were persisted, the model could read it back out of the filesystem it operates on.

**Push is implemented but unverified.** It requires `GITHUB_TOKEN` and a repository the Operator can write to; neither existed at the time of building. Clone, status, diff, add and commit are all confirmed working. Treat push as untested until it has run once for real.

Two statements elsewhere became false the moment this landed and were corrected: the system prompt and the `bash` tool description both told the model it could not use git, and `skill-author` taught the same thing to every future Skill.
