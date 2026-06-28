'use strict';

// Verifies the manual-Open-Profile (visible) recovery path: a STALE bridge-spawned HEADLESS Chromium
// holding the profile's SingletonLock is terminated so the visible relaunch can take the lock, while
// any non-headless / external / visible browser is left untouched (it still surfaces
// profile_already_open). No real Chromium processes are spawned — deps are injected and the
// SingletonLock is a symlink pointing at the live test process pid.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const browser = require('../src/browser');

function makeProfileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbtc-lock-'));
}
// A SingletonLock symlink whose target ends in -<pid>; singletonLockPid() parses that pid. Using the
// live test process pid makes pidExists() true without launching anything.
function writeLock(profileDir, pid) {
  const lock = path.join(profileDir, 'SingletonLock');
  try { fs.rmSync(lock, { force: true }); } catch {}
  fs.symlinkSync(`some-host-${pid}`, lock);
}
function lockExists(profileDir) {
  try { fs.lstatSync(path.join(profileDir, 'SingletonLock')); return true; } catch { return false; }
}

// ── isHeadlessProfileProcess (pure predicate, the safety gate) ──────────────────────────────────

test('isHeadlessProfileProcess matches a headless Chromium on the exact profile dir', () => {
  const dir = '/Users/x/.facebook-token-cloak/profiles/100090320823561';
  const cmd = `/path/Chromium --headless --user-data-dir=${dir} --no-first-run`;
  assert.equal(browser.isHeadlessProfileProcess(cmd, dir), true);
});

test('isHeadlessProfileProcess rejects a NON-headless (visible/external) browser on the same dir', () => {
  const dir = '/Users/x/.facebook-token-cloak/profiles/100090320823561';
  const cmd = `/path/Chromium --user-data-dir=${dir} --no-first-run`;
  assert.equal(browser.isHeadlessProfileProcess(cmd, dir), false);
});

test('isHeadlessProfileProcess rejects a headless browser on a DIFFERENT profile dir', () => {
  const dir = '/Users/x/.facebook-token-cloak/profiles/100090320823561';
  const other = '/Users/x/.facebook-token-cloak/profiles/999';
  const cmd = `/path/Chromium --headless --user-data-dir=${other}`;
  assert.equal(browser.isHeadlessProfileProcess(cmd, dir), false);
});

test('isHeadlessProfileProcess handles --headless=new and quoted --user-data-dir', () => {
  const dir = '/Users/x/.facebook-token-cloak/profiles/100090320823561';
  assert.equal(browser.isHeadlessProfileProcess(`Chromium --headless=new --user-data-dir=${dir}`, dir), true);
  assert.equal(browser.isHeadlessProfileProcess(`Chromium --headless --user-data-dir "${dir}"`, dir), true);
});

test('isHeadlessProfileProcess rejects empty inputs', () => {
  assert.equal(browser.isHeadlessProfileProcess('', '/x'), false);
  assert.equal(browser.isHeadlessProfileProcess('Chromium --headless --user-data-dir=/x', ''), false);
});

// A substring like "--headlessly" must not count as the --headless flag.
test('isHeadlessProfileProcess does not match a --headless-prefixed unrelated token', () => {
  const dir = '/Users/x/profiles/abc';
  assert.equal(browser.isHeadlessProfileProcess(`Chromium --headlessly --user-data-dir=${dir}`, dir), false);
});

// ── terminateStaleHeadlessProfileLock (behavior with injected deps) ─────────────────────────────

test('terminates ONLY a stale headless profile process and releases the lock', async () => {
  const dir = makeProfileDir();
  writeLock(dir, process.pid);
  const calls = [];
  const res = await browser.terminateStaleHeadlessProfileLock(dir, {
    readCommandLine: () => `Chromium --headless --user-data-dir=${dir}`,
    kill: (pid, sig) => {
      calls.push([pid, sig]);
      // SIGTERM makes the process exit → it drops the SingletonLock.
      if (sig === 'SIGTERM') fs.rmSync(path.join(dir, 'SingletonLock'), { force: true });
      return true;
    },
    sleep: async () => {}
  });
  assert.equal(res.terminated, true);
  assert.equal(res.pid, process.pid);
  assert.deepEqual(calls, [[process.pid, 'SIGTERM']], 'one graceful SIGTERM, no SIGKILL needed');
  assert.equal(lockExists(dir), false, 'stale SingletonLock cleared after release');
});

test('does NOT kill a non-headless (visible/external) browser holding the lock', async () => {
  const dir = makeProfileDir();
  writeLock(dir, process.pid);
  const calls = [];
  const res = await browser.terminateStaleHeadlessProfileLock(dir, {
    readCommandLine: () => `Chromium --user-data-dir=${dir} --no-first-run`, // no --headless
    kill: (pid, sig) => { calls.push([pid, sig]); return true; },
    sleep: async () => {}
  });
  assert.equal(res.terminated, false);
  assert.equal(res.reason, 'not_headless_profile_process');
  assert.equal(calls.length, 0, 'a visible/external browser is never killed');
  assert.equal(lockExists(dir), true, 'an external browser keeps its lock → caller surfaces profile_already_open');
});

test('does nothing when there is no live SingletonLock', async () => {
  const dir = makeProfileDir(); // no lock file written
  const calls = [];
  const res = await browser.terminateStaleHeadlessProfileLock(dir, {
    readCommandLine: () => { throw new Error('should not be read'); },
    kill: (pid, sig) => { calls.push([pid, sig]); return true; },
    sleep: async () => {}
  });
  assert.equal(res.terminated, false);
  assert.equal(res.reason, 'no_live_lock');
  assert.equal(calls.length, 0);
});

test('escalates to SIGKILL when the headless process survives SIGTERM', async () => {
  const dir = makeProfileDir();
  writeLock(dir, process.pid);
  const calls = [];
  const res = await browser.terminateStaleHeadlessProfileLock(dir, {
    readCommandLine: () => `Chromium --headless --user-data-dir=${dir}`,
    kill: (pid, sig) => { calls.push([pid, sig]); return true; }, // never releases the lock
    sleep: async () => {},
    waitMs: 30,
    stepMs: 10
  });
  assert.equal(res.terminated, true);
  assert.deepEqual(calls, [[process.pid, 'SIGTERM'], [process.pid, 'SIGKILL']]);
});
