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
const bridgeConfig = require('../src/bridge-config');
const { store, internetStore, securityCalls, fakeRunner } = require('./_helpers');

const SECRETS = ['pw-secret', 'TOTPSECRET'];

function assertTokenFree(value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  // No raw token surface: no EAA* token, and no truthy token/accessToken value in the body.
  assert.doesNotMatch(payload, /EAA[A-Za-z0-9_-]{8,}/, 'response carries a raw Facebook token');
  assert.doesNotMatch(payload, /"token"\s*:\s*"/, 'response carries a token field');
  assert.doesNotMatch(payload, /"accessToken"\s*:\s*"/, 'response carries an accessToken field');
  for (const secret of SECRETS) assert.ok(!payload.includes(secret), `leaked ${secret}`);
}

let server;
let registryConfigPath;
let selectorConfigPath;
let bridgeConfigPath;
let openPageCalls;

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

function bridgeStore(configPath) {
  return {
    FACEBOOK_ROLES: bridgeConfig.FACEBOOK_ROLES,
    FACEBOOK_ROLE_LABELS: bridgeConfig.FACEBOOK_ROLE_LABELS,
    getFacebookRoles: () => bridgeConfig.getFacebookRoles({ configPath }),
    setFacebookRoles: input => bridgeConfig.setFacebookRoles(input, { configPath })
  };
}

// A browser dep that FAILS LOUDLY if anything tries to open a page / mint via the browser. Bridge
// status/config reads must never reach it.
function noBrowser() {
  return {
    PROFILE_ROOT: '/tmp/profiles',
    loadBrowserBackend: async () => ({ backend: 'mock-browser' }),
    openPage: async () => {
      openPageCalls += 1;
      throw new Error('openPage must not be called for status/config');
    },
    fillFacebookLogin: async () => { throw new Error('fillFacebookLogin must not be called'); }
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

async function saveAccount(account, extra = {}) {
  return req('POST', '/accounts', {
    account,
    username: 'fb-hint@example.com',
    password: 'pw-secret',
    totp: 'TOTPSECRET',
    ...extra
  });
}

beforeEach(async () => {
  store.clear();
  internetStore.clear();
  securityCalls.length = 0;
  openPageCalls = 0;
  delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED;
  registryConfigPath = await tempPath('facebook-token-cloak-reg-', 'registry.json');
  selectorConfigPath = await tempPath('facebook-token-cloak-sel-', 'accounts.json');
  bridgeConfigPath = await tempPath('facebook-token-cloak-bridge-', 'bridge-config.json');
  keychain.setRunner(fakeRunner);
  server = createServer({
    browser: noBrowser(),
    accountSelectors: selectorStore(selectorConfigPath),
    accountsRegistry: registryStore(registryConfigPath),
    bridgeConfig: bridgeStore(bridgeConfigPath)
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  keychain.clearRunner();
  delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED;
  await new Promise(resolve => server.close(resolve));
});

// ── New Accounts Bridge APIs exist and are token-free ─────────────────────────────────────────

test('GET /accounts/bridge/status returns Shopee + Facebook sections and roles, token-free', async () => {
  const r = await req('GET', '/accounts/bridge/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.app, 'accounts-bridge');
  assert.ok(r.body.shopee, 'shopee section present');
  assert.ok(r.body.facebook, 'facebook section present');
  assert.equal(typeof r.body.facebook.accountsCount, 'number');
  assert.ok(r.body.facebook.roles.page_posting_facebook_lite, 'page posting role present');
  assert.ok(r.body.facebook.roles.ads_power_editor, 'ads power editor role present');
  // The two Facebook surfaces stay conceptually separate by name.
  assert.equal(r.body.facebook.roles.page_posting_facebook_lite.role, 'page_posting_facebook_lite');
  assert.equal(r.body.facebook.roles.ads_power_editor.role, 'ads_power_editor');
  assert.equal(openPageCalls, 0, 'status must not open a browser');
  assertTokenFree(r.body);
});

test('GET /accounts/bridge/facebook returns role mapping + local readiness, no browser/token', async () => {
  const r = await req('GET', '/accounts/bridge/facebook');
  assert.equal(r.status, 200);
  const roles = r.body.roles;
  assert.equal(roles.page_posting_facebook_lite.configured, false);
  assert.equal(roles.page_posting_facebook_lite.account, null);
  assert.equal(roles.ads_power_editor.configured, false);
  assert.equal(roles.page_posting_facebook_lite.readiness.source, 'local_metadata');
  assert.equal(openPageCalls, 0, 'config read must not open a browser');
  assertTokenFree(r.body);
});

// ── POST config stores/retrieves the two Facebook role accounts ───────────────────────────────

test('POST /accounts/bridge/facebook stores both role accounts and they persist on GET', async () => {
  await saveAccount('CHEARB');
  await saveAccount('ADSPAGE');

  let r = await req('POST', '/accounts/bridge/facebook', {
    page_posting_facebook_lite: 'CHEARB',
    ads_power_editor: 'ADSPAGE'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.updated, true);
  assert.equal(r.body.roles.page_posting_facebook_lite.account, 'CHEARB');
  assert.equal(r.body.roles.page_posting_facebook_lite.accountExists, true);
  assert.equal(r.body.roles.ads_power_editor.account, 'ADSPAGE');
  assert.equal(r.body.roles.ads_power_editor.accountExists, true);
  // Readiness reflects local Keychain metadata only (we stored password + 2FA above).
  assert.equal(r.body.roles.page_posting_facebook_lite.readiness.credentialPresent, true);
  assert.equal(r.body.roles.page_posting_facebook_lite.readiness.totpPresent, true);
  assertTokenFree(r.body);

  r = await req('GET', '/accounts/bridge/facebook');
  assert.equal(r.body.roles.page_posting_facebook_lite.account, 'CHEARB');
  assert.equal(r.body.roles.ads_power_editor.account, 'ADSPAGE');

  // It was actually written to the bridge-config file, not just held in memory.
  const onDisk = JSON.parse(await fs.readFile(bridgeConfigPath, 'utf8'));
  assert.equal(onDisk.facebook.page_posting_facebook_lite, 'CHEARB');
  assert.equal(onDisk.facebook.ads_power_editor, 'ADSPAGE');
  const raw = await fs.readFile(bridgeConfigPath, 'utf8');
  for (const secret of SECRETS) assert.ok(!raw.includes(secret), `bridge-config leaked ${secret}`);
});

test('POST /accounts/bridge/facebook rejects an account that does not exist', async () => {
  const r = await req('POST', '/accounts/bridge/facebook', { page_posting_facebook_lite: 'GHOST' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not found/i);
});

test('POST /accounts/bridge/facebook merges: clearing one role keeps the other', async () => {
  await saveAccount('CHEARB');
  await saveAccount('ADSPAGE');
  await req('POST', '/accounts/bridge/facebook', { page_posting_facebook_lite: 'CHEARB', ads_power_editor: 'ADSPAGE' });

  const r = await req('POST', '/accounts/bridge/facebook', { ads_power_editor: '' });
  assert.equal(r.status, 200);
  assert.equal(r.body.roles.ads_power_editor.account, null);
  assert.equal(r.body.roles.page_posting_facebook_lite.account, 'CHEARB');
});

// ── Explicit check defaults to dry-run, token-free, no browser ────────────────────────────────

test('POST /accounts/bridge/facebook/check defaults to dry-run with no browser open', async () => {
  await saveAccount('CHEARB');
  const r = await req('POST', '/accounts/bridge/facebook/check', { role: 'page_posting_facebook_lite', account: 'CHEARB' });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.browserOpened, false);
  assert.equal(r.body.accountExists, true);
  assert.equal(r.body.readiness.source, 'local_metadata');
  assert.equal(r.body.readiness.credentialPresent, true);
  assert.equal(openPageCalls, 0, 'dry-run check must not open a browser');
  assertTokenFree(r.body);
});

test('POST /accounts/bridge/facebook/check never opens a browser when browser login is disabled', async () => {
  await saveAccount('CHEARB');
  // Even with the explicit open flags, the global browser-login switch is off → no browser.
  const r = await req('POST', '/accounts/bridge/facebook/check', {
    account: 'CHEARB',
    dry_run: false,
    open_browser: true
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.browserOpened, false);
  assert.equal(r.body.browserNote, 'browser_login_disabled');
  assert.equal(openPageCalls, 0, 'no browser opens while browser login is disabled');
  assertTokenFree(r.body);
});

test('POST /accounts/bridge/facebook/check rejects an unknown role', async () => {
  const r = await req('POST', '/accounts/bridge/facebook/check', { role: 'nope', account: 'CHEARB' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /role/i);
});

// ── GET status/config does not call browser.openPage / token minting ──────────────────────────

test('bridge status + config reads never touch the browser', async () => {
  await saveAccount('CHEARB');
  await req('GET', '/accounts/bridge/status');
  await req('GET', '/accounts/bridge/facebook');
  await req('POST', '/accounts/bridge/facebook', { page_posting_facebook_lite: 'CHEARB' });
  await req('POST', '/accounts/bridge/facebook/check', { account: 'CHEARB' });
  assert.equal(openPageCalls, 0, 'no bridge status/config path opened a browser');
});

// ── UI invariants: API-first, no auto login/refresh on load ───────────────────────────────────

test('UI is Accounts Bridge and never auto-logs-in, auto-fills, or auto-submits', async () => {
  const r = await getRaw('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Accounts Bridge/);
  // No automatic visible=1&autofill=1&submit=1 anywhere.
  assert.doesNotMatch(r.text, /autofill=1/);
  assert.doesNotMatch(r.text, /submit=1/);
  assert.doesNotMatch(r.text, /visible=1&autofill=1&submit=1/);

  // The auto-run init() does STATUS reads only — it must not reference /login or /token in any form.
  const initBody = r.text.slice(r.text.indexOf('function init()'), r.text.indexOf('init();', r.text.indexOf('function init()')));
  assert.ok(initBody.length > 0, 'init() function found');
  assert.match(initBody, /loadAccounts\(\)/);
  assert.match(initBody, /loadBridgeRoles\(\)/);
  assert.doesNotMatch(initBody, /\/login/);
  assert.doesNotMatch(initBody, /\/token/);
  assert.doesNotMatch(initBody, /refreshFacebookLiteToken|openPowerEditorSession/);

  // loadBridgeRoles (the load-path bridge call) hits the token-free GET, never a refresh/login.
  const loadRoles = r.text.slice(r.text.indexOf('async function loadBridgeRoles'), r.text.indexOf('async function saveBridgeRoles'));
  assert.match(loadRoles, /api\("GET", "\/accounts\/bridge\/facebook"\)/);
  assert.doesNotMatch(loadRoles, /\/token\/refresh/);
  assert.doesNotMatch(loadRoles, /\/login/);

  // The dry-run check the UI issues is explicitly dry_run:true.
  assert.match(r.text, /"\/accounts\/bridge\/facebook\/check", \{ role: role, account: account, dry_run: true \}/);
});
