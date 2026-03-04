-- Migration number: 0001 	 2026-02-22T13:50:05.410Z

-- Add bot_id to tables
ALTER TABLE pages ADD COLUMN bot_id TEXT DEFAULT 'default';
ALTER TABLE post_queue ADD COLUMN bot_id TEXT DEFAULT 'default';
ALTER TABLE post_history ADD COLUMN bot_id TEXT DEFAULT 'default';

-- Create table for allowed Telegram Users
CREATE TABLE IF NOT EXISTS allowed_users (
    telegram_id INTEGER PRIMARY KEY,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_pages_bot_id ON pages(bot_id);
CREATE INDEX IF NOT EXISTS idx_post_queue_bot_id ON post_queue(bot_id);
CREATE INDEX IF NOT EXISTS idx_post_history_bot_id ON post_history(bot_id);

