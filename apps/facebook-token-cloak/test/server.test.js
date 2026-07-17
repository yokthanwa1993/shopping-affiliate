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

test('native-only Accounts Bridge ships no local web UI files', async () => {
  const uiHtml = path.join(__dirname, '..', 'src', 'ui.html');
  const uiJs = path.join(__dirname, '..', 'src', 'ui.js');
  await assert.rejects(fs.access(uiHtml), { code: 'ENOENT' });
  await assert.rejects(fs.access(uiJs), { code: 'ENOENT' });
});

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
  process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED = '1';
  store.clear();
  internetStore.clear();
  securityCalls.length = 0;
  selectorConfigPath = await tempConfigPath();
  keychain.setRunner(fakeRunner);
  await listenWith();
});

afterEach(async () => {
  delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED;
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

test('/login safe visible no-autofill no-submit is allowed when browser login is disabled', async () => {
  // Operator "Open Browser Session" debug case: a VISIBLE window with autofill=0 AND submit=0 may
  // be opened even when FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED is not set, so the operator can
  // see which user is logged in / whether Facebook is stuck at checkpoint. No credential is read,
  // nothing is submitted, and no secret is returned.
  delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED;
  const r = await req('GET', '/login?account=CHEARB&visible=1&autofill=0&submit=0');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'login_opened');
  assert.equal(r.body.autofilled, false);
  assert.equal(r.body.submitted, false);
  assertNoLeak(r.body, ['EAAB_USER_SECRET']);
});

test('/login still rejects autofill or submit while browser login is disabled', async () => {
  // The unsafe automation (read a stored credential / submit a login) stays gated behind the env
  // flag. With the flag unset, any autofill=1 or submit=1 is refused with browser_login_disabled.
  delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED;

  let r = await req('GET', '/login?account=CHEARB&visible=1&autofill=1&submit=0');
  assert.equal(r.status, 410);
  assert.equal(r.body.state, 'browser_login_disabled');
  assert.equal(r.body.reason, 'browser_login_disabled');

  r = await req('GET', '/login?account=CHEARB&visible=1&autofill=0&submit=1');
  assert.equal(r.status, 410);
  assert.equal(r.body.state, 'browser_login_disabled');
});



test('/login/close closes the cached browser session idempotently and token-free', async () => {
  let closed = 0;
  const deps = browser('https://www.facebook.com/login');
  let liveContext = {
    close: async () => { closed += 1; },
    browser: () => ({ isConnected: () => true })
  };
  deps.closeAccountContext = async (account) => {
    if (account !== 'CHEARB') return { closed: false, state: 'not_open' };
    if (!liveContext) return { closed: false, state: 'not_open' };
    await liveContext.close();
    liveContext = null;
    return { closed: true, state: 'closed' };
  };
  const handler = createHandler({ keychain, browser: deps, selectors: selectorStore(selectorConfigPath), graphFetch: fakeFetch });
  const call = (path) => new Promise((resolve, reject) => {
    const req = new Readable({ read() {} });
    req.url = path;
    req.method = 'GET';
    req.headers = { host: '127.0.0.1' };
    req.socket = { remoteAddress: '127.0.0.1' };
    const chunks = [];
    const res = {
      setHeader() {},
      writeHead(status) { this.statusCode = status; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode || 200, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
    };
    handler(req, res).catch(reject);
    req.push(null);
  });
  let r = await call('/login/close?account=CHEARB');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'closed');
  assert.equal(r.body.closed, true);
  assert.equal(closed, 1);
  assertNoLeak(r.body, ['EAAB_USER_SECRET']);
  r = await call('/login/close?account=CHEARB');
  assert.equal(r.body.state, 'not_open');
  assert.equal(r.body.closed, false);
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

const EXPORT_SECRET_ENV = ['BRIDGE_TOKEN_SYNC_SECRET', 'TAG_SYNC_PUSH_SECRET', 'BROWSERSAVING_TAG_SYNC_SECRET', 'FACEBOOK_TOKEN_CLOAK_AUTOSYNC_TTL_MS'];

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
function callHandler(deps, { method, path, body, remoteAddress, headers }) {
  const handler = createHandler({ accountSelectors: selectorStore(selectorConfigPath), ...deps });
  const payload = body ? JSON.stringify(body) : '';
  const req = Readable.from([payload]);
  req.method = method;
  req.url = path;
  req.headers = Object.assign({ host: '127.0.0.1' }, headers || {});
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

test('LaunchAgent default post account is Thanwan and ads account is Chanalai', () => {
  const nodeFs = require('node:fs');
  const plist = nodeFs.readFileSync(path.join(__dirname, '..', 'launchd', 'com.affiliate.facebook-token-cloak.plist'), 'utf8');
  assert.match(plist, /<key>FACEBOOK_TOKEN_CLOAK_POST_ACCOUNT<\/key>\s*<string>100077795357192<\/string>/);
  assert.match(plist, /<key>FACEBOOK_TOKEN_CLOAK_ADS_ACCOUNT<\/key>\s*<string>100090320823561<\/string>/);
  assert.doesNotMatch(plist, /content_paiya/);
});

// ── Facebook Lite removed — minting/enumeration/auto-sync moved to the IDLogin/IDBridge stack ──
// Every Facebook Lite request (numeric uid or an explicit facebook_lite flag) must FAIL CLOSED with
// 410 facebook_lite_removed and mint/enumerate/publish nothing here. The CloakBrowser/Power-Editor
// session paths for non-lite accounts are covered by the /token/export + /accounts tests above.
const FB_LITE_ACCOUNT = '100090320823561'; // numeric uid => Facebook Lite dispatch

test('/token/auto-sync is removed (410 facebook_lite_removed), mints nothing', async () => {
  const r = await callHandler({ browser: browser() }, { method: 'POST', path: '/token/auto-sync', body: { namespaceId: 'NS', dryRun: false } });
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'facebook_lite_removed');
  assert.equal('token' in r.body, false);
  assert.equal('access_token' in r.body, false);
});

test('/token/import-pages is removed (410 facebook_lite_removed), resolves no token', async () => {
  const r = await callHandler({ browser: browser() }, { method: 'POST', path: '/token/import-pages', body: { account: FB_LITE_ACCOUNT, namespaceId: 'NS', dryRun: false } });
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'facebook_lite_removed');
});

test('/token/export fails closed (410) for a Facebook Lite (numeric) account — never mints', async () => {
  const r = await callHandler({ browser: browser() }, { method: 'POST', path: '/token/export', body: { account: FB_LITE_ACCOUNT, namespaceId: 'NS', pageId: '11', dryRun: false } });
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'facebook_lite_removed');
  assert.equal('token' in r.body, false);
  assert.equal('access_token' in r.body, false);
});

test('/token/export with an explicit facebook_lite flag fails closed (410)', async () => {
  const r = await callHandler({ browser: browser() }, { method: 'POST', path: '/token/export', body: { account: 'CHEARB', facebook_lite: 1, namespaceId: 'NS', pageId: '11', dryRun: false } });
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'facebook_lite_removed');
});

test('GET /token?facebook_lite=1&includeToken=1 fails closed (410), reveals no token', async () => {
  const r = await callHandler({ browser: browser() }, { method: 'GET', path: '/token?account=' + FB_LITE_ACCOUNT + '&facebook_lite=1&includeToken=1' });
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'facebook_lite_removed');
  assert.equal('token' in r.body, false);
});

test('GET /pages?facebook_lite=1 fails closed (410)', async () => {
  const r = await callHandler({ browser: browser() }, { method: 'GET', path: '/pages?account=' + FB_LITE_ACCOUNT + '&facebook_lite=1' });
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'facebook_lite_removed');
});

test('POST /post facebook_lite fails closed (410), publishes nothing', async () => {
  const r = await callHandler({ browser: browser() }, { method: 'POST', path: '/post', body: { account: FB_LITE_ACCOUNT, facebook_lite: 1, page_id: '11', video_url: 'https://example.test/v.mp4' } });
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'facebook_lite_removed');
});

test('POST /page-comment facebook_lite fails closed (410), comments nothing', async () => {
  const r = await callHandler({ browser: browser() }, { method: 'POST', path: '/page-comment', body: { account: FB_LITE_ACCOUNT, facebook_lite: 1, page_id: '11', message: 'hi' } });
  assert.equal(r.status, 410);
  assert.equal(r.body.step, 'facebook_lite_removed');
});
