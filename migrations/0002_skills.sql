-- Skills (ADR-0001): folders in the open Agent Skills format.
--
-- Operator-global, not per-Workspace: an install is done once. Bytes live in
-- D1 because Skills are small markdown and Manifests must be queryable anyway;
-- adding R2 for a few kilobytes of text would be ceremony.

CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,      -- slug, from frontmatter `name`
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,         -- the half of the Manifest that does the work
  origin       TEXT NOT NULL CHECK (origin IN ('preloaded', 'github')),
  source_url   TEXT,                  -- the GitHub URL as the Operator gave it
  source_ref   TEXT,                  -- branch or tag actually fetched
  -- A Skill body is instructions the model will obey, so an unapproved Skill
  -- is a prompt-injection vector wearing a helpful hat. Nothing reaches a
  -- prompt until the Operator has read it and approved it.
  status       TEXT NOT NULL CHECK (status IN ('pending', 'approved')) DEFAULT 'pending',
  installed_at INTEGER NOT NULL,
  approved_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status, name);

CREATE TABLE IF NOT EXISTS skill_files (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path     TEXT NOT NULL,             -- relative to the Skill folder, e.g. SKILL.md
  content  TEXT NOT NULL,
  PRIMARY KEY (skill_id, path)
);
