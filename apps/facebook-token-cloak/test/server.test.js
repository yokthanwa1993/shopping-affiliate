'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createServer, createHandler, DEFAULT_PORT } = require('../src/server');
const keychain = require('../src/keychain');
const accountSelectors = require('../src/account-selectors');
const {
  store,
  internetStore,
  securityCalls,
  fakeRunner,
  setInternetCredential
} = require('./_helpers');

function assertNoLeak(value, secrets) {
  const payload = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!payload.includes(secret), `leaked ${secret}`);
}

test('UI auto-check marks Facebook Lite ready from accessToken without requiring Power Editor fbDtsg', async () => {
  const ui = await fs.readFile(path.join(__dirname, '..', 'src', 'ui.html'), 'utf8');
  assert.match(ui, /var tokenReady = !!\(probe && probe\.accessToken\)/);
  assert.match(ui, /var sessionReady = !!\(probe && probe\.fbDtsg\)/);
  assert.match(ui, /tokenPresent: tokenReady/);
  assert.match(ui, /sessionPresent: sessionReady/);
  assert.ok(!ui.includes('var ready = tokenReady && sessionReady'), 'Facebook Lite token status must not require Power Editor/session readiness');
  assert.ok(!ui.includes('tokenPresent: ready'), 'UI must not gate Facebook Lite token status on combined readiness');
})

function browser(url = 'https://postcron.com/auth/login/facebook/callback#access_token=EAAB_USER_SECRET', seen) {
  return {
    PROFILE_ROOT: '/tmp/profiles',
    loadBrowserBackend: async () => ({ backend: 'mock-browser' }),
    openPage: async () => {
      if (seen) seen.opened = (seen.opened || 0) + 1;
      return {
        backend: 'mock-browser',
        profileDir: '/tmp/profiles/chearb',
        page: {
          url: () => url,
          textContent: async () => ''
        }
      };
    },
    fillFacebookLogin: async (_page, credential, options) => {
      if (seen) seen.credential = credential;
      return {
        autofilled: !!credential,
        submitted: !!(options && options.submit),
        username: credential && credential.username,
        password: credential && credential.password
      };
    }
  };
}

async function fakeFetch() {
  return {
    ok: true,
    json: async () => ({
      data: [{ id: '11', name: 'Page', category: 'Shop', access_token: 'PAGESECRET' }]
    })
  };
}

let server;
let selectorConfigPath;

function selectorStore(configPath) {
  return {
    getSelector: account => accountSelectors.getSelector(account, { configPath }),
    getSelectorStatus: account => accountSelectors.getSelectorStatus(account, { configPath }),
    saveSelector: (account, selector) => accountSelectors.saveSelector(account, selector, { configPath }),
    deleteSelector: account => accountSelectors.deleteSelector(account, { configPath })
  };
}

async function tempConfigPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'facebook-token-cloak-server-'));
  return path.join(dir, 'accounts.json');
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: data ? JSON.parse(data) : {}
      }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function listenWith(mockBrowser = browser()) {
  server = createServer({
    browser: mockBrowser,
    fetch: fakeFetch,
    accountSelectors: selectorStore(selectorConfigPath)
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

beforeEach(async () => {
  store.clear();
  internetStore.clear();
  securityCalls.length = 0;
  selectorConfigPath = await tempConfigPath();
  keychain.setRunner(fakeRunner);
  await listenWith();
});

afterEach(async () => {
  keychain.clearRunner();
  await new Promise(resolve => server.close(resolve));
});

test('server health/keychain/login/refresh/export', async () => {
  let r = await req('GET', '/health');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.port, DEFAULT_PORT);

  r = await req('POST', '/keychain/credential', {
    account: 'CHEARB',
    username: 'u@example.com',
    password: 'pw-secret'
  });
  assert.equal(r.status, 200);
  assertNoLeak(r.body, ['pw-secret']);

  r = await req('GET', '/login?account=CHEARB&visible=1&autofill=1');
  assert.equal(r.body.state, 'login_opened');
  assert.equal(r.body.autofilled, true);

  r = await req('POST', '/token/refresh', { account: 'CHEARB' });
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.pagesCount, 1);
  assertNoLeak(r.body, ['EAAB_USER_SECRET', 'PAGESECRET']);

  r = await req('POST', '/token/refresh', { account: 'CHEARB', includeToken: true });
  assert.equal(r.body.token, 'EAAB_USER_SECRET');
  assert.equal(r.body.pages[0].access_token, 'PAGESECRET');

  r = await req('POST', '/token/export', { account: 'CHEARB' });
  assert.equal(r.body.status, 'dry_run_only');
});

test('/accounts/selector saves, reports, and deletes redacted apple passwords selector', async () => {
  let r = await req('GET', '/accounts/selector?account=CHEARB');
  assert.equal(r.status, 200);
  assert.equal(r.body.selectorPresent, false);
  assert.equal(r.body.usernameHintPresent, false);

  r = await req('POST', '/accounts/selector', {
    account: 'CHEARB',
    credentialProvider: 'apple-passwords',
    domain: 'facebook.com',
    username: 'fb-one@example.com'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.account, 'CHEARB');
  assert.equal(r.body.selectorPresent, true);
  assert.equal(r.body.credentialProvider, 'apple-passwords');
  assert.equal(r.body.usernameHintPresent, true);
  assert.equal(r.body.selectedDomain, 'facebook.com');
  assert.equal(r.body.selectedServer, 'facebook.com');
  assert.equal(r.body.selectedProtocol, 'https');
  assertNoLeak(r.body, ['fb-one@example.com']);

  r = await req('GET', '/accounts/selector?account=CHEARB');
  assert.equal(r.status, 200);
  assert.equal(r.body.selectorPresent, true);
  assert.equal(r.body.usernameHintPresent, true);
  assertNoLeak(r.body, ['fb-one@example.com']);

  r = await req('DELETE', '/accounts/selector?account=CHEARB');
  assert.equal(r.status, 200);
  assert.equal(r.body.selectorPresent, false);

  r = await req('GET', '/accounts/selector?account=CHEARB');
  assert.equal(r.body.selectorPresent, false);
});

test('/accounts/selector rejects password/token/cookie/secret fields without leaking values', async () => {
  const r = await req('POST', '/accounts/selector', {
    account: 'CHEARB',
    credentialProvider: 'apple-passwords',
    domain: 'facebook.com',
    username: 'fb-one@example.com',
    password: 'pw-secret'
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.success, false);
  assert.match(r.body.error, /Forbidden selector field: password/);
  assertNoLeak(r.body, ['pw-secret', 'fb-one@example.com']);
});

test('/passwords/status autodiscovers a single apple passwords item without username or domain', async () => {
  setInternetCredential({
    server: 'www.facebook.com',
    username: 'fb@example.com',
    password: 'internet-secret'
  });

  const r = await req('GET', '/passwords/status?account=CHEARB');
  assert.equal(r.status, 200);
  assert.equal(r.body.provider, 'apple-passwords');
  assert.equal(r.body.credentialPresent, true);
  assert.equal(r.body.usernamePresent, true);
  assert.equal(r.body.passwordPresent, true);
  assert.equal(r.body.usernameSource, 'metadata');
  assert.equal(r.body.selectedDomain, 'www.facebook.com');
  assert.equal(r.body.selectedProtocol, 'https');
  assert.deepEqual(r.body.candidatesChecked, {
    count: 4,
    domains: keychain.FACEBOOK_INTERNET_SERVERS
  });
  assertNoLeak(r.body, ['fb@example.com', 'internet-secret']);
});

test('/passwords/status uses stored selector and checks only the selected apple passwords item', async () => {
  await req('POST', '/accounts/selector', {
    account: 'CHEARB',
    credentialProvider: 'apple-passwords',
    domain: 'facebook.com',
    username: 'fb-one@example.com'
  });
  setInternetCredential({
    server: 'facebook.com',
    username: 'fb-one@example.com',
    password: 'internet-secret-one'
  });
  setInternetCredential({
    server: 'www.facebook.com',
    username: 'fb-two@example.com',
    password: 'internet-secret-two'
  });
  securityCalls.length = 0;

  const r = await req('GET', '/passwords/status?account=CHEARB');
  assert.equal(r.status, 200);
  assert.equal(r.body.selectorPresent, true);
  assert.equal(r.body.usernameHintPresent, true);
  assert.equal(r.body.credentialPresent, true);
  assert.equal(r.body.usernamePresent, true);
  assert.equal(r.body.passwordPresent, true);
  assert.equal(r.body.selectedDomain, 'facebook.com');
  assert.equal(r.body.selectedServer, 'facebook.com');
  assert.equal(r.body.selectedProtocol, 'https');
  assert.deepEqual(r.body.candidatesChecked, {
    count: 1,
    domains: ['facebook.com']
  });
  assert.deepEqual(securityCalls, [[
    'find-internet-password',
    '-s',
    'facebook.com',
    '-r',
    'htps',
    '-a',
    'fb-one@example.com'
  ]]);
  assertNoLeak(r.body, [
    'fb-one@example.com',
    'fb-two@example.com',
    'internet-secret-one',
    'internet-secret-two'
  ]);
});

test('/login can autodiscover apple-passwords provider without exposing credential', async () => {
  await new Promise(resolve => server.close(resolve));
  const seen = {};
  await listenWith(browser('https://www.facebook.com/login', seen));
  setInternetCredential({
    server: 'login.facebook.com',
    username: 'fb@example.com',
    password: 'internet-secret'
  });

  const r = await req('GET', '/login?account=CHEARB&credentialProvider=apple-passwords&visible=1&autofill=1&submit=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'login_submitted');
  assert.equal(r.body.credentialProvider, 'apple-passwords');
  assert.equal(r.body.autofilled, true);
  assert.equal(r.body.submitted, true);
  assert.equal(seen.opened, 1);
  assert.deepEqual(seen.credential.username, 'fb@example.com');
  assert.deepEqual(seen.credential.password, 'internet-secret');
  assert.deepEqual(securityCalls.slice(0, 4).map(args => args[2]), keychain.FACEBOOK_INTERNET_SERVERS);
  assert.deepEqual(securityCalls[4], [
    'find-internet-password',
    '-s',
    'login.facebook.com',
    '-r',
    'htps',
    '-a',
    'fb@example.com',
    '-w'
  ]);
  assertNoLeak(r.body, ['fb@example.com', 'internet-secret']);
});

test('/login uses stored selector for apple-passwords without exposing credential', async () => {
  await new Promise(resolve => server.close(resolve));
  const seen = {};
  await listenWith(browser('https://www.facebook.com/login', seen));
  await req('POST', '/accounts/selector', {
    account: 'CHEARB',
    credentialProvider: 'apple-passwords',
    domain: 'facebook.com',
    username: 'fb-one@example.com'
  });
  setInternetCredential({
    server: 'facebook.com',
    username: 'fb-one@example.com',
    password: 'internet-secret-one'
  });
  setInternetCredential({
    server: 'www.facebook.com',
    username: 'fb-two@example.com',
    password: 'internet-secret-two'
  });
  securityCalls.length = 0;

  const r = await req('GET', '/login?account=CHEARB&provider=apple-passwords&visible=1&autofill=1&submit=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'login_submitted');
  assert.equal(r.body.selectorPresent, true);
  assert.equal(r.body.usernameHintPresent, true);
  assert.equal(r.body.selectedDomain, 'facebook.com');
  assert.equal(r.body.autofilled, true);
  assert.equal(r.body.submitted, true);
  assert.equal(seen.opened, 1);
  assert.equal(seen.credential.username, 'fb-one@example.com');
  assert.equal(seen.credential.password, 'internet-secret-one');
  assert.deepEqual(securityCalls, [[
    'find-internet-password',
    '-s',
    'facebook.com',
    '-r',
    'htps',
    '-a',
    'fb-one@example.com',
    '-w'
  ]]);
  assertNoLeak(r.body, [
    'fb-one@example.com',
    'fb-two@example.com',
    'internet-secret-one',
    'internet-secret-two'
  ]);
});

test('/login returns safe 404 when apple-passwords autodiscovery finds no candidate', async () => {
  await new Promise(resolve => server.close(resolve));
  const seen = {};
  await listenWith(browser('https://www.facebook.com/login', seen));

  const r = await req('GET', '/login?account=CHEARB&provider=apple-passwords&visible=1&autofill=1');
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
  assert.equal(r.body.state, 'credential_not_found');
  assert.equal(r.body.credentialProvider, 'apple-passwords');
  assert.equal(r.body.credentialPresent, false);
  assert.equal(r.body.autofilled, false);
  assert.equal(r.body.submitted, false);
  assert.equal(seen.opened || 0, 0);
  assert.deepEqual(r.body.candidatesChecked, {
    count: 4,
    domains: keychain.FACEBOOK_INTERNET_SERVERS
  });
  assert.ok(securityCalls.every(args => !args.includes('-w')));
});

test('/login returns safe ambiguity error for multiple autodiscovered apple passwords', async () => {
  await new Promise(resolve => server.close(resolve));
  const seen = {};
  await listenWith(browser('https://www.facebook.com/login', seen));
  setInternetCredential({
    server: 'facebook.com',
    username: 'fb-one@example.com',
    password: 'internet-secret-one'
  });
  setInternetCredential({
    server: 'm.facebook.com',
    username: 'fb-two@example.com',
    password: 'internet-secret-two'
  });

  const r = await req('GET', '/login?account=CHEARB&provider=apple-passwords&visible=1&autofill=1');
  assert.equal(r.status, 409);
  assert.equal(r.body.success, false);
  assert.equal(r.body.state, 'credential_ambiguous');
  assert.equal(r.body.credentialPresent, false);
  assert.equal(r.body.usernamePresent, true);
  assert.equal(r.body.passwordPresent, true);
  assert.equal(r.body.ambiguous, true);
  assert.equal(seen.opened || 0, 0);
  assertNoLeak(r.body, [
    'fb-one@example.com',
    'fb-two@example.com',
    'internet-secret-one',
    'internet-secret-two'
  ]);
});

test('/login explicit apple-passwords query overrides stored selector without leaking values', async () => {
  await new Promise(resolve => server.close(resolve));
  const seen = {};
  await listenWith(browser('https://www.facebook.com/login', seen));
  await req('POST', '/accounts/selector', {
    account: 'CHEARB',
    credentialProvider: 'apple-passwords',
    domain: 'facebook.com',
    username: 'fb-one@example.com'
  });
  setInternetCredential({
    server: 'facebook.com',
    username: 'fb-one@example.com',
    password: 'internet-secret-one'
  });
  setInternetCredential({
    server: 'www.facebook.com',
    username: 'fb-two@example.com',
    password: 'internet-secret-two'
  });
  securityCalls.length = 0;

  const r = await req(
    'GET',
    '/login?account=CHEARB&credentialProvider=apple-passwords&domain=www.facebook.com&username=fb-two%40example.com&visible=1&autofill=1&submit=1'
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'login_submitted');
  assert.equal(r.body.selectorPresent, true);
  assert.equal(r.body.usernameHintPresent, true);
  assert.equal(r.body.selectedDomain, 'www.facebook.com');
  assert.equal(r.body.autofilled, true);
  assert.equal(r.body.submitted, true);
  assert.equal(seen.credential.username, 'fb-two@example.com');
  assert.equal(seen.credential.password, 'internet-secret-two');
  assert.deepEqual(securityCalls, [[
    'find-internet-password',
    '-s',
    'www.facebook.com',
    '-r',
    'htps',
    '-a',
    'fb-two@example.com',
    '-w'
  ]]);
  assertNoLeak(r.body, [
    'fb-one@example.com',
    'fb-two@example.com',
    'internet-secret-one',
    'internet-secret-two'
  ]);
});

test('/login explicit domain and username override still wins for apple-passwords', async () => {
  await new Promise(resolve => server.close(resolve));
  const seen = {};
  await listenWith(browser('https://www.facebook.com/login', seen));
  setInternetCredential({
    server: 'facebook.com',
    username: 'fb-one@example.com',
    password: 'internet-secret-one'
  });
  setInternetCredential({
    server: 'www.facebook.com',
    username: 'fb-two@example.com',
    password: 'internet-secret-two'
  });

  const r = await req(
    'GET',
    '/login?account=CHEARB&credentialProvider=apple-passwords&domain=www.facebook.com&username=fb-two%40example.com&visible=1&autofill=1&submit=1'
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'login_submitted');
  assert.equal(r.body.autofilled, true);
  assert.equal(r.body.submitted, true);
  assert.deepEqual(seen.credential.username, 'fb-two@example.com');
  assert.deepEqual(seen.credential.password, 'internet-secret-two');
  assert.deepEqual(securityCalls, [[
    'find-internet-password',
    '-s',
    'www.facebook.com',
    '-r',
    'htps',
    '-a',
    'fb-two@example.com',
    '-w'
  ]]);
  assertNoLeak(r.body, [
    'fb-one@example.com',
    'fb-two@example.com',
    'internet-secret-one',
    'internet-secret-two'
  ]);
});

// ── /token/export live local-only sync ──────────────────────────────────────────────────────
// The Bridge Token exporter resolves a page-scoped token from the logged-in CloakBrowser
// session and pushes it into the Worker namespace token pool via the secret-authed
// /api/pages/profile-sync route. It is local-only, dry-run by default, and token-free in every
// response it returns.

const EXPORT_SECRET_ENV = ['BRIDGE_TOKEN_SYNC_SECRET', 'TAG_SYNC_PUSH_SECRET', 'BROWSERSAVING_TAG_SYNC_SECRET'];

function withExportEnv(values, fn) {
  const saved = {};
  for (const key of EXPORT_SECRET_ENV) saved[key] = process.env[key];
  return (async () => {
    try {
      for (const key of EXPORT_SECRET_ENV) delete process.env[key];
      Object.assign(process.env, values);
      return await fn();
    } finally {
      for (const key of EXPORT_SECRET_ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  })();
}

// Spin up a dedicated server with custom browser+fetch deps for the live-export cases.
async function withExportServer(deps, fn) {
  const srv = createServer({
    accountSelectors: selectorStore(selectorConfigPath),
    ...deps
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const request = (method, p, body) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const rq = http.request({
      hostname: '127.0.0.1', port, path: p, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    rq.on('error', reject);
    if (payload) rq.write(payload);
    rq.end();
  });
  try { return await fn(request); } finally { await new Promise(resolve => srv.close(resolve)); }
}

// Invoke the raw handler with a synthetic non-local socket to exercise the local-only guard
// (real http requests in this suite always arrive from 127.0.0.1).
function callHandler(deps, { method, path, body, remoteAddress }) {
  const handler = createHandler({ accountSelectors: selectorStore(selectorConfigPath), ...deps });
  const payload = body ? JSON.stringify(body) : '';
  const req = Readable.from([payload]);
  req.method = method;
  req.url = path;
  req.headers = { host: '127.0.0.1' };
  req.socket = { remoteAddress };
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const res = {
    statusCode: 0, headers: null, bodyText: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(p) { this.bodyText = p || ''; resolveDone(); }
  };
  return Promise.resolve(handler(req, res)).then(() => done).then(() => ({
    status: res.statusCode,
    body: res.bodyText ? JSON.parse(res.bodyText) : {}
  }));
}

async function captureConsole(fn) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((arg) => String(arg)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

// A CloakBrowser mock whose session resolves the page list through `session.graphFetch` — the
// same cookie-bound client GET /pages uses — instead of a bare server fetch. `pagesByAccount`
// maps an account/alias to the me/accounts rows that account's logged-in session administers;
// `noSessionAccounts` makes an account yield no usable token (no OAuth token in the callback URL
// and no Ads Manager token), exercising the no_session / default-account fallback paths. The
// graphFetch path runs over `context.request.fetch` (Playwright APIRequestContext shape), which
// is what `makeBrowserGraphFetch` prefers in production.
function exportBrowser({ pagesByAccount = {}, noSessionAccounts = [], graphErrorsByAccount = {} } = {}) {
  const graphCalls = [];
  return {
    graphCalls,
    PROFILE_ROOT: '/tmp/profiles',
    loadBrowserBackend: async () => ({ backend: 'mock-browser' }),
    openPage: async (account) => {
      const hasSession = !noSessionAccounts.includes(account);
      const pages = pagesByAccount[account] || [];
      return {
        backend: 'mock-browser',
        profileDir: `/tmp/profiles/${account}`,
        page: {
          // A session-bearing account carries its token in the OAuth callback hash; a session-less
          // one lands on a plain page (no token), so resolveSessionToken reports no_session.
          url: () => hasSession
            ? `https://postcron.com/auth/login/facebook/callback#access_token=SESSION_${account}`
            : 'https://www.facebook.com/',
          goto: async () => {},
          // Ads Manager fallback extractor — yields nothing, keeping session-less accounts no_session.
          evaluate: async () => ({ token: null, fbDtsgPresent: false, userId: null }),
          textContent: async () => ''
        },
        // Cookie-bound Graph client (preferred path in makeBrowserGraphFetch). Serves me/accounts
        // for this account's administered pages; never touched when there is no session token.
        context: {
          request: {
            fetch: async (url) => {
              const u = String(url);
              graphCalls.push({ account, url: u });
              const error = graphErrorsByAccount[account];
              const payload = u.includes('/me/accounts') && error
                ? { error: { message: String(error) } }
                : (u.includes('/me/accounts') ? { data: pages } : {});
              return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
            }
          }
        }
      };
    }
  };
}

test('/token/export default stays dry_run_only and token-free (no profile-sync push)', async () => {
  let pushCalled = false;
  await withExportServer({
    browser: browser(),
    fetch: async (url) => {
      if (String(url).includes('/api/pages/profile-sync')) pushCalled = true;
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
  }, async (request) => {
    const r = await request('POST', '/token/export', { account: 'CHEARB', namespaceId: 'NS', pageId: '11' });
    assert.equal(r.body.status, 'dry_run_only');
    assert.equal(r.body.dryRun, true);
    assert.equal(pushCalled, false, 'a dry run must never push to the Worker');
    assertNoLeak(r.body, ['EAAB_USER_SECRET', 'PAGESECRET']);
    assert.equal('access_token' in r.body, false);
    assert.equal('token' in r.body, false);
  });
});

test('/token/export live export rejects non-local requests', async () => {
  const r = await callHandler({ browser: browser() }, {
    method: 'POST',
    path: '/token/export',
    body: { account: 'CHEARB', namespaceId: 'NS', pageId: '11', dryRun: false },
    remoteAddress: '203.0.113.7'
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.success, false);
});

test('/token/export live export returns sync_secret_missing when no secret configured', async () => {
  await withExportEnv({}, () => withExportServer({
    browser: browser(),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })
  }, async (request) => {
    const r = await request('POST', '/token/export', { account: 'CHEARB', namespaceId: 'NS', pageId: '11', dryRun: false });
    assert.equal(r.body.status, 'sync_secret_missing');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.synced, false);
  }));
});

test('/token/export live export resolves the page via session.graphFetch (same as /pages) and stays token-free', async () => {
  const SECRET = 'unit-test-bridge-secret';
  let captured = null;
  let r;
  // A non-numeric alias keeps this on the CloakBrowser session export path (numeric ids route to
  // the Facebook Lite EAAD6V path — covered by a dedicated test below).
  const SESSION_ACCOUNT = 'cheap_session';
  const mockBrowser = exportBrowser({
    pagesByAccount: {
      [SESSION_ACCOUNT]: [
        { id: '999', name: 'Other', access_token: 'OTHERPAGESECRET' },
        { id: '1008898512617594', name: 'เฉียบ', access_token: 'PAGESECRET' }
      ]
    }
  });
  // The injected fetch deliberately does NOT serve /me/accounts — if the exporter still resolved
  // the page it must have come from session.graphFetch (the /pages semantics), not a bare fetch.
  await withExportEnv({ BRIDGE_TOKEN_SYNC_SECRET: SECRET }, () => withExportServer({
    browser: mockBrowser,
    fetch: async (url, opts) => {
      if (String(url).includes('/me/accounts')) {
        throw new Error('me/accounts must be resolved via session.graphFetch, not the bare fetch');
      }
      if (String(url).includes('/api/pages/profile-sync')) {
        captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
        return { ok: true, status: 200, json: async () => ({ success: true, created: false, updated: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const capturedConsole = await captureConsole(async () => {
      r = await request('POST', '/token/export', {
        account: SESSION_ACCOUNT,
        namespaceId: '1774858894802785816',
        pageId: '1008898512617594',
        dryRun: false
      });
    });
    const logs = capturedConsole.lines;
    // Response is token-free and reports a successful sync.
    assert.equal(r.body.ok, true);
    assert.equal(r.body.synced, true);
    assert.equal(r.body.status, 'synced');
    assert.equal(r.body.page_found, true);
    assert.equal(r.body.hasToken, true);
    assert.equal(r.body.profile_sync_success, true);
    assert.equal(r.body.token_source, 'cloak_session_bridge');
    assert.equal('access_token' in r.body, false);
    assert.equal('token' in r.body, false);
    assertNoLeak({ body: r.body, logs }, ['PAGESECRET', 'OTHERPAGESECRET', `SESSION_${SESSION_ACCOUNT}`, SECRET, 'fb_dtsg', 'datr=']);
    assert.ok(
      mockBrowser.graphCalls.some((call) =>
        call.account === SESSION_ACCOUNT &&
        /\/me\/accounts/.test(call.url) &&
        /fields=access_token,id,name,category/.test(call.url) &&
        new RegExp(`access_token=SESSION_${SESSION_ACCOUNT}`).test(call.url)
      ),
      'export must call session.graphFetch /me/accounts with the user token'
    );

    // The push carried the secret header + the page-scoped token in the body only.
    assert.ok(captured, 'profile-sync must be called');
    assert.equal(captured.headers['x-tag-sync-secret'], SECRET);
    assert.equal(captured.body.namespace_id, '1774858894802785816');
    assert.equal(captured.body.page_id, '1008898512617594');
    assert.equal(captured.body.access_token, 'PAGESECRET');
    assert.equal(captured.body.comment_token, 'PAGESECRET');
    assert.notEqual(captured.body.access_token, 'OTHERPAGESECRET', 'must choose the token for the matching page id');
  }));
});

// A deterministic Facebook Lite token service: facebookLogin() returns a fresh EAAD6V converted
// token without any network. extractTokenPrefix reuses the real implementation so prefix hints
// (e.g. "EAAD6V") match production.
const { extractTokenPrefix: realExtractTokenPrefix } = require('../src/fb-lite-token-service.cjs');
function mockFbLite({ token = 'EAAD6Vuser0000000000000000000', success = true, error } = {}) {
  return {
    extractTokenPrefix: realExtractTokenPrefix,
    facebookLogin: async () => (success
      ? { success: true, converted_token: { access_token: token } }
      : { success: false, error: error || 'login_failed' })
  };
}
// Minimal Keychain stub for the Facebook Lite credential path. Only the three secret reads the
// Lite resolver uses are implemented.
function mockKeychain({ username = 'lite-user', password = 'lite-pass', totp, datr } = {}) {
  return {
    retrieveCredential: async () => ({ username, password }),
    retrieveTotp: async () => { if (totp == null) throw new Error('no totp'); return totp; },
    retrieveDatr: async () => { if (datr == null) throw new Error('no datr'); return datr; }
  };
}

test('/token/export Facebook Lite (numeric account) mints a fresh EAAD6V page token via me/accounts and tags facebook_lite_bridge, token-free', async () => {
  const SECRET = 'unit-test-bridge-secret';
  const LITE_USER_TOKEN = 'EAAD6Vuser0000000000000000000';
  const LITE_PAGE_TOKEN = 'EAAD6Vpage0000000000000000000';
  let captured = null;
  let meAccountsToken = null;
  await withExportEnv({ BRIDGE_TOKEN_SYNC_SECRET: SECRET }, () => withExportServer({
    keychain: mockKeychain(),
    fbLiteTokenService: mockFbLite({ token: LITE_USER_TOKEN }),
    // The CloakBrowser session must NEVER be consulted for a Facebook Lite account. graphErrors on
    // every session would surface if it were used; here pagesByAccount is empty so a session resolve
    // could only ever fail — proving the page token came from the Lite login, not the session.
    browser: exportBrowser({}),
    fetch: async (url, opts) => {
      const u = String(url);
      if (u.includes('/me/accounts')) {
        const m = u.match(/access_token=([^&]+)/);
        meAccountsToken = m ? decodeURIComponent(m[1]) : null;
        return { ok: true, status: 200, json: async () => ({ data: [
          { id: '999', name: 'Other', access_token: 'EAAD6Vother000000000000000000' },
          { id: '1008898512617594', name: 'เฉียบ', access_token: LITE_PAGE_TOKEN }
        ] }) };
      }
      if (u.includes('/api/pages/profile-sync')) {
        captured = { headers: opts.headers, body: JSON.parse(opts.body) };
        return { ok: true, status: 200, json: async () => ({ success: true, updated: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/token/export', {
      account: '100090320823561',
      namespaceId: '1774858894802785816',
      pageId: '1008898512617594',
      dryRun: false
    });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.synced, true);
    assert.equal(r.body.status, 'synced');
    assert.equal(r.body.page_found, true);
    assert.equal(r.body.hasToken, true);
    // The minted token is a Facebook Lite EAAD6V — the response carries the source + prefix HINT only.
    assert.equal(r.body.token_source, 'facebook_lite_bridge');
    assert.equal(r.body.token_prefix, 'EAAD6V');
    assert.equal('access_token' in r.body, false);
    assert.equal('token' in r.body, false);
    // me/accounts was resolved with the freshly minted Lite USER token (not a session token).
    assert.equal(meAccountsToken, LITE_USER_TOKEN);
    // The push carried the secret header + the EAAD6V PAGE token for the matching page id only.
    assert.ok(captured, 'profile-sync must be called');
    assert.equal(captured.headers['x-tag-sync-secret'], SECRET);
    assert.equal(captured.body.access_token, LITE_PAGE_TOKEN);
    assert.equal(captured.body.comment_token, LITE_PAGE_TOKEN);
    assert.equal(captured.body.token_source, 'facebook_lite_bridge');
    assertNoLeak(r.body, [LITE_USER_TOKEN, LITE_PAGE_TOKEN, 'EAAD6Vother000000000000000000', SECRET]);
  }));
});

test('/token/export Facebook Lite dry run reports facebook_lite_bridge and pushes nothing', async () => {
  let pushCalled = false;
  await withExportServer({
    keychain: mockKeychain(),
    fbLiteTokenService: mockFbLite(),
    browser: exportBrowser({}),
    fetch: async (url) => {
      if (String(url).includes('/api/pages/profile-sync')) pushCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/token/export', {
      account: '100090320823561', namespaceId: 'NS', pageId: '1008898512617594'
    });
    assert.equal(r.body.status, 'dry_run_only');
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.token_source, 'facebook_lite_bridge');
    assert.equal(pushCalled, false, 'a dry run must never push to the Worker');
    assert.equal('access_token' in r.body, false);
  });
});

test('/token/export Facebook Lite reports a token-free failure when the login cannot mint a token (no session fallback)', async () => {
  const SECRET = 'unit-test-bridge-secret';
  let pushCalled = false;
  await withExportEnv({ BRIDGE_TOKEN_SYNC_SECRET: SECRET }, () => withExportServer({
    keychain: mockKeychain(),
    fbLiteTokenService: mockFbLite({ success: false, error: 'checkpoint_required' }),
    // A working CloakBrowser session DOES administer the page — but a Facebook Lite account must
    // NEVER fall back to it. The export must fail rather than sync a session-derived token.
    browser: exportBrowser({ pagesByAccount: { content_paiya: [{ id: '1008898512617594', name: 'เฉียบ', access_token: 'PAGESECRET' }] } }),
    fetch: async (url) => {
      if (String(url).includes('/api/pages/profile-sync')) pushCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/token/export', {
      account: '100090320823561', namespaceId: 'NS', pageId: '1008898512617594', dryRun: false
    });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.synced, false);
    assert.equal(r.body.token_source, 'facebook_lite_bridge');
    assert.equal(pushCalled, false, 'a failed Lite mint must never push a token');
    assert.equal('access_token' in r.body, false);
    assertNoLeak(r.body, ['PAGESECRET', SECRET]);
  }));
});

test('POST /post facebook_lite publishes a REAL organic page video via /{page_id}/videos (EAAD6V page token), never the ad-account advideos path', async () => {
  const PAGE = '1008898512617594';
  const LITE_USER_TOKEN = 'EAAD6Vuser0000000000000000000';
  const LITE_PAGE_TOKEN = 'EAAD6Vpage0000000000000000000';
  const calls = [];
  await withExportServer({
    keychain: mockKeychain(),
    fbLiteTokenService: mockFbLite({ token: LITE_USER_TOKEN }),
    browser: exportBrowser({}),
    // Multipart upload path: the bridge downloads the bytes itself, so no real network is needed.
    downloadVideo: async () => ({ buffer: Buffer.from('VIDEOBYTES'), contentType: 'video/mp4' }),
    fetch: async (url, opts) => {
      const u = String(url);
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      calls.push({ url: u, method });
      if (u.includes('/me/accounts')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: PAGE, name: 'เฉียบ', access_token: LITE_PAGE_TOKEN }] }) };
      }
      if (u.includes(`/${PAGE}/videos`) && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'PAGEVIDX', post_id: `${PAGE}_NEWPOST` }) };
      }
      if (u.includes('/PAGEVIDX') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ post_id: `${PAGE}_NEWPOST`, permalink_url: `https://www.facebook.com/${PAGE}/posts/NEWPOST`, thumbnails: { data: [{ uri: 'https://thumb/x.jpg' }] } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/post', {
      account: '100090320823561',
      page_id: PAGE,
      video_url: 'https://cdn/example.mp4',
      message: 'hello lite'
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.source, 'facebook_lite_eaad6');
    assert.equal(r.body.story_id, `${PAGE}_NEWPOST`);
    assert.equal(r.body.video_id, 'PAGEVIDX');
    assert.equal(r.body.published_to_page, true);
    // HARD GUARANTEE: the organic /{page_id}/videos endpoint was used, and the ad-account advideos
    // path (the source of the live "(#10) Permission Denied") was NEVER called.
    assert.ok(calls.some((c) => c.url.includes(`/${PAGE}/videos`) && c.method === 'POST'), 'must publish via /{page_id}/videos');
    assert.ok(!calls.some((c) => /\/advideos/.test(c.url)), 'must NOT call the ad-account advideos endpoint');
    assertNoLeak({ body: r.body }, [LITE_USER_TOKEN, LITE_PAGE_TOKEN]);
  });
});

test('GET /pages facebook_lite lists administered pages from the EAAD6V token (Worker bridge authorization probe), token-free by default', async () => {
  const PAGE = '1008898512617594';
  const LITE_USER_TOKEN = 'EAAD6Vuser0000000000000000000';
  const LITE_PAGE_TOKEN = 'EAAD6Vpage0000000000000000000';
  let meAccountsToken = null;
  await withExportServer({
    keychain: mockKeychain(),
    fbLiteTokenService: mockFbLite({ token: LITE_USER_TOKEN }),
    browser: exportBrowser({}),
    fetch: async (url) => {
      const u = String(url);
      if (u.includes('/me/accounts')) {
        const m = u.match(/access_token=([^&]+)/);
        meAccountsToken = m ? decodeURIComponent(m[1]) : null;
        return { ok: true, status: 200, json: async () => ({ data: [{ id: PAGE, name: 'เฉียบ', access_token: LITE_PAGE_TOKEN }] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('GET', '/pages?account=100090320823561');
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'facebook_lite_eaad6');
    assert.ok(Array.isArray(r.body.data));
    assert.ok(r.body.data.map((p) => String(p.id)).includes(PAGE), 'must list the administered page so the Worker authorizes it');
    // me/accounts was resolved with the freshly minted EAAD6V token, and no page token leaks by default.
    assert.equal(meAccountsToken, LITE_USER_TOKEN);
    for (const p of r.body.data) assert.equal(p.access_token, undefined, 'page tokens are stripped without includeToken');
    assertNoLeak({ body: r.body }, [LITE_USER_TOKEN, LITE_PAGE_TOKEN]);
  });
});

test('GET /token facebook_lite includeToken=1 reveals the raw EAAD6V token to a LOCAL operator (UI verification)', async () => {
  const LITE_USER_TOKEN = 'EAAD6Vuser0000000000000000000';
  await withExportServer({
    keychain: mockKeychain(),
    fbLiteTokenService: mockFbLite({ token: LITE_USER_TOKEN }),
    browser: exportBrowser({}),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
  }, async (request) => {
    // Without includeToken: prefix only, no raw token (the default safe probe).
    const safe = await request('GET', '/token?account=100090320823561&facebook_lite=1');
    assert.equal(safe.body.ok, true);
    assert.equal(safe.body.tokenPrefix, 'EAAD6V');
    assert.equal('token' in safe.body, false);
    // With includeToken=1 from localhost: the raw token IS returned for operator verification.
    const r = await request('GET', '/token?account=100090320823561&facebook_lite=1&includeToken=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.source, 'facebook_lite_eaad6');
    assert.equal(r.body.tokenPrefix, 'EAAD6V');
    assert.equal(r.body.token, LITE_USER_TOKEN);
    assert.ok(String(r.body.warning || '').includes('localhost'));
  });
});

test('GET /token facebook_lite includeToken=1 is refused (403) for a NON-local request (never reveals the token remotely)', async () => {
  const r = await callHandler({ keychain: mockKeychain(), fbLiteTokenService: mockFbLite() }, {
    method: 'GET',
    path: '/token?account=100090320823561&facebook_lite=1&includeToken=1',
    remoteAddress: '203.0.113.7'
  });
  assert.equal(r.status, 403);
  assert.equal('token' in r.body, false);
});

test('POST /page-comment facebook_lite mints a fresh EAAD6V token, resolves me/accounts and comments as the Page with the page token (never CloakBrowser, no leak)', async () => {
  const PAGE = '1008898512617594';
  const STORY = `${PAGE}_NEWPOST`;
  const LITE_USER_TOKEN = 'EAAD6Vuser0000000000000000000';
  const LITE_PAGE_TOKEN = 'EAAD6Vpage0000000000000000000';
  const loginCalls = [];
  let meAccountsToken = null;
  let commentBody = null;
  let commentTarget = null;
  // A login-tracking Facebook Lite service: records that facebookLogin is the source of the token
  // (so we prove the comment is minted from stored credentials, not a CloakBrowser session).
  const fbLiteTracking = {
    extractTokenPrefix: realExtractTokenPrefix,
    facebookLogin: async (args) => { loginCalls.push(args); return { success: true, converted_token: { access_token: LITE_USER_TOKEN } }; }
  };
  await withExportServer({
    keychain: mockKeychain(),
    fbLiteTokenService: fbLiteTracking,
    // A CloakBrowser session would throw on every me/accounts; it is never consulted for Lite.
    browser: exportBrowser({ graphErrorsByAccount: { '100090320823561': 'cloak_session_must_not_be_used' } }),
    fetch: async (url, opts) => {
      const u = String(url);
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      if (u.includes('/me/accounts')) {
        const m = u.match(/access_token=([^&]+)/);
        meAccountsToken = m ? decodeURIComponent(m[1]) : null;
        return { ok: true, status: 200, json: async () => ({ data: [{ id: PAGE, name: 'เฉียบ', access_token: LITE_PAGE_TOKEN }] }) };
      }
      if (u.includes(`/${encodeURIComponent(STORY)}/comments`) || (u.includes('/comments') && u.includes(STORY))) {
        commentTarget = u;
        commentBody = opts && opts.body ? JSON.parse(opts.body) : null;
        return { ok: true, status: 200, json: async () => ({ id: `${STORY}_CMT1` }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/page-comment', {
      account: '100090320823561',
      facebook_lite: 1,
      page_id: PAGE,
      story_id: STORY,
      message: 'comment from lite'
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.source, 'facebook_lite_eaad6');
    assert.equal(r.body.token_prefix, 'EAAD6V');
    assert.equal(r.body.id, `${STORY}_CMT1`);
    assert.equal(r.body.author_expected, 'page');
    // The token came from a fresh credential login, me/accounts was resolved with that user token,
    // and the comment was authored with the PAGE token resolved for this page id.
    assert.equal(loginCalls.length, 1, 'must mint a fresh token via facebookLogin');
    assert.equal(meAccountsToken, LITE_USER_TOKEN);
    assert.ok(commentTarget && commentTarget.includes(STORY), 'comment must target the story id');
    assert.ok(commentBody && commentBody.access_token === LITE_PAGE_TOKEN, 'comment must use the resolved page token');
    assertNoLeak({ body: r.body }, [LITE_USER_TOKEN, LITE_PAGE_TOKEN]);
  });
});

test('POST /page-comment facebook_lite fails closed (token-free) when the credential login cannot mint a token', async () => {
  await withExportServer({
    keychain: mockKeychain(),
    fbLiteTokenService: mockFbLite({ success: false, error: 'login_failed' }),
    browser: exportBrowser({}),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
  }, async (request) => {
    const r = await request('POST', '/page-comment', {
      account: '100090320823561',
      facebook_lite: 1,
      page_id: '1008898512617594',
      story_id: '1008898512617594_NEWPOST',
      message: 'comment from lite'
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.source, 'facebook_lite_eaad6');
    assert.equal(r.body.step, 'facebook_lite_token');
    assert.equal('token' in r.body, false);
    assert.equal('access_token' in r.body, false);
  });
});

test('/token/export falls back to the default posting account when the explicit alias lacks a session', async () => {
  const SECRET = 'unit-test-bridge-secret';
  let captured = null;
  // CHEARB has no usable session; the default posting account (content_paiya) administers the page.
  await withExportEnv({ BRIDGE_TOKEN_SYNC_SECRET: SECRET }, () => withExportServer({
    browser: exportBrowser({
      noSessionAccounts: ['CHEARB'],
      pagesByAccount: {
        content_paiya: [{ id: '1008898512617594', name: 'เฉียบ', access_token: 'PAGESECRET' }]
      }
    }),
    fetch: async (url, opts) => {
      if (String(url).includes('/api/pages/profile-sync')) {
        captured = { headers: opts.headers, body: JSON.parse(opts.body) };
        return { ok: true, status: 200, json: async () => ({ success: true, updated: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/token/export', {
      account: 'CHEARB',
      namespaceId: 'NS',
      pageId: '1008898512617594',
      dryRun: false
    });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.synced, true);
    assert.equal(r.body.status, 'synced');
    assert.equal(r.body.page_found, true);
    assert.equal(r.body.hasToken, true);
    // The response names the EFFECTIVE account (the default), not the explicit alias, and is token-free.
    assert.equal(r.body.account, 'CONTENT_PAIYA');
    assert.equal('access_token' in r.body, false);
    assert.equal('token' in r.body, false);
    assertNoLeak(r.body, ['PAGESECRET', 'SESSION_content_paiya', SECRET]);
    assert.ok(captured, 'profile-sync must be called via the default session token');
    assert.equal(captured.body.access_token, 'PAGESECRET');
    assert.equal(captured.body.account, 'CONTENT_PAIYA');
  }));
});

test('/token/export returns no_session when neither the alias nor the default account has a session', async () => {
  const SECRET = 'unit-test-bridge-secret';
  let pushCalled = false;
  await withExportEnv({ BRIDGE_TOKEN_SYNC_SECRET: SECRET }, () => withExportServer({
    browser: exportBrowser({ noSessionAccounts: ['CHEARB', 'content_paiya'] }),
    fetch: async (url) => {
      if (String(url).includes('/api/pages/profile-sync')) pushCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/token/export', {
      account: 'CHEARB', namespaceId: 'NS', pageId: '1008898512617594', dryRun: false
    });
    assert.equal(r.body.status, 'no_session');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.synced, false);
    assert.equal(r.body.page_found, false);
    assert.equal(r.body.hasToken, false);
    assert.equal(pushCalled, false, 'no token => no profile-sync push');
    assert.equal('access_token' in r.body, false);
  }));
});

test('/token/export returns page_not_found when no administered session lists the page', async () => {
  const SECRET = 'unit-test-bridge-secret';
  let pushCalled = false;
  const mockBrowser = exportBrowser({
    pagesByAccount: {
      CHEARB: [{ id: '999', name: 'Other', access_token: 'X' }],
      content_paiya: [{ id: '888', name: 'Other2', access_token: 'Y' }]
    }
  });
  // Both the alias and the default account have sessions, but neither administers the requested page.
  await withExportEnv({ BRIDGE_TOKEN_SYNC_SECRET: SECRET }, () => withExportServer({
    browser: mockBrowser,
    fetch: async (url) => {
      if (String(url).includes('/api/pages/profile-sync')) pushCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/token/export', {
      account: 'CHEARB', namespaceId: 'NS', pageId: '1008898512617594', dryRun: false
    });
    assert.equal(r.body.status, 'page_not_found');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.page_found, false);
    assert.equal(pushCalled, false);
    assert.ok(mockBrowser.graphCalls.some((call) => call.account === 'CHEARB' && /\/me\/accounts/.test(call.url)));
    assert.ok(mockBrowser.graphCalls.some((call) => call.account === 'content_paiya' && /\/me\/accounts/.test(call.url)));
    assertNoLeak(r.body, ['SESSION_CHEARB', 'SESSION_content_paiya', 'X', 'Y', SECRET]);
  }));
});

test('/token/export returns page_token_unavailable when the page is administered but carries no token', async () => {
  const SECRET = 'unit-test-bridge-secret';
  let pushCalled = false;
  await withExportEnv({ BRIDGE_TOKEN_SYNC_SECRET: SECRET }, () => withExportServer({
    browser: exportBrowser({
      pagesByAccount: {
        CHEARB: [{ id: '1008898512617594', name: 'เฉียบ' }],
        content_paiya: [{ id: '1008898512617594', name: 'เฉียบ' }]
      }
    }),
    fetch: async (url) => {
      if (String(url).includes('/api/pages/profile-sync')) pushCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const r = await request('POST', '/token/export', {
      account: 'CHEARB', namespaceId: 'NS', pageId: '1008898512617594', dryRun: false
    });
    assert.equal(r.body.status, 'page_token_unavailable');
    assert.equal(r.body.ok, false);
    assert.equal(r.body.page_found, true);
    assert.equal(r.body.hasToken, false);
    assert.equal(pushCalled, false);
    assert.equal('access_token' in r.body, false);
    assert.equal('token' in r.body, false);
    assertNoLeak(r.body, ['SESSION_CHEARB', 'SESSION_content_paiya', SECRET]);
  }));
});

test('/token/export sanitizes graph failure reasons and console output', async () => {
  const SECRET = 'unit-test-bridge-secret';
  const leakyReason = 'graph failed access_token=EAAB_USER_SECRET fb_dtsg=FB_DTSG_SECRET datr=DATR_SECRET cookie=c_user=123 password=PW_SECRET';
  let pushCalled = false;
  let r;
  await withExportEnv({ BRIDGE_TOKEN_SYNC_SECRET: SECRET }, () => withExportServer({
    browser: exportBrowser({
      graphErrorsByAccount: {
        CHEARB: leakyReason,
        content_paiya: leakyReason
      }
    }),
    fetch: async (url) => {
      if (String(url).includes('/api/pages/profile-sync')) pushCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  }, async (request) => {
    const captured = await captureConsole(async () => {
      r = await request('POST', '/token/export', {
        account: 'CHEARB',
        namespaceId: 'NS',
        pageId: '1008898512617594',
        dryRun: false
      });
    });
    assert.equal(r.body.status, 'graph_pages_failed');
    assert.equal(r.body.ok, false);
    assert.equal(pushCalled, false);
    assert.match(r.body.reason, /access_token=\[REDACTED\]/);
    assert.match(r.body.reason, /fb_dtsg=\[REDACTED\]/);
    assert.match(r.body.reason, /datr=\[REDACTED\]/);
    assert.match(r.body.reason, /cookie=\[REDACTED\]/);
    assert.match(r.body.reason, /password=\[REDACTED\]/);
    assertNoLeak({ body: r.body, logs: captured.lines }, [
      'EAAB_USER_SECRET',
      'FB_DTSG_SECRET',
      'DATR_SECRET',
      'c_user=123',
      'PW_SECRET',
      SECRET
    ]);
  }));
});
