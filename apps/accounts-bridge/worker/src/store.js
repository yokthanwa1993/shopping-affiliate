// D1 data-access layer for Accounts Bridge v2.
//
// `db` is any object exposing the D1 prepared-statement API:
//   db.prepare(sql).bind(...args).first() | .all() | .run()
// Cloudflare's `env.DB` satisfies this directly; the test suite injects a `node:sqlite`-backed shim
// that runs the REAL migration SQL, so these queries are exercised against an actual SQL engine.
//
// Every method that returns session/cookie rows strips the `encrypted_blob` column before it leaves
// this layer. The blob is intentionally never surfaced past the store boundary.

import { newId, nowIso, sha256Hex, assertEncryptedBlob } from './lib.js';
import { SCHEMA_SQL } from './schema.js';


function splitSchemaStatements(sql) {
  return String(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('--'));
}

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    account_uid: row.account_uid,
    platform: row.platform,
    role: row.role,
    page_id: row.page_id ?? null,
    version: row.version,
    source: row.source,
    blob_digest: row.blob_digest,
    has_blob: true,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at ?? null
  };
}

function publicCookie(row) {
  if (!row) return null;
  return {
    id: row.id,
    account_uid: row.account_uid,
    platform: row.platform,
    role: row.role ?? null,
    page_id: row.page_id ?? null,
    cookie_scope: row.cookie_scope ?? null,
    version: row.version,
    source: row.source,
    blob_digest: row.blob_digest,
    has_blob: true,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at ?? null
  };
}

export class AccountsStore {
  constructor(db, { clock } = {}) {
    this.db = db;
    this.clock = clock;
  }

  ts() {
    return nowIso(this.clock);
  }


  async bootstrapSchema() {
    const statements = splitSchemaStatements(SCHEMA_SQL);
    for (const stmt of statements) {
      await this.db.prepare(stmt).run();
    }
    const wanted = ['accounts', 'sections', 'account_roles', 'page_bindings', 'session_records', 'cookie_records', 'audit_events'];
    const { results } = await this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${wanted.map(() => '?').join(',')}) ORDER BY name`)
      .bind(...wanted)
      .all();
    return { applied: statements.length, tables: results.map((r) => r.name) };
  }

  // --- accounts ----------------------------------------------------------
  async listAccounts(platform) {
    const stmt = platform
      ? this.db.prepare('SELECT * FROM accounts WHERE platform = ? ORDER BY created_at').bind(platform)
      : this.db.prepare('SELECT * FROM accounts ORDER BY created_at');
    const { results } = await stmt.all();
    return results.map((r) => ({
      id: r.id,
      account_uid: r.account_uid,
      platform: r.platform,
      display_label: r.display_label ?? null,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
  }

  async getAccount(platform, accountUid) {
    return this.db
      .prepare('SELECT * FROM accounts WHERE platform = ? AND account_uid = ?')
      .bind(platform, accountUid)
      .first();
  }

  async createAccount({ account_uid, platform, display_label = null, status = 'active' }) {
    const existing = await this.getAccount(platform, account_uid);
    if (existing) {
      return { account: await this.publicAccount(platform, account_uid), created: false };
    }
    const now = this.ts();
    await this.db
      .prepare(
        'INSERT INTO accounts (id, account_uid, platform, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(newId('acc'), account_uid, platform, display_label, status, now, now)
      .run();
    return { account: await this.publicAccount(platform, account_uid), created: true };
  }

  async publicAccount(platform, accountUid) {
    const r = await this.getAccount(platform, accountUid);
    if (!r) return null;
    return {
      id: r.id,
      account_uid: r.account_uid,
      platform: r.platform,
      display_label: r.display_label ?? null,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  }

  // --- roles -------------------------------------------------------------
  async getRoleRow(platform, role) {
    return this.db
      .prepare('SELECT * FROM account_roles WHERE platform = ? AND role = ?')
      .bind(platform, role)
      .first();
  }

  // Does `accountUid` hold `role` on `platform`?
  async accountHoldsRole(platform, accountUid, role) {
    const row = await this.getRoleRow(platform, role);
    return !!row && row.account_uid === accountUid;
  }

  async listRoles(platform, roles) {
    const out = {};
    for (const role of roles) {
      const row = await this.getRoleRow(platform, role);
      out[role] = row
        ? {
            account_uid: row.account_uid,
            source: row.source ?? null,
            version: row.version ?? null,
            updated_at: row.updated_at
          }
        : null;
    }
    return out;
  }

  // Assign `accountUid` to `role` (singleton per platform+role). Caller must have validated that the
  // account exists. Pass account_uid=null to clear the role.
  async setRole(platform, role, accountUid, { source = null, version = null } = {}) {
    const now = this.ts();
    const existing = await this.getRoleRow(platform, role);
    if (accountUid == null) {
      if (existing) await this.db.prepare('DELETE FROM account_roles WHERE id = ?').bind(existing.id).run();
      return;
    }
    if (existing) {
      await this.db
        .prepare('UPDATE account_roles SET account_uid = ?, source = ?, version = ?, updated_at = ? WHERE id = ?')
        .bind(accountUid, source, version, now, existing.id)
        .run();
    } else {
      await this.db
        .prepare(
          'INSERT INTO account_roles (id, account_uid, platform, role, source, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(newId('role'), accountUid, platform, role, source, version, now, now)
        .run();
    }
  }

  // --- page bindings -----------------------------------------------------
  async getPageBindings(platform, pageId) {
    const { results } = await this.db
      .prepare('SELECT * FROM page_bindings WHERE platform = ? AND page_id = ? ORDER BY role')
      .bind(platform, pageId)
      .all();
    return results.map((r) => ({
      id: r.id,
      page_id: r.page_id,
      platform: r.platform,
      account_uid: r.account_uid,
      role: r.role,
      display_label: r.display_label ?? null,
      source: r.source ?? null,
      version: r.version ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
  }

  async putPageBinding({ platform, page_id, account_uid, role, display_label = null, source = null, version = null }) {
    const now = this.ts();
    const existing = await this.db
      .prepare('SELECT * FROM page_bindings WHERE platform = ? AND page_id = ? AND role = ?')
      .bind(platform, page_id, role)
      .first();
    if (existing) {
      await this.db
        .prepare(
          'UPDATE page_bindings SET account_uid = ?, display_label = ?, source = ?, version = ?, updated_at = ? WHERE id = ?'
        )
        .bind(account_uid, display_label, source, version, now, existing.id)
        .run();
    } else {
      await this.db
        .prepare(
          'INSERT INTO page_bindings (id, page_id, platform, account_uid, role, display_label, source, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(newId('bind'), page_id, platform, account_uid, role, display_label, source, version, now, now)
        .run();
    }
    return (await this.getPageBindings(platform, page_id)).find((b) => b.role === role);
  }

  // --- sessions ----------------------------------------------------------
  async insertSession({ account_uid, platform, role, page_id = null, version, source, encrypted_blob }) {
    assertEncryptedBlob(encrypted_blob);
    const now = this.ts();
    const id = newId('sess');
    const digest = await sha256Hex(encrypted_blob);
    await this.db
      .prepare(
        'INSERT INTO session_records (id, account_uid, platform, role, page_id, version, source, encrypted_blob, blob_digest, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, account_uid, platform, role, page_id, version, source, encrypted_blob, digest, 'active', now, now, null)
      .run();
    const row = await this.db.prepare('SELECT * FROM session_records WHERE id = ?').bind(id).first();
    return publicSession(row);
  }

  // Latest session status for the binding triple. Never includes the blob.
  async sessionStatus({ platform, account_uid, role }) {
    const row = await this.db
      .prepare(
        'SELECT * FROM session_records WHERE platform = ? AND account_uid = ? AND role = ? ORDER BY created_at DESC, id DESC LIMIT 1'
      )
      .bind(platform, account_uid, role)
      .first();
    const latest = publicSession(row);
    const { results } = await this.db
      .prepare('SELECT COUNT(*) AS n FROM session_records WHERE platform = ? AND account_uid = ? AND role = ?')
      .bind(platform, account_uid, role)
      .all();
    return { present: !!latest, count: results[0]?.n ?? 0, latest };
  }

  // --- cookies -----------------------------------------------------------
  async insertCookie({ account_uid, platform, role = null, page_id = null, cookie_scope = null, version, source, encrypted_blob }) {
    assertEncryptedBlob(encrypted_blob);
    const now = this.ts();
    const id = newId('cookie');
    const digest = await sha256Hex(encrypted_blob);
    await this.db
      .prepare(
        'INSERT INTO cookie_records (id, account_uid, platform, role, page_id, cookie_scope, version, source, encrypted_blob, blob_digest, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, account_uid, platform, role, page_id, cookie_scope, version, source, encrypted_blob, digest, 'active', now, now, null)
      .run();
    const row = await this.db.prepare('SELECT * FROM cookie_records WHERE id = ?').bind(id).first();
    return publicCookie(row);
  }

  // --- audit -------------------------------------------------------------
  async insertAudit({ event_type, account_uid = null, platform = null, role = null, page_id = null, source = null, detail = null }) {
    const now = this.ts();
    const id = newId('audit');
    const detailJson = detail == null ? null : JSON.stringify(detail);
    await this.db
      .prepare(
        'INSERT INTO audit_events (id, event_type, account_uid, platform, role, page_id, source, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, event_type, account_uid, platform, role, page_id, source, detailJson, now)
      .run();
    return { id, event_type, created_at: now };
  }
}
