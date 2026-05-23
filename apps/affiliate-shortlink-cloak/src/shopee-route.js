'use strict';

const { SHOPEE_LEGACY_CUSTOM_LINK_URL } = require('./config');

const SHOPEE_AFFILIATE_HOST = 'affiliate.shopee.co.th';
const SHOPEE_ROUTE_NOT_FOUND_REASON = 'shopee_custom_link_route_not_found';
const SHOPEE_CUSTOM_LINK_LOGIN_REQUIRED_REASON = 'shopee_custom_link_login_required';

function currentPageUrl(page) {
  try {
    return page && typeof page.url === 'function' ? String(page.url() || '') : '';
  } catch {
    return '';
  }
}

function sanitizeDiagnosticUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  try {
    const parsed = new URL(input);
    const out = new URL(parsed.origin + parsed.pathname);
    for (const [key, value] of parsed.searchParams.entries()) {
      out.searchParams.append(key, value ? '[REDACTED]' : '[empty]');
    }
    if (parsed.hash) out.hash = '#[REDACTED]';
    return out.toString();
  } catch {
    return input
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
      .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '[REDACTED_PHONE]')
      .slice(0, 220);
  }
}

function domainForUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname;
  } catch {
    return '';
  }
}

function isShopeeAffiliateUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname === SHOPEE_AFFILIATE_HOST;
  } catch {
    return false;
  }
}

function isShopeeRouteNotFoundUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.hostname === SHOPEE_AFFILIATE_HOST && path === '/404';
  } catch {
    return false;
  }
}

function shopeeRouteNotFoundDiagnostic(rawUrl) {
  const url = String(rawUrl || '');
  return {
    capturedAt: new Date().toISOString(),
    platform: 'shopee',
    reason: SHOPEE_ROUTE_NOT_FOUND_REASON,
    url: sanitizeDiagnosticUrl(url),
    domain: domainForUrl(url),
    title: '',
    frameCount: 0,
    framesCaptured: 0,
    blockerMarkers: [],
    frames: [],
  };
}

function createShopeeRouteNotFoundError(rawUrl) {
  const err = new Error(SHOPEE_ROUTE_NOT_FOUND_REASON);
  err.manualLoginRequired = true;
  err.reason = SHOPEE_ROUTE_NOT_FOUND_REASON;
  err.diagnostic = shopeeRouteNotFoundDiagnostic(rawUrl);
  return err;
}

// Classify the URL the Shopee custom-link probe ends on. The affiliate origin
// alone is not enough — a stale session redirects to /buyer/login (or the
// affiliate /login page) and the bridge must surface that as an auth failure
// instead of falsely claiming alreadyAuthenticated.
function classifyShopeeCustomLinkUrl(rawUrl) {
  const value = String(rawUrl || '');
  if (!value) return { authenticated: false, reason: 'shopee_custom_link_no_current_url' };
  let parsed;
  try { parsed = new URL(value); } catch {
    return { authenticated: false, reason: 'shopee_custom_link_invalid_current_url' };
  }
  if (parsed.hostname !== SHOPEE_AFFILIATE_HOST) {
    if (/\/buyer\/login(\/|\?|$)/i.test(parsed.pathname + parsed.search)) {
      return { authenticated: false, reason: SHOPEE_CUSTOM_LINK_LOGIN_REQUIRED_REASON };
    }
    return { authenticated: false, reason: 'shopee_custom_link_off_affiliate_origin' };
  }
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (path === '/404') {
    return { authenticated: false, reason: SHOPEE_ROUTE_NOT_FOUND_REASON };
  }
  if (/^\/login(\/|$)/i.test(path)) {
    return { authenticated: false, reason: SHOPEE_CUSTOM_LINK_LOGIN_REQUIRED_REASON };
  }
  return { authenticated: true, reason: '' };
}

async function validateShopeeCustomLinkSession(page) {
  if (!page || typeof page.goto !== 'function') {
    return {
      ok: false,
      authenticated: false,
      reason: 'shopee_custom_link_probe_unavailable',
      currentUrl: '',
      sanitizedUrl: '',
    };
  }
  try {
    await page.goto(SHOPEE_LEGACY_CUSTOM_LINK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {}
  if (typeof page.waitForLoadState === 'function') {
    try { await page.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
  }
  if (typeof page.waitForTimeout === 'function') {
    try { await page.waitForTimeout(300); } catch {}
  }
  const currentUrl = currentPageUrl(page);
  const classification = classifyShopeeCustomLinkUrl(currentUrl);
  return {
    ok: classification.authenticated,
    authenticated: classification.authenticated,
    reason: classification.reason,
    currentUrl,
    sanitizedUrl: sanitizeDiagnosticUrl(currentUrl),
  };
}

function shopeeCustomLinkLoginRequiredDiagnostic(rawUrl, reason) {
  const url = String(rawUrl || '');
  return {
    capturedAt: new Date().toISOString(),
    platform: 'shopee',
    reason: reason || SHOPEE_CUSTOM_LINK_LOGIN_REQUIRED_REASON,
    url: sanitizeDiagnosticUrl(url),
    domain: domainForUrl(url),
    title: '',
    frameCount: 0,
    framesCaptured: 0,
    blockerMarkers: [],
    frames: [],
  };
}

module.exports = {
  SHOPEE_AFFILIATE_HOST,
  SHOPEE_ROUTE_NOT_FOUND_REASON,
  SHOPEE_CUSTOM_LINK_LOGIN_REQUIRED_REASON,
  currentPageUrl,
  sanitizeDiagnosticUrl,
  domainForUrl,
  isShopeeAffiliateUrl,
  isShopeeRouteNotFoundUrl,
  shopeeRouteNotFoundDiagnostic,
  createShopeeRouteNotFoundError,
  classifyShopeeCustomLinkUrl,
  validateShopeeCustomLinkSession,
  shopeeCustomLinkLoginRequiredDiagnostic,
};
