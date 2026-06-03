'use strict';

const http = require('http');
const url = require('url');

const {
  DEFAULT_PORT,
  DEFAULT_HOST,
  PROFILE_ROOT,
  SHOPEE_URL,
  SHOPEE_LOGIN_URL,
  LAZADA_URL,
  LAZADA_LOGIN_URL,
} = require('./config');
const {
  sanitizeAccount,
  sanitizePlatform,
  ensureProfileDir,
  listAccounts,
  DEFAULT_ACCOUNT,
} = require('./accounts');
const { detectPlatform } = require('./platforms');
const {
  resolveOriginalLink,
  resolveTrackingLink,
  extractMemberIdFromUrl,
  extractMemberIdFromData,
  extractUtmSource,
  normalizeShopeeOriginalLink,
} = require('./normalize');
const {
  buildShopeeShortlinkPayload,
  buildLazadaShortlinkPayload,
} = require('./payload');
const { shortenShopee } = require('./shopee');
const { shortenLazada } = require('./lazada');
const browser = require('./browser');
const { attemptLogin, captureLoginDiagnostics, detectManualBlocker } = require('./login');
const keychain = require('./keychain');
const {
  SHOPEE_ROUTE_NOT_FOUND_REASON,
  SHOPEE_CUSTOM_LINK_LOGIN_REQUIRED_REASON,
  currentPageUrl: currentShopeeRoutePageUrl,
  isShopeeRouteNotFoundUrl,
  validateShopeeCustomLinkSession,
  shopeeCustomLinkLoginRequiredDiagnostic,
  sanitizeDiagnosticUrl: sanitizeShopeeDiagnosticUrl,
} = require('./shopee-route');
const {
  resolveShopeeAccountMetadataFromId,
  normalizeShopeeAffiliateId,
} = require('./shopee-accounts');
const clickReport = require('./click-report');
const conversionReport = require('./conversion-report');

const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_RECENT_LOGIN_DIAGNOSTICS = 8;
const recentLoginDiagnostics = [];

// A profile dir + an affiliate origin no longer means "ready". Anything older
// than this is treated as unknown so the shorten preflight re-validates the
// protected route before calling batchCustomLink.
const SESSION_FRESHNESS_MS = 5 * 60 * 1000;

// Per-account session validity snapshots. Keyed by `${platform}::${account}`.
// Populated whenever the bridge probes the custom_link route during reauth or
// the JSON login endpoint, so /accounts and /debug can expose the difference
// between credentialPresent (Keychain) and sessionValid (live route check).
const sessionStateCache = new Map();
const MAX_SESSION_STATE_ENTRIES = 32;

function sessionStateKey(platform, account) {
  return `${sanitizePlatform(platform) || ''}::${sanitizeAccount(account) || ''}`;
}

function recordSessionState(platform, account, state) {
  const p = sanitizePlatform(platform);
  if (!p) return null;
  const key = sessionStateKey(p, account);
  const prev = sessionStateCache.get(key) || {};
  const safeUrl = state && typeof state.currentUrl === 'string' ? state.currentUrl : '';
  const sanitizedUrl = safeUrl ? sanitizeShopeeDiagnosticUrl(safeUrl) : (prev.sanitizedUrl || '');
  const now = new Date().toISOString();
  const sessionValidRaw = state ? state.sessionValid : undefined;
  const sessionValid = sessionValidRaw == null ? null : !!sessionValidRaw;
  const customLinkRaw = state ? state.customLinkAuthenticated : undefined;
  const customLinkAuthenticated = customLinkRaw === undefined
    ? (prev.customLinkAuthenticated == null ? null : !!prev.customLinkAuthenticated)
    : (customLinkRaw == null ? null : !!customLinkRaw);
  const reason = state && state.reason !== undefined ? String(state.reason) : '';
  const needsManualRaw = state ? state.needsManual : undefined;
  const needsManual = needsManualRaw != null
    ? !!needsManualRaw
    : (sessionValid === false);
  const entry = {
    platform: p,
    account: sanitizeAccount(account),
    sessionValid,
    customLinkAuthenticated,
    reason,
    sanitizedUrl,
    checkedAt: now,
    lastCheckedAt: now,
    lastSuccessAt: sessionValid === true ? now : (prev.lastSuccessAt || ''),
    lastFailureReason: sessionValid === false
      ? (reason || prev.lastFailureReason || '')
      : (sessionValid === true ? '' : (prev.lastFailureReason || '')),
    needsManual,
  };
  if (sessionStateCache.has(key)) sessionStateCache.delete(key);
  sessionStateCache.set(key, entry);
  while (sessionStateCache.size > MAX_SESSION_STATE_ENTRIES) {
    const oldestKey = sessionStateCache.keys().next().value;
    if (oldestKey === undefined) break;
    sessionStateCache.delete(oldestKey);
  }
  return entry;
}

function isSessionSnapshotFresh(snapshot, nowMs = Date.now()) {
  if (!snapshot || !snapshot.lastCheckedAt) return false;
  const ts = Date.parse(snapshot.lastCheckedAt);
  if (!Number.isFinite(ts)) return false;
  return (nowMs - ts) < SESSION_FRESHNESS_MS;
}

function getSessionStateSnapshot(platform, account) {
  const p = sanitizePlatform(platform);
  if (!p) return null;
  const entry = sessionStateCache.get(sessionStateKey(p, account));
  return entry ? Object.assign({}, entry) : null;
}

function listSessionStateSnapshots() {
  return Array.from(sessionStateCache.values()).map((entry) => Object.assign({}, entry));
}

function _resetSessionStateCacheForTest() {
  sessionStateCache.clear();
}

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactValue(text, value) {
  if (!value) return String(text || '');
  const haystack = String(text || '');
  if (!haystack) return haystack;
  try {
    return haystack.split(value).join('[REDACTED]');
  } catch {
    return haystack.replace(new RegExp(escapeForRegex(value), 'g'), '[REDACTED]');
  }
}

function recordLoginDiagnostic(diagnostic, meta = {}) {
  if (!diagnostic || typeof diagnostic !== 'object') return null;
  const safe = Object.assign({}, diagnostic, {
    source: String(meta.source || diagnostic.source || ''),
    account: sanitizeAccount(meta.account || diagnostic.account || ''),
    platform: sanitizePlatform(meta.platform || diagnostic.platform) || String(diagnostic.platform || ''),
  });
  recentLoginDiagnostics.unshift(safe);
  if (recentLoginDiagnostics.length > MAX_RECENT_LOGIN_DIAGNOSTICS) {
    recentLoginDiagnostics.length = MAX_RECENT_LOGIN_DIAGNOSTICS;
  }
  return safe;
}

function recentLoginDiagnosticsForDebug() {
  return recentLoginDiagnostics.map((item) => item && typeof item === 'object' ? Object.assign({}, item) : item);
}

function sendJson(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

function sendHtml(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
}

function isTruthyFlag(value) {
  if (value === true) return true;
  const str = String(value == null ? '' : value).trim().toLowerCase();
  return str === '1' || str === 'true' || str === 'yes' || str === 'on';
}

function isExplicitFalseFlag(value) {
  if (value === false) return true;
  const str = String(value == null ? '' : value).trim().toLowerCase();
  return str === '0' || str === 'false' || str === 'no' || str === 'off';
}

// remember defaults to true: missing/null/empty/unrecognized => true.
// Only explicit false-y forms (false, '0', 'false', 'no', 'off') disable saving.
function parseRememberFlag(value) {
  if (value === undefined || value === null) return true;
  if (value === false) return false;
  if (value === true) return true;
  const str = String(value).trim().toLowerCase();
  if (!str) return true;
  if (str === '0' || str === 'false' || str === 'no' || str === 'off') return false;
  return true;
}

function sanitizePublicDiagnosticValue(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/[^A-Za-z0-9@._:-]/g, '_')
    .slice(0, 128);
}

function expectedShopeeUtmSourceForId(id) {
  const normalized = normalizeShopeeAffiliateId(id);
  return normalized ? `an_${normalized}` : '';
}

function shopeeAffiliateValidationError(reason, details = {}) {
  const normalizedRequestedId = normalizeShopeeAffiliateId(details.requestedId);
  const requestedId = normalizedRequestedId || sanitizePublicDiagnosticValue(details.requestedId || '');
  const expectedUtmSource = sanitizePublicDiagnosticValue(
    details.expectedUtmSource || expectedShopeeUtmSourceForId(normalizedRequestedId),
  );
  const actualUtmSource = sanitizePublicDiagnosticValue(details.actualUtmSource || '');
  const account = details.account ? sanitizeAccount(details.account) : '';
  const displayAccount = sanitizePublicDiagnosticValue(details.displayAccount || '');
  const requestedAccount = details.requestedAccount
    ? sanitizeAccount(details.requestedAccount)
    : '';
  const message = String(details.message || reason).trim();
  const payload = {
    status: 'error',
    error: reason,
    reason,
    platform: 'shopee',
    message,
  };
  if (requestedId) payload.requestedId = requestedId;
  if (expectedUtmSource) payload.expected_utm_source = expectedUtmSource;
  if (Object.prototype.hasOwnProperty.call(details, 'actualUtmSource')) {
    payload.actual_utm_source = actualUtmSource;
  }
  if (account) payload.account = account;
  if (displayAccount) payload.displayAccount = displayAccount;
  if (requestedAccount) payload.requestedAccount = requestedAccount;

  const err = new Error(message);
  err.reason = reason;
  err.statusCode = 400;
  err.publicPayload = payload;
  return err;
}

function clientWantsJson(req, query) {
  if (isTruthyFlag(query && query.json)) return true;
  const accept = String((req && req.headers && req.headers.accept) || '').toLowerCase();
  if (!accept) return false;
  if (accept.includes('text/html')) return false;
  if (accept.includes('application/json')) return true;
  return false;
}

function buildLoginUiUrlForRetry(platform /* , account, rawUrl, sub1 */) {
  const params = new URLSearchParams();
  if (platform) params.set('platform', platform);
  const qs = params.toString();
  return qs ? '/login?' + qs : '/login';
}

function currentPageUrl(page) {
  try {
    return page && typeof page.url === 'function' ? String(page.url() || '') : '';
  } catch {
    return '';
  }
}

async function shopeeRouteNotFoundReauthResult(page, platform, account, source, secrets = []) {
  if (platform !== 'shopee') return null;
  if (!isShopeeRouteNotFoundUrl(currentShopeeRoutePageUrl(page))) return null;
  const diagnostic = recordLoginDiagnostic(
    await captureLoginDiagnostics(page, platform, SHOPEE_ROUTE_NOT_FOUND_REASON, secrets),
    { platform, account, source },
  );
  return {
    ok: false,
    manualLoginRequired: true,
    reason: SHOPEE_ROUTE_NOT_FOUND_REASON,
    diagnostic,
  };
}

// Probe https://affiliate.shopee.co.th/offer/custom_link and report whether
// the live session is actually authorized for the protected custom_link
// route. Dashboard/origin alone is not enough — Shopee redirects a stale
// affiliate session to /buyer/login even when the user looks logged-in on
// the portal home. Result is cached per (platform, account) so /accounts and
// /debug can surface credentialPresent vs sessionValid.
async function probeShopeeCustomLinkSession(page, platform, account, source, secrets = []) {
  if (platform !== 'shopee') return null;
  const probe = await validateShopeeCustomLinkSession(page);
  const sanitizedUrl = probe && probe.sanitizedUrl ? probe.sanitizedUrl : '';
  if (probe && probe.ok) {
    recordSessionState(platform, account, {
      sessionValid: true,
      customLinkAuthenticated: true,
      reason: '',
      currentUrl: probe.currentUrl,
    });
    return {
      ok: true,
      sessionValid: true,
      customLinkAuthenticated: true,
      currentUrl: sanitizedUrl,
      reason: '',
    };
  }
  const reason = (probe && probe.reason) || SHOPEE_CUSTOM_LINK_LOGIN_REQUIRED_REASON;
  recordSessionState(platform, account, {
    sessionValid: false,
    customLinkAuthenticated: false,
    reason,
    currentUrl: probe && probe.currentUrl,
  });
  if (reason === SHOPEE_ROUTE_NOT_FOUND_REASON) {
    const diagnostic = recordLoginDiagnostic(
      await captureLoginDiagnostics(page, platform, reason, secrets),
      { platform, account, source },
    );
    return {
      ok: false,
      sessionValid: false,
      customLinkAuthenticated: false,
      manualLoginRequired: true,
      reason,
      diagnostic,
      currentUrl: sanitizedUrl,
    };
  }
  const diagnostic = recordLoginDiagnostic(
    shopeeCustomLinkLoginRequiredDiagnostic(probe && probe.currentUrl, reason),
    { platform, account, source },
  );
  return {
    ok: false,
    sessionValid: false,
    customLinkAuthenticated: false,
    manualLoginRequired: true,
    reason,
    diagnostic,
    currentUrl: sanitizedUrl,
  };
}

function isLoginUrl(platform, currentUrl) {
  const value = String(currentUrl || '');
  if (!value) return false;
  if (platform === 'shopee') {
    return /affiliate\.shopee\.co\.th\/login|shopee\.co\.th\/buyer\/login/i.test(value);
  }
  if (platform === 'lazada') {
    return /member\.lazada\.co\.th\/user\/login|login/i.test(value);
  }
  return /login/i.test(value);
}

function isAlreadyAuthenticatedOrigin(page, platform) {
  const pageUrl = currentPageUrl(page);
  if (!pageUrl || isLoginUrl(platform, pageUrl)) return false;
  if (platform === 'shopee' && isShopeeRouteNotFoundUrl(pageUrl)) return false;
  if (typeof browser.isOnPlatformOrigin !== 'function') return false;
  return browser.isOnPlatformOrigin(pageUrl, platform);
}

function credentialAccountCandidates(account) {
  const exact = sanitizeAccount(account);
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const cleaned = sanitizeAccount(value);
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  add(exact);
  const lower = String(exact || '').toLowerCase();
  if (lower && lower !== exact) add(lower);
  if (lower && lower !== DEFAULT_ACCOUNT && !lower.startsWith('affiliate_')) {
    add(`affiliate_${lower}.com`);
    add(`affiliate_${lower}`);
  }
  return out;
}

function credentialLookupMetadata(platform, account, candidates) {
  const p = sanitizePlatform(platform);
  const a = sanitizeAccount(account);
  const candidateAccounts = Array.isArray(candidates) && candidates.length
    ? candidates.map((candidate) => sanitizeAccount(candidate))
    : credentialAccountCandidates(a);
  const seen = new Set();
  const uniqueAccounts = [];
  for (const candidate of candidateAccounts) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    uniqueAccounts.push(candidate);
  }
  return {
    platform: p,
    account: a,
    servicePrefix: keychain.SERVICE_PREFIX,
    checkedAccounts: uniqueAccounts,
    expectedServices: p ? uniqueAccounts.map((candidate) => keychain.serviceName(p, candidate)) : [],
  };
}

function keychainCredentialNotFoundResult(platform, account, lookup) {
  const keychainCredential = Object.assign({ present: false }, lookup || credentialLookupMetadata(platform, account));
  return {
    ok: false,
    manualLoginRequired: true,
    reason: 'keychain_credential_not_found',
    keychainCredential,
    diagnostic: {
      reason: 'keychain_credential_not_found',
      platform: keychainCredential.platform,
      source: 'auto_reauth_keychain',
      keychainCredential,
    },
  };
}

async function findStoredCredentialForAccount(platform, account) {
  const candidates = credentialAccountCandidates(account);
  const lookup = credentialLookupMetadata(platform, account, candidates);
  for (const candidate of candidates) {
    const cred = await keychain.findCredential(platform, candidate);
    if (cred && cred.password && cred.username) {
      return { credential: cred, credentialAccount: candidate, lookup };
    }
  }
  return { credential: null, credentialAccount: '', lookup };
}

async function hasStoredCredentialForAccount(platform, account) {
  const candidates = credentialAccountCandidates(account);
  for (const candidate of candidates) {
    try {
      const info = await keychain.hasCredential(platform, candidate);
      if (info) return true;
    } catch {}
  }
  return false;
}

function knownAccountsByPlatform(credentials = []) {
  const out = { shopee: new Set(), lazada: new Set() };
  let profileAccounts = { shopee: [], lazada: [] };
  try {
    profileAccounts = listAccounts();
  } catch {}
  for (const platform of ['shopee', 'lazada']) {
    const list = Array.isArray(profileAccounts[platform]) ? profileAccounts[platform] : [];
    for (const account of list) out[platform].add(sanitizeAccount(account));
  }
  for (const loaded of browser.listLoadedContexts()) {
    const platform = sanitizePlatform(loaded && loaded.platform);
    if (!platform) continue;
    out[platform].add(sanitizeAccount(loaded && loaded.account));
  }
  for (const item of Array.isArray(credentials) ? credentials : []) {
    const platform = sanitizePlatform(item && item.platform);
    if (!platform) continue;
    out[platform].add(sanitizeAccount(item && item.account));
  }
  return {
    shopee: Array.from(out.shopee).sort(),
    lazada: Array.from(out.lazada).sort(),
  };
}

async function credentialPresenceForAccounts() {
  if (!keychain.isSupported()) {
    return { keychainSupported: false, accounts: { shopee: {}, lazada: {} } };
  }
  let credentials = [];
  try {
    credentials = await keychain.listCredentials();
  } catch {
    credentials = [];
  }
  const known = knownAccountsByPlatform(credentials);
  const accounts = { shopee: {}, lazada: {} };
  for (const platform of ['shopee', 'lazada']) {
    for (const account of known[platform]) {
      accounts[platform][account] = await hasStoredCredentialForAccount(platform, account);
    }
  }
  return { keychainSupported: true, accounts };
}

async function attemptReauthWithStoredCredential(platform, account, opts = {}) {
  if (!keychain.isSupported()) {
    return { ok: false, manualLoginRequired: true, reason: 'keychain_unavailable' };
  }
  let cred = null;
  let lookup = credentialLookupMetadata(platform, account);
  try {
    const found = await findStoredCredentialForAccount(platform, account);
    cred = found.credential;
    lookup = found.lookup || lookup;
  } catch (err) {
    return {
      ok: false,
      manualLoginRequired: true,
      reason: 'keychain_lookup_failed',
      keychainCredential: Object.assign({ present: false }, lookup),
    };
  }
  if (!cred || !cred.password || !cred.username) {
    return keychainCredentialNotFoundResult(platform, account, lookup);
  }
  const loginUrl = platform === 'shopee' ? SHOPEE_LOGIN_URL : LAZADA_LOGIN_URL;
  let loginRecord;
  try {
    loginRecord = await browser.getPage(platform, account, {
      headless: !!opts.headless,
      forceNew: !!opts.forceNew,
    });
  } catch (err) {
    const msg = redactValue(err && err.message ? err.message : String(err), cred.password);
    return { ok: false, manualLoginRequired: true, reason: `browser_unavailable: ${msg}` };
  }
  const page = loginRecord.page;
  try { if (page.bringToFront) await page.bringToFront(); } catch {}
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {}
  if (typeof page.waitForLoadState === 'function') {
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
  }
  const loginRouteIssue = await shopeeRouteNotFoundReauthResult(
    page,
    platform,
    account,
    'auto_reauth_login_route',
    [cred.username, cred.password],
  );
  if (loginRouteIssue) return loginRouteIssue;
  // Shopee/Lazada redirect their login URL to the authenticated affiliate
  // origin (e.g. /dashboard) when the stored session is still valid. The
  // dashboard has no password input, so attemptLogin would mis-report
  // password_field_not_found and block a perfectly working session. Origin
  // alone is not enough though — Shopee bounces a stale affiliate session
  // through /dashboard before redirecting protected routes to /buyer/login.
  // Verify the actual custom_link route before claiming authenticated.
  if (isAlreadyAuthenticatedOrigin(page, platform)) {
    if (platform === 'shopee') {
      const probeResult = await probeShopeeCustomLinkSession(
        page,
        platform,
        account,
        'auto_reauth_already_authenticated_probe',
        [cred.username, cred.password],
      );
      if (probeResult && !probeResult.ok) return probeResult;
      return {
        ok: true,
        manualLoginRequired: false,
        alreadyAuthenticated: true,
        reuseAuthenticatedContext: true,
        sessionValid: true,
        customLinkAuthenticated: true,
        currentUrl: probeResult ? probeResult.currentUrl : '',
      };
    }
    return {
      ok: true,
      manualLoginRequired: false,
      alreadyAuthenticated: true,
      reuseAuthenticatedContext: true,
    };
  }
  let result;
  try {
    result = await attemptLogin(page, platform, cred.username, cred.password, { submit: true });
  } catch (err) {
    const msg = redactValue(err && err.message ? err.message : String(err), cred.password);
    return { ok: false, manualLoginRequired: true, reason: `auto_login_threw: ${msg}` };
  }
  if (!result || result.needsManual) {
    const diagnostic = result && result.diagnostic
      ? recordLoginDiagnostic(result.diagnostic, { platform, account, source: 'auto_reauth' })
      : null;
    return {
      ok: false,
      manualLoginRequired: true,
      reason: redactValue((result && result.reason) || 'manual_step_required', cred.password),
      diagnostic,
    };
  }
  try {
    const target = platform === 'shopee' ? SHOPEE_URL : LAZADA_URL;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {}
  if (typeof page.waitForLoadState === 'function') {
    try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
  }
  const targetRouteIssue = await shopeeRouteNotFoundReauthResult(
    page,
    platform,
    account,
    'auto_reauth_post_login_route',
    [cred.username, cred.password],
  );
  if (targetRouteIssue) return targetRouteIssue;
  const afterUrl = currentPageUrl(page);
  const stillOnLogin = isLoginUrl(platform, afterUrl);
  let onExpectedOrigin = false;
  if (platform === 'shopee' && typeof browser.isOnPlatformOrigin === 'function') {
    onExpectedOrigin = browser.isOnPlatformOrigin(afterUrl, 'shopee') && !stillOnLogin;
  } else if (platform === 'lazada' && typeof browser.isOnPlatformOrigin === 'function') {
    onExpectedOrigin = browser.isOnPlatformOrigin(afterUrl, 'lazada') && !stillOnLogin;
  } else {
    onExpectedOrigin = !!afterUrl && !stillOnLogin;
  }
  if (!onExpectedOrigin) {
    const postLoginBlocker = await detectManualBlocker(page);
    const reason = postLoginBlocker || 'login_still_required';
    const diagnostic = recordLoginDiagnostic(
      await captureLoginDiagnostics(page, platform, reason, [cred.username, cred.password]),
      { platform, account, source: 'auto_reauth_post_login' },
    );
    return {
      ok: false,
      manualLoginRequired: true,
      reason: redactValue(reason, cred.password),
      diagnostic,
    };
  }
  if (platform === 'shopee') {
    const probeResult = await probeShopeeCustomLinkSession(
      page,
      platform,
      account,
      'auto_reauth_post_login_custom_link_probe',
      [cred.username, cred.password],
    );
    if (probeResult && !probeResult.ok) return probeResult;
    return {
      ok: true,
      manualLoginRequired: false,
      reuseAuthenticatedContext: true,
      sessionValid: true,
      customLinkAuthenticated: true,
      currentUrl: probeResult ? probeResult.currentUrl : '',
    };
  }
  return { ok: true, manualLoginRequired: false, reuseAuthenticatedContext: true };
}

async function handleShorten(query, opts = {}) {
  const rawUrl = String(query.url || '').trim();
  if (!rawUrl) throw new Error('Missing required parameter: url');

  const explicitPlatform = sanitizePlatform(query.platform);
  const platform = explicitPlatform || detectPlatform(rawUrl);
  if (!platform) throw new Error(`Cannot detect platform from url: ${rawUrl}`);

  const rawAccount = String(query.account || '').trim();
  const rawShopeeId = String(query.id == null ? '' : query.id).trim();
  const explicitId = normalizeShopeeAffiliateId(rawShopeeId);
  let account;
  let responseAccount;
  if (platform === 'shopee' && rawShopeeId && !explicitId) {
    throw shopeeAffiliateValidationError('shopee_affiliate_id_invalid', {
      requestedId: rawShopeeId,
      requestedAccount: rawAccount,
      message: 'Invalid Shopee affiliate id',
    });
  }
  if (platform === 'shopee' && explicitId) {
    const resolvedAccount = resolveShopeeAccountMetadataFromId(explicitId);
    if (!resolvedAccount || !resolvedAccount.account) {
      throw shopeeAffiliateValidationError('shopee_affiliate_id_unknown', {
        requestedId: explicitId,
        expectedUtmSource: expectedShopeeUtmSourceForId(explicitId),
        requestedAccount: rawAccount,
        message: 'Unknown Shopee affiliate id: ' + explicitId,
      });
    }
    account = sanitizeAccount(resolvedAccount.account);
    responseAccount = String(resolvedAccount.displayAccount || account).trim();
    if (rawAccount && sanitizeAccount(rawAccount) !== account) {
      throw shopeeAffiliateValidationError('shopee_affiliate_account_conflict', {
        requestedId: explicitId,
        expectedUtmSource: expectedShopeeUtmSourceForId(explicitId),
        requestedAccount: rawAccount,
        account,
        displayAccount: responseAccount,
        message: 'Shopee affiliate id does not match requested account',
      });
    }
  } else if (rawAccount) {
    account = sanitizeAccount(rawAccount);
    responseAccount = account;
  } else {
    account = sanitizeAccount(query.account);
    responseAccount = account;
  }
  const autoReauth = opts.autoReauth !== false;

  const onSessionExpired = autoReauth
    ? (info) => attemptReauthWithStoredCredential(info.platform, info.account, { headless: true, forceNew: true })
    : null;

  if (platform === 'shopee') {
    await ensureShopeeReadyForShorten(account);
    const resolvedOriginalLink = await resolveOriginalLink(rawUrl);
    const productUrl = normalizeShopeeOriginalLink(resolvedOriginalLink || rawUrl) || (resolvedOriginalLink || rawUrl);
    const d = await shortenShopee(
      account,
      productUrl,
      [query.sub1, query.sub2, query.sub3, query.sub4, query.sub5],
      { onSessionExpired },
    );
    const resolvedShortLink = await resolveTrackingLink(d.shortLink);
    const actualUtmSource = extractUtmSource(resolvedShortLink);
    if (explicitId) {
      const expectedUtmSource = expectedShopeeUtmSourceForId(explicitId);
      if (actualUtmSource !== expectedUtmSource) {
        throw shopeeAffiliateValidationError('shopee_affiliate_utm_source_mismatch', {
          requestedId: explicitId,
          expectedUtmSource,
          actualUtmSource,
          account,
          displayAccount: responseAccount,
          message: actualUtmSource
            ? 'Shopee shortLink resolved to the wrong affiliate utm_source'
            : 'Shopee shortLink resolved without an affiliate utm_source',
        });
      }
    }
    return buildShopeeShortlinkPayload({
      link: rawUrl,
      longLink: d.longLink || resolvedOriginalLink || '',
      shortLink: d.shortLink,
      id: explicitId,
      utmSource: actualUtmSource,
      account: responseAccount,
      sub1: query.sub1 || '',
    });
  }

  const resolvedOriginalLink = await resolveOriginalLink(rawUrl);
  const d = await shortenLazada(account, rawUrl, { onSessionExpired });
  const resolvedShortLink = await resolveTrackingLink(d.promotionLink);
  return buildLazadaShortlinkPayload({
    link: rawUrl,
    longLink: resolvedOriginalLink,
    shortLink: d.promotionLink,
    memberId: extractMemberIdFromUrl(resolvedShortLink) || extractMemberIdFromData(d),
    promotionCode: d.promotionCode || '',
    account,
    sub1: query.sub1 || '',
  });
}

async function handleLogin(query) {
  const platform = sanitizePlatform(query.platform);
  if (!platform) throw new Error(`Invalid or missing platform (expected shopee|lazada)`);
  const account = sanitizeAccount(query.account);
  const profileDir = ensureProfileDir(platform, account);
  const target = platform === 'shopee' ? SHOPEE_LOGIN_URL : LAZADA_LOGIN_URL;
  const explicitAutofill = isTruthyFlag(query.autofill) || isTruthyFlag(query.autoFill);
  const autofillOptOut = isExplicitFalseFlag(query.autofill)
    || isExplicitFalseFlag(query.autoFill)
    || isTruthyFlag(query.noAutofill)
    || isTruthyFlag(query.noAutoFill);
  if (!autofillOptOut) {
    const autofillResult = await attemptReauthWithStoredCredential(platform, account, {
      headless: false,
      forceNew: false,
    });
    if (!explicitAutofill && (
      autofillResult.reason === 'keychain_credential_not_found'
      || autofillResult.reason === 'keychain_unavailable'
      || autofillResult.reason === 'keychain_lookup_failed'
    )) {
      const { page } = await browser.getPage(platform, account, { headless: false, forceVisible: true });
      await page.bringToFront().catch(() => {});
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return {
        status: 'login_window_opened',
        platform,
        account,
        profileDir,
        loginUrl: target,
        backend: browser.backendInfo(),
      };
    }
    // Custom-link probe truth is the load-bearing signal: origin/dashboard
    // alone can lie when Shopee redirects protected routes to /buyer/login.
    const sessionValid = !!(autofillResult.ok && autofillResult.sessionValid);
    const customLinkAuthenticated = autofillResult.customLinkAuthenticated == null
      ? null
      : !!autofillResult.customLinkAuthenticated;
    const response = {
      status: autofillResult.ok ? 'login_autofill_completed' : (autofillResult.reason || 'login_autofill_failed'),
      platform,
      account,
      profileDir,
      loginUrl: target,
      autofill: {
        attempted: true,
        ok: !!autofillResult.ok,
        needsManual: !!autofillResult.manualLoginRequired,
        reason: autofillResult.reason || '',
        alreadyAuthenticated: !!autofillResult.alreadyAuthenticated,
        sessionValid,
        customLinkAuthenticated,
        currentUrl: autofillResult.currentUrl
          ? sanitizeShopeeDiagnosticUrl(autofillResult.currentUrl)
          : '',
      },
      sessionValid,
      customLinkAuthenticated,
      currentUrl: autofillResult.currentUrl
        ? sanitizeShopeeDiagnosticUrl(autofillResult.currentUrl)
        : '',
      reason: autofillResult.reason || undefined,
      backend: browser.backendInfo(),
    };
    if (autofillResult.keychainCredential) {
      response.keychainCredential = autofillResult.keychainCredential;
    }
    if (autofillResult.diagnostic) {
      response.diagnostic = autofillResult.diagnostic;
      response.debug = '/debug';
    }
    return response;
  }
  const { page } = await browser.getPage(platform, account, { headless: false, forceVisible: true });
  await page.bringToFront().catch(() => {});
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  return {
    status: 'login_window_opened',
    platform,
    account,
    profileDir,
    loginUrl: target,
    backend: browser.backendInfo(),
  };
}

async function handleAccounts() {
  const credentialPresence = await credentialPresenceForAccounts();
  const accountsList = listAccounts();
  const loadedContexts = browser.listLoadedContexts();
  return {
    profileRoot: PROFILE_ROOT,
    defaultAccount: DEFAULT_ACCOUNT,
    accounts: accountsList,
    loaded: loadedContexts,
    credentialPresence,
    sessionState: buildAccountsSessionState(credentialPresence, accountsList, loadedContexts),
  };
}

// Cross-reference Keychain presence against the latest custom_link probe so
// callers can see at a glance when credentialPresent != sessionValid (the
// exact failure mode that was previously masked by alreadyAuthenticated).
// A directory-only profile (profileExists=true) with no credential and no
// fresh sessionValid=true probe must surface as ready=false / needsManual=true,
// so Hermes never treats a blank profile as a usable account.
function buildAccountsSessionState(credentialPresence, accountsList = null, loadedContexts = null) {
  const out = { shopee: {}, lazada: {} };
  const accounts = credentialPresence && credentialPresence.accounts
    ? credentialPresence.accounts
    : { shopee: {}, lazada: {} };
  let profiles = accountsList;
  if (!profiles) {
    try { profiles = listAccounts(); } catch { profiles = { shopee: [], lazada: [] }; }
  }
  const profileSets = {
    shopee: new Set(Array.isArray(profiles.shopee) ? profiles.shopee.map(sanitizeAccount) : []),
    lazada: new Set(Array.isArray(profiles.lazada) ? profiles.lazada.map(sanitizeAccount) : []),
  };
  let loaded = loadedContexts;
  if (!loaded) {
    try { loaded = browser.listLoadedContexts(); } catch { loaded = []; }
  }
  const loadedByKey = new Map();
  for (const entry of Array.isArray(loaded) ? loaded : []) {
    if (!entry || !entry.platform) continue;
    const p = sanitizePlatform(entry.platform);
    if (!p) continue;
    const a = sanitizeAccount(entry.account);
    loadedByKey.set(`${p}::${a}`, entry);
  }
  const addReadiness = (platform, account, credentialPresent) => {
    const snapshot = getSessionStateSnapshot(platform, account);
    const fresh = isSessionSnapshotFresh(snapshot);
    const sessionValid = snapshot && snapshot.sessionValid === true && fresh ? true
      : (snapshot && snapshot.sessionValid === false ? false : null);
    const customLinkAuthenticated = snapshot && snapshot.customLinkAuthenticated != null
      ? !!snapshot.customLinkAuthenticated && fresh
      : null;
    const loadedRecord = loadedByKey.get(`${platform}::${account}`) || null;
    // Shopee is the only platform with a protected-route probe today, so its
    // readiness gates on customLinkAuthenticated. Lazada has no probe yet, so
    // a stored credential is sufficient until protected-route validation lands.
    const ready = platform === 'shopee'
      ? !!(credentialPresent && sessionValid === true && customLinkAuthenticated === true)
      : !!credentialPresent;
    const needsManual = !ready
      || (snapshot && snapshot.needsManual === true)
      || (snapshot && snapshot.sessionValid === false);
    out[platform][account] = {
      credentialPresent,
      profileExists: profileSets[platform].has(account),
      loaded: !!loadedRecord,
      launchMode: loadedRecord ? (loadedRecord.launchMode || '') : '',
      sessionValid,
      customLinkAuthenticated,
      currentUrl: snapshot ? (snapshot.sanitizedUrl || '') : '',
      sanitizedUrl: snapshot ? (snapshot.sanitizedUrl || '') : '',
      lastReason: snapshot ? snapshot.reason : '',
      lastFailureReason: snapshot ? (snapshot.lastFailureReason || '') : '',
      lastCheckedAt: snapshot ? (snapshot.lastCheckedAt || snapshot.checkedAt || '') : '',
      lastSuccessAt: snapshot ? (snapshot.lastSuccessAt || '') : '',
      needsManual: !!needsManual,
      ready,
    };
  };
  for (const platform of ['shopee', 'lazada']) {
    const presenceMap = accounts && accounts[platform] ? accounts[platform] : {};
    const seen = new Set();
    for (const account of Object.keys(presenceMap)) {
      seen.add(account);
      addReadiness(platform, account, !!presenceMap[account]);
    }
    // Profile-only accounts (a directory exists on disk but no credential and
    // no session probe yet) must still appear so operators can see that the
    // bridge knows about the directory but considers it unauthenticated.
    for (const account of profileSets[platform]) {
      if (!seen.has(account)) {
        seen.add(account);
        addReadiness(platform, account, false);
      }
    }
    for (const [key, entry] of loadedByKey.entries()) {
      if (!key.startsWith(`${platform}::`)) continue;
      if (seen.has(entry.account)) continue;
      seen.add(entry.account);
      addReadiness(platform, sanitizeAccount(entry.account), false);
    }
  }
  for (const entry of listSessionStateSnapshots()) {
    if (!entry || !entry.platform || !out[entry.platform]) continue;
    if (out[entry.platform][entry.account]) continue;
    addReadiness(entry.platform, entry.account, false);
  }
  return out;
}

function listReadyShopeeAccountsForFallback(credentialPresence) {
  const accounts = credentialPresence && credentialPresence.accounts && credentialPresence.accounts.shopee
    ? credentialPresence.accounts.shopee
    : {};
  const ready = [];
  for (const account of Object.keys(accounts)) {
    if (!accounts[account]) continue;
    const snapshot = getSessionStateSnapshot('shopee', account);
    if (!snapshot || snapshot.sessionValid !== true || snapshot.customLinkAuthenticated !== true) continue;
    if (!isSessionSnapshotFresh(snapshot)) continue;
    ready.push({
      platform: 'shopee',
      account,
      sessionValid: true,
      customLinkAuthenticated: true,
      credentialPresent: true,
      lastCheckedAt: snapshot.lastCheckedAt || snapshot.checkedAt || '',
    });
  }
  return ready;
}

// Pre-shorten readiness gate for Shopee. A directory-only profile with no
// Keychain credential is the documented footgun (Hermes saw `default` /
// `affiliate_*` directories surfaced as "available" even when blank), so we
// refuse to spin up a blank persistent context for an unauthenticated account.
// Any session that is not a fresh, sessionValid+customLinkAuthenticated
// snapshot — missing, unknown (null), stale, or explicitly invalid — must be
// re-validated via Keychain reauth before we are allowed to call
// shortenShopee/batchCustomLink. Otherwise we would silently issue batch
// requests against a profile we have never freshly probed.
async function ensureShopeeReadyForShorten(account) {
  const platform = 'shopee';
  const snapshot = getSessionStateSnapshot(platform, account);
  if (
    snapshot
    && snapshot.sessionValid === true
    && snapshot.customLinkAuthenticated === true
    && isSessionSnapshotFresh(snapshot)
  ) {
    return;
  }
  const credentialPresent = await hasStoredCredentialForAccount(platform, account);
  if (!credentialPresent) {
    const lookup = credentialLookupMetadata(platform, account);
    const reason = 'keychain_credential_not_found';
    const keychainCredential = Object.assign({ present: false }, lookup);
    recordSessionState(platform, account, {
      sessionValid: false,
      customLinkAuthenticated: false,
      reason,
      needsManual: true,
    });
    let readyAccounts = [];
    try {
      readyAccounts = listReadyShopeeAccountsForFallback(await credentialPresenceForAccounts());
    } catch { readyAccounts = []; }
    const err = new Error('MANUAL_LOGIN_REQUIRED');
    err.manualLoginRequired = true;
    err.reason = reason;
    err.keychainCredential = keychainCredential;
    err.readyAccounts = readyAccounts;
    err.diagnostic = recordLoginDiagnostic(
      {
        reason,
        platform,
        source: 'pre_shorten_session_gate',
        keychainCredential,
      },
      { platform, account, source: 'pre_shorten_session_gate' },
    );
    throw err;
  }
  // Credential exists and the snapshot is not fresh+valid (covers: missing
  // snapshot, sessionValid===null/undefined, customLinkAuthenticated!==true,
  // stale snapshot, or explicit sessionValid===false). Probe the protected
  // custom_link route via the stored credential before allowing the batch
  // path to run.
  let reauth;
  try {
    reauth = await attemptReauthWithStoredCredential(platform, account, {
      headless: true,
      forceNew: false,
    });
  } catch (reauthErr) {
    if (reauthErr && reauthErr.manualLoginRequired) throw reauthErr;
    throw reauthErr;
  }
  if (
    reauth
    && reauth.ok
    && reauth.sessionValid === true
    && reauth.customLinkAuthenticated === true
  ) {
    return;
  }
  let readyAccounts = [];
  try {
    readyAccounts = listReadyShopeeAccountsForFallback(await credentialPresenceForAccounts());
  } catch { readyAccounts = []; }
  const reason = (reauth && reauth.reason) || 'session_not_ready';
  recordSessionState(platform, account, {
    sessionValid: false,
    customLinkAuthenticated: false,
    reason,
    needsManual: true,
  });
  const err = new Error('MANUAL_LOGIN_REQUIRED');
  err.manualLoginRequired = true;
  err.reason = reason;
  if (reauth && reauth.diagnostic) err.diagnostic = reauth.diagnostic;
  if (reauth && reauth.keychainCredential) err.keychainCredential = reauth.keychainCredential;
  err.readyAccounts = readyAccounts;
  throw err;
}

function readJsonBody(req, limitBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('Request body too large'));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleCredentialStatus(query) {
  const platform = sanitizePlatform(query && query.platform);
  if (!platform) throw new Error('Invalid or missing platform (expected shopee|lazada)');
  const account = sanitizeAccount(query && query.account);
  if (!keychain.isSupported()) {
    return { platform, account, configured: false, keychainSupported: false };
  }
  const candidates = credentialAccountCandidates(account);
  let info = null;
  let matchedCandidate = '';
  for (const candidate of candidates) {
    try {
      const probe = await keychain.hasCredential(platform, candidate);
      if (probe) { info = probe; matchedCandidate = candidate; break; }
    } catch {
      info = null;
    }
  }
  const response = {
    platform,
    account,
    configured: !!info,
    keychainSupported: true,
    username: info && info.username ? info.username : '',
  };
  if (info && matchedCandidate && matchedCandidate !== account) {
    response.matchedAccount = matchedCandidate;
  }
  if (!info) {
    response.checkedAccounts = candidates;
    response.servicePrefix = keychain.SERVICE_PREFIX;
    response.expectedServices = candidates.map((c) => keychain.serviceName(platform, c));
  }
  return response;
}

async function handleCredentialList() {
  if (!keychain.isSupported()) {
    return { keychainSupported: false, credentials: [] };
  }
  let items = [];
  try {
    items = await keychain.listCredentials();
  } catch {
    items = [];
  }
  // Defensive sanitization: never let an upstream parser leak unexpected fields
  // (especially password-shaped ones) into the response.
  const credentials = (Array.isArray(items) ? items : []).map((it) => ({
    platform: String(it && it.platform || ''),
    account: String(it && it.account || ''),
    username: String(it && it.username || ''),
    configured: true,
  })).filter((it) => it.platform && it.account);
  return { keychainSupported: true, credentials };
}

async function handleCredentialSave(body) {
  const platform = sanitizePlatform(body && body.platform);
  if (!platform) throw new Error('Invalid or missing platform (expected shopee|lazada)');
  const account = sanitizeAccount(body && body.account);
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  if (!username) throw new Error('Missing required field: username');
  if (!password) throw new Error('Missing required field: password');
  if (!keychain.isSupported()) {
    throw new Error('Keychain credential storage is only supported on macOS');
  }
  await keychain.saveCredential(platform, account, username, password);
  return { platform, account, configured: true, username };
}

async function handleCredentialDelete(query) {
  const platform = sanitizePlatform(query && query.platform);
  if (!platform) throw new Error('Invalid or missing platform (expected shopee|lazada)');
  const account = sanitizeAccount(query && query.account);
  if (!keychain.isSupported()) {
    throw new Error('Keychain credential storage is only supported on macOS');
  }
  const result = await keychain.deleteCredential(platform, account);
  return { platform, account, configured: false, deleted: !!result.deleted };
}

async function handleLoginAndShorten(body) {
  const platform = sanitizePlatform(body && body.platform);
  if (!platform) {
    throw new Error('Invalid or missing platform (expected shopee|lazada)');
  }
  const username = String((body && body.username) || '').trim();
  if (!username) throw new Error('Missing required field: username');
  const rawAccountIn = String((body && body.account) == null ? '' : (body && body.account)).trim();
  const account = rawAccountIn ? sanitizeAccount(rawAccountIn) : sanitizeAccount(username);
  const password = String((body && body.password) || '');
  if (!password) throw new Error('Missing required field: password');
  const rawUrl = String((body && body.url) || '').trim();
  if (!rawUrl) throw new Error('Missing required field: url');
  const sub1 = String((body && body.sub1) || '').trim();
  const remember = isTruthyFlag(body && body.remember);

  const profileDir = ensureProfileDir(platform, account);
  const target = platform === 'shopee' ? SHOPEE_LOGIN_URL : LAZADA_LOGIN_URL;

  let loginRecord;
  try {
    loginRecord = await browser.getPage(platform, account, { headless: false, forceVisible: true });
  } catch (err) {
    const msg = redactValue(err && err.message ? err.message : String(err), password);
    throw new Error(msg);
  }
  const page = loginRecord.page;
  try { await page.bringToFront(); } catch {}
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {}

  let loginResult = { filled: false, submitted: false, needsManual: true, reason: 'login_skipped' };
  try {
    loginResult = await attemptLogin(page, platform, username, password, { submit: true });
  } catch (err) {
    loginResult = {
      filled: false,
      submitted: false,
      needsManual: true,
      reason: redactValue(err && err.message ? err.message : String(err), password),
    };
  }

  const loginReport = {
    filled: !!loginResult.filled,
    submitted: !!loginResult.submitted,
    needsManual: !!loginResult.needsManual,
    reason: redactValue(loginResult.reason || '', password),
  };
  if (loginResult && loginResult.diagnostic) {
    loginReport.diagnostic = recordLoginDiagnostic(
      loginResult.diagnostic,
      { platform, account, source: 'login_and_shorten' },
    );
  }

  let credentialSaved = false;
  let credentialSaveError = '';
  if (remember && (loginReport.filled || loginReport.submitted)) {
    try {
      await keychain.saveCredential(platform, account, username, password);
      credentialSaved = true;
    } catch (err) {
      credentialSaveError = redactValue(
        err && err.message ? err.message : String(err),
        password,
      );
    }
  }

  let shorten = null;
  let shortenError = '';
  if (!loginReport.needsManual) {
    try {
      shorten = await handleShorten({ url: rawUrl, account, platform, sub1 }, { autoReauth: true });
    } catch (err) {
      shortenError = redactValue(err && err.message ? err.message : String(err), password);
    }
  } else {
    shortenError = loginReport.reason || 'manual_login_required';
  }

  return {
    status: shorten ? 'ok' : 'login_window_open_awaiting_manual',
    platform,
    account,
    profileDir,
    loginUrl: target,
    login: loginReport,
    shorten,
    shortenError: shortenError || undefined,
    credential: {
      saved: credentialSaved,
      requested: remember,
      error: credentialSaveError || undefined,
    },
    note: 'Browser window left open for OTP/CAPTCHA or manual completion. Retry shorten after finishing login.',
    backend: browser.backendInfo(),
  };
}

async function handleLoginOnly(body) {
  const platform = sanitizePlatform(body && body.platform);
  if (!platform) {
    throw new Error('Invalid or missing platform (expected shopee|lazada)');
  }
  const username = String((body && body.username) || '').trim();
  if (!username) throw new Error('Missing required field: username');
  const rawAccountIn = String((body && body.account) == null ? '' : (body && body.account)).trim();
  const account = rawAccountIn ? sanitizeAccount(rawAccountIn) : sanitizeAccount(username);
  const password = String((body && body.password) || '');
  if (!password) throw new Error('Missing required field: password');
  const remember = parseRememberFlag(body && body.remember);

  let credentialSaved = false;
  let credentialStatus;
  let credentialSaveError = '';

  if (!remember) {
    credentialStatus = 'credential_save_skipped';
  } else if (!keychain.isSupported()) {
    credentialStatus = 'credential_save_failed';
    credentialSaveError = 'keychain_unsupported';
  } else {
    try {
      await keychain.saveCredential(platform, account, username, password);
      credentialSaved = true;
      credentialStatus = 'credential_saved';
    } catch (err) {
      credentialStatus = 'credential_save_failed';
      credentialSaveError = redactValue(
        err && err.message ? err.message : String(err),
        password,
      );
    }
  }

  return {
    status: 'ok',
    platform,
    account,
    credential: {
      saved: credentialSaved,
      requested: remember,
      status: credentialStatus,
      error: credentialSaveError || undefined,
    },
  };
}

function handleHealth() {
  return {
    status: 'ok',
    port: DEFAULT_PORT,
    backend: browser.backendInfo(),
    loaded: browser.listLoadedContexts().length,
    uptimeSec: Math.round(process.uptime()),
    keychainSupported: keychain.isSupported(),
  };
}

function handleDebug() {
  return {
    profileRoot: PROFILE_ROOT,
    backend: browser.backendInfo(),
    loaded: browser.listLoadedContexts(),
    recentLoginDiagnostics: recentLoginDiagnosticsForDebug(),
    sessionState: listSessionStateSnapshots(),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    keychainSupported: keychain.isSupported(),
  };
}

function indexHtml() {
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>Affiliate Shortlink Cloak</title>',
    '<h1>Affiliate Shortlink Cloak Bridge</h1>',
    '<p>Parallel CloakBrowser-based bridge (does not replace the Electron port 8800).</p>',
    '<ul>',
    '<li><code>GET /?url=SHOPEE_OR_LAZADA_URL&account=X&sub1=Y</code> (auto-detect)</li>',
    '<li><code>GET /shorten?url=...</code> (same contract)</li>',
    '<li><code>GET /login</code> (credential-only HTML form; Accept: application/json or <code>?json=1</code> opens the account browser and attempts stored Keychain autofill by default when credentials exist; add <code>&amp;noAutofill=1</code> or <code>&amp;autofill=0</code> for manual mode; secrets are never returned)</li>',
    '<li><code>GET /login/shopee</code> · <code>GET /login/lazada</code> (302 compatibility redirects to <code>/login?platform=shopee|lazada</code> — not primary)</li>',
    '<li><code>GET /login-ui?account=X&url=Y</code> (legacy interactive login + shorten form; url required; account still passed as a hidden field for backward compat)</li>',
    '<li><code>POST /api/login</code> (credential-save-only JSON — does NOT open a browser or attempt login; <code>account</code> optional, derived from <code>username</code> when blank; <code>remember</code> defaults to true and persists in macOS Keychain; <code>remember:false</code> returns credential.status=credential_save_skipped)</li>',
    '<li><code>POST /api/login-and-shorten</code> (JSON body; <code>account</code> optional — derived from <code>username</code> when blank; <code>remember</code> persists in macOS Keychain)</li>',
    '<li><code>GET /api/credentials?platform=shopee&account=X</code> (status only, never returns password)</li>',
    '<li><code>POST /api/credentials</code> (JSON {platform, account, username, password} — stored in macOS Keychain)</li>',
    '<li><code>DELETE /api/credentials?platform=shopee&account=X</code></li>',
    '<li><code>GET /click-report?id=15130770000&amp;time=DD/MM/YYYY</code> (Shopee click_report summary JSON: per-sub_id counts + percentages, no raw list; <code>id</code> defaults to <code>15130770000</code>; <code>time</code> defaults to today in Asia/Bangkok; add <code>&amp;raw=1</code> or <code>&amp;mode=raw</code> to return one page of raw rows with <code>page_num</code>/<code>page_size</code>)</li>',
    '<li><code>GET /accounts</code> (profiles + loaded contexts + Keychain credential presence booleans)</li>',
    '<li><code>GET /health</code></li>',
    '<li><code>GET /debug</code> (sanitized — no cookies/tokens/passwords; includes recent redacted login diagnostics)</li>',
    '</ul>',
  ].join('\n');
}

function escapeHtmlAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loginUiHtml(query = {}) {
  const rawUrl = String((query && query.url) || '').trim();
  const account = String((query && query.account) || '').trim();
  const sub1 = String((query && query.sub1) || '').trim();
  const platform = sanitizePlatform(query && query.platform) || detectPlatform(rawUrl);

  const styles = [
    '<style>',
    'body{font-family:system-ui,-apple-system,sans-serif;max-width:420px;margin:24px auto;padding:0 16px;color:#222;}',
    'h1{font-size:18px;margin-bottom:4px;}p.note{color:#666;font-size:13px;margin-top:0;}',
    'form{display:flex;flex-direction:column;gap:10px;margin-top:16px;}',
    'label{display:flex;flex-direction:column;font-size:13px;color:#333;}',
    'label.inline{flex-direction:row;align-items:center;gap:8px;font-size:13px;color:#333;}',
    'input{padding:8px 10px;font-size:14px;border:1px solid #ccc;border-radius:6px;}',
    'input[type="checkbox"]{padding:0;width:auto;}',
    'button{margin-top:8px;padding:10px 14px;font-size:14px;background:#1f6feb;color:#fff;border:0;border-radius:6px;cursor:pointer;}',
    'button:disabled{opacity:.6;cursor:not-allowed;}',
    '#out{white-space:pre-wrap;background:#0b1020;color:#cde;padding:12px;border-radius:6px;font-size:12px;margin-top:14px;min-height:40px;}',
    '.ctx{background:#f4f6fa;border:1px solid #e2e6ee;padding:8px 10px;border-radius:6px;font-size:12px;color:#555;}',
    '.ctx code{background:transparent;color:#1f6feb;}',
    '.err{background:#fff4f4;border:1px solid #f3c2c2;color:#7a1f1f;padding:10px 12px;border-radius:6px;font-size:13px;}',
    '.cred{margin-top:6px;font-size:12px;color:#555;}',
    '.cred .saved{color:#1a7f37;}',
    '.cred button.danger{background:#a4262c;margin-top:0;padding:6px 10px;font-size:12px;}',
    '</style>',
  ];

  if (!rawUrl || !platform) {
    const reason = !rawUrl
      ? 'Missing required query parameter: <code>url</code>.'
      : 'Cannot detect platform from the provided url (expected a Shopee or Lazada link, or pass <code>platform=shopee|lazada</code>).';
    return [
      '<!doctype html>',
      '<html lang="en"><head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>Login &amp; Shorten — Affiliate Cloak</title>',
      ...styles,
      '</head><body>',
      '<h1>Login &amp; Shorten</h1>',
      '<p class="err">' + reason + '</p>',
      '<p class="note">Open this page with the shorten context in the query string, for example:</p>',
      '<p class="ctx"><code>/login-ui?account=CHEARB&amp;url=https%3A%2F%2Fshopee.co.th%2F-i.6817918.28499498718&amp;sub1=yok</code></p>',
      '<p class="note">The UI only collects your username and password. Platform, account, url and sub1 come from the query string and are never editable from this page.</p>',
      '</body></html>',
    ].join('\n');
  }

  const platformAttr = escapeHtmlAttr(platform);
  const accountAttr = escapeHtmlAttr(account);
  const urlAttr = escapeHtmlAttr(rawUrl);
  const sub1Attr = escapeHtmlAttr(sub1);
  const accountDisplay = account ? escapeHtmlAttr(account) : '<em>default</em>';
  const credStatusQs = '?platform=' + encodeURIComponent(platform)
    + '&account=' + encodeURIComponent(account);

  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Login &amp; Shorten — Affiliate Cloak</title>',
    ...styles,
    '</head><body>',
    '<h1>Login &amp; Shorten</h1>',
    '<p class="note">Enter your platform credentials. A real browser window will open on this machine; finish OTP / CAPTCHA there, then this page reports the shorten result. Password is never echoed back or written outside macOS Keychain.</p>',
    '<p class="ctx">platform <code>' + platformAttr + '</code> · account <code>' + accountDisplay + '</code></p>',
    '<p class="cred" id="cred">Checking saved credential…</p>',
    '<form id="f" autocomplete="off">',
    '<input type="hidden" name="platform" value="' + platformAttr + '">',
    '<input type="hidden" name="account" value="' + accountAttr + '">',
    '<input type="hidden" name="url" value="' + urlAttr + '">',
    '<input type="hidden" name="sub1" value="' + sub1Attr + '">',
    '<label>username<input name="username" required autocomplete="off"></label>',
    '<label>password<input name="password" type="password" required autocomplete="new-password"></label>',
    '<label class="inline"><input type="checkbox" name="remember" value="1"> Remember credentials in macOS Keychain (auto re-auth on session expiry)</label>',
    '<button type="submit" id="go">Open login window &amp; shorten</button>',
    '</form>',
    '<pre id="out">Ready.</pre>',
    '<script>',
    '(function(){',
    'var credEl=document.getElementById("cred");',
    'var credQs=' + JSON.stringify(credStatusQs) + ';',
    'function renderCred(s){',
    'if(!s){credEl.textContent="Saved credential: unknown.";return;}',
    'if(s.configured){',
    'var name=s.username?(" ("+s.username+")"):"";',
    'credEl.innerHTML="Saved credential: <span class=\\"saved\\">stored in macOS Keychain"+name+"</span>. ";',
    'var btn=document.createElement("button");btn.type="button";btn.className="danger";btn.textContent="Forget credential";',
    'btn.addEventListener("click",function(){',
    'btn.disabled=true;',
    'fetch("/api/credentials"+credQs,{method:"DELETE"})',
    '.then(function(r){return r.json().catch(function(){return{};});})',
    '.then(function(){refresh();}).catch(function(){btn.disabled=false;});',
    '});credEl.appendChild(btn);',
    '}else if(s.keychainSupported===false){credEl.textContent="Saved credential: keychain unavailable on this OS.";}',
    'else{credEl.textContent="Saved credential: none (tick \\"Remember\\" to save after login).";}',
    '}',
    'function refresh(){',
    'fetch("/api/credentials"+credQs,{method:"GET"})',
    '.then(function(r){return r.json().catch(function(){return null;});})',
    '.then(renderCred).catch(function(){renderCred(null);});',
    '}refresh();',
    'var f=document.getElementById("f"),btn=document.getElementById("go"),out=document.getElementById("out");',
    'f.addEventListener("submit",function(ev){',
    'ev.preventDefault();',
    'var fd=new FormData(f);var body={};fd.forEach(function(v,k){body[k]=String(v);});',
    'if(!fd.has("remember"))body.remember="0";',
    'btn.disabled=true;out.textContent="Opening browser window…";',
    'fetch("/api/login-and-shorten",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})',
    '.then(function(r){return r.text().then(function(t){return{status:r.status,text:t};});})',
    '.then(function(res){var pretty=res.text;try{pretty=JSON.stringify(JSON.parse(res.text),null,2);}catch(_){}',
    'out.textContent="HTTP "+res.status+"\\n"+pretty;',
    'try{f.querySelector("input[name=password]").value="";}catch(_){}',
    'refresh();',
    '})',
    '.catch(function(e){out.textContent="Error: "+(e&&e.message?e.message:String(e));})',
    '.then(function(){btn.disabled=false;});',
    '});',
    '})();',
    '</script>',
    '</body></html>',
  ].join('\n');
}

function accountListsForHtml() {
  let raw;
  try {
    raw = listAccounts();
  } catch {
    raw = { shopee: [], lazada: [] };
  }
  const out = { shopee: [], lazada: [] };
  for (const platform of ['shopee', 'lazada']) {
    const seen = new Set();
    const list = Array.isArray(raw[platform]) ? raw[platform] : [];
    const ordered = [];
    for (const name of [DEFAULT_ACCOUNT, ...list]) {
      const cleaned = sanitizeAccount(name);
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        ordered.push(cleaned);
      }
    }
    out[platform] = ordered;
  }
  return out;
}

function buildManualLoginRequiredPayload(query = {}, err = {}) {
  const platform = sanitizePlatform(query.platform) || detectPlatform(String(query.url || ''));
  const account = sanitizeAccount(query.account);
  const payload = {
    status: 'manual_login_required',
    error: 'manual_login_required',
    manualLoginRequired: true,
    needsManual: true,
    reason: err.reason || 'manual_login_required',
    platform: platform || '',
    account,
    loginUi: buildLoginUiUrlForRetry(
      platform || '',
      account,
      String(query.url || ''),
      String(query.sub1 || ''),
    ),
  };
  if (err && err.diagnostic) {
    payload.diagnostic = recordLoginDiagnostic(
      err.diagnostic,
      { platform: platform || '', account, source: 'manual_payload' },
    );
  }
  if (err && err.keychainCredential) {
    payload.keychainCredential = err.keychainCredential;
  }
  if (err && Array.isArray(err.readyAccounts)) {
    payload.readyAccounts = err.readyAccounts;
  }
  if (payload.diagnostic) payload.debug = '/debug';
  return payload;
}

function loginHtmlPage(opts = {}) {
  const presetPlatform = sanitizePlatform(opts.platform) || '';
  const platformLocked = !!presetPlatform;

  const platformAttr = escapeHtmlAttr(presetPlatform);

  const styles = [
    '<style>',
    '*,*::before,*::after{box-sizing:border-box;}',
    'html,body{margin:0;padding:0;}',
    'body{min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",system-ui,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#1a1a1a;padding:24px 16px;display:flex;align-items:flex-start;justify-content:center;}',
    '@media (max-width:480px){body{padding:16px 12px;}}',
    'main.card{background:#ffffff;width:100%;max-width:480px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.15);padding:28px 24px;}',
    'h1{margin:0 0 4px;font-size:22px;font-weight:600;letter-spacing:-.01em;color:#1a1a1a;}',
    'p.lede{margin:0 0 16px;color:#5a5f68;font-size:13px;line-height:1.55;}',
    'p.lede code{background:#f3f4f7;padding:1px 5px;border-radius:4px;font-size:12px;color:#1f6feb;}',
    '.ctx{margin:0 0 16px;padding:8px 12px;background:#f3f4f7;border-radius:8px;font-size:12px;color:#5a5f68;}',
    '.ctx strong{color:#1f6feb;font-weight:600;}',
    'section.list{margin:0 0 18px;}',
    'section.list .list-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}',
    'section.list h2{margin:0;font-size:14px;font-weight:600;letter-spacing:.02em;color:#1a1a1a;}',
    'button.add-btn{background:#1f6feb;color:#fff;border:0;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;transition:background .15s ease;}',
    'button.add-btn:hover:not(:disabled){background:#1858c4;}',
    'button.add-btn[aria-expanded="true"]{background:#a4262c;}',
    '.group{margin:0 0 12px;}',
    '.group-label{font-size:11px;font-weight:600;color:#9098a3;text-transform:uppercase;letter-spacing:.06em;margin:6px 0;}',
    '.cred-item{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid #e6e8ed;border-radius:10px;background:#fbfbfd;margin:6px 0;gap:10px;}',
    '.cred-item .meta{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}',
    '.cred-item .acct{font-size:13px;font-weight:600;color:#1a1a1a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.cred-item .uname{font-size:12px;color:#5a5f68;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
    '.cred-item .platform-tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:4px;color:#fff;margin-right:6px;}',
    '.cred-item .platform-tag.shopee{background:#ee4d2d;}',
    '.cred-item .platform-tag.lazada{background:#0f136d;}',
    '.cred-item button.del{background:#fff;border:1px solid #d4d8df;color:#a4262c;padding:5px 10px;border-radius:6px;font-size:12px;font-family:inherit;cursor:pointer;transition:.15s ease;flex:0 0 auto;}',
    '.cred-item button.del:hover:not(:disabled){background:#a4262c;color:#fff;border-color:#a4262c;}',
    '.cred-item button.del:disabled{opacity:.55;cursor:not-allowed;}',
    '.empty-state{padding:18px 14px;border:1px dashed #d4d8df;border-radius:10px;background:#fbfbfd;color:#5a5f68;font-size:13px;text-align:center;}',
    'form{display:flex;flex-direction:column;}',
    'section.add{margin-top:6px;padding:14px;border:1px solid #e6e8ed;border-radius:12px;background:#fbfbfd;}',
    'section.add[hidden]{display:none;}',
    'section.add h2{margin:0 0 10px;font-size:14px;font-weight:600;color:#1a1a1a;}',
    '.field{display:flex;flex-direction:column;margin-bottom:12px;}',
    '.field-label{font-size:12px;font-weight:600;color:#3a3f49;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;}',
    '.field select,.field input[type="text"],.field input[type="password"]{padding:11px 12px;font-size:15px;border:1px solid #d4d8df;border-radius:9px;background:#fff;color:#1a1a1a;width:100%;font-family:inherit;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease;}',
    '.field select:focus,.field input[type="text"]:focus,.field input[type="password"]:focus{outline:none;border-color:#1f6feb;background:#fff;box-shadow:0 0 0 3px rgba(31,111,235,.15);}',
    '.preview{font-size:12px;color:#5a5f68;margin:6px 0 0;}',
    '.preview strong{color:#1f6feb;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
    'label.check{display:flex;align-items:center;gap:10px;padding:11px 12px;background:#f3f4f7;border-radius:9px;margin:2px 0 14px;font-size:13px;color:#3a3f49;cursor:pointer;}',
    'label.check input{margin:0;width:auto;}',
    '#cred{padding:12px 14px;border-radius:10px;background:#fff;border:1px solid #e6e8ed;margin:0 0 16px;display:flex;flex-direction:column;gap:8px;}',
    '#cred .label{font-size:11px;font-weight:600;color:#9098a3;text-transform:uppercase;letter-spacing:.06em;}',
    '#cred .body{font-size:13px;color:#3a3f49;line-height:1.45;}',
    '#cred.saved{background:#ecfdf3;border-color:#a5e7c0;}',
    '#cred.saved .body{color:#1a7f37;}',
    '#cred.warn{background:#fef9ec;border-color:#fadc94;}',
    '#cred.warn .body{color:#7a5300;}',
    '#cred.info{background:#eef4ff;border-color:#c2d4f5;}',
    '#cred.info .body{color:#1f4eb8;}',
    '#cred .forget{align-self:flex-start;background:#fff;border:1px solid #d4d8df;color:#a4262c;padding:5px 10px;border-radius:6px;font-size:12px;font-family:inherit;cursor:pointer;transition:.15s ease;}',
    '#cred .forget:hover:not(:disabled){background:#a4262c;color:#fff;border-color:#a4262c;}',
    '#cred .forget:disabled{opacity:.55;cursor:not-allowed;}',
    'button.submit{width:100%;margin-top:2px;padding:13px 16px;font-size:15px;font-weight:600;background:#1f6feb;color:#fff;border:0;border-radius:10px;cursor:pointer;transition:background .15s ease;font-family:inherit;}',
    'button.submit:hover:not(:disabled){background:#1858c4;}',
    'button.submit:disabled{opacity:.55;cursor:not-allowed;}',
    '#out{margin-top:14px;padding:11px 14px;border-radius:10px;font-size:13px;line-height:1.45;display:none;border:1px solid transparent;}',
    '#out.show{display:block;}',
    '#out.ok{background:#ecfdf3;border-color:#a5e7c0;color:#1a7f37;}',
    '#out.err{background:#fef2f2;border-color:#fbcaca;color:#a4262c;}',
    '#out.info{background:#eef4ff;border-color:#c2d4f5;color:#1f4eb8;}',
    '</style>',
  ];

  const platformControl = platformLocked
    ? '<input type="hidden" name="platform" id="platform" value="' + platformAttr + '">'
    : [
        '<div class="field">',
        '  <label class="field-label" for="platform">แพลตฟอร์ม</label>',
        '  <select name="platform" id="platform">',
        '    <option value="shopee"' + (presetPlatform === 'shopee' ? ' selected' : '') + '>Shopee</option>',
        '    <option value="lazada"' + (presetPlatform === 'lazada' ? ' selected' : '') + '>Lazada</option>',
        '  </select>',
        '</div>',
      ].join('\n');

  const heading = platformLocked
    ? ('เข้าสู่ระบบ ' + (presetPlatform === 'shopee' ? 'Shopee' : 'Lazada'))
    : 'เข้าสู่ระบบ Affiliate';

  // Client-side mirror of src/accounts.js sanitizeAccount so we can show the
  // derived account name (and look up its keychain status) live as the user
  // types their username. Must stay in sync with sanitizeAccount on the server.
  const script = [
    '(function(){',
    'var PRESET_PLATFORM=' + JSON.stringify(presetPlatform) + ';',
    'var PLATFORM_LOCKED=' + JSON.stringify(platformLocked) + ';',
    'function $(id){return document.getElementById(id);}',
    'function platformLabel(p){return p==="shopee"?"Shopee":(p==="lazada"?"Lazada":(p||""));}',
    'function currentPlatform(){if(PLATFORM_LOCKED)return PRESET_PLATFORM;var el=$("platform");return el&&el.value?el.value:"shopee";}',
    'function sanitizeAccount(raw){',
    '  var s=String(raw==null?"":raw).trim();',
    '  if(!s)return "default";',
    '  var cleaned=s.replace(/[^A-Za-z0-9._-]/g,"_").slice(0,64);',
    '  return cleaned||"default";',
    '}',
    'function derivedAccount(){return sanitizeAccount(($("username").value||"").trim());}',
    'function escapeText(s){return String(s||"").replace(/[<>&\\"\\\']/g,"?");}',
    'function updateCtxLabel(){',
    '  var p=currentPlatform();var u=($("username").value||"").trim();',
    '  var a=u?derivedAccount():"(จะสร้างจาก username)";',
    '  var label=$("ctxLabel");if(label){label.innerHTML="<strong>"+platformLabel(p)+"</strong> · account <strong>"+escapeText(a)+"</strong>";}',
    '  var prev=$("accountPreview");if(prev){prev.textContent=u?a:"—";}',
    '}',
    'function setCred(cls,text){',
    '  var el=$("cred");if(!el)return;',
    '  el.className="";if(cls)el.className=cls;',
    '  var body=$("credBody");if(body)body.textContent=text;',
    '  var oldBtn=el.querySelector(".forget");if(oldBtn&&oldBtn.parentNode)oldBtn.parentNode.removeChild(oldBtn);',
    '}',
    'function setToast(cls,text){',
    '  var el=$("out");if(!el)return;',
    '  el.className="";el.textContent="";',
    '  if(!text)return;',
    '  el.classList.add("show");if(cls)el.classList.add(cls);',
    '  el.textContent=text;',
    '}',
    'function showAdd(open){',
    '  var panel=$("addPanel");var toggle=$("toggleAdd");',
    '  if(!panel||!toggle)return;',
    '  if(open){',
    '    panel.hidden=false;toggle.setAttribute("aria-expanded","true");toggle.textContent="× ปิดฟอร์ม";',
    '    var unameEl=$("username");if(unameEl){try{unameEl.focus();}catch(_){}}',
    '    updateCtxLabel();refreshCred();',
    '  } else {',
    '    panel.hidden=true;toggle.setAttribute("aria-expanded","false");toggle.textContent="+ เพิ่ม credential";',
    '    try{$("password").value="";}catch(_){}',
    '  }',
    '}',
    'function renderList(items){',
    '  var body=$("listBody");if(!body)return;',
    '  while(body.firstChild)body.removeChild(body.firstChild);',
    '  if(!items||!items.length){',
    '    var empty=document.createElement("div");empty.className="empty-state";',
    '    empty.textContent="ยังไม่มี credential ที่บันทึกไว้ — กด \\u201C+ เพิ่ม credential\\u201D เพื่อบันทึกบัญชีใหม่";',
    '    body.appendChild(empty);return;',
    '  }',
    '  var groups={shopee:[],lazada:[]};',
    '  for(var i=0;i<items.length;i++){var it=items[i];if(it&&groups[it.platform])groups[it.platform].push(it);}',
    '  var order=["shopee","lazada"];',
    '  for(var gi=0;gi<order.length;gi++){',
    '    var plat=order[gi];var list=groups[plat];if(!list.length)continue;',
    '    var grp=document.createElement("div");grp.className="group";',
    '    var hd=document.createElement("div");hd.className="group-label";hd.textContent=platformLabel(plat);grp.appendChild(hd);',
    '    for(var j=0;j<list.length;j++){',
    '      (function(it){',
    '        var row=document.createElement("div");row.className="cred-item";',
    '        var meta=document.createElement("div");meta.className="meta";',
    '        var top=document.createElement("div");top.className="acct";',
    '        var tag=document.createElement("span");tag.className="platform-tag "+it.platform;tag.textContent=platformLabel(it.platform);',
    '        top.appendChild(tag);top.appendChild(document.createTextNode(it.account||""));',
    '        var uname=document.createElement("div");uname.className="uname";uname.textContent=it.username||"(no username recorded)";',
    '        meta.appendChild(top);meta.appendChild(uname);',
    '        var del=document.createElement("button");del.type="button";del.className="del";del.textContent="ลบ credential นี้";',
    '        del.addEventListener("click",function(){',
    '          if(!confirm("ลบ credential ของ "+platformLabel(it.platform)+" / "+(it.account||"")+" ออกจาก macOS Keychain?"))return;',
    '          del.disabled=true;setToast("info","กำลังลบ credential…");',
    '          fetch("/api/credentials?platform="+encodeURIComponent(it.platform)+"&account="+encodeURIComponent(it.account||""),{method:"DELETE"})',
    '            .then(function(r){return r.json().catch(function(){return{};}).then(function(j){return{status:r.status,json:j};});})',
    '            .then(function(res){',
    '              if(res.status>=200&&res.status<300){setToast("ok","ลบ credential เรียบร้อยแล้ว สำหรับ "+platformLabel(it.platform)+" / "+(it.account||""));}',
    '              else{setToast("err","ลบ credential ไม่สำเร็จ"+(res.json&&res.json.error?": "+res.json.error:""));}',
    '              refreshList();',
    '            })',
    '            .catch(function(e){del.disabled=false;setToast("err","ลบไม่สำเร็จ: "+(e&&e.message?e.message:String(e)));});',
    '        });',
    '        row.appendChild(meta);row.appendChild(del);',
    '        grp.appendChild(row);',
    '      })(list[j]);',
    '    }',
    '    body.appendChild(grp);',
    '  }',
    '}',
    'function refreshList(){',
    '  var body=$("listBody");if(body){body.innerHTML="";var loading=document.createElement("div");loading.className="empty-state";loading.textContent="กำลังโหลด credential ที่บันทึกไว้…";body.appendChild(loading);}',
    '  fetch("/api/credentials",{method:"GET"})',
    '    .then(function(r){return r.ok?r.json():null;})',
    '    .then(function(j){',
    '      if(!j){renderList([]);return;}',
    '      if(j.keychainSupported===false){',
    '        var body2=$("listBody");if(body2){body2.innerHTML="";var warn=document.createElement("div");warn.className="empty-state";warn.textContent="Keychain ไม่รองรับใน OS นี้ — ไม่มี credential ให้แสดง";body2.appendChild(warn);}',
    '        return;',
    '      }',
    '      renderList(Array.isArray(j.credentials)?j.credentials:[]);',
    '    })',
    '    .catch(function(){renderList([]);});',
    '}',
    'var credAbort=null;',
    'function refreshCred(){',
    '  var unameEl=$("username");if(!unameEl)return;',
    '  var p=currentPlatform();var u=(unameEl.value||"").trim();',
    '  if(!u){setCred("","กรอก username เพื่อเช็คสถานะ credential");return;}',
    '  var a=derivedAccount();',
    '  setCred("info","กำลังเช็คสถานะ credential สำหรับ account "+a+"…");',
    '  if(credAbort){try{credAbort.abort();}catch(_){}}',
    '  credAbort=(typeof AbortController!=="undefined")?new AbortController():null;',
    '  var opts=credAbort?{signal:credAbort.signal}:{};',
    '  fetch("/api/credentials?platform="+encodeURIComponent(p)+"&account="+encodeURIComponent(a),opts)',
    '    .then(function(r){return r.ok?r.json():null;})',
    '    .then(function(s){',
    '      if(!s){setCred("warn","สถานะ credential: ไม่ทราบ");return;}',
    '      if(s.configured){',
    '        var name=s.username?(" ("+s.username+")"):"";',
    '        setCred("saved","มี credential ใน macOS Keychain แล้ว"+name+" สำหรับ account "+a);',
    '        var btn=document.createElement("button");btn.type="button";btn.className="forget";btn.textContent="ลบ credential นี้";',
    '        btn.addEventListener("click",function(){',
    '          if(!confirm("ลบ credential ของ account "+a+" ออกจาก macOS Keychain?"))return;',
    '          btn.disabled=true;setToast("info","กำลังลบ credential…");',
    '          fetch("/api/credentials?platform="+encodeURIComponent(p)+"&account="+encodeURIComponent(a),{method:"DELETE"})',
    '            .then(function(r){return r.json().catch(function(){return{};}).then(function(j){return{status:r.status,json:j};});})',
    '            .then(function(res){',
    '              if(res.status>=200&&res.status<300){setToast("ok","ลบ credential เรียบร้อยแล้ว สำหรับ account "+a);}',
    '              else{setToast("err","ลบ credential ไม่สำเร็จ"+(res.json&&res.json.error?": "+res.json.error:""));}',
    '              refreshCred();refreshList();',
    '            })',
    '            .catch(function(e){btn.disabled=false;setToast("err","ลบไม่สำเร็จ: "+(e&&e.message?e.message:String(e)));});',
    '        });',
    '        $("cred").appendChild(btn);',
    '      } else if(s.keychainSupported===false){',
    '        setCred("warn","ยังไม่มี credential — Keychain ไม่รองรับใน OS นี้ (จะไม่ remember)");',
    '      } else {',
    '        setCred("","ยังไม่มี credential สำหรับ account "+a+" (กดบันทึก credential เพื่อเก็บลง macOS Keychain)");',
    '      }',
    '    })',
    '    .catch(function(){});',
    '}',
    'var platformEl=$("platform");',
    'if(platformEl&&platformEl.tagName==="SELECT"){platformEl.addEventListener("change",function(){updateCtxLabel();refreshCred();});}',
    '$("username").addEventListener("input",function(){updateCtxLabel();refreshCred();});',
    '$("toggleAdd").addEventListener("click",function(){var panel=$("addPanel");showAdd(!!(panel&&panel.hidden));});',
    'refreshList();',
    'updateCtxLabel();',
    '$("f").addEventListener("submit",function(ev){',
    '  ev.preventDefault();',
    '  var p=currentPlatform();',
    '  var btn=$("go");',
    '  var u=($("username").value||"").trim();var pw=$("password").value||"";',
    '  if(!u||!pw){setToast("err","กรุณากรอก username และ password");return;}',
    '  var remember=$("remember").checked?"1":"0";',
    '  var body={platform:p,username:u,password:pw,remember:remember};',
    '  btn.disabled=true;setToast("info","กำลังบันทึก credential ลง macOS Keychain…");',
    '  fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})',
    '    .then(function(r){return r.json().catch(function(){return{error:"invalid_response"};}).then(function(j){return{status:r.status,json:j};});})',
    '    .then(function(res){',
    '      try{$("password").value="";}catch(_){}',
    '      try{$("username").value="";}catch(_){}',
    '      var j=res.json||{};',
    '      if(res.status>=200&&res.status<300&&j.status==="ok"){',
    '        var c=j.credential||{};',
    '        if(c.saved){setToast("ok","บันทึก credential ลง macOS Keychain เรียบร้อยแล้ว (account "+(j.account||"")+")");}',
    '        else if(c.status==="credential_save_skipped"){setToast("info","ไม่ได้บันทึก credential (ปิดการจำ credential ไว้)");}',
    '        else if(c.status==="credential_save_failed"){setToast("err","บันทึก credential ไม่สำเร็จ: "+(c.error||"unknown"));}',
    '        else{setToast("ok","เรียบร้อย");}',
    '        showAdd(false);',
    '      } else {',
    '        var emsg=j&&j.error?String(j.error):("HTTP "+res.status);',
    '        setToast("err","ผิดพลาด: "+emsg);',
    '      }',
    '      refreshList();',
    '      refreshCred();',
    '    })',
    '    .catch(function(e){setToast("err","Error: "+(e&&e.message?e.message:String(e)));})',
    '    .then(function(){btn.disabled=false;});',
    '});',
    '})();',
  ].join('\n');

  return [
    '<!doctype html>',
    '<html lang="th"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + heading + ' — Affiliate Cloak</title>',
    ...styles,
    '</head><body>',
    '<main class="card">',
    '<h1>' + heading + '</h1>',
    '<p class="lede">จัดการ credential ของบัญชี affiliate ที่บันทึกไว้ใน macOS Keychain — ระบบจะใช้ credential นี้สำหรับ auto re-auth เมื่อ session หมดอายุระหว่างเรียก shorten หน้านี้ไม่เปิดเบราว์เซอร์และไม่พยายาม login เอง โดย account จะสร้างจาก username อัตโนมัติ (เช่น <code>affiliate@neezs.com</code> → <code>affiliate_neezs.com</code>)</p>',
    '<section class="list" id="list">',
    '  <div class="list-header">',
    '    <h2>Credentials ที่บันทึกไว้</h2>',
    '    <button type="button" id="toggleAdd" class="add-btn" aria-expanded="false" aria-controls="addPanel">+ เพิ่ม credential</button>',
    '  </div>',
    '  <div id="listBody"><div class="empty-state">กำลังโหลด credential ที่บันทึกไว้…</div></div>',
    '</section>',
    '<section class="add" id="addPanel" hidden>',
    '<h2>เพิ่ม credential ใหม่</h2>',
    '<p class="ctx">กำลัง login: <span id="ctxLabel">…</span></p>',
    '<form id="f" autocomplete="off">',
    platformControl,
    '<div class="field">',
    '  <label class="field-label" for="username">Username</label>',
    '  <input name="username" id="username" type="text" required autocomplete="off" placeholder="affiliate@neezs.com">',
    '  <p class="preview">Account ที่จะใช้: <strong id="accountPreview">—</strong></p>',
    '</div>',
    '<div class="field">',
    '  <label class="field-label" for="password">Password</label>',
    '  <input name="password" id="password" type="password" required autocomplete="new-password" placeholder="••••••••">',
    '</div>',
    '<label class="check"><input type="checkbox" name="remember" id="remember" value="1" checked> จำ credential ใน macOS Keychain (auto re-auth on session expiry)</label>',
    '<div id="cred">',
    '  <span class="label">สถานะ Keychain</span>',
    '  <span class="body" id="credBody">กรอก username เพื่อเช็คสถานะ credential</span>',
    '</div>',
    '<button type="submit" id="go" class="submit">บันทึก credential</button>',
    '</form>',
    '</section>',
    '<div id="out" role="status" aria-live="polite"></div>',
    '</main>',
    '<script>',
    script,
    '</script>',
    '</body></html>',
  ].join('\n');
}

function createServer() {
  return http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    const query = parsed.query || {};

    try {
      if (pathname === '/health') return sendJson(res, 200, handleHealth());
      if (pathname === '/debug') return sendJson(res, 200, handleDebug());
      if (pathname === '/accounts') return sendJson(res, 200, await handleAccounts());

      if (pathname === '/login-ui') {
        return sendHtml(res, 200, loginUiHtml(query));
      }

      if (pathname === '/api/credentials') {
        try {
          if (req.method === 'GET') {
            const hasPlatform = !!String((query && query.platform) || '').trim();
            const hasAccount = !!String((query && query.account) || '').trim();
            if (!hasPlatform && !hasAccount) {
              const result = await handleCredentialList();
              return sendJson(res, 200, result);
            }
            const result = await handleCredentialStatus(query);
            return sendJson(res, 200, result);
          }
          if (req.method === 'POST') {
            let body;
            try {
              body = await readJsonBody(req);
            } catch (err) {
              return sendJson(res, 400, { error: err && err.message ? err.message : 'Invalid body' });
            }
            try {
              const result = await handleCredentialSave(body);
              return sendJson(res, 200, result);
            } catch (err) {
              const pw = body && typeof body.password === 'string' ? body.password : '';
              const msg = err && err.message ? err.message : String(err);
              return sendJson(res, 400, { error: redactValue(msg, pw) });
            }
          }
          if (req.method === 'DELETE') {
            const result = await handleCredentialDelete(query);
            return sendJson(res, 200, result);
          }
          res.setHeader('Allow', 'GET, POST, DELETE');
          return sendJson(res, 405, { error: 'Method not allowed' });
        } catch (err) {
          return sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
        }
      }

      if (pathname === '/api/login') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return sendJson(res, 405, { error: 'Method not allowed (use POST)' });
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: err && err.message ? err.message : 'Invalid body' });
        }
        try {
          const result = await handleLoginOnly(body);
          return sendJson(res, 200, result);
        } catch (err) {
          const pw = body && typeof body.password === 'string' ? body.password : '';
          const msg = err && err.message ? err.message : String(err);
          return sendJson(res, 400, { error: redactValue(msg, pw) });
        }
      }

      if (pathname === '/api/login-and-shorten') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return sendJson(res, 405, { error: 'Method not allowed (use POST)' });
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: err && err.message ? err.message : 'Invalid body' });
        }
        try {
          const result = await handleLoginAndShorten(body);
          return sendJson(res, 200, result);
        } catch (err) {
          const pw = body && typeof body.password === 'string' ? body.password : '';
          const msg = err && err.message ? err.message : String(err);
          return sendJson(res, 400, { error: redactValue(msg, pw) });
        }
      }

      if (pathname === '/login/shopee') {
        res.statusCode = 302;
        res.setHeader('Location', '/login?platform=shopee');
        return res.end();
      }
      if (pathname === '/login/lazada') {
        res.statusCode = 302;
        res.setHeader('Location', '/login?platform=lazada');
        return res.end();
      }

      if (pathname === '/login') {
        if (clientWantsJson(req, query)) {
          const result = await handleLogin(query);
          return sendJson(res, 200, result);
        }
        return sendHtml(res, 200, loginHtmlPage({ platform: query.platform, account: query.account }));
      }

      const hostHeader = req && req.headers ? req.headers.host : '';
      const treatAsClickReport = pathname === '/click-report'
        || (pathname === '/' && clickReport.isClickReportHost(hostHeader));

      if (treatAsClickReport) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return sendJson(res, 405, { error: 'Method not allowed (use GET)' });
        }
        try {
          const payload = await clickReport.handleClickReport(query);
          return sendJson(res, 200, payload);
        } catch (err) {
          if (err && err.publicPayload) {
            return sendJson(res, err.statusCode || 400, err.publicPayload);
          }
          throw err;
        }
      }

      const treatAsConversionReport = pathname === '/conversion-report'
        || (pathname === '/' && conversionReport.isConversionReportHost(hostHeader));

      if (pathname === '/daily-income-report' || pathname === '/income-report') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return sendJson(res, 405, { error: 'Method not allowed (use GET)' });
        }
        try {
          const payload = await conversionReport.handleDailyIncomeReport(query);
          return sendJson(res, 200, payload);
        } catch (err) {
          if (err && err.publicPayload) {
            return sendJson(res, err.statusCode || 400, err.publicPayload);
          }
          throw err;
        }
      }

      if (treatAsConversionReport) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return sendJson(res, 405, { error: 'Method not allowed (use GET)' });
        }
        try {
          const payload = await conversionReport.handleConversionReport(query);
          return sendJson(res, 200, payload);
        } catch (err) {
          if (err && err.publicPayload) {
            return sendJson(res, err.statusCode || 400, err.publicPayload);
          }
          throw err;
        }
      }

      if (pathname === '/' || pathname === '/shorten') {
        if (!query.url) {
          if (pathname === '/') return sendHtml(res, 200, indexHtml());
          return sendJson(res, 400, { error: 'Missing required parameter: url' });
        }
        try {
          const payload = await handleShorten(query);
          return sendJson(res, 200, payload);
        } catch (err) {
          if (err && err.manualLoginRequired) {
            return sendJson(res, 200, buildManualLoginRequiredPayload(query, err));
          }
          if (err && err.publicPayload) {
            return sendJson(res, err.statusCode || 400, err.publicPayload);
          }
          throw err;
        }
      }

      return sendJson(res, 404, { error: 'Not found', path: pathname });
    } catch (err) {
      if (err && err.publicPayload) {
        return sendJson(res, err.statusCode || 500, err.publicPayload);
      }
      return sendJson(res, 500, { error: err && err.message ? err.message : String(err) });
    }
  });
}

function start({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`[affiliate-shortlink-cloak] listening on http://${host}:${port}`);
    console.log(`[affiliate-shortlink-cloak] profile root: ${PROFILE_ROOT}`);
    console.log(`[affiliate-shortlink-cloak] backend: ${browser.backendInfo().source}`);
  });
  return server;
}

module.exports = {
  createServer,
  start,
  handleShorten,
  handleClickReport: clickReport.handleClickReport,
  isClickReportHost: clickReport.isClickReportHost,
  handleConversionReport: conversionReport.handleConversionReport,
  handleDailyIncomeReport: conversionReport.handleDailyIncomeReport,
  isConversionReportHost: conversionReport.isConversionReportHost,
  handleLogin,
  handleLoginAndShorten,
  handleLoginOnly,
  handleAccounts,
  handleHealth,
  handleDebug,
  handleCredentialStatus,
  handleCredentialList,
  handleCredentialSave,
  handleCredentialDelete,
  attemptReauthWithStoredCredential,
  credentialAccountCandidates,
  buildManualLoginRequiredPayload,
  loginUiHtml,
  loginHtmlPage,
  accountListsForHtml,
  clientWantsJson,
  readJsonBody,
  recordSessionState,
  getSessionStateSnapshot,
  listSessionStateSnapshots,
  ensureShopeeReadyForShorten,
  buildAccountsSessionState,
  listReadyShopeeAccountsForFallback,
  isSessionSnapshotFresh,
  SESSION_FRESHNESS_MS,
  _resetSessionStateCacheForTest,
};
