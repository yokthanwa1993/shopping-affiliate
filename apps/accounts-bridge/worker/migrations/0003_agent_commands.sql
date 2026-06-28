-- Accounts Bridge v2 — agent command queue + agent heartbeat
--
-- This adds the "cloud-backed Mac Agent launcher" control plane. The cloud dashboard enqueues a
-- non-secret COMMAND (open_profile / close_profile / sync_accounts / status); a local Mac agent
-- (apps/facebook-token-cloak) polls its queue, runs the command against its OWN browser/profile,
-- and reports a non-secret RESULT. The Worker is still a pure DB API — it never opens a browser,
-- mints a token, or fills credentials. It only stores queue state and agent heartbeats.
--
-- SECRET POLICY (unchanged): neither payload_json nor result_json may contain secret material.
-- The API layer rejects secret-looking keys/values before any row is written, so a token/cookie/
-- password/datr/fb_dtsg can never land here even by mistake. error_message is sanitized + truncated.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- agents — one row per local Mac agent, heartbeat + last-seen + non-secret detail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  label        TEXT,
  status       TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'idle', 'busy', 'error', 'offline')),
  detail       TEXT,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- agent_commands — the durable command queue. payload_json / result_json are
-- NON-SECRET JSON only (enforced by the API). Status walks a fixed lifecycle:
--   queued -> running (claimed by a poll) -> succeeded | failed | cancelled
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_commands (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('open_profile', 'close_profile', 'sync_accounts', 'status')),
  platform      TEXT CHECK (platform IN ('facebook', 'shopee')),
  role          TEXT CHECK (role IN ('page_posting_facebook_lite', 'ads_power_editor')),
  account_uid   TEXT,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload_json  TEXT,
  result_json   TEXT,
  error_code    TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  claimed_at    TEXT,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_commands_queue ON agent_commands (agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_commands_created ON agent_commands (created_at);
