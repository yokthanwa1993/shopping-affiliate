// D1 data-access layer for Accounts Bridge v2.
//
// `db` is any object exposing the D1 prepared-statement API:
//   db.prepare(sql).bind(...args).first() | .all() | .run()
// Cloudflare's `env.DB` satisfies this directly; the test suite injects a `node:sqlite`-backed shim
// that runs the REAL migration SQL, so these queries are exercised against an actual SQL engine.
//
// Every method that returns session/cookie rows strips the `encrypted_blob` column before it leaves
// this layer. The blob is intentionally never surfaced past the store boundary.

import { newId, nowIso, sha256Hex, sha256HexBytes, assertEncryptedBlob, assertEncryptedArchive, sanitizeErrorMessage, HttpError } from './lib.js';
import { SCHEMA_SQL } from './schema.js';

// Parse a stored JSON column back to an object, tolerating null/legacy-bad rows (never throws).
function parseJsonColumn(value) {
  if (value == null || value === '') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Parse the stored tags column (a JSON array string) back to a clean string[] (never throws).
function parseTags(value) {
  if (value == null || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
  } catch {
    return [];
  }
}

// Normalize caller tags input (string[] or comma/space-separated string) to a JSON array string for
// storage, or null when empty. Each tag is trimmed, deduped, length-capped — non-secret labels only.
function normalizeTagsToJson(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') list = input.split(/[,\n]/);
  else if (input == null) return null;
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, 40);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= 12) break;
  }
  return out.length ? JSON.stringify(out) : null;
}

// Public (non-secret) shape of an accounts row. Metadata columns are operator labels only.
function publicAccountRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    account_uid: r.account_uid,
    platform: r.platform,
    display_label: r.display_label ?? null,
    notes: r.notes ?? null,
    tags: parseTags(r.tags),
    page_label: r.page_label ?? null,
    account_role: r.account_role ?? null,
    preferred_agent_id: r.preferred_agent_id ?? null,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

// Public (non-secret) shape of an agent_commands row. payload/result are already non-secret JSON
// (the API rejects secret-shaped keys/values before insert); error_message was sanitized on write.
function publicCommand(row) {
  if (!row) return null;
  return {
    id: row.id,
    agent_id: row.agent_id,
    action: row.action,
    platform: row.platform ?? null,
    role: row.role ?? null,
    account_uid: row.account_uid ?? null,
    status: row.status,
    payload: parseJsonColumn(row.payload_json),
    result: parseJsonColumn(row.result_json),
    error_code: row.error_code ?? null,
    error_message: row.error_message ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at ?? null,
    completed_at: row.completed_at ?? null
  };
}

// Public (non-secret) shape of an agents row. detail is non-secret provenance only.
function publicAgent(row) {
  if (!row) return null;
  return {
    agent_id: row.agent_id,
    label: row.label ?? null,
    status: row.status,
    detail: parseJsonColumn(row.detail),
    last_seen_at: row.last_seen_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// R2 object key for the current sealed profile archive. Scoped by platform/role/account_uid (NOT a
// bare profile id) so ownership is unambiguous and BrowserSaving's `browser-data/{profileId}` ambiguity
// can't recur. `.enc` marks it as opaque ciphertext the Worker never decrypts.
export function profileArchiveR2Key({ platform, role, account_uid }) {
  return `profile-archives/${platform}/${role}/${account_uid}.tar.gz.enc`;
}

function publicArchive(row) {
  if (!row) return null;
  return {
    platform: row.platform,
    role: row.role,
    account_uid: row.account_uid,
    blob_digest: row.blob_digest,
    byte_size: row.byte_size,
    cipher: row.cipher,
    version: row.version,
    source: row.source,
    status: row.status,
    has_archive: true,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}


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
  constructor(db, { clock, bucket } = {}) {
    this.db = db;
    this.clock = clock;
    // R2 bucket binding for sealed profile archives (env.PROFILE_ARCHIVES). Optional: only the
    // profile-archive routes require it; the rest of the API is pure D1.
    this.bucket = bucket;
  }

  ts() {
    return nowIso(this.clock);
  }


  async bootstrapSchema() {
    const statements = splitSchemaStatements(SCHEMA_SQL);
    for (const stmt of statements) {
      await this.db.prepare(stmt).run();
    }
    const wanted = ['accounts', 'sections', 'account_roles', 'page_bindings', 'session_records', 'cookie_records', 'audit_events', 'profile_archives', 'agents', 'agent_commands'];
    const { results } = await this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${wanted.map(() => '?').join(',')}) ORDER BY name`)
      .bind(...wanted)
      .all();
    return { applied: statements.length, tables: results.map((r) => r.name) };
  }

  // --- accounts ----------------------------------------------------------
  // List accounts (optionally a single platform). Archived rows are hidden unless includeArchived.
  async listAccounts(platform, { includeArchived = false } = {}) {
    const where = [];
    const args = [];
    if (platform) { where.push('platform = ?'); args.push(platform); }
    if (!includeArchived) where.push("status != 'archived'");
    let sql = 'SELECT * FROM accounts';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at';
    const { results } = await this.db.prepare(sql).bind(...args).all();
    return results.map((r) => publicAccountRow(r));
  }

  async getAccount(platform, accountUid) {
    return this.db
      .prepare('SELECT * FROM accounts WHERE platform = ? AND account_uid = ?')
      .bind(platform, accountUid)
      .first();
  }

  async createAccount({
    account_uid,
    platform,
    display_label = null,
    notes = null,
    tags = null,
    page_label = null,
    account_role = null,
    preferred_agent_id = null,
    status = 'active'
  }) {
    const existing = await this.getAccount(platform, account_uid);
    if (existing) {
      return { account: await this.publicAccount(platform, account_uid), created: false };
    }
    const now = this.ts();
    await this.db
      .prepare(
        'INSERT INTO accounts (id, account_uid, platform, display_label, notes, tags, page_label, account_role, preferred_agent_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        newId('acc'),
        account_uid,
        platform,
        display_label,
        notes,
        normalizeTagsToJson(tags),
        page_label,
        account_role,
        preferred_agent_id,
        status,
        now,
        now
      )
      .run();
    return { account: await this.publicAccount(platform, account_uid), created: true };
  }

  // Update mutable, NON-SECRET metadata/status on an existing account. Only whitelisted fields in
  // `patch` are touched; account_uid/platform (the identity) are immutable here. Returns the updated
  // public account, or null when the account does not exist.
  async updateAccount(platform, accountUid, patch = {}) {
    const existing = await this.getAccount(platform, accountUid);
    if (!existing) return null;
    const sets = [];
    const args = [];
    const setCol = (col, val) => { sets.push(`${col} = ?`); args.push(val); };
    if ('display_label' in patch) setCol('display_label', patch.display_label ?? null);
    if ('notes' in patch) setCol('notes', patch.notes ?? null);
    if ('tags' in patch) setCol('tags', normalizeTagsToJson(patch.tags));
    if ('page_label' in patch) setCol('page_label', patch.page_label ?? null);
    if ('account_role' in patch) setCol('account_role', patch.account_role ?? null);
    if ('preferred_agent_id' in patch) setCol('preferred_agent_id', patch.preferred_agent_id ?? null);
    if ('status' in patch && patch.status != null) setCol('status', patch.status);
    if (sets.length === 0) {
      // Nothing to change — still return the current shape (idempotent no-op PATCH).
      return this.publicAccount(platform, accountUid);
    }
    const now = this.ts();
    setCol('updated_at', now);
    args.push(platform, accountUid);
    await this.db
      .prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE platform = ? AND account_uid = ?`)
      .bind(...args)
      .run();
    return this.publicAccount(platform, accountUid);
  }

  // Soft-archive an account: status='archived'. NEVER deletes the row or any profile/session/cookie/
  // archive bytes — those sealed records keep their own lifecycle. Returns the archived public account
  // or null when the account does not exist.
  async archiveAccount(platform, accountUid) {
    const existing = await this.getAccount(platform, accountUid);
    if (!existing) return null;
    const now = this.ts();
    await this.db
      .prepare("UPDATE accounts SET status = 'archived', updated_at = ? WHERE platform = ? AND account_uid = ?")
      .bind(now, platform, accountUid)
      .run();
    return this.publicAccount(platform, accountUid);
  }

  async publicAccount(platform, accountUid) {
    return publicAccountRow(await this.getAccount(platform, accountUid));
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

  // --- agents (heartbeat + last-seen) -----------------------------------
  async getAgent(agentId) {
    const row = await this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').bind(agentId).first();
    return publicAgent(row);
  }

  async listAgents() {
    const { results } = await this.db.prepare('SELECT * FROM agents ORDER BY agent_id').all();
    return results.map((r) => publicAgent(r));
  }

  // Upsert an agent heartbeat. `detail` is non-secret JSON (validated by the router). Touching the
  // row always advances last_seen_at/updated_at so the dashboard can tell a live agent from a stale
  // one. `status` defaults to 'online' on first contact and is only overwritten when provided.
  async upsertAgentStatus({ agent_id, status = null, label = null, detail = null, seen = true }) {
    const now = this.ts();
    const detailJson = detail == null ? null : JSON.stringify(detail);
    const existing = await this.db.prepare('SELECT * FROM agents WHERE agent_id = ?').bind(agent_id).first();
    const lastSeen = seen ? now : existing ? existing.last_seen_at : null;
    if (existing) {
      await this.db
        .prepare('UPDATE agents SET status = ?, label = COALESCE(?, label), detail = COALESCE(?, detail), last_seen_at = ?, updated_at = ? WHERE agent_id = ?')
        .bind(status || existing.status, label, detailJson, lastSeen, now, agent_id)
        .run();
    } else {
      await this.db
        .prepare('INSERT INTO agents (agent_id, label, status, detail, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(agent_id, label, status || 'online', detailJson, lastSeen, now, now)
        .run();
    }
    return this.getAgent(agent_id);
  }

  // --- agent command queue ----------------------------------------------
  async enqueueCommand({ agent_id, action, platform = null, role = null, account_uid = null, payload = null }) {
    const now = this.ts();
    const id = newId('cmd');
    const payloadJson = payload == null ? null : JSON.stringify(payload);
    await this.db
      .prepare(
        'INSERT INTO agent_commands (id, agent_id, action, platform, role, account_uid, status, payload_json, result_json, error_code, error_message, created_at, updated_at, claimed_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(id, agent_id, action, platform, role, account_uid, 'queued', payloadJson, null, null, null, now, now, null, null)
      .run();
    // Enqueuing implies the agent is a known target; register/refresh it WITHOUT marking it seen
    // (only the agent itself, by polling/heartbeat, proves liveness).
    const existing = await this.db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').bind(agent_id).first();
    if (!existing) await this.upsertAgentStatus({ agent_id, status: 'offline', seen: false });
    return publicCommand(await this.db.prepare('SELECT * FROM agent_commands WHERE id = ?').bind(id).first());
  }

  async getCommand(id) {
    return publicCommand(await this.db.prepare('SELECT * FROM agent_commands WHERE id = ?').bind(id).first());
  }

  async listCommands({ agent_id = null, status = null, limit = 20 } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    let sql = 'SELECT * FROM agent_commands';
    const where = [];
    const args = [];
    if (agent_id) { where.push('agent_id = ?'); args.push(agent_id); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    args.push(n);
    const { results } = await this.db.prepare(sql).bind(...args).all();
    return results.map((r) => publicCommand(r));
  }

  // Atomically claim up to `limit` queued commands for an agent and transition them to 'running'.
  // D1/the test shim have no multi-row transaction primitive, so we claim ONE row at a time with a
  // compare-and-set UPDATE guarded on status='queued' and confirm via meta.changes — a deterministic
  // single-command claim that two concurrent pollers can never double-claim (the loser's UPDATE
  // matches zero rows). The poll itself is also an agent heartbeat.
  async claimQueuedCommands({ agent_id, limit = 5 }) {
    const n = Math.max(1, Math.min(50, Number(limit) || 5));
    await this.upsertAgentStatus({ agent_id, status: 'online', seen: true });
    const { results } = await this.db
      .prepare("SELECT id FROM agent_commands WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC, id ASC LIMIT ?")
      .bind(agent_id, n)
      .all();
    const claimed = [];
    for (const { id } of results) {
      const now = this.ts();
      const res = await this.db
        .prepare("UPDATE agent_commands SET status = 'running', claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
        .bind(now, now, id)
        .run();
      const changes = res?.meta?.changes ?? res?.changes ?? 0;
      if (changes === 1) {
        claimed.push(await this.getCommand(id));
      }
    }
    return claimed;
  }

  // Report a terminal result for a running command. Guarded on status='running' so a command can't
  // be completed twice or completed before it was claimed (returns null → router answers 409).
  // result is non-secret JSON (validated by the router); error_message is sanitized defensively here.
  async completeCommand({ id, status, result = null, error_code = null, error_message = null }) {
    const existing = await this.db.prepare('SELECT * FROM agent_commands WHERE id = ?').bind(id).first();
    if (!existing) return { ok: false, reason: 'not_found', command: null };
    if (existing.status !== 'running') return { ok: false, reason: 'not_running', command: publicCommand(existing) };
    const now = this.ts();
    const resultJson = result == null ? null : JSON.stringify(result);
    const safeError = sanitizeErrorMessage(error_message);
    const safeCode = error_code == null ? null : sanitizeErrorMessage(error_code, 80);
    await this.db
      .prepare('UPDATE agent_commands SET status = ?, result_json = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?')
      .bind(status, resultJson, safeCode, safeError, now, now, id)
      .run();
    return { ok: true, command: await this.getCommand(id) };
  }

  // --- profile archives (sealed bytes in R2, metadata in D1) -------------
  requireBucket() {
    if (!this.bucket) {
      throw new HttpError('Profile archive storage (R2) is not configured', 503, 'archive_store_unconfigured');
    }
    return this.bucket;
  }

  async getArchiveRow({ platform, role, account_uid }) {
    return this.db
      .prepare('SELECT * FROM profile_archives WHERE platform = ? AND role = ? AND account_uid = ?')
      .bind(platform, role, account_uid)
      .first();
  }

  // Replace the CURRENT sealed archive for this owner triple: write opaque ciphertext to R2, then
  // upsert non-secret metadata in D1. `archive` MUST be the locally-sealed ABENC1 envelope (validated
  // here so a raw browser-data archive can never be stored). Returns metadata only — never the bytes.
  async putProfileArchive({ platform, role, account_uid, version, source, cipher = 'aesgcm', archive }) {
    const bytes = assertEncryptedArchive(archive);
    const bucket = this.requireBucket();
    const key = profileArchiveR2Key({ platform, role, account_uid });
    const digest = await sha256HexBytes(bytes);
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { platform, role, account_uid, version, source, cipher, digest }
    });
    const now = this.ts();
    const existing = await this.getArchiveRow({ platform, role, account_uid });
    if (existing) {
      await this.db
        .prepare(
          'UPDATE profile_archives SET r2_key = ?, blob_digest = ?, byte_size = ?, cipher = ?, version = ?, source = ?, status = ?, updated_at = ? WHERE id = ?'
        )
        .bind(key, digest, bytes.byteLength, cipher, version, source, 'active', now, existing.id)
        .run();
    } else {
      await this.db
        .prepare(
          'INSERT INTO profile_archives (id, platform, role, account_uid, r2_key, blob_digest, byte_size, cipher, version, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(newId('arch'), platform, role, account_uid, key, digest, bytes.byteLength, cipher, version, source, 'active', now, now)
        .run();
    }
    return publicArchive(await this.getArchiveRow({ platform, role, account_uid }));
  }

  // Metadata-only presence check (the "head" surface). Never touches the bytes.
  async profileArchiveStatus({ platform, role, account_uid }) {
    const meta = publicArchive(await this.getArchiveRow({ platform, role, account_uid }));
    return { present: !!meta, archive: meta };
  }

  // Fetch the sealed ciphertext for restore-before-open. Returns `{ meta, body }` where `body` is the
  // R2 object body (opaque bytes) or null when absent. The Worker has no key; it streams ciphertext.
  async getProfileArchiveBytes({ platform, role, account_uid }) {
    const row = await this.getArchiveRow({ platform, role, account_uid });
    if (!row) return { meta: null, object: null };
    const bucket = this.requireBucket();
    const object = await bucket.get(row.r2_key);
    return { meta: publicArchive(row), object };
  }
}
