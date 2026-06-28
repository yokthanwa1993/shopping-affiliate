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

// Shared spy of browser side-effects. Reset per test so a profile-status read can prove it never
// launched a browser (openPage stays at 0). profileStatus mirrors the real shape (booleans only).
let browserCalls;

function browser() {
  return {
    PROFILE_ROOT: '/tmp/profiles',
    loadBrowserBackend: async () => ({ backend: 'mock-browser' }),
    openPage: async () => {
      browserCalls.openPage += 1;
      return {
        backend: 'mock-browser',
        profileDir: '/tmp/profiles/x',
        page: { url: () => 'https://www.facebook.com/login', textContent: async () => '' }
      };
    },
    fillFacebookLogin: async () => ({ autofilled: false, submitted: false }),
    profileStatus: account => {
      browserCalls.profileStatus += 1;
      const key = String(account).toLowerCase();
      return {
        account: String(account).toUpperCase(),
        key,
        profileDir: key,
        profileExists: true,
        running: account === 'OPENACC',
        bridgeSession: account === 'OPENACC',
        visibleSession: account === 'OPENACC',
        lockPidPresent: false,
        pidCount: 0
      };
    }
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
  browserCalls = { openPage: 0, profileStatus: 0 };
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

test('GET / web UI is disabled because Account Manager is native-only', async () => {
  const r = await getRaw('/');
  assert.equal(r.status, 410);
  assert.match(r.text, /native_app_only/);
  assertNoLeak(r.text, SECRETS);
});

// Raw request that lets a test set arbitrary headers (Origin) and method (OPTIONS) to exercise CORS.
function rawReq(method, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: '127.0.0.1', port: server.address().port, path: reqPath, method, headers },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

test('CORS preflight is allowed for the Pubilo dashboard origin on safe accounts endpoints', async () => {
  const r = await rawReq('OPTIONS', '/accounts', { Origin: 'https://www.pubilo.com' });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'https://www.pubilo.com');
  assert.match(r.headers['access-control-allow-methods'] || '', /GET/);
});


test('CORS preflight opts into Chromium private-network access for Pubilo dashboard', async () => {
  const r = await rawReq('OPTIONS', '/accounts', {
    Origin: 'https://www.pubilo.com',
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Private-Network': 'true'
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'https://www.pubilo.com');
  assert.equal(r.headers['access-control-allow-private-network'], 'true');
});

test('CORS echoes the allowed origin on a real safe GET', async () => {
  const r = await rawReq('GET', '/accounts', { Origin: 'https://pubilo.com' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], 'https://pubilo.com');
});

test('CORS is refused for a non-allowlisted origin', async () => {
  const r = await rawReq('OPTIONS', '/accounts', { Origin: 'https://evil.example.com' });
  assert.equal(r.status, 403);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('CORS is not applied to non-safe (token/posting) endpoints', async () => {
  // /token/refresh is a token route — it must never gain cross-origin reach, even from pubilo.com.
  const r = await rawReq('OPTIONS', '/token/refresh', { Origin: 'https://www.pubilo.com' });
  assert.equal(r.status, 403);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('native-only mode keeps account APIs working while browser login stays disabled', async () => {
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

  r = await req('GET', '/accounts');
  assert.equal(r.status, 200);
  const acc = r.body.accounts.find(a => a.account === 'CHEARB');
  assert.ok(acc);
  assert.equal(acc.credentialPresent, true);
  assert.equal(acc.totpPresent, true);
  assertNoLeak(r.body, SECRETS);

  r = await req('GET', '/login?account=CHEARB&visible=1&autofill=1&submit=1');
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'browser_login_disabled');
  assert.equal(r.body.state, 'browser_login_disabled');
  assertNoLeak(r.body, SECRETS);

  r = await req('POST', '/token/refresh', { account: 'CHEARB', visible: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.tokenPresent, false);
  assert.equal(r.body.token, undefined);
  assertNoLeak(r.body, SECRETS);
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

// ── Native profile-manager status endpoint (token-free, no browser launch) ───────────────────────

test('GET /accounts/profile-status?account lists single profile status without opening a browser', async () => {
  await req('POST', '/accounts', { account: 'CHEARB', username: 'u@example.com', password: 'pw-secret' });

  const r = await req('GET', '/accounts/profile-status?account=CHEARB');
  assert.equal(r.status, 200);
  assert.ok(r.body.profile, 'single profile returned');
  assert.equal(r.body.profile.account, 'CHEARB');
  assert.equal(r.body.profile.profileDir, 'chearb'); // basename only — never an absolute path
  assert.ok(!r.body.profile.profileDir.includes('/'), 'profileDir is basename only, no path separators');
  assert.equal(r.body.profile.profileExists, true);
  assert.equal(r.body.profile.statusKnown, true);
  // Booleans only — the status read must NEVER carry token/cookie/credential material.
  assert.equal(r.body.profile.token, undefined);
  assert.equal(r.body.profile.accessToken, undefined);
  assertNoLeak(r.body, SECRETS);

  // Hard guarantee of "status-only": the status read launched no browser.
  assert.equal(browserCalls.openPage, 0, 'profile-status must not open a browser');
  assert.ok(browserCalls.profileStatus >= 1, 'profile-status delegated to browser.profileStatus');
});

test('GET /accounts/profile-status reports running/visible for the operator-opened profile', async () => {
  await req('POST', '/accounts', { account: 'OPENACC', username: 'u@example.com', password: 'pw-secret' });

  const r = await req('GET', '/accounts/profile-status?account=OPENACC');
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.running, true);
  assert.equal(r.body.profile.bridgeSession, true);
  assert.equal(r.body.profile.visibleSession, true);
  assert.equal(browserCalls.openPage, 0, 'reporting a running profile must not itself open a browser');
});

test('GET /accounts/profile-status (no account) lists every account profile and launches nothing', async () => {
  await req('POST', '/accounts', { account: 'CHEARB', username: 'u@example.com', password: 'pw-secret' });
  await req('POST', '/accounts', { account: 'PAGEX', provider: 'apple-passwords', username: 'p@example.com', domain: 'facebook.com' });

  const r = await req('GET', '/accounts/profile-status');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.profiles), 'profiles list returned');
  const names = r.body.profiles.map(p => p.account).sort();
  assert.deepEqual(names, ['CHEARB', 'PAGEX']);
  for (const p of r.body.profiles) {
    assert.equal(typeof p.running, 'boolean');
    assert.equal(typeof p.profileExists, 'boolean');
    assert.ok(!String(p.profileDir).includes('/'), 'profileDir basename only');
  }
  assertNoLeak(r.body, SECRETS);
  assert.equal(browserCalls.openPage, 0, 'bulk profile-status must not open any browser');
});

test('GET /accounts/profile-status?account rejects an invalid account without side effects', async () => {
  const r = await req('GET', '/accounts/profile-status?account=' + encodeURIComponent('bad/../acct'));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Invalid account/);
  assert.equal(browserCalls.openPage, 0);
});
