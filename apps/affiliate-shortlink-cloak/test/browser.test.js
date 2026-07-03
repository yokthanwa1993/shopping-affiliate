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
        options,
      });
      return createFakeContext();
    },
  };
}

// cloakbrowser takes a single options object (with userDataDir) instead of the
// (profileDir, options) signature that playwright-core uses.
function createFakeCloakBrowser(launches) {
  return {
    async launchPersistentContext(options) {
      launches.push({
        profileDir: options.userDataDir,
        headless: options.headless,
        options,
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

  const first = await browser.getContext('lazada', 'CHEARB', { headless: true });
  const second = await browser.getContext('lazada', 'CHEARB', { headless: true });

  assert.equal(second.context, first.context);
  assert.deepEqual(launches.map((launch) => launch.headless), [true]);
});

test('getContext closes and relaunches a persistent context when headless mode changes', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const first = await browser.getContext('lazada', 'CHEARB', { headless: true });
  const second = await browser.getContext('lazada', 'CHEARB', { headless: false });

  assert.notEqual(second.context, first.context);
  assert.equal(first.context.closeCalls, 1);
  assert.equal(second.headless, false);
  assert.equal(second.launchMode, 'headed');
  assert.deepEqual(launches.map((launch) => launch.headless), [true, false]);
});

test('getContext keeps Shopee headless for automatic shorten when requested', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const record = await browser.getContext('shopee', 'CHEARB', { headless: true });

  assert.equal(record.headless, true);
  assert.equal(record.launchMode, 'headless');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].headless, true);
});

test('getContext launches Shopee with defaults only — no userAgent/viewport/locale/args', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  await browser.getContext('shopee', 'CHEARB', { headless: true });

  const opts = launches[0].options;
  assert.deepEqual(Object.keys(opts), ['headless']);
  assert.equal(opts.headless, true);
  assert.equal('userAgent' in opts, false);
  assert.equal('viewport' in opts, false);
  assert.equal('locale' in opts, false);
  assert.equal('args' in opts, false);
});

test('getContext (cloakbrowser) launches Shopee headless with only humanize default', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('cloakbrowser', createFakeCloakBrowser(launches));
  t.after(() => browser.__resetForTest());

  const record = await browser.getContext('shopee', 'CHEARB', { headless: true });

  const opts = launches[0].options;
  assert.equal(typeof opts.userDataDir, 'string');
  assert.equal(opts.userDataDir.length > 0, true);
  assert.equal(opts.humanize, true);
  assert.equal(opts.headless, true);
  assert.equal('userAgent' in opts, false);
  assert.equal('viewport' in opts, false);
  assert.equal('locale' in opts, false);
  assert.equal('args' in opts, false);
  assert.equal(record.launchMode, 'headless');
});

test('getPage keeps Shopee headless for automatic shorten/reauth', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  const { record } = await browser.getPage('shopee', 'CHEARB', { headless: true });

  assert.equal(record.headless, true);
  assert.equal(record.launchMode, 'headless');
  assert.equal(launches[0].headless, true);
  assert.deepEqual(Object.keys(launches[0].options), ['headless']);
});

test('getContext keeps the configured launch options for Lazada', async (t) => {
  const launches = [];
  await browser.__resetForTest();
  browser.__setChromiumForTest('playwright-core', createFakeChromium(launches));
  t.after(() => browser.__resetForTest());

  await browser.getContext('lazada', 'CHEARB', { headless: true });

  const opts = launches[0].options;
  assert.equal(opts.headless, true);
  assert.equal(typeof opts.userAgent, 'string');
  assert.equal(opts.userAgent.length > 0, true);
  assert.deepEqual(opts.viewport, { width: 1280, height: 800 });
  assert.equal(opts.locale, 'en-US');
  assert.deepEqual(opts.args, ['--no-sandbox', '--disable-blink-features=AutomationControlled']);
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
