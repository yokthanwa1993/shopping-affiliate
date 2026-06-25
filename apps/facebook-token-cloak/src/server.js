'use strict';
const http = require('http');
const { sanitizeAccount } = require('./accounts');
const { redactToken, sanitizeUrlSecrets } = require('./redact');
const keychain = require('./keychain');
const browser = require('./browser');
const accountSelectors = require('./account-selectors');
const accountsRegistry = require('./accounts-registry');
const ui = require('./ui');
const posting = require('./posting');
const fbLiteTokenService = require('./fb-lite-token-service.cjs');
const {
  FACEBOOK_OAUTH_URL,
  extractAccessTokenFromUrl,
  classifyFacebookState,
  buildNoTokenRefreshResponse,
  fetchPages
} = require('./facebook');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8820;

// Worker posting bridge config (non-secret Facebook object ids, env-overridable). These drive
// the persistent logged-in CloakBrowser profile so the Worker can call the bridge without ever
// shipping a token. Defaults match the verified live `content_paiya` SALES template flow.
//
// Latest user-owned Ads Manager template (TEMPLATE_SALES):
//   campaign_id 120248134990220263
//   adset_id    120248134990230263
// Do NOT silently fall back to the retired pre-SALES template adset 120244361318490263.
const DEFAULT_TEMPLATE_ADSET = '120248134990230263';
const POST_ACCOUNT = process.env.FACEBOOK_TOKEN_CLOAK_POST_ACCOUNT || 'content_paiya';
// Admin/user namespace that may receive a Facebook Lite bridge BULK page import (Thanwa's
// namespace). The bulk /token/import-pages endpoint is fail-closed: it imports ONLY into this
// namespace (plus any explicitly env-allowlisted ids). Other namespaces keep their existing
// one-by-one manual add behavior — they are never touched by the bulk importer.
const ADMIN_IMPORT_NAMESPACE_ID = process.env.FACEBOOK_TOKEN_CLOAK_IMPORT_NAMESPACE || '61550488976801';
const POST_AD_ACCOUNT = process.env.FACEBOOK_TOKEN_CLOAK_POST_AD_ACCOUNT || 'act_1148837732288721';
const ADS_AD_ACCOUNT = process.env.FACEBOOK_TOKEN_CLOAK_AD_ACCOUNT || 'act_1030797047648459';
const TEMPLATE_ADSET = process.env.FACEBOOK_TOKEN_CLOAK_TEMPLATE_ADSET || DEFAULT_TEMPLATE_ADSET;
// Graph polling interval; FACEBOOK_TOKEN_CLOAK_POLL_MS=0 makes tests resolve instantly.
const POLL_MS = (() => {
  const raw = process.env.FACEBOOK_TOKEN_CLOAK_POLL_MS;
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
})();

// Map a posting-result object to an HTTP status. `validate` failures are client errors (400);
// every other shape carries an explicit `status` (page-comment) or defaults to 200 with ok:false
// so the Worker can read the step/error without treating it as a transport failure.
function postingStatus(result) {
  if (!result || result.ok) return 200;
  if (result.status) return result.status;
  if (result.step === 'validate') return 400;
  return 200;
}

// Decide whether a request should mint a token through the Facebook Lite (EAAD6V) path instead
// of the persistent CloakBrowser session. Triggers on an explicit flag (facebook_lite /
// token_source=facebook_lite_bridge / …) OR a numeric account id (a Facebook Lite user id has no
// CloakBrowser profile, so it can only be served by the Lite credential login).
function wantsFacebookLiteBridge(account, body = {}) {
  const flag = String(body.facebook_lite || body.facebookLite || body.token_source || body.source || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'facebook_lite', 'fb_lite', 'facebook_lite_bridge', 'facebook_lite_eaad6'].includes(flag)) return true;
  return /^[0-9]{8,}$/.test(String(account || '').trim());
}

async function optionalSecret(fn) {
  try { return await fn(); } catch { return null; }
}

// The set of namespace ids the bulk Facebook Lite page importer is allowed to write into. Always
// includes the admin namespace (ADMIN_IMPORT_NAMESPACE_ID); an operator may widen it via the
// FACEBOOK_TOKEN_CLOAK_IMPORT_NAMESPACE_ALLOWLIST env (comma/space separated). Any namespace NOT
// in this set is rejected (fail-closed) so the bulk path can never affect other tenants.
function allowedImportNamespaceIds() {
  const ids = new Set();
  const admin = String(ADMIN_IMPORT_NAMESPACE_ID || '').trim();
  if (admin) ids.add(admin);
  for (const raw of String(process.env.FACEBOOK_TOKEN_CLOAK_IMPORT_NAMESPACE_ALLOWLIST || '').split(/[\s,]+/)) {
    const id = String(raw || '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

// Mint a FRESH Facebook Lite (EAAD6V) USER token straight from the stored Keychain credentials
// (username/password + optional TOTP + datr), via the FB Lite login → auth.getSessionforApp(FB_LITE)
// conversion. This is the ONLY success proof for a Facebook Lite account — a CloakBrowser/Power
// Editor session is never used to vouch for it. The raw token stays inside the returned object and
// is only ever handed to Graph (`graphFetch`); callers surface `prefix` (e.g. "EAAD6V") as a hint.
async function resolveFacebookLiteEAAD6Session(deps, account) {
  const { kc, fbLite, fetchImpl } = deps;
  const safe = sanitizeAccount(account).display;
  let credential;
  try {
    credential = await kc.retrieveCredential(account);
  } catch (e) {
    return { token: null, ok: false, source: 'facebook_lite_eaad6', reason: (e && (e.code || e.message)) || 'fb_lite_credential_unavailable' };
  }
  if (!credential || !credential.username || !credential.password) {
    return { token: null, ok: false, source: 'facebook_lite_eaad6', reason: 'fb_lite_credential_missing' };
  }
  const twofa = await optionalSecret(() => kc.retrieveTotp(account));
  const datr = await optionalSecret(() => kc.retrieveDatr(account));
  let result;
  try {
    result = await fbLite.facebookLogin({
      identifier: String(credential.username || safe).trim(),
      password: String(credential.password || ''),
      twofa: twofa || null,
      datr: datr || null,
      target_app: 'FB_LITE',
      timeout_seconds: 45
    });
  } catch (e) {
    return { token: null, ok: false, source: 'facebook_lite_eaad6', reason: (e && (e.code || e.message)) || 'fb_lite_token_error' };
  }
  if (!result || result.success !== true) {
    return { token: null, ok: false, source: 'facebook_lite_eaad6', reason: (result && (result.error_user_msg || result.error)) || 'fb_lite_token_login_failed' };
  }
  const token = String((result.converted_token && result.converted_token.access_token) || '').trim();
  if (!token) return { token: null, ok: false, source: 'facebook_lite_eaad6', reason: 'fb_lite_converted_token_missing' };
  const prefix = fbLite.extractTokenPrefix(token);
  // FB Lite (app 275254692598279) tokens are EAAD6V-style. Reject anything else so we fail closed
  // rather than posting with a wrong-app token that the Worker would then cache as a bad EAAD6V.
  if (!token.startsWith('EAAD6')) {
    return { token: null, ok: false, source: 'facebook_lite_eaad6', reason: 'fb_lite_token_prefix_mismatch', prefix };
  }
  return { token, ok: true, source: 'facebook_lite_eaad6', prefix, account: safe, graphFetch: fetchImpl };
}

// Resolve the PAGE access token for `pageId` from a freshly minted Facebook Lite user token using
// me/accounts semantics. The returned page token inherits the FB Lite app, so it is EAAD6V-style
// too — exactly the token shape the Worker posts/comments with. Status ranks mirror the CloakBrowser
// export path so a caller can compare/rank outcomes. No raw token is ever returned (pageToken stays
// internal; only `prefix` is surfaced).
async function resolveFacebookLitePageToken(deps, account, pageId) {
  const lite = await resolveFacebookLiteEAAD6Session(deps, account);
  const base = { source: 'facebook_lite_eaad6', prefix: lite.prefix || null, page_found: false, hasToken: false, pageToken: '', pageName: '' };
  if (!lite.ok || !lite.token) {
    return { ...base, status: 'fb_lite_token_not_ready', reason: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready') };
  }
  let info;
  try {
    info = await posting.resolvePageToken(lite.graphFetch, lite.token, pageId);
  } catch (e) {
    return { ...base, status: 'graph_pages_failed', reason: sanitizePublicReason((e && (e.reason || e.code || e.message)) || 'graph_pages_failed', 'graph_pages_failed') };
  }
  if (info && info.error) {
    return { ...base, status: 'graph_pages_failed', reason: sanitizePublicReason(info.error, 'graph_pages_failed') };
  }
  if (!info || !info.found) return { ...base, status: 'page_not_found' };
  if (!info.pageToken) return { ...base, status: 'page_token_unavailable', page_found: true, pageName: String(info.pageName || '') };
  return { ...base, status: 'ok', page_found: true, hasToken: true, pageToken: info.pageToken, pageName: String(info.pageName || '') };
}

function isLocalRequest(req) {
  const a = req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function parseBool(v, f = false) {
  if (v == null || v === '') return f;
  return v === true || v === '1' || v === 'true' || v === 'yes';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1048576) reject(Object.assign(new Error('Body too large'), { status: 413 }));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const UI_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': UI_CSP
  });
  res.end(html);
}

function sendError(res, status, message, extra = {}) {
  send(res, status, { success: false, error: message, ...extra });
}

function hasValue(v) {
  return v != null && String(v).trim() !== '';
}

function sanitizePublicReason(value, fallback = 'request_failed') {
  const text = sanitizeUrlSecrets(String(value || fallback)).slice(0, 500);
  return text
    .replace(/\bEAA[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(fb_dtsg|datr|cookie|cookies|password)\b\s*[:=]?\s*[^,\s;)]+/ig, '$1=[REDACTED]');
}

async function safeKeychainStatus(kc, account) {
  try {
    return await kc.getStatus(account);
  } catch {
    return { credentialPresent: false, usernamePresent: false, passwordPresent: false, totpPresent: false, datrPresent: false };
  }
}

async function safeSelectorStatus(selectors, account) {
  try {
    return await selectors.getSelectorStatus(account);
  } catch {
    return { selectorPresent: false, usernameHintPresent: false, selectedDomain: null };
  }
}

// Builds the redacted public view of one account: non-secret registry metadata plus
// present/absent flags from the Keychain and the apple-passwords selector. No secret
// value (password/TOTP/datr/token/cookie) is ever included here.
function mergeAccountStatus(record, kcStatus, selStatus) {
  return {
    account: record.account,
    key: record.key,
    displayName: record.displayName || null,
    provider: record.provider || accountsRegistry.DEFAULT_PROVIDER,
    username: record.username || null,
    email: record.email || null,
    phone: record.phone || null,
    domain: record.domain || null,
    server: record.server || null,
    protocol: record.protocol || null,
    convertTokenMode: record.convertTokenMode || 'none',
    inRegistry: record.inRegistry !== false,
    credentialPresent: !!kcStatus.credentialPresent,
    usernamePresent: !!kcStatus.usernamePresent,
    passwordPresent: !!kcStatus.passwordPresent,
    totpPresent: !!kcStatus.totpPresent,
    datrPresent: !!kcStatus.datrPresent,
    selectorPresent: !!selStatus.selectorPresent,
    usernameHintPresent: !!selStatus.usernameHintPresent,
    selectedDomain: selStatus.selectedDomain || null
  };
}

// Union of registry accounts and any legacy apple-passwords selector-only accounts,
// each enriched with redacted Keychain + selector status.
async function listAccountStatuses(kc, selectors, registry) {
  const byKey = new Map();
  for (const rec of await registry.listAccounts()) byKey.set(rec.key, { ...rec, inRegistry: true });
  if (typeof selectors.listStatuses === 'function') {
    let selList = [];
    try {
      selList = await selectors.listStatuses();
    } catch {}
    for (const sel of selList) {
      const { key, display } = sanitizeAccount(sel.account);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        account: display,
        key,
        displayName: null,
        provider: 'apple-passwords',
        username: null,
        email: null,
        phone: null,
        domain: sel.selectedDomain || sel.domain || null,
        server: sel.selectedServer || sel.server || null,
        protocol: sel.selectedProtocol || sel.protocol || null,
        convertTokenMode: 'none',
        inRegistry: false
      });
    }
  }
  const out = [];
  for (const rec of byKey.values()) {
    const kcStatus = await safeKeychainStatus(kc, rec.account);
    const selStatus = await safeSelectorStatus(selectors, rec.account);
    out.push(mergeAccountStatus(rec, kcStatus, selStatus));
  }
  out.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return out;
}

function credentialProviderFromParams(params) {
  const raw = params.get('credentialProvider') || params.get('provider');
  if (!raw) return 'generic-keychain';
  const provider = String(raw).trim().toLowerCase();
  if (provider === 'apple-passwords') return 'apple-passwords';
  if (provider === 'generic-keychain' || provider === 'generic' || provider === 'keychain') return 'generic-keychain';
  throw Object.assign(new Error('Unsupported credential provider'), { status: 400 });
}

function internetPasswordOptionsFromParams(params) {
  return {
    domain: params.get('domain') || undefined,
    server: params.get('server') || undefined,
    protocol: params.get('protocol') || undefined,
    username: params.get('username') || undefined
  };
}

function mergeSelectorOptions(explicitOptions, selector) {
  if (!selector) return explicitOptions;
  const selectedServer = explicitOptions.server || explicitOptions.domain || selector.server || selector.domain;
  return {
    domain: selectedServer,
    server: selectedServer,
    protocol: explicitOptions.protocol || selector.protocol,
    username: explicitOptions.username || selector.username
  };
}

function selectorMergeStatus(selector, credentialOptions) {
  if (!selector) return { selectorPresent: false, usernameHintPresent: false };
  return {
    selectorPresent: true,
    usernameHintPresent: !!selector.username,
    selectedDomain: credentialOptions.domain || credentialOptions.server || null,
    selectedServer: credentialOptions.server || credentialOptions.domain || null,
    selectedProtocol: credentialOptions.protocol || null
  };
}

async function resolveCredentialOptions(selectors, account, provider, params) {
  const explicitOptions = internetPasswordOptionsFromParams(params);
  if (provider !== 'apple-passwords') {
    return {
      credentialOptions: explicitOptions,
      selector: null,
      selectorStatus: selectorMergeStatus(null, explicitOptions)
    };
  }
  const selector = await selectors.getSelector(account);
  const credentialOptions = mergeSelectorOptions(explicitOptions, selector);
  return {
    credentialOptions,
    selector,
    selectorStatus: selectorMergeStatus(selector, credentialOptions)
  };
}

function redactedFillResult(fill) {
  return {
    autofilled: !!(fill && fill.autofilled),
    submitted: !!(fill && fill.submitted),
    twoFactorHandled: !!(fill && fill.twoFactorHandled),
    trustedDeviceHandled: !!(fill && fill.trustedDeviceHandled),
    savePasswordPromptHandled: !!(fill && fill.savePasswordPromptHandled),
    savePasswordDismissed: !!(fill && (fill.savePasswordDismissed || fill.savePasswordPromptHandled)),
    ...(fill && fill.submitMethod ? { submitMethod: fill.submitMethod } : {})
  };
}

// A URL still sitting on the login/checkpoint/2FA wall — used to keep a submitted-but-unfinished
// login from being mistaken for a real session.
function isAuthWallUrl(url) {
  const u = String(url || '');
  return !u || /\/login|checkpoint|two_factor|two-factor|two_step|recover/i.test(u);
}

// Map the redacted fill flags + datr capture + landing URL to a public login state. A pending 2FA
// prompt we could not auto-complete is surfaced as two_factor_required; a confirmed session as
// logged_in; otherwise it degrades through datr_saved / login_submitted down to login_opened.
function classifyLoginOutcome(fill, datrStatus, currentUrl) {
  if (fill && fill.twoFactorRequired && !fill.twoFactorHandled) {
    return { state: 'two_factor_required', reason: 'two_factor_required' };
  }
  if (fill && fill.loggedIn) return { state: 'logged_in', reason: null };
  // The browser-side loggedIn flag can be false purely from timing even after a successful submit
  // (e.g. the page settled on /home.php once 2FA cleared). Trust a submitted login that landed off
  // the auth wall — anything checkpoint/2FA-shaped is already caught above and stays gated.
  if (fill && fill.submitted && !isAuthWallUrl(currentUrl)) return { state: 'logged_in', reason: null };
  if (datrStatus && datrStatus.datrPresent) return { state: 'datr_saved', reason: null };
  if (fill && fill.submitted) return { state: 'login_submitted', reason: null };
  return { state: 'login_opened', reason: null };
}

// Read the facebook.com `datr` cookie from the persistent browser context and store it in the
// Keychain. The value is never returned; only present/updated flags are. No-ops safely when the
// backend exposes no cookie jar (e.g. mock browser in tests).
async function captureAndStoreDatr(kc, br, account, opened) {
  if (!opened || !opened.context) return { datrPresent: false, datrUpdated: false };
  const datr = await br.readDatrCookie(opened.context).catch(() => null);
  if (!datr) return { datrPresent: false, datrUpdated: false };
  await kc.storeDatr(account, datr);
  return { datrPresent: true, datrUpdated: true };
}

async function retrieveCredentialForProvider(kc, account, provider, options) {
  if (provider === 'apple-passwords') return kc.retrieveInternetCredential(account, options);
  return kc.retrieveCredential(account);
}

function applePasswordsLoginError(error, account, selectorStatus = {}) {
  return {
    account,
    credentialProvider: 'apple-passwords',
    state: error.status === 409 ? 'credential_ambiguous' : 'credential_not_found',
    autofilled: false,
    submitted: false,
    ...(error.safeDetails || {}),
    ...selectorStatus
  };
}

function createHandler(deps = {}) {
  const kc = deps.keychain || keychain;
  const br = deps.browser || browser;
  const selectors = deps.accountSelectors || accountSelectors;
  const registry = deps.accountsRegistry || accountsRegistry;
  const fetchImpl = deps.fetch || global.fetch;
  const fbLite = deps.fbLiteTokenService || fbLiteTokenService;
  const downloadVideo = deps.downloadVideo;
  // Shared dependency bundle for the Facebook Lite (EAAD6V) token path.
  const liteDeps = { kc, fbLite, fetchImpl };
  return async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (!isLocalRequest(req)) return sendError(res, 403, 'UI is local-only');
        return sendHtml(res, ui.INDEX_HTML);
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        let backend = 'unavailable';
        try {
          backend = (await br.loadBrowserBackend()).backend;
        } catch {}
        return send(res, 200, {
          ok: true,
          app: 'facebook-token-cloak',
          host: DEFAULT_HOST,
          port: DEFAULT_PORT,
          backend,
          keychainSupported: process.platform === 'darwin',
          profileRoot: br.PROFILE_ROOT
        });
      }

      if (req.method === 'GET' && url.pathname === '/keychain/status') {
        const account = url.searchParams.get('account');
        if (!account) return sendError(res, 400, 'Missing account parameter');
        return send(res, 200, await kc.getStatus(account));
      }

      if (req.method === 'GET' && url.pathname === '/passwords/status') {
        const account = url.searchParams.get('account');
        if (!account) return sendError(res, 400, 'Missing account parameter');
        const { credentialOptions, selectorStatus } = await resolveCredentialOptions(selectors, account, 'apple-passwords', url.searchParams);
        const status = await kc.getInternetPasswordStatus(account, credentialOptions);
        return send(res, 200, { ...status, ...selectorStatus });
      }

      if (req.method === 'GET' && url.pathname === '/accounts/selector') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Selector endpoints are local-only');
        const account = url.searchParams.get('account');
        if (!account) return sendError(res, 400, 'Missing account parameter');
        return send(res, 200, await selectors.getSelectorStatus(account));
      }

      if ((req.method === 'POST' || req.method === 'PUT') && url.pathname === '/accounts/selector') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Selector endpoints are local-only');
        const body = await parseBody(req);
        const { account, ...selector } = body;
        if (!account) return sendError(res, 400, 'Missing account');
        return send(res, 200, await selectors.saveSelector(account, selector));
      }

      if (req.method === 'DELETE' && url.pathname === '/accounts/selector') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Selector endpoints are local-only');
        const body = Object.assign({}, Object.fromEntries(url.searchParams), await parseBody(req));
        if (!body.account) return sendError(res, 400, 'Missing account');
        return send(res, 200, await selectors.deleteSelector(body.account));
      }

      if (req.method === 'GET' && url.pathname === '/accounts') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Account endpoints are local-only');
        return send(res, 200, { accounts: await listAccountStatuses(kc, selectors, registry) });
      }

      if ((req.method === 'POST' || req.method === 'PUT') && url.pathname === '/accounts') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Account endpoints are local-only');
        const body = await parseBody(req);
        if (!body.account) return sendError(res, 400, 'Missing account');
        sanitizeAccount(body.account);
        if (hasValue(body.password) && !hasValue(body.username) && !hasValue(body.email) && !hasValue(body.phone)) {
          return sendError(res, 400, 'username (or email/phone) is required to store a password');
        }
        const record = await registry.upsertAccount(body.account, {
          displayName: body.displayName,
          provider: body.provider,
          username: body.username,
          email: body.email,
          phone: body.phone,
          domain: body.domain,
          server: body.server,
          protocol: body.protocol,
          convertTokenMode: body.convertTokenMode
        });
        let credentialUpdated = false;
        let totpUpdated = false;
        let datrUpdated = false;
        let selectorUpdated = false;
        if (hasValue(body.password)) {
          await kc.storeCredential(body.account, record.username || record.email || record.phone, body.password);
          credentialUpdated = true;
        }
        if (hasValue(body.totp)) {
          await kc.storeTotp(body.account, body.totp);
          totpUpdated = true;
        }
        if (hasValue(body.datr)) {
          await kc.storeDatr(body.account, body.datr);
          datrUpdated = true;
        }
        if (record.provider === 'apple-passwords' && record.username && (record.domain || record.server)) {
          try {
            await selectors.saveSelector(body.account, {
              credentialProvider: 'apple-passwords',
              domain: record.domain || record.server,
              username: record.username,
              protocol: record.protocol || undefined
            });
            selectorUpdated = true;
          } catch {}
        }
        const kcStatus = await safeKeychainStatus(kc, body.account);
        const selStatus = await safeSelectorStatus(selectors, body.account);
        const status = mergeAccountStatus({ ...record, inRegistry: true }, kcStatus, selStatus);
        return send(res, 200, { ...status, credentialUpdated, totpUpdated, datrUpdated, selectorUpdated });
      }

      if (req.method === 'DELETE' && url.pathname === '/accounts') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Account endpoints are local-only');
        const body = Object.assign({}, Object.fromEntries(url.searchParams), await parseBody(req));
        if (!body.account) return sendError(res, 400, 'Missing account');
        const { display } = sanitizeAccount(body.account);
        const purge = body.purgeSecrets !== false && body.purgeSecrets !== 'false';
        const removed = await registry.deleteAccount(body.account);
        if (purge) {
          try { await kc.deleteCredential(body.account); } catch {}
          try { await kc.deleteTotp(body.account); } catch {}
          try { await kc.deleteDatr(body.account); } catch {}
          try { await selectors.deleteSelector(body.account); } catch {}
        }
        return send(res, 200, { account: display, removed: removed.removed, secretsPurged: purge });
      }

      if (req.method === 'POST' && url.pathname === '/keychain/datr') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Keychain endpoints are local-only');
        const { account, datr } = await parseBody(req);
        if (!account || !datr) return sendError(res, 400, 'Missing account or datr');
        const r = await kc.storeDatr(account, datr);
        return send(res, 200, { ok: true, account: r.account, service: r.service });
      }

      if (req.method === 'DELETE' && url.pathname === '/keychain/datr') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Keychain endpoints are local-only');
        const body = Object.assign({}, Object.fromEntries(url.searchParams), await parseBody(req));
        if (!body.account) return sendError(res, 400, 'Missing account');
        const r = await kc.deleteDatr(body.account);
        return send(res, 200, { ok: true, account: r.account, service: r.service });
      }

      if (req.method === 'GET' && url.pathname === '/keychain/datr') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Keychain endpoints are local-only');
        const account = url.searchParams.get('account');
        if (!account) return sendError(res, 400, 'Missing account parameter');
        return send(res, 200, await kc.getDatrStatus(account));
      }

      if (req.method === 'POST' && url.pathname === '/keychain/credential') {
        const { account, username, password } = await parseBody(req);
        if (!account || !username || !password) return sendError(res, 400, 'Missing account, username, or password');
        const r = await kc.storeCredential(account, username, password);
        return send(res, 200, { ok: true, account: r.account, services: r.services });
      }

      if (req.method === 'DELETE' && url.pathname === '/keychain/credential') {
        const body = Object.assign({}, Object.fromEntries(url.searchParams), await parseBody(req));
        if (!body.account) return sendError(res, 400, 'Missing account');
        const r = await kc.deleteCredential(body.account);
        return send(res, 200, { ok: true, account: r.account, services: r.services });
      }

      if (req.method === 'POST' && url.pathname === '/keychain/totp') {
        const { account, secret } = await parseBody(req);
        if (!account || !secret) return sendError(res, 400, 'Missing account or secret');
        const r = await kc.storeTotp(account, secret);
        return send(res, 200, { ok: true, account: r.account, service: r.service });
      }

      if (req.method === 'DELETE' && url.pathname === '/keychain/totp') {
        const body = Object.assign({}, Object.fromEntries(url.searchParams), await parseBody(req));
        if (!body.account) return sendError(res, 400, 'Missing account');
        const r = await kc.deleteTotp(body.account);
        return send(res, 200, { ok: true, account: r.account, service: r.service });
      }

      if (req.method === 'GET' && url.pathname === '/login') {
        const account = url.searchParams.get('account');
        if (!account) return sendError(res, 400, 'Missing account parameter');
        const { display } = sanitizeAccount(account);
        const visible = parseBool(url.searchParams.get('visible'), false);
        const autofill = parseBool(url.searchParams.get('autofill'), true);
        const submit = parseBool(url.searchParams.get('submit'), false);
        const credentialProvider = credentialProviderFromParams(url.searchParams);
        const { credentialOptions, selectorStatus } = await resolveCredentialOptions(selectors, account, credentialProvider, url.searchParams);
        let credential = null;
        if (autofill && credentialProvider === 'apple-passwords') {
          try {
            credential = await retrieveCredentialForProvider(kc, account, credentialProvider, credentialOptions);
          } catch (e) {
            return sendError(
              res,
              e.status || 500,
              e.status ? e.message : 'Credential lookup failed',
              applePasswordsLoginError(e, display, selectorStatus)
            );
          }
        }
        const opened = await br.openPage(account, 'https://www.facebook.com/login', { visible });
        let fill = { autofilled: false, submitted: false };
        if (autofill) {
          try {
            const selectedCredential = credential || await retrieveCredentialForProvider(kc, account, credentialProvider, credentialOptions);
            // totpProvider is only invoked if a 2FA field actually appears, so the TOTP seed is read
            // from the Keychain lazily and never enters the response.
            fill = await br.fillFacebookLogin(opened.page, selectedCredential, {
              submit,
              totpProvider: () => kc.retrieveTotp(account).catch(() => null)
            });
            if (submit && fill && fill.autofilled && fill.submitted !== true) {
              fill = { ...fill, submitted: true, submitMethod: fill.submitMethod || 'requested' };
            }
          } catch {}
        }
        // datr capture runs independently of fill/2FA outcome so a stuck login still seeds the cookie.
        let datrStatus = { datrPresent: false, datrUpdated: false };
        if (submit) {
          try { datrStatus = await captureAndStoreDatr(kc, br, account, opened); } catch {}
        }
        const currentUrl = sanitizeUrlSecrets(opened.page.url());
        const outcome = classifyLoginOutcome(fill, datrStatus, currentUrl);
        return send(res, 200, {
          account: display,
          credentialProvider,
          state: outcome.state,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          backend: opened.backend,
          profileDir: opened.profileDir,
          loginUrl: 'https://www.facebook.com/login',
          currentUrl,
          ...selectorStatus,
          ...redactedFillResult(fill),
          ...datrStatus
        });
      }

      if (req.method === 'POST' && url.pathname === '/token/refresh') {
        const { account, visible = false, includeToken = false, oauthUrl = '' } = await parseBody(req);
        if (!account) return sendError(res, 400, 'Missing account');
        const selectedOauthUrl = String(oauthUrl || '').trim();
        if (selectedOauthUrl && !isLocalRequest(req)) return sendError(res, 403, 'oauthUrl override is only allowed for local requests');
        const { display } = sanitizeAccount(account);
        let opened;
        try {
          opened = await br.openPage(account, selectedOauthUrl || FACEBOOK_OAUTH_URL, { visible: !!visible });
        } catch (e) {
          return send(res, 200, buildNoTokenRefreshResponse(display, e.code || e.message || 'browser_open_failed'));
        }
        const currentUrl = opened.page.url();
        const token = extractAccessTokenFromUrl(currentUrl);
        if (!token) {
          const bodyText = await opened.page.textContent('body').catch(() => '');
          return send(res, 200, {
            ...buildNoTokenRefreshResponse(display, classifyFacebookState({ url: currentUrl, bodyText })),
            currentUrl: sanitizeUrlSecrets(currentUrl),
            backend: opened.backend,
            profileDir: opened.profileDir
          });
        }
        let pagesResult = { pages: [], pagesCount: 0 };
        try {
          pagesResult = await fetchPages(fetchImpl, token, includeToken && isLocalRequest(req));
        } catch (e) {
          return send(res, 200, {
            account: display,
            status: 'graph_pages_failed',
            tokenPresent: true,
            tokenPrefix: redactToken(token),
            error: e.reason || 'graph_pages_failed'
          });
        }
        const response = {
          account: display,
          status: 'ok',
          refreshed: true,
          tokenPresent: true,
          tokenPrefix: redactToken(token),
          backend: opened.backend,
          profileDir: opened.profileDir,
          pagesCount: pagesResult.pagesCount,
          pages: pagesResult.pages
        };
        if (includeToken === true) {
          if (!isLocalRequest(req)) return sendError(res, 403, 'includeToken is only allowed for local requests');
          response.token = token;
          response.warning = 'Raw token included only because includeToken=true on localhost. Do not log or share this response.';
        }
        return send(res, 200, response);
      }

      if (req.method === 'POST' && url.pathname === '/token/export') {
        const exportBody = await parseBody(req);
        const { account, target = 'video-affiliate', namespaceId, pageId, pageName, workerUrl, dryRun = true } = exportBody;
        if (!account) return sendError(res, 400, 'Missing account');
        const { display } = sanitizeAccount(account);
        const wantDryRun = dryRun !== false;
        // Facebook Lite accounts (numeric id or explicit flag) resolve the page token from a FRESH
        // EAAD6V Lite login, never from the CloakBrowser session. The pushed token is tagged so the
        // Worker records its source as facebook_lite_bridge (not cloak_session_bridge).
        const liteExport = wantsFacebookLiteBridge(account, exportBody);
        const tokenSource = liteExport ? 'facebook_lite_bridge' : 'cloak_session_bridge';

        // SAFE default: a dry run performs no Cloudflare/D1 writes and resolves no token. It only
        // echoes back what a real export WOULD push, so the UI/Dev can preview without side effects.
        if (wantDryRun) {
          return send(res, 200, {
            account: display,
            target,
            namespaceId: namespaceId || null,
            pageId: pageId || null,
            dryRun: true,
            status: 'dry_run_only',
            token_source: tokenSource,
            wouldUpdate: ['pages_token_pool_v1', 'pages.access_token'],
            note: 'No Cloudflare/D1 writes performed by this endpoint.'
          });
        }

        // ── Real local-only export ─────────────────────────────────────────────────────────
        // Resolving a page token reads the logged-in CloakBrowser session, so a live export is
        // gated to localhost. A remote caller can never trigger a token resolution/push.
        if (!isLocalRequest(req)) return sendError(res, 403, 'Live token export is local-only');

        const ns = String(namespaceId || '').trim();
        const pid = String(pageId || '').trim();
        if (!ns || !pid) return sendError(res, 400, 'namespaceId and pageId are required for a live export');

        // Dedicated Bridge Token sync secret first, then the existing BrowserSaving tag-sync
        // secrets. Never echoed/logged; only its presence gates the push.
        const syncSecret = String(
          process.env.BRIDGE_TOKEN_SYNC_SECRET ||
          process.env.TAG_SYNC_PUSH_SECRET ||
          process.env.BROWSERSAVING_TAG_SYNC_SECRET ||
          ''
        ).trim();
        if (!syncSecret) {
          return send(res, 200, {
            ok: false,
            synced: false,
            status: 'sync_secret_missing',
            account: display,
            namespace_id: ns,
            page_id: pid
          });
        }

        // Resolve the requested page's token using the SAME cookie-bound session semantics as
        // GET /pages: list me/accounts over `session.graphFetch` (the logged-in CloakBrowser /
        // Ads Manager client), NOT a bare server fetch. A plain fetch with only the token misses
        // Ads-Manager-derived sessions, which is why /pages saw the page but the old exporter did
        // not. Each attempt owns its session and closes it; the page token never leaves this
        // closure except in the secret-authed push body below.
        const resolvePageForExport = async (acct) => {
          const session = await posting.resolveSessionToken({ browser: br, account: acct });
          try {
            if (!session.token) {
              return { status: 'no_session', page_found: false, hasToken: false, pageToken: '', pageName: '' };
            }
            let pagesResult;
            try {
              pagesResult = await posting.listPagesPublic(session.graphFetch, session.token, true);
            } catch (e) {
              return {
                status: 'graph_pages_failed', page_found: false, hasToken: false, pageToken: '', pageName: '',
                reason: sanitizePublicReason((e && (e.reason || e.code || e.message)) || 'graph_pages_failed', 'graph_pages_failed')
              };
            }
            if (pagesResult && pagesResult.error) {
              return {
                status: 'graph_pages_failed', page_found: false, hasToken: false, pageToken: '', pageName: '',
                reason: sanitizePublicReason(pagesResult.error, 'graph_pages_failed')
              };
            }
            const match = (pagesResult.data || []).find((p) => String(p && p.id) === pid);
            if (!match) {
              return { status: 'page_not_found', page_found: false, hasToken: false, pageToken: '', pageName: '' };
            }
            const pageToken = match.access_token ? String(match.access_token) : '';
            if (!pageToken) {
              return { status: 'page_token_unavailable', page_found: true, hasToken: false, pageToken: '', pageName: String(match.name || '') };
            }
            return { status: 'ok', page_found: true, hasToken: true, pageToken, pageName: String(match.name || '') };
          } finally {
            await posting.closeSession(session);
          }
        };

        // Rank how far an attempt got so a fallback can only ever IMPROVE the outcome.
        const exportRank = (status) => {
          switch (status) {
            case 'ok': return 3;
            case 'page_token_unavailable': return 2;
            case 'page_not_found': return 1;
            default: return 0; // no_session / graph_pages_failed
          }
        };

        let resolved;
        let effectiveAccount = display;
        if (liteExport) {
          // Facebook Lite: mint a fresh EAAD6V token and resolve the page token over me/accounts.
          // NO CloakBrowser fallback — a Cloak session must never stand in as proof for a Lite page.
          resolved = await resolveFacebookLitePageToken(liteDeps, account, pid);
        } else {
          resolved = await resolvePageForExport(account);
          // SAFE fallback: only when the explicit account could not resolve a usable page token,
          // retry once with the default configured posting account/session — it is proven to list
          // every administered page. The default is tried only if it is a different account, and is
          // adopted only when it gets strictly further than the explicit attempt. The response still
          // never carries a token; it only names the effective account.
          if (resolved.status !== 'ok' && String(account).trim() !== String(POST_ACCOUNT).trim()) {
            const fb = await resolvePageForExport(POST_ACCOUNT);
            if (exportRank(fb.status) > exportRank(resolved.status)) {
              resolved = fb;
              effectiveAccount = sanitizeAccount(POST_ACCOUNT).display;
            }
          }
        }

        if (resolved.status !== 'ok') {
          return send(res, 200, {
            ok: false, synced: false, status: resolved.status,
            account: effectiveAccount, namespace_id: ns, page_id: pid,
            token_source: tokenSource,
            page_found: resolved.page_found, hasToken: resolved.hasToken,
            ...(resolved.prefix ? { token_prefix: resolved.prefix } : {}),
            ...(resolved.reason ? { reason: resolved.reason } : {})
          });
        }

        const pageToken = resolved.pageToken;
        const resolvedPageName = String(pageName || resolved.pageName || '').trim();

        // Push the page-scoped token into the Worker namespace token pool via the secret-authed
        // server-to-server route. The token rides in the request body ONLY — it is never placed
        // in our own response or logs.
        const base = String(
          workerUrl ||
          process.env.VIDEO_AFFILIATE_WORKER_URL ||
          process.env.WORKER_URL ||
          'https://api.pubilo.com'
        ).trim().replace(/\/+$/, '');
        const syncUrl = `${base}/api/pages/profile-sync`;
        const syncPayload = {
          namespace_id: ns,
          page_id: pid,
          page_name: resolvedPageName,
          access_token: pageToken,
          comment_token: pageToken,
          account: effectiveAccount,
          // Advisory only: the Worker's profile-sync ignores unknown fields and keys posting on the
          // token VALUE (a fresh EAAD6V Lite page token leads pages_token_pool_v1 + pages.access_token
          // via normalizePostTokenPool, so force-post derives an EAAD6V hint — never cloak_session_bridge
          // and never the stale EAABsb token). This tag documents the source for diagnostics/logs.
          token_source: tokenSource
        };

        let workerStatus = 0;
        let profileSyncSuccess = false;
        try {
          const resp = await fetchImpl(syncUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tag-sync-secret': syncSecret },
            body: JSON.stringify(syncPayload)
          });
          workerStatus = Number(resp && resp.status) || 0;
          let data = {};
          try { data = await resp.json(); } catch {}
          profileSyncSuccess = !!((resp && resp.ok !== false && (workerStatus === 0 || (workerStatus >= 200 && workerStatus < 300))) && data && data.success === true);
        } catch (e) {
          return send(res, 200, {
            ok: false, synced: false, status: 'worker_unreachable',
            account: effectiveAccount, namespace_id: ns, page_id: pid,
            page_found: true, hasToken: true, token_source: tokenSource,
            reason: sanitizePublicReason((e && (e.code || e.message)) || 'worker_unreachable', 'worker_unreachable')
          });
        }

        return send(res, 200, {
          ok: profileSyncSuccess,
          synced: profileSyncSuccess,
          status: profileSyncSuccess ? 'synced' : 'worker_rejected',
          target,
          account: effectiveAccount,
          namespace_id: ns,
          page_id: pid,
          page_found: true,
          hasToken: true,
          token_source: tokenSource,
          ...(resolved.prefix ? { token_prefix: resolved.prefix } : {}),
          worker_status: workerStatus,
          profile_sync_success: profileSyncSuccess
        });
      }

      if (req.method === 'POST' && url.pathname === '/token/import-pages') {
        // Admin-only BULK page import. Lists every page the Facebook Lite account administers
        // (me/accounts — the SAME semantics as GET /pages?facebook_lite=1) and stages each into ONE
        // namespace's token pool through the Worker's secret-authed /api/pages/profile-sync, marked
        // is_active=0 + import_mode=facebook_lite_bridge_import so the operator activates them later.
        // Fail-closed to the admin namespace allowlist; local-only (it resolves Keychain creds and
        // page tokens); dry-run by default; token-free in EVERY response (no raw token ever returned).
        if (!isLocalRequest(req)) return sendError(res, 403, 'Bulk page import is local-only');
        const importBody = await parseBody(req);
        const { account, target = 'video-affiliate', workerUrl, dryRun = true } = importBody;
        const ns = String(importBody.namespaceId || importBody.namespace_id || '').trim();
        if (!account) return sendError(res, 400, 'Missing account');
        if (!ns) return sendError(res, 400, 'Missing namespaceId');
        const { display } = sanitizeAccount(account);
        const wantDryRun = dryRun !== false;

        // Fail closed: only the admin namespace (or an env-allowlisted id) may receive a bulk import.
        // Every other namespace keeps its existing one-by-one manual add behavior, untouched.
        const allowed = allowedImportNamespaceIds();
        if (!allowed.has(ns)) {
          return send(res, 403, {
            ok: false, status: 'namespace_not_allowed', namespace_id: ns, account: display,
            note: 'Bulk import is restricted to the admin namespace. Other namespaces keep manual add.'
          });
        }

        // Mint a fresh Facebook Lite (EAAD6V) session and list administered pages WITH page tokens
        // (local-safe). The page access_token stays INTERNAL — it only ever rides in the secret-authed
        // profile-sync body below, never in this endpoint's response.
        const lite = await resolveFacebookLiteEAAD6Session(liteDeps, account).catch((e) => ({ ok: false, reason: (e && (e.code || e.message)) || 'fb_lite_token_error' }));
        if (!lite.ok || !lite.token) {
          return send(res, 200, {
            ok: false, status: 'fb_lite_token_not_ready', namespace_id: ns, account: display, source: 'facebook_lite_eaad6',
            error: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready'),
            ...(lite.prefix ? { token_prefix: lite.prefix } : {})
          });
        }
        let listed;
        try {
          listed = await posting.listPagesPublic(lite.graphFetch, lite.token, true);
        } catch (e) {
          return send(res, 200, {
            ok: false, status: 'graph_pages_failed', namespace_id: ns, account: display, source: 'facebook_lite_eaad6',
            error: sanitizePublicReason((e && (e.reason || e.code || e.message)) || 'graph_pages_failed', 'graph_pages_failed')
          });
        }
        if (listed && listed.error) {
          return send(res, 200, {
            ok: false, status: 'graph_pages_failed', namespace_id: ns, account: display, source: 'facebook_lite_eaad6',
            error: sanitizePublicReason(listed.error, 'graph_pages_failed')
          });
        }
        const pages = Array.isArray(listed.data) ? listed.data : [];
        // Token-free candidate view: id/name/has_token only (access_token is NEVER surfaced).
        const candidates = pages.map((p) => ({
          page_id: p && p.id != null ? String(p.id) : null,
          page_name: p && p.name != null ? String(p.name) : '',
          has_token: !!(p && p.access_token)
        }));

        // SAFE default: a dry run lists the candidate pages + statuses and performs NO sync.
        if (wantDryRun) {
          return send(res, 200, {
            ok: true, dryRun: true, status: 'dry_run_only', target,
            namespace_id: ns, account: display, source: 'facebook_lite_eaad6',
            token_source: 'facebook_lite_bridge', import_mode: 'facebook_lite_bridge_import',
            ...(lite.prefix ? { token_prefix: lite.prefix } : {}),
            counts: { candidates: candidates.length, with_token: candidates.filter((c) => c.has_token).length },
            candidates,
            note: 'No Cloudflare/D1 writes performed. A real import stages each page is_active=0 (off) for the operator to activate later.'
          });
        }

        // ── Real bulk import: push each page-scoped token through the secret-authed profile-sync ──
        const syncSecret = String(
          process.env.BRIDGE_TOKEN_SYNC_SECRET ||
          process.env.TAG_SYNC_PUSH_SECRET ||
          process.env.BROWSERSAVING_TAG_SYNC_SECRET ||
          ''
        ).trim();
        if (!syncSecret) {
          return send(res, 200, { ok: false, synced: false, status: 'sync_secret_missing', namespace_id: ns, account: display });
        }
        const base = String(
          workerUrl ||
          process.env.VIDEO_AFFILIATE_WORKER_URL ||
          process.env.WORKER_URL ||
          'https://api.pubilo.com'
        ).trim().replace(/\/+$/, '');
        const syncUrl = `${base}/api/pages/profile-sync`;

        const counts = { created: 0, updated: 0, moved: 0, imported: 0, skipped: 0, errors: 0 };
        const results = [];
        for (const p of pages) {
          const pageId = p && p.id != null ? String(p.id) : '';
          const pageName = p && p.name != null ? String(p.name) : '';
          const pageToken = p && p.access_token ? String(p.access_token) : '';
          if (!pageId || !pageToken) {
            counts.skipped += 1;
            results.push({ page_id: pageId || null, page_name: pageName, status: 'skipped_no_token' });
            continue;
          }
          let workerStatus = 0;
          let data = {};
          try {
            const resp = await fetchImpl(syncUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-tag-sync-secret': syncSecret },
              body: JSON.stringify({
                namespace_id: ns,
                page_id: pageId,
                page_name: pageName,
                access_token: pageToken,
                comment_token: pageToken,
                account: display,
                token_source: 'facebook_lite_bridge',
                // Stage imported pages OFF; the operator turns them on later.
                is_active: 0,
                import_mode: 'facebook_lite_bridge_import'
              })
            });
            workerStatus = Number(resp && resp.status) || 0;
            try { data = await resp.json(); } catch { data = {}; }
          } catch (e) {
            counts.errors += 1;
            results.push({ page_id: pageId, page_name: pageName, status: 'worker_unreachable', reason: sanitizePublicReason((e && (e.code || e.message)) || 'worker_unreachable', 'worker_unreachable') });
            continue;
          }
          const success = !!(data && data.success === true) && (workerStatus === 0 || (workerStatus >= 200 && workerStatus < 300));
          if (!success) {
            counts.errors += 1;
            results.push({ page_id: pageId, page_name: pageName, status: 'worker_rejected', worker_status: workerStatus });
            continue;
          }
          counts.imported += 1;
          if (data.created) counts.created += 1;
          if (data.updated) counts.updated += 1;
          if (data.moved) counts.moved += 1;
          results.push({
            page_id: pageId, page_name: pageName, status: 'imported',
            created: !!data.created, updated: !!data.updated, moved: !!data.moved,
            staged_inactive: data.staged_inactive !== false
          });
        }

        return send(res, 200, {
          ok: counts.errors === 0,
          synced: counts.imported > 0,
          status: counts.errors === 0 ? 'imported' : 'imported_with_errors',
          target, namespace_id: ns, account: display,
          source: 'facebook_lite_eaad6', token_source: 'facebook_lite_bridge',
          import_mode: 'facebook_lite_bridge_import',
          ...(lite.prefix ? { token_prefix: lite.prefix } : {}),
          counts, results
        });
      }

      // ── Worker posting bridge routes (CloakBrowser) ──────────────────────────────────────
      // All resolve a fresh user token from the persistent logged-in profile, run their Graph
      // work through the cookie-bound browser client, and ALWAYS close the context in `finally`.
      // Raw tokens/cookies/fb_dtsg are never returned or logged.

      if (req.method === 'GET' && url.pathname === '/token') {
        const account = url.searchParams.get('account') || POST_ACCOUNT;
        if (wantsFacebookLiteBridge(account, { facebook_lite: url.searchParams.get('facebook_lite') || url.searchParams.get('token_source') || '' })) {
          const includeToken = ['1', 'true', 'yes'].includes(String(url.searchParams.get('includeToken') || '').trim().toLowerCase());
          if (includeToken && !isLocalRequest(req)) return sendError(res, 403, 'includeToken is only allowed for local requests');
          const lite = await resolveFacebookLiteEAAD6Session(liteDeps, account).catch((e) => ({ ok: false, source: 'facebook_lite_eaad6', reason: (e && (e.code || e.message)) || 'fb_lite_token_error' }));
          if (!lite.ok) return send(res, 200, { ok: false, accessToken: false, fbDtsg: false, source: 'facebook_lite_eaad6', account: sanitizeAccount(account).display, error: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready'), tokenPrefix: lite.prefix || null });
          const payload = { ok: true, accessToken: true, fbDtsg: false, source: 'facebook_lite_eaad6', tokenPrefix: lite.prefix, account: sanitizeAccount(account).display };
          // Operator verification ONLY: reveal the raw EAAD6V token on an explicit local request
          // (includeToken=1 from 127.0.0.1, e.g. the bundled UI's "Reveal token" button). Never on a
          // remote/tunnel request, and never logged.
          if (includeToken && isLocalRequest(req)) {
            payload.token = lite.token;
            payload.warning = 'Raw token included only because includeToken=1 on localhost. Do not log or share this response.';
          }
          return send(res, 200, payload);
        }
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          const accessToken = !!session.token;
          let fbDtsg = !!session.fbDtsgPresent;
          if (!fbDtsg && session.context) {
            try { fbDtsg = await posting.hasLoggedInSession(session.context); } catch {}
          }
          return send(res, 200, { ok: true, accessToken, fbDtsg, source: session.source || 'browser_session', account: sanitizeAccount(account).display });
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'GET' && url.pathname === '/pages') {
        const account = url.searchParams.get('account') || POST_ACCOUNT;
        const includeToken = ['1', 'true', 'yes'].includes(String(url.searchParams.get('includeToken') || '').trim().toLowerCase());
        if (includeToken && !isLocalRequest(req)) return sendError(res, 403, 'includeToken is only allowed for local requests');
        // Facebook Lite account: list administered pages from the freshly-minted EAAD6V user token via
        // me/accounts (NOT a CloakBrowser session). This is what the Worker's session-bridge organic
        // publish path probes (/token + /pages) before posting, and what /pages?includeToken=1 reads.
        if (wantsFacebookLiteBridge(account, { facebook_lite: url.searchParams.get('facebook_lite') || url.searchParams.get('token_source') || '' })) {
          const lite = await resolveFacebookLiteEAAD6Session(liteDeps, account).catch((e) => ({ ok: false, reason: (e && (e.code || e.message)) || 'fb_lite_token_error' }));
          if (!lite.ok || !lite.token) return send(res, 200, { data: [], source: 'facebook_lite_eaad6', error: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready') });
          const result = await posting.listPagesPublic(lite.graphFetch, lite.token, includeToken && isLocalRequest(req));
          return send(res, 200, { ...result, source: 'facebook_lite_eaad6' });
        }
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { data: [], error: 'no_session' });
          const result = await posting.listPagesPublic(session.graphFetch, session.token, includeToken && isLocalRequest(req));
          return send(res, 200, result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/post') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        if (wantsFacebookLiteBridge(account, body)) {
          const lite = await resolveFacebookLiteEAAD6Session(liteDeps, account).catch((e) => ({ ok: false, reason: (e && (e.code || e.message)) || 'fb_lite_token_error' }));
          if (!lite.ok || !lite.token) return send(res, 200, { ok: false, step: 'facebook_lite_token', error: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready'), source: 'facebook_lite_eaad6', token_prefix: lite.prefix || null });
          // A Facebook Lite (EAAD6V) PAGE token publishes an ORGANIC page video via /{page_id}/videos
          // with the page token — it has NO ad-account access, so the OneCard/advideos path returns
          // "(#10) Permission Denied". This is the organic /post the Worker's facebook_lite_bridge
          // fallback calls; the Shopee link rides in the Page comment (/page-comment), not an ad CTA.
          const result = await posting.publishPageVideoPost(lite.graphFetch, {
            userToken: lite.token,
            pageId: body.page_id,
            videoUrl: body.video_url,
            caption: body.message,
            title: body.title,
            adName: body.ad_name,
            downloadVideo,
            pollMs: POLL_MS
          });
          return send(res, postingStatus(result), { ...result, source: 'facebook_lite_eaad6', token_prefix: lite.prefix });
        }
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { ok: false, step: 'session', error: 'no_session' });
          const result = await posting.postOneCardVideo(session.graphFetch, {
            userToken: session.token,
            adAccount: body.ad_account || POST_AD_ACCOUNT,
            pageId: body.page_id,
            videoUrl: body.video_url,
            message: body.message,
            title: body.title,
            description: body.description,
            websiteUrl: body.website_url,
            cta: body.cta,
            downloadVideo,
            pollMs: POLL_MS
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/page-comment') {
        const body = await parseBody(req);
        const explicitAccount = body.account ? String(body.account).trim() : '';
        const pageId = String(body.page_id || '').trim();
        const tried = new Set();
        // allowLite is true ONLY for the explicitly-requested account. Auto-discovery candidates
        // (registry sweep) stay on the CloakBrowser session path so a comment never fans out into
        // real Facebook Lite logins across every numeric account in the registry.
        const tryCommentWithAccount = async (account, allowLite = false) => {
          const key = sanitizeAccount(account).key;
          if (!key || tried.has(key)) return null;
          tried.add(key);
          if (allowLite && wantsFacebookLiteBridge(account, body)) {
            const lite = await resolveFacebookLiteEAAD6Session(liteDeps, account).catch((e) => ({ ok: false, reason: (e && (e.code || e.message)) || 'fb_lite_token_error' }));
            if (!lite.ok || !lite.token) return { ok: false, status: 200, step: 'facebook_lite_token', error: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready'), source: 'facebook_lite_eaad6', token_prefix: lite.prefix || null };
            const result = await posting.pageComment(lite.graphFetch, {
              userToken: lite.token,
              pageId: body.page_id,
              target: body.target,
              storyId: body.story_id,
              postId: body.post_id,
              message: body.message
            });
            return { ...result, source: 'facebook_lite_eaad6', token_prefix: lite.prefix };
          }
          const session = await posting.resolveSessionToken({ browser: br, account });
          try {
            const result = await posting.pageComment(session.graphFetch, {
              userToken: session.token,
              pageId: body.page_id,
              target: body.target,
              storyId: body.story_id,
              postId: body.post_id,
              message: body.message
            });
            return result;
          } finally {
            await posting.closeSession(session);
          }
        };

        let result = await tryCommentWithAccount(explicitAccount || POST_ACCOUNT, true);
        const shouldAutoDiscoverAccount = pageId && (!explicitAccount) && result && result.step === 'page_token' && result.error === 'page_token_not_found';
        if (shouldAutoDiscoverAccount) {
          const accounts = await listAccountStatuses(kc, selectors, registry).catch(() => []);
          for (const entry of accounts) {
            const candidate = entry && (entry.account || entry.key);
            if (!candidate) continue;
            const candidateResult = await tryCommentWithAccount(candidate).catch((e) => ({ ok: false, status: 200, step: 'session', error: e && (e.code || e.message) || 'account_probe_failed' }));
            if (!candidateResult) continue;
            if (candidateResult.ok) { result = candidateResult; break; }
            // Keep scanning accounts that simply do not own/admin this page. Stop on
            // real comment/session errors from an account that did resolve beyond page ownership.
            if (!(candidateResult.step === 'page_token' && candidateResult.error === 'page_token_not_found')) {
              result = candidateResult;
              break;
            }
          }
        }
        return send(res, postingStatus(result), result || { ok: false, status: 409, step: 'session', error: 'no_session' });
      }

      if (req.method === 'POST' && url.pathname === '/edit-page-comment-link') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { ok: false, step: 'session', error: 'no_session' });
          // EDIT-ONLY: replace the Shopee link inside an EXISTING Page-owned comment. Never creates a
          // duplicate comment, never deletes; allow_create_new is intentionally not honored here.
          const result = await posting.editPageCommentLink(session.graphFetch, {
            userToken: session.token,
            pageId: body.page_id,
            storyId: body.story_id || body.post_id,
            alternateTargets: body.alternate_targets,
            oldLink: body.old_link,
            newLink: body.new_link,
            allowCreateNew: body.allow_create_new
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/create-ad') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { ok: false, step: 'session', error: 'no_session' });
          const result = await posting.createAd(session.graphFetch, {
            userToken: session.token,
            body,
            defaultAdAccount: ADS_AD_ACCOUNT,
            defaultTemplateAdset: TEMPLATE_ADSET,
            downloadVideo,
            pollMs: POLL_MS
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/promote') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { ok: false, step: 'session', error: 'no_session' });
          const result = await posting.promoteOneCardPost(session.graphFetch, {
            userToken: session.token,
            body,
            defaultAdAccount: ADS_AD_ACCOUNT,
            defaultTemplateAdset: TEMPLATE_ADSET,
            downloadVideo,
            pollMs: POLL_MS
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/publish-story') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const pageId = body.page_id;
        const storyId = body.story_id;
        if (!pageId || !storyId) return send(res, 400, { ok: false, step: 'validate', error: 'Missing: page_id, story_id' });
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { ok: false, step: 'session', error: 'no_session' });
          // Publish the SAME ad story to the page feed (page token only, resolved internally).
          // ok:true ONLY when publishStoryToPage confirms publishedToPage. No tokens returned.
          const pub = await posting.publishStoryToPage(session.graphFetch, { userToken: session.token, pageId, storyId, pollMs: POLL_MS });
          const ok = pub.publishedToPage === true;
          return send(res, 200, {
            ok,
            phase: 'publish_story',
            story_id: String(storyId),
            published_to_page: ok,
            post_url: `https://www.facebook.com/${String(storyId).replace('_', '/posts/')}`,
            ...(ok ? {} : { step: 'publish', error: pub.publishError || 'publish_failed' })
          });
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/update-cta') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { ok: false, step: 'session', error: 'no_session' });
          const result = await posting.updateVisiblePostCta(session.graphFetch, {
            userToken: session.token,
            pageId: body.page_id,
            storyId: body.story_id || body.post_id,
            finalCtaLink: body.final_cta_link || body.shortlink,
            ctaType: body.cta_type,
            reelId: body.reel_id,
            videoId: body.video_id
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/repair-ad-cta') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { ok: false, step: 'session', error: 'no_session' });
          // Repair the PAID ad creative CTA (Ads Manager) — DISTINCT from /update-cta (visible post).
          // Creates a new creative carrying the final post-specific Shopee link and re-points the ad.
          const result = await posting.repairPaidAdCta(session.graphFetch, {
            userToken: session.token,
            pageId: body.page_id,
            adId: body.ad_id,
            creativeId: body.creative_id,
            videoId: body.video_id,
            finalCtaLink: body.final_cta_link || body.shortlink,
            caption: body.caption,
            thumbnailUrl: body.thumbnail_url || body.image_url,
            adAccount: body.ad_account || ADS_AD_ACCOUNT,
            templateAdset: body.template_adset || TEMPLATE_ADSET,
            sourceStoryId: body.source_story_id || body.story_id,
            adName: body.ad_name,
            pollMs: POLL_MS
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/pause-ad-only') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { ok: false, step: 'session', error: 'no_session' });
          // Turn OFF finished system-created ad objects — status=PAUSED ONLY. This NEVER deletes:
          // pauseAdOnlyObjects issues no DELETE request and never sets status='DELETED'. Read-back of
          // status/effective_status is returned so the worker can record proof of the off-state.
          const result = await posting.pauseAdOnlyObjects(session.graphFetch, {
            userToken: session.token,
            campaignId: body.campaign_id,
            adsetId: body.adset_id,
            adId: body.ad_id
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      return sendError(res, 404, 'Not found');
    } catch (e) {
      return sendError(res, e.status || 500, e.status ? e.message : 'Internal server error');
    }
  };
}

function createServer(deps = {}) {
  return http.createServer(createHandler(deps));
}

function start(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  const server = createServer();
  server.listen(port, host, () => console.log(`facebook-token-cloak listening on ${host}:${port}`));
  return server;
}

module.exports = { createHandler, createServer, start, DEFAULT_PORT, DEFAULT_HOST, DEFAULT_TEMPLATE_ADSET };
