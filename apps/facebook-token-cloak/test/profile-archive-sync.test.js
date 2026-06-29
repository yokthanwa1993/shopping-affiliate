'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshModule(profileRoot) {
  process.env.FACEBOOK_TOKEN_CLOAK_PROFILE_ROOT = profileRoot;
  process.env.ACCOUNTS_BRIDGE_PROFILE_SYNC = '1';
  process.env.ACCOUNTS_BRIDGE_WORKER_URL = 'https://bridge.test';
  process.env.ACCOUNTS_BRIDGE_API_KEY = 'test-api-key';
  process.env.ACCOUNTS_BRIDGE_ARCHIVE_SECRET = 'test-archive-secret';
  delete require.cache[require.resolve('../src/browser')];
  delete require.cache[require.resolve('../src/profileArchiveSync')];
  return require('../src/profileArchiveSync');
}

test('seal/unseal uses ABENC1 envelope and hides plaintext', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sync-'));
  const sync = freshModule(root);
  const plaintext = Buffer.from('browser-data.tar.gz with cookie-ish text');
  const sealed = sync.sealArchive(plaintext);
  assert.equal(sealed.subarray(0, 6).toString('ascii'), 'ABENC1');
  assert.equal(sealed.includes(Buffer.from('cookie-ish')), false);
  assert.deepEqual(sync.unsealArchive(sealed), plaintext);
});

test('buildManifest only includes allowlisted browser state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sync-'));
  const sync = freshModule(root);
  const profile = path.join(root, 'uid1');
  fs.mkdirSync(path.join(profile, 'Default', 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Cookies'), 'cookie-db');
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), '{}');
  fs.writeFileSync(path.join(profile, 'Default', 'NotAllowed'), 'x');
  const manifest = sync.buildManifest(profile);
  assert.ok(manifest.includes('Default/Cookies'));
  assert.ok(manifest.includes('Default/Preferences'));
  assert.ok(manifest.includes('Default/Local Storage'));
  assert.equal(manifest.includes('Default/NotAllowed'), false);
});

test('restoreBeforeOpen downloads sealed bytes and restores selected files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sync-'));
  const sync = freshModule(root);
  const tarSrc = path.join(root, 'src');
  fs.mkdirSync(path.join(tarSrc, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(tarSrc, 'Default', 'Preferences'), '{"ok":true}');
  const tarPath = path.join(root, 'browser-data.tar.gz');
  require('node:child_process').spawnSync('/usr/bin/tar', ['-czf', tarPath, '-C', tarSrc, 'Default/Preferences']);
  const envelope = sync.sealArchive(fs.readFileSync(tarPath));
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/v1/accounts')) return { ok: true, status: 201, json: async () => ({}) };
    if (String(url).endsWith('/v1/roles/facebook')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, arrayBuffer: async () => envelope.buffer.slice(envelope.byteOffset, envelope.byteOffset + envelope.byteLength) };
  };
  const r = await sync.restoreBeforeOpen('UIDRESTORE');
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.ok(calls.some(c => c.url.endsWith('/v1/accounts')));
  assert.ok(calls.some(c => c.url.endsWith('/v1/roles/facebook')));
  const downloadCall = calls.find(c => c.url.includes('/download'));
  assert.ok(downloadCall);
  assert.equal(downloadCall.opts.headers['x-accounts-bridge-key'], 'test-api-key');
  assert.equal(fs.readFileSync(path.join(root, 'uidrestore', 'Default', 'Preferences'), 'utf8'), '{"ok":true}');
});

test('default Worker URL targets the active accounts-bridge worker when env is unset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sync-'));
  // Clear the explicit URL so the module must fall back to its baked-in DEFAULT_WORKER_URL.
  delete process.env.ACCOUNTS_BRIDGE_WORKER_URL;
  delete process.env.ACCOUNTS_BRIDGE_URL;
  process.env.FACEBOOK_TOKEN_CLOAK_PROFILE_ROOT = root;
  process.env.ACCOUNTS_BRIDGE_PROFILE_SYNC = '1';
  process.env.ACCOUNTS_BRIDGE_API_KEY = 'test-api-key';
  process.env.ACCOUNTS_BRIDGE_ARCHIVE_SECRET = 'test-archive-secret';
  delete require.cache[require.resolve('../src/browser')];
  delete require.cache[require.resolve('../src/profileArchiveSync')];
  const sync = require('../src/profileArchiveSync');
  const cfg = sync.configured();
  assert.equal(cfg.configured, true);
  assert.equal(cfg.baseUrl, 'https://accounts-bridge-worker.yokthanwa1993-bc9.workers.dev');
  assert.equal(cfg.baseUrl.includes('onlyy-gor'), false);
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return { ok: false, status: 500, json: async () => ({}) }; };
  await sync.restoreBeforeOpen('UIDDEFAULT');
  assert.ok(urls.length > 0);
  assert.ok(urls.every(u => u.startsWith('https://accounts-bridge-worker.yokthanwa1993-bc9.workers.dev')), `unexpected target: ${urls.join(', ')}`);
});

test('uploadAfterClose seals tarball and uploads ciphertext only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sync-'));
  const sync = freshModule(root);
  const profile = path.join(root, 'uidupload');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Cookies'), 'raw-cookie-value');
  let uploaded;
  global.fetch = async (url, opts) => {
    if (String(url).endsWith('/v1/accounts')) return { ok: true, status: 201, json: async () => ({}) };
    if (String(url).endsWith('/v1/roles/facebook')) return { ok: true, status: 200, json: async () => ({}) };
    uploaded = Buffer.from(opts.body);
    return { ok: true, status: 201, json: async () => ({ archive: { blob_digest: 'abcdef1234567890' } }) };
  };
  const r = await sync.uploadAfterClose('UIDUPLOAD');
  assert.equal(r.ok, true);
  assert.equal(r.uploaded, true);
  assert.equal(uploaded.subarray(0, 6).toString('ascii'), 'ABENC1');
  assert.equal(uploaded.includes(Buffer.from('raw-cookie-value')), false);
});

// --- Logged-out archive guard (requirement: never overwrite cloud archive with a logged-out profile) ---

function makeCookiesDb(filePath, names) {
  // Build a minimal Chromium-shaped cookies table with NAMES only (no value column needed for the
  // guard, which inspects names exclusively). host_key uses the leading-dot facebook.com form.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB)');
  for (const name of names) {
    const stmt = db.prepare('INSERT INTO cookies (host_key, name, encrypted_value) VALUES (?, ?, ?)');
    stmt.run('.facebook.com', name, Buffer.from('ENCRYPTED-NEVER-READ'));
  }
  db.close();
}

test('inspectFacebookCookieNames detects a logged-in session (c_user + xs) by NAME only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cookie-'));
  const sync = freshModule(root);
  const profile = path.join(root, 'p1');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  makeCookiesDb(path.join(profile, 'Default', 'Cookies'), ['datr', 'c_user', 'xs', 'fr']);
  const presence = sync.inspectFacebookCookieNames(profile);
  assert.equal(presence.status, 'inspected');
  assert.equal(presence.hasCUser, true);
  assert.equal(presence.hasXs, true);
  assert.deepEqual(sync.decideArchiveUpload(presence), { proceed: true, reason: 'logged_in' });
});

test('inspectFacebookCookieNames flags a logged-out profile (no c_user/xs) → upload skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cookie-'));
  const sync = freshModule(root);
  const profile = path.join(root, 'p2');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  makeCookiesDb(path.join(profile, 'Default', 'Cookies'), ['datr', 'fr']);
  const presence = sync.inspectFacebookCookieNames(profile);
  assert.equal(presence.status, 'inspected');
  assert.equal(presence.hasCUser, false);
  assert.equal(presence.hasXs, false);
  assert.deepEqual(sync.decideArchiveUpload(presence), { proceed: false, reason: 'logged_out_archive_skipped' });
});

test('decideArchiveUpload: missing cookies DB → skip; unreadable/engine-missing → proceed (preserve behavior)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cookie-'));
  const sync = freshModule(root);
  // No cookies DB at all → definitely logged out → skip.
  assert.equal(sync.decideArchiveUpload({ status: 'no_cookies_db' }).proceed, false);
  assert.equal(sync.decideArchiveUpload({ status: 'no_cookies_db' }).reason, 'logged_out_archive_skipped');
  // Cannot inspect (older runtime / locked DB) → cannot prove logged-out → proceed.
  assert.equal(sync.decideArchiveUpload({ status: 'engine_unavailable' }).proceed, true);
  assert.equal(sync.decideArchiveUpload({ status: 'read_error' }).proceed, true);
});

test('uploadAfterClose SKIPS upload for a logged-out profile and never calls the upload endpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cookie-'));
  const sync = freshModule(root);
  const profile = path.join(root, 'uidloggedout');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  // Logged-out cookies DB (no c_user/xs) plus some allowlisted state that WOULD otherwise archive.
  makeCookiesDb(path.join(profile, 'Default', 'Cookies'), ['datr']);
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), '{}');
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith('/v1/accounts')) return { ok: true, status: 201, json: async () => ({}) };
    if (String(url).endsWith('/v1/roles/facebook')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 201, json: async () => ({}) };
  };
  const r = await sync.uploadAfterClose('UIDLOGGEDOUT');
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'logged_out_archive_skipped');
  // Critically: the upload endpoint was never hit (the cloud archive is untouched).
  assert.equal(calls.some(u => u.includes('/upload')), false);
});

test('uploadAfterClose PROCEEDS to upload for a logged-in profile (c_user + xs present)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-cookie-'));
  const sync = freshModule(root);
  const profile = path.join(root, 'uidloggedin');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  makeCookiesDb(path.join(profile, 'Default', 'Cookies'), ['c_user', 'xs']);
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), '{}');
  let uploaded = false;
  global.fetch = async (url, opts) => {
    if (String(url).endsWith('/v1/accounts')) return { ok: true, status: 201, json: async () => ({}) };
    if (String(url).endsWith('/v1/roles/facebook')) return { ok: true, status: 200, json: async () => ({}) };
    if (String(url).includes('/upload')) { uploaded = true; return { ok: true, status: 201, json: async () => ({ archive: { blob_digest: 'abcdef1234567890' } }) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const r = await sync.uploadAfterClose('UIDLOGGEDIN');
  assert.equal(r.ok, true);
  assert.equal(r.uploaded, true);
  assert.equal(uploaded, true);
});
