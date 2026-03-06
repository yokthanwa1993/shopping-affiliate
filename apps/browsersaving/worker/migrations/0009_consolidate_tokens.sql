-- Consolidate postcron_token + comment_token → access_token
-- Prefer comment_token (EAAD6 prefix), fallback to postcron_token

-- Step 1: Add access_token column
ALTER TABLE profiles ADD COLUMN access_token TEXT;

-- Step 2: Copy only EAAD6 tokens from comment_token
UPDATE profiles SET access_token = CASE
    WHEN comment_token IS NOT NULL AND trim(comment_token) LIKE 'EAAD6%' THEN trim(comment_token)
    ELSE NULL
END;

-- Step 3: Drop old columns by recreating table
CREATE TABLE profiles_new (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    owner_email TEXT,
    name TEXT NOT NULL DEFAULT 'Unnamed',
    proxy TEXT DEFAULT '',
    homepage TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    avatar_url TEXT,
    totp_secret TEXT,
    uid TEXT,
    username TEXT,
    password TEXT,
    datr TEXT,
    access_token TEXT,
    facebook_token TEXT,
    shopee_cookies TEXT,
    page_name TEXT,
    page_avatar_url TEXT,
    deleted_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO profiles_new SELECT
    id, owner_email, name, proxy, homepage, notes, tags, avatar_url,
    totp_secret, uid, username, password, datr, access_token, facebook_token,
    shopee_cookies, page_name, page_avatar_url, deleted_at, created_at, updated_at
FROM profiles;

DROP TABLE profiles;
ALTER TABLE profiles_new RENAME TO profiles;
