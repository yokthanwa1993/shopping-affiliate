// Profile-archive sync tests — restore-on-open / save-on-close, BrowserSaving-style but SEALED.
// Drives the real router against a real D1 (node:sqlite) + an in-memory R2 shim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { makeEnv } from './d1-sqlite.js';

// A locally-sealed ABENC1 envelope: magic "ABENC1" + (fake) nonce/ciphertext/tag. Matches what the
// Swift/Node LocalBlobSealer produces; the Worker validates the shape but never decrypts.
function sealedEnvelope(seed = 7) {
  const magic = [0x41, 0x42, 0x45, 0x4e, 0x43, 0x31]; // ABENC1
  const payload = [];
  for (let i = 0; i < 64; i += 1) payload.push((seed * 31 + i * 7) & 0xff);
  return new Uint8Array([...magic, ...payload]);
}

const ARCHIVE_PATH = '/v1/profile-archives/facebook/page_posting_facebook_lite/100000000000001';

async function call(env, method, path, { body, key, raw } = {}) {
  const headers = {};
  if (key !== null) headers['x-accounts-bridge-key'] = key === undefined ? env.ACCOUNTS_BRIDGE_API_KEY : key;
  let payload;
  if (raw !== undefined) {
    headers['content-type'] = 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const req = new Request('https://bridge.local' + path, { method, headers, body: payload });
  const res = await handleRequest(req, env);
  return res;
}

async function asJson(res) {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function seedOwner(env) {
  const post = (p, b) => handleRequest(new Request('https://bridge.local' + p, { method: 'POST', headers: { 'x-accounts-bridge-key': env.ACCOUNTS_BRIDGE_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(b) }), env);
  const put = (p, b) => handleRequest(new Request('https://bridge.local' + p, { method: 'PUT', headers: { 'x-accounts-bridge-key': env.ACCOUNTS_BRIDGE_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(b) }), env);
  await post('/v1/accounts', { account_uid: '100000000000001', platform: 'facebook' });
  await put('/v1/roles/facebook', { roles: { page_posting_facebook_lite: '100000000000001' } });
}

test('status is absent before any upload', async () => {
  const env = makeEnv();
  await seedOwner(env);
  const { status, json } = await asJson(await call(env, 'GET', ARCHIVE_PATH + '/status'));
  assert.equal(status, 200);
  assert.equal(json.present, false);
  assert.equal(json.archive, null);
});

test('upload seals bytes to R2, returns metadata only, status mirrors it', async () => {
  const env = makeEnv();
  await seedOwner(env);
  const env_payload = sealedEnvelope();

  const up = await asJson(await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v1&source=accounts_bridge_local', { raw: env_payload }));
  assert.equal(up.status, 201);
  assert.equal(up.json.archive.has_archive, true);
  assert.equal(up.json.archive.byte_size, env_payload.byteLength);
  assert.equal(up.json.archive.version, 'v1');
  assert.equal(up.json.archive.cipher, 'aesgcm');
  assert.match(up.json.archive.blob_digest, /^[0-9a-f]{64}$/);
  // The response must never contain the raw bytes / an r2_key field.
  assert.ok(!up.text.includes('r2_key'), 'metadata must not expose r2_key');

  const st = await asJson(await call(env, 'GET', ARCHIVE_PATH + '/status'));
  assert.equal(st.json.present, true);
  assert.equal(st.json.archive.byte_size, env_payload.byteLength);
});

test('download returns the exact sealed bytes with non-secret metadata headers', async () => {
  const env = makeEnv();
  await seedOwner(env);
  const payload = sealedEnvelope(11);
  await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v2&source=accounts_bridge_local', { raw: payload });

  const res = await call(env, 'GET', ARCHIVE_PATH + '/download');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-archive-version'), 'v2');
  assert.equal(res.headers.get('x-archive-size'), String(payload.byteLength));
  assert.match(res.headers.get('x-archive-digest'), /^[0-9a-f]{64}$/);
  const got = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...got], [...payload], 'downloaded ciphertext must match what was uploaded');
});

test('re-upload replaces the current archive (singleton, latest wins)', async () => {
  const env = makeEnv();
  await seedOwner(env);
  await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v1&source=local', { raw: sealedEnvelope(1) });
  const second = sealedEnvelope(2);
  const up2 = await asJson(await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v2&source=local', { raw: second }));
  assert.equal(up2.status, 201);
  assert.equal(up2.json.archive.version, 'v2');

  const res = await call(env, 'GET', ARCHIVE_PATH + '/download');
  const got = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...got], [...second], 'latest upload must win');
});

test('download is 404 before any upload', async () => {
  const env = makeEnv();
  await seedOwner(env);
  const { status, json } = await asJson(await call(env, 'GET', ARCHIVE_PATH + '/download'));
  assert.equal(status, 404);
  assert.equal(json.error, 'archive_not_found');
});

test('upload rejects a raw (unencrypted) gzip archive', async () => {
  const env = makeEnv();
  await seedOwner(env);
  // gzip magic 1f 8b — exactly what BrowserSaving uploads RAW; we must refuse it.
  const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
  const { status, json } = await asJson(await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v1&source=local', { raw: gzip }));
  assert.equal(status, 400);
  assert.equal(json.error, 'archive_not_encrypted');
});

test('upload rejects bytes missing the ABENC1 envelope header', async () => {
  const env = makeEnv();
  await seedOwner(env);
  const bad = new Uint8Array(64).fill(0x42); // no ABENC1 prefix
  const { status, json } = await asJson(await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v1&source=local', { raw: bad }));
  assert.equal(status, 400);
  assert.equal(json.error, 'archive_not_encrypted');
});

test('upload for an account that does not hold the role is refused 409', async () => {
  const env = makeEnv();
  // Account exists but holds no role.
  await handleRequest(new Request('https://bridge.local/v1/accounts', { method: 'POST', headers: { 'x-accounts-bridge-key': env.ACCOUNTS_BRIDGE_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ account_uid: '100000000000001', platform: 'facebook' }) }), env);
  const { status, json } = await asJson(await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v1&source=local', { raw: sealedEnvelope() }));
  assert.equal(status, 409);
  assert.equal(json.error, 'role_mismatch');
});

test('upload for an unknown account is refused 422', async () => {
  const env = makeEnv();
  const { status, json } = await asJson(await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v1&source=local', { raw: sealedEnvelope() }));
  assert.equal(status, 422);
  assert.equal(json.error, 'account_not_found');
});

test('archive routes require the API key', async () => {
  const env = makeEnv();
  for (const [method, suffix, opts] of [['GET', '/status', {}], ['GET', '/download', {}], ['POST', '/upload?version=v1&source=local', { raw: sealedEnvelope() }]]) {
    const res = await call(env, method, ARCHIVE_PATH + suffix, { ...opts, key: null });
    assert.equal(res.status, 401, `${method} ${suffix} without key`);
  }
});

test('archive store fails closed (503) when R2 is unconfigured', async () => {
  const env = makeEnv({ PROFILE_ARCHIVES: undefined });
  await seedOwner(env);
  const { status, json } = await asJson(await call(env, 'POST', ARCHIVE_PATH + '/upload?version=v1&source=local', { raw: sealedEnvelope() }));
  assert.equal(status, 503);
  assert.equal(json.error, 'archive_store_unconfigured');
});
