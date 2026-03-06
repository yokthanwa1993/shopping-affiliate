-- Add post token/profile trace fields for activity log audit
ALTER TABLE post_history ADD COLUMN post_token_hint TEXT;
ALTER TABLE post_history ADD COLUMN post_profile_id TEXT;
ALTER TABLE post_history ADD COLUMN post_profile_name TEXT;
ALTER TABLE post_history ADD COLUMN comment_profile_id TEXT;
ALTER TABLE post_history ADD COLUMN comment_profile_name TEXT;
