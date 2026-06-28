-- Accounts Bridge v2 — richer (NON-SECRET) account metadata
--
-- /dashboard/accounts is now a real Cloud Account Manager (add / edit / archive accounts), so the
-- accounts table needs a few more operator-facing, NON-SECRET columns. We ADD nullable columns only
-- (no table rebuild) so the change is safe on a populated production D1 and never touches the
-- existing FK relationships (account_roles / page_bindings / profile_archives reference
-- accounts(platform, account_uid) ON DELETE CASCADE — untouched here).
--
-- SECRET POLICY (unchanged): these columns hold operator labels/notes ONLY. Raw cookies, tokens,
-- passwords, datr, fb_dtsg, localStorage, profile archives, and any session secret are NEVER stored
-- here — the API rejects secret-shaped request fields before a row is written, and sealed session/
-- archive bytes keep living in their own dedicated routes (session_records / profile_archives / R2).
--
-- account_uid stays the primary identity (numeric Facebook UID, 5–32 digits, enforced by the API).
-- status keeps its existing CHECK ('active','inactive','archived'); the UI's "disabled" maps to
-- 'inactive' so we never have to rebuild the table to widen the enum.

ALTER TABLE accounts ADD COLUMN notes              TEXT;
ALTER TABLE accounts ADD COLUMN tags               TEXT;   -- JSON array of short string tags, e.g. ["post","main"]
ALTER TABLE accounts ADD COLUMN page_label         TEXT;   -- operator label for the page this account posts to
ALTER TABLE accounts ADD COLUMN account_role       TEXT;   -- free, non-secret role hint: 'post' | 'ads' | 'general'
ALTER TABLE accounts ADD COLUMN preferred_agent_id TEXT;   -- optional preferred Mac agent for open/close commands
