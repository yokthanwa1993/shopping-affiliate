'use strict';

// BrowserSaving-style profile sync for Accounts Bridge local bridge:
//   open  => download sealed archive from Worker/R2, unseal locally, extract before launching Chromium
//   close => tar allowlisted profile state, seal locally, upload to Worker/R2 after Chromium closes
// Worker stores opaque ABENC1 ciphertext only. Never log/archive raw secrets in responses.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { sanitizeAccount } = require('./accounts');
const { PROFILE_ROOT, profileDirFor } = require('./browser');

const ARCHIVE_MAGIC = Buffer.from('ABENC1', 'ascii');
const DEFAULT_WORKER_URL = 'https://accounts-bridge-worker.yokthanwa1993-bc9.workers.dev';
// IDBridge-owned non-secret FB role metadata (FB Lite vs Power Editor). IDBridge writes/owns
// this file; the FBGetToken app is being retired. Env override kept for tests/ops.
const IDBRIDGE_FB_ROLE_METADATA = process.env.FACEBOOK_TOKEN_CLOAK_FB_ROLE_METADATA
  || path.join(os.homedir(), 'Library', 'Application Support', 'IDBridge', 'fb-accounts.json');
// PHASE 1 TEMP FALLBACK — REMOVE IN PHASE 2. Legacy FBGetToken (fb-lite-token-tool) accounts.json.
// Only consulted when the IDBridge-owned file is missing or does not yet list the account, so the
// cutover cannot regress Power Editor classification before IDBridge has fully taken ownership.
const LEGACY_FBGETTOKEN_ACCOUNTS_JSON = process.env.FACEBOOK_TOKEN_CLOAK_LEGACY_FB_ROLE_METADATA
  || path.join(os.homedir(), 'Library', 'Application Support', 'fb-lite-token-tool', 'accounts.json');

// Same intent as BrowserSaving's browser-data tarball, restricted to Chromium state paths.
const ESSENTIAL_PROFILE_PATHS = [
  'Cookies',
  'Login Data',
  'Preferences',
  'Local State',
  'Network',
  'Local Storage',
  'IndexedDB',
  'Session Storage',
  'Service Worker',
  'Sessions',
  'Extension State',
  'DIPS',
  'History',
  'Web Data',
  'Favicons',
  'Sync Data'
];
const ROOT_PROFILE_PATHS = ['Local State', 'First Run'];

function isSafeRel(rel) {
  return !!rel && !path.isAbsolute(rel) && !rel.split(/[\\/]+/).includes('..') && !/[\x00-\x1f\x7f]/.test(rel);
}
function existsInside(base, rel) {
  if (!isSafeRel(rel)) return false;
  return fs.existsSync(path.join(base, rel));
}
function buildManifest(profileDir) {
  const entries = [];
  for (const rel of ROOT_PROFILE_PATHS) {
    if (existsInside(profileDir, rel)) entries.push(rel);
  }
  for (const rel of ESSENTIAL_PROFILE_PATHS) {
    const candidate = path.join('Default', rel);
    if (existsInside(profileDir, candidate)) entries.push(candidate);
  }
  return [...new Set(entries)];
}
function keyFromSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest();
}
function archiveSecret() {
  return process.env.ACCOUNTS_BRIDGE_ARCHIVE_SECRET || process.env.ACCOUNTS_BRIDGE_API_KEY || process.env.FACEBOOK_TOKEN_CLOAK_API_KEY || '';
}
function sealArchive(tarGz) {
  const secret = archiveSecret();
  if (!secret) throw Object.assign(new Error('archive secret not configured'), { code: 'archive_secret_missing' });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(tarGz), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ARCHIVE_MAGIC, iv, ciphertext, tag]);
}
function unsealArchive(envelope) {
  const secret = archiveSecret();
  if (!secret) throw Object.assign(new Error('archive secret not configured'), { code: 'archive_secret_missing' });
  const buf = Buffer.from(envelope || '');
  if (buf.length <= ARCHIVE_MAGIC.length + 12 + 16 || !buf.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
    throw Object.assign(new Error('not a sealed ABENC1 archive'), { code: 'archive_not_encrypted' });
  }
  const body = buf.subarray(ARCHIVE_MAGIC.length);
  const iv = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(12, body.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function configured() {
  const baseUrl = (process.env.ACCOUNTS_BRIDGE_WORKER_URL || process.env.ACCOUNTS_BRIDGE_URL || DEFAULT_WORKER_URL).trim().replace(/\/+$/, '');
  const apiKey = (process.env.ACCOUNTS_BRIDGE_API_KEY || process.env.FACEBOOK_TOKEN_CLOAK_API_KEY || '').trim();
  const secret = archiveSecret();
  const enabled = process.env.ACCOUNTS_BRIDGE_PROFILE_SYNC !== '0';
  return { enabled, baseUrl, apiKey, secretPresent: !!secret, configured: enabled && !!baseUrl && !!apiKey && !!secret };
}
// Read a role classification for `key` from one non-secret metadata file.
// Returns 'ads_power_editor' / 'page_posting_facebook_lite' when the account is listed,
// or null when the file is missing/unreadable or does not list this account (→ try next source).
function readRoleFromMetadata(file, key) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = Array.isArray(data) ? data.find((a) => String(a.facebookUID || '').trim().toLowerCase() === key) : null;
    if (row) return row.facebookAccountType === 'ads_power_editor' ? 'ads_power_editor' : 'page_posting_facebook_lite';
  } catch {}
  return null;
}
function roleForAccount(rawAccount) {
  const { key } = sanitizeAccount(rawAccount);
  // Primary: IDBridge-owned metadata is authoritative for any account it lists.
  const owned = readRoleFromMetadata(IDBRIDGE_FB_ROLE_METADATA, key);
  if (owned) return owned;
  // PHASE 1 TEMP FALLBACK (remove in Phase 2): consult legacy FBGetToken metadata only when the
  // IDBridge-owned file is missing or does not yet list this account.
  const legacy = readRoleFromMetadata(LEGACY_FBGETTOKEN_ACCOUNTS_JSON, key);
  if (legacy) return legacy;
  return 'page_posting_facebook_lite';
}
function archiveUrl(baseUrl, role, account, action) {
  const uid = encodeURIComponent(sanitizeAccount(account).key);
  return `${baseUrl}/v1/profile-archives/facebook/${role}/${uid}/${action}`;
}
async function ensureWorkerAccountRole(cfg, role, account) {
  const { key } = sanitizeAccount(account);
  const version = new Date().toISOString().replace(/[^0-9A-Za-z._-]/g, '_');
  const accountRes = await fetchWithTimeout(`${cfg.baseUrl}/v1/accounts`, {
    method: 'POST',
    headers: workerHeaders(cfg, { 'content-type': 'application/json' }),
    body: JSON.stringify({ platform: 'facebook', account_uid: key, display_label: key })
  });
  if (!accountRes.ok && accountRes.status !== 409) throw Object.assign(new Error(`account_http_${accountRes.status}`), { code: `account_http_${accountRes.status}` });
  const roleRes = await fetchWithTimeout(`${cfg.baseUrl}/v1/roles/facebook`, {
    method: 'PUT',
    headers: workerHeaders(cfg, { 'content-type': 'application/json' }),
    body: JSON.stringify({ roles: { [role]: key }, source: 'facebook_token_cloak', version })
  });
  if (!roleRes.ok) throw Object.assign(new Error(`role_http_${roleRes.status}`), { code: `role_http_${roleRes.status}` });
  return true;
}
function workerHeaders(cfg, extra = {}) {
  return { 'x-accounts-bridge-key': cfg.apiKey, ...extra };
}
async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
function makeTarGz(profileDir) {
  const manifest = buildManifest(profileDir);
  if (!manifest.length) return { tarGz: null, manifest };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-profile-'));
  const listFile = path.join(tmp, 'manifest.txt');
  const outFile = path.join(tmp, 'browser-data.tar.gz');
  fs.writeFileSync(listFile, manifest.join('\n'));
  const r = spawnSync('/usr/bin/tar', ['-czf', outFile, '-C', profileDir, '-T', listFile], { encoding: 'utf8' });
  if (r.status !== 0) throw Object.assign(new Error('tar archive failed'), { code: 'archive_tar_failed', detail: String(r.stderr || '').slice(0, 200) });
  const tarGz = fs.readFileSync(outFile);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { tarGz, manifest };
}
function extractTarGz(profileDir, tarGz) {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-restore-'));
  const inFile = path.join(tmp, 'browser-data.tar.gz');
  fs.writeFileSync(inFile, tarGz);
  // macOS tar refuses path traversal by default for normal archives; still enforce no absolute paths in listing first.
  const list = spawnSync('/usr/bin/tar', ['-tzf', inFile], { encoding: 'utf8' });
  if (list.status !== 0) throw Object.assign(new Error('tar list failed'), { code: 'archive_tar_invalid' });
  for (const rel of String(list.stdout || '').split(/\n+/).filter(Boolean)) {
    if (!isSafeRel(rel)) throw Object.assign(new Error('archive contains unsafe path'), { code: 'archive_unsafe_path' });
  }
  const r = spawnSync('/usr/bin/tar', ['-xzf', inFile, '-C', profileDir], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw Object.assign(new Error('tar extract failed'), { code: 'archive_extract_failed', detail: String(r.stderr || '').slice(0, 200) });
}
function publicSkip(reason) { return { ok: false, skipped: true, reason }; }
function publicError(code) { return { ok: false, skipped: false, reason: code || 'archive_sync_failed' }; }

// ---- Logged-out archive guard --------------------------------------------
// Overwriting the sealed cloud archive with a profile whose Facebook session has been cleared/logged
// out would DESTROY the good saved session. Before uploadAfterClose seals/uploads, inspect ONLY the
// cookie NAMES in the Chromium Cookies SQLite DB (never a value): a logged-in Facebook session has
// BOTH `c_user` and `xs` cookies for facebook.com. If those are absent we skip the upload. Cookie
// values are never read or logged — the encrypted value blob column is never selected.
function cookiesDbPathFor(profileDir) {
  // Chromium keeps the cookies DB under Default/Cookies (and a bare Cookies on some channels).
  const candidates = [path.join(profileDir, 'Default', 'Cookies'), path.join(profileDir, 'Cookies')];
  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return p; } catch { /* ignore */ }
  }
  return '';
}

// Inspect cookie NAMES only. Returns a token-free presence summary:
//   status 'inspected'         — the DB was read; hasCUser/hasXs reflect the facebook.com cookie names.
//   status 'no_cookies_db'     — no non-empty Cookies DB exists → definitely no session.
//   status 'engine_unavailable'— node:sqlite is missing (older runtime) → cannot prove logged-out.
//   status 'read_error'        — DB present but unreadable (locked/corrupt) → cannot prove logged-out.
// Never reads/returns/logs a cookie value; only the `host_key` + `name` columns are queried.
function inspectFacebookCookieNames(profileDir) {
  const dbPath = cookiesDbPathFor(profileDir);
  if (!dbPath) return { status: 'no_cookies_db', hasCUser: false, hasXs: false, hasFacebookHost: false };
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch { return { status: 'engine_unavailable', hasCUser: false, hasXs: false, hasFacebookHost: false }; }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // NAMES ONLY — host_key + name. The encrypted_value blob is never touched.
    const rows = db.prepare("SELECT host_key, name FROM cookies WHERE host_key LIKE '%facebook.com'").all();
    let hasCUser = false;
    let hasXs = false;
    for (const r of rows) {
      const name = String((r && r.name) || '');
      if (name === 'c_user') hasCUser = true;
      else if (name === 'xs') hasXs = true;
    }
    return { status: 'inspected', hasCUser, hasXs, hasFacebookHost: rows.length > 0 };
  } catch (e) {
    return { status: 'read_error', hasCUser: false, hasXs: false, hasFacebookHost: false, error: e && (e.code || e.name) };
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

// Pure decision from a presence summary. We SKIP the upload only when we can positively conclude the
// session is logged out (cookies inspected and c_user/xs absent, or no cookies DB at all). When we
// genuinely cannot inspect (engine unavailable / read error) we PROCEED, preserving the prior upload
// behavior rather than silently disabling archive sync on an inconclusive read.
function decideArchiveUpload(presence) {
  const p = presence || {};
  if (p.status === 'inspected') {
    const loggedIn = !!(p.hasFacebookHost && p.hasCUser && p.hasXs);
    return loggedIn ? { proceed: true, reason: 'logged_in' } : { proceed: false, reason: 'logged_out_archive_skipped' };
  }
  if (p.status === 'no_cookies_db') return { proceed: false, reason: 'logged_out_archive_skipped' };
  // engine_unavailable / read_error → cannot prove logged-out; keep existing behavior.
  return { proceed: true, reason: p.status === 'engine_unavailable' ? 'cookie_check_engine_unavailable' : 'cookie_check_unreadable' };
}

async function restoreBeforeOpen(rawAccount) {
  const cfg = configured();
  if (!cfg.configured) return publicSkip('not_configured');
  const role = roleForAccount(rawAccount);
  const { key } = sanitizeAccount(rawAccount);
  try {
    await ensureWorkerAccountRole(cfg, role, key);
    const res = await fetchWithTimeout(archiveUrl(cfg.baseUrl, role, key, 'download'), { headers: workerHeaders(cfg) });
    if (res.status === 404) return { ok: true, restored: false, reason: 'archive_not_found', role };
    if (!res.ok) return publicError(`download_http_${res.status}`);
    const envelope = Buffer.from(await res.arrayBuffer());
    const tarGz = unsealArchive(envelope);
    extractTarGz(profileDirFor(key), tarGz);
    return { ok: true, restored: true, role, bytes: envelope.length };
  } catch (e) {
    return publicError(e && (e.code || e.name || e.message));
  }
}

async function uploadAfterClose(rawAccount) {
  const cfg = configured();
  if (!cfg.configured) return publicSkip('not_configured');
  const role = roleForAccount(rawAccount);
  const { key } = sanitizeAccount(rawAccount);
  const profileDir = profileDirFor(key);
  try {
    if (!fs.existsSync(profileDir)) return publicSkip('profile_missing');
    // Logged-out guard: never overwrite the good cloud archive with a logged-out/cleared profile.
    const presence = inspectFacebookCookieNames(profileDir);
    const decision = decideArchiveUpload(presence);
    if (!decision.proceed) {
      console.log(`[profile-archive] upload skipped key=${key} role=${role} reason=${decision.reason} cookie_status=${presence.status}`);
      return publicSkip(decision.reason);
    }
    await ensureWorkerAccountRole(cfg, role, key);
    const { tarGz, manifest } = makeTarGz(profileDir);
    if (!tarGz) return publicSkip('archive_empty');
    const envelope = sealArchive(tarGz);
    const version = encodeURIComponent(new Date().toISOString());
    const source = encodeURIComponent('facebook_token_cloak');
    const res = await fetchWithTimeout(`${archiveUrl(cfg.baseUrl, role, key, 'upload')}?version=${version}&source=${source}`, {
      method: 'POST',
      headers: workerHeaders(cfg, { 'content-type': 'application/octet-stream' }),
      body: envelope
    }, 30000);
    if (!res.ok) return publicError(`upload_http_${res.status}`);
    const body = await res.json().catch(() => ({}));
    return { ok: true, uploaded: true, role, bytes: envelope.length, files: manifest.length, digest: body && body.archive && body.archive.blob_digest ? String(body.archive.blob_digest).slice(0, 12) : undefined };
  } catch (e) {
    return publicError(e && (e.code || e.name || e.message));
  }
}

module.exports = { restoreBeforeOpen, uploadAfterClose, buildManifest, sealArchive, unsealArchive, configured, roleForAccount, inspectFacebookCookieNames, decideArchiveUpload };
