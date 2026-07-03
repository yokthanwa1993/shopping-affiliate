'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testProfileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-cloak-conversion-report-test-'));
process.env.AFFILIATE_CLOAK_PROFILE_DIR = testProfileRoot;
process.on('exit', () => {
  fs.rmSync(testProfileRoot, { recursive: true, force: true });
});

const browser = require('../src/browser');
const conversionReport = require('../src/conversion-report');
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

test('parseConversionReportDate accepts DD/MM/YYYY and exposes purchase_time_s/e for Bangkok day', () => {
  const out = conversionReport.parseConversionReportDate('25/05/2026');
  assert.equal(out.display, '25/05/2026');
  assert.equal(out.isoDate, '2026-05-25');
  assert.equal(out.timezone, 'Asia/Bangkok');
  // Bangkok 00:00:00 on 2026-05-25 == 2026-05-24T17:00:00Z
  assert.equal(out.purchase_time_s, Math.floor(Date.UTC(2026, 4, 24, 17, 0, 0) / 1000));
  // Bangkok 23:59:59 on 2026-05-25 == 2026-05-25T16:59:59Z
  assert.equal(out.purchase_time_e, Math.floor(Date.UTC(2026, 4, 25, 16, 59, 59) / 1000));
  assert.equal(out.purchase_time_e - out.purchase_time_s, 86399);
});

test('parseConversionReportDate accepts YYYY-MM-DD ISO format', () => {
  const out = conversionReport.parseConversionReportDate('2026-05-25');
  assert.equal(out.display, '25/05/2026');
  assert.equal(out.isoDate, '2026-05-25');
});

test('parseConversionReportDate("today") uses Bangkok local day not server UTC', () => {
  const lateUtc = new Date('2026-05-25T18:00:00Z');
  const out = conversionReport.parseConversionReportDate('today', { now: lateUtc });
  assert.equal(out.display, '26/05/2026');
});

test('parseConversionReportDate("yesterday") subtracts 24h before applying Bangkok day', () => {
  const out = conversionReport.parseConversionReportDate('yesterday', { now: FROZEN_NOW });
  assert.equal(out.display, '25/05/2026');
});

test('parseConversionReportDate rejects garbage with conversion_report_time_invalid', () => {
  assert.throws(
    () => conversionReport.parseConversionReportDate('not-a-date'),
    (err) => {
      assert.equal(err.reason, 'conversion_report_time_invalid');
      assert.equal(err.statusCode, 400);
      assert.equal(err.publicPayload.reason, 'conversion_report_time_invalid');
      assert.equal(err.publicPayload.requestedTime, 'not-a-date');
      return true;
    },
  );
});

test('parseConversionReportDate rejects out-of-range day (32/05/2026)', () => {
  assert.throws(
    () => conversionReport.parseConversionReportDate('32/05/2026'),
    (err) => err.reason === 'conversion_report_time_invalid',
  );
});

// ---------------------------------------------------------------------------
// Page num / size clamping
// ---------------------------------------------------------------------------

test('conversionReport.clampPageSize defaults to 20 and clamps above 100', () => {
  assert.equal(conversionReport.clampPageSize(undefined), 20);
  assert.equal(conversionReport.clampPageSize(''), 20);
  assert.equal(conversionReport.clampPageSize('50'), 50);
  assert.equal(conversionReport.clampPageSize(500), 100);
  assert.equal(conversionReport.clampPageSize(-1), 20);
});

test('conversionReport.clampPageNum defaults to 1 and floors at 1', () => {
  assert.equal(conversionReport.clampPageNum(undefined), 1);
  assert.equal(conversionReport.clampPageNum('0'), 1);
  assert.equal(conversionReport.clampPageNum('7'), 7);
});

// ---------------------------------------------------------------------------
// Request resolution + id alias mapping
// ---------------------------------------------------------------------------

test('resolveConversionReportRequest defaults id to 15130770000 (affiliate_chearb.com) when omitted', () => {
  const spec = conversionReport.resolveConversionReportRequest({ time: '25/05/2026' }, { now: FROZEN_NOW });
  assert.equal(spec.id, '15130770000');
  assert.equal(spec.account, 'affiliate_chearb.com');
  assert.equal(spec.accountInternal, 'affiliate_chearb.com');
  assert.equal(spec.displayAccount, 'affiliate@chearb.com');
  assert.equal(spec.time, '25/05/2026');
  assert.equal(spec.isoDate, '2026-05-25');
  assert.equal(spec.page_num, 1);
  assert.equal(spec.page_size, 20);
  assert.equal(spec.range.timezone, 'Asia/Bangkok');
  assert.equal(typeof spec.range.purchase_time_s, 'number');
  assert.equal(typeof spec.range.purchase_time_e, 'number');
});

test('resolveConversionReportRequest maps 15142270000 to affiliate_neezs.com', () => {
  const spec = conversionReport.resolveConversionReportRequest({ id: '15142270000', time: 'yesterday' }, { now: FROZEN_NOW });
  assert.equal(spec.id, '15142270000');
  assert.equal(spec.account, 'affiliate_neezs.com');
  assert.equal(spec.displayAccount, 'affiliate@neezs.com');
  assert.equal(spec.time, '25/05/2026');
});

test('resolveConversionReportRequest accepts an_ prefix for id', () => {
  const spec = conversionReport.resolveConversionReportRequest({ id: 'an_15142270000' }, { now: FROZEN_NOW });
  assert.equal(spec.id, '15142270000');
  assert.equal(spec.account, 'affiliate_neezs.com');
});

test('resolveConversionReportRequest rejects unknown id with safe publicPayload', () => {
  assert.throws(
    () => conversionReport.resolveConversionReportRequest({ id: '999999999999', time: '25/05/2026' }),
    (err) => {
      assert.equal(err.reason, 'shopee_affiliate_id_unknown');
      assert.equal(err.statusCode, 400);
      assert.equal(err.publicPayload.requestedId, '999999999999');
      assert.equal(/cookie|token|password|secret/i.test(JSON.stringify(err.publicPayload)), false);
      return true;
    },
  );
});

test('resolveConversionReportRequest rejects unparseable id with shopee_affiliate_id_invalid', () => {
  assert.throws(
    () => conversionReport.resolveConversionReportRequest({ id: 'not-an-id' }),
    (err) => err.reason === 'shopee_affiliate_id_invalid',
  );
});

test('resolveConversionReportRequest reads page_num and falls back to page when page_num is blank', () => {
  const spec = conversionReport.resolveConversionReportRequest(
    { id: '15130770000', time: '25/05/2026', page_num: '', page: '4', page_size: '5' },
    { now: FROZEN_NOW },
  );
  assert.equal(spec.page_num, 4);
  assert.equal(spec.page_size, 5);
});

test('resolveConversionReportRequest passes through sub_id/order_id/checkout_id/conversion_id/order_status/conversion_status', () => {
  const spec = conversionReport.resolveConversionReportRequest(
    {
      id: '15130770000',
      time: '25/05/2026',
      sub_id: 'yok',
      order_id: 'OID-1',
      checkout_id: 'CKO-1',
      conversion_id: 'CON-1',
      order_status: '',
      conversion_status: 'PAID',
    },
    { now: FROZEN_NOW },
  );
  assert.deepEqual(spec.extras, {
    sub_id: 'yok',
    order_id: 'OID-1',
    checkout_id: 'CKO-1',
    conversion_id: 'CON-1',
    conversion_status: 'PAID',
  });
});

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

test('buildConversionReportFetchUrl targets /api/v3/report/list with purchase_time_s/e, page_num, page_size, version=1, and extras', () => {
  const spec = conversionReport.resolveConversionReportRequest(
    { id: '15142270000', time: '25/05/2026', page_size: '5', sub_id: 'yok', order_id: 'O1' },
    { now: FROZEN_NOW },
  );
  const url = conversionReport.buildConversionReportFetchUrl(spec);
  // Must hit v3 (not v1 — v1 returns 404 text/plain in production).
  assert.match(url, /^https:\/\/affiliate\.shopee\.co\.th\/api\/v3\/report\/list\?/);
  assert.equal(/\/api\/v1\/report\/list/.test(url), false, 'must not target v1');
  assert.match(url, /purchase_time_s=\d+/);
  assert.match(url, /purchase_time_e=\d+/);
  assert.match(url, /page_num=1/);
  assert.match(url, /page_size=5/);
  assert.match(url, /version=1/);
  assert.match(url, /sub_id=yok/);
  assert.match(url, /order_id=O1/);
});

test('SHOPEE_CONVERSION_REPORT_API_BASE is the v3 endpoint', () => {
  assert.equal(
    conversionReport.SHOPEE_CONVERSION_REPORT_API_BASE,
    'https://affiliate.shopee.co.th/api/v3/report/list',
  );
});

// ---------------------------------------------------------------------------
// classifyConversionReportFailure
// ---------------------------------------------------------------------------

test('classifyConversionReportFailure returns shopee_login_required for code 30001', () => {
  assert.equal(conversionReport.classifyConversionReportFailure({ code: 30001 }), 'shopee_login_required');
  assert.equal(conversionReport.classifyConversionReportFailure({ code: '30001' }), 'shopee_login_required');
  assert.equal(conversionReport.classifyConversionReportFailure({ data: { code: 30001 } }), 'shopee_login_required');
});

test('classifyConversionReportFailure returns shopee_login_required for code 30002 (cookie incorrect)', () => {
  assert.equal(conversionReport.classifyConversionReportFailure({ code: 30002 }), 'shopee_login_required');
  assert.equal(conversionReport.classifyConversionReportFailure({ code: '30002' }), 'shopee_login_required');
  assert.equal(conversionReport.classifyConversionReportFailure({ data: { code: 30002 } }), 'shopee_login_required');
  assert.equal(conversionReport.classifyConversionReportFailure({ code: 30002, msg: 'cookie incorrect' }), 'shopee_login_required');
});

test('classifyConversionReportFailure returns null for healthy envelope', () => {
  assert.equal(conversionReport.classifyConversionReportFailure({ data: { total_count: 0, list: [] } }), null);
  assert.equal(conversionReport.classifyConversionReportFailure(null), null);
  assert.equal(conversionReport.classifyConversionReportFailure({ code: 0 }), null);
  // Non-login Shopee error codes must not be misclassified as login failures.
  assert.equal(conversionReport.classifyConversionReportFailure({ code: 99999 }), null);
});

// ---------------------------------------------------------------------------
// isConversionReportHost
// ---------------------------------------------------------------------------

test('isConversionReportHost is disabled for local-only operation', () => {
  assert.equal(conversionReport.isConversionReportHost('conversionreport.wwoom.com'), false);
  assert.equal(conversionReport.isConversionReportHost('conversionreport.wwoom.com:8810'), false);
  assert.equal(conversionReport.isConversionReportHost('ConversionReport.WWoom.com'), false);
});

test('isConversionReportHost rejects other hosts', () => {
  assert.equal(conversionReport.isConversionReportHost(''), false);
  assert.equal(conversionReport.isConversionReportHost('127.0.0.1:8810'), false);
  assert.equal(conversionReport.isConversionReportHost('shopee.co.th'), false);
  assert.equal(conversionReport.isConversionReportHost('clickreport.wwoom.com'), false);
  assert.equal(conversionReport.isConversionReportHost('conversionreport.evil.com'), false);
});

// ---------------------------------------------------------------------------
// isRawConversionReportMode
// ---------------------------------------------------------------------------

test('isRawConversionReportMode accepts raw=1, raw=true, mode=raw; rejects others', () => {
  assert.equal(conversionReport.isRawConversionReportMode({ raw: '1' }), true);
  assert.equal(conversionReport.isRawConversionReportMode({ raw: 'true' }), true);
  assert.equal(conversionReport.isRawConversionReportMode({ raw: 'yes' }), true);
  assert.equal(conversionReport.isRawConversionReportMode({ mode: 'raw' }), true);
  assert.equal(conversionReport.isRawConversionReportMode({ mode: 'RAW' }), true);
  assert.equal(conversionReport.isRawConversionReportMode({}), false);
  assert.equal(conversionReport.isRawConversionReportMode({ raw: '0' }), false);
  assert.equal(conversionReport.isRawConversionReportMode({ mode: 'summary' }), false);
  assert.equal(conversionReport.isRawConversionReportMode(null), false);
});

// ---------------------------------------------------------------------------
// pickRowSubId — utm_content is the live Sub ID field on conversion rows
// ---------------------------------------------------------------------------

test('pickRowSubId reads utm_content as primary Sub ID source (live conversion row shape)', () => {
  assert.equal(conversionReport.pickRowSubId({ utm_content: 'alpha' }), 'alpha');
  assert.equal(conversionReport.pickRowSubId({ utmContent: 'alpha' }), 'alpha');
  // Trims whitespace.
  assert.equal(conversionReport.pickRowSubId({ utm_content: '  trim-me  ' }), 'trim-me');
});

test('pickRowSubId prefers utm_content over sub_id when both are present', () => {
  assert.equal(
    conversionReport.pickRowSubId({ utm_content: 'from-utm', sub_id: 'from-sub' }),
    'from-utm',
  );
});

test('pickRowSubId falls back to sub_id/subId/sub_ids when utm_content is absent or blank', () => {
  assert.equal(conversionReport.pickRowSubId({ sub_id: 'legacy' }), 'legacy');
  assert.equal(conversionReport.pickRowSubId({ subId: 'legacy' }), 'legacy');
  assert.equal(conversionReport.pickRowSubId({ sub_ids: 'legacy' }), 'legacy');
  assert.equal(conversionReport.pickRowSubId({ utm_content: '', sub_id: 'legacy' }), 'legacy');
  assert.equal(conversionReport.pickRowSubId({ utm_content: '   ', sub_id: 'legacy' }), 'legacy');
});

test('pickRowSubId returns empty string for missing/blank/non-object inputs', () => {
  assert.equal(conversionReport.pickRowSubId(null), '');
  assert.equal(conversionReport.pickRowSubId(undefined), '');
  assert.equal(conversionReport.pickRowSubId({}), '');
  assert.equal(conversionReport.pickRowSubId({ utm_content: '' }), '');
  assert.equal(conversionReport.pickRowSubId({ utm_content: null, sub_id: null }), '');
  assert.equal(conversionReport.pickRowSubId('string'), '');
});

// ---------------------------------------------------------------------------
// isPlaceholderSubId — dash-only Sub IDs are non-informative for filtered mode
// ---------------------------------------------------------------------------

test('isPlaceholderSubId treats dash-only Sub IDs (-, ----, etc.) as placeholders', () => {
  // Live Shopee bug: filtering by sub_id="-" or "----" returns the full day's
  // total_count, falsely attributing 100% to a bogus bucket.
  assert.equal(conversionReport.isPlaceholderSubId('-'), true);
  assert.equal(conversionReport.isPlaceholderSubId('--'), true);
  assert.equal(conversionReport.isPlaceholderSubId('----'), true);
  assert.equal(conversionReport.isPlaceholderSubId('--------'), true);
  // Whitespace around a dash-only value still counts as placeholder.
  assert.equal(conversionReport.isPlaceholderSubId('  ----  '), true);
});

test('isPlaceholderSubId treats blank/missing values as placeholders', () => {
  assert.equal(conversionReport.isPlaceholderSubId(''), true);
  assert.equal(conversionReport.isPlaceholderSubId('   '), true);
  assert.equal(conversionReport.isPlaceholderSubId(null), true);
  assert.equal(conversionReport.isPlaceholderSubId(undefined), true);
});

test('isPlaceholderSubId returns false for real Sub IDs (including ones that contain dashes)', () => {
  assert.equal(conversionReport.isPlaceholderSubId('alpha'), false);
  assert.equal(conversionReport.isPlaceholderSubId('16MAY26FBSPCAD----'), false);
  assert.equal(conversionReport.isPlaceholderSubId('-alpha'), false);
  assert.equal(conversionReport.isPlaceholderSubId('alpha-'), false);
  assert.equal(conversionReport.isPlaceholderSubId('a-b-c'), false);
  assert.equal(conversionReport.isPlaceholderSubId('0'), false);
});

// ---------------------------------------------------------------------------
// handleConversionReport with stubbed browser
// ---------------------------------------------------------------------------

function stubBrowserForConversionReport(t, opts = {}) {
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

// Sequenced stub: each getPage() call consumes the next state in `states`
// (currentUrl + evaluateResult), letting a test model "attempt 0 is login-gated,
// attempt 1 succeeds after auto re-auth". The final state repeats once exhausted.
function stubBrowserSequence(t, states) {
  const originalGetPage = browser.getPage;
  const originalEnsureOnPlatformPage = browser.ensureOnPlatformPage;
  const originalIsOnPlatformOrigin = browser.isOnPlatformOrigin;
  const getPageCalls = [];
  const evaluates = [];

  t.after(() => {
    browser.getPage = originalGetPage;
    browser.ensureOnPlatformPage = originalEnsureOnPlatformPage;
    browser.isOnPlatformOrigin = originalIsOnPlatformOrigin;
  });

  browser.getPage = async (platform, account, browserOpts) => {
    const idx = getPageCalls.length;
    const state = states[Math.min(idx, states.length - 1)] || {};
    getPageCalls.push({ platform, account, opts: browserOpts });
    return {
      record: {},
      page: {
        url: () => state.currentUrl || 'https://affiliate.shopee.co.th/',
        goto: async () => {},
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (_fn, args) => {
          evaluates.push({ idx, args });
          if (typeof state.evaluateResult === 'function') return state.evaluateResult(args);
          return state.evaluateResult;
        },
      },
    };
  };
  browser.ensureOnPlatformPage = async () => {};
  browser.isOnPlatformOrigin = (url) => /affiliate\.shopee\.co\.th/i.test(String(url || ''));

  return { getPageCalls, evaluates };
}

function buildOrderRow(idx, subId, purchaseValue = 100, commission = 5) {
  return {
    purchase_time: 1748226000 + idx,
    click_time: 1748225000 + idx,
    checkout_id: 'CKO-' + idx,
    conversion_id: 'CON-' + idx,
    order_sn: 'ORD-' + idx,
    shop_name: 'shop-' + idx,
    item_name: 'item-' + idx,
    sub_id: subId,
    conversion_status: 'PAID',
    purchase_value: purchaseValue,
    actual_commission: commission,
  };
}

test('handleDailyIncomeReport reads Shopee dashboard/detail metrics so totals match dashboard cards', async (t) => {
  const stub = stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: (args) => {
      const url = new URL(args[0]);
      assert.match(url.pathname, /\/api\/v3\/dashboard\/detail$/);
      assert.match(url.searchParams.get('start_time'), /^\d+$/);
      assert.match(url.searchParams.get('end_time'), /^\d+$/);
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            clicks_sum: 45473,
            cv_by_order_sum: 6100,
            item_sold_sum: 10800,
            order_amount_sum: 190000000000,
            est_commission_sum: 323000000,
            est_income_sum: 32300000,
          },
        },
      };
    },
  });

  const result = await conversionReport.handleDailyIncomeReport(
    { id: '15142270000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.report_type, 'daily_income_report');
  assert.equal(result.time, '25/05/2026');
  assert.equal(result.isoDate, '2026-05-25');
  assert.equal(result.account_count, 1);
  assert.equal(result.amount_unit, 'THB');
  assert.equal(result.totals.orders, 6100);
  assert.equal(result.totals.purchase_value, 1900000);
  assert.equal(result.totals.commission, 3230);
  assert.equal(result.accounts[0].id, '15142270000');
  assert.equal(result.accounts[0].mode, 'dashboard_detail');
  assert.equal(result.accounts[0].orders, 6100);
  assert.equal(result.accounts[0].item_sold, 10800);
  assert.equal(result.accounts[0].clicks, 45473);
  assert.equal(result.accounts[0].source_endpoint, '/api/v3/dashboard/detail');
  assert.equal(stub.getPageCalls[0].account, 'affiliate_neezs.com');
  assert.equal(stub.evaluates.length, 1);
});

test('GET /daily-income-report returns dashboard/detail daily income JSON', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          cv_by_order_sum: 1,
          est_commission_sum: 500000,
        },
      },
    },
  });
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const response = await httpRequest(instance, {
    path: '/daily-income-report?id=15130770000&time=25/05/2026',
  });
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.report_type, 'daily_income_report');
  assert.equal(payload.totals.orders, 1);
  assert.equal(payload.totals.commission, 5);
});

test('handleDailyIncomeReport uses dashboard est_commission_sum in THB', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          cv_by_order_sum: 1,
          est_commission_sum: 639000,
        },
      },
    },
  });

  const result = await conversionReport.handleDailyIncomeReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.amount_unit, 'THB');
  assert.equal(result.totals.commission, 6.39);
  assert.equal(result.accounts[0].commission, 6.39);
});

test('handleConversionReport raw mode returns ok payload with total_count, list, affiliate_id from stubbed Shopee response', async (t) => {
  const stub = stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15142270000,
          total_count: 12,
          list: [
            buildOrderRow(1, 'yok', 100, 5),
            buildOrderRow(2, '', 200, 10),
          ],
        },
      },
    },
  });

  const result = await conversionReport.handleConversionReport(
    { id: '15142270000', time: '25/05/2026', page_size: '50', raw: '1' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'raw');
  assert.equal(result.report_type, 'conversion_report');
  assert.equal(result.id, '15142270000');
  assert.equal(result.account, 'affiliate@neezs.com');
  assert.equal(result.accountInternal, 'affiliate_neezs.com');
  assert.equal(result.time, '25/05/2026');
  assert.equal(result.isoDate, '2026-05-25');
  assert.equal(result.range.timezone, 'Asia/Bangkok');
  assert.equal(result.page_num, 1);
  assert.equal(result.page_size, 50);
  assert.equal(result.total_count, 12);
  assert.equal(result.affiliate_id, '15142270000');
  assert.equal(result.list.length, 2);
  assert.equal(result.source, 'shopee_conversion_report_api');
  assert.equal(stub.getPageCalls[0].platform, 'shopee');
  assert.equal(stub.getPageCalls[0].account, 'affiliate_neezs.com');
  assert.deepEqual(stub.getPageCalls[0].opts, { headless: true });
  // Raw fetch URL must hit v3 (v1 returns 404 text/plain in production).
  const apiUrl = stub.evaluates[0][0];
  assert.match(apiUrl, /\/api\/v3\/report\/list\?/);
  assert.equal(/\/api\/v1\/report\/list/.test(apiUrl), false);
  assert.match(apiUrl, /version=1/);
  assert.match(apiUrl, /purchase_time_s=\d+/);
  assert.match(apiUrl, /purchase_time_e=\d+/);
  // Sanity: no leak of secrets.
  assert.equal(/cookie|token|password|secret/i.test(JSON.stringify(result)), false);
});

test('handleConversionReport default summary mode does 1 unfiltered + 2 filtered fetches and reports exact filtered count per discovered sub_id', async (t) => {
  // Day total = 140 (Shopee caps sample at 100 rows). Unfiltered sample contains
  // two sub_ids; filtered API gives the true total per sub_id.
  const buildRows = (count, subId, vpu = 100, cpu = 5) => {
    const rows = [];
    for (let i = 0; i < count; i += 1) rows.push(buildOrderRow(i, subId, vpu, cpu));
    return rows;
  };
  const filteredTotalsBySubId = { alpha: 80, beta: 50 };
  const calls = [];
  const stub = stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: (args) => {
      const apiUrl = args[0];
      const url = new URL(apiUrl);
      const pageNum = Number(url.searchParams.get('page_num'));
      const pageSize = Number(url.searchParams.get('page_size'));
      assert.equal(pageNum, 1, 'every fetch must target page_num=1');
      assert.equal(pageSize, 100, 'summary mode must request page_size=100');
      assert.equal(url.searchParams.get('version'), '1');
      const subId = url.searchParams.get('sub_id');
      calls.push(subId == null ? null : subId);
      if (subId == null) {
        return {
          status: 200,
          parsed: true,
          body: {
            code: 0,
            data: {
              affiliate_id: 15142270000,
              total_count: 140,
              list: [].concat(buildRows(50, 'alpha', 100, 5), buildRows(50, 'beta', 200, 10)),
            },
          },
        };
      }
      const subTotal = filteredTotalsBySubId[subId] || 0;
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            affiliate_id: 15142270000,
            total_count: subTotal,
            list: buildRows(Math.min(subTotal, 100), subId, subId === 'alpha' ? 100 : 200, subId === 'alpha' ? 5 : 10),
          },
        },
      };
    },
  });

  const result = await conversionReport.handleConversionReport(
    { id: '15142270000', time: '25/05/2026', page_size: '50' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.report_type, 'conversion_report');
  assert.equal(result.id, '15142270000');
  assert.equal(result.account, 'affiliate@neezs.com');
  assert.equal(result.time, '25/05/2026');
  assert.equal(result.isoDate, '2026-05-25');
  assert.equal(result.total_count, 140);
  assert.equal(result.page_size, 100);
  assert.equal(stub.evaluates.length, 3);
  assert.equal(result.pages_fetched, 3);
  assert.equal(result.row_sample_count, 100);
  assert.equal(result.discovered_sub_id_count, 2);
  assert.equal(result.unique_sub_id_count, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.breakdown_mode, 'discovered_filtered');
  assert.match(result.warning, /sub_id discovery is based on/);
  assert.deepEqual(calls, [null, 'alpha', 'beta']);
  // Entries report filtered total_count with sample amount fields from filtered calls.
  assert.equal(result.sub_ids.length, 2);
  assert.equal(result.sub_ids[0].sub_id, 'alpha');
  assert.equal(result.sub_ids[0].count, 80);
  assert.equal(result.sub_ids[0].percent, 57.14);
  assert.equal(result.sub_ids[1].sub_id, 'beta');
  assert.equal(result.sub_ids[1].count, 50);
  assert.equal(result.sub_ids[1].percent, 35.71);
  // Sample totals on the unfiltered sample: 50 * 100 + 50 * 200 = 15000 purchase, 50 * 5 + 50 * 10 = 750 commission.
  assert.equal(result.sample_totals.purchase_value, 15000);
  assert.equal(result.sample_totals.commission, 750);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'list'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'page_num'), false);
  assert.equal(/cookie|token|password|secret/i.test(JSON.stringify(result)), false);
});

test('handleConversionReport default summary mode returns conversion_report_sub_count_failed when a filtered sub call hits login error', async (t) => {
  const buildRows = (count, subId) => {
    const rows = [];
    for (let i = 0; i < count; i += 1) rows.push(buildOrderRow(i, subId));
    return rows;
  };
  const calls = [];
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: (args) => {
      const url = new URL(args[0]);
      const subId = url.searchParams.get('sub_id');
      calls.push(subId);
      if (subId == null) {
        return {
          status: 200,
          parsed: true,
          body: {
            code: 0,
            data: {
              affiliate_id: 15142270000,
              total_count: 140,
              list: [].concat(buildRows(50, 'alpha'), buildRows(50, 'beta')),
            },
          },
        };
      }
      if (subId === 'alpha') {
        return { status: 200, parsed: true, body: { code: 0, data: { affiliate_id: 15142270000, total_count: 80, list: [] } } };
      }
      return { status: 200, parsed: true, body: { code: 30001, message: 'Not Login' } };
    },
  });

  const result = await conversionReport.handleConversionReport(
    { id: '15142270000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'error');
  assert.equal(result.mode, 'summary');
  assert.equal(result.reason, 'conversion_report_sub_count_failed');
  assert.equal(result.error, 'conversion_report_sub_count_failed');
  assert.equal(result.failed_sub_id, 'beta');
  assert.equal(result.underlying, 'shopee_login_required');
  assert.equal(result.pages_fetched, 3);
  assert.equal(result.page_size, 100);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'sub_ids'), false);
  assert.deepEqual(calls, [null, 'alpha', 'beta']);
  assert.equal(/cookie|token|password|secret/i.test(JSON.stringify(result)), false);
});

test('handleConversionReport default summary mode stops on first page when list shorter than total_count', async (t) => {
  const stub = stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 3,
          list: [
            buildOrderRow(1, 'yok', 100, 5),
            buildOrderRow(2, 'yok', 50, 2.5),
            buildOrderRow(3, '', 30, 1.5),
          ],
        },
      },
    },
  });
  const result = await conversionReport.handleConversionReport(
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
  // Complete mode aggregates per-sub purchase_value + commission and exposes them.
  assert.equal(result.sub_ids.length, 2);
  const yokEntry = result.sub_ids.find((e) => e.sub_id === 'yok');
  const emptyEntry = result.sub_ids.find((e) => e.sub_id === '');
  assert.equal(yokEntry.count, 2);
  assert.equal(yokEntry.purchase_value, 150);
  assert.equal(yokEntry.commission, 7.5);
  assert.equal(yokEntry.percent, 66.67);
  assert.equal(emptyEntry.count, 1);
  assert.equal(emptyEntry.purchase_value, 30);
  assert.equal(emptyEntry.commission, 1.5);
  assert.equal(emptyEntry.percent, 33.33);
  assert.equal(result.sample_totals.purchase_value, 180);
  assert.equal(result.sample_totals.commission, 9);
  assert.equal(stub.evaluates.length, 1);
});

test('handleConversionReport complete-mode groups by utm_content (live row shape — no row.sub_id present)', async (t) => {
  // Mimic the real Shopee conversion row: utm_content carries the Sub ID and
  // row.sub_id is absent entirely. Grouping must still produce non-empty sub_ids.
  const buildLiveRow = (idx, utmContent, purchaseValue, commission) => ({
    purchase_time: 1748226000 + idx,
    checkout_id: 'CKO-' + idx,
    conversion_status: 'PAID',
    gross_commission: commission,
    estimated_total_commission: commission,
    utm_content: utmContent,
    orders: [],
    click_time: 1748225000 + idx,
    click_id: 'CID-' + idx,
    purchase_value: purchaseValue,
    actual_commission: commission,
  });
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 3,
          list: [
            buildLiveRow(1, '16MAY26FBSPCAD----', 100, 5),
            buildLiveRow(2, '16MAY26FBSPCAD----', 50, 2.5),
            buildLiveRow(3, '17MAY26FBSPCAD----', 30, 1.5),
          ],
        },
      },
    },
  });
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.breakdown_mode, 'complete');
  assert.equal(result.truncated, false);
  assert.equal(result.total_count, 3);
  assert.equal(result.row_sample_count, 3);
  assert.equal(result.unique_sub_id_count, 2);
  assert.equal(result.sub_ids.length, 2);
  const first = result.sub_ids.find((e) => e.sub_id === '16MAY26FBSPCAD----');
  const second = result.sub_ids.find((e) => e.sub_id === '17MAY26FBSPCAD----');
  assert.ok(first, 'first sub_id (from utm_content) must be grouped');
  assert.equal(first.count, 2);
  assert.equal(first.purchase_value, 150);
  assert.equal(first.commission, 7.5);
  assert.ok(second, 'second sub_id (from utm_content) must be grouped');
  assert.equal(second.count, 1);
  // No entries should leak as empty-string when utm_content was populated.
  assert.equal(result.sub_ids.some((e) => e.sub_id === ''), false);
});

test('handleConversionReport summary uses live Shopee affiliate_net_commission as net THB', async (t) => {
  const liveRow = (idx, utmContent, affiliateNetCommission, grossCommission) => ({
    purchase_time: 1781197000 + idx,
    checkout_id: 'LIVE-' + idx,
    conversion_status: 1,
    affiliate_net_commission: String(affiliateNetCommission),
    estimated_total_commission_with_mcn: affiliateNetCommission,
    estimated_total_commission: affiliateNetCommission,
    gross_commission: grossCommission,
    total_brand_commission: affiliateNetCommission - grossCommission,
    mcn_management_fee_commission: '0',
    utm_content: utmContent,
    orders: [],
    click_time: 1781196000 + idx,
    click_id: 'CID-LIVE-' + idx,
  });
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 2,
          list: [
            liveRow(1, '1JUN26FBSPCAD-1266171535687542-1008898512617594--', 5001500, 5000000),
            liveRow(2, '20APR26FBSPCAD----', 153000, 153000),
          ],
        },
      },
    },
  });

  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '11/06/2026' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.breakdown_mode, 'complete');
  assert.equal(result.sample_totals.commission, 51.55);
  const first = result.sub_ids.find((e) => e.sub_id === '1JUN26FBSPCAD-1266171535687542-1008898512617594--');
  assert.ok(first, 'first live sub id must be present');
  assert.equal(first.commission, 50.02);
});

test('handleConversionReport complete-mode keeps empty-sub_id bucket only when row utm_content/sub_id are all blank', async (t) => {
  // Mix of populated utm_content + blank/missing rows. Blank rows form one
  // empty-string bucket (only valid in complete mode — discovery skips empties).
  const liveRow = (idx, utmContent) => ({
    purchase_time: 1748226000 + idx,
    checkout_id: 'CKO-' + idx,
    conversion_status: 'PAID',
    gross_commission: 1,
    estimated_total_commission: 1,
    utm_content: utmContent,
    orders: [],
    click_time: 1748225000 + idx,
    click_id: 'CID-' + idx,
    purchase_value: 10,
    actual_commission: 1,
  });
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 3,
          list: [
            liveRow(1, 'alpha'),
            liveRow(2, ''),
            liveRow(3, null),
          ],
        },
      },
    },
  });
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.breakdown_mode, 'complete');
  assert.equal(result.unique_sub_id_count, 2);
  const alpha = result.sub_ids.find((e) => e.sub_id === 'alpha');
  const empty = result.sub_ids.find((e) => e.sub_id === '');
  assert.ok(alpha);
  assert.equal(alpha.count, 1);
  assert.ok(empty, 'blank utm_content rows must collapse into one empty-sub_id bucket in complete mode');
  assert.equal(empty.count, 2);
});

test('handleConversionReport discovered_filtered mode discovers sub_ids from row.utm_content and skips blank rows from discovery', async (t) => {
  // Day total > sample (forces discovered_filtered). Sample mixes two utm_content
  // values plus a blank-utm_content row. Discovery must call Shopee filtered
  // queries only for the two non-empty discovered sub_ids, in sorted order.
  const liveRow = (idx, utmContent, purchaseValue, commission) => ({
    purchase_time: 1748226000 + idx,
    checkout_id: 'CKO-' + idx,
    conversion_status: 'PAID',
    gross_commission: commission,
    estimated_total_commission: commission,
    utm_content: utmContent,
    orders: [],
    click_time: 1748225000 + idx,
    click_id: 'CID-' + idx,
    purchase_value: purchaseValue,
    actual_commission: commission,
  });
  const buildSample = () => {
    const rows = [];
    for (let i = 0; i < 50; i += 1) rows.push(liveRow(i, 'alpha', 100, 5));
    for (let i = 50; i < 95; i += 1) rows.push(liveRow(i, 'beta', 200, 10));
    // 5 rows with blank utm_content; discovery must skip them.
    for (let i = 95; i < 100; i += 1) rows.push(liveRow(i, '', 50, 2.5));
    return rows;
  };
  const filteredTotalsBySubId = { alpha: 80, beta: 50 };
  const calls = [];
  const stub = stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: (args) => {
      const url = new URL(args[0]);
      assert.equal(url.searchParams.get('page_num'), '1');
      assert.equal(url.searchParams.get('page_size'), '100');
      assert.equal(url.searchParams.get('version'), '1');
      assert.match(url.pathname, /\/api\/v3\/report\/list/);
      const subId = url.searchParams.get('sub_id');
      calls.push(subId);
      if (subId == null) {
        return {
          status: 200,
          parsed: true,
          body: {
            code: 0,
            data: {
              affiliate_id: 15130770000,
              total_count: 140,
              list: buildSample(),
            },
          },
        };
      }
      // Filtered query param remains `sub_id` (proven live).
      const subTotal = filteredTotalsBySubId[subId] || 0;
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            affiliate_id: 15130770000,
            total_count: subTotal,
            list: [liveRow(0, subId, 100, 5)],
          },
        },
      };
    },
  });

  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.breakdown_mode, 'discovered_filtered');
  assert.equal(result.truncated, true);
  assert.equal(result.total_count, 140);
  assert.equal(result.row_sample_count, 100);
  // Discovery skips blank utm_content — only 2 real sub_ids are discovered.
  assert.equal(result.discovered_sub_id_count, 2);
  assert.equal(result.unique_sub_id_count, 2);
  // 1 unfiltered + 2 filtered = 3 fetches. No filtered call for empty string.
  assert.equal(result.pages_fetched, 3);
  assert.equal(stub.evaluates.length, 3);
  assert.deepEqual(calls, [null, 'alpha', 'beta']);
  // Filtered totals from Shopee are trusted; per-entry sub_id is the utm_content value.
  assert.equal(result.sub_ids[0].sub_id, 'alpha');
  assert.equal(result.sub_ids[0].count, 80);
  assert.equal(result.sub_ids[1].sub_id, 'beta');
  assert.equal(result.sub_ids[1].count, 50);
  assert.match(result.warning, /sub_id discovery is based on/);
});

test('handleConversionReport discovered_filtered mode SKIPS dash-only utm_content (-, ----) instead of issuing a bogus filtered call', async (t) => {
  // Live regression: sample contains real Sub IDs ("alpha") alongside Shopee
  // placeholder values "-" and "----" in utm_content. Filtering Shopee by
  // sub_id="-" or "----" returns the full day total_count and would falsely
  // attribute 100% to those buckets. Discovery must skip them entirely.
  const liveRow = (idx, utmContent, purchaseValue, commission) => ({
    purchase_time: 1748226000 + idx,
    checkout_id: 'CKO-' + idx,
    conversion_status: 'PAID',
    gross_commission: commission,
    estimated_total_commission: commission,
    utm_content: utmContent,
    orders: [],
    click_time: 1748225000 + idx,
    click_id: 'CID-' + idx,
    purchase_value: purchaseValue,
    actual_commission: commission,
  });
  const buildSample = () => {
    const rows = [];
    for (let i = 0; i < 60; i += 1) rows.push(liveRow(i, 'alpha', 100, 5));
    for (let i = 60; i < 90; i += 1) rows.push(liveRow(i, '-', 50, 2.5));
    for (let i = 90; i < 100; i += 1) rows.push(liveRow(i, '----', 50, 2.5));
    return rows;
  };
  const calls = [];
  const stub = stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: (args) => {
      const url = new URL(args[0]);
      const subId = url.searchParams.get('sub_id');
      calls.push(subId);
      // Guardrail: if discovery ever issues a placeholder filter call, fail loudly.
      if (subId === '-' || subId === '----' || /^-+$/.test(String(subId || ''))) {
        throw new Error('placeholder sub_id "' + subId + '" must not be sent to Shopee');
      }
      if (subId == null) {
        return {
          status: 200,
          parsed: true,
          body: {
            code: 0,
            data: {
              affiliate_id: 15130770000,
              total_count: 5486,
              list: buildSample(),
            },
          },
        };
      }
      assert.equal(subId, 'alpha');
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            affiliate_id: 15130770000,
            total_count: 4000,
            list: [liveRow(0, 'alpha', 100, 5)],
          },
        },
      };
    },
  });

  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.breakdown_mode, 'discovered_filtered');
  assert.equal(result.truncated, true);
  assert.equal(result.total_count, 5486);
  assert.equal(result.row_sample_count, 100);
  // Only 'alpha' is informative; '-' and '----' are placeholders and must be
  // excluded from both discovery and the filtered-call sequence.
  assert.equal(result.discovered_sub_id_count, 1, 'placeholders must not count toward discovery');
  assert.equal(result.unique_sub_id_count, 1);
  // 1 unfiltered + 1 filtered (alpha only). No filtered call for '-' or '----'.
  assert.equal(result.pages_fetched, 2);
  assert.equal(stub.evaluates.length, 2);
  assert.deepEqual(calls, [null, 'alpha']);
  // No bogus 100% entries from '-' or '----'.
  assert.equal(result.sub_ids.length, 1);
  assert.equal(result.sub_ids[0].sub_id, 'alpha');
  assert.equal(result.sub_ids[0].count, 4000);
  assert.equal(result.sub_ids.some((e) => /^-+$/.test(String(e.sub_id))), false);
});

test('handleConversionReport discovered_filtered mode reports no sub_ids when the entire sample is placeholders', async (t) => {
  // Edge case: sample has only "-" and "----" utm_content. Discovery must skip
  // both, leaving zero discovered sub_ids and zero filtered calls.
  const liveRow = (idx, utmContent) => ({
    purchase_time: 1748226000 + idx,
    checkout_id: 'CKO-' + idx,
    conversion_status: 'PAID',
    gross_commission: 1,
    estimated_total_commission: 1,
    utm_content: utmContent,
    orders: [],
    click_time: 1748225000 + idx,
    click_id: 'CID-' + idx,
    purchase_value: 10,
    actual_commission: 1,
  });
  const buildSample = () => {
    const rows = [];
    for (let i = 0; i < 70; i += 1) rows.push(liveRow(i, '-'));
    for (let i = 70; i < 100; i += 1) rows.push(liveRow(i, '----'));
    return rows;
  };
  const calls = [];
  const stub = stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: (args) => {
      const url = new URL(args[0]);
      const subId = url.searchParams.get('sub_id');
      calls.push(subId);
      if (subId != null) {
        throw new Error('no filtered call should be issued when only placeholders are sampled');
      }
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            affiliate_id: 15130770000,
            total_count: 5486,
            list: buildSample(),
          },
        },
      };
    },
  });
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.breakdown_mode, 'discovered_filtered');
  assert.equal(result.truncated, true);
  assert.equal(result.discovered_sub_id_count, 0);
  assert.equal(result.unique_sub_id_count, 0);
  assert.equal(result.pages_fetched, 1);
  assert.equal(stub.evaluates.length, 1);
  assert.deepEqual(calls, [null]);
  assert.deepEqual(result.sub_ids, []);
});

test('handleConversionReport complete mode keeps dash-only Sub IDs as honest buckets (no filtered call needed)', async (t) => {
  // Complete-mode aggregation is honest: if rows really say utm_content="-",
  // that bucket appears in the breakdown. The placeholder guard only applies
  // to discovered_filtered mode (where filtering by "-" would be a bug).
  const liveRow = (idx, utmContent, purchaseValue, commission) => ({
    purchase_time: 1748226000 + idx,
    checkout_id: 'CKO-' + idx,
    conversion_status: 'PAID',
    gross_commission: commission,
    estimated_total_commission: commission,
    utm_content: utmContent,
    orders: [],
    click_time: 1748225000 + idx,
    click_id: 'CID-' + idx,
    purchase_value: purchaseValue,
    actual_commission: commission,
  });
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 4,
          list: [
            liveRow(1, 'alpha', 100, 5),
            liveRow(2, '-', 50, 2.5),
            liveRow(3, '----', 30, 1.5),
            liveRow(4, '----', 70, 3.5),
          ],
        },
      },
    },
  });
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.breakdown_mode, 'complete');
  assert.equal(result.truncated, false);
  assert.equal(result.unique_sub_id_count, 3);
  const dash = result.sub_ids.find((e) => e.sub_id === '-');
  const dashes = result.sub_ids.find((e) => e.sub_id === '----');
  const alpha = result.sub_ids.find((e) => e.sub_id === 'alpha');
  assert.ok(dash);
  assert.equal(dash.count, 1);
  assert.ok(dashes);
  assert.equal(dashes.count, 2);
  assert.ok(alpha);
  assert.equal(alpha.count, 1);
});

test('handleConversionReport summary mode honors sub_id filter passthrough', async (t) => {
  const stub = stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: (args) => {
      const apiUrl = args[0];
      const url = new URL(apiUrl);
      assert.equal(url.searchParams.get('sub_id'), '16MAY26FBSPCAD');
      assert.equal(url.searchParams.get('page_size'), '100');
      assert.equal(url.searchParams.get('page_num'), '1');
      assert.equal(url.searchParams.get('version'), '1');
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            affiliate_id: 15130770000,
            total_count: 2,
            list: [
              buildOrderRow(1, '16MAY26FBSPCAD----', 250, 12.5),
              buildOrderRow(2, '16MAY26FBSPCAD----', 250, 12.5),
            ],
          },
        },
      };
    },
  });
  const result = await conversionReport.handleConversionReport(
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
  assert.equal(result.sub_ids.length, 1);
  assert.equal(result.sub_ids[0].sub_id, '16MAY26FBSPCAD----');
  assert.equal(result.sub_ids[0].requested_sub_id, '16MAY26FBSPCAD');
  assert.equal(result.sub_ids[0].count, 2);
  assert.equal(result.sub_ids[0].percent, 100);
  assert.equal(result.sample_totals.purchase_value, 500);
  assert.equal(result.sample_totals.commission, 25);
  assert.equal(stub.evaluates.length, 1);
});

test('handleConversionReport summary mode propagates manual_login_required from first page', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: { status: 200, parsed: true, body: { code: 30001, message: 'Not Login' } },
  });
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.mode, 'summary');
  assert.equal(result.reason, 'shopee_login_required');
  assert.equal(result.loginUi, '/login?platform=shopee');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'list'), false);
});

test('handleConversionReport returns manual_login_required when Shopee responds with code 30001', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: { code: 30001, message: 'Not Login' },
    },
  });

  const result = await conversionReport.handleConversionReport(
    { id: '15142270000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.reason, 'shopee_login_required');
  assert.equal(result.manualLoginRequired, true);
  assert.equal(result.loginUi, '/login?platform=shopee');
  assert.equal(result.account, 'affiliate@neezs.com');
});

test('handleConversionReport returns manual_login_required when Shopee responds with code 30002 (cookie incorrect)', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: { code: 30002, msg: 'cookie incorrect' },
    },
  });

  const result = await conversionReport.handleConversionReport(
    { id: '15142270000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.mode, 'summary');
  assert.equal(result.reason, 'shopee_login_required');
  assert.equal(result.manualLoginRequired, true);
  assert.equal(result.loginUi, '/login?platform=shopee');
  // Must not leak a redirect URL (raw Shopee login URL, "next" param, or buyer/login path) into the JSON.
  const serialized = JSON.stringify(result);
  assert.equal(/shopee\.co\.th\/buyer\/login/i.test(serialized), false);
  assert.equal(/affiliate\.shopee\.co\.th\/login/i.test(serialized), false);
  assert.equal(/cookie|token|password|secret/i.test(serialized), false);
});

test('handleConversionReport code 30002 in raw mode also yields manual_login_required without leaking redirect URL', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: { code: 30002, msg: 'cookie incorrect' },
    },
  });
  const result = await conversionReport.handleConversionReport(
    { id: '15142270000', time: '25/05/2026', raw: '1' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.mode, 'raw');
  assert.equal(result.reason, 'shopee_login_required');
  const serialized = JSON.stringify(result);
  assert.equal(/shopee\.co\.th\/buyer\/login/i.test(serialized), false);
  assert.equal(/affiliate\.shopee\.co\.th\/login/i.test(serialized), false);
});

test('handleConversionReport returns manual_login_required on HTTP 401 without leaking detail', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: { status: 401, parsed: false, snippet: 'unauthorized' },
  });
  const result = await conversionReport.handleConversionReport({ id: '15130770000' }, { now: FROZEN_NOW });
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.reason, 'shopee_unauthorized');
  assert.equal(result.httpStatus, 401);
});

test('handleConversionReport returns manual_login_required when page is redirected to buyer login (and does not leak the buyer-login URL)', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2F',
    evaluateResult: { status: 200, parsed: true, body: { code: 0 } },
  });
  const result = await conversionReport.handleConversionReport({ id: '15130770000' }, { now: FROZEN_NOW });
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.reason, 'shopee_login_required');
  // Local UI hint is allowed; the raw Shopee redirect URL must not appear in the JSON.
  assert.equal(result.loginUi, '/login?platform=shopee');
  const serialized = JSON.stringify(result);
  assert.equal(/shopee\.co\.th\/buyer\/login/i.test(serialized), false);
  assert.equal(/next=/i.test(serialized), false);
});

test('handleConversionReport reports conversion_report_fetch_failed on evaluate throw', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: () => { throw new Error('Failed to fetch'); },
  });
  const result = await conversionReport.handleConversionReport({ id: '15130770000' }, { now: FROZEN_NOW });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'conversion_report_fetch_failed');
  assert.match(result.detail, /Failed to fetch/);
});

// ---------------------------------------------------------------------------
// Auto re-auth before manual_login_required
// ---------------------------------------------------------------------------

test('handleConversionReport auto re-auths on off-origin redirect then retries successfully', async (t) => {
  const stub = stubBrowserSequence(t, [
    // attempt 0: bounced to buyer login -> off affiliate origin
    {
      currentUrl: 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2F',
      evaluateResult: { status: 200, parsed: true, body: { code: 0, data: { total_count: 0, list: [] } } },
    },
    // attempt 1 (after successful re-auth): authenticated, real data
    {
      currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
      evaluateResult: {
        status: 200,
        parsed: true,
        body: { code: 0, data: { total_count: 1, list: [buildOrderRow(1, 'sub-a')] } },
      },
    },
  ]);
  const reauthCalls = [];
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    {
      now: FROZEN_NOW,
      onSessionExpired: async (info) => { reauthCalls.push(info); return { ok: true, manualLoginRequired: false }; },
    },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'summary');
  assert.equal(result.total_count, 1);
  assert.equal(reauthCalls.length, 1);
  assert.equal(reauthCalls[0].platform, 'shopee');
  assert.equal(reauthCalls[0].account, 'affiliate_chearb.com');
  assert.equal(stub.getPageCalls.length, 2);
  // First fetch attempt should not have leaked since it was off-origin.
  assert.equal(result.autoReauthAttempted, undefined);
});

test('handleConversionReport auto re-auths on Shopee code 30001 then retries the fetch', async (t) => {
  const stub = stubBrowserSequence(t, [
    {
      currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
      evaluateResult: { status: 200, parsed: true, body: { code: 30001, message: 'Not Login' } },
    },
    {
      currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
      evaluateResult: {
        status: 200,
        parsed: true,
        body: { code: 0, data: { total_count: 2, list: [buildOrderRow(1, 'sub-a'), buildOrderRow(2, 'sub-a')] } },
      },
    },
  ]);
  let reauthCount = 0;
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW, onSessionExpired: async () => { reauthCount += 1; return { ok: true }; } },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.total_count, 2);
  assert.equal(reauthCount, 1);
  assert.equal(stub.getPageCalls.length, 2);
});

test('handleConversionReport returns manual_login_required when auto re-auth hits a captcha blocker', async (t) => {
  const stub = stubBrowserSequence(t, [
    {
      currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
      evaluateResult: { status: 200, parsed: true, body: { code: 30001, message: 'Not Login' } },
    },
  ]);
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    {
      now: FROZEN_NOW,
      onSessionExpired: async () => ({ ok: false, manualLoginRequired: true, reason: 'captcha_required' }),
    },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.reason, 'shopee_login_required');
  assert.equal(result.loginUi, '/login?platform=shopee');
  assert.equal(result.autoReauthAttempted, true);
  assert.equal(result.autoReauthReason, 'captcha_required');
  // Only one fetch attempt because re-auth failed (no retry).
  assert.equal(stub.getPageCalls.length, 1);
  // No secret leakage.
  const serialized = JSON.stringify(result);
  assert.equal(/password|cookie|token|secret/i.test(serialized), false);
});

test('handleConversionReport surfaces keychain-missing diagnostic when auto re-auth has no credential', async (t) => {
  stubBrowserSequence(t, [
    {
      currentUrl: 'https://shopee.co.th/buyer/login',
      evaluateResult: { status: 200, parsed: true, body: { code: 0 } },
    },
  ]);
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    {
      now: FROZEN_NOW,
      onSessionExpired: async () => ({ ok: false, manualLoginRequired: true, reason: 'keychain_credential_not_found' }),
    },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.autoReauthAttempted, true);
  assert.equal(result.autoReauthReason, 'keychain_credential_not_found');
});

test('handleConversionReport without a re-auth hook keeps legacy manual_login_required (no retry)', async (t) => {
  const stub = stubBrowserSequence(t, [
    {
      currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
      evaluateResult: { status: 200, parsed: true, body: { code: 30001, message: 'Not Login' } },
    },
  ]);
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.reason, 'shopee_login_required');
  assert.equal(result.autoReauthAttempted, undefined);
  assert.equal(stub.getPageCalls.length, 1);
});

test('handleConversionReport only retries once when re-auth succeeds but session is still gated', async (t) => {
  const stub = stubBrowserSequence(t, [
    {
      currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
      evaluateResult: { status: 200, parsed: true, body: { code: 30001, message: 'Not Login' } },
    },
    {
      currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
      evaluateResult: { status: 200, parsed: true, body: { code: 30001, message: 'Not Login' } },
    },
  ]);
  let reauthCount = 0;
  const result = await conversionReport.handleConversionReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW, onSessionExpired: async () => { reauthCount += 1; return { ok: true }; } },
  );
  assert.equal(result.status, 'manual_login_required');
  assert.equal(result.autoReauthAttempted, true);
  assert.equal(reauthCount, 1);
  // Exactly two fetch attempts (original + single retry), no infinite loop.
  assert.equal(stub.getPageCalls.length, 2);
});

test('handleDailyIncomeReport auto re-auths per account before manual_login_required', async (t) => {
  const stub = stubBrowserSequence(t, [
    // attempt 0: off-origin login redirect
    {
      currentUrl: 'https://shopee.co.th/buyer/login',
      evaluateResult: { status: 200, parsed: true, body: { code: 0, data: {} } },
    },
    // attempt 1: authenticated dashboard detail
    {
      currentUrl: 'https://affiliate.shopee.co.th/dashboard',
      evaluateResult: {
        status: 200,
        parsed: true,
        body: { code: 0, data: { cv_by_order_sum: 3, est_commission_sum: 500000, order_amount_sum: 100000000 } },
      },
    },
  ]);
  let reauthCount = 0;
  const result = await conversionReport.handleDailyIncomeReport(
    { id: '15130770000', time: '25/05/2026' },
    { now: FROZEN_NOW, onSessionExpired: async () => { reauthCount += 1; return { ok: true }; } },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.accounts[0].status, 'ok');
  assert.equal(result.accounts[0].orders, 3);
  assert.equal(reauthCount, 1);
  assert.equal(stub.getPageCalls.length, 2);
});

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

test('GET /conversion-report returns shopee_affiliate_id_unknown JSON for unmapped id (no browser call)', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called for an unknown id');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, { path: '/conversion-report?id=999999999999&time=25/05/2026' });
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.reason, 'shopee_affiliate_id_unknown');
  assert.equal(parsed.requestedId, '999999999999');
  assert.equal(getPageCalls.length, 0);
});

test('GET /conversion-report returns conversion_report_time_invalid JSON for garbage time without opening a browser', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called for an invalid time');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, { path: '/conversion-report?id=15130770000&time=not-a-date' });
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.reason, 'conversion_report_time_invalid');
  assert.equal(getPageCalls.length, 0);
});

test('GET /conversion-report returns summary by default in local-only mode', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 3,
          list: [
            buildOrderRow(1, 'yok', 100, 5),
            buildOrderRow(2, 'yok', 50, 2.5),
            buildOrderRow(3, '', 30, 1.5),
          ],
        },
      },
    },
  });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    path: '/conversion-report?time=25/05/2026',
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /application\/json/);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.mode, 'summary');
  assert.equal(parsed.report_type, 'conversion_report');
  assert.equal(parsed.id, '15130770000');
  assert.equal(parsed.account, 'affiliate@chearb.com');
  assert.equal(parsed.total_count, 3);
  assert.equal(parsed.unique_sub_id_count, 2);
  assert.equal(parsed.page_size, 100);
  assert.equal(parsed.pages_fetched, 1);
  assert.equal(parsed.row_sample_count, 3);
  assert.equal(parsed.breakdown_mode, 'complete');
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.source, 'shopee_conversion_report_api');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'list'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'warning'), false);
});

test('GET /conversion-report?raw=1 preserves single-page list response', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/report/conversion_report',
    evaluateResult: {
      status: 200,
      parsed: true,
      body: {
        code: 0,
        data: {
          affiliate_id: 15130770000,
          total_count: 9,
          list: [
            buildOrderRow(1, 'yok', 100, 5),
          ],
        },
      },
    },
  });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    path: '/conversion-report?id=15130770000&time=25/05/2026&raw=1&page_size=5&page_num=2',
  });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.mode, 'raw');
  assert.equal(parsed.report_type, 'conversion_report');
  assert.equal(parsed.total_count, 9);
  assert.equal(parsed.page_num, 2);
  assert.equal(parsed.page_size, 5);
  assert.equal(Array.isArray(parsed.list), true);
  assert.equal(parsed.list.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'sub_ids'), false);
});

test('GET /click-report stays separate from conversion-report in local-only mode', async (t) => {
  stubBrowserForConversionReport(t, {
    currentUrl: 'https://affiliate.shopee.co.th/dashboard',
    evaluateResult: (args) => {
      const url = new URL(args[0]);
      // If we get here, we should be hitting the click_report API, not the conversion report API.
      assert.match(url.pathname, /\/api\/v1\/click_report\/list/);
      return {
        status: 200,
        parsed: true,
        body: {
          code: 0,
          data: {
            affiliate_id: 15130770000,
            total_count: 0,
            list: [],
          },
        },
      };
    },
  });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    path: '/click-report?time=25/05/2026',
  });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  // click-report response shape: no report_type field.
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'report_type'), false);
  assert.equal(parsed.source, 'shopee_click_report_api');
});

test('GET / on default Host still serves the shortlink index HTML (no regression)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, { path: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/);
  assert.match(res.body, /Affiliate Shortlink Cloak Bridge/);
});

test('POST /conversion-report returns 405 (only GET is allowed)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));
  const res = await httpRequest(instance, { method: 'POST', path: '/conversion-report' });
  assert.equal(res.statusCode, 405);
  assert.match(String(res.headers['allow'] || ''), /GET/);
});
