-- Allow 1 email to login from multiple Telegram accounts
-- Remove UNIQUE constraint on email by recreating the table

CREATE TABLE IF NOT EXISTS users_new (
  telegram_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  session_token TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO users_new (telegram_id, email, namespace_id, session_token, created_at)
  SELECT telegram_id, email, namespace_id, session_token, created_at FROM users WHERE telegram_id IS NOT NULL;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token);
