-- Migration number: 0005
-- Add comment result tracking fields to post_history

ALTER TABLE post_history ADD COLUMN comment_status TEXT DEFAULT 'not_configured';
ALTER TABLE post_history ADD COLUMN comment_token_hint TEXT;
ALTER TABLE post_history ADD COLUMN comment_error TEXT;
ALTER TABLE post_history ADD COLUMN comment_fb_id TEXT;

UPDATE post_history
SET comment_status = 'not_configured'
WHERE comment_status IS NULL;
