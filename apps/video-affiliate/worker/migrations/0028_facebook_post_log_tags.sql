-- Migration number: 0028   2026-07-01T00:00:00.000Z
-- Facebook post log hashtag ledger.
--
-- Every NEW visible Facebook Page post (force-post + cron page-posting path) gets a short
-- unique log hashtag appended to its caption (e.g. `#f2skgi`). This table is the reverse
-- lookup: given the tag/code, an operator/CGO/Hermes can retrieve all token-free details
-- and logs for that post — page, story/post/video ids, caption before/after, shopee/original
-- link, shortlink, comment link, sub ids, posting/comment source, status/error, and a safe
-- snapshot JSON.
--
-- This is INTENTIONALLY separate from create-ad-only (dark-story ads); only real visible
-- page posts get logged here. Idempotent: log_code is UNIQUE so collisions are retried at
-- insert time, and the row is upserted on log_code as the post succeeds/fails. Runtime also
-- ensures this table idempotently via ensureFacebookPostLogTagsTable, mirroring the existing
-- Worker "ensure table/columns" pattern.
--
-- NEVER stores tokens/cookies/fb_dtsg/passwords/API keys — snapshot_json/sub_ids are stripped
-- of secret-shaped keys before write (see worker/src/post-log-tag.ts sanitizeSnapshot).

CREATE TABLE IF NOT EXISTS facebook_post_log_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_code TEXT NOT NULL,
    hashtag TEXT NOT NULL DEFAULT '',
    bot_id TEXT NOT NULL DEFAULT '',
    namespace_id TEXT NOT NULL DEFAULT '',
    page_id TEXT NOT NULL DEFAULT '',
    page_name TEXT NOT NULL DEFAULT '',
    history_id INTEGER,
    story_id TEXT NOT NULL DEFAULT '',
    fb_post_id TEXT NOT NULL DEFAULT '',
    fb_video_id TEXT NOT NULL DEFAULT '',
    reel_id TEXT NOT NULL DEFAULT '',
    source_video_id TEXT NOT NULL DEFAULT '',
    system_video_id TEXT NOT NULL DEFAULT '',
    caption_before TEXT NOT NULL DEFAULT '',
    caption_after TEXT NOT NULL DEFAULT '',
    shopee_link TEXT NOT NULL DEFAULT '',
    original_link TEXT NOT NULL DEFAULT '',
    shortlink TEXT NOT NULL DEFAULT '',
    comment_link TEXT NOT NULL DEFAULT '',
    sub_ids TEXT NOT NULL DEFAULT '',
    posting_source TEXT NOT NULL DEFAULT '',
    comment_source TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    snapshot_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fb_post_log_tags_code
ON facebook_post_log_tags(log_code);

CREATE INDEX IF NOT EXISTS idx_fb_post_log_tags_page
ON facebook_post_log_tags(page_id);

CREATE INDEX IF NOT EXISTS idx_fb_post_log_tags_history
ON facebook_post_log_tags(history_id);

CREATE INDEX IF NOT EXISTS idx_fb_post_log_tags_namespace
ON facebook_post_log_tags(namespace_id);
