-- Simplify auth: replace allowed_emails with system_admins + email_namespaces as owner source of truth
-- system_admins = system-wide admin (yokthanwa1993@gmail.com only)
-- email_namespaces = every namespace owner (canonical mapping)

CREATE TABLE IF NOT EXISTS system_admins (
  email TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_admins (email) VALUES ('yokthanwa1993@gmail.com');

-- Ensure all current allowed_emails entries have email_namespaces mappings
-- (this is a safety net; the migration script will handle the actual ID migration)
INSERT OR IGNORE INTO email_namespaces (email, namespace_id, created_at, updated_at)
SELECT ae.email,
       COALESCE(
           (SELECT u.namespace_id FROM users u WHERE u.email = ae.email ORDER BY datetime(u.created_at) ASC LIMIT 1),
           ae.email
       ),
       datetime('now'),
       datetime('now')
FROM allowed_emails ae
WHERE ae.email NOT IN (SELECT email FROM email_namespaces);
