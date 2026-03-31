-- Add approval status column to line_users table
-- New users default to 'pending', existing users are auto-approved
ALTER TABLE line_users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

-- Auto-approve all existing users
UPDATE line_users SET status = 'approved' WHERE status = 'pending';
