-- Durable Graph comment pacing/lock guard for page-comment read/write workflows.
-- No tokens or raw Graph payloads are stored here; block_reason is sanitized by code.
CREATE TABLE IF NOT EXISTS graph_comment_op_guard (
    page_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    last_comment_operation_at TEXT NOT NULL DEFAULT '',
    block_until TEXT NOT NULL DEFAULT '',
    block_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (page_id, feature)
);
