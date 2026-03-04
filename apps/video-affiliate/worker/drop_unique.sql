CREATE TABLE users_new (
  telegram_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  session_token TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO users_new SELECT * FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token);
