-- Track videos imported from other namespaces

CREATE TABLE IF NOT EXISTS imported_videos (
    namespace_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    source_namespace_id TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    imported_by TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (namespace_id, video_id)
);
