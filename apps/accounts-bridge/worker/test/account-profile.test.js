// BrowserSaving-style profile tests: richer non-secret metadata (tag/homepage/email), the WRITE-ONLY
// encrypted credential vault (password/datr_cookie/totp_secret/proxy_url — presence flags only, never
// raw values), and avatar upload/stream/validation. Driven against a real (node:sqlite) D1 + R2 shim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { makeEnv } from './d1-sqlite.js';

const UID = '100090320823561';

// A real 1x1 PNG (valid signature) so detectImageMime accepts it.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
  return { status: res.status, json: parsed, text, res };
}

async function seed(env) {
  await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook', display_label: 'Chanalai' } });
}

test('create accepts the BrowserSaving tag + homepage + email and echoes them back', async () => {
  const env = makeEnv();
  const create = await call(env, 'POST', '/v1/accounts', {
    body: {
      account_uid: UID,
      platform: 'facebook',
      display_label: 'Chanalai',
      tag: 'comment',
      homepage_url: 'https://facebook.com/chanalai',
      email: 'ops@example.com'
    }
  });
  assert.equal(create.status, 201);
  const a = create.json.account;
  assert.equal(a.tag, 'comment');
  assert.equal(a.homepage_url, 'https://facebook.com/chanalai');
  assert.equal(a.email, 'ops@example.com');
  // The credential vault starts empty + avatar absent.
  assert.deepEqual(a.credential_presence, { password: false, datr_cookie: false, totp_secret: false, proxy_url: false });
  assert.equal(a.avatar_present, false);
  assert.equal(a.proxy_host_hint, null);
});

test('tag must be one of post/comment/mobile', async () => {
  const env = makeEnv();
  const bad = await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook', tag: 'spam' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_tag');
});

test('invalid email is rejected', async () => {
  const env = makeEnv();
  const bad = await call(env, 'POST', '/v1/accounts', { body: { account_uid: UID, platform: 'facebook', email: 'not-an-email' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_email');
});

test('credential vault is write-only: stores presence + proxy hint, never returns raw values', async () => {
  const env = makeEnv();
  await seed(env);
  const put = await call(env, 'PUT', `/v1/accounts/facebook/${UID}/credentials`, {
    body: {
      password: 'hunter2-secret',
      datr_cookie: 'datrCOOKIEvalue1234',
      totp_secret: 'JBSWY3DPEHPK3PXP',
      proxy_url: 'socks5://proxyuser:proxypass@1.2.3.4:1080'
    }
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.credential_presence, { password: true, datr_cookie: true, totp_secret: true, proxy_url: true });
  // Host-only proxy hint — credentials stripped.
  assert.equal(put.json.proxy_host_hint, 'socks5://1.2.3.4:1080');
  // The PUT response must NOT echo any raw secret.
  for (const leak of ['hunter2-secret', 'datrCOOKIEvalue1234', 'JBSWY3DPEHPK3PXP', 'proxyuser', 'proxypass']) {
    assert.ok(!put.text.includes(leak), `PUT leaked ${leak}`);
  }

  // GET single + list must also expose presence only — never the raw values or the ciphertext.
  const got = await call(env, 'GET', `/v1/accounts/facebook/${UID}`);
  assert.deepEqual(got.json.account.credential_presence, { password: true, datr_cookie: true, totp_secret: true, proxy_url: true });
  assert.equal(got.json.account.proxy_host_hint, 'socks5://1.2.3.4:1080');
  const list = await call(env, 'GET', '/v1/accounts?platform=facebook');
  for (const leak of ['hunter2-secret', 'datrCOOKIEvalue1234', 'JBSWY3DPEHPK3PXP', 'proxypass', 'encrypted_blob']) {
    assert.ok(!got.text.includes(leak) && !list.text.includes(leak), `GET leaked ${leak}`);
  }
});

test('credential PUT leaves absent fields untouched and clears with clear_<field>', async () => {
  const env = makeEnv();
  await seed(env);
  await call(env, 'PUT', `/v1/accounts/facebook/${UID}/credentials`, {
    body: { password: 'p1', proxy_url: 'http://u:p@host.example:3128' }
  });
  // Re-save metadata-only credentials call (only datr now); password + proxy must remain.
  const second = await call(env, 'PUT', `/v1/accounts/facebook/${UID}/credentials`, { body: { datr_cookie: 'd1' } });
  assert.deepEqual(second.json.credential_presence, { password: true, datr_cookie: true, totp_secret: false, proxy_url: true });

  // Explicitly clear the password; everything else stays.
  const cleared = await call(env, 'PUT', `/v1/accounts/facebook/${UID}/credentials`, { body: { clear_password: true } });
  assert.deepEqual(cleared.json.credential_presence, { password: false, datr_cookie: true, totp_secret: false, proxy_url: true });
});

test('credentials require an existing account + the API key', async () => {
  const env = makeEnv();
  const missing = await call(env, 'PUT', `/v1/accounts/facebook/${UID}/credentials`, { body: { password: 'x' } });
  assert.equal(missing.status, 404);
  const noKey = await call(env, 'PUT', `/v1/accounts/facebook/${UID}/credentials`, { body: { password: 'x' }, key: null });
  assert.equal(noKey.status, 401);
});

test('avatar upload (JSON data_url) stores the image, flags the account, and streams it back', async () => {
  const env = makeEnv();
  await seed(env);
  const up = await call(env, 'PUT', `/v1/accounts/facebook/${UID}/avatar`, {
    body: { data_url: `data:image/png;base64,${PNG_1x1_B64}` }
  });
  assert.equal(up.status, 200);
  assert.equal(up.json.account.avatar_present, true);
  assert.equal(up.json.account.avatar_mime, 'image/png');

  // GET streams the bytes with the right content-type.
  const req = new Request(`https://bridge.local/v1/accounts/facebook/${UID}/avatar`, {
    method: 'GET',
    headers: { 'x-accounts-bridge-key': env.ACCOUNTS_BRIDGE_API_KEY }
  });
  const res = await handleRequest(req, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.ok(buf.byteLength > 12);
  assert.equal(buf[0], 0x89); // PNG signature survived the round trip

  // DELETE removes it.
  const del = await call(env, 'DELETE', `/v1/accounts/facebook/${UID}/avatar`);
  assert.equal(del.status, 200);
  assert.equal(del.json.account.avatar_present, false);
});

test('avatar rejects a non-image payload by signature', async () => {
  const env = makeEnv();
  await seed(env);
  const notImage = Buffer.from('hello world this is not an image', 'utf8').toString('base64');
  const bad = await call(env, 'PUT', `/v1/accounts/facebook/${UID}/avatar`, { body: { base64: notImage } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_avatar_type');
});

test('avatar upload requires an existing account (422)', async () => {
  const env = makeEnv();
  const bad = await call(env, 'PUT', `/v1/accounts/facebook/${UID}/avatar`, {
    body: { data_url: `data:image/png;base64,${PNG_1x1_B64}` }
  });
  assert.equal(bad.status, 422);
});
