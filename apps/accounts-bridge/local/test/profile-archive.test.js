// Local profile-archive helper — manifest safety + envelope round-trip + HTTP flow.
// Uses a REAL AES-GCM seal/open (node:crypto) with an in-test key (never hard-coded in the module).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  ESSENTIAL_PROFILE_PATHS,
  ARCHIVE_MAGIC,
  isSafeRelativePath,
  buildArchiveManifest,
  sealArchiveEnvelope,
  unsealArchiveEnvelope,
  ProfileArchiveClient
} from '../profile-archive.js';

// AES-256-GCM seal/open with a locally-generated key — stands in for the Keychain-backed sealer.
function makeSealer() {
  const key = crypto.randomBytes(32);
  const seal = (plaintext) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  };
  const open = (ciphertext) => {
    const buf = Buffer.from(ciphertext);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const body = buf.subarray(12, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  };
  return { seal, open };
}

test('isSafeRelativePath refuses absolute paths and traversal', () => {
  assert.equal(isSafeRelativePath('Cookies'), true);
  assert.equal(isSafeRelativePath('Network/Cookies'), true);
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('../../secrets'), false);
  assert.equal(isSafeRelativePath('Local Storage/../../../etc'), false);
  assert.equal(isSafeRelativePath('C:/Windows'), false);
  assert.equal(isSafeRelativePath(''), false);
});

test('buildArchiveManifest collects only existing allowlisted paths', () => {
  const present = new Set(['Cookies', 'Login Data', 'Local Storage']);
  const { included, missing, rejected } = buildArchiveManifest({ exists: (rel) => present.has(rel) });
  assert.deepEqual(included.sort(), ['Cookies', 'Local Storage', 'Login Data']);
  assert.ok(missing.includes('History'));
  assert.deepEqual(rejected, [], 'no allowlist entry should ever be unsafe');
});

test('buildArchiveManifest refuses an injected unsafe path (defence in depth)', () => {
  const { included, rejected } = buildArchiveManifest({
    exists: () => true,
    paths: ['Cookies', '../escape', '/abs']
  });
  assert.ok(included.includes('Cookies'));
  assert.deepEqual(rejected.sort(), ['../escape', '/abs']);
});

test('sealArchiveEnvelope adds the ABENC1 magic and round-trips', () => {
  const { seal, open } = makeSealer();
  const tarGz = Buffer.from('\x1f\x8bfake-tar-gz-with-c_user=plaintext-and-EAA-token', 'binary');
  const envelope = sealArchiveEnvelope(tarGz, seal);
  assert.ok(envelope.subarray(0, 6).equals(ARCHIVE_MAGIC), 'envelope must start with ABENC1');
  assert.ok(!envelope.subarray(6).includes(Buffer.from('c_user=plaintext')), 'ciphertext must not leak plaintext');
  assert.ok(envelope.length > tarGz.length, 'envelope adds overhead');
  const restored = unsealArchiveEnvelope(envelope, open);
  assert.ok(restored.equals(tarGz), 'archive must round-trip through seal/unseal');
});

test('unsealArchiveEnvelope rejects bytes without the ABENC1 magic', () => {
  const { open } = makeSealer();
  assert.throws(() => unsealArchiveEnvelope(Buffer.from('not-sealed-bytes'), open), /ABENC1 sealed archive/);
});

test('ESSENTIAL_PROFILE_PATHS are all safe relative paths', () => {
  for (const p of ESSENTIAL_PROFILE_PATHS) assert.equal(isSafeRelativePath(p), true, p);
});

test('ProfileArchiveClient drives the three routes with the API key (stub fetch)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', key: opts.headers?.['x-accounts-bridge-key'], body: opts.body });
    if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ present: false, archive: null }) };
    if (url.includes('/download')) return { status: 404, ok: false };
    if (url.includes('/upload')) return { ok: true, status: 201, json: async () => ({ archive: { has_archive: true } }) };
    return { ok: false, status: 500 };
  };
  const client = new ProfileArchiveClient({ baseUrl: 'https://bridge.local/', apiKey: 'k', fetchImpl });
  const owner = { platform: 'facebook', role: 'page_posting_facebook_lite', accountUid: 'uidPost' };

  const st = await client.status(owner);
  assert.equal(st.present, false);
  const dl = await client.download(owner);
  assert.equal(dl, null, '404 download returns null (no archive yet)');
  const up = await client.upload({ ...owner, version: 'v1', source: 'accounts_bridge_local', sealedEnvelope: Buffer.concat([ARCHIVE_MAGIC, Buffer.alloc(40)]) });
  assert.equal(up.archive.has_archive, true);

  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(c.key, 'k', 'every call must carry the API key');
  assert.ok(calls[2].url.includes('version=v1'), 'upload sends version/source as query');
});
