-- Canonical mapping: 1 email = 1 namespace

CREATE TABLE IF NOT EXISTS email_namespaces (
  email TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_namespaces_namespace ON email_namespaces(namespace_id);

-- Backfill mapping from earliest user row per email (stable workspace owner)
INSERT OR IGNORE INTO email_namespaces (email, namespace_id)
SELECT u.email, u.namespace_id
FROM users u
WHERE u.email IS NOT NULL
  AND TRIM(u.email) <> ''
  AND u.namespace_id IS NOT NULL
  AND TRIM(u.namespace_id) <> ''
  AND u.rowid = (
    SELECT u2.rowid
    FROM users u2
    WHERE u2.email = u.email
      AND u2.namespace_id IS NOT NULL
      AND TRIM(u2.namespace_id) <> ''
    ORDER BY datetime(u2.created_at) ASC, u2.rowid ASC
    LIMIT 1
  );

-- Normalize existing rows so all devices/accounts of same email share one namespace
UPDATE users
SET namespace_id = (
  SELECT en.namespace_id
  FROM email_namespaces en
  WHERE en.email = users.email
)
WHERE email IN (SELECT email FROM email_namespaces);
