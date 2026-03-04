-- Cloudflare D1 Schema for Video Affiliate Auto-Post System
-- Created: 2026-02-06

-- Facebook Pages Table
CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_url TEXT,
    access_token TEXT NOT NULL,
    comment_token TEXT,
    post_interval_minutes INTEGER DEFAULT 60,
    bot_id TEXT DEFAULT 'default',
    post_hours TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    last_post_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Post Queue Table (Videos scheduled to be posted)
CREATE TABLE IF NOT EXISTS post_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    bot_id TEXT DEFAULT 'default', -- pending, processing, completed, failed
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

-- Post History Table (Completed posts)
CREATE TABLE IF NOT EXISTS post_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    fb_post_id TEXT,
    fb_reel_url TEXT,
    shopee_link TEXT,
    posted_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'success',
    bot_id TEXT DEFAULT 'default', -- success, failed
    error_message TEXT,
    comment_status TEXT DEFAULT 'not_configured', -- success, failed, pending, skipped, not_attempted, not_configured
    comment_token_hint TEXT,
    comment_error TEXT,
    comment_fb_id TEXT,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

-- Settings Table (Global settings)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_post_queue_status ON post_queue(status);
CREATE INDEX IF NOT EXISTS idx_post_queue_scheduled ON post_queue(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_post_history_page ON post_history(page_id);
CREATE INDEX IF NOT EXISTS idx_post_history_posted ON post_history(posted_at);
CREATE INDEX IF NOT EXISTS idx_pages_active ON pages(is_active);

-- Initial Settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('default_interval', '60');
INSERT OR IGNORE INTO settings (key, value) VALUES ('max_posts_per_day', '48');


-- Create table for allowed Telegram Users
CREATE TABLE IF NOT EXISTS allowed_users (
    telegram_id INTEGER PRIMARY KEY,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Email-based auth tables
CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  session_token TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_namespaces (
  email TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_namespaces_namespace ON email_namespaces(namespace_id);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token);
