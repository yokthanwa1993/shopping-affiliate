'use strict';

// Tests for the optional cloud Accounts Bridge poller. Everything is injected — NO real Cloudflare,
// NO real browser. Proves: it stays off unless configured, never autofills/submits/mints, syncs only
// token-free account fields, and never uploads a secret-shaped key in a command result.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPoller, maybeStartPoller, readConfig, sanitizeAgentId, stripSecrets } = require('../src/accountsBridgePoller');

const CONFIGURED_ENV = {
  ACCOUNTS_BRIDGE_WORKER_URL: 'https://bridge.example.workers.dev',
  ACCOUNTS_BRIDGE_API_KEY: 'test-bridge-key-AAAA',
  ACCOUNTS_BRIDGE_AGENT_ID: 'Mac Mini #1'
};

// A recording fetch: returns canned responses keyed by a substring of the URL, records every call.
function makeFetch(routes) {
  const calls = [];
  async function fetchImpl(url, opts = {}) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });
    for (const [needle, responder] of routes) {
      if (url.includes(needle)) {
        const r = typeof responder === 'function' ? responder({ url, opts, body }) : responder;
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json || {} };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function mockRegistry(accounts) {
  return { listAccounts: async () => accounts };
}

// A profileArchiveSync mock that records call order so tests can prove restore-before-open and
// upload-after-close, without touching R2/the network/the filesystem.
function mockArchiveSync(order = [], overrides = {}) {
  return {
    restoreBeforeOpen: async (account) => { order.push(`restore:${account}`); return overrides.restore || { ok: true, restored: true, role: 'page_posting_facebook_lite', bytes: 1234 }; },
    uploadAfterClose: async (account) => { order.push(`upload:${account}`); return overrides.upload || { ok: true, uploaded: true, role: 'page_posting_facebook_lite', bytes: 4321, files: 9 }; }
  };
}

const SECRET_KEYS_RE = /password|token|cookie|secret|datr|dtsg|totp/i;
function assertNoSecretKeys(obj) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, nested] of Object.entries(v)) {
        assert.ok(!SECRET_KEYS_RE.test(k), `secret-shaped key leaked: ${k}`);
        walk(nested);
      }
    }
  };
  walk(obj);
}

test('readConfig: disabled when no API key is present, enabled when both URL + key are set', () => {
  assert.equal(readConfig({}).enabled, false);
  assert.equal(readConfig({ ACCOUNTS_BRIDGE_WORKER_URL: 'https://x' }).enabled, false);
  const cfg = readConfig(CONFIGURED_ENV);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.configured, true);
  assert.equal(cfg.agentId, 'mac-mini-1'); // sanitized from "Mac Mini #1"
});

test('readConfig: ACCOUNTS_BRIDGE_AGENT_POLL=0 disables even when configured', () => {
  assert.equal(readConfig({ ...CONFIGURED_ENV, ACCOUNTS_BRIDGE_AGENT_POLL: '0' }).enabled, false);
});

test('sanitizeAgentId produces a stable lowercase id and never empty', () => {
  assert.equal(sanitizeAgentId('Mac Mini'), 'mac-mini');
  assert.equal(sanitizeAgentId('  '), 'mac-mini');
  assert.equal(sanitizeAgentId('AGENT_07.beta'), 'agent_07.beta');
});

test('maybeStartPoller returns null (no-op) when not configured and never touches the network', () => {
  let touched = false;
  const fetchImpl = () => { touched = true; throw new Error('should not be called'); };
  const handle = maybeStartPoller({ env: {}, fetch: fetchImpl, browser: {}, accountsRegistry: mockRegistry([]) });
  assert.equal(handle, null);
  assert.equal(touched, false);
});

test('constructing a poller does NOT start polling or hit the network', () => {
  const fetchImpl = makeFetch([]);
  createPoller({ env: CONFIGURED_ENV, fetch: fetchImpl, browser: {}, accountsRegistry: mockRegistry([]) });
  assert.equal(fetchImpl.calls.length, 0);
});

test('syncAccounts uploads ONLY token-free identity fields (uid + display label), no hints/secrets', async () => {
  const fetchImpl = makeFetch([['/v1/accounts', { status: 201 }]]);
  const registry = mockRegistry([
    { key: 'chearb', account: 'CHEARB', displayName: 'Chearb Page', username: 'u@example.com', email: 'u@example.com', phone: '+66000000000' },
    { key: 'content_paiya', account: 'CONTENT_PAIYA', displayName: null }
  ]);
  const poller = createPoller({ env: CONFIGURED_ENV, fetch: fetchImpl, browser: {}, accountsRegistry: registry });
  const res = await poller.syncAccounts();
  assert.equal(res.total, 2);
  assert.equal(res.synced, 2);
  const posts = fetchImpl.calls.filter((c) => c.url.includes('/v1/accounts'));
  assert.equal(posts.length, 2);
  for (const post of posts) {
    assert.equal(post.headers['x-accounts-bridge-key'], 'test-bridge-key-AAAA');
    assert.deepEqual(Object.keys(post.body).sort(), ['account_uid', 'display_label', 'platform']);
    assert.equal(post.body.platform, 'facebook');
    assert.ok(!JSON.stringify(post.body).includes('@example.com'), 'username/email hint must not be uploaded');
    assert.ok(!JSON.stringify(post.body).includes('+66000000000'), 'phone hint must not be uploaded');
  }
});

test('open_profile reuses the safe visible open (no autofill/submit) and reports a sanitized result', async () => {
  const order = [];
  const openCalls = [];
  const browser = {
    openPage: async (account, url, options) => {
      order.push(`open:${account}`);
      openCalls.push({ account, url, options });
      // Even if the browser layer returned a secret-shaped field, it must be stripped before upload.
      return { profileDir: 'chearb', reused: false, access_token: 'EAABsecret-should-be-stripped' };
    }
  };
  const poller = createPoller({ env: CONFIGURED_ENV, fetch: makeFetch([]), browser, accountsRegistry: mockRegistry([]), profileArchiveSync: mockArchiveSync(order) });
  const outcome = await poller.runCommand({ id: 'cmd_1', action: 'open_profile', account_uid: 'chearb' });
  assert.equal(outcome.status, 'succeeded');
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].account, 'chearb');
  assert.equal(openCalls[0].url, 'https://www.facebook.com/');
  assert.equal(openCalls[0].options.visible, true);
  assert.equal(openCalls[0].options.reuse, true);
  // CRITICAL: autofill and submit are never enabled by the agent path.
  assert.notEqual(openCalls[0].options.autofill, true);
  assert.notEqual(openCalls[0].options.submit, true);
  // BrowserSaving parity: the sealed archive is restored BEFORE the window is opened.
  assert.deepEqual(order, ['restore:chearb', 'open:chearb']);
  assert.equal(outcome.result.archiveSync.restored, true);
  assertNoSecretKeys(outcome.result);
  assert.equal(outcome.result.access_token, undefined);
  assert.equal(outcome.result.opened, true);
});

test('open_profile restore-before-open metadata is sanitized of any secret-shaped key', async () => {
  const browser = { openPage: async () => ({ profileDir: 'chearb', reused: true }) };
  // Even if archive sync somehow surfaced a secret-shaped field, stripSecrets must drop it.
  const archive = mockArchiveSync([], { restore: { ok: true, restored: true, role: 'x', access_token: 'EAABleak', cookie: 'c_user=leak' } });
  const poller = createPoller({ env: CONFIGURED_ENV, fetch: makeFetch([]), browser, accountsRegistry: mockRegistry([]), profileArchiveSync: archive });
  const outcome = await poller.runCommand({ id: 'cmd_1b', action: 'open_profile', account_uid: 'chearb' });
  assert.equal(outcome.status, 'succeeded');
  assertNoSecretKeys(outcome.result);
  assert.equal(outcome.result.archiveSync.access_token, undefined);
  assert.equal(outcome.result.archiveSync.cookie, undefined);
  assert.equal(outcome.result.archiveSync.restored, true);
});

test('close_profile delegates to closeAccountContext and uploads the sealed archive after closing', async () => {
  const order = [];
  const closeCalls = [];
  const browser = { closeAccountContext: async (account) => { order.push(`close:${account}`); closeCalls.push(account); return { closed: true, state: 'closed' }; } };
  const poller = createPoller({ env: CONFIGURED_ENV, fetch: makeFetch([]), browser, accountsRegistry: mockRegistry([]), profileArchiveSync: mockArchiveSync(order) });
  const outcome = await poller.runCommand({ id: 'cmd_2', action: 'close_profile', account_uid: 'chearb' });
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(closeCalls, ['chearb']);
  assert.equal(outcome.result.closed, true);
  // BrowserSaving parity: the profile is uploaded AFTER the context is closed (and flushed).
  assert.deepEqual(order, ['close:chearb', 'upload:chearb']);
  assert.equal(outcome.result.archiveSync.uploaded, true);
  assertNoSecretKeys(outcome.result);
});

test('open_profile / close_profile fail cleanly without an account_uid', async () => {
  const poller = createPoller({ env: CONFIGURED_ENV, fetch: makeFetch([]), browser: {}, accountsRegistry: mockRegistry([]) });
  const open = await poller.runCommand({ id: 'c', action: 'open_profile' });
  assert.equal(open.status, 'failed');
  assert.equal(open.error_code, 'account_uid_required');
});

test('a browser error becomes a failed outcome with a sanitized code, never a throw', async () => {
  const browser = { openPage: async () => { const e = new Error('profile is locked'); e.code = 'profile_already_open'; throw e; } };
  const poller = createPoller({ env: CONFIGURED_ENV, fetch: makeFetch([]), browser, accountsRegistry: mockRegistry([]), profileArchiveSync: mockArchiveSync() });
  const outcome = await poller.runCommand({ id: 'c', action: 'open_profile', account_uid: 'chearb' });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error_code, 'profile_already_open');
});

test('poll claims a command, runs it, and reports a sanitized completion', async () => {
  const fetchImpl = makeFetch([
    ['/poll', { json: { agent_id: 'mac-mini-1', commands: [{ id: 'cmd_99', action: 'open_profile', account_uid: 'chearb' }] } }],
    ['/complete', { status: 200 }]
  ]);
  const browser = { openPage: async () => ({ profileDir: 'chearb', reused: true, cookie: 'c_user=should-not-leave' }) };
  const poller = createPoller({ env: CONFIGURED_ENV, fetch: fetchImpl, browser, accountsRegistry: mockRegistry([]), profileArchiveSync: mockArchiveSync() });
  const done = await poller.poll();
  assert.deepEqual(done, ['cmd_99']);
  const complete = fetchImpl.calls.find((c) => c.url.includes('/complete'));
  assert.ok(complete, 'a completion was reported');
  assert.equal(complete.body.status, 'succeeded');
  assertNoSecretKeys(complete.body);
  assert.ok(!JSON.stringify(complete.body).includes('c_user='), 'cookie value must never be uploaded');
});

test('stripSecrets drops secret-shaped keys but keeps boolean presence flags', () => {
  const cleaned = stripSecrets({ access_token: 'x', datrPresent: false, profileDir: 'p', nested: { cookie: 'y', ok: true } });
  assert.equal(cleaned.access_token, undefined);
  assert.equal(cleaned.datrPresent, false);
  assert.equal(cleaned.profileDir, 'p');
  assert.equal(cleaned.nested.cookie, undefined);
  assert.equal(cleaned.nested.ok, true);
});
