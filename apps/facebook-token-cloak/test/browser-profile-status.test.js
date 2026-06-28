'use strict';

// PROFILE_ROOT is captured at module load from this env var, so it must be set BEFORE requiring
// browser.js. node:test runs each test file in its own process, so this override is isolated here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fbtc-profiles-'));
process.env.FACEBOOK_TOKEN_CLOAK_PROFILE_ROOT = profileRoot;

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const browser = require('../src/browser');

// Mirrors a Playwright persistent context closely enough for the reuse/liveness logic:
// browser().isConnected() is the real liveness signal and close() flips it + fires 'close'.
function makeLauncher() {
  const makeContext = () => {
    let connected = true;
    const closeListeners = [];
    const pages = [];
    return {
      pages() { return pages; },
      async newPage() { const p = { goto: async () => {}, url: () => 'about:blank' }; pages.push(p); return p; },
      browser() { return { isConnected: () => connected }; },
      on(ev, fn) { if (ev === 'close') closeListeners.push(fn); },
      async close() { connected = false; closeListeners.forEach(f => { try { f(); } catch {} }); }
    };
  };
  return { async launchPersistentContext() { return makeContext(); } };
}

afterEach(() => {
  browser.setBrowserBackend(null);
  browser.resetAccountContexts();
});

// The ONLY keys the native profile manager consumes. A drift here is how a secret would slip in,
// so the shape is asserted explicitly (no token/cookie/credential field may ever appear).
const ALLOWED_KEYS = new Set([
  'account', 'key', 'profileDir', 'profileExists',
  'running', 'bridgeSession', 'visibleSession', 'lockPidPresent', 'pidCount'
]);

test('profileStatus for a never-opened, non-existent profile reports not-running and missing', () => {
  browser.resetAccountContexts();
  const s = browser.profileStatus('AbsentAcc');
  assert.equal(s.account, 'ABSENTACC');
  assert.equal(s.key, 'absentacc');
  assert.equal(s.profileDir, 'absentacc'); // basename only — lowercased key, never the abs path
  assert.ok(!s.profileDir.includes('/'), 'profileDir is a basename, not a path');
  assert.ok(!s.profileDir.includes(os.homedir()), 'profileDir never leaks the home directory');
  assert.equal(s.profileExists, false);
  assert.equal(s.running, false);
  assert.equal(s.bridgeSession, false);
  assert.equal(s.visibleSession, false);
  assert.equal(s.lockPidPresent, false);
  assert.equal(s.pidCount, 0);
});

test('profileStatus reports profileExists=true when the profile dir is present on disk', () => {
  browser.resetAccountContexts();
  fs.mkdirSync(path.join(profileRoot, 'existsacc'), { recursive: true });
  const s = browser.profileStatus('EXISTSACC');
  assert.equal(s.profileExists, true);
  assert.equal(s.running, false, 'a dir on disk alone is not "running"');
});

test('profileStatus reflects a live operator-visible bridge context as running + visible', async () => {
  browser.setBrowserBackend(makeLauncher(), 'mock');
  browser.resetAccountContexts();
  await browser.acquireAccountContext('100090320823561', { visible: true });
  const s = browser.profileStatus('100090320823561');
  assert.equal(s.running, true);
  assert.equal(s.bridgeSession, true);
  assert.equal(s.visibleSession, true);
});

test('profileStatus marks a headless bridge context as running but NOT operator-visible', async () => {
  browser.setBrowserBackend(makeLauncher(), 'mock');
  browser.resetAccountContexts();
  await browser.acquireAccountContext('100090320823561', { visible: false });
  const s = browser.profileStatus('100090320823561');
  assert.equal(s.running, true);
  assert.equal(s.bridgeSession, true);
  assert.equal(s.visibleSession, false);
});

test('profileStatus stops reporting running once the bridge context is closed', async () => {
  browser.setBrowserBackend(makeLauncher(), 'mock');
  browser.resetAccountContexts();
  await browser.acquireAccountContext('100090320823561', { visible: true });
  assert.equal(browser.profileStatus('100090320823561').running, true);
  await browser.closeAccountContext('100090320823561');
  const s = browser.profileStatus('100090320823561');
  assert.equal(s.running, false);
  assert.equal(s.bridgeSession, false);
  assert.equal(s.visibleSession, false);
});

test('profileStatus exposes ONLY the allowed status keys — no secret-shaped fields', async () => {
  browser.setBrowserBackend(makeLauncher(), 'mock');
  browser.resetAccountContexts();
  await browser.acquireAccountContext('100090320823561', { visible: true });
  const s = browser.profileStatus('100090320823561');
  for (const k of Object.keys(s)) {
    assert.ok(ALLOWED_KEYS.has(k), `unexpected status key leaked: ${k}`);
  }
  const payload = JSON.stringify(s).toLowerCase();
  for (const banned of ['token', 'cookie', 'datr', 'fb_dtsg', 'password', 'access_token']) {
    assert.ok(!payload.includes(banned), `status payload must not mention ${banned}`);
  }
});

test('profileStatus does not launch a browser (pure read on an unopened account)', () => {
  // With a launcher installed but never invoked, a status read must not create a context.
  browser.setBrowserBackend(makeLauncher(), 'mock');
  browser.resetAccountContexts();
  const s = browser.profileStatus('neveropened');
  assert.equal(s.running, false);
  assert.equal(s.bridgeSession, false);
  // A subsequent peek confirms nothing was cached by the status read.
  assert.equal(browser.peekAccountContext('neveropened'), null);
});
