-- Safe full workflow for rewriting the Shopee shortlink inside Page/Reel
-- comments (CHEARB page). Three tables with history-safe columns:
--   page_comment_link_registry  — durable per-item audit snapshot
--   page_comment_link_jobs      — one rewrite batch (dry_run + safety knobs)
--   page_comment_link_job_items — per-comment plan/result, keeps old_message /
--                                 old_shortlink for rollback & history
-- No secrets/tokens are stored here.

CREATE TABLE IF NOT EXISTS page_comment_link_registry (
    page_id TEXT NOT NULL,
    fb_video_id TEXT NOT NULL,
    reel_id TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL DEFAULT '',
    canonical_post_id TEXT NOT NULL DEFAULT '',
    comment_target_id TEXT NOT NULL DEFAULT '',
    comment_id TEXT NOT NULL DEFAULT '',
    comment_from_id TEXT NOT NULL DEFAULT '',
    comment_from_name TEXT NOT NULL DEFAULT '',
    old_message TEXT NOT NULL DEFAULT '',
    old_shortlink TEXT NOT NULL DEFAULT '',
    old_expanded_url TEXT NOT NULL DEFAULT '',
    old_utm_content TEXT NOT NULL DEFAULT '',
    old_sub1 TEXT NOT NULL DEFAULT '',
    old_sub2 TEXT NOT NULL DEFAULT '',
    old_sub3 TEXT NOT NULL DEFAULT '',
    old_sub4 TEXT NOT NULL DEFAULT '',
    old_sub5 TEXT NOT NULL DEFAULT '',
    product_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    last_audited_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (page_id, fb_video_id)
);

CREATE INDEX IF NOT EXISTS idx_page_comment_link_registry_page
ON page_comment_link_registry(page_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS page_comment_link_jobs (
    job_id TEXT NOT NULL PRIMARY KEY,
    page_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'created',
    dry_run INTEGER NOT NULL DEFAULT 1,
    batch_size INTEGER NOT NULL DEFAULT 5,
    stop_on_first_error INTEGER NOT NULL DEFAULT 1,
    requested_sub1 TEXT NOT NULL DEFAULT '',
    customlink_id TEXT NOT NULL DEFAULT '',
    total_items INTEGER NOT NULL DEFAULT 0,
    planned_items INTEGER NOT NULL DEFAULT 0,
    skipped_items INTEGER NOT NULL DEFAULT 0,
    done_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_page_comment_link_jobs_page
ON page_comment_link_jobs(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS page_comment_link_job_items (
    job_id TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    page_id TEXT NOT NULL,
    fb_video_id TEXT NOT NULL DEFAULT '',
    reel_id TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL DEFAULT '',
    canonical_post_id TEXT NOT NULL DEFAULT '',
    comment_target_id TEXT NOT NULL DEFAULT '',
    old_comment_id TEXT NOT NULL DEFAULT '',
    new_comment_id TEXT NOT NULL DEFAULT '',
    comment_from_id TEXT NOT NULL DEFAULT '',
    comment_from_name TEXT NOT NULL DEFAULT '',
    old_message TEXT NOT NULL DEFAULT '',
    new_message TEXT NOT NULL DEFAULT '',
    old_shortlink TEXT NOT NULL DEFAULT '',
    old_expanded_url TEXT NOT NULL DEFAULT '',
    old_utm_content TEXT NOT NULL DEFAULT '',
    old_sub1 TEXT NOT NULL DEFAULT '',
    old_sub2 TEXT NOT NULL DEFAULT '',
    old_sub3 TEXT NOT NULL DEFAULT '',
    old_sub4 TEXT NOT NULL DEFAULT '',
    old_sub5 TEXT NOT NULL DEFAULT '',
    product_url TEXT NOT NULL DEFAULT '',
    target_sub1 TEXT NOT NULL DEFAULT '',
    target_sub2 TEXT NOT NULL DEFAULT '',
    target_sub3 TEXT NOT NULL DEFAULT '',
    new_shortlink TEXT NOT NULL DEFAULT '',
    new_expanded_url TEXT NOT NULL DEFAULT '',
    new_utm_content TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    reason TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_audited_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (job_id, item_index)
);
