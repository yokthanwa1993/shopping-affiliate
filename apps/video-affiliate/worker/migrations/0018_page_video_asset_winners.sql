-- Store page-video winners that were selected from Shopee conversion/order data
-- and uploaded into Meta/Facebook ad account Asset Library (`/{ad_account}/advideos`).
-- This stores aggregate IDs/status only; no tokens/cookies/raw order payloads.

CREATE TABLE IF NOT EXISTS page_video_asset_winners (
  namespace_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  fb_video_id TEXT NOT NULL,
  system_video_id TEXT NOT NULL DEFAULT '',
  ad_account TEXT NOT NULL DEFAULT '',
  advideo_id TEXT NOT NULL DEFAULT '',
  advideo_status TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_sub_id TEXT NOT NULL DEFAULT '',
  source_shopee_link TEXT NOT NULL DEFAULT '',
  orders_1d INTEGER NOT NULL DEFAULT 0,
  orders_7d INTEGER NOT NULL DEFAULT 0,
  commission_7d REAL NOT NULL DEFAULT 0,
  last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (namespace_id, page_id, fb_video_id)
);

CREATE INDEX IF NOT EXISTS idx_page_video_asset_winners_rank
ON page_video_asset_winners(namespace_id, page_id, orders_7d DESC, commission_7d DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_page_video_asset_winners_advideo
ON page_video_asset_winners(ad_account, advideo_id);
