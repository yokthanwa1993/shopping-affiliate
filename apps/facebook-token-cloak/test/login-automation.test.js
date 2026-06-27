'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const browser = require('../src/browser');
const { createServer } = require('../src/server');
const keychain = require('../src/keychain');
const { store, securityCalls, fakeRunner } = require('./_helpers');

// RFC 6238 test seed: base32 of the ASCII string "12345678901234567890".
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function noLeak(value, secrets) {
  const payload = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!payload.includes(secret), `leaked ${secret}`);
}

// Configurable fake Playwright page. Only the selectors listed actually "exist"; the 2FA field
// disappears once its code is filled (so twoFactorHandled can be confirmed).
function makePage(opts = {}) {
  const {
    submitButtons = [],
    twoFactorField = null,
    twoFactorSubmit = [],
    twoFactorClears = true,
    url = 'https://www.facebook.com/home',
    allowPress = true
  } = opts;
  const calls = { fills: [], presses: [], clicks: [], keys: [] };
  let codeEntered = false;
  const exists = sel => {
    if (submitButtons.includes(sel)) return true;
    if (twoFactorSubmit.includes(sel)) return true;
    if (twoFactorField && sel === twoFactorField) return !(codeEntered && twoFactorClears);
    return false;
  };
  // Locator supports both the `.first().count()` presence-check path and the
  // `.count()/.nth(i).isVisible()/.click()` click path used by clickFirstPresent.
  const candidate = sel => ({
    count: async () => (exists(sel) ? 1 : 0),
    isVisible: async () => exists(sel),
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { calls.clicks.push(sel); }
  });
  const page = {
    waitForSelector: async () => ({}),
    fill: async (sel, val) => { calls.fills.push([sel, val]); if (twoFactorField && sel === twoFactorField) codeEntered = true; },
    press: async (sel, key) => { if (!allowPress) throw new Error('no press'); calls.presses.push([sel, key]); },
    keyboard: { press: async key => { calls.keys.push(key); } },
    locator: sel => ({ count: async () => (exists(sel) ? 1 : 0), first: () => candidate(sel), nth: () => candidate(sel) }),
    waitForLoadState: async () => {},
    waitForURL: async () => {},
    waitForTimeout: async () => {},
    url: () => url
  };
  return { page, calls };
}

const CREDENTIAL = { username: 'u@example.com', password: 'pw-secret' };

test('generateTotpCode matches the RFC 6238 SHA1 test vector', () => {
  assert.equal(browser.generateTotpCode(RFC_SEED, { time: 59 }), '287082');
  assert.equal(browser.generateTotpCode(RFC_SEED, { time: 1111111109 }), '081804');
  // otpauth:// URIs and spaced seeds are accepted too.
  assert.equal(browser.generateTotpCode(`otpauth://totp/x?secret=${RFC_SEED}&issuer=fb`, { time: 59 }), '287082');
  assert.equal(browser.generateTotpCode('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ', { time: 59 }), '287082');
  assert.equal(browser.generateTotpCode('', { time: 59 }), null);
});

test('fillFacebookLogin does nothing without a credential', async () => {
  const { page, calls } = makePage();
  const r = await browser.fillFacebookLogin(page, null, { submit: true });
  assert.equal(r.autofilled, false);
  assert.equal(r.submitted, false);
  assert.equal(calls.fills.length, 0);
});

test('fillFacebookLogin fills without submitting when submit is false', async () => {
  const { page, calls } = makePage({ submitButtons: ['button[name="login"]'] });
  const r = await browser.fillFacebookLogin(page, CREDENTIAL, { submit: false });
  assert.equal(r.autofilled, true);
  assert.equal(r.submitted, false);
  assert.equal(calls.clicks.length, 0);
  assert.equal(calls.presses.length, 0);
});

test('fillFacebookLogin clicks the real Login button when present', async () => {
  const { page, calls } = makePage({ submitButtons: ['button[name="login"]'] });
  const r = await browser.fillFacebookLogin(page, CREDENTIAL, { submit: true });
  assert.equal(r.submitted, true);
  assert.equal(r.submitMethod, 'click:button[name="login"]');
  assert.equal(r.loggedIn, true);
  assert.deepEqual(calls.clicks, ['button[name="login"]']);
  noLeak(r, ['pw-secret']);
});

test('fillFacebookLogin falls back to keyboard Enter when no button matches', async () => {
  const { page, calls } = makePage({ submitButtons: [] });
  const r = await browser.fillFacebookLogin(page, CREDENTIAL, { submit: true });
  assert.equal(r.submitted, true);
  assert.equal(r.submitMethod, 'enter:password');
  assert.equal(calls.presses[0][1], 'Enter');
});

test('fillFacebookLogin reports submitted:false only when no submit attempt was possible', async () => {
  const { page } = makePage({ submitButtons: [], allowPress: false });
  const r = await browser.fillFacebookLogin(page, CREDENTIAL, { submit: true });
  assert.equal(r.autofilled, true);
  assert.equal(r.submitted, false);
});

test('fillFacebookLogin auto-completes 2FA from the TOTP seed without leaking it', async () => {
  const { page } = makePage({
    submitButtons: ['button[name="login"]'],
    twoFactorField: 'input[name="approvals_code"]',
    twoFactorSubmit: ['button[type="submit"]'],
    twoFactorClears: true
  });
  const r = await browser.fillFacebookLogin(page, CREDENTIAL, {
    submit: true,
    totpProvider: async () => RFC_SEED
  });
  assert.equal(r.twoFactorRequired, true);
  assert.equal(r.twoFactorHandled, true);
  const code = browser.generateTotpCode(RFC_SEED);
  noLeak(r, [RFC_SEED, 'pw-secret', code]);
});

test('fillFacebookLogin surfaces two_factor_required when no TOTP seed is available', async () => {
  const { page } = makePage({
    submitButtons: ['button[name="login"]'],
    twoFactorField: 'input[name="approvals_code"]',
    twoFactorSubmit: ['button[type="submit"]'],
    url: 'https://www.facebook.com/checkpoint/'
  });
  const r = await browser.fillFacebookLogin(page, CREDENTIAL, {
    submit: true,
    totpProvider: async () => null
  });
  assert.equal(r.twoFactorRequired, true);
  assert.equal(r.twoFactorHandled, false);
  assert.equal(r.loggedIn, false);
});

// Text-driven fake page for the method-chooser / trust-device / save-password interstitials. Only
// getByText, keyboard.press, locator (for the code input) and url are exercised by those helpers.
function makeTextPage({ url = 'https://www.facebook.com/checkpoint/?next', codeSelectors = [], textsFor }) {
  const state = { escapes: 0, clicked: [], codePresent: false, selectedMethod: 'passkey', urlNow: url };
  const texts = textsFor(state);
  const matchText = (pattern, label) => (pattern instanceof RegExp ? pattern.test(label) : String(label).includes(String(pattern)));
  const codeVisible = sel => state.codePresent && codeSelectors.includes(sel);
  const page = {
    keyboard: { press: async () => { state.escapes += 1; } },
    waitForSelector: async () => {},
    fill: async () => {},
    press: async () => {},
    waitForLoadState: async () => {},
    waitForURL: async () => {},
    waitForTimeout: async () => {},
    getByText: pattern => {
      const hits = texts.filter(t => (t.present ? t.present() : true) && matchText(pattern, t.label));
      const cand = i => ({ isVisible: async () => true, scrollIntoViewIfNeeded: async () => {}, click: async () => { state.clicked.push(hits[i].label); if (hits[i].onClick) hits[i].onClick(); } });
      return { count: async () => hits.length, nth: i => cand(i), first: () => cand(0) };
    },
    locator: sel => {
      const cand = { count: async () => (codeVisible(sel) ? 1 : 0), isVisible: async () => codeVisible(sel), scrollIntoViewIfNeeded: async () => {}, click: async () => {} };
      return { count: async () => (codeVisible(sel) ? 1 : 0), first: () => cand, nth: () => cand };
    },
    url: () => state.urlNow
  };
  return { page, state };
}

// Full login page that walks the whole Thai flow: passkey chooser → authenticator code → trust
// device → dismiss save-password → Home. Drives fillFacebookLogin end to end.
function makeFullLoginPage() {
  const codeField = 'input[autocomplete="one-time-code"]';
  const twoFactorSubmit = 'button[type="submit"]';
  const state = { escapes: 0, clicked: [], fills: [], presses: [], selectedMethod: 'passkey', codePresent: false, codeEntered: false, twoFactorSubmitted: false, trustClicked: false, savePwClicked: false };
  const matchText = (p, l) => (p instanceof RegExp ? p.test(l) : String(l).includes(String(p)));
  const texts = () => {
    const nodes = [];
    if (!state.codePresent) {
      nodes.push({ label: 'ลองวิธีอื่น', onClick: () => {} });
      nodes.push({ label: 'แอพยืนยันตัวตน', onClick: () => { state.selectedMethod = 'authenticator'; } });
      nodes.push({ label: 'ดำเนินการต่อ', onClick: () => { if (state.selectedMethod === 'authenticator') state.codePresent = true; } });
    }
    if (state.twoFactorSubmitted) nodes.push({ label: 'เชื่อถืออุปกรณ์นี้', onClick: () => { state.trustClicked = true; } });
    if (state.trustClicked) {
      nodes.push({ label: 'ไม่ใช่ตอนนี้', onClick: () => { state.savePwClicked = true; } });
      nodes.push({ label: 'ตกลง', onClick: () => {} });
    }
    return nodes;
  };
  const codeVisible = sel => sel === codeField && state.codePresent && !state.codeEntered;
  const submitVisible = sel => sel === twoFactorSubmit && state.codePresent;
  const page = {
    waitForSelector: async () => {},
    fill: async (sel, val) => { state.fills.push([sel, val]); if (sel === codeField) state.codeEntered = true; },
    press: async (sel, key) => { state.presses.push([sel, key]); },
    keyboard: { press: async () => { state.escapes += 1; } },
    waitForLoadState: async () => {},
    waitForURL: async () => {},
    waitForTimeout: async () => {},
    getByText: pattern => {
      const hits = texts().filter(t => matchText(pattern, t.label));
      const cand = i => ({ isVisible: async () => true, scrollIntoViewIfNeeded: async () => {}, click: async () => { state.clicked.push(hits[i].label); hits[i].onClick(); } });
      return { count: async () => hits.length, nth: i => cand(i), first: () => cand(0) };
    },
    locator: sel => {
      const present = () => codeVisible(sel) || submitVisible(sel);
      const cand = { count: async () => (present() ? 1 : 0), isVisible: async () => present(), scrollIntoViewIfNeeded: async () => {}, click: async () => { if (submitVisible(sel)) { state.twoFactorSubmitted = true; state.clicked.push(sel); } } };
      return { count: async () => (present() ? 1 : 0), first: () => cand, nth: () => cand };
    },
    url: () => (state.savePwClicked || state.codeEntered) ? 'https://www.facebook.com/home' : 'https://www.facebook.com/checkpoint/?next=passkey'
  };
  return { page, state };
}

test('looksLikeTwoFactorUrl flags checkpoint/passkey/2fa screens, not Home', () => {
  assert.equal(browser.looksLikeTwoFactorUrl('https://www.facebook.com/checkpoint/?next'), true);
  assert.equal(browser.looksLikeTwoFactorUrl('https://www.facebook.com/two_factor/'), true);
  assert.equal(browser.looksLikeTwoFactorUrl('https://www.facebook.com/auth_platform/passkey'), true);
  assert.equal(browser.looksLikeTwoFactorUrl('https://www.facebook.com/home'), false);
});

test('chooseTwoFactorCodeMethod walks the Thai passkey chooser to the code input', async () => {
  const { page, state } = makeTextPage({
    codeSelectors: ['input[name="approvals_code"]'],
    textsFor: s => [
      { label: 'ลองวิธีอื่น', onClick: () => { s.selectedMethod = null; } },
      { label: 'แอพยืนยันตัวตน', onClick: () => { s.selectedMethod = 'authenticator'; } }, // Thai พ spelling
      { label: 'ดำเนินการต่อ', onClick: () => { if (s.selectedMethod === 'authenticator') s.codePresent = true; } }
    ]
  });
  assert.equal(state.selectedMethod, 'passkey'); // passkey is the default selected method
  const outcome = await browser.chooseTwoFactorCodeMethod(page);
  assert.ok(state.escapes >= 1);                  // native security-key prompt dismissed
  assert.equal(outcome.switchedMethod, true);     // clicked "ลองวิธีอื่น"
  assert.equal(outcome.selectedAuthenticatorApp, true); // authenticator option available + selected
  assert.equal(state.selectedMethod, 'authenticator');
  assert.equal(outcome.confirmedMethod, true);    // clicked "ดำเนินการต่อ"
  assert.equal(state.codePresent, true);          // continue revealed the code input
  assert.equal(await page.locator('input[name="approvals_code"]').count(), 1);
  noLeak(outcome, ['pw-secret']);
});

test('chooseTwoFactorCodeMethod walks the English passkey chooser', async () => {
  const { page, state } = makeTextPage({
    codeSelectors: ['input[name="approvals_code"]'],
    textsFor: s => [
      { label: 'Try another way', onClick: () => {} },
      { label: 'Authentication app', onClick: () => { s.selectedMethod = 'authenticator'; } },
      { label: 'Continue', onClick: () => { if (s.selectedMethod === 'authenticator') s.codePresent = true; } }
    ]
  });
  const outcome = await browser.chooseTwoFactorCodeMethod(page);
  assert.equal(outcome.switchedMethod, true);
  assert.equal(outcome.selectedAuthenticatorApp, true);
  assert.equal(outcome.confirmedMethod, true);
  assert.equal(state.codePresent, true);
});

test('handleTrustDevicePage clicks the trust button (Thai + English) without touching "do not trust"', async () => {
  const thai = makeTextPage({ textsFor: () => [
    { label: 'เชื่อถืออุปกรณ์นี้', onClick: () => {} },
    { label: 'ไม่เชื่อถือ', onClick: () => {} }
  ] });
  assert.equal(await browser.handleTrustDevicePage(thai.page), true);
  assert.deepEqual(thai.state.clicked, ['เชื่อถืออุปกรณ์นี้']);

  const english = makeTextPage({ textsFor: () => [{ label: 'Trust this device', onClick: () => {} }] });
  assert.equal(await browser.handleTrustDevicePage(english.page), true);
  assert.deepEqual(english.state.clicked, ['Trust this device']);
});

test('dismissSavePasswordPrompt clicks Not now, never OK/Save (Thai + English)', async () => {
  const thai = makeTextPage({ textsFor: () => [
    { label: 'ตกลง', onClick: () => {} },
    { label: 'ไม่ใช่ตอนนี้', onClick: () => {} }
  ] });
  assert.equal(await browser.dismissSavePasswordPrompt(thai.page), true);
  assert.deepEqual(thai.state.clicked, ['ไม่ใช่ตอนนี้']); // ตกลง (OK) never clicked

  const english = makeTextPage({ textsFor: () => [
    { label: 'Save', onClick: () => {} },
    { label: 'Not now', onClick: () => {} }
  ] });
  assert.equal(await browser.dismissSavePasswordPrompt(english.page), true);
  assert.deepEqual(english.state.clicked, ['Not now']);
});

test('fillFacebookLogin completes the full Thai flow: chooser → TOTP → trust device → skip save password', async () => {
  const { page, state } = makeFullLoginPage();
  const r = await browser.fillFacebookLogin(page, CREDENTIAL, { submit: true, totpProvider: async () => RFC_SEED });
  assert.equal(r.twoFactorRequired, true);
  assert.equal(r.twoFactorHandled, true);
  assert.equal(r.trustedDeviceHandled, true);
  assert.equal(r.savePasswordPromptHandled, true);
  assert.equal(r.savePasswordDismissed, true);
  assert.equal(r.loggedIn, true);
  assert.ok(state.clicked.includes('เชื่อถืออุปกรณ์นี้'));
  assert.ok(state.clicked.includes('ไม่ใช่ตอนนี้'));
  assert.ok(!state.clicked.includes('ตกลง')); // never accepted the save-password prompt
  const code = browser.generateTotpCode(RFC_SEED);
  noLeak(r, [RFC_SEED, 'pw-secret', code]);
});

test('readDatrCookie returns null for backends without a cookie jar', async () => {
  assert.equal(await browser.readDatrCookie(null), null);
  assert.equal(await browser.readDatrCookie({}), null);
});

// ── /login response flags + datr capture (server level) ──────────────────────────────────────

function mockBrowser(fill, datrValue, pageUrl = 'https://www.facebook.com/home') {
  return {
    PROFILE_ROOT: '/tmp/profiles',
    loadBrowserBackend: async () => ({ backend: 'mock-browser' }),
    openPage: async () => ({
      backend: 'mock-browser',
      profileDir: '/tmp/profiles/chearb',
      context: { cookies: async () => (datrValue ? [{ name: 'datr', value: datrValue, domain: '.facebook.com' }] : []) },
      page: { url: () => pageUrl, textContent: async () => '' }
    }),
    fillFacebookLogin: async () => fill,
    readDatrCookie: browser.readDatrCookie
  };
}

let server;
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function listenWith(mock) {
  server = createServer({ browser: mock });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

beforeEach(() => {
  process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED=String.fromCharCode(49);
  store.clear();
  securityCalls.length = 0;
  keychain.setRunner(fakeRunner);
});

afterEach(async () => {
  delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED;
  keychain.clearRunner();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function seedCredential() {
  await req('POST', '/keychain/credential', { account: 'CHEARB', username: 'u@example.com', password: 'pw-secret' });
}

test('/login captures datr and returns only redacted flags', async () => {
  await listenWith(mockBrowser({ autofilled: true, submitted: true, submitMethod: 'click:button[name="login"]', loggedIn: true }, 'DATRSECRET'));
  await seedCredential();

  const r = await req('GET', '/login?account=CHEARB&submit=1&autofill=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.autofilled, true);
  assert.equal(r.body.submitted, true);
  assert.equal(r.body.twoFactorHandled, false);
  assert.equal(r.body.datrPresent, true);
  assert.equal(r.body.datrUpdated, true);
  assert.equal(r.body.state, 'logged_in');
  // datr value, password, and any cookie material must never appear in the response.
  noLeak(r.body, ['DATRSECRET', 'pw-secret']);
  // datr was actually written to the keychain.
  assert.ok([...store.keys()].some(k => k.includes('.datr.')));
});

test('/login surfaces two_factor_required without blocking datr capture', async () => {
  await listenWith(mockBrowser({ autofilled: true, submitted: true, twoFactorRequired: true, twoFactorHandled: false }, 'DATRSECRET'));
  await seedCredential();

  const r = await req('GET', '/login?account=CHEARB&submit=1&autofill=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'two_factor_required');
  assert.equal(r.body.reason, 'two_factor_required');
  assert.equal(r.body.twoFactorHandled, false);
  assert.equal(r.body.datrPresent, true);
  noLeak(r.body, ['DATRSECRET', 'pw-secret']);
});

test('/login classifies submitted login on /home.php as logged_in even when browser loggedIn flag is false', async () => {
  // Live regression: the page settled on /home.php after 2FA cleared but the browser-side loggedIn
  // flag came back false due to timing; the server must still report logged_in, not datr_saved.
  await listenWith(mockBrowser(
    { autofilled: true, submitted: true, submitMethod: 'enter:password', loggedIn: false, twoFactorRequired: true, twoFactorHandled: true },
    'DATRSECRET',
    'https://www.facebook.com/home.php'
  ));
  await seedCredential();

  const r = await req('GET', '/login?account=CHEARB&submit=1&autofill=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'logged_in');
  assert.equal(r.body.reason, undefined);
  assert.equal(r.body.currentUrl, 'https://www.facebook.com/home.php');
  assert.equal(r.body.submitted, true);
  assert.equal(r.body.datrPresent, true);
  noLeak(r.body, ['DATRSECRET', 'pw-secret']);
});

test('/login still gates a submitted login that stayed on the checkpoint wall', async () => {
  await listenWith(mockBrowser(
    { autofilled: true, submitted: true, loggedIn: false, twoFactorRequired: true, twoFactorHandled: false },
    'DATRSECRET',
    'https://www.facebook.com/checkpoint/?next'
  ));
  await seedCredential();

  const r = await req('GET', '/login?account=CHEARB&submit=1&autofill=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'two_factor_required');
  noLeak(r.body, ['DATRSECRET', 'pw-secret']);
});

test('/login leaves a submitted login still on /login.php as login_submitted, not logged_in', async () => {
  await listenWith(mockBrowser(
    { autofilled: true, submitted: true, loggedIn: false },
    null,
    'https://www.facebook.com/login.php?login_attempt=1'
  ));
  await seedCredential();

  const r = await req('GET', '/login?account=CHEARB&submit=1&autofill=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'login_submitted');
});

test('/login surfaces trust-device and save-password flags as redacted booleans', async () => {
  await listenWith(mockBrowser({
    autofilled: true, submitted: true, submitMethod: 'enter:password', loggedIn: true,
    twoFactorRequired: true, twoFactorHandled: true,
    trustedDeviceHandled: true, savePasswordPromptHandled: true, savePasswordDismissed: true
  }, 'DATRSECRET'));
  await seedCredential();

  const r = await req('GET', '/login?account=CHEARB&submit=1&autofill=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.twoFactorHandled, true);
  assert.equal(r.body.trustedDeviceHandled, true);
  assert.equal(r.body.savePasswordPromptHandled, true);
  assert.equal(r.body.savePasswordDismissed, true);
  assert.equal(r.body.state, 'logged_in');
  noLeak(r.body, ['DATRSECRET', 'pw-secret']);
});

test('/login without submit neither captures datr nor reports a submit', async () => {
  await listenWith(mockBrowser({ autofilled: true, submitted: false }, 'DATRSECRET'));
  await seedCredential();

  const r = await req('GET', '/login?account=CHEARB&submit=0&autofill=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'login_opened');
  assert.equal(r.body.submitted, false);
  assert.equal(r.body.datrPresent, false);
  assert.ok(![...store.keys()].some(k => k.includes('.datr.')));
});

// ── Per-account context reuse + locked-profile error handling ──────────────────────────────────
// A fake browser backend (injected via setBrowserBackend) lets us prove the reuse/launch logic
// without a real Chromium. Each context exposes browser().isConnected() (the real liveness signal)
// and an evicting 'close' event, mirroring a Playwright persistent context.
function makeReuseLauncher() {
  let launches = 0;
  const makeContext = () => {
    let connected = true;
    const closeListeners = [];
    const pages = [];
    return {
      pages() { return pages; },
      async newPage() { const p = { goto: async () => {}, url: () => 'https://www.facebook.com/login' }; pages.push(p); return p; },
      browser() { return { isConnected: () => connected }; },
      on(ev, fn) { if (ev === 'close') closeListeners.push(fn); },
      async close() { connected = false; closeListeners.forEach(f => { try { f(); } catch {} }); }
    };
  };
  return {
    get launches() { return launches; },
    async launchPersistentContext() { launches += 1; return makeContext(); }
  };
}

test('openPage reuse: two consecutive same-account opens reuse ONE context and launcher', async () => {
  const launcher = makeReuseLauncher();
  browser.setBrowserBackend(launcher, 'mock');
  browser.resetAccountContexts();
  try {
    const first = await browser.openPage('100090320823561', 'https://www.facebook.com/login', { visible: true, reuse: true });
    const second = await browser.openPage('100090320823561', 'https://www.facebook.com/login', { visible: true, reuse: true });
    // The second /login must NOT launch a second persistent profile on the same (locked) dir.
    assert.equal(launcher.launches, 1);
    assert.equal(first.context, second.context); // same live context is reused
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
  } finally {
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

test('concurrent same-account opens share a single launch (no double persistentContext)', async () => {
  const launcher = makeReuseLauncher();
  browser.setBrowserBackend(launcher, 'mock');
  browser.resetAccountContexts();
  try {
    const [a, b] = await Promise.all([
      browser.openPage('100090320823561', 'https://x/', { reuse: true }),
      browser.openPage('100090320823561', 'https://x/', { reuse: true })
    ]);
    assert.equal(launcher.launches, 1);
    assert.equal(a.context, b.context);
  } finally {
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

test('openPage reuse relaunches after the cached context closes (no stale dead context)', async () => {
  const launcher = makeReuseLauncher();
  browser.setBrowserBackend(launcher, 'mock');
  browser.resetAccountContexts();
  try {
    const first = await browser.openPage('100090320823561', 'https://x/', { reuse: true });
    await first.context.close(); // window closed → cache must evict
    const second = await browser.openPage('100090320823561', 'https://x/', { reuse: true });
    assert.equal(launcher.launches, 2);
    assert.notEqual(first.context, second.context);
    assert.equal(second.reused, false);
  } finally {
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

test('launchPersistentContext maps a SingletonLock failure to profile_already_open, not a generic error', async () => {
  const launcher = { async launchPersistentContext() { throw new Error('Failed to create a ProcessSingleton for your profile directory. SingletonLock is held by another process.'); } };
  browser.setBrowserBackend(launcher, 'mock');
  browser.resetAccountContexts();
  try {
    await assert.rejects(
      () => browser.openPage('100090320823561', 'https://www.facebook.com/login', { visible: true, reuse: true }),
      (err) => { assert.equal(err.code, 'profile_already_open'); assert.ok(!/SingletonLock|ProcessSingleton/.test(err.message)); return true; }
    );
  } finally {
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

// Server-level: a locked profile must surface a sanitized profile_already_open (409), never a
// generic HTTP 500 "Internal server error" — this is the exact symptom the operator reported.
function lockMockBrowser() {
  return {
    PROFILE_ROOT: '/tmp/profiles',
    loadBrowserBackend: async () => ({ backend: 'mock-browser' }),
    openPage: async () => { throw Object.assign(new Error('Profile is already open in another browser process'), { code: 'profile_already_open' }); },
    readDatrCookie: browser.readDatrCookie
  };
}


test('clearStaleProfileSingletons removes dead Chromium Singleton symlinks but keeps a live lock', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-profile-lock-'));
  try {
    fs.symlinkSync('Thanwas-Mac-mini.local-99999999', path.join(dir, 'SingletonLock'));
    fs.symlinkSync('cookie', path.join(dir, 'SingletonCookie'));
    fs.symlinkSync('/tmp/socket', path.join(dir, 'SingletonSocket'));
    assert.equal(browser.clearStaleProfileSingletons(dir), true);
    assert.equal(fs.existsSync(path.join(dir, 'SingletonLock')), false);
    fs.symlinkSync(`Thanwas-Mac-mini.local-${process.pid}`, path.join(dir, 'SingletonLock'));
    assert.equal(browser.clearStaleProfileSingletons(dir), false);
    assert.equal(fs.lstatSync(path.join(dir, 'SingletonLock')).isSymbolicLink(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/login returns a sanitized profile_already_open (409), never a generic 500, when the profile is locked', async () => {
  await listenWith(lockMockBrowser());
  const r = await req('GET', '/login?account=100090320823561&visible=1&autofill=0&submit=0');
  assert.notEqual(r.status, 500);
  assert.equal(r.status, 409);
  assert.equal(r.body.success, false);
  assert.equal(r.body.state, 'profile_already_open');
  assert.equal(r.body.reason, 'profile_already_open');
  assert.notEqual(r.body.error, 'Internal server error');
});


test('loadBrowserBackend requires Chrome for Testing and rejects ordinary Chrome executables', async () => {
  const oldBrowser = process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE;
  const oldChrome = process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE;
  const oldGeneric = process.env.CHROME_EXECUTABLE_PATH;
  browser.setBrowserBackend(null);
  browser.resetAccountContexts();
  process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  delete process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE;
  delete process.env.CHROME_EXECUTABLE_PATH;
  try {
    await assert.rejects(() => browser.loadBrowserBackend(), /Chrome for Testing/);
  } finally {
    if (oldBrowser === undefined) delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE;
    else process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE=oldBrowser;
    if (oldChrome === undefined) delete process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE;
    else process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE=oldChrome;
    if (oldGeneric === undefined) delete process.env.CHROME_EXECUTABLE_PATH;
    else process.env.CHROME_EXECUTABLE_PATH=oldGeneric;
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

test('loadBrowserBackend defaults to Playwright Chrome for Testing, not bundled headless shell or Google Chrome', async () => {
  const oldBrowser = process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE;
  const oldChrome = process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE;
  const oldGeneric = process.env.CHROME_EXECUTABLE_PATH;
  browser.setBrowserBackend(null);
  browser.resetAccountContexts();
  delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE;
  delete process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE;
  delete process.env.CHROME_EXECUTABLE_PATH;
  try {
    const backend = await browser.loadBrowserBackend();
    assert.equal(backend.backend, 'chrome-for-testing');
    assert.match(backend.executablePath, /Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/);
    assert.doesNotMatch(backend.executablePath, /chrome-headless-shell|Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/);
    assert.equal(typeof backend.launcher.launchPersistentContext, 'function');
  } finally {
    if (oldBrowser === undefined) delete process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE;
    else process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_EXECUTABLE=oldBrowser;
    if (oldChrome === undefined) delete process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE;
    else process.env.FACEBOOK_TOKEN_CLOAK_CHROME_EXECUTABLE=oldChrome;
    if (oldGeneric === undefined) delete process.env.CHROME_EXECUTABLE_PATH;
    else process.env.CHROME_EXECUTABLE_PATH=oldGeneric;
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

// ── reuseIfPresent: posting/session-token resolution reuses an operator-visible context ─────────
// The no_session bug: posting's resolveSessionToken opened a SECOND persistentContext on a profile
// dir whose window a visible /login had already locked. reuseIfPresent fixes it: reuse the live
// cached context when one exists, otherwise open a fresh one-off (that closeSession then closes).
const posting = require('../src/posting');

test('openPage reuseIfPresent REUSES the live context a visible /login left open (no second launch)', async () => {
  const launcher = makeReuseLauncher();
  browser.setBrowserBackend(launcher, 'mock');
  browser.resetAccountContexts();
  try {
    // A visible /login caches a live context for the account.
    const login = await browser.openPage('100090320823561', 'https://www.facebook.com/login', { visible: true, reuse: true });
    assert.equal(login.reused, false);
    // Posting/session-token resolution reuses that SAME context — never a second persistentContext.
    const reuse = await browser.openPage('100090320823561', 'https://www.facebook.com/dialog/oauth', { reuseIfPresent: true });
    assert.equal(launcher.launches, 1);
    assert.equal(reuse.context, login.context);
    assert.equal(reuse.reused, true);
  } finally {
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

test('openPage reuseIfPresent opens a fresh one-off context when none is cached (and does NOT cache it)', async () => {
  const launcher = makeReuseLauncher();
  browser.setBrowserBackend(launcher, 'mock');
  browser.resetAccountContexts();
  try {
    const first = await browser.openPage('100090320823561', 'https://x/', { reuseIfPresent: true });
    assert.equal(first.reused, false);
    assert.equal(launcher.launches, 1);
    // A one-off open must NOT populate the reuse cache, so the next reuseIfPresent launches again.
    const second = await browser.openPage('100090320823561', 'https://x/', { reuseIfPresent: true });
    assert.equal(second.reused, false);
    assert.equal(launcher.launches, 2);
    assert.notEqual(first.context, second.context);
    assert.equal(browser.peekAccountContext('100090320823561'), null);
  } finally {
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

test('resolveSessionToken reuses the operator-visible context and closeSession does NOT close it', async () => {
  const launcher = makeReuseLauncher();
  browser.setBrowserBackend(launcher, 'mock');
  browser.resetAccountContexts();
  try {
    const login = await browser.openPage('100090320823561', 'https://www.facebook.com/login', { visible: true, reuse: true });
    const session = await posting.resolveSessionToken({ browser, account: '100090320823561' });
    assert.equal(session.reused, true);
    assert.equal(session.context, login.context);
    await posting.closeSession(session);
    // The operator's live context must remain OPEN after closeSession — never torn down mid-use.
    assert.equal(login.context.browser().isConnected(), true);
    assert.equal(launcher.launches, 1);
  } finally {
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

test('resolveSessionToken opens a one-off context when none is cached and closeSession closes it', async () => {
  const launcher = makeReuseLauncher();
  browser.setBrowserBackend(launcher, 'mock');
  browser.resetAccountContexts();
  try {
    const session = await posting.resolveSessionToken({ browser, account: '100090320823561' });
    assert.equal(session.reused, false);
    assert.equal(session.context.browser().isConnected(), true);
    await posting.closeSession(session);
    // A one-off context this request opened IS closed (no leak).
    assert.equal(session.context.browser().isConnected(), false);
  } finally {
    browser.setBrowserBackend(null);
    browser.resetAccountContexts();
  }
});

// Direct closeSession contract (no resolveSessionToken plumbing): a context whose close() bumps a
// counter lets us assert exactly when the teardown fires. reused:true is the operator-visible
// context — never closed; reused:false (one-off) and reused:undefined (default lifecycle, no flag)
// are both closed exactly once.
function makeClosable() {
  let closes = 0;
  return { get closes() { return closes; }, context: { close: async () => { closes += 1; } } };
}

test('closeSession skips a reused:true context but closes reused:false / undefined one-off contexts', async () => {
  const reused = makeClosable();
  await posting.closeSession({ reused: true, context: reused.context });
  assert.equal(reused.closes, 0); // operator-visible context left OPEN

  const oneOff = makeClosable();
  await posting.closeSession({ reused: false, context: oneOff.context });
  assert.equal(oneOff.closes, 1); // one-off context torn down

  const noFlag = makeClosable();
  await posting.closeSession({ context: noFlag.context }); // default lifecycle: reused undefined
  assert.equal(noFlag.closes, 1);
});
test('readTemplateSettings captures promoted_object so conversion adsets keep pixel tracking', async () => {
  const posting = require('../src/posting');
  const fetchImpl = async () => ({
    json: async () => ({
      promoted_object: { pixel_id: '123', custom_event_type: 'PURCHASE' },
      existing_customer_budget_percentage: 0,
      campaign: { id: 'camp1', objective: 'OUTCOME_SALES', smart_promotion_type: 'GUIDED_CREATION' }
    })
  });
  const settings = await posting.readTemplateSettings(fetchImpl, { userToken: 'tok', templateAdset: 'tpl' });
  assert.equal(settings.objective, 'OUTCOME_SALES');
  assert.deepEqual(settings.adsetSettings.promoted_object, { pixel_id: '123', custom_event_type: 'PURCHASE' });
});
