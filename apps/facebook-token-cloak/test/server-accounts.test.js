'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const keychain = require('../src/keychain');
const accountSelectors = require('../src/account-selectors');
const accountsRegistry = require('../src/accounts-registry');
const { store, internetStore, securityCalls, fakeRunner } = require('./_helpers');

function assertNoLeak(value, secrets) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!payload.includes(secret), `leaked ${secret}`);
}

const SECRETS = ['pw-secret', 'TOTPSECRET', 'DATRSECRET'];

let server;
let registryConfigPath;
let selectorConfigPath;

function selectorStore(configPath) {
  return {
    getSelector: account => accountSelectors.getSelector(account, { configPath }),
    getSelectorStatus: account => accountSelectors.getSelectorStatus(account, { configPath }),
    listStatuses: () => accountSelectors.listStatuses({ configPath }),
    saveSelector: (account, selector) => accountSelectors.saveSelector(account, selector, { configPath }),
    deleteSelector: account => accountSelectors.deleteSelector(account, { configPath })
  };
}

function registryStore(configPath) {
  return {
    listAccounts: () => accountsRegistry.listAccounts({ configPath }),
    getAccount: account => accountsRegistry.getAccount(account, { configPath }),
    upsertAccount: (account, input) => accountsRegistry.upsertAccount(account, input, { configPath }),
    deleteAccount: account => accountsRegistry.deleteAccount(account, { configPath })
  };
}

function browser() {
  return {
    PROFILE_ROOT: '/tmp/profiles',
    loadBrowserBackend: async () => ({ backend: 'mock-browser' }),
    openPage: async () => ({
      backend: 'mock-browser',
      profileDir: '/tmp/profiles/x',
      page: { url: () => 'https://www.facebook.com/login', textContent: async () => '' }
    }),
    fillFacebookLogin: async () => ({ autofilled: false, submitted: false })
  };
}

async function tempPath(prefix, file) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(dir, file);
}

function req(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: reqPath,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function getRaw(reqPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port: server.address().port, path: reqPath, method: 'GET' }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    r.on('error', reject);
    r.end();
  });
}

beforeEach(async () => {
  store.clear();
  internetStore.clear();
  securityCalls.length = 0;
  registryConfigPath = await tempPath('facebook-token-cloak-reg-', 'registry.json');
  selectorConfigPath = await tempPath('facebook-token-cloak-sel-', 'accounts.json');
  keychain.setRunner(fakeRunner);
  server = createServer({
    browser: browser(),
    accountSelectors: selectorStore(selectorConfigPath),
    accountsRegistry: registryStore(registryConfigPath)
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  keychain.clearRunner();
  await new Promise(resolve => server.close(resolve));
});

test('GET / serves the simple account table/form console and never requests a raw token', async () => {
  const r = await getRaw('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.ok(r.headers['content-security-policy'], 'CSP header present');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.text, /Facebook Token Cloak/);
  assert.match(r.text, /id="accounts-table"/);
  assert.match(r.text, /id="account-form"/);
  assert.match(r.text, /id="account-input"/);
  assert.match(r.text, /id="username-input"/);
  assert.match(r.text, /id="password-input"/);
  assert.match(r.text, /id="totp-input"/);
  assert.match(r.text, /Save/);
  assert.match(r.text, /Login\/Get Token/);
  assert.match(r.text, /Delete/);
  const visibleMarkup = r.text.slice(0, r.text.indexOf('<script>'));
  assert.doesNotMatch(visibleMarkup, /provider-input/i);
  assert.doesNotMatch(visibleMarkup, />\s*Provider\s*</i);
  assert.doesNotMatch(visibleMarkup, /<select/i);
  assert.doesNotMatch(visibleMarkup, /<option/i);
  assert.doesNotMatch(visibleMarkup, /domain-input/i);
  assert.doesNotMatch(visibleMarkup, /server-input/i);
  assert.doesNotMatch(visibleMarkup, /protocol-input/i);
  assert.doesNotMatch(visibleMarkup, />\s*(Domain|Server|Protocol)\s*</i);
  assert.doesNotMatch(r.text, /apple-passwords/i);
  assert.doesNotMatch(r.text, /passwords\/status/i);
  assert.doesNotMatch(r.text, /credentialProvider/i);
  assert.doesNotMatch(r.text, /Service overview/);
  assert.doesNotMatch(r.text, /Token tools/);
  assert.doesNotMatch(r.text, /token-out/);
  assert.doesNotMatch(r.text, /refresh-button/);
  assert.doesNotMatch(r.text, /btn-export/);
  assert.doesNotMatch(r.text, /\/token\/export/);
  assert.doesNotMatch(r.text, /includeToken/i, 'UI must not mention or request raw token output');
  assert.doesNotMatch(r.text, /datr/i);
  assert.doesNotMatch(r.text, /Convert token mode/);
  // Static page carries no secret literals.
  assertNoLeak(r.text, SECRETS);
});

test('GET / uses only the generic-keychain UI save/login path', async () => {
  const r = await getRaw('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /function formAccount\(\)[\s\S]*provider: "generic-keychain"[\s\S]*password: value\("#password-input"\)[\s\S]*totp: value\("#totp-input"\)/);
  assert.match(r.text, /api\("POST", "\/accounts", body\)/);
  assert.match(r.text, /var loginPath = "\/login\?account=" \+ encodeURIComponent\(account\) \+ "&visible=1&autofill=1&submit=1";/);
  assert.match(r.text, /api\("POST", "\/token\/refresh", \{ account: account, visible: false \}\)/);
  assert.doesNotMatch(r.text, /provider=/i);
  assert.doesNotMatch(r.text, /domain|server|protocol/i);
  assert.doesNotMatch(r.text, /apple-passwords/i);
  assert.doesNotMatch(r.text, /includeToken/i);
});

test('simple save/login/token path stays redacted and clears write-only fields in UI code', async () => {
  let r = await req('POST', '/accounts', {
    account: 'CHEARB',
    provider: 'generic-keychain',
    username: 'fb-hint@example.com',
    password: 'pw-secret',
    totp: 'TOTPSECRET'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.credentialUpdated, true);
  assert.equal(r.body.totpUpdated, true);
  assertNoLeak(r.body, SECRETS);

  r = await req('GET', '/login?account=CHEARB&visible=1&autofill=1&submit=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'login_opened');
  assert.equal(r.body.credentialProvider, 'generic-keychain');
  assert.equal(typeof r.body.autofilled, 'boolean');
  assert.equal(typeof r.body.submitted, 'boolean');
  assertNoLeak(r.body, SECRETS);

  r = await req('POST', '/token/refresh', { account: 'CHEARB', visible: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.tokenPresent, false);
  assert.equal(r.body.token, undefined);
  assertNoLeak(r.body, SECRETS);

  const page = await getRaw('/');
  assert.match(page.text, /function clearSecretFields\(\)/);
  assert.match(page.text, /clearSecretFields\(\);[\s\S]*fillForm\(saved\)/);
  assert.match(page.text, /\$\("#password-input"\)\.value = "";/);
  assert.match(page.text, /\$\("#totp-input"\)\.value = "";/);
  assert.doesNotMatch(page.text, /password-input"\)\.value\s*=\s*(account|saved|body|data|r)\./);
  assert.doesNotMatch(page.text, /totp-input"\)\.value\s*=\s*(account|saved|body|data|r)\./);
});

test('POST /accounts stores generic credential, 2FA and datr without leaking, list shows present flags', async () => {
  let r = await req('POST', '/accounts', {
    account: 'CHEARB',
    displayName: 'Chearb Page',
    provider: 'generic-keychain',
    username: 'fb-hint@example.com',
    domain: 'facebook.com',
    convertTokenMode: 'postcron-oauth',
    password: 'pw-secret',
    totp: 'TOTPSECRET',
    datr: 'DATRSECRET'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.account, 'CHEARB');
  assert.equal(r.body.credentialUpdated, true);
  assert.equal(r.body.totpUpdated, true);
  assert.equal(r.body.datrUpdated, true);
  assert.equal(r.body.credentialPresent, true);
  assert.equal(r.body.totpPresent, true);
  assert.equal(r.body.datrPresent, true);
  assert.equal(r.body.username, 'fb-hint@example.com'); // username hint is allowed to be shown
  assertNoLeak(r.body, SECRETS);

  r = await req('GET', '/accounts');
  assert.equal(r.status, 200);
  const acc = r.body.accounts.find(a => a.account === 'CHEARB');
  assert.ok(acc, 'account listed');
  assert.equal(acc.provider, 'generic-keychain');
  assert.equal(acc.displayName, 'Chearb Page');
  assert.equal(acc.credentialPresent, true);
  assert.equal(acc.totpPresent, true);
  assert.equal(acc.datrPresent, true);
  assert.equal(acc.convertTokenMode, 'postcron-oauth');
  assert.equal(acc.inRegistry, true);
  assertNoLeak(r.body, SECRETS);

  // Secrets reached the Keychain, but never the on-disk registry.
  const onDisk = await fs.readFile(registryConfigPath, 'utf8');
  assertNoLeak(onDisk, SECRETS);
  const stored = [...store.values()];
  assert.ok(stored.includes('pw-secret'));
  assert.ok(stored.includes('TOTPSECRET'));
  assert.ok(stored.includes('DATRSECRET'));
});

test('POST /accounts apple-passwords saves the simplified UI selector defaults and reports it', async () => {
  let r = await req('POST', '/accounts', {
    account: 'PAGEX',
    provider: 'apple-passwords',
    username: 'fb-one@example.com',
    domain: 'facebook.com',
    server: 'facebook.com',
    protocol: 'https'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.selectorUpdated, true);
  assert.equal(r.body.selectorPresent, true);
  assert.equal(r.body.provider, 'apple-passwords');
  assert.equal(r.body.domain, 'facebook.com');
  assert.equal(r.body.server, 'facebook.com');
  assert.equal(r.body.protocol, 'https');

  r = await req('GET', '/accounts');
  const acc = r.body.accounts.find(a => a.account === 'PAGEX');
  assert.ok(acc);
  assert.equal(acc.selectorPresent, true);
  assert.equal(acc.provider, 'apple-passwords');
  assert.equal(acc.domain, 'facebook.com');
  assert.equal(acc.server, 'facebook.com');
  assert.equal(acc.protocol, 'https');

  r = await req('GET', '/accounts/selector?account=PAGEX');
  assert.equal(r.status, 200);
  assert.equal(r.body.selectorPresent, true);
  assert.equal(r.body.selectedDomain, 'facebook.com');
  assert.equal(r.body.selectedServer, 'facebook.com');
  assert.equal(r.body.selectedProtocol, 'https');
  assert.equal(r.body.usernameHintPresent, true);
  assertNoLeak(r.body, ['fb-one@example.com']);
});

test('POST /accounts rejects a password with no username/email/phone, and bad provider', async () => {
  let r = await req('POST', '/accounts', { account: 'NOUSER', password: 'pw-secret' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /username/);
  assertNoLeak(r.body, SECRETS);

  r = await req('POST', '/accounts', { account: 'BADPROV', provider: 'nope' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Unsupported credential provider/);
});

test('DELETE /accounts removes the registry entry and purges Keychain secrets', async () => {
  await req('POST', '/accounts', {
    account: 'DELME',
    username: 'u@example.com',
    password: 'pw-secret',
    totp: 'TOTPSECRET',
    datr: 'DATRSECRET'
  });

  let r = await req('GET', '/accounts');
  assert.ok(r.body.accounts.some(a => a.account === 'DELME'));

  r = await req('DELETE', '/accounts?account=DELME');
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, true);
  assert.equal(r.body.secretsPurged, true);

  r = await req('GET', '/accounts');
  assert.ok(!r.body.accounts.some(a => a.account === 'DELME'));

  r = await req('GET', '/keychain/status?account=DELME');
  assert.equal(r.body.credentialPresent, false);
  assert.equal(r.body.totpPresent, false);
  assert.equal(r.body.datrPresent, false);
});

test('/keychain/datr stores, reports and deletes without leaking the value', async () => {
  let r = await req('POST', '/keychain/datr', { account: 'CHEARB', datr: 'DATRSECRET' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assertNoLeak(r.body, SECRETS);

  r = await req('GET', '/keychain/datr?account=CHEARB');
  assert.equal(r.body.datrPresent, true);

  r = await req('GET', '/keychain/status?account=CHEARB');
  assert.equal(r.body.datrPresent, true);
  assertNoLeak(r.body, SECRETS);

  r = await req('DELETE', '/keychain/datr?account=CHEARB');
  assert.equal(r.body.ok, true);

  r = await req('GET', '/keychain/datr?account=CHEARB');
  assert.equal(r.body.datrPresent, false);
});

test('GET /accounts surfaces legacy selector-only accounts without leaking the username', async () => {
  await req('POST', '/accounts/selector', {
    account: 'LEGACY',
    credentialProvider: 'apple-passwords',
    domain: 'facebook.com',
    username: 'legacy@example.com'
  });

  const r = await req('GET', '/accounts');
  const acc = r.body.accounts.find(a => a.account === 'LEGACY');
  assert.ok(acc, 'legacy selector account is listed');
  assert.equal(acc.provider, 'apple-passwords');
  assert.equal(acc.selectorPresent, true);
  assert.equal(acc.inRegistry, false);
  // The apple-passwords selector username is a hint-only boolean; the value must not appear.
  assertNoLeak(r.body, ['legacy@example.com']);
});
