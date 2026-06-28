// Account CRUD tests — the real Cloud Account Manager surface. Drives the router against a real
// (node:sqlite) D1. Covers create (with non-secret metadata), list (archived hidden), single read,
// update, soft-archive, secret-field rejection, and numeric-uid validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { makeEnv } from './d1-sqlite.js';

const UID = '100090320823561';
const UID2 = '100090320823562';

async function call(env, method, path, { body, key } = {}) {
  const headers = {};
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
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, json: parsed, text };
}

test('create account stores non-secret metadata and echoes it back', async () => {
  const env = makeEnv();
  const create = await call(env, 'POST', '/v1/accounts', {
    body: {
      account_uid: UID,
      platform: 'facebook',
      display_label: 'Chanalai',
      notes: 'main posting account',
      tags: ['post', 'main', 'post'], // dedupe expected
      page_label: 'เพจหลัก',
      account_role: 'post',
      preferred_agent_id: 'mac-mini-01'
    }
  });
  assert.equal(create.status, 201);
  assert.equal(create.json.created, true);
  const a = create.json.account;
  assert.equal(a.account_uid, UID);
  assert.equal(a.display_label, 'Chanalai');
  assert.equal(a.notes, 'main posting account');
  assert.deepEqual(a.tags, ['post', 'main']);
  assert.equal(a.page_label, 'เพจหลัก');
  assert.equal(a.account_role, 'post');
  assert.equal(a.preferred_agent_id, 'mac-mini-01');
  assert.equal(a.status, 'active');
});

test('GET single account returns the stored shape; 404 for unknown', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook', display_label: 'A' } });
  const got = await call(env, 'GET', `/v1/accounts/facebook/${UID}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.account.account_uid, UID);

  const missing = await call(env, 'GET', `/v1/accounts/facebook/${UID2}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'account_not_found');
});

test('PATCH updates only provided fields and is idempotent for absent keys', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook', display_label: 'A', notes: 'keep me' } });

  const patch = await call(env, 'PATCH', `/v1/accounts/facebook/${UID}`, {
    body: { display_label: 'A renamed', tags: 'ads,promo', account_role: 'ads' }
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.account.display_label, 'A renamed');
  assert.deepEqual(patch.json.account.tags, ['ads', 'promo']);
  assert.equal(patch.json.account.account_role, 'ads');
  // notes was NOT in the body — must be untouched.
  assert.equal(patch.json.account.notes, 'keep me');

  const missing = await call(env, 'PATCH', `/v1/accounts/facebook/${UID2}`, { body: { notes: 'x' } });
  assert.equal(missing.status, 404);
});

test('PATCH status=disabled maps to the stored inactive status', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook' } });
  const patch = await call(env, 'PATCH', `/v1/accounts/facebook/${UID}`, { body: { status: 'disabled' } });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.account.status, 'inactive');
});

test('DELETE soft-archives (status archived) and never removes the row', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook' } });
  const del = await call(env, 'DELETE', `/v1/accounts/facebook/${UID}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.archived, true);
  assert.equal(del.json.account.status, 'archived');

  // Still fetchable by id (not deleted), just archived.
  const got = await call(env, 'GET', `/v1/accounts/facebook/${UID}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.account.status, 'archived');
});

test('list hides archived by default and includes them with include_archived=1', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook' } });
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID2, platform: 'facebook' } });
  await call(env, 'DELETE', `/v1/accounts/facebook/${UID2}`);

  const visible = await call(env, 'GET', '/v1/accounts?platform=facebook');
  assert.equal(visible.json.accounts.length, 1);
  assert.equal(visible.json.accounts[0].account_uid, UID);

  const all = await call(env, 'GET', '/v1/accounts?platform=facebook&include_archived=1');
  assert.equal(all.json.accounts.length, 2);
});

test('create rejects a non-numeric / too-short account_uid', async () => {
  const env = makeEnv();
  const bad = await call(env, 'POST', '/v1/accounts', { body: { account_uid: 'not-a-number', platform: 'facebook' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_account_uid');

  const short = await call(env, 'POST', '/v1/accounts', { body: { account_uid: '123', platform: 'facebook' } });
  assert.equal(short.status, 400);
  assert.equal(short.json.error, 'bad_account_uid');
});

test('create rejects a secret-shaped field with secret_field_rejected (and never echoes the value)', async () => {
  const env = makeEnv();
  const bad = await call(env, 'POST', '/v1/accounts', {
    body: { account_uid: UID, platform: 'facebook', access_token: 'EAABwzLixnjYsecret', notes: 'x' }
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'secret_field_rejected');
  assert.ok(!bad.text.includes('EAABwzLixnjY'), 'must not echo the secret value');

  // Nested secret key (e.g. proxy_password) is also rejected.
  const nested = await call(env, 'POST', '/v1/accounts', {
    body: { account_uid: UID, platform: 'facebook', meta: { proxy_password: 'hunter2' } }
  });
  assert.equal(nested.status, 400);
  assert.equal(nested.json.error, 'secret_field_rejected');

  // Nothing was created.
  const list = await call(env, 'GET', '/v1/accounts?platform=facebook&include_archived=1');
  assert.equal(list.json.accounts.length, 0);
});

test('PATCH also rejects a secret-shaped field', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook' } });
  const bad = await call(env, 'PATCH', `/v1/accounts/facebook/${UID}`, { body: { cookie: 'datr=abc' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'secret_field_rejected');
});

test('account writes require the bridge API key', async () => {
  const env = makeEnv();
  const noKey = await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook' }, key: null });
  assert.equal(noKey.status, 401);
});
