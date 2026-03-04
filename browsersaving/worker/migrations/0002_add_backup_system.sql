-- Migration: 0002_add_backup_system.sql
-- Adds soft-delete and automatic backup snapshots

-- 1. Add soft-delete column to profiles
ALTER TABLE profiles ADD COLUMN deleted_at TEXT DEFAULT NULL;

-- 2. Create backup snapshots table
-- Every update/delete creates a snapshot for recovery
CREATE TABLE IF NOT EXISTS profile_backups (
    backup_id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('update', 'delete')),
    snapshot TEXT NOT NULL, -- Full JSON snapshot of the profile at that point
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_backups_profile_id ON profile_backups(profile_id);
CREATE INDEX IF NOT EXISTS idx_backups_created_at ON profile_backups(created_at DESC);
