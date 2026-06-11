-- CHEARB Facebook Page post/comment inventory imported from Graph/Page export CSV.
-- Stores full page-story post_id (`<page_id>_<post_tail>`) and a derived tail for
-- joins/reporting. Import is idempotent on (page_id, post_id).

CREATE TABLE IF NOT EXISTS facebook_page_post_inventory (
    page_id TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL,
    post_id_tail TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    post_url TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    page_commented TEXT NOT NULL DEFAULT '',
    page_comment_id TEXT NOT NULL DEFAULT '',
    page_comment_link TEXT NOT NULL DEFAULT '',
    page_comment TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'graph_page_export_csv',
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (page_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_fb_page_post_inventory_page_date_time
ON facebook_page_post_inventory(page_id, date, time);

CREATE INDEX IF NOT EXISTS idx_fb_page_post_inventory_page_tail
ON facebook_page_post_inventory(page_id, post_id_tail);
