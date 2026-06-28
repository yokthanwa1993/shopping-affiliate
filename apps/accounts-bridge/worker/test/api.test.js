// API behaviour tests — drive the real router against a real (node:sqlite) D1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { makeEnv } from './d1-sqlite.js';

// A believable ciphertext that matches none of the plaintext-secret tripwires.
const FAKE_CIPHERTEXT = 'enc:v1:Zm9vYmFyLWZha2UtY2lwaGVydGV4dC1ub3Qtc2VjcmV0';

async function call(env, method, path, { body, key } = {}) {
  const headers = {};
  // key === null -> omit header; undefined -> use the configured key; string -> use as given.
  if (key !== null) headers['x-accounts-bridge-key'] = key === undefined ? env.ACCOUNTS_BRIDGE_API_KEY : key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request('https://bridge.local' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const res = await handleRequest(req, env);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, json: parsed, text };
}

function assertNoBlobLeak(text) {
  assert.ok(!text.includes('encrypted_blob'), 'response must not name encrypted_blob');
  assert.ok(!text.includes(FAKE_CIPHERTEXT), 'response must not echo the ciphertext blob');
}

test('GET /health is public and advertises the two roles', async () => {
  const env = makeEnv();
  const { status, json } = await call(env, 'GET', '/health', { key: null });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.roles, ['page_posting_facebook_lite', 'ads_power_editor']);
});

test('account create + list is token-free', async () => {
  const env = makeEnv();
  const create = await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100090320823561', platform: 'facebook', display_label: 'Chanalai' } });
  assert.equal(create.status, 201);
  assert.equal(create.json.created, true);
  assert.equal(create.json.account.account_uid, '100090320823561');
  // idempotent re-create
  const again = await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100090320823561', platform: 'facebook' } });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);

  const list = await call(env, 'GET', '/v1/accounts?platform=facebook');
  assert.equal(list.status, 200);
  assert.equal(list.json.accounts.length, 1);
  assertNoBlobLeak(list.text);
});

test('role mapping assign/read; unknown account is rejected 422', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100000000000001', platform: 'facebook' } });

  const bad = await call(env, 'PUT', '/v1/roles/facebook', { body: { roles: { page_posting_facebook_lite: 'ghost-account' } } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, 'account_not_found');

  const ok = await call(env, 'PUT', '/v1/roles/facebook', { body: { roles: { page_posting_facebook_lite: '100000000000001' }, source: 'operator', version: 'v1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.roles.page_posting_facebook_lite.account_uid, '100000000000001');
  assert.equal(ok.json.roles.ads_power_editor, null);

  const read = await call(env, 'GET', '/v1/roles/facebook');
  assert.equal(read.json.roles.page_posting_facebook_lite.account_uid, '100000000000001');
});

test('page binding rejects a mismatched account/role and accepts the rightful owner', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100000000000001', platform: 'facebook' } });
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100000000000002', platform: 'facebook' } });
  await call(env, 'PUT', '/v1/roles/facebook', { body: { roles: { page_posting_facebook_lite: '100000000000001', ads_power_editor: '100000000000002' } } });

  // Binding the page-posting role to the ads account must be refused (role/account drift).
  const mismatch = await call(env, 'PUT', '/v1/pages/61550/binding', { body: { account_uid: '100000000000002', role: 'page_posting_facebook_lite' } });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.error, 'role_mismatch');

  // Binding to the account that actually holds the role succeeds.
  const ok = await call(env, 'PUT', '/v1/pages/61550/binding', { body: { account_uid: '100000000000001', role: 'page_posting_facebook_lite', source: 'operator' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.binding.account_uid, '100000000000001');

  const read = await call(env, 'GET', '/v1/pages/61550/binding');
  assert.equal(read.json.bindings.length, 1);
  assert.equal(read.json.bindings[0].role, 'page_posting_facebook_lite');
});

test('session store returns digest/flags but never the blob; status mirrors it', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100000000000001', platform: 'facebook' } });
  await call(env, 'PUT', '/v1/roles/facebook', { body: { roles: { page_posting_facebook_lite: '100000000000001' } } });

  const store = await call(env, 'POST', '/v1/sessions', {
    body: { account_uid: '100000000000001', platform: 'facebook', role: 'page_posting_facebook_lite', version: 'v1', source: 'facebook_lite_bridge', encrypted_blob: FAKE_CIPHERTEXT }
  });
  assert.equal(store.status, 201);
  assert.equal(store.json.session.has_blob, true);
  assert.equal(store.json.session.encrypted_blob, undefined);
  assert.match(store.json.session.blob_digest, /^[0-9a-f]{64}$/);
  assertNoBlobLeak(store.text);

  const status = await call(env, 'GET', '/v1/sessions/status?account_uid=100000000000001&role=page_posting_facebook_lite&platform=facebook');
  assert.equal(status.status, 200);
  assert.equal(status.json.present, true);
  assert.equal(status.json.count, 1);
  assert.equal(status.json.latest.encrypted_blob, undefined);
  assertNoBlobLeak(status.text);
});

test('session store rejects a plaintext-looking secret blob', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100000000000001', platform: 'facebook' } });
  await call(env, 'PUT', '/v1/roles/facebook', { body: { roles: { page_posting_facebook_lite: '100000000000001' } } });

  const res = await call(env, 'POST', '/v1/sessions', {
    body: { account_uid: '100000000000001', platform: 'facebook', role: 'page_posting_facebook_lite', version: 'v1', source: 'x', encrypted_blob: 'fb_dtsg=plaintext-test-value; c_user=123' }
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'blob_not_encrypted');
  // The offending value must NOT be echoed back.
  assert.ok(!res.text.includes('fb_dtsg=plaintext-test-value; c_user=123'));
});

test('session store for an account that does not hold the role is refused 409', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100000000000001', platform: 'facebook' } });
  const res = await call(env, 'POST', '/v1/sessions', {
    body: { account_uid: '100000000000001', platform: 'facebook', role: 'page_posting_facebook_lite', version: 'v1', source: 'x', encrypted_blob: FAKE_CIPHERTEXT }
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'role_mismatch');
});

test('audit events accept non-secret detail and reject secret-looking detail keys', async () => {
  const env = makeEnv();
  const ok = await call(env, 'POST', '/v1/audit/events', { body: { event_type: 'page_token.minted', platform: 'facebook', account_uid: '100000000000001', detail: { note: 'token minted from facebook_lite' } } });
  assert.equal(ok.status, 201);

  const bad = await call(env, 'POST', '/v1/audit/events', { body: { event_type: 'x', detail: { access_token: 'whatever' } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'forbidden_detail');
});


test('admin bootstrap applies the fixed schema and is token-free', async () => {
  const env = makeEnv({ applyMigration: false });
  const boot = await call(env, 'POST', '/v1/admin/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.json.ok, true);
  assert.ok(boot.json.tables.includes('accounts'));
  assert.ok(boot.json.tables.includes('session_records'));
  assertNoBlobLeak(boot.text);

  const create = await call(env, 'POST', '/v1/accounts', { body: { account_uid: '100000000000003', platform: 'facebook' } });
  assert.equal(create.status, 201);
});
