'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createServer, DEFAULT_PORT } = require('../src/server');
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
