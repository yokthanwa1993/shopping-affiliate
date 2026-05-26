'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testProfileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-cloak-click-report-test-'));
process.env.AFFILIATE_CLOAK_PROFILE_DIR = testProfileRoot;
process.on('exit', () => {
  fs.rmSync(testProfileRoot, { recursive: true, force: true });
});

const browser = require('../src/browser');
const clickReport = require('../src/click-report');
const server = require('../src/server');

// "2026-05-26 03:00 UTC" -> Bangkok 2026-05-26 10:00 (deterministic for date defaults)
const FROZEN_NOW = new Date('2026-05-26T03:00:00Z');

function httpRequest(serverInstance, { method = 'GET', path: requestPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const address = serverInstance.address();
    const opts = {
      host: address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address,
      port: address.port,
      method,
      path: requestPath,
      headers: { ...headers },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function startTestServer() {
  return new Promise((resolve) => {
    const instance = server.createServer();
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
}

function stopTestServer(instance) {
  return new Promise((resolve) => instance.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

test('parseClickReportDate accepts DD/MM/YYYY and computes Bangkok-day Unix range', () => {
  const out = clickReport.parseClickReportDate('25/05/2026');
  assert.equal(out.display, '25/05/2026');
  assert.equal(out.isoDate, '2026-05-25');
  assert.equal(out.timezone, 'Asia/Bangkok');
  // Bangkok 00:00:00 on 2026-05-25 == 2026-05-24T17:00:00Z
  assert.equal(out.click_time_s, Math.floor(Date.UTC(2026, 4, 24, 17, 0, 0) / 1000));
  // Bangkok 23:59:59 on 2026-05-25 == 2026-05-25T16:59:59Z
  assert.equal(out.click_time_e, Math.floor(Date.UTC(2026, 4, 25, 16, 59, 59) / 1000));
  assert.equal(out.click_time_e - out.click_time_s, 86399);
});

test('parseClickReportDate accepts YYYY-MM-DD ISO format', () => {
  const out = clickReport.parseClickReportDate('2026-05-25');
  assert.equal(out.display, '25/05/2026');
  assert.equal(out.isoDate, '2026-05-25');
});

test('parseClickReportDate("today") uses Bangkok local day not server UTC', () => {
  // 2026-05-25T18:00:00Z == Bangkok 2026-05-26 01:00 — must yield 2026-05-26.
  const lateUtc = new Date('2026-05-25T18:00:00Z');
  const out = clickReport.parseClickReportDate('today', { now: lateUtc });
  assert.equal(out.display, '26/05/2026');
  assert.equal(out.isoDate, '2026-05-26');
});

test('parseClickReportDate("yesterday") subtracts 24h before applying Bangkok day', () => {
  const out = clickReport.parseClickReportDate('yesterday', { now: FROZEN_NOW });
  assert.equal(out.display, '25/05/2026');
  assert.equal(out.isoDate, '2026-05-25');
});

test('parseClickReportDate defaults missing/blank input to Bangkok today', () => {
  const out = clickReport.parseClickReportDate('', { now: FROZEN_NOW });
  assert.equal(out.display, '26/05/2026');
});

test('parseClickReportDate rejects garbage with click_report_time_invalid', () => {
  assert.throws(
    () => clickReport.parseClickReportDate('not-a-date'),
    (err) => {
      assert.equal(err.reason, 'click_report_time_invalid');
      assert.equal(err.statusCode, 400);
      assert.equal(err.publicPayload.reason, 'click_report_time_invalid');
      assert.equal(err.publicPayload.requestedTime, 'not-a-date');
      return true;
    },
  );
});

test('parseClickReportDate rejects out-of-range day (32/05/2026)', () => {
  assert.throws(
    () => clickReport.parseClickReportDate('32/05/2026'),
    (err) => err.reason === 'click_report_time_invalid',
  );
});

// ---------------------------------------------------------------------------
// Page num / size clamping
// ---------------------------------------------------------------------------

test('clampPageSize defaults to 20 and clamps above 100', () => {
  assert.equal(clickReport.clampPageSize(undefined), 20);
  assert.equal(clickReport.clampPageSize(''), 20);
  assert.equal(clickReport.clampPageSize('50'), 50);
  assert.equal(clickReport.clampPageSize(500), 100);
  assert.equal(clickReport.clampPageSize(-1), 20);
});

test('clampPageNum defaults to 1 and floors at 1', () => {
  assert.equal(clickReport.clampPageNum(undefined), 1);
  assert.equal(clickReport.clampPageNum('0'), 1);
  assert.equal(clickReport.clampPageNum('7'), 7);
});

// ---------------------------------------------------------------------------
// Request resolution + id alias mapping
// ---------------------------------------------------------------------------

test('resolveClickReportRequest defaults id to 15130770000 (affiliate_chearb.com) when omitted', () => {
  const spec = clickReport.resolveClickReportRequest({ time: '25/05/2026' }, { now: FROZEN_NOW });
  assert.equal(spec.id, '15130770000');
  assert.equal(spec.account, 'affiliate_chearb.com');
  assert.equal(spec.accountInternal, 'affiliate_chearb.com');
  assert.equal(spec.displayAccount, 'affiliate@chearb.com');
  assert.equal(spec.time, '25/05/2026');
  assert.equal(spec.page_num, 1);
  assert.equal(spec.page_size, 20);
});

test('resolveClickReportRequest maps 15142270000 to affiliate_neezs.com', () => {
  const spec = clickReport.resolveClickReportRequest({ id: '15142270000', time: 'yesterday' }, { now: FROZEN_NOW });
  assert.equal(spec.id, '15142270000');
  assert.equal(spec.account, 'affiliate_neezs.com');
  assert.equal(spec.displayAccount, 'affiliate@neezs.com');
  assert.equal(spec.time, '25/05/2026');
});

test('resolveClickReportRequest accepts an_ prefix for id', () => {
  const spec = clickReport.resolveClickReportRequest({ id: 'an_15142270000' }, { now: FROZEN_NOW });
  assert.equal(spec.id, '15142270000');
  assert.equal(spec.account, 'affiliate_neezs.com');
});

test('resolveClickReportRequest rejects unknown id with safe publicPayload (no secrets)', () => {
  assert.throws(
    () => clickReport.resolveClickReportRequest({ id: '999999999999', time: '25/05/2026' }),
    (err) => {
      assert.equal(err.reason, 'shopee_affiliate_id_unknown');
      assert.equal(err.statusCode, 400);
      assert.equal(err.publicPayload.requestedId, '999999999999');
      assert.equal(/cookie|token|password|secret/i.test(JSON.stringify(err.publicPayload)), false);
      return true;
    },
  );
});

test('resolveClickReportRequest rejects unparseable id with shopee_affiliate_id_invalid', () => {
  assert.throws(
    () => clickReport.resolveClickReportRequest({ id: 'not-an-id' }),
    (err) => err.reason === 'shopee_affiliate_id_invalid',
  );
});

test('resolveClickReportRequest reads page_num and falls back to page when page_num is blank', () => {
  const spec = clickReport.resolveClickReportRequest(
    { id: '15130770000', time: '25/05/2026', page_num: '', page: '4', page_size: '5' },
    { now: FROZEN_NOW },
  );
  assert.equal(spec.page_num, 4);
  assert.equal(spec.page_size, 5);
});

test('resolveClickReportRequest passes through sub_id/click_id/click_region when non-empty', () => {
  const spec = clickReport.resolveClickReportRequest(
    { id: '15130770000', time: '25/05/2026', sub_id: 'yok', click_id: '', click_region: 'TH' },
    { now: FROZEN_NOW },
  );
  assert.deepEqual(spec.extras, { sub_id: 'yok', click_region: 'TH' });
});

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

test('buildClickReportFetchUrl includes click_time_s/e, page_num, page_size, and extras', () => {
  const spec = clickReport.resolveClickReportRequest(
    { id: '15142270000', time: '25/05/2026', page_size: '5', sub_id: 'yok' },
    { now: FROZEN_NOW },
  );
  const url = clickReport.buildClickReportFetchUrl(spec);
  assert.match(url, /^https:\/\/affiliate\.shopee\.co\.th\/api\/v1\/click_report\/list\?/);
  assert.match(url, /click_time_s=\d+/);
  assert.match(url, /click_time_e=\d+/);
  assert.match(url, /page_num=1/);
  assert.match(url, /page_size=5/);
  assert.match(url, /sub_id=yok/);
});

// ---------------------------------------------------------------------------
// classifyClickReportFailure
// ---------------------------------------------------------------------------

test('classifyClickReportFailure returns shopee_login_required for code 30001', () => {
  assert.equal(clickReport.classifyClickReportFailure({ code: 30001 }), 'shopee_login_required');
  assert.equal(clickReport.classifyClickReportFailure({ code: '30001' }), 'shopee_login_required');
  assert.equal(clickReport.classifyClickReportFailure({ data: { code: 30001 } }), 'shopee_login_required');
});

test('classifyClickReportFailure returns null for healthy envelope', () => {
  assert.equal(clickReport.classifyClickReportFailure({ data: { total_count: 12, list: [] } }), null);
  assert.equal(clickReport.classifyClickReportFailure(null), null);
});

// ---------------------------------------------------------------------------
// isClickReportHost
// ---------------------------------------------------------------------------

test('isClickReportHost matches clickreport.wwoom.com (any port, case-insensitive)', () => {
  assert.equal(clickReport.isClickReportHost('clickreport.wwoom.com'), true);
  assert.equal(clickReport.isClickReportHost('clickreport.wwoom.com:8810'), true);
  assert.equal(clickReport.isClickReportHost('ClickReport.WWoom.com'), true);
});

test('isClickReportHost rejects other hosts', () => {
  assert.equal(clickReport.isClickReportHost(''), false);
  assert.equal(clickReport.isClickReportHost('127.0.0.1:8810'), false);
  assert.equal(clickReport.isClickReportHost('shopee.co.th'), false);
  assert.equal(clickReport.isClickReportHost('clickreport.evil.com'), false);
});

// ---------------------------------------------------------------------------
// handleClickReport with stubbed browser
// ---------------------------------------------------------------------------

function stubBrowserForClickReport(t, opts = {}) {
  const originalGetPage = browser.getPage;
  const originalEnsureOnPlatformPage = browser.ensureOnPlatformPage;
  const originalIsOnPlatformOrigin = browser.isOnPlatformOrigin;
  const evaluates = [];
  const getPageCalls = [];

  t.after(() => {
    browser.getPage = originalGetPage;
    browser.ensureOnPlatformPage = originalEnsureOnPlatformPage;
    browser.isOnPlatformOrigin = originalIsOnPlatformOrigin;
  });

  browser.getPage = async (platform, account, browserOpts) => {
    getPageCalls.push({ platform, account, opts: browserOpts });
    return {
      record: {},
      page: {
        url: () => opts.currentUrl || 'https://affiliate.shopee.co.th/',
        goto: async () => {},
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (_fn, args) => {
          evaluates.push(args);
          if (typeof opts.evaluateResult === 'function') return opts.evaluateResult(args);
          return opts.evaluateResult;
        },
      },
    };
  };
  browser.ensureOnPlatformPage = async () => {};
  browser.isOnPlatformOrigin = (url) => /affiliate\.shopee\.co\.th/i.test(String(url || ''));

  return { evaluates, getPageCalls };
}

test('handleClickReport raw mode returns ok payload with total_count, list, affiliate_id from stubbed Shopee response', async (t) => {
  const stub = stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15142270000,
          total_count: 26437,
          list: [
            { click_id: 'c1', click_time: 1748226000, click_region: 'TH', sub_id: 'yok', referrer: '' },
            { click_id: 'c2', click_time: 1748226100, click_region: 'TH', sub_id: '', referrer: 'fb' },
          ],
        },
      },
    },
  });

  const result = await clickReport.handleClickReport(
    { id: '15142270000', time: '25/05/2026', page_size: '50', raw: '1' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'raw');
  assert.equal(result.id, '15142270000');
  assert.equal(result.account, 'affiliate@neezs.com');
  assert.equal(result.accountInternal, 'affiliate_neezs.com');
  assert.equal(result.time, '25/05/2026');
  assert.equal(result.range.timezone, 'Asia/Bangkok');
  assert.equal(result.page_num, 1);
  assert.equal(result.page_size, 50);
  assert.equal(result.total_count, 26437);
  assert.equal(result.affiliate_id, '15142270000');
  assert.equal(result.list.length, 2);
  assert.equal(result.source, 'shopee_click_report_api');
  assert.equal(stub.getPageCalls[0].platform, 'shopee');
  assert.equal(stub.getPageCalls[0].account, 'affiliate_neezs.com');
  assert.deepEqual(stub.getPageCalls[0].opts, { headless: true });
  // Sanity: response must not leak cookie/token/password fields.
  assert.equal(/cookie|token|password|secret/i.test(JSON.stringify(result)), false);
});

test('handleClickReport default summary mode aggregates multi-page sub_id counts with no list key', async (t) => {
  // Page 1: 100 rows -> 50 alpha + 50 beta (forces a second page; list.length === pageSize).
  // Page 2: 40 rows -> 30 alpha + 10 empty sub_id (list.length < pageSize -> stop).
  // Aggregate: alpha=80 (57.14%), beta=50 (35.71%), '' (empty) = 10 (7.14%).
  const buildRows = (count, subId) => {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      rows.push({ click_id: `${subId || 'empty'}-${i}`, click_time: 1748226000 + i, click_region: 'TH', sub_id: subId, referrer: '' });
    }
    return rows;
  };
  const pages = {
    1: { affiliate_id: 15142270000, total_count: 140, list: [].concat(buildRows(50, 'alpha'), buildRows(50, 'beta')) },
    2: { affiliate_id: 15142270000, total_count: 140, list: [].concat(buildRows(30, 'alpha'), buildRows(10, '')) },
  };
  const stub = stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: (args) => {
      const apiUrl = args[0];
      const url = new URL(apiUrl);
      const pageNum = Number(url.searchParams.get('page_num'));
      const pageSize = Number(url.searchParams.get('page_size'));
      assert.equal(pageSize, 100, 'summary mode must request page_size=100');
      const data = pages[pageNum] || { affiliate_id: 15142270000, total_count: 140, list: [] };
      return { status: 200, parsed: true, body: { code: 0, data } };
    },
  });

  const result = await clickReport.handleClickReport(
    { id: '15142270000', time: '25/05/2026', page_size: '50' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.id, '15142270000');
  assert.equal(result.account, 'affiliate@neezs.com');
  assert.equal(result.accountInternal, 'affiliate_neezs.com');
  assert.equal(result.time, '25/05/2026');
  assert.equal(result.range.timezone, 'Asia/Bangkok');
  assert.equal(result.total_count, 140);
  assert.equal(result.page_size, 100);
  assert.equal(result.pages_fetched, 2);
  assert.equal(result.row_sample_count, 140);
  assert.equal(result.truncated, false);
  assert.equal(result.breakdown_mode, 'complete');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'warning'), false);
  assert.equal(result.unique_sub_id_count, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'list'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'page_num'), false);
  // Sort: count desc, sub_id asc as tiebreaker.
  assert.deepEqual(result.sub_ids, [
    { sub_id: 'alpha', count: 80, percent: 57.14 },
    { sub_id: 'beta', count: 50, percent: 35.71 },
    { sub_id: '', count: 10, percent: 7.14 },
  ]);
  // Stub recorded one apiUrl per fetched page; both should target the same date range.
  assert.equal(stub.evaluates.length, 2);
  // Sanity: response must not leak cookie/token/password fields.
  assert.equal(/cookie|token|password|secret/i.test(JSON.stringify(result)), false);
});

test('handleClickReport default summary mode stops on first page when list shorter than page_size', async (t) => {
  const stub = stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 3,
          list: [
            { click_id: 'c1', click_time: 1748226000, click_region: 'TH', sub_id: 'yok', referrer: '' },
            { click_id: 'c2', click_time: 1748226100, click_region: 'TH', sub_id: 'yok', referrer: '' },
            { click_id: 'c3', click_time: 1748226200, click_region: 'TH', sub_id: '', referrer: '' },
          ],
        },
      },
    },
  });
  const result = await clickReport.handleClickReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.pages_fetched, 1);
  assert.equal(result.total_count, 3);
  assert.equal(result.row_sample_count, 3);
  assert.equal(result.breakdown_mode, 'complete');
  assert.equal(result.truncated, false);
  assert.equal(result.unique_sub_id_count, 2);
  assert.deepEqual(result.sub_ids, [
    { sub_id: 'yok', count: 2, percent: 66.67 },
    { sub_id: '', count: 1, percent: 33.33 },
  ]);
  assert.equal(stub.evaluates.length, 1);
});

test('handleClickReport summary mode honors sub_id filter passthrough', async (t) => {
  const stub = stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: (args) => {
      const apiUrl = args[0];
      const url = new URL(apiUrl);
      assert.equal(url.searchParams.get('sub_id'), '16MAY26FBSPCAD');
      assert.equal(url.searchParams.get('page_size'), '100');
      assert.equal(url.searchParams.get('page_num'), '1');
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            affiliate_id: 15130770000,
            total_count: 2,
            list: [
              { click_id: 'a', click_time: 1748226000, click_region: 'TH', sub_id: '16MAY26FBSPCAD----', referrer: '' },
              { click_id: 'b', click_time: 1748226001, click_region: 'TH', sub_id: '16MAY26FBSPCAD----', referrer: '' },
            ],
          },
        },
      };
    },
  });
  const result = await clickReport.handleClickReport(
    { id: '15130770000', time: '25/05/2026', sub_id: '16MAY26FBSPCAD' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.total_count, 2);
  assert.equal(result.unique_sub_id_count, 1);
  assert.equal(result.breakdown_mode, 'filtered');
  assert.equal(result.pages_fetched, 1);
  assert.equal(result.row_sample_count, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.sub_ids, [
    { sub_id: '16MAY26FBSPCAD----', requested_sub_id: '16MAY26FBSPCAD', count: 2, percent: 100 },
  ]);
  assert.equal(stub.evaluates.length, 1);
});

test('handleClickReport filtered summary uses total_count even when Shopee caps the row list', async (t) => {
  // Reproduces the live bug: Shopee reports total_count=32247 but the list
  // pagination only ever yields up to ~10,000 rows. Summary mode with a
  // sub_id filter must report 32247, not the enumerable row count.
  const buildRow = (idx) => ({
    click_id: 'cid-' + idx,
    click_time: 1748226000 + idx,
    click_region: 'TH',
    sub_id: '16MAY26FBSPCAD----',
    referrer: '',
  });
  const rows = [];
  for (let i = 0; i < 100; i += 1) rows.push(buildRow(i));
  const stub = stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: (args) => {
      const url = new URL(args[0]);
      assert.equal(url.searchParams.get('sub_id'), '16MAY26FBSPCAD');
      assert.equal(url.searchParams.get('page_num'), '1');
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            affiliate_id: 15130770000,
            total_count: 32247,
            list: rows,
          },
        },
      };
    },
  });
  const result = await clickReport.handleClickReport(
    { id: '15130770000', time: '25/05/2026', sub_id: '16MAY26FBSPCAD' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.total_count, 32247);
  assert.equal(result.unique_sub_id_count, 1);
  assert.equal(result.breakdown_mode, 'filtered');
  assert.equal(result.pages_fetched, 1, 'filtered summary must stop after first page');
  assert.equal(result.row_sample_count, 100);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.sub_ids, [
    { sub_id: '16MAY26FBSPCAD----', requested_sub_id: '16MAY26FBSPCAD', count: 32247, percent: 100 },
  ]);
  // Only one Shopee fetch should happen for filtered mode.
  assert.equal(stub.evaluates.length, 1);
});

test('handleClickReport unfiltered summary marks breakdown_mode sample when Shopee caps pagination below total_count', async (t) => {
  // Simulate Shopee capping the row list at 2 pages even though total_count is huge.
  // Page 1: 100 rows (alpha). Page 2: 100 rows (beta). Page 3: empty -> stop.
  // Aggregate rowSampleCount=200, totalCount=32247 -> sample mode.
  const buildRows = (count, subId) => {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push({ click_id: `${subId}-${i}`, click_time: 1748226000 + i, click_region: 'TH', sub_id: subId, referrer: '' });
    }
    return out;
  };
  const pages = {
    1: { affiliate_id: 15130770000, total_count: 32247, list: buildRows(100, 'alpha') },
    2: { affiliate_id: 15130770000, total_count: 32247, list: buildRows(100, 'beta') },
    3: { affiliate_id: 15130770000, total_count: 32247, list: [] },
  };
  const stub = stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: (args) => {
      const url = new URL(args[0]);
      const pageNum = Number(url.searchParams.get('page_num'));
      assert.equal(url.searchParams.get('page_size'), '100');
      assert.equal(url.searchParams.has('sub_id'), false, 'unfiltered must not send sub_id');
      const data = pages[pageNum] || { affiliate_id: 15130770000, total_count: 32247, list: [] };
      return { status: 200, parsed: true, body: { code: 0, data } };
    },
  });

  const result = await clickReport.handleClickReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.breakdown_mode, 'sample');
  assert.equal(result.truncated, true);
  assert.equal(result.total_count, 32247);
  assert.equal(result.row_sample_count, 200);
  assert.equal(result.pages_fetched, 3);
  // Sample entries must use sample_count/sample_percent (NOT count/percent) to
  // avoid implying the percentage is of total_count.
  assert.equal(result.unique_sub_id_count, 2);
  assert.deepEqual(result.sub_ids, [
    { sub_id: 'alpha', sample_count: 100, sample_percent: 50 },
    { sub_id: 'beta', sample_count: 100, sample_percent: 50 },
  ]);
  for (const entry of result.sub_ids) {
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'count'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'percent'), false);
  }
  assert.match(result.warning, /sub_id=/);
  assert.equal(stub.evaluates.length, 3);
});

test('handleClickReport unfiltered summary stays breakdown_mode complete with percent when row sample matches total_count', async (t) => {
  // Reuse the small-total scenario: total_count=3, all rows fit on first page.
  // This is the canonical "complete" case and must keep the original
  // count/percent field shape (no sample_count, no warning).
  stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 3,
          list: [
            { click_id: 'c1', click_time: 1748226000, click_region: 'TH', sub_id: 'yok', referrer: '' },
            { click_id: 'c2', click_time: 1748226100, click_region: 'TH', sub_id: 'yok', referrer: '' },
            { click_id: 'c3', click_time: 1748226200, click_region: 'TH', sub_id: '', referrer: '' },
          ],
        },
      },
    },
  });
  const result = await clickReport.handleClickReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.breakdown_mode, 'complete');
  assert.equal(result.truncated, false);
  assert.equal(result.total_count, 3);
  assert.equal(result.row_sample_count, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'warning'), false);
  assert.deepEqual(result.sub_ids, [
    { sub_id: 'yok', count: 2, percent: 66.67 },
    { sub_id: '', count: 1, percent: 33.33 },
  ]);
});

test('handleClickReport summary mode propagates manual_login_required from first page', async (t) => {
  stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: { status: 200, parsed: true, body: { code: 30001, message: 'Not Login' } },
  });
  const result = await clickReport.handleClickReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.mode, 'summary');
  assert.equal(result.reason, 'shopee_login_required');
  assert.equal(result.loginUi, '/login?platform=shopee');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'list'), false);
});

test('isRawClickReportMode accepts raw=1, raw=true, mode=raw; rejects others', () => {
  assert.equal(clickReport.isRawClickReportMode({ raw: '1' }), true);
  assert.equal(clickReport.isRawClickReportMode({ raw: 'true' }), true);
  assert.equal(clickReport.isRawClickReportMode({ raw: 'yes' }), true);
  assert.equal(clickReport.isRawClickReportMode({ mode: 'raw' }), true);
  assert.equal(clickReport.isRawClickReportMode({ mode: 'RAW' }), true);
  assert.equal(clickReport.isRawClickReportMode({}), false);
  assert.equal(clickReport.isRawClickReportMode({ raw: '0' }), false);
  assert.equal(clickReport.isRawClickReportMode({ mode: 'summary' }), false);
  assert.equal(clickReport.isRawClickReportMode(null), false);
});

test('handleClickReport returns manual_login_required when Shopee responds with code 30001', async (t) => {
  stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: { code: 30001, message: 'Not Login' },
    },
  });

  const result = await clickReport.handleClickReport(
    { id: '15142270000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.reason, 'shopee_login_required');
  assert.equal(result.manualLoginRequired, true);
  assert.equal(result.loginUi, '/login?platform=shopee');
  assert.equal(result.account, 'affiliate@neezs.com');
});

test('handleClickReport returns manual_login_required on HTTP 401 without leaking detail', async (t) => {
  stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: { status: 401, parsed: false, snippet: 'unauthorized' },
  });
  const result = await clickReport.handleClickReport({ id: '15130770000' }, { now: FROZEN_NOW });
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.reason, 'shopee_unauthorized');
  assert.equal(result.httpStatus, 401);
});

test('handleClickReport returns manual_login_required when page is redirected to buyer login', async (t) => {
  stubBrowserForClickReport(t, {
    currentUrl: 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2F',
    evaluateResult: { status: 200, parsed: true, body: { code: 0 } },
  });
  const result = await clickReport.handleClickReport({ id: '15130770000' }, { now: FROZEN_NOW });
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.reason, 'shopee_login_required');
});

test('handleClickReport reports click_report_fetch_failed on evaluate throw without exposing the raw error verbatim', async (t) => {
  stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: () => { throw new Error('Failed to fetch'); },
  });
  const result = await clickReport.handleClickReport({ id: '15130770000' }, { now: FROZEN_NOW });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'click_report_fetch_failed');
  assert.match(result.detail, /Failed to fetch/);
});

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

test('GET /click-report returns shopee_affiliate_id_unknown JSON for unmapped id (no browser call)', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called for an unknown id');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, { path: '/click-report?id=999999999999&time=25/05/2026' });
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.reason, 'shopee_affiliate_id_unknown');
  assert.equal(parsed.requestedId, '999999999999');
  assert.equal(getPageCalls.length, 0);
});

test('GET /click-report returns click_report_time_invalid JSON for garbage time without opening a browser', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called for an invalid time');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, { path: '/click-report?id=15130770000&time=not-a-date' });
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.reason, 'click_report_time_invalid');
  assert.equal(getPageCalls.length, 0);
});

test('GET / on Host clickreport.wwoom.com is routed to /click-report and returns summary by default', async (t) => {
  stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 3,
          list: [
            { click_id: 'c1', click_time: 1748226000, click_region: 'TH', sub_id: 'yok', referrer: '' },
            { click_id: 'c2', click_time: 1748226100, click_region: 'TH', sub_id: 'yok', referrer: '' },
            { click_id: 'c3', click_time: 1748226200, click_region: 'TH', sub_id: '', referrer: '' },
          ],
        },
      },
    },
  });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    path: '/?time=25/05/2026',
    headers: { Host: 'clickreport.wwoom.com' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /application\/json/);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.mode, 'summary');
  assert.equal(parsed.id, '15130770000');
  assert.equal(parsed.account, 'affiliate@chearb.com');
  assert.equal(parsed.total_count, 3);
  assert.equal(parsed.unique_sub_id_count, 2);
  assert.equal(parsed.page_size, 100);
  assert.equal(parsed.pages_fetched, 1);
  assert.equal(parsed.row_sample_count, 3);
  assert.equal(parsed.breakdown_mode, 'complete');
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.source, 'shopee_click_report_api');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'list'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'warning'), false);
  assert.deepEqual(parsed.sub_ids, [
    { sub_id: 'yok', count: 2, percent: 66.67 },
    { sub_id: '', count: 1, percent: 33.33 },
  ]);
});

test('GET /click-report?raw=1 preserves single-page list response', async (t) => {
  stubBrowserForClickReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 9,
          list: [
            { click_id: 'c1', click_time: 1748226000, click_region: 'TH', sub_id: 'yok', referrer: '' },
          ],
        },
      },
    },
  });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    path: '/click-report?id=15130770000&time=25/05/2026&raw=1&page_size=5&page_num=2',
  });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.mode, 'raw');
  assert.equal(parsed.total_count, 9);
  assert.equal(parsed.page_num, 2);
  assert.equal(parsed.page_size, 5);
  assert.equal(Array.isArray(parsed.list), true);
  assert.equal(parsed.list.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'sub_ids'), false);
});

test('GET / on default Host still serves the shortlink index HTML (no regression)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, { path: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/);
  assert.match(res.body, /Affiliate Shortlink Cloak Bridge/);
});

test('GET / on default Host with ?url=... still routes to shorten (returns JSON error, not click-report)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    path: '/?url=' + encodeURIComponent('https://example.com/foo'),
  });
  assert.match(String(res.headers['content-type'] || ''), /application\/json/);
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error || '', /Cannot detect platform/);
});

test('POST /click-report returns 405 (only GET is allowed)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));
  const res = await httpRequest(instance, { method: 'POST', path: '/click-report' });
  assert.equal(res.statusCode, 405);
  assert.match(String(res.headers['allow'] || ''), /GET/);
});
