'use strict';

const browser = require('./browser');
const {
  MAX_SHORTEN_ATTEMPTS,
  BETWEEN_ATTEMPT_DELAY_MS,
  SHORTEN_TIMEOUT_MS,
  SHOPEE_URL,
  SHOPEE_CUSTOM_LINK_ROUTE_CANDIDATES,
  CHROME_UA,
} = require('./config');
const {
  currentPageUrl,
  isShopeeRouteNotFoundUrl,
  createShopeeRouteNotFoundError,
} = require('./shopee-route');

// Real authentication / session errors — login expired, CSRF rejected, 401/403.
// Split out from generic network so the last-known-good fallback never masks
// a genuine auth failure that the operator needs to see (and reauth).
function isAuthSessionError(err) {
  const msg = String((err && err.message) || err || '').toUpperCase();
  return /SESSION|TOKEN|UNAUTHORIZED|LOGIN|CSRF|FAIL_SYS|401|403/.test(msg);
}

// Pure transport hiccups (DNS, reset, abort, fetch failure). Recoverable
// like nav/timeout/api-transient and safe to mask with a cached shortlink.
function isNetworkRecoverable(err) {
  const msg = String((err && err.message) || err || '').toUpperCase();
  return /FAILED TO FETCH|NETWORKERROR|NETWORK ERROR|ERR_NETWORK|ERR_INTERNET|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|LOAD FAILED|ABORTED/.test(msg);
}

function isSessionLikelyExpired(err) {
  return (
    isAuthSessionError(err)
    || isNetworkRecoverable(err)
    || isShopeeFailCode3(err)
    || isShopeeOffDomainRedirect(err)
  );
}

// Detect transient Playwright/CDP failures caused by the page navigating
// out from under us mid-evaluate. These are recoverable by re-settling the
// page (or forcing a fresh persistent context) and retrying the shorten.
function isContextDestroyed(err) {
  const msg = String((err && err.message) || err || '');
  return /execution context (was )?destroyed|most likely because of a navigation|navigation (started|happened) (during|while)|frame (was )?detached|target closed|target page, context or browser has been closed|page has been closed|page closed|page\.evaluate.*(navigation|destroyed)|browsing context (was )?discarded/i.test(msg);
}

// Shopee's batchCustomLink GraphQL endpoint intermittently returns an
// envelope with no data.batchCustomLink and an error code 90309999
// ("failed to dispatch" / upstream hiccup). Same product URL succeeds on
// retry, so treat it as transient rather than fatal.
function isTransientApiError(err) {
  const msg = String((err && err.message) || err || '');
  return /No results:[\s\S]*90309999/.test(msg);
}

// Shopee failCode 3 has shown up when the profile is bounced through a
// stale/incorrect affiliate session. Legacy Electron can recover the same URL
// with the same account, so give Keychain reauth + context recycle a chance
// before surfacing it. Other failCodes remain fatal.
function isShopeeFailCode3(err) {
  const msg = String((err && err.message) || err || '');
  return /\bfailCode:\s*3\b/.test(msg);
}

function isShopeeOffDomainRedirect(err) {
  const msg = String((err && err.message) || err || '');
  return /redirected off affiliate\.shopee\.co\.th|shopee\.co\.th\/buyer\/login/i.test(msg);
}

function isShopeeSessionApiError(err) {
  const msg = String((err && err.message) || err || '');
  return (
    /No results:[\s\S]*90309999/.test(msg)
    && (/"2"\s*:\s*false/.test(msg) || /"error"\s*:\s*90309999/.test(msg))
  );
}

// withTimeout() throws `Timeout after Nms` when shortenShopeeOnce hangs —
// usually a stuck page.evaluate or detached frame the page can't recover
// from. The hung page poisons every subsequent request on the same context,
// so treat the timeout as transient and force a fresh persistent context on
// the next attempt rather than reusing the wedged one.
function isTimeoutError(err) {
  const msg = String((err && err.message) || err || '');
  return /^Timeout after \d+ms$/.test(msg);
}

function isRecoverableShortenError(err) {
  return (
    isShopeeOffDomainRedirect(err)
    || isContextDestroyed(err)
    || isTimeoutError(err)
    || isTransientApiError(err)
    || isSessionLikelyExpired(err)
  );
}

// Failures we are willing to mask with a previously-cached short link after
// retries exhaust: transient API (90309999), timeout, nav/context-destroyed,
// and pure network hiccups. Auth/session and fatal failCodes are excluded —
// masking those would hide a real login problem the operator must address.
function isFallbackEligibleError(err) {
  if (!err) return false;
  if (err.manualLoginRequired) return false;
  if (isAuthSessionError(err)) return false;
  if (isShopeeOffDomainRedirect(err)) return false;
  if (isShopeeFailCode3(err) || isShopeeSessionApiError(err)) return false;
  return (
    isTimeoutError(err)
    || isContextDestroyed(err)
    || isTransientApiError(err)
    || isNetworkRecoverable(err)
  );
}

function postReauthFailureSuffix(reauthResult) {
  return reauthResult && reauthResult.alreadyAuthenticated
    ? 'after_authenticated_reauth'
    : 'after_reauth';
}

function reauthPreservesContext(reauthResult) {
  return !!(reauthResult && (reauthResult.alreadyAuthenticated || reauthResult.reuseAuthenticatedContext));
}

function postReauthFailureReason(err, reauthResult) {
  const suffix = postReauthFailureSuffix(reauthResult);
  if (isShopeeFailCode3(err)) return `shopee_api_fail_code_3_${suffix}`;
  if (isShopeeSessionApiError(err)) return `shopee_api_session_rejected_${suffix}`;
  if (isAuthSessionError(err)) return `shopee_api_auth_rejected_${suffix}`;
  if (isShopeeOffDomainRedirect(err)) return `shopee_redirected_off_affiliate_${suffix}`;
  return `shopee_session_not_restored_${suffix}`;
}

function postReauthErrorClass(err) {
  const msg = String((err && err.message) || err || '');
  if (/\b(401|403)\b/.test(msg)) return 'http_401_or_403';
  if (isShopeeFailCode3(err)) return 'fail_code_3';
  if (isShopeeSessionApiError(err)) return 'session_api_90309999';
  if (isAuthSessionError(err)) return 'auth_session_error';
  if (isShopeeOffDomainRedirect(err)) return 'off_domain_redirect';
  return 'session_not_restored';
}

function isHttp401Or403Error(err) {
  return postReauthErrorClass(err) === 'http_401_or_403';
}

function isFailClosedShopeeValidationError(err) {
  const reason = String((err && err.reason) || '');
  if (
    reason === 'shopee_affiliate_id_unknown'
    || reason === 'shopee_affiliate_account_conflict'
    || reason === 'shopee_affiliate_utm_source_mismatch'
  ) {
    return true;
  }
  const msg = String((err && err.message) || err || '');
  return /\bshopee_affiliate_(?:id_unknown|account_conflict|utm_source_mismatch)\b/.test(msg);
}

function createManualLoginRequiredError(reauthResult) {
  const blockErr = new Error('MANUAL_LOGIN_REQUIRED');
  blockErr.manualLoginRequired = true;
  blockErr.reason = (reauthResult && reauthResult.reason) || 'manual_login_required';
  if (reauthResult && reauthResult.diagnostic) blockErr.diagnostic = reauthResult.diagnostic;
  return blockErr;
}

function sanitizeShopeeErrorMessageForLog(value) {
  let msg = String(value == null ? '' : value);
  if (!msg) return '';
  msg = msg.replace(/^(\s*-\s*)?(cookie:\s*)[^\r\n]*/gim, '$1$2[REDACTED]');
  msg = msg.replace(/^(\s*-\s*)?(authorization:\s*)[^\r\n]*/gim, '$1$2[REDACTED]');
  msg = msg.replace(/^(\s*-\s*)?(csrf-token:\s*)[^\r\n]*/gim, '$1$2[REDACTED]');
  msg = msg.replace(/((?:SPC|REC|_ga|_gcl|_fbp|csrftoken|language|ds|shopee_webUnique_ccd)[^=;\s]*=)[^;\s\r\n]*/gi, '$1[REDACTED]');
  return msg.length > 1200 ? msg.slice(0, 1199).trimEnd() + '…' : msg;
}

function sanitizedErrorForSurface(err) {
  if (!err || typeof err !== 'object') return new Error(sanitizeShopeeErrorMessageForLog(err));
  const original = err && err.message ? err.message : String(err);
  const safe = sanitizeShopeeErrorMessageForLog(original);
  if (safe === original) return err;
  const out = new Error(safe);
  out.name = err.name || out.name;
  if (err.manualLoginRequired) out.manualLoginRequired = err.manualLoginRequired;
  if (err.reason) out.reason = err.reason;
  if (err.diagnostic) out.diagnostic = err.diagnostic;
  if (err.shopeeApiTransport) out.shopeeApiTransport = err.shopeeApiTransport;
  return out;
}

function attachApiTransportDiagnostic(err, contextRequestErr) {
  if (!err || typeof err !== 'object' || !contextRequestErr) return err;
  err.shopeeApiTransport = {
    contextRequest: postReauthErrorClass(contextRequestErr),
    pageEvaluateAttempted: true,
    pageEvaluate: postReauthErrorClass(err),
  };
  return err;
}

function extractShopeeApiEnvelope(err) {
  const msg = String((err && err.message) || err || '');
  const match = msg.match(/envelope:\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function buildPostReauthDiagnostic(err, reauthResult, attempt, reason) {
  const diagnostic = {
    reason,
    platform: 'shopee',
    source: 'shorten_retry_after_reauth',
    attempt,
    reauthOk: !!(reauthResult && reauthResult.ok),
    reauthAlreadyAuthenticated: !!(reauthResult && reauthResult.alreadyAuthenticated),
    errorClass: postReauthErrorClass(err),
  };
  if (err && err.shopeeApiTransport) {
    diagnostic.apiTransport = Object.assign({}, err.shopeeApiTransport);
  }
  const envelope = extractShopeeApiEnvelope(err);
  if (envelope) diagnostic.shopeeApiEnvelope = envelope;
  return diagnostic;
}

// Last-known-good cache keyed by (account, productUrl, sub1..sub5). The same
// caller asking for the same shortlink during a Shopee API hiccup gets the
// last successful response instead of a bare 90309999. Module-scoped so a
// long-running bridge process retains memory across loop iterations.
const lastSuccessCache = new Map();

function buildCacheKey(account, productUrl, subIds) {
  const safeSubs = [0, 1, 2, 3, 4].map((i) => String((subIds && subIds[i]) || '').trim());
  return JSON.stringify([String(account || ''), String(productUrl || ''), safeSubs]);
}

function recordLastSuccess(account, productUrl, subIds, result) {
  if (!result || typeof result !== 'object') return;
  const shortLink = String(result.shortLink || '').trim();
  if (!shortLink) return;
  lastSuccessCache.set(buildCacheKey(account, productUrl, subIds), {
    shortLink,
    longLink: String(result.longLink || ''),
    originalLink: String(result.originalLink || ''),
  });
}

function getLastSuccess(account, productUrl, subIds) {
  return lastSuccessCache.get(buildCacheKey(account, productUrl, subIds)) || null;
}

function _resetLastSuccessCache() {
  lastSuccessCache.clear();
}

function sanitizeShopeeSubId(value) {
  return String(value == null ? '' : value).replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
}

function sanitizeShopeeSubIds(subIds) {
  return [0, 1, 2, 3, 4].map((i) => sanitizeShopeeSubId(subIds && subIds[i]));
}

const SHORTEN_SCRIPT = `async ([productUrl, subIds]) => {
  const sanitizeShopeeSubId = (value) => String(value == null ? '' : value).replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
  const sanitizedSubIds = [0, 1, 2, 3, 4].map((i) => sanitizeShopeeSubId(subIds && subIds[i]));
  const [sub1, sub2, sub3, sub4, sub5] = sanitizedSubIds;
  let csrfToken = null;
  const m = document.cookie.match(/csrftoken=([^;]+)/);
  if (m) csrfToken = m[1];
  if (!csrfToken) {
    const meta = document.querySelector('meta[name="csrf-token"]') || document.querySelector('meta[name="csrftoken"]');
    if (meta) csrfToken = meta.getAttribute('content');
  }
  const headers = {
    'Content-Type': 'application/json',
    'affiliate-program-type': '1',
  };
  if (csrfToken) headers['csrf-token'] = csrfToken;
  const linkParam = { originalLink: productUrl };
  if (sanitizedSubIds.some(Boolean)) {
    linkParam.advancedLinkParams = {
      subId1: sub1 || '', subId2: sub2 || '', subId3: sub3 || '',
      subId4: sub4 || '', subId5: sub5 || '',
    };
  }
  const resp = await fetch('https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink', {
    method: 'POST',
    headers: headers,
    credentials: 'include',
    body: JSON.stringify({
      operationName: 'batchGetCustomLink',
      variables: { linkParams: [linkParam], sourceCaller: 'CUSTOM_LINK_CALLER' },
      query: 'query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }',
    }),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('HTTP ' + resp.status + ' UNAUTHORIZED (likely SESSION_EXPIRED)');
  }
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) {
    const snippet = text.substring(0, 200);
    if (/login|sign[- ]?in|csrf/i.test(snippet)) throw new Error('SESSION_EXPIRED (login page returned)');
    throw new Error('Invalid JSON: ' + snippet);
  }
  const results = json && json.data && json.data.batchCustomLink;
  if (!results || !results.length) throw new Error('No results: ' + JSON.stringify(json).substring(0, 200));
  const r = results[0];
  if (r.failCode && r.failCode !== 0) {
    const envelope = JSON.stringify({ result: r, errors: (json && json.errors) || null }).substring(0, 600);
    throw new Error('failCode: ' + r.failCode + ' envelope: ' + envelope);
  }
  return { shortLink: r.shortLink || '', longLink: r.longLink || '', originalLink: productUrl };
}`;

function buildShortlinkBody(productUrl, subIds) {
  const sanitizedSubIds = sanitizeShopeeSubIds(subIds);
  const [sub1, sub2, sub3, sub4, sub5] = sanitizedSubIds;
  const linkParam = { originalLink: productUrl };
  if (sanitizedSubIds.some(Boolean)) {
    linkParam.advancedLinkParams = {
      subId1: sub1 || '',
      subId2: sub2 || '',
      subId3: sub3 || '',
      subId4: sub4 || '',
      subId5: sub5 || '',
    };
  }
  return {
    operationName: 'batchGetCustomLink',
    variables: { linkParams: [linkParam], sourceCaller: 'CUSTOM_LINK_CALLER' },
    query: 'query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }',
  };
}

async function csrfTokenFromContext(context, page) {
  try {
    const cookies = await context.cookies('https://affiliate.shopee.co.th');
    const csrf = (cookies || []).find((cookie) => cookie && cookie.name === 'csrftoken');
    if (csrf && csrf.value) return csrf.value;
  } catch {}
  try {
    return await page.evaluate(() => {
      const match = document.cookie.match(/csrftoken=([^;]+)/);
      if (match) return match[1];
      const meta = document.querySelector('meta[name="csrf-token"]') || document.querySelector('meta[name="csrftoken"]');
      return meta ? meta.getAttribute('content') || '' : '';
    });
  } catch {}
  return '';
}

function parseShopeeShortlinkResponse(status, text, productUrl) {
  if (status === 401 || status === 403) {
    throw new Error('HTTP ' + status + ' UNAUTHORIZED (likely SESSION_EXPIRED)');
  }
  let json;
  try { json = JSON.parse(text); } catch (err) {
    const snippet = String(text || '').substring(0, 200);
    if (/login|sign[- ]?in|csrf/i.test(snippet)) throw new Error('SESSION_EXPIRED (login page returned)');
    throw new Error('Invalid JSON: ' + snippet);
  }
  const results = json && json.data && json.data.batchCustomLink;
  if (!results || !results.length) throw new Error('No results: ' + JSON.stringify(json).substring(0, 200));
  const r = results[0];
  if (r.failCode && r.failCode !== 0) {
    const envelope = JSON.stringify({ result: r, errors: (json && json.errors) || null }).substring(0, 600);
    throw new Error('failCode: ' + r.failCode + ' envelope: ' + envelope);
  }
  return { shortLink: r.shortLink || '', longLink: r.longLink || '', originalLink: productUrl };
}


async function shortenShopeeViaContextRequest(record, page, productUrl, safeSubs) {
  const context = record && record.context;
  const request = context && context.request;
  if (!request || typeof request.post !== 'function') return null;
  const csrfToken = await csrfTokenFromContext(context, page);
  const headers = {
    'Content-Type': 'application/json',
    'affiliate-program-type': '1',
    origin: 'https://affiliate.shopee.co.th',
    referer: SHOPEE_URL,
    'user-agent': CHROME_UA,
  };
  if (csrfToken) headers['csrf-token'] = csrfToken;
  const response = await request.post('https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink', {
    headers,
    data: buildShortlinkBody(productUrl, safeSubs),
    timeout: SHORTEN_TIMEOUT_MS,
  });
  const status = typeof response.status === 'function' ? response.status() : response.status;
  const text = await response.text();
  return parseShopeeShortlinkResponse(status, text, productUrl);
}

async function shortenShopeeOnce(account, productUrl, subIds) {
  // Match the real Shopee Custom Link UI path: open/reuse the authenticated
  // affiliate page and let the in-page fetch run from that page context when
  // BrowserContext.request is rejected. Live UI proof (2026-07-03) showed the
  // logged-in page succeeds while request-only can return 403.
  const { record, page } = await browser.getPage('shopee', account, { headless: false });
  const safeSubs = [0, 1, 2, 3, 4].map((i) => String((subIds && subIds[i]) || '').trim());
  await browser.ensureOnPlatformPage(page, 'shopee');
  await recoverShopeeCustomLinkRoute(page);
  // Guard against a redirect-to-login (or any non-affiliate origin) that
  // ensureOnPlatformPage could not fully resolve: running page.evaluate from
  // the wrong Origin makes the in-page fetch fail CORS with "Failed to fetch",
  // which the retry classifier would otherwise interpret as a session error.
  if (typeof browser.isOnPlatformOrigin === 'function') {
    let currentUrl = '';
    try { currentUrl = page.url() || ''; } catch { currentUrl = ''; }
    if (!browser.isOnPlatformOrigin(currentUrl, 'shopee')) {
      throw new Error('Execution context was destroyed: redirected off affiliate.shopee.co.th');
    }
  }
  let contextRequestErr = null;
  try {
    const requestResult = await shortenShopeeViaContextRequest(record, page, productUrl, safeSubs);
    if (requestResult) return requestResult;
  } catch (err) {
    if (!isHttp401Or403Error(err)) throw err;
    contextRequestErr = err;
  }
  let result;
  try {
    result = await page.evaluate(
      new Function('args', `return (${SHORTEN_SCRIPT})(args);`),
      [productUrl, safeSubs],
    );
  } catch (err) {
    throw attachApiTransportDiagnostic(err, contextRequestErr);
  }
  if (!result || !result.shortLink) {
    throw attachApiTransportDiagnostic(
      new Error('No shortLink from Shopee: ' + JSON.stringify(result).substring(0, 200)),
      contextRequestErr,
    );
  }
  return result;
}

async function resettleShopeePage(account, { forceNew = false } = {}) {
  const { page } = await browser.getPage('shopee', account, { headless: true, forceNew });
  try {
    await page.goto(SHOPEE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {}
  if (typeof page.waitForLoadState === 'function') {
    try { await page.waitForLoadState('load', { timeout: 8000 }); } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
  }
  if (typeof page.waitForTimeout === 'function') {
    try { await page.waitForTimeout(500); } catch {}
  }
  // If the resettle landed somewhere other than affiliate.shopee.co.th
  // (e.g. a login-redirect followed a stale-cookie revalidation), give the
  // page one more goto so the next attempt's page.evaluate runs from the
  // correct Origin with the csrftoken cookie loaded.
  if (typeof browser.isOnPlatformOrigin === 'function') {
    let url = '';
    try { url = page.url() || ''; } catch { url = ''; }
    if (!browser.isOnPlatformOrigin(url, 'shopee')) {
      try { await page.goto(SHOPEE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
      if (typeof page.waitForLoadState === 'function') {
        try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
      }
    }
  }
  await recoverShopeeCustomLinkRoute(page);
}

async function recoverShopeeCustomLinkRoute(page) {
  let currentUrl = currentPageUrl(page);
  if (!isShopeeRouteNotFoundUrl(currentUrl)) return;

  for (const candidate of SHOPEE_CUSTOM_LINK_ROUTE_CANDIDATES) {
    if (!candidate) continue;
    try {
      await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {}
    if (typeof page.waitForLoadState === 'function') {
      try { await page.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch {}
      try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
    }
    if (typeof page.waitForTimeout === 'function') {
      try { await page.waitForTimeout(300); } catch {}
    }
    currentUrl = currentPageUrl(page) || currentUrl;
    if (!isShopeeRouteNotFoundUrl(currentUrl)) return;
  }

  throw createShopeeRouteNotFoundError(currentUrl);
}

async function shortenShopee(account, productUrl, subIds, opts = {}) {
  const onSessionExpired = typeof opts.onSessionExpired === 'function' ? opts.onSessionExpired : null;
  let lastErr = null;
  let lastWasNavIssue = false;
  let lastWasApiIssue = false;
  let lastWasNetIssue = false;
  let lastWasSessionIssue = false;
  let reauthAttempted = false;
  let opportunisticReauthAttempted = false;
  let lastReauthResult = null;
  let sawIneligibleError = false;
  for (let attempt = 1; attempt <= MAX_SHORTEN_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(shortenShopeeOnce(account, productUrl, subIds), SHORTEN_TIMEOUT_MS);
      recordLastSuccess(account, productUrl, subIds, result);
      return result;
    } catch (err) {
      lastErr = sanitizedErrorForSurface(err);
      if (!isFallbackEligibleError(err)) sawIneligibleError = true;
      const timeoutIssue = isTimeoutError(err);
      const offDomainRedirectIssue = !timeoutIssue && isShopeeOffDomainRedirect(err);
      const navIssue = !timeoutIssue && !offDomainRedirectIssue && isContextDestroyed(err);
      const sessionApiIssue = !timeoutIssue && !navIssue && isShopeeSessionApiError(err);
      const apiIssue = !timeoutIssue && !navIssue && !sessionApiIssue && isTransientApiError(err);
      // Reauth is only safe when the classifier actually says *auth* —
      // pure network blips (Failed to fetch / ERR_*), API transients and
      // timeouts must not trigger a relogin. A network error from inside
      // page.evaluate is almost always a cross-origin redirect (Shopee
      // bounced us off affiliate.shopee.co.th), recoverable by re-navigation.
      const netIssue = !timeoutIssue && !navIssue && !apiIssue && isNetworkRecoverable(err);
      const failCode3Issue = !timeoutIssue && !navIssue && !apiIssue && !netIssue && isShopeeFailCode3(err);
      const sessionIssue = (
        offDomainRedirectIssue
        ||
        sessionApiIssue
        || failCode3Issue
        || (!timeoutIssue && !navIssue && !apiIssue && !netIssue && isAuthSessionError(err))
      );
      const recoverable = navIssue || timeoutIssue || apiIssue || netIssue || sessionIssue;
      lastWasSessionIssue = sessionIssue;
      const tag = recoverable
        ? (timeoutIssue
            ? 'recoverable:timeout'
            : navIssue
              ? 'recoverable:nav'
              : apiIssue
                ? 'recoverable:api'
                : netIssue
                  ? 'recoverable:net'
                  : 'recoverable:session')
        : 'fatal';
      console.warn(`[shopee:${account}] attempt ${attempt}/${MAX_SHORTEN_ATTEMPTS} failed (${tag}): ${lastErr.message}`);
      if (!recoverable || attempt === MAX_SHORTEN_ATTEMPTS) break;
      await sleep(BETWEEN_ATTEMPT_DELAY_MS[attempt] || 3500);
      if (sessionIssue && !reauthAttempted && onSessionExpired) {
        reauthAttempted = true;
        try {
          const reauth = await onSessionExpired({ platform: 'shopee', account, attempt, error: err });
          lastReauthResult = reauth || null;
          if (reauth && reauth.manualLoginRequired) {
            throw createManualLoginRequiredError(reauth);
          }
        } catch (reauthErr) {
          if (reauthErr && reauthErr.manualLoginRequired) throw reauthErr;
        }
      } else if (sessionIssue && reauthAttempted && onSessionExpired) {
        const blockErr = new Error('MANUAL_LOGIN_REQUIRED');
        blockErr.manualLoginRequired = true;
        blockErr.reason = postReauthFailureReason(err, lastReauthResult);
        blockErr.diagnostic = buildPostReauthDiagnostic(err, lastReauthResult, attempt, blockErr.reason);
        throw blockErr;
      }
      // A timeout means the page/evaluate is wedged — close the persistent
      // context and reopen so the next attempt does not inherit the hang.
      // Consecutive nav/API/net failures also escalate to a fresh context so
      // a poisoned tab can't keep failing forever.
      const preserveReauthContext = reauthPreservesContext(lastReauthResult);
      const forceNew = timeoutIssue
        || (navIssue && lastWasNavIssue)
        || (apiIssue && lastWasApiIssue)
        || navIssue
        || (sessionIssue && !preserveReauthContext)
        || (netIssue && lastWasNetIssue);
      try {
        await resettleShopeePage(account, { forceNew });
      } catch {}
      lastWasNavIssue = navIssue;
      lastWasApiIssue = apiIssue;
      lastWasNetIssue = netIssue;
    }
  }
  // Retries exhausted. If every observed failure was a recoverable transient
  // (timeout / nav / API 90309999 / network) and this exact (account, url,
  // subIds) previously succeeded, serve the cached shortlink so a brief
  // Shopee hiccup does not surface as a user-visible 90309999. Real
  // auth/session/manual-login and fatal failCodes always bubble up.
  if (!sawIneligibleError) {
    const cached = getLastSuccess(account, productUrl, subIds);
    if (cached) {
      console.warn(`[shopee:${account}] retries exhausted — serving last-known-good shortlink fallback`);
      return Object.assign({}, cached, { fallback: 'last_success' });
    }
  }
  // Some Shopee route/state/API errors are not classified as session issues
  // but still recover after a Keychain-backed login refresh. Give those one
  // bounded reauth + fresh-context retry before surfacing the original error.
  if (
    onSessionExpired
    && !reauthAttempted
    && !opportunisticReauthAttempted
    && !lastWasSessionIssue
    && !isFailClosedShopeeValidationError(lastErr)
  ) {
    opportunisticReauthAttempted = true;
    try {
      const reauth = await onSessionExpired({
        platform: 'shopee',
        account,
        attempt: MAX_SHORTEN_ATTEMPTS + 1,
        error: lastErr,
        opportunistic: true,
      });
      lastReauthResult = reauth || null;
      if (reauth && reauth.manualLoginRequired) {
        throw createManualLoginRequiredError(reauth);
      }
    } catch (reauthErr) {
      if (reauthErr && reauthErr.manualLoginRequired) throw reauthErr;
    }
    try {
      await resettleShopeePage(account, { forceNew: true });
    } catch {}
    try {
      const result = await withTimeout(shortenShopeeOnce(account, productUrl, subIds), SHORTEN_TIMEOUT_MS);
      recordLastSuccess(account, productUrl, subIds, result);
      return result;
    } catch (retryErr) {
      lastErr = sanitizedErrorForSurface(retryErr);
      if (
        isShopeeOffDomainRedirect(retryErr)
        || isShopeeSessionApiError(retryErr)
        || isShopeeFailCode3(retryErr)
        || isAuthSessionError(retryErr)
      ) {
        const blockErr = new Error('MANUAL_LOGIN_REQUIRED');
        blockErr.manualLoginRequired = true;
        blockErr.reason = postReauthFailureReason(retryErr, lastReauthResult);
        blockErr.diagnostic = buildPostReauthDiagnostic(retryErr, lastReauthResult, MAX_SHORTEN_ATTEMPTS + 1, blockErr.reason);
        throw blockErr;
      }
    }
  }
  throw lastErr;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  shortenShopee,
  isSessionLikelyExpired,
  isAuthSessionError,
  isNetworkRecoverable,
  isContextDestroyed,
  isTransientApiError,
  isShopeeFailCode3,
  isShopeeOffDomainRedirect,
  isShopeeSessionApiError,
  isTimeoutError,
  isRecoverableShortenError,
  isFallbackEligibleError,
  sanitizeShopeeErrorMessageForLog,
  recoverShopeeCustomLinkRoute,
  _resetLastSuccessCache,
  _SHOPEE_SHORTEN_SCRIPT_FOR_TEST: SHORTEN_SCRIPT,
  _buildShortlinkBodyForTest: buildShortlinkBody,
  _sanitizeShopeeSubIdForTest: sanitizeShopeeSubId,
};
