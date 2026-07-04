'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const stealth = require('../src/stealthBrowser');
const browser = require('../src/browser');
const posting = require('../src/posting');

// Nothing here should ever surface a token/cookie. Reuse the login-automation noLeak idea.
function noLeak(value, secrets) {
  const payload = JSON.stringify(value == null ? '' : value);
  for (const secret of secrets) {
    if (secret && payload.includes(secret)) return false;
  }
  return true;
}

afterEach(() => {
  browser.setBrowserBackend(null);
  browser.resetAccountContexts();
});

// ── Backend selection ────────────────────────────────────────────────────────────────────────────
test('resolveBrowserBackend defaults to cloakbrowser when unset', () => {
  assert.equal(stealth.resolveBrowserBackend({}), 'cloakbrowser');
  assert.equal(stealth.resolveBrowserBackend({ FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND: '' }), 'cloakbrowser');
  assert.equal(stealth.resolveBrowserBackend({ FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND: 'cloakbrowser' }), 'cloakbrowser');
  assert.equal(stealth.resolveBrowserBackend({ FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND: 'chrome' }), 'cloakbrowser');
});

test('resolveBrowserBackend selects stealth via primary and fallback env aliases', () => {
  assert.equal(stealth.resolveBrowserBackend({ FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND: 'stealth' }), 'stealth');
  assert.equal(stealth.resolveBrowserBackend({ FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND: 'NoDriver' }), 'stealth');
  assert.equal(stealth.resolveBrowserBackend({ FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND: '  stealth-browser-mcp ' }), 'stealth');
  // Fallback env only used when primary is empty.
  assert.equal(stealth.resolveBrowserBackend({ ACCOUNTS_BRIDGE_BROWSER_BACKEND: 'stealth' }), 'stealth');
  assert.equal(stealth.resolveBrowserBackend({ FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND: 'cloakbrowser', ACCOUNTS_BRIDGE_BROWSER_BACKEND: 'stealth' }), 'cloakbrowser');
});

test('isStealthBackendSelected mirrors resolveBrowserBackend', () => {
  assert.equal(stealth.isStealthBackendSelected({ FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND: 'stealth' }), true);
  assert.equal(stealth.isStealthBackendSelected({}), false);
});

test('loadBrowserBackend stays cloakbrowser by default (production 8820 unchanged)', async () => {
  const old = process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND;
  delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND;
  try {
    const backend = await browser.loadBrowserBackend();
    assert.equal(backend.backend, 'cloakbrowser');
  } finally {
    if (old === undefined) delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND;
    else process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND = old;
  }
});

test('loadBrowserBackend reports backend=stealth when env selects it (no cloakbrowser require)', async () => {
  const old = process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND;
  process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND = 'stealth';
  try {
    const backend = await browser.loadBrowserBackend();
    assert.equal(backend.backend, 'stealth');
    assert.equal(typeof backend.launcher.launchPersistentContext, 'function');
  } finally {
    if (old === undefined) delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND;
    else process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND = old;
  }
});

// ── CDP endpoint mapping ──────────────────────────────────────────────────────────────────────────
test('parseAccountCdpMap parses valid entries and skips malformed / non-CDP values', () => {
  const map = stealth.parseAccountCdpMap('100090320823561=http://127.0.0.1:9222, bad-entry, x=not-a-url, Y=ws://127.0.0.1:9333');
  assert.deepEqual(map, { '100090320823561': 'http://127.0.0.1:9222', y: 'ws://127.0.0.1:9333' });
  assert.deepEqual(stealth.parseAccountCdpMap(''), {});
  assert.deepEqual(stealth.parseAccountCdpMap(null), {});
});

test('resolveStealthCdpEndpoint prefers per-account map then default, else empty', () => {
  const env = {
    FACEBOOK_TOKEN_CLOAK_STEALTH_CDP_URL: 'http://127.0.0.1:9000',
    FACEBOOK_TOKEN_CLOAK_STEALTH_ACCOUNT_CDP_MAP: '100090320823561=http://127.0.0.1:9222'
  };
  assert.equal(stealth.resolveStealthCdpEndpoint('100090320823561', { env }), 'http://127.0.0.1:9222');
  assert.equal(stealth.resolveStealthCdpEndpoint('someother', { env }), 'http://127.0.0.1:9000');
  assert.equal(stealth.resolveStealthCdpEndpoint('anyone', { env: {} }), '');
});

test('looksLikeCdpEndpoint accepts http(s)/ws(s) only', () => {
  assert.equal(stealth.looksLikeCdpEndpoint('http://127.0.0.1:9222'), true);
  assert.equal(stealth.looksLikeCdpEndpoint('ws://127.0.0.1:9222/devtools/browser/abc'), true);
  assert.equal(stealth.looksLikeCdpEndpoint('127.0.0.1:9222'), false);
  assert.equal(stealth.looksLikeCdpEndpoint(''), false);
});

// ── Launcher: attach + fail-closed ─────────────────────────────────────────────────────────────────
test('stealth launcher fails closed (no connect) when no CDP endpoint is configured', async () => {
  let connectCalls = 0;
  const backend = stealth.loadStealthBackend({ env: {}, connectOverCDP: async () => { connectCalls++; return {}; } });
  await assert.rejects(
    () => backend.launcher.launchPersistentContext('/root/100090320823561'),
    (e) => e && e.code === 'stealth_cdp_endpoint_missing'
  );
  assert.equal(connectCalls, 0, 'must not touch the browser when misconfigured');
});

test('stealth launcher maps profile basename to CDP endpoint and returns the attached context', async () => {
  const realContext = { pages: () => [], async cookies() { return []; }, async close() { throw new Error('should not close operator context'); } };
  const browserConn = { contexts: () => [realContext], async close() {} };
  let attached = '';
  const backend = stealth.loadStealthBackend({
    env: { FACEBOOK_TOKEN_CLOAK_STEALTH_ACCOUNT_CDP_MAP: '100090320823561=http://127.0.0.1:9222' },
    connectOverCDP: async (endpoint) => { attached = endpoint; return browserConn; }
  });
  const ctx = await backend.launcher.launchPersistentContext('/root/100090320823561');
  assert.equal(attached, 'http://127.0.0.1:9222');
  assert.equal(typeof ctx.pages, 'function');
});

test('stealth launcher surfaces stealth_cdp_connect_failed on attach error', async () => {
  const backend = stealth.loadStealthBackend({
    env: { FACEBOOK_TOKEN_CLOAK_STEALTH_CDP_URL: 'http://127.0.0.1:9222' },
    connectOverCDP: async () => { throw new Error('ECONNREFUSED'); }
  });
  await assert.rejects(
    () => backend.launcher.launchPersistentContext('/root/acct'),
    (e) => e && e.code === 'stealth_cdp_connect_failed'
  );
});

// ── Wrapped context close() must disconnect, never tear down the operator's real context ────────────
test('wrapAttachedContext.close() disconnects the CDP link and never closes the operator context', async () => {
  let connClosed = 0;
  let ctxClosed = 0;
  const realContext = { pages: () => ['p'], async close() { ctxClosed++; } };
  const browserConn = { async close() { connClosed++; } };
  const wrapped = stealth.wrapAttachedContext(browserConn, realContext);
  // Non-close members delegate straight through.
  assert.deepEqual(wrapped.pages(), ['p']);
  await wrapped.close();
  assert.equal(connClosed, 1);
  assert.equal(ctxClosed, 0, 'operator context/tabs must survive');
});

// ── Integration: /update-cta code path over a stealth-attached session, no token leak, fail closed ──
test('resolveSessionToken over a stealth session with no token fails closed as token_not_found and leaks nothing', async () => {
  const SECRET = 'FAKE_SECRET_SHOULD_NEVER_APPEAR';
  const realContext = {
    pages: () => [fakePage],
    async newPage() { return fakePage; },
    async cookies() { return []; },
    request: null,
    async close() { throw new Error('operator context must not be closed'); }
  };
  const fakePage = {
    url: () => 'about:blank',
    async goto() {},
    // In-page token extractor finds nothing — a logged-out / login-parked stealth session.
    async evaluate() { return { token: null, fbDtsgPresent: false, userId: null }; }
  };
  const browserConn = { contexts: () => [realContext], async close() {} };
  const stealthBackend = stealth.loadStealthBackend({
    env: { FACEBOOK_TOKEN_CLOAK_STEALTH_CDP_URL: 'http://127.0.0.1:9222' },
    connectOverCDP: async () => browserConn
  });
  // Route browser.js through the stealth backend for this test.
  browser.setBrowserBackend(stealthBackend.launcher, 'stealth');

  const session = await posting.resolveSessionToken({ browser, account: '100090320823561' });
  try {
    assert.equal(session.token, null);
    assert.equal(session.reason, 'token_not_found');
    assert.equal(session.backend, 'stealth');
    assert.ok(noLeak({ token: session.token, reason: session.reason, source: session.source }, [SECRET]));

    // /update-cta contract: no token → fail closed with no_session, no Graph call, no leak.
    const cta = await posting.updateVisiblePostCta(session.graphFetch, {
      userToken: session.token,
      pageId: '1008898512617594',
      storyId: '1008898512617594_1220849613553068',
      finalCtaLink: 'https://s.shopee.co.th/7prNYwcQ4p'
    });
    assert.equal(cta.ok, false);
    assert.equal(cta.step, 'session');
    assert.equal(cta.error, 'no_session');
  } finally {
    await posting.closeSession(session);
  }
});
