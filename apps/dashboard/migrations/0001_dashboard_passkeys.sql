-- Dashboard passkey identity tables.
-- Bound on the shared video-affiliate D1 database so future Mini App migration
-- can reuse the same users/credentials. Each table is idempotent (IF NOT EXISTS)
-- so this file can be re-applied safely.

CREATE TABLE IF NOT EXISTS dashboard_passkey_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  workspace_name TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_users_email
  ON dashboard_passkey_users(email);
CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_users_namespace
  ON dashboard_passkey_users(namespace_id);

CREATE TABLE IF NOT EXISTS dashboard_passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_credentials_user
  ON dashboard_passkey_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_credentials_namespace
  ON dashboard_passkey_credentials(namespace_id);

CREATE TABLE IF NOT EXISTS dashboard_passkey_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_challenges_expires
  ON dashboard_passkey_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_challenges_user
  ON dashboard_passkey_challenges(user_id);

CREATE TABLE IF NOT EXISTS dashboard_passkey_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_sessions_user
  ON dashboard_passkey_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_passkey_sessions_expires
  ON dashboard_passkey_sessions(expires_at);

-- Bootstrap user row: id matches the shared workspace namespace so admin/UX
-- code that already references CHIEB_NAMESPACE_ID resolves to the same id.
INSERT OR IGNORE INTO dashboard_passkey_users (
  id, email, display_name, workspace_name, namespace_id
) VALUES (
  '1774858894802785816',
  NULL,
  'YOK',
  'PUBILO',
  '1774858894802785816'
);
