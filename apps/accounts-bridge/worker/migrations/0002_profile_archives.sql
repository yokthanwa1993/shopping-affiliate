-- Accounts Bridge v2 — profile archive sync (encrypted, opaque)
--
-- Mirrors BrowserSaving's "compress the browser/session data on close, restore it on open" behaviour,
-- but the bytes are sealed LOCALLY (AES-GCM, ABENC1 envelope) before they ever leave the device. The
-- Worker stores only opaque ciphertext in R2 (key `profile-archives/{platform}/{role}/{account_uid}
-- .tar.gz.enc`) and only NON-SECRET metadata here. It NEVER parses cookies/tokens/datr/passwords out
-- of the archive (it cannot — it has no key) and NEVER returns plaintext.
--
-- One CURRENT archive per (platform, role, account_uid): each upload replaces the previous bytes and
-- bumps version/digest/size/updated_at, so "open" always restores the latest sealed profile.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profile_archives (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL CHECK (platform IN ('facebook', 'shopee')),
  role          TEXT NOT NULL CHECK (role IN ('page_posting_facebook_lite', 'ads_power_editor')),
  account_uid   TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  blob_digest   TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  cipher        TEXT NOT NULL DEFAULT 'aesgcm',
  version       TEXT NOT NULL,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (platform, role, account_uid),
  FOREIGN KEY (platform, account_uid) REFERENCES accounts (platform, account_uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_profile_archives_account ON profile_archives (account_uid);
CREATE INDEX IF NOT EXISTS idx_profile_archives_lookup ON profile_archives (platform, role, account_uid);
