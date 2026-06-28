// Security-invariant tests: auth required, status-only (no browser/token-mint code path), no blob
// ever leaves a GET, and fail-closed when the API key is unconfigured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../src/router.js';
import { makeEnv } from './d1-sqlite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

function req(method, p, { key, body } = {}) {
  const headers = {};
  if (key) headers['x-accounts-bridge-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request('https://bridge.local' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('every /v1 endpoint rejects a missing or wrong API key with 401', async () => {
  const env = makeEnv();
  const probes = [
    ['POST', '/v1/admin/bootstrap'],
    ['GET', '/v1/accounts'],
    ['POST', '/v1/accounts'],
    ['GET', '/v1/roles/facebook'],
    ['PUT', '/v1/roles/facebook'],
    ['GET', '/v1/pages/1/binding'],
    ['PUT', '/v1/pages/1/binding'],
    ['POST', '/v1/sessions'],
    ['GET', '/v1/sessions/status?account_uid=x&role=ads_power_editor'],
    ['POST', '/v1/cookies'],
    ['POST', '/v1/audit/events'],
    ['GET', '/v1/profile-archives/facebook/page_posting_facebook_lite/100000000000001/status'],
    ['GET', '/v1/profile-archives/facebook/page_posting_facebook_lite/100000000000001/download'],
    ['POST', '/v1/profile-archives/facebook/page_posting_facebook_lite/100000000000001/upload?version=v1&source=local']
  ];
  for (const [method, p] of probes) {
    const missing = await handleRequest(req(method, p), env);
    assert.equal(missing.status, 401, `${method} ${p} without key`);
    const wrong = await handleRequest(req(method, p, { key: 'nope' }), env);
    assert.equal(wrong.status, 401, `${method} ${p} wrong key`);
  }
});

test('fails closed (503) when the API key is not configured — never open', async () => {
  const env = makeEnv({ ACCOUNTS_BRIDGE_API_KEY: '' });
  const res = await handleRequest(req('GET', '/v1/accounts', { key: 'anything' }), env);
  assert.equal(res.status, 503);
});

test('health stays public even with no key configured', async () => {
  const env = makeEnv({ ACCOUNTS_BRIDGE_API_KEY: '' });
  const res = await handleRequest(req('GET', '/health'), env);
  assert.equal(res.status, 200);
});

test('the worker source contains NO browser/login/token-mint code path (status-only API)', () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
  const blob = files.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  // Forbidden capabilities for a status/config API. (Regexes, so PLAINTEXT_SECRET_RE etc. don't trip.)
  const forbidden = [
    /playwright/i,
    /chromium|chrome\b/i,
    /openPage\s*\(/i,
    /launchPersistentContext/i,
    /facebookLogin/i,
    /\bautofill\b/i,
    /mintToken|refreshToken|convertToken/i
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(blob), `worker source must not reference ${re}`);
  }
});

test('no GET response over a populated DB ever contains the ciphertext or the encrypted_blob column', async () => {
  const env = makeEnv();
  const KEY = env.ACCOUNTS_BRIDGE_API_KEY;
  const CIPHER = 'enc:v1:populated-db-fake-cipher-not-secret';
  const post = (p, body) => handleRequest(req('POST', p, { key: KEY, body }), env);
  const put = (p, body) => handleRequest(req('PUT', p, { key: KEY, body }), env);

  await post('/v1/accounts', { account_uid: '100000000000001', platform: 'facebook' });
  await put('/v1/roles/facebook', { roles: { page_posting_facebook_lite: '100000000000001' } });
  await put('/v1/pages/777/binding', { account_uid: '100000000000001', role: 'page_posting_facebook_lite' });
  await post('/v1/sessions', { account_uid: '100000000000001', platform: 'facebook', role: 'page_posting_facebook_lite', version: 'v1', source: 's', encrypted_blob: CIPHER });
  await post('/v1/cookies', { account_uid: '100000000000001', platform: 'facebook', version: 'v1', source: 's', encrypted_blob: CIPHER });

  const gets = [
    '/v1/accounts',
    '/v1/roles/facebook',
    '/v1/pages/777/binding',
    '/v1/sessions/status?account_uid=100000000000001&role=page_posting_facebook_lite&platform=facebook'
  ];
  for (const p of gets) {
    const res = await handleRequest(req('GET', p, { key: KEY }), env);
    const text = await res.text();
    assert.ok(!text.includes(CIPHER), `${p} leaked ciphertext`);
    assert.ok(!text.includes('encrypted_blob'), `${p} named encrypted_blob`);
  }
});
