'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testProfileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-cloak-test-'));
process.env.AFFILIATE_CLOAK_PROFILE_DIR = testProfileRoot;
process.on('exit', () => {
  fs.rmSync(testProfileRoot, { recursive: true, force: true });
});

const browser = require('../src/browser');

const IDLE_ENV = 'AFFILIATE_CLOAK_BROWSER_IDLE_MS';
const KEEP_WARM_ENV = 'AFFILIATE_CLOAK_BROWSER_KEEP_WARM';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function withIdleEnv(t, value) {
  withEnv(t, IDLE_ENV, value);
}

function withKeepWarmEnv(t, value) {
  withEnv(t, KEEP_WARM_ENV, value);
}

function createFakeContext() {
  const closeHandlers = [];
  const pages = [];
  return {
    __closed: false,
    closeCalls: 0,
    pages() {
      return pages;
    },
    async newPage() {
      const page = {
        isClosed: () => false,
        url: () => 'about:blank',
        goto: async () => {},
        waitForTimeout: async () => {},
        bringToFront: async () => {},
      };
      pages.push(page);
      return page;
    },
    on(event, handler) {
      if (event === 'close') closeHandlers.push(handler);
    },
    async close() {
      this.closeCalls += 1;
      this.__closed = true;
      for (const handler of closeHandlers) handler();
    },
  };
}

function createFakeChromium(launches) {
  return {
    async launchPersistentContext(profileDir, options) {
      launches.push({
        profileDir,
        headless: options.headless,
      });
      return createFakeContext();
    },
  };
}

test('getContext reuses an existing context when launch mode matches', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const first = await browser.getContext('shopee', 'CHEARB', { headless: true });
  const second = await browser.getContext('shopee', 'CHEARB', { headless: true });

  assert.equal(second.context, first.context);
  assert.deepEqual(launches.map((launch) => launch.headless), [true]);
});

test('getContext closes and relaunches a persistent context when headless mode changes', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const first = await browser.getContext('shopee', 'CHEARB', { headless: true });
  const second = await browser.getContext('shopee', 'CHEARB', { headless: false });

  assert.notEqual(second.context, first.context);
  assert.equal(first.context.closeCalls, 1);
  assert.equal(second.headless, false);
  assert.equal(second.launchMode, 'headed');
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false]);
});

test('getPage forceVisible reopens a headless context as headed for manual login', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const first = await browser.getContext('lazada', 'CHEARB', { headless: true });
  const { record, page } = await browser.getPage('lazada', 'CHEARB', {
    headless: true,
    forceVisible: true,
  });

  assert.equal(typeof page.goto, 'function');
  assert.notEqual(record.context, first.context);
  assert.equal(first.context.closeCalls, 1);
  assert.equal(record.headless, false);
  assert.equal(record.launchMode, 'headed');
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false]);
});

test('getContext reuse before the idle timeout keeps the context alive', async (t) => {
  const launches = [];
  withIdleEnv(t, '10000');
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const first = await browser.getContext('shopee', 'CHEARB', { headless: true });
  await delay(40);
  const second = await browser.getContext('shopee', 'CHEARB', { headless: true });

  assert.equal(second.context, first.context);
  assert.equal(first.context.__closed, false);
  assert.equal(first.context.closeCalls, 0);
});

test('idle timer closes a headless context once it stops being used', async (t) => {
  const launches = [];
  withIdleEnv(t, '20');
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const record = await browser.getContext('shopee', 'CHEARB', { headless: true });
  await delay(120);

  assert.equal(record.context.__closed, true);
  assert.equal(record.context.closeCalls, 1);
  assert.equal(browser.listLoadedContexts().length, 0);
});

test('forceVisible/headed contexts are not auto-closed by default', async (t) => {
  const launches = [];
  withIdleEnv(t, '20');
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const { record } = await browser.getPage('lazada', 'CHEARB', {
    headless: true,
    forceVisible: true,
  });
  await delay(120);

  assert.equal(record.headless, false);
  assert.equal(record.launchMode, 'headed');
  assert.equal(record.context.__closed, false);
  assert.equal(record.context.closeCalls, 0);
  assert.equal(browser.listLoadedContexts().length, 1);
});

test('AFFILIATE_CLOAK_BROWSER_IDLE_MS=0 disables idle auto-close', async (t) => {
  const launches = [];
  withIdleEnv(t, '0');
  withKeepWarmEnv(t, undefined);
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const record = await browser.getContext('shopee', 'CHEARB', { headless: true });
  await delay(120);

  assert.equal(record.context.__closed, false);
  assert.equal(record.context.closeCalls, 0);
  assert.equal(browser.listLoadedContexts().length, 1);
});

// --- keep-warm mode -------------------------------------------------------

test('resolveKeepWarm honors explicit env values and default resolution', (t) => {
  withIdleEnv(t, undefined);
  withKeepWarmEnv(t, undefined);

  // Default (nothing set): keep warm so the hot path reuses the context.
  delete process.env[KEEP_WARM_ENV];
  delete process.env[IDLE_ENV];
  assert.equal(browser.resolveKeepWarm(), true);

  // Explicit truthy/falsey values win.
  process.env[KEEP_WARM_ENV] = 'on';
  assert.equal(browser.resolveKeepWarm(), true);
  process.env[KEEP_WARM_ENV] = '0';
  assert.equal(browser.resolveKeepWarm(), false);
  process.env[KEEP_WARM_ENV] = 'off';
  assert.equal(browser.resolveKeepWarm(), false);

  // Keep-warm wins over an idle-close window when it is explicitly enabled.
  process.env[KEEP_WARM_ENV] = 'true';
  process.env[IDLE_ENV] = '5000';
  assert.equal(browser.resolveKeepWarm(), true);

  // Unset keep-warm + an explicit idle-close window => operator opted into
  // idle-close, so keep-warm defers.
  delete process.env[KEEP_WARM_ENV];
  process.env[IDLE_ENV] = '5000';
  assert.equal(browser.resolveKeepWarm(), false);
  process.env[IDLE_ENV] = '0';
  assert.equal(browser.resolveKeepWarm(), false);

  // Unknown keep-warm value falls back to default resolution.
  process.env[KEEP_WARM_ENV] = 'maybe';
  delete process.env[IDLE_ENV];
  assert.equal(browser.resolveKeepWarm(), true);
});

test('keep-warm keeps a reused headless context resident (no relaunch, no Dock bounce)', async (t) => {
  const launches = [];
  withKeepWarmEnv(t, '1');
  withIdleEnv(t, '20'); // keep-warm must win over this idle window
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const first = await browser.getContext('shopee', 'CHEARB', { headless: true });
  await delay(120); // longer than the idle window — would have closed if not warm
  const second = await browser.getContext('shopee', 'CHEARB', { headless: true });

  assert.equal(second.context, first.context);
  assert.equal(first.context.__closed, false);
  assert.equal(first.context.closeCalls, 0);
  assert.equal(first.keepWarm, true);
  // Only one launch: the hot path reused the warm context instead of relaunching.
  assert.deepEqual(launches.map((launch) => launch.headless), [true]);
  assert.equal(browser.listLoadedContexts().length, 1);
});

test('keep-warm by default (no env set) leaves a headless context resident', async (t) => {
  const launches = [];
  withKeepWarmEnv(t, undefined);
  withIdleEnv(t, undefined);
  delete process.env[KEEP_WARM_ENV];
  delete process.env[IDLE_ENV];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const record = await browser.getContext('shopee', 'CHEARB', { headless: true });
  await delay(60);

  assert.equal(record.keepWarm, true);
  assert.equal(record.context.__closed, false);
  assert.equal(record.context.closeCalls, 0);
  assert.equal(browser.listLoadedContexts().length, 1);
});

test('keep-warm disabled (explicit 0) still honors idle-close', async (t) => {
  const launches = [];
  withKeepWarmEnv(t, '0');
  withIdleEnv(t, '20');
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const record = await browser.getContext('shopee', 'CHEARB', { headless: true });
  assert.equal(record.keepWarm, false);
  await delay(120);

  assert.equal(record.context.__closed, true);
  assert.equal(record.context.closeCalls, 1);
  assert.equal(browser.listLoadedContexts().length, 0);
});

test('keep-warm never keeps a headed/manual (forceVisible) context resident flag off', async (t) => {
  const launches = [];
  withKeepWarmEnv(t, '1');
  withIdleEnv(t, undefined);
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const { record } = await browser.getPage('lazada', 'CHEARB', {
    headless: true,
    forceVisible: true,
  });
  await delay(60);

  // Manual visible login window stays open (as before) but is NOT flagged as a
  // keep-warm headless context — it is preserved by the headed rule instead.
  assert.equal(record.headless, false);
  assert.equal(record.launchMode, 'headed');
  assert.equal(record.keepWarm, false);
  assert.equal(record.context.__closed, false);
  assert.equal(browser.listLoadedContexts().length, 1);
});
