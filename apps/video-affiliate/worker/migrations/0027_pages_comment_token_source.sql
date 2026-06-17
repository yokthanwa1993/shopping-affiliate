-- Migration number: 0027   2026-06-16T00:00:00.000Z
-- Per-page Facebook COMMENT token source selector — decoupled from posting source.
-- Decides HOW the automatic affiliate comment is sent AFTER a post:
--   'stored_token' = comment via the stored/dedicated page comment token over Graph
--                    (the deferred comment_status='pending' backlog path).
--   'cloak_browser'= comment as the Page via the CloakBrowser bridge /page-comment route.
-- NULL/missing/invalid normalizes at RUNTIME to the page's effective posting source
-- (see defaultCommentSourceForRoute in worker/src/posting-token-source.ts), so existing
-- rows keep their current behavior: CloakBrowser-posting pages still comment via the
-- bridge, stored-token pages still comment with the stored token. No default is forced
-- here precisely so the runtime fallback can follow the posting source per page.
-- Runtime also ensures this column idempotently via ensurePagesOneCardColumns.

ALTER TABLE pages ADD COLUMN comment_token_source TEXT;
