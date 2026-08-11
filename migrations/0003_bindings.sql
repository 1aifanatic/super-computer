-- Workspace Bindings (M5).
--
-- One repository per Workspace. `dir` is where the working tree lives inside
-- the Workspace filesystem, recorded rather than derived so a later rename of
-- the convention cannot orphan an existing Binding.

CREATE TABLE IF NOT EXISTS workspace_bindings (
  workspace_id TEXT PRIMARY KEY,
  repo_url     TEXT NOT NULL,
  ref          TEXT,
  dir          TEXT NOT NULL,
  bound_at     INTEGER NOT NULL,
  last_push_at INTEGER
);
