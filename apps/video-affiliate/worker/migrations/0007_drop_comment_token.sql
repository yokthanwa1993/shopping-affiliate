-- Migration: Consolidate comment_token into access_token
-- After this migration, only access_token is used for both posting and commenting.

-- Step 1: Copy comment_token value into access_token where comment_token exists and starts with EAAD6
UPDATE pages
SET access_token = comment_token,
    updated_at = datetime('now')
WHERE comment_token IS NOT NULL
  AND TRIM(comment_token) <> ''
  AND UPPER(TRIM(comment_token)) LIKE 'EAAD6%';

-- Step 2: Drop the comment_token column
ALTER TABLE pages DROP COLUMN comment_token;
