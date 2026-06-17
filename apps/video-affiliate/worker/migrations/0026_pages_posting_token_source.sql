-- Migration number: 0026   2026-06-13T00:00:00.000Z
-- Per-page Facebook posting token source selector.
-- 'stored_token' (default) = current behavior (pages.access_token + namespace token pool).
-- 'post-reels-token-ads'   = opt-in Ads Manager/CloakBrowser bridge for posting Reels.
-- Existing rows get the default, so production posting behavior is unchanged.
-- Runtime also ensures this column idempotently via ensurePagesOneCardColumns in worker/src/index.ts.
-- Runtime normalizes any other stored value back to 'stored_token'.

ALTER TABLE pages ADD COLUMN posting_token_source TEXT DEFAULT 'stored_token';
