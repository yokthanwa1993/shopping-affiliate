-- Accounts Bridge v2 — initial schema
--
-- Durable, ownership-explicit store for accounts / roles / sections / sessions / cookies / page
-- bindings, plus an append-only audit log. Every session/cookie/page record binds to
-- account_uid + role + platform + (optional) page_id + version/source + timestamps so the source
-- identity of any page token or post can always be explained. There is no hidden fallback account.
--
-- SECRET POLICY: secret material (session/cookie/token blobs) is stored ONLY in the *_blob columns
-- and ONLY as opaque ciphertext produced outside this DB (key material lives in a Worker secret or
-- on the local operator machine). The API never returns these columns. A non-secret SHA-256 digest
-- and a version/source label are kept alongside so callers can compare/audit without the plaintext.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- accounts — one row per real login identity (non-secret display data only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  account_uid   TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('facebook', 'shopee')),
  display_label TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (platform, account_uid)
);
CREATE INDEX IF NOT EXISTS idx_accounts_uid ON accounts (account_uid);

-- ---------------------------------------------------------------------------
-- sections — optional operator-facing grouping of accounts (non-secret)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sections (
  id          TEXT PRIMARY KEY,
  section_key TEXT NOT NULL,
  label       TEXT,
  platform    TEXT NOT NULL CHECK (platform IN ('facebook', 'shopee')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (platform, section_key)
);

-- ---------------------------------------------------------------------------
-- account_roles — which account plays each role (page posting vs ad creation)
-- role is singleton per (platform, role): exactly one account owns a role.
--   page_posting_facebook_lite -> Facebook Lite / Token Bridge (page posting)
--   ads_power_editor           -> Power Editor (ad creation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_roles (
  id          TEXT PRIMARY KEY,
  account_uid TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('facebook', 'shopee')),
  role        TEXT NOT NULL CHECK (role IN ('page_posting_facebook_lite', 'ads_power_editor')),
  source      TEXT,
  version     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (platform, role),
  FOREIGN KEY (platform, account_uid) REFERENCES accounts (platform, account_uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_roles_account ON account_roles (account_uid);

-- ---------------------------------------------------------------------------
-- page_bindings — which account+role owns a given page_id (no fallback account)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_bindings (
  id            TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('facebook', 'shopee')),
  account_uid   TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('page_posting_facebook_lite', 'ads_power_editor')),
  display_label TEXT,
  source        TEXT,
  version       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (platform, page_id, role),
  FOREIGN KEY (platform, account_uid) REFERENCES accounts (platform, account_uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_page_bindings_page ON page_bindings (page_id);
CREATE INDEX IF NOT EXISTS idx_page_bindings_account ON page_bindings (account_uid);

-- ---------------------------------------------------------------------------
-- session_records — encrypted session/token blob metadata (NEVER returned raw)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_records (
  id             TEXT PRIMARY KEY,
  account_uid    TEXT NOT NULL,
  platform       TEXT NOT NULL CHECK (platform IN ('facebook', 'shopee')),
  role           TEXT NOT NULL CHECK (role IN ('page_posting_facebook_lite', 'ads_power_editor')),
  page_id        TEXT,
  version        TEXT NOT NULL,
  source         TEXT NOT NULL,
  encrypted_blob TEXT NOT NULL,
  blob_digest    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  expires_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_records_lookup
  ON session_records (platform, account_uid, role);
CREATE INDEX IF NOT EXISTS idx_session_records_page ON session_records (page_id);

-- ---------------------------------------------------------------------------
-- cookie_records — encrypted cookie blob metadata (NEVER returned raw)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cookie_records (
  id             TEXT PRIMARY KEY,
  account_uid    TEXT NOT NULL,
  platform       TEXT NOT NULL CHECK (platform IN ('facebook', 'shopee')),
  role           TEXT CHECK (role IN ('page_posting_facebook_lite', 'ads_power_editor')),
  page_id        TEXT,
  cookie_scope   TEXT,
  version        TEXT NOT NULL,
  source         TEXT NOT NULL,
  encrypted_blob TEXT NOT NULL,
  blob_digest    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  expires_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cookie_records_lookup
  ON cookie_records (platform, account_uid);

-- ---------------------------------------------------------------------------
-- audit_events — append-only, non-secret provenance trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  account_uid TEXT,
  platform    TEXT,
  role        TEXT,
  page_id     TEXT,
  source      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_account ON audit_events (account_uid);
