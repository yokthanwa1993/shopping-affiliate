'use strict';

const browser = require('./browser');
const { sanitizeAccount } = require('./accounts');
const {
  normalizeShopeeAffiliateId,
  resolveShopeeAccountMetadataFromId,
} = require('./shopee-accounts');

const SHOPEE_CONVERSION_REPORT_API_BASE = 'https://affiliate.shopee.co.th/api/v3/report/list';
const SHOPEE_CONVERSION_REPORT_HOST_PATTERN = /^conversionreport\.wwoom\.com$/i;
const SHOPEE_CONVERSION_REPORT_PAGE_SIZE_DEFAULT = 20;
const SHOPEE_CONVERSION_REPORT_PAGE_SIZE_MAX = 100;
const SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE = 100;
const SHOPEE_CONVERSION_REPORT_DEFAULT_ID = '15130770000';
const SHOPEE_CONVERSION_REPORT_API_VERSION = '1';
const BANGKOK_TIMEZONE = 'Asia/Bangkok';
const BANGKOK_UTC_OFFSET_SECONDS = 7 * 3600;
const CONVERSION_REPORT_EXTRA_KEYS = [
  'sub_id',
  'order_id',
  'checkout_id',
  'conversion_id',
  'order_status',
  'conversion_status',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function currentBangkokDate(now) {
  const ms = (now instanceof Date ? now.getTime() : Date.now()) + BANGKOK_UTC_OFFSET_SECONDS * 1000;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function dateToUnixSecondsBangkok(year, month, day, hour, minute, second) {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.floor(ms / 1000) - BANGKOK_UTC_OFFSET_SECONDS;
}

function isValidYMD(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1970 || y > 9999) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y
    && probe.getUTCMonth() + 1 === m
    && probe.getUTCDate() === d
  );
}

function conversionReportDateError(raw) {
  const safe = String(raw == null ? '' : raw).slice(0, 64);
  const err = new Error('Invalid time parameter: ' + safe);
  err.reason = 'conversion_report_time_invalid';
  err.statusCode = 400;
  err.publicPayload = {
    status: 'error',
    error: 'conversion_report_time_invalid',
    reason: 'conversion_report_time_invalid',
    message: 'Invalid time parameter. Accepted formats: DD/MM/YYYY, YYYY-MM-DD, today, yesterday.',
    requestedTime: safe,
  };
  return err;
}

function parseConversionReportDate(input, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const raw = String(input == null ? '' : input).trim();
  let y;
  let m;
  let d;
  if (!raw || raw.toLowerCase() === 'today') {
    ({ year: y, month: m, day: d } = currentBangkokDate(now));
  } else if (raw.toLowerCase() === 'yesterday') {
    const shifted = new Date(now.getTime() - 86400 * 1000);
    ({ year: y, month: m, day: d } = currentBangkokDate(shifted));
  } else {
    const ddmm = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (ddmm) {
      d = Number(ddmm[1]);
      m = Number(ddmm[2]);
      y = Number(ddmm[3]);
    } else if (iso) {
      y = Number(iso[1]);
      m = Number(iso[2]);
      d = Number(iso[3]);
    } else {
      throw conversionReportDateError(raw);
    }
    if (!isValidYMD(y, m, d)) {
      throw conversionReportDateError(raw);
    }
  }
  return {
    year: y,
    month: m,
    day: d,
    display: pad2(d) + '/' + pad2(m) + '/' + y,
    isoDate: y + '-' + pad2(m) + '-' + pad2(d),
    timezone: BANGKOK_TIMEZONE,
    purchase_time_s: dateToUnixSecondsBangkok(y, m, d, 0, 0, 0),
    purchase_time_e: dateToUnixSecondsBangkok(y, m, d, 23, 59, 59),
  };
}

function parseInteger(value, fallback) {
  const str = String(value == null ? '' : value).trim();
  if (!str) return fallback;
  const n = Number(str);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function clampPageNum(value) {
  const n = parseInteger(value, 1);
  return n < 1 ? 1 : n;
}

function clampPageSize(value) {
  const n = parseInteger(value, SHOPEE_CONVERSION_REPORT_PAGE_SIZE_DEFAULT);
  if (n < 1) return SHOPEE_CONVERSION_REPORT_PAGE_SIZE_DEFAULT;
  if (n > SHOPEE_CONVERSION_REPORT_PAGE_SIZE_MAX) return SHOPEE_CONVERSION_REPORT_PAGE_SIZE_MAX;
  return n;
}

function sanitizeExtraValue(value) {
  return String(value == null ? '' : value).trim().slice(0, 200);
}

function safePassthroughExtras(query) {
  const out = {};
  if (!query || typeof query !== 'object') return out;
  for (const key of CONVERSION_REPORT_EXTRA_KEYS) {
    const v = sanitizeExtraValue(query[key]);
    if (v) out[key] = v;
  }
  return out;
}

function isTruthyFlag(value) {
  if (value === true) return true;
  const str = String(value == null ? '' : value).trim().toLowerCase();
  return str === '1' || str === 'true' || str === 'yes' || str === 'on';
}

function isRawConversionReportMode(query) {
  if (!query || typeof query !== 'object') return false;
  if (isTruthyFlag(query.raw)) return true;
  const mode = String(query.mode == null ? '' : query.mode).trim().toLowerCase();
  return mode === 'raw';
}

function conversionReportIdError(reason, message, requestedId) {
  const err = new Error(message);
  err.reason = reason;
  err.statusCode = 400;
  err.publicPayload = {
    status: 'error',
    error: reason,
    reason,
    message,
  };
  if (requestedId) err.publicPayload.requestedId = String(requestedId).slice(0, 64);
  return err;
}

function resolveConversionReportRequest(query = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const rawId = String(query.id == null ? '' : query.id).trim();
  const idCandidate = rawId || SHOPEE_CONVERSION_REPORT_DEFAULT_ID;
  const normalizedId = normalizeShopeeAffiliateId(idCandidate);
  if (!normalizedId) {
    throw conversionReportIdError(
      'shopee_affiliate_id_invalid',
      'Invalid Shopee affiliate id',
      idCandidate,
    );
  }
  const meta = resolveShopeeAccountMetadataFromId(normalizedId);
  if (!meta || !meta.account) {
    throw conversionReportIdError(
      'shopee_affiliate_id_unknown',
      'Unknown Shopee affiliate id: ' + normalizedId,
      normalizedId,
    );
  }
  const accountInternal = String(meta.account);
  const account = sanitizeAccount(accountInternal);
  const displayAccount = String(meta.displayAccount || accountInternal).trim() || accountInternal;
  const parsedTime = parseConversionReportDate(query.time, { now });
  const pageNumSource = query.page_num != null && String(query.page_num).trim() !== ''
    ? query.page_num
    : query.page;
  const page_num = clampPageNum(pageNumSource);
  const page_size = clampPageSize(query.page_size);
  const extras = safePassthroughExtras(query);
  return {
    id: normalizedId,
    account,
    accountInternal,
    displayAccount,
    time: parsedTime.display,
    isoDate: parsedTime.isoDate,
    range: {
      timezone: parsedTime.timezone,
      purchase_time_s: parsedTime.purchase_time_s,
      purchase_time_e: parsedTime.purchase_time_e,
    },
    page_num,
    page_size,
    extras,
  };
}

function buildConversionReportFetchUrl(spec) {
  const params = new URLSearchParams();
  params.set('purchase_time_s', String(spec.range.purchase_time_s));
  params.set('purchase_time_e', String(spec.range.purchase_time_e));
  params.set('page_num', String(spec.page_num));
  params.set('page_size', String(spec.page_size));
  params.set('version', SHOPEE_CONVERSION_REPORT_API_VERSION);
  const extras = spec.extras && typeof spec.extras === 'object' ? spec.extras : {};
  for (const key of CONVERSION_REPORT_EXTRA_KEYS) {
    const value = extras[key];
    if (value) params.set(key, String(value));
  }
  return SHOPEE_CONVERSION_REPORT_API_BASE + '?' + params.toString();
}

const CONVERSION_REPORT_FETCH_SCRIPT = `async ([apiUrl]) => {
  const resp = await fetch(apiUrl, {
    method: 'GET',
    credentials: 'include',
    headers: { 'accept': 'application/json' },
  });
  const status = resp.status;
  const text = await resp.text();
  let parsed = false;
  let body = null;
  try { body = JSON.parse(text); parsed = true; } catch (e) { parsed = false; }
  return { status, parsed, body, snippet: parsed ? '' : String(text || '').slice(0, 200) };
}`;

function isShopeeLoginCode(code) {
  if (code == null) return false;
  const n = Number(code);
  if (!Number.isFinite(n)) return false;
  // 30001 = "not login"; 30002 = "cookie incorrect" — both require manual login.
  return n === 30001 || n === 30002;
}

function classifyConversionReportFailure(body) {
  if (!body || typeof body !== 'object') return null;
  const code = body.code != null ? body.code : (body.data && body.data.code);
  if (isShopeeLoginCode(code)) return 'shopee_login_required';
  return null;
}

function isLoginRedirectUrl(currentUrl) {
  const value = String(currentUrl || '');
  if (!value) return false;
  return /shopee\.co\.th\/buyer\/login|affiliate\.shopee\.co\.th\/login/i.test(value);
}

function sanitizeDetail(text) {
  return String(text == null ? '' : text)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

function pickTotalCount(body) {
  if (!body || typeof body !== 'object') return 0;
  const data = body.data && typeof body.data === 'object' ? body.data : null;
  const candidates = [
    data ? data.total_count : null,
    data ? data.total : null,
    body.total_count,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickList(body) {
  if (!body || typeof body !== 'object') return [];
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.conversion_report_list)) return data.conversion_report_list;
  if (Array.isArray(data.conversion_list)) return data.conversion_list;
  if (Array.isArray(data.order_list)) return data.order_list;
  if (Array.isArray(data.report_list)) return data.report_list;
  if (Array.isArray(body.list)) return body.list;
  return [];
}

function pickAffiliateId(body) {
  if (!body || typeof body !== 'object') return null;
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const candidate = data.affiliate_id != null ? data.affiliate_id
    : (data.affiliateId != null ? data.affiliateId
      : (body.affiliate_id != null ? body.affiliate_id : null));
  if (candidate == null) return null;
  return String(candidate);
}

function pickNumber(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pickRowPurchaseValue(row) {
  if (!row || typeof row !== 'object') return 0;
  const candidates = [
    row.purchase_value,
    row.purchaseValue,
    row.total_payable_amount,
    row.totalPayableAmount,
    row.order_amount,
    row.gmv,
  ];
  for (const candidate of candidates) {
    if (candidate != null && candidate !== '') return pickNumber(candidate);
  }
  return 0;
}

// Shopee renders missing utm_content as one of several dash placeholders
// (e.g. "-", "----"). Filtering by these values returns the whole day's
// total_count, which would falsely attribute 100% to a bogus bucket. Skip them
// in discovered_filtered mode. Complete mode still keeps them as honest buckets.
function isPlaceholderSubId(subId) {
  if (subId == null) return true;
  const s = String(subId).trim();
  if (!s) return true;
  return /^-+$/.test(s);
}

function pickRowSubId(row) {
  if (!row || typeof row !== 'object') return '';
  // Live Shopee conversion rows expose Sub ID as `utm_content`; legacy/variant
  // names fall back in order. Filtered query param stays `sub_id` (proven live).
  const candidates = [
    row.utm_content,
    row.utmContent,
    row.sub_id,
    row.subId,
    row.sub_ids,
    row.subIds,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const str = String(candidate).trim();
    if (str) return str;
  }
  return '';
}

function pickRowCommission(row) {
  if (!row || typeof row !== 'object') return 0;
  const candidates = [
    row.actual_commission,
    row.actualCommission,
    row.commission,
    row.gross_commission,
    row.grossCommission,
    row.commission_amount,
  ];
  for (const candidate of candidates) {
    if (candidate != null && candidate !== '') return pickNumber(candidate);
  }
  return 0;
}

function pickRowEstimatedCommissionBaht(row) {
  if (!row || typeof row !== 'object') return 0;
  const candidates = [
    row.estimated_total_commission,
    row.estimatedTotalCommission,
    row.estimated_total_commission_with_mcn,
    row.estimatedTotalCommissionWithMcn,
    row.affiliate_net_commission,
    row.affiliateNetCommission,
  ];
  for (const candidate of candidates) {
    if (candidate != null && candidate !== '') return pickNumber(candidate) / 100000;
  }
  return pickRowCommission(row);
}

function summarizeDailyIncomeRowAmounts(rows) {
  let purchaseValue = 0;
  let commission = 0;
  for (const row of rows) {
    purchaseValue += pickRowPurchaseValue(row);
    commission += pickRowEstimatedCommissionBaht(row);
  }
  return {
    purchase_value: roundTo2(purchaseValue),
    commission: roundTo2(commission),
  };
}

function roundTo2(value) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function baseResponseShape(spec) {
  return {
    report_type: 'conversion_report',
    id: spec.id,
    account: spec.displayAccount,
    accountInternal: spec.accountInternal,
    time: spec.time,
    isoDate: spec.isoDate,
    range: spec.range,
    page_num: spec.page_num,
    page_size: spec.page_size,
    source: 'shopee_conversion_report_api',
  };
}

function classifyConversionReportFetchResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      status: 'error',
      error: 'conversion_report_empty_response',
      reason: 'conversion_report_empty_response',
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      status: 'manual_login_required',
      error: 'manual_login_required',
      manualLoginRequired: true,
      needsManual: true,
      reason: 'shopee_unauthorized',
      httpStatus: result.status,
      loginUi: '/login?platform=shopee',
    };
  }
  if (!result.parsed) {
    return {
      status: 'error',
      error: 'conversion_report_invalid_json',
      reason: 'conversion_report_invalid_json',
      httpStatus: result.status,
    };
  }
  const loginReason = classifyConversionReportFailure(result.body);
  if (loginReason) {
    return {
      status: 'manual_login_required',
      error: 'manual_login_required',
      manualLoginRequired: true,
      needsManual: true,
      reason: loginReason,
      loginUi: '/login?platform=shopee',
    };
  }
  return null;
}

async function fetchConversionReportPageOnce(page, apiUrl) {
  return page.evaluate(
    new Function('args', 'return (' + CONVERSION_REPORT_FETCH_SCRIPT + ')(args);'),
    [apiUrl],
  );
}

function summaryResponseShape(spec) {
  return {
    status: 'ok',
    report_type: 'conversion_report',
    mode: 'summary',
    id: spec.id,
    account: spec.displayAccount,
    accountInternal: spec.accountInternal,
    time: spec.time,
    isoDate: spec.isoDate,
    range: spec.range,
    source: 'shopee_conversion_report_api',
  };
}

function parseDailyIncomeIds(query = {}) {
  const raw = String(
    query.ids != null && String(query.ids).trim() !== ''
      ? query.ids
      : (query.id != null && String(query.id).trim() !== '' ? query.id : '15130770000,15142270000'),
  );
  const ids = [];
  const seen = new Set();
  for (const part of raw.split(',')) {
    const candidate = normalizeShopeeAffiliateId(part);
    if (!candidate || seen.has(candidate)) continue;
    // Reuse the normal request resolver so unknown IDs fail with the same public error.
    resolveConversionReportRequest({ id: candidate, time: query.time });
    seen.add(candidate);
    ids.push(candidate);
  }
  if (!ids.length) {
    throw conversionReportIdError('shopee_affiliate_id_invalid', 'Invalid Shopee affiliate id list', raw);
  }
  return ids;
}

async function handleDailyIncomeForSpec(spec, page, opts = {}) {
  const pageSize = SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE;
  const maxPages = Math.max(1, Math.min(1000, parseInteger(opts.max_pages, 1000)));
  const rows = [];
  let totalCount = 0;
  let affiliateId = null;
  let pagesFetched = 0;
  let stoppedReason = 'total_reached';

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const apiUrl = buildConversionReportFetchUrl({
      range: spec.range,
      page_num: pageNum,
      page_size: pageSize,
      extras: spec.extras,
    });
    let result;
    try {
      result = await fetchConversionReportPageOnce(page, apiUrl);
    } catch (err) {
      return Object.assign(baseResponseShape(spec), {
        status: 'error',
        error: 'conversion_report_fetch_failed',
        reason: 'conversion_report_fetch_failed',
        detail: sanitizeDetail(err && err.message ? err.message : String(err)),
        pages_fetched: pagesFetched,
        page_size: pageSize,
      });
    }
    pagesFetched += 1;
    const classification = classifyConversionReportFetchResult(result);
    if (classification) {
      return Object.assign(baseResponseShape(spec), classification, {
        pages_fetched: pagesFetched,
        page_size: pageSize,
      });
    }
    const body = result.body;
    if (pageNum === 1) {
      totalCount = pickTotalCount(body);
      affiliateId = pickAffiliateId(body);
    }
    const list = pickList(body);
    const pageRows = Array.isArray(list) ? list : [];
    rows.push(...pageRows);
    if (!pageRows.length) {
      stoppedReason = 'empty_page';
      break;
    }
    if (totalCount <= 0 || rows.length >= totalCount) {
      stoppedReason = 'total_reached';
      break;
    }
  }

  if (pagesFetched >= maxPages && rows.length < totalCount) stoppedReason = 'max_pages';
  const amounts = summarizeDailyIncomeRowAmounts(rows);
  return Object.assign(baseResponseShape(spec), {
    status: 'ok',
    report_type: 'daily_income_account',
    mode: 'daily_income',
    amount_unit: 'THB',
    total_count: totalCount,
    orders: totalCount,
    row_count: rows.length,
    purchase_value: amounts.purchase_value,
    commission: amounts.commission,
    pages_fetched: pagesFetched,
    page_size: pageSize,
    truncated: totalCount > rows.length,
    stopped_reason: stoppedReason,
    affiliate_id: affiliateId,
  });
}

function buildDashboardDetailFetchUrl(spec) {
  const params = new URLSearchParams({
    start_time: String(spec.range.purchase_time_s),
    end_time: String(spec.range.purchase_time_e),
  });
  return `https://affiliate.shopee.co.th/api/v3/dashboard/detail?${params.toString()}`;
}

function dashboardMoney(value) {
  return roundTo2(pickNumber(value) / 100000);
}

async function handleDashboardIncomeForSpec(spec, page) {
  const apiUrl = buildDashboardDetailFetchUrl(spec);
  let result;
  try {
    result = await fetchConversionReportPageOnce(page, apiUrl);
  } catch (err) {
    return Object.assign(baseResponseShape(spec), {
      status: 'error',
      error: 'dashboard_detail_fetch_failed',
      reason: 'dashboard_detail_fetch_failed',
      detail: sanitizeDetail(err && err.message ? err.message : String(err)),
    });
  }
  const classification = classifyConversionReportFetchResult(result);
  if (classification) return Object.assign(baseResponseShape(spec), classification);
  const body = result.body || {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  return Object.assign(baseResponseShape(spec), {
    status: 'ok',
    report_type: 'daily_income_account',
    mode: 'dashboard_detail',
    amount_unit: 'THB',
    orders: pickNumber(data.cv_by_order_sum),
    row_count: null,
    item_sold: pickNumber(data.item_sold_sum),
    clicks: pickNumber(data.clicks_sum),
    purchase_value: dashboardMoney(data.order_amount_sum),
    commission: dashboardMoney(data.est_commission_sum),
    est_income: dashboardMoney(data.est_income_sum),
    source_endpoint: '/api/v3/dashboard/detail',
    last_update_time: data.last_update_time || body.last_update_time || null,
  });
}

async function handleDailyIncomeReport(query = {}, deps = {}) {
  const browserDep = deps.browser || browser;
  const now = deps.now instanceof Date ? deps.now : new Date();
  const ids = parseDailyIncomeIds(query);
  const accounts = [];
  let firstSpec = null;

  for (const id of ids) {
    const spec = resolveConversionReportRequest(Object.assign({}, query, {
      id,
      page_size: SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE,
      page_num: 1,
    }), { now });
    if (!firstSpec) firstSpec = spec;
    let pageRecord;
    try {
      pageRecord = await browserDep.getPage('shopee', spec.account, { headless: true });
    } catch (err) {
      accounts.push(Object.assign(baseResponseShape(spec), {
        status: 'error',
        error: 'browser_unavailable',
        reason: 'browser_unavailable',
        detail: sanitizeDetail(err && err.message ? err.message : String(err)),
      }));
      continue;
    }
    const page = pageRecord && pageRecord.page;
    if (!page) {
      accounts.push(Object.assign(baseResponseShape(spec), {
        status: 'error',
        error: 'browser_unavailable',
        reason: 'browser_unavailable',
      }));
      continue;
    }
    if (typeof browserDep.ensureOnPlatformPage === 'function') {
      try { await browserDep.ensureOnPlatformPage(page, 'shopee'); } catch {}
    }
    let currentUrl = '';
    try { currentUrl = typeof page.url === 'function' ? String(page.url() || '') : ''; } catch { currentUrl = ''; }
    const onAffiliateOrigin = typeof browserDep.isOnPlatformOrigin === 'function'
      ? browserDep.isOnPlatformOrigin(currentUrl, 'shopee')
      : /affiliate\.shopee\.co\.th/i.test(currentUrl);
    if (isLoginRedirectUrl(currentUrl) || !onAffiliateOrigin) {
      accounts.push(Object.assign(baseResponseShape(spec), {
        status: 'manual_login_required',
        error: 'manual_login_required',
        manualLoginRequired: true,
        needsManual: true,
        reason: 'shopee_login_required',
        loginUi: '/login?platform=shopee',
      }));
      continue;
    }
    accounts.push(await handleDashboardIncomeForSpec(spec, page));
  }

  const okAccounts = accounts.filter((account) => account.status === 'ok');
  const totals = okAccounts.reduce((acc, account) => {
    acc.orders += Number(account.orders || account.total_count || 0);
    acc.row_count += Number(account.row_count || 0);
    acc.purchase_value += Number(account.purchase_value || 0);
    acc.commission += Number(account.commission || 0);
    return acc;
  }, { orders: 0, row_count: 0, purchase_value: 0, commission: 0 });
  totals.purchase_value = roundTo2(totals.purchase_value);
  totals.commission = roundTo2(totals.commission);
  const failedAccounts = accounts.filter((account) => account.status !== 'ok');
  return {
    status: failedAccounts.length ? 'error' : 'ok',
    report_type: 'daily_income_report',
    mode: 'daily_income',
    time: firstSpec ? firstSpec.time : '',
    isoDate: firstSpec ? firstSpec.isoDate : '',
    range: firstSpec ? firstSpec.range : null,
    timezone: BANGKOK_TIMEZONE,
    source: 'shopee_conversion_report_api',
    account_count: accounts.length,
    ok_account_count: okAccounts.length,
    failed_account_count: failedAccounts.length,
    totals,
    amount_unit: 'THB',
    accounts,
  };
}

async function handleConversionReportRawMode(spec, page) {
  const apiUrl = buildConversionReportFetchUrl(spec);
  let result;
  try {
    result = await fetchConversionReportPageOnce(page, apiUrl);
  } catch (err) {
    return Object.assign(baseResponseShape(spec), {
      mode: 'raw',
      status: 'error',
      error: 'conversion_report_fetch_failed',
      reason: 'conversion_report_fetch_failed',
      detail: sanitizeDetail(err && err.message ? err.message : String(err)),
    });
  }
  const classification = classifyConversionReportFetchResult(result);
  if (classification) {
    return Object.assign(baseResponseShape(spec), { mode: 'raw' }, classification);
  }
  const body = result.body;
  return Object.assign(baseResponseShape(spec), {
    mode: 'raw',
    status: 'ok',
    total_count: pickTotalCount(body),
    list: pickList(body),
    affiliate_id: pickAffiliateId(body),
  });
}

const SHOPEE_DISCOVERED_SUMMARY_WARNING = 'sub_id discovery is based on the first sample of rows from Shopee; additional sub_ids may exist beyond the sample.';

function summarizeRowAmounts(rows) {
  let purchaseValue = 0;
  let commission = 0;
  for (const row of rows) {
    purchaseValue += pickRowPurchaseValue(row);
    commission += pickRowCommission(row);
  }
  return {
    purchase_value: roundTo2(purchaseValue),
    commission: roundTo2(commission),
  };
}

async function handleConversionReportFilteredSummary(spec, page) {
  const pageSize = SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE;
  const requestedSubId = String(spec.extras && spec.extras.sub_id != null ? spec.extras.sub_id : '');
  const apiUrl = buildConversionReportFetchUrl({
    range: spec.range,
    page_num: 1,
    page_size: pageSize,
    extras: spec.extras,
  });
  let result;
  try {
    result = await fetchConversionReportPageOnce(page, apiUrl);
  } catch (err) {
    return Object.assign(summaryResponseShape(spec), {
      status: 'error',
      error: 'conversion_report_fetch_failed',
      reason: 'conversion_report_fetch_failed',
      detail: sanitizeDetail(err && err.message ? err.message : String(err)),
      pages_fetched: 0,
      page_size: pageSize,
    });
  }
  const classification = classifyConversionReportFetchResult(result);
  if (classification) {
    return Object.assign(summaryResponseShape(spec), classification, {
      pages_fetched: 0,
      page_size: pageSize,
    });
  }
  const body = result.body;
  const totalCount = pickTotalCount(body);
  const list = pickList(body);
  const affiliateId = pickAffiliateId(body);
  const rows = Array.isArray(list) ? list : [];
  const firstRowSubId = rows.length > 0 ? pickRowSubId(rows[0]) : '';
  const displaySubId = firstRowSubId || requestedSubId;
  const sampleAmounts = summarizeRowAmounts(rows);
  return Object.assign(summaryResponseShape(spec), {
    total_count: totalCount,
    unique_sub_id_count: totalCount > 0 ? 1 : 0,
    sub_ids: totalCount > 0
      ? [{
        sub_id: displaySubId,
        requested_sub_id: requestedSubId,
        count: totalCount,
        percent: 100,
        sample_purchase_value: sampleAmounts.purchase_value,
        sample_commission: sampleAmounts.commission,
      }]
      : [],
    pages_fetched: 1,
    page_size: pageSize,
    row_sample_count: rows.length,
    truncated: false,
    breakdown_mode: 'filtered',
    sample_totals: sampleAmounts,
    affiliate_id: affiliateId,
  });
}

async function handleConversionReportSummaryMode(spec, page) {
  if (spec.extras && spec.extras.sub_id) {
    return handleConversionReportFilteredSummary(spec, page);
  }
  const pageSize = SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE;
  const unfilteredUrl = buildConversionReportFetchUrl({
    range: spec.range,
    page_num: 1,
    page_size: pageSize,
    extras: spec.extras,
  });
  let unfilteredResult;
  try {
    unfilteredResult = await fetchConversionReportPageOnce(page, unfilteredUrl);
  } catch (err) {
    return Object.assign(summaryResponseShape(spec), {
      status: 'error',
      error: 'conversion_report_fetch_failed',
      reason: 'conversion_report_fetch_failed',
      detail: sanitizeDetail(err && err.message ? err.message : String(err)),
      pages_fetched: 0,
      page_size: pageSize,
    });
  }
  const classification = classifyConversionReportFetchResult(unfilteredResult);
  if (classification) {
    return Object.assign(summaryResponseShape(spec), classification, {
      pages_fetched: 0,
      page_size: pageSize,
    });
  }
  const body = unfilteredResult.body;
  const totalCount = pickTotalCount(body);
  const list = pickList(body);
  const affiliateId = pickAffiliateId(body);
  const rows = Array.isArray(list) ? list : [];
  const rowSampleCount = rows.length;
  const sampleAmounts = summarizeRowAmounts(rows);

  const sampleComplete = totalCount <= 0 || rowSampleCount >= totalCount;
  if (sampleComplete) {
    const byId = new Map();
    for (const row of rows) {
      const subId = pickRowSubId(row);
      const prev = byId.get(subId) || { count: 0, purchaseValue: 0, commission: 0 };
      prev.count += 1;
      prev.purchaseValue += pickRowPurchaseValue(row);
      prev.commission += pickRowCommission(row);
      byId.set(subId, prev);
    }
    const entries = [];
    let total = 0;
    for (const [subId, agg] of byId.entries()) {
      total += agg.count;
      entries.push({
        sub_id: subId,
        count: agg.count,
        purchase_value: roundTo2(agg.purchaseValue),
        commission: roundTo2(agg.commission),
      });
    }
    entries.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.sub_id < b.sub_id) return -1;
      if (a.sub_id > b.sub_id) return 1;
      return 0;
    });
    for (const entry of entries) {
      entry.percent = total > 0 ? Number(((entry.count / total) * 100).toFixed(2)) : 0;
    }
    return Object.assign(summaryResponseShape(spec), {
      total_count: totalCount,
      unique_sub_id_count: entries.length,
      sub_ids: entries,
      pages_fetched: 1,
      page_size: pageSize,
      row_sample_count: rowSampleCount,
      truncated: false,
      breakdown_mode: 'complete',
      sample_totals: sampleAmounts,
      affiliate_id: affiliateId,
    });
  }

  // Sample is shorter than total_count. Discover unique sub_ids from the
  // sample rows, then ask Shopee for the exact filtered total_count per sub.
  const discoveredSet = new Set();
  for (const row of rows) {
    const subId = pickRowSubId(row);
    if (isPlaceholderSubId(subId)) continue;
    discoveredSet.add(subId);
  }
  const discoveredSubIds = Array.from(discoveredSet);
  discoveredSubIds.sort();

  const entries = [];
  let filteredFetchCount = 0;
  for (const subId of discoveredSubIds) {
    const filteredUrl = buildConversionReportFetchUrl({
      range: spec.range,
      page_num: 1,
      page_size: pageSize,
      extras: Object.assign({}, spec.extras || {}, { sub_id: subId }),
    });
    let subResult;
    try {
      subResult = await fetchConversionReportPageOnce(page, filteredUrl);
    } catch (err) {
      return Object.assign(summaryResponseShape(spec), {
        status: 'error',
        error: 'conversion_report_sub_count_failed',
        reason: 'conversion_report_sub_count_failed',
        failed_sub_id: sanitizeExtraValue(subId),
        detail: sanitizeDetail(err && err.message ? err.message : String(err)),
        pages_fetched: 1 + filteredFetchCount,
        page_size: pageSize,
      });
    }
    filteredFetchCount += 1;
    const subClassification = classifyConversionReportFetchResult(subResult);
    if (subClassification) {
      return Object.assign(summaryResponseShape(spec), {
        status: 'error',
        error: 'conversion_report_sub_count_failed',
        reason: 'conversion_report_sub_count_failed',
        failed_sub_id: sanitizeExtraValue(subId),
        underlying: subClassification.reason || subClassification.error || null,
        pages_fetched: 1 + filteredFetchCount,
        page_size: pageSize,
      });
    }
    const subTotal = pickTotalCount(subResult.body);
    const subRows = pickList(subResult.body);
    const subAmounts = summarizeRowAmounts(Array.isArray(subRows) ? subRows : []);
    entries.push({
      sub_id: subId,
      count: subTotal,
      sample_purchase_value: subAmounts.purchase_value,
      sample_commission: subAmounts.commission,
    });
  }

  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.sub_id < b.sub_id) return -1;
    if (a.sub_id > b.sub_id) return 1;
    return 0;
  });
  for (const entry of entries) {
    entry.percent = totalCount > 0
      ? Number(((entry.count / totalCount) * 100).toFixed(2))
      : 0;
  }

  return Object.assign(summaryResponseShape(spec), {
    total_count: totalCount,
    unique_sub_id_count: entries.length,
    discovered_sub_id_count: discoveredSet.size,
    sub_ids: entries,
    pages_fetched: 1 + filteredFetchCount,
    page_size: pageSize,
    row_sample_count: rowSampleCount,
    truncated: true,
    breakdown_mode: 'discovered_filtered',
    sample_totals: sampleAmounts,
    warning: SHOPEE_DISCOVERED_SUMMARY_WARNING,
    affiliate_id: affiliateId,
  });
}

async function handleConversionReport(query = {}, deps = {}) {
  const browserDep = deps.browser || browser;
  const now = deps.now instanceof Date ? deps.now : new Date();
  const rawMode = isRawConversionReportMode(query);

  // Summary mode always fetches with the largest page_size starting at page 1.
  // The caller-supplied page_num/page_size are honored only in raw mode.
  const workingQuery = rawMode ? query : Object.assign({}, query, {
    page_size: SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE,
    page_num: 1,
  });
  const spec = resolveConversionReportRequest(workingQuery, { now });

  const errorShape = () => (rawMode
    ? Object.assign(baseResponseShape(spec), { mode: 'raw' })
    : summaryResponseShape(spec));

  let pageRecord;
  try {
    pageRecord = await browserDep.getPage('shopee', spec.account, { headless: true });
  } catch (err) {
    return Object.assign(errorShape(), {
      status: 'error',
      error: 'browser_unavailable',
      reason: 'browser_unavailable',
      detail: sanitizeDetail(err && err.message ? err.message : String(err)),
    });
  }

  const page = pageRecord && pageRecord.page;
  if (!page) {
    return Object.assign(errorShape(), {
      status: 'error',
      error: 'browser_unavailable',
      reason: 'browser_unavailable',
    });
  }

  if (typeof browserDep.ensureOnPlatformPage === 'function') {
    try { await browserDep.ensureOnPlatformPage(page, 'shopee'); } catch {}
  }

  let currentUrl = '';
  try { currentUrl = typeof page.url === 'function' ? String(page.url() || '') : ''; } catch { currentUrl = ''; }

  const onAffiliateOrigin = typeof browserDep.isOnPlatformOrigin === 'function'
    ? browserDep.isOnPlatformOrigin(currentUrl, 'shopee')
    : /affiliate\.shopee\.co\.th/i.test(currentUrl);

  if (isLoginRedirectUrl(currentUrl) || !onAffiliateOrigin) {
    return Object.assign(errorShape(), {
      status: 'manual_login_required',
      error: 'manual_login_required',
      manualLoginRequired: true,
      needsManual: true,
      reason: 'shopee_login_required',
      loginUi: '/login?platform=shopee',
    });
  }

  return rawMode
    ? handleConversionReportRawMode(spec, page)
    : handleConversionReportSummaryMode(spec, page);
}

function isConversionReportHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).split(',')[0].split(':')[0].trim().toLowerCase();
  if (!host) return false;
  return SHOPEE_CONVERSION_REPORT_HOST_PATTERN.test(host);
}

module.exports = {
  SHOPEE_CONVERSION_REPORT_API_BASE,
  SHOPEE_CONVERSION_REPORT_DEFAULT_ID,
  SHOPEE_CONVERSION_REPORT_PAGE_SIZE_DEFAULT,
  SHOPEE_CONVERSION_REPORT_PAGE_SIZE_MAX,
  SHOPEE_CONVERSION_REPORT_SUMMARY_PAGE_SIZE,
  SHOPEE_CONVERSION_REPORT_API_VERSION,
  SHOPEE_DISCOVERED_SUMMARY_WARNING,
  BANGKOK_TIMEZONE,
  CONVERSION_REPORT_EXTRA_KEYS,
  parseConversionReportDate,
  clampPageNum,
  clampPageSize,
  safePassthroughExtras,
  isRawConversionReportMode,
  resolveConversionReportRequest,
  buildConversionReportFetchUrl,
  classifyConversionReportFailure,
  handleConversionReport,
  handleDailyIncomeReport,
  parseDailyIncomeIds,
  isConversionReportHost,
  pickRowSubId,
  isPlaceholderSubId,
  _CONVERSION_REPORT_FETCH_SCRIPT_FOR_TEST: CONVERSION_REPORT_FETCH_SCRIPT,
};
