// D1 schema tests — runs the REAL migration against node:sqlite and asserts structure + CHECK/UNIQUE
// constraints that enforce ownership-explicit, no-fallback-account invariants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite } from './d1-sqlite.js';

const EXPECTED_TABLES = [
  'accounts',
  'sections',
  'account_roles',
  'page_bindings',
  'session_records',
  'cookie_records',
  'audit_events',
  'profile_archives'
];

test('migration creates every expected table', async () => {
  const db = new D1Sqlite();
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const names = results.map((r) => r.name);
  for (const t of EXPECTED_TABLES) assert.ok(names.includes(t), `missing table ${t}`);
});

test('accounts.platform CHECK rejects an unsupported platform', async () => {
  const db = new D1Sqlite();
  assert.throws(() =>
    db.db
      .prepare('INSERT INTO accounts (id, account_uid, platform, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('a1', 'uid1', 'tiktok', 't', 't')
  );
});

test('account_roles enforces a single owner per (platform, role)', async () => {
  const db = new D1Sqlite();
  db.db.prepare('INSERT INTO accounts (id, account_uid, platform, created_at, updated_at) VALUES (?,?,?,?,?)').run('a1', 'uidA', 'facebook', 't', 't');
  db.db.prepare('INSERT INTO accounts (id, account_uid, platform, created_at, updated_at) VALUES (?,?,?,?,?)').run('a2', 'uidB', 'facebook', 't', 't');
  db.db.prepare('INSERT INTO account_roles (id, account_uid, platform, role, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('r1', 'uidA', 'facebook', 'page_posting_facebook_lite', 't', 't');
  // A second row for the same (platform, role) must violate UNIQUE — proving the role is a singleton.
  assert.throws(() =>
    db.db.prepare('INSERT INTO account_roles (id, account_uid, platform, role, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('r2', 'uidB', 'facebook', 'page_posting_facebook_lite', 't', 't')
  );
});

test('account_roles.role CHECK rejects an unknown role', async () => {
  const db = new D1Sqlite();
  db.db.prepare('INSERT INTO accounts (id, account_uid, platform, created_at, updated_at) VALUES (?,?,?,?,?)').run('a1', 'uidA', 'facebook', 't', 't');
  assert.throws(() =>
    db.db.prepare('INSERT INTO account_roles (id, account_uid, platform, role, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('r1', 'uidA', 'facebook', 'some_other_role', 't', 't')
  );
});

test('page_bindings is unique per (platform, page_id, role)', async () => {
  const db = new D1Sqlite();
  db.db.prepare('INSERT INTO accounts (id, account_uid, platform, created_at, updated_at) VALUES (?,?,?,?,?)').run('a1', 'uidA', 'facebook', 't', 't');
  db.db.prepare('INSERT INTO page_bindings (id, page_id, platform, account_uid, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('b1', 'page99', 'facebook', 'uidA', 'page_posting_facebook_lite', 't', 't');
  assert.throws(() =>
    db.db.prepare('INSERT INTO page_bindings (id, page_id, platform, account_uid, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('b2', 'page99', 'facebook', 'uidA', 'page_posting_facebook_lite', 't', 't')
  );
});

test('session_records requires encrypted_blob + blob_digest (NOT NULL)', async () => {
  const db = new D1Sqlite();
  assert.throws(() =>
    db.db
      .prepare('INSERT INTO session_records (id, account_uid, platform, role, version, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('s1', 'uidA', 'facebook', 'page_posting_facebook_lite', 'v1', 'api', 't', 't')
  );
});

test('profile_archives is a singleton per (platform, role, account_uid)', async () => {
  const db = new D1Sqlite();
  db.db.prepare('INSERT INTO accounts (id, account_uid, platform, created_at, updated_at) VALUES (?,?,?,?,?)').run('a1', 'uidA', 'facebook', 't', 't');
  const ins = (id) =>
    db.db
      .prepare('INSERT INTO profile_archives (id, platform, role, account_uid, r2_key, blob_digest, byte_size, version, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'facebook', 'page_posting_facebook_lite', 'uidA', 'k', 'd', 100, 'v1', 'api', 't', 't');
  ins('arch1');
  // A second CURRENT archive for the same owner triple must violate UNIQUE.
  assert.throws(() => ins('arch2'));
});

test('profile_archives.platform/role CHECKs reject unsupported values', async () => {
  const db = new D1Sqlite();
  db.db.prepare('INSERT INTO accounts (id, account_uid, platform, created_at, updated_at) VALUES (?,?,?,?,?)').run('a1', 'uidA', 'facebook', 't', 't');
  assert.throws(() =>
    db.db
      .prepare('INSERT INTO profile_archives (id, platform, role, account_uid, r2_key, blob_digest, byte_size, version, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('arch1', 'facebook', 'not_a_role', 'uidA', 'k', 'd', 100, 'v1', 'api', 't', 't')
  );
});
