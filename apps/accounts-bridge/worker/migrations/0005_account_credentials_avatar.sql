-- Accounts Bridge v2 — BrowserSaving-style profile fields: richer NON-SECRET metadata, an avatar
-- pointer (bytes live in R2), and an ENCRYPTED-at-rest credential vault (separate table).
--
-- WHY: /dashboard/accounts now has an "Add / Edit Profile" modal modeled on BrowserSaving. It collects
-- non-secret metadata (profile name, single tag, homepage, email, notes, page label, status) AND a few
-- genuinely sensitive fields (password, DATR cookie, TOTP/2FA secret, proxy URL which may embed
-- user:pass). The sensitive fields are NEVER stored in the accounts table and NEVER returned by any GET.
--
-- SPLIT:
--   * accounts            — gains only NON-SECRET columns + an avatar pointer (avatar_r2_key/mime/at).
--   * account_credentials — one row per (platform, account_uid): a single AES-GCM ciphertext blob that
--                           JSON-encrypts {password, datr_cookie, totp_secret, proxy_url}. The API
--                           returns ONLY presence booleans (has_*) and a credential-free proxy_host_hint.
--                           The Worker holds the key (dedicated ACCOUNTS_BRIDGE_SECRETS_KEY, or derived
--                           from ACCOUNTS_BRIDGE_API_KEY) but never returns plaintext.
--
-- We ADD nullable columns only (no table rebuild) so the change is safe on a populated production D1.
-- account_uid stays the numeric Facebook UID (5–32 digits, enforced by the API).

-- New NON-SECRET account metadata + avatar pointer (avatar bytes live in R2, never in D1).
ALTER TABLE accounts ADD COLUMN tag                TEXT;   -- single BrowserSaving-style tag: 'post' | 'comment' | 'mobile'
ALTER TABLE accounts ADD COLUMN homepage_url       TEXT;   -- non-secret homepage/landing URL for the profile
ALTER TABLE accounts ADD COLUMN email              TEXT;   -- login email (non-secret contact label, never a password)
ALTER TABLE accounts ADD COLUMN avatar_r2_key      TEXT;   -- R2 object key for the uploaded avatar image
ALTER TABLE accounts ADD COLUMN avatar_mime        TEXT;   -- image/png | image/jpeg | image/webp
ALTER TABLE accounts ADD COLUMN avatar_updated_at  TEXT;   -- last avatar upload timestamp (cache-bust hint)

-- ---------------------------------------------------------------------------
-- account_credentials — ENCRYPTED-at-rest sensitive profile credentials.
-- One row per (platform, account_uid). The blob is opaque AES-GCM ciphertext; the API returns ONLY the
-- has_* presence booleans and a credential-free proxy_host_hint. The raw values are NEVER returned.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_credentials (
  id              TEXT PRIMARY KEY,
  platform        TEXT NOT NULL CHECK (platform IN ('facebook', 'shopee')),
  account_uid     TEXT NOT NULL,
  encrypted_blob  TEXT,            -- base64(iv ‖ AES-GCM ciphertext) of {password,datr_cookie,totp_secret,proxy_url}
  cipher          TEXT NOT NULL DEFAULT 'aesgcm',
  key_version     TEXT,            -- which key derived/sealed this blob (apikey-v1 | secrets-v1)
  has_password    INTEGER NOT NULL DEFAULT 0,
  has_datr_cookie INTEGER NOT NULL DEFAULT 0,
  has_totp_secret INTEGER NOT NULL DEFAULT 0,
  has_proxy_url   INTEGER NOT NULL DEFAULT 0,
  proxy_host_hint TEXT,            -- host:port ONLY (credentials stripped) — safe to display
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (platform, account_uid),
  FOREIGN KEY (platform, account_uid) REFERENCES accounts (platform, account_uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_credentials_account ON account_credentials (account_uid);
