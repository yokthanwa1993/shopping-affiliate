-- Migration: add BrowserSaving auth/session + profile ownership scoping

ALTER TABLE profiles ADD COLUMN owner_email TEXT;
CREATE INDEX IF NOT EXISTS idx_profiles_owner_email ON profiles(owner_email);

CREATE TABLE IF NOT EXISTS bs_users (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bs_sessions (
    token TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_email) REFERENCES bs_users(email) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bs_sessions_user_email ON bs_sessions(user_email);
CREATE INDEX IF NOT EXISTS idx_bs_sessions_expires_at ON bs_sessions(expires_at);
