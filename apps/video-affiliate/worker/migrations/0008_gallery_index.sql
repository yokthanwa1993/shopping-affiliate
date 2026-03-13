CREATE TABLE IF NOT EXISTS gallery_index (
  namespace_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT '',
  is_owner_linked INTEGER NOT NULL DEFAULT 0,
  script TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  shopee_link TEXT NOT NULL DEFAULT '',
  has_link INTEGER NOT NULL DEFAULT 0,
  public_url TEXT NOT NULL DEFAULT '',
  original_url TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  has_public_video INTEGER NOT NULL DEFAULT 0,
  has_original_video INTEGER NOT NULL DEFAULT 0,
  has_metadata INTEGER NOT NULL DEFAULT 0,
  is_original_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (namespace_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_gallery_index_owner_link_updated
ON gallery_index(is_owner_linked, has_link, updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gallery_index_owner_thumb_updated
ON gallery_index(is_owner_linked, has_thumbnail, updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gallery_index_namespace_updated
ON gallery_index(namespace_id, updated_at DESC, created_at DESC);
