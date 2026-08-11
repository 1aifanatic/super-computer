-- M1 schema.
--
-- D1 is the read model, never the write path for a live Conversation (ADR-0006):
-- the Conversation Durable Object owns a Turn while it runs and flushes it here
-- once it completes. Everything in this file is either Operator-global data that
-- never belonged in a single Durable Object, or a completed record.

CREATE TABLE IF NOT EXISTS operators (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- A Model Profile is how a provider gets added: a row, not a code change
-- (ADR-0005). `secret_name` names a Worker secret; the credential itself is
-- never stored here, so a leak of this table costs nothing.
CREATE TABLE IF NOT EXISTS model_profiles (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  provider_kind     TEXT NOT NULL CHECK (provider_kind IN ('openai_compatible', 'workers_ai')),
  base_url          TEXT,
  secret_name       TEXT,
  model_id          TEXT NOT NULL,
  price_in_per_mtok  REAL NOT NULL DEFAULT 0,
  price_out_per_mtok REAL NOT NULL DEFAULT 0,
  price_cached_per_mtok REAL NOT NULL DEFAULT 0,
  is_default        INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  operator_id  TEXT NOT NULL REFERENCES operators(id),
  title        TEXT NOT NULL DEFAULT 'New conversation',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_ws ON conversations(workspace_id, updated_at DESC);

-- One row per completed Turn, flushed by the Durable Object. `cached_tokens` is
-- stored separately on purpose: it is the visible signal that ADR-0007's frozen
-- prompt prefix is still intact. If it collapses to zero, someone broke it.
CREATE TABLE IF NOT EXISTS turns (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id),
  seq              INTEGER NOT NULL,
  operator_message TEXT NOT NULL,
  assistant_message TEXT,
  model_profile_id TEXT REFERENCES model_profiles(id),
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  stop_reason      TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id, seq);

-- Two providers from row one, which is the point: ADR-0005 claims adding a
-- provider is a data change, and a schema with only one profile would never
-- prove it. MiniMax M2.7 is the Default Profile; endpoint, model id and prices
-- are the values verified live on 2026-08-11.
INSERT OR IGNORE INTO model_profiles
  (id, label, provider_kind, base_url, secret_name, model_id,
   price_in_per_mtok, price_out_per_mtok, price_cached_per_mtok,
   is_default, enabled, created_at)
VALUES
  ('minimax-m2.7', 'MiniMax M2.7', 'openai_compatible',
   'https://api.minimax.io/v1', 'MINIMAX_API_KEY', 'MiniMax-M2.7',
   0.30, 1.20, 0.06, 1, 1, unixepoch()),
  ('workers-ai-gpt-oss-120b', 'Workers AI / gpt-oss-120b', 'workers_ai',
   NULL, NULL, '@cf/openai/gpt-oss-120b',
   0, 0, 0, 0, 1, unixepoch());
