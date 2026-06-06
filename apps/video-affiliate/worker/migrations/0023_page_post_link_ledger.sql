-- Durable per-page-story ledger for the comment-link rewrite workflow.
-- Unlike page_comment_link_registry (PK page_id, fb_video_id), this mints a
-- stable AUTOINCREMENT numeric `id` keyed by (page_id, comment_target_id) so
-- EVERY rewrite target — including cache/manual/imported posts that have no
-- post_history.id — receives a non-empty target_sub4/log_id. An empty slot 4
-- minted utm_content = `<sub1>-<sub2>-<sub3>--` (the 2026-05-16 production
-- defect). Practical metadata columns (new_*, target_sub1..4, status,
-- last_rewrite_at, last_verified_at) make the row a self-contained audit trail.
-- No secrets/tokens are stored here.

CREATE TABLE IF NOT EXISTS page_post_link_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    comment_target_id TEXT NOT NULL DEFAULT '',
    page_story_object_id TEXT NOT NULL DEFAULT '',
    fb_video_id TEXT NOT NULL DEFAULT '',
    reel_id TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL DEFAULT '',
    comment_id TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    old_shortlink TEXT NOT NULL DEFAULT '',
    new_shortlink TEXT NOT NULL DEFAULT '',
    old_utm_content TEXT NOT NULL DEFAULT '',
    new_utm_content TEXT NOT NULL DEFAULT '',
    old_affiliate_id TEXT NOT NULL DEFAULT '',
    new_affiliate_id TEXT NOT NULL DEFAULT '',
    target_sub1 TEXT NOT NULL DEFAULT '',
    target_sub2 TEXT NOT NULL DEFAULT '',
    target_sub3 TEXT NOT NULL DEFAULT '',
    target_sub4 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    last_audited_at TEXT NOT NULL DEFAULT '',
    last_rewrite_at TEXT NOT NULL DEFAULT '',
    last_verified_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_page_post_link_ledger_key
ON page_post_link_ledger(page_id, comment_target_id);
