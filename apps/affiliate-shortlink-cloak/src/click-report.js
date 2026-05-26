'use strict';

const browser = require('./browser');
const { sanitizeAccount } = require('./accounts');
const {
  normalizeShopeeAffiliateId,
  resolveShopeeAccountMetadataFromId,
} = require('./shopee-accounts');

const SHOPEE_CLICK_REPORT_API_BASE = 'https://affiliate.shopee.co.th/api/v1/click_report/list';
const SHOPEE_CLICK_REPORT_HOST_PATTERN = /^clickreport\.wwoom\.com$/i;
const SHOPEE_CLICK_REPORT_PAGE_SIZE_DEFAULT = 20;
const SHOPEE_CLICK_REPORT_PAGE_SIZE_MAX = 100;
const SHOPEE_CLICK_REPORT_SUMMARY_PAGE_SIZE = 100;
const SHOPEE_CLICK_REPORT_SUMMARY_MAX_PAGES = 1000;
const SHOPEE_CLICK_REPORT_DEFAULT_ID = '15130770000';
const BANGKOK_TIMEZONE = 'Asia/Bangkok';
const BANGKOK_UTC_OFFSET_SECONDS = 7 * 3600;
const CLICK_REPORT_EXTRA_KEYS = ['sub_id', 'click_id', 'click_region'];

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

function clickReportDateError(raw) {
  const safe = String(raw == null ? '' : raw).slice(0, 64);
  const err = new Error('Invalid time parameter: ' + safe);
  err.reason = 'click_report_time_invalid';
  err.statusCode = 400;
  err.publicPayload = {
    status: 'error',
    error: 'click_report_time_invalid',
    reason: 'click_report_time_invalid',
    message: 'Invalid time parameter. Accepted formats: DD/MM/YYYY, YYYY-MM-DD, today, yesterday.',
    requestedTime: safe,
  };
  return err;
}

function parseClickReportDate(input, opts = {}) {
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
      throw clickReportDateError(raw);
    }
    if (!isValidYMD(y, m, d)) {
      throw clickReportDateError(raw);
    }
  }
  return {
    year: y,
    month: m,
    day: d,
    display: pad2(d) + '/' + pad2(m) + '/' + y,
    isoDate: y + '-' + pad2(m) + '-' + pad2(d),
    timezone: BANGKOK_TIMEZONE,
    click_time_s: dateToUnixSecondsBangkok(y, m, d, 0, 0, 0),
    click_time_e: dateToUnixSecondsBangkok(y, m, d, 23, 59, 59),
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
  const n = parseInteger(value, SHOPEE_CLICK_REPORT_PAGE_SIZE_DEFAULT);
  if (n < 1) return SHOPEE_CLICK_REPORT_PAGE_SIZE_DEFAULT;
  if (n > SHOPEE_CLICK_REPORT_PAGE_SIZE_MAX) return SHOPEE_CLICK_REPORT_PAGE_SIZE_MAX;
  return n;
}

function sanitizeExtraValue(value) {
  return String(value == null ? '' : value).trim().slice(0, 200);
}

function safePassthroughExtras(query) {
  const out = {};
  if (!query || typeof query !== 'object') return out;
  for (const key of CLICK_REPORT_EXTRA_KEYS) {
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

function isRawClickReportMode(query) {
  if (!query || typeof query !== 'object') return false;
  if (isTruthyFlag(query.raw)) return true;
  const mode = String(query.mode == null ? '' : query.mode).trim().toLowerCase();
  return mode === 'raw';
}

function clickReportIdError(reason, message, requestedId) {
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

function resolveClickReportRequest(query = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const rawId = String(query.id == null ? '' : query.id).trim();
  const idCandidate = rawId || SHOPEE_CLICK_REPORT_DEFAULT_ID;
  const normalizedId = normalizeShopeeAffiliateId(idCandidate);
  if (!normalizedId) {
    throw clickReportIdError(
      'shopee_affiliate_id_invalid',
      'Invalid Shopee affiliate id',
      idCandidate,
    );
  }
  const meta = resolveShopeeAccountMetadataFromId(normalizedId);
  if (!meta || !meta.account) {
    throw clickReportIdError(
      'shopee_affiliate_id_unknown',
      'Unknown Shopee affiliate id: ' + normalizedId,
      normalizedId,
    );
  }
  const accountInternal = String(meta.account);
  const account = sanitizeAccount(accountInternal);
  const displayAccount = String(meta.displayAccount || accountInternal).trim() || accountInternal;
  const parsedTime = parseClickReportDate(query.time, { now });
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
      click_time_s: parsedTime.click_time_s,
      click_time_e: parsedTime.click_time_e,
    },
    page_num,
    page_size,
    extras,
  };
}

function buildClickReportFetchUrl(spec) {
  const params = new URLSearchParams();
  params.set('click_time_s', String(spec.range.click_time_s));
  params.set('click_time_e', String(spec.range.click_time_e));
  params.set('page_num', String(spec.page_num));
  params.set('page_size', String(spec.page_size));
  const extras = spec.extras && typeof spec.extras === 'object' ? spec.extras : {};
  for (const key of CLICK_REPORT_EXTRA_KEYS) {
    const value = extras[key];
    if (value) params.set(key, String(value));
  }
  return SHOPEE_CLICK_REPORT_API_BASE + '?' + params.toString();
}

const CLICK_REPORT_FETCH_SCRIPT = `async ([apiUrl]) => {
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
  return n === 30001;
}

function classifyClickReportFailure(body) {
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
  if (Array.isArray(data.click_report_list)) return data.click_report_list;
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

function baseResponseShape(spec) {
  return {
    id: spec.id,
    account: spec.displayAccount,
    accountInternal: spec.accountInternal,
    time: spec.time,
    range: spec.range,
    page_num: spec.page_num,
    page_size: spec.page_size,
    source: 'shopee_click_report_api',
  };
}

function classifyClickReportFetchResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      status: 'error',
      error: 'click_report_empty_response',
      reason: 'click_report_empty_response',
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
      error: 'click_report_invalid_json',
      reason: 'click_report_invalid_json',
      httpStatus: result.status,
    };
  }
  const loginReason = classifyClickReportFailure(result.body);
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

function summarizeSubIdCounts(counts, opts = {}) {
  const countField = opts.countField || 'count';
  const percentField = opts.percentField || 'percent';
  const entries = [];
  let total = 0;
  for (const [subId, count] of counts.entries()) {
    total += count;
    entries.push({ sub_id: subId, [countField]: count });
  }
  entries.sort((a, b) => {
    if (b[countField] !== a[countField]) return b[countField] - a[countField];
    if (a.sub_id < b.sub_id) return -1;
    if (a.sub_id > b.sub_id) return 1;
    return 0;
  });
  for (const entry of entries) {
    entry[percentField] = total > 0
      ? Number(((entry[countField] / total) * 100).toFixed(2))
      : 0;
  }
  return { entries, aggregatedTotal: total };
}

async function fetchClickReportPageOnce(page, apiUrl) {
  return page.evaluate(
    new Function('args', 'return (' + CLICK_REPORT_FETCH_SCRIPT + ')(args);'),
    [apiUrl],
  );
}

function summaryResponseShape(spec) {
  return {
    status: 'ok',
    mode: 'summary',
    id: spec.id,
    account: spec.displayAccount,
    accountInternal: spec.accountInternal,
    time: spec.time,
    range: spec.range,
    source: 'shopee_click_report_api',
  };
}

async function handleClickReportRawMode(spec, page) {
  const apiUrl = buildClickReportFetchUrl(spec);
  let result;
  try {
    result = await fetchClickReportPageOnce(page, apiUrl);
  } catch (err) {
    return Object.assign(baseResponseShape(spec), {
      mode: 'raw',
      status: 'error',
      error: 'click_report_fetch_failed',
      reason: 'click_report_fetch_failed',
      detail: sanitizeDetail(err && err.message ? err.message : String(err)),
    });
  }
  const classification = classifyClickReportFetchResult(result);
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

const SHOPEE_SAMPLE_SUMMARY_WARNING = 'Shopee list pagination caps before total_count is reached; per-sub_id breakdown reflects the fetched sample only. Use sub_id=<value> to get the exact count for one sub.';

async function handleClickReportFilteredSummary(spec, page) {
  const pageSize = SHOPEE_CLICK_REPORT_SUMMARY_PAGE_SIZE;
  const requestedSubId = String(spec.extras && spec.extras.sub_id != null ? spec.extras.sub_id : '');
  const apiUrl = buildClickReportFetchUrl({
    range: spec.range,
    page_num: 1,
    page_size: pageSize,
    extras: spec.extras,
  });
  let result;
  try {
    result = await fetchClickReportPageOnce(page, apiUrl);
  } catch (err) {
    return Object.assign(summaryResponseShape(spec), {
      status: 'error',
      error: 'click_report_fetch_failed',
      reason: 'click_report_fetch_failed',
      detail: sanitizeDetail(err && err.message ? err.message : String(err)),
      pages_fetched: 0,
      page_size: pageSize,
    });
  }
  const classification = classifyClickReportFetchResult(result);
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
  const firstRowSubId = rows.length > 0 && rows[0] && rows[0].sub_id != null
    ? String(rows[0].sub_id)
    : '';
  const displaySubId = firstRowSubId || requestedSubId;
  return Object.assign(summaryResponseShape(spec), {
    total_count: totalCount,
    unique_sub_id_count: totalCount > 0 ? 1 : 0,
    sub_ids: totalCount > 0
      ? [{
        sub_id: displaySubId,
        requested_sub_id: requestedSubId,
        count: totalCount,
        percent: 100,
      }]
      : [],
    pages_fetched: 1,
    page_size: pageSize,
    row_sample_count: rows.length,
    truncated: false,
    breakdown_mode: 'filtered',
    affiliate_id: affiliateId,
  });
}

async function handleClickReportSummaryMode(spec, page) {
  if (spec.extras && spec.extras.sub_id) {
    return handleClickReportFilteredSummary(spec, page);
  }
  const pageSize = SHOPEE_CLICK_REPORT_SUMMARY_PAGE_SIZE;
  const counts = new Map();
  let totalCount = 0;
  let affiliateId = null;
  let firstResultTotal = null;
  let pagesFetched = 0;
  let rowSampleCount = 0;
  let maxPagesHit = false;
  let pageNum = 1;

  while (true) {
    const apiUrl = buildClickReportFetchUrl({
      range: spec.range,
      page_num: pageNum,
      page_size: pageSize,
      extras: spec.extras,
    });
    let result;
    try {
      result = await fetchClickReportPageOnce(page, apiUrl);
    } catch (err) {
      return Object.assign(summaryResponseShape(spec), {
        status: 'error',
        error: 'click_report_fetch_failed',
        reason: 'click_report_fetch_failed',
        detail: sanitizeDetail(err && err.message ? err.message : String(err)),
        pages_fetched: pagesFetched,
        page_size: pageSize,
      });
    }
    const classification = classifyClickReportFetchResult(result);
    if (classification) {
      return Object.assign(summaryResponseShape(spec), classification, {
        pages_fetched: pagesFetched,
        page_size: pageSize,
      });
    }
    const body = result.body;
    const pageTotal = pickTotalCount(body);
    const list = pickList(body);
    if (pagesFetched === 0) {
      totalCount = pageTotal;
      affiliateId = pickAffiliateId(body);
      firstResultTotal = pageTotal;
    }
    pagesFetched += 1;
    const rows = Array.isArray(list) ? list : [];
    rowSampleCount += rows.length;
    for (const row of rows) {
      const subId = row && row.sub_id != null ? String(row.sub_id) : '';
      counts.set(subId, (counts.get(subId) || 0) + 1);
    }
    if (rows.length === 0) break;
    if (rows.length < pageSize) break;
    if (firstResultTotal != null && firstResultTotal > 0 && rowSampleCount >= firstResultTotal) break;
    if (pagesFetched >= SHOPEE_CLICK_REPORT_SUMMARY_MAX_PAGES) {
      maxPagesHit = true;
      break;
    }
    pageNum += 1;
  }

  const sampleComplete = totalCount <= 0 || rowSampleCount >= totalCount;
  if (sampleComplete && !maxPagesHit) {
    const { entries } = summarizeSubIdCounts(counts);
    return Object.assign(summaryResponseShape(spec), {
      total_count: totalCount,
      unique_sub_id_count: entries.length,
      sub_ids: entries,
      pages_fetched: pagesFetched,
      page_size: pageSize,
      row_sample_count: rowSampleCount,
      truncated: false,
      breakdown_mode: 'complete',
      affiliate_id: affiliateId,
    });
  }

  const { entries } = summarizeSubIdCounts(counts, {
    countField: 'sample_count',
    percentField: 'sample_percent',
  });
  return Object.assign(summaryResponseShape(spec), {
    total_count: totalCount,
    unique_sub_id_count: entries.length,
    sub_ids: entries,
    pages_fetched: pagesFetched,
    page_size: pageSize,
    row_sample_count: rowSampleCount,
    truncated: true,
    breakdown_mode: 'sample',
    warning: SHOPEE_SAMPLE_SUMMARY_WARNING,
    affiliate_id: affiliateId,
  });
}

async function handleClickReport(query = {}, deps = {}) {
  const browserDep = deps.browser || browser;
  const now = deps.now instanceof Date ? deps.now : new Date();
  const rawMode = isRawClickReportMode(query);

  // Summary mode always fetches with the largest page_size starting at page 1.
  // The caller-supplied page_num/page_size are honored only in raw mode.
  const workingQuery = rawMode ? query : Object.assign({}, query, {
    page_size: SHOPEE_CLICK_REPORT_SUMMARY_PAGE_SIZE,
    page_num: 1,
  });
  const spec = resolveClickReportRequest(workingQuery, { now });

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
    ? handleClickReportRawMode(spec, page)
    : handleClickReportSummaryMode(spec, page);
}

function isClickReportHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).split(',')[0].split(':')[0].trim().toLowerCase();
  if (!host) return false;
  return SHOPEE_CLICK_REPORT_HOST_PATTERN.test(host);
}

module.exports = {
  SHOPEE_CLICK_REPORT_API_BASE,
  SHOPEE_CLICK_REPORT_DEFAULT_ID,
  SHOPEE_CLICK_REPORT_PAGE_SIZE_DEFAULT,
  SHOPEE_CLICK_REPORT_PAGE_SIZE_MAX,
  SHOPEE_CLICK_REPORT_SUMMARY_PAGE_SIZE,
  SHOPEE_CLICK_REPORT_SUMMARY_MAX_PAGES,
  SHOPEE_SAMPLE_SUMMARY_WARNING,
  BANGKOK_TIMEZONE,
  CLICK_REPORT_EXTRA_KEYS,
  parseClickReportDate,
  clampPageNum,
  clampPageSize,
  safePassthroughExtras,
  isRawClickReportMode,
  resolveClickReportRequest,
  buildClickReportFetchUrl,
  classifyClickReportFailure,
  handleClickReport,
  isClickReportHost,
  _CLICK_REPORT_FETCH_SCRIPT_FOR_TEST: CLICK_REPORT_FETCH_SCRIPT,
};
