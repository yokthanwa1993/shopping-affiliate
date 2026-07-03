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
