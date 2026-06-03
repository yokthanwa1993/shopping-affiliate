CREATE TABLE IF NOT EXISTS processed_video_asset_library (
    namespace_id TEXT NOT NULL,
    system_video_id TEXT NOT NULL,
    ad_account TEXT NOT NULL,
    advideo_id TEXT NOT NULL DEFAULT '',
    advideo_status TEXT NOT NULL DEFAULT '',
    file_url TEXT NOT NULL DEFAULT '',
    upload_status TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    uploaded_at TEXT NOT NULL DEFAULT '',
    last_checked_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (namespace_id, system_video_id, ad_account)
);

CREATE INDEX IF NOT EXISTS idx_processed_video_asset_library_advideo
ON processed_video_asset_library(ad_account, advideo_id);
