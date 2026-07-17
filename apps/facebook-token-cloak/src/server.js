'use strict';
const http = require('http');
const { sanitizeAccount } = require('./accounts');
const { redactToken, sanitizeUrlSecrets } = require('./redact');
const keychain = require('./keychain');
const browser = require('./browser');
const accountSelectors = require('./account-selectors');
const accountsRegistry = require('./accounts-registry');
const bridgeConfig = require('./bridge-config');
const posting = require('./posting');
const profileArchiveSync = require('./profileArchiveSync');
const { createRemoteBrowserManager } = require('./remoteBrowser');
const { attachRemoteBrowserUpgrade } = require('./remoteBrowserWs');
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

// Facebook Lite token minting/enumeration/auto-sync moved ENTIRELY to the IDLogin/IDBridge stack:
// the receiver on 8799 mints from the iOS-Keychain credentials and profile-syncs page tokens to the
// Worker. This service NO LONGER mints, enumerates, or auto-syncs Facebook Lite tokens. Any request
// that targets the Facebook Lite path (numeric uid or an explicit facebook_lite flag) fails closed
// here; Power Editor / Meta Ads / Accounts Bridge / CloakBrowser sessions are unaffected.
function facebookLiteRemoved(res, extra = {}) {
  return send(res, 410, {
    ok: false,
    error: 'facebook_lite_removed',
    hint: 'Facebook Lite tokens are minted only by the IDLogin/IDBridge app (receiver /fb-relogin).',
    ...extra
  });
}

// (Facebook Lite mint helpers removed — minting now lives only in the IDLogin/IDBridge receiver.)

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

// ── Narrow CORS for the Pubilo dashboard Accounts page ──────────────────────────────────────────
// The dashboard is served from https://www.pubilo.com but the Accounts Bridge runs on THIS Mac at
// 127.0.0.1:8820. A browser tab on pubilo.com can read a loopback response only if we echo an
// allowed Origin back. We do this ONLY for the safe, token-free accounts read/open/close endpoints
// — never for any token-mint or posting route — so the bridge stays a local-only surface for
// everything that touches a secret. No credentials are allowed (the dashboard fetches with
// credentials:'omit'), so the echoed origin is always a single concrete origin, never '*'.
const CORS_ALLOWED_ORIGINS = new Set([
  'https://www.pubilo.com',
  'https://pubilo.com',
  'https://dashboard.pubilo.com',
  // Local dev / preview origins for the React dashboard (Vite dev 5173, preview 4173).
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
]);

// Endpoints the dashboard Accounts page may call cross-origin: status-only reads plus the explicit
// user-triggered visible-open / close actions. None of these mint, refresh, or return a secret.
const CORS_SAFE_PATHS = new Set([
  '/health',
  '/accounts',
  '/accounts/bridge/status',
  '/accounts/bridge/facebook',
  '/accounts/profile-status',
  '/login',
  '/login/close'
]);

// Remote (cloud) browser routes carry a session id in the path, so they cannot live in the fixed
// CORS_SAFE_PATHS set. They are token-free (only id/url/title/status + a rasterized image) and the
// dashboard drives them cross-origin, so they are treated as CORS-safe via this matcher. The session
// id is an unguessable crypto handle, never an account secret.
const REMOTE_BROWSER_PREFIX = '/remote-browser';
function isRemoteBrowserCorsPath(pathname) {
  return pathname === REMOTE_BROWSER_PREFIX + '/start'
    || pathname === REMOTE_BROWSER_PREFIX + '/display/status'
    || /^\/remote-browser\/[A-Za-z0-9_-]+\/(status|screenshot|input|stop)$/.test(pathname);
}

// The remote-browser routes are reached by the dashboard through the cloudflared tunnel, where every
// request arrives from 127.0.0.1 (cloudflared → loopback) — so isLocalRequest() can NOT distinguish
// internet traffic from a genuine local call. They are therefore gated by a shared secret header that
// the dashboard proxy injects SERVER-SIDE (never exposed to the browser). When no key is configured
// the gate is open for on-Mac local/dev use only; an operator MUST set the key BEFORE adding the
// tunnel ingress for /remote-browser*. The unguessable session id is a second capability on top.
function remoteBrowserAuthorized(req) {
  // Accept either env name (FACEBOOK_TOKEN_CLOAK_* on the Mac, or the dashboard-shared
  // ACCOUNTS_BRIDGE_REMOTE_BROWSER_KEY) and fall back to ACCOUNTS_BRIDGE_API_KEY, so a single shared
  // secret configured on both sides just works — matching the dashboard proxy's own fallback chain.
  const expected = String(
    process.env.FACEBOOK_TOKEN_CLOAK_REMOTE_BROWSER_KEY ||
    process.env.ACCOUNTS_BRIDGE_REMOTE_BROWSER_KEY ||
    process.env.ACCOUNTS_BRIDGE_API_KEY || ''
  ).trim();
  if (!expected) return true;
  const provided = String(req.headers['x-remote-browser-key'] || '').trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return require('crypto').timingSafeEqual(a, b); } catch { return false; }
}

function resolveCorsOrigin(req) {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) return origin;
  return null;
}

function applyCorsHeaders(res, origin, req = null) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-id');
  // Chromium/Opera Private Network Access: public https://pubilo.com -> local
  // http://127.0.0.1:8820 requires this opt-in on the preflight response.
  if (req?.headers?.['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  res.setHeader('Access-Control-Max-Age', '600');
}

function hasValue(v) {
  return v != null && String(v).trim() !== '';
}

function normalizePublicFacebookLiteReason(value, fallback = 'request_failed') {
  const raw = String(value || fallback || '').trim();
  const text = raw.toLowerCase();

  // Facebook Lite sometimes returns localized first-party messages (for example Vietnamese)
  // from the mobile/login endpoint. Do not surface those raw strings to the operator UI;
  // convert them to stable Thai/English operational reasons instead.
  if (/giới hạn tần suất|khoảng thời gian nhất định|bảo vệ cộng đồng|spam|temporar(?:y|ily).*limit|try again later|rate limit|too many/i.test(raw)) {
    return 'facebook_rate_limited: Facebook จำกัดความถี่การโพสต์/คอมเมนต์ชั่วคราว ให้ใช้บัญชี fallback หรือรอแล้วลองใหม่';
  }
  if (/mật khẩu.*chưa chính xác|tên người dùng.*mật khẩu.*không hợp lệ|username.*password.*invalid|password.*incorrect|incorrect password|invalid password/i.test(raw)) {
    return 'credential_invalid: รหัสผ่าน Facebook Lite ไม่ถูกต้องหรือหมดอายุ ต้องอัปเดตรหัสใน Keychain';
  }
  if (/checkpoint|two[_ -]?factor|2fa|authentication code|xác thực|mã xác minh/i.test(raw)) {
    return 'facebook_checkpoint: Facebook ต้องยืนยันตัวตน/2FA ใน browser session ก่อน';
  }
  if (/invalidat|expired|revoked|not authoriz|invalid oauth|session.*invalid|security reason|changed their password/i.test(text)) {
    return 'token_invalidated: Facebook token หมดอายุหรือถูก invalidate ต้อง refresh จาก Facebook Lite bridge';
  }
  return '';
}

function sanitizePublicReason(value, fallback = 'request_failed') {
  const normalized = normalizePublicFacebookLiteReason(value, fallback);
  if (normalized) return normalized;
  const text = sanitizeUrlSecrets(String(value || fallback)).slice(0, 500);
  return text
    .replace(/\bEAA[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(fb_dtsg|datr|cookie|cookies|password)\b\s*[:=]?\s*[^,\s;)]+/ig, '$1=[REDACTED]');
}

// Build the response body for a posting route that could not resolve a usable session token. `error`
// stays the stable 'no_session' code (the Worker + existing tests key on it), but the SANITIZED
// blocker `reason` (profile_already_open / profile_locked / token_not_found / browser_unavailable …)
// and the sanitized landing `current_url` are added so the failure is no longer collapsed into an
// opaque no_session. Never carries a token, cookie, datr, or fb_dtsg — both fields are sanitized.
function sessionFailureBody(session, extra = {}) {
  const raw = String((session && session.reason) || '').trim();
  const out = { ok: false, step: 'session', error: 'no_session', ...extra };
  if (raw && raw !== 'no_session') out.reason = sanitizePublicReason(raw, 'no_session');
  const currentUrl = session && session.currentUrl;
  if (currentUrl) out.current_url = sanitizeUrlSecrets(String(currentUrl)).slice(0, 500);
  return out;
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

// Token-free, no-launch profile/session status for the native Accounts Bridge profile manager.
// Delegates to browser.profileStatus when available, degrading to a `statusKnown:false` "unknown"
// verdict for injected/test backends that don't implement it. NEVER opens a browser, mints/refreshes
// a token, reads a credential, or returns a secret — it only forwards presence/running booleans.
function safeProfileStatus(br, account) {
  const { display, key } = sanitizeAccount(account);
  const unknown = {
    account: display,
    key,
    profileDir: key,
    profileExists: false,
    running: false,
    bridgeSession: false,
    visibleSession: false,
    lockPidPresent: false,
    pidCount: 0,
    statusKnown: false
  };
  if (typeof br.profileStatus !== 'function') return unknown;
  try {
    return { ...br.profileStatus(account), statusKnown: true };
  } catch {
    return unknown;
  }
}

// Local-only readiness for one Facebook role, derived ENTIRELY from cached/local metadata (registry
// presence + Keychain present/absent flags). No token is minted or refreshed and no browser is
// opened — these booleans only reflect "do we hold the local material this role would need". Token
// values never appear here.
function facebookRoleReadiness(accountStatus) {
  if (!accountStatus) {
    return { credentialPresent: false, totpPresent: false, datrPresent: false, inRegistry: false };
  }
  return {
    credentialPresent: !!accountStatus.credentialPresent,
    totpPresent: !!accountStatus.totpPresent,
    datrPresent: !!accountStatus.datrPresent,
    inRegistry: !!accountStatus.inRegistry,
    selectorPresent: !!accountStatus.selectorPresent
  };
}

// Build the public Facebook role view from the stored role mapping plus the redacted account list.
// `source: 'local_metadata'` documents that readiness is never a live probe. Token-free by design.
function buildFacebookBridgeView(roles, accountList) {
  const byKey = new Map();
  for (const acc of accountList) byKey.set(acc.key, acc);
  const out = {};
  for (const role of bridgeConfig.FACEBOOK_ROLES) {
    const account = roles && roles[role] ? roles[role] : null;
    const key = account ? sanitizeAccount(account).key : null;
    const matched = key ? byKey.get(key) : null;
    out[role] = {
      role,
      label: bridgeConfig.FACEBOOK_ROLE_LABELS[role] || role,
      account: account || null,
      configured: !!account,
      accountExists: !!matched,
      readiness: { source: 'local_metadata', ...facebookRoleReadiness(matched) }
    };
  }
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
  const bridge = deps.bridgeConfig || bridgeConfig;
  const fetchImpl = deps.fetch || global.fetch;
  const downloadVideo = deps.downloadVideo;
  // Cloud Browser manager — opens/streams/drives a single visible page on this Mac's persistent
  // profile for the dashboard Accounts "Cloud Browser" feature. One instance per handler so its
  // session map is shared across requests. Reuses the same browser backend + profile archive sync as
  // the Accounts Bridge open/close lifecycle, so a cloud session is cookie-identical to a local one.
  const remoteBrowser = deps.remoteBrowser || createRemoteBrowserManager({
    browser: br,
    profileArchiveSync: deps.profileArchiveSync || profileArchiveSync
  });
  // /remote-browser/* capability routes are gated by remoteBrowserAuthorized() (shared-secret header
  // injected by the dashboard proxy) since cloudflared makes tunnel traffic look like loopback.
  return async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
    try {
      // Narrow CORS: only the safe, token-free accounts endpoints are reachable cross-origin from the
      // allowlisted Pubilo dashboard origins. Set the response headers up-front so every send() below
      // carries them, and answer the preflight before any routing/side-effect runs.
      const corsOrigin = resolveCorsOrigin(req);
      const corsSafe = CORS_SAFE_PATHS.has(url.pathname) || isRemoteBrowserCorsPath(url.pathname);
      if (corsOrigin && corsSafe) applyCorsHeaders(res, corsOrigin, req);
      if (req.method === 'OPTIONS') {
        if (corsOrigin && corsSafe) {
          res.writeHead(204);
          return res.end();
        }
        return sendError(res, 403, 'cors_not_allowed');
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return sendError(res, 410, 'native_app_only');
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        let backend = 'unavailable';
        let executablePath = '';
        try {
          const browserBackend = await br.loadBrowserBackend();
          backend = browserBackend.backend;
          executablePath = browserBackend.executablePath || '';
        } catch {}
        return send(res, 200, {
          ok: true,
          app: 'facebook-token-cloak',
          host: DEFAULT_HOST,
          port: DEFAULT_PORT,
          backend,
          executablePath,
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

      // ── Accounts Bridge: API-first account-role configuration/status ──────────────────────────
      // These endpoints are token-free and side-effect-free reads (GET) plus a non-secret config
      // write (POST). NONE of them mint/refresh a token or open a browser. They exist so ops/Hermes
      // can inspect and configure which account plays each Facebook role on demand.
      if (req.method === 'GET' && url.pathname === '/accounts/bridge/status') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Account endpoints are local-only');
        const roles = await bridge.getFacebookRoles();
        const accountList = await listAccountStatuses(kc, selectors, registry);
        return send(res, 200, {
          app: 'accounts-bridge',
          shopee: {
            managed: false,
            roles: {},
            note: 'Shopee report/login is handled by the local Shopee zip runtime, not this Accounts Bridge.'
          },
          facebook: {
            accountsCount: accountList.length,
            roles: buildFacebookBridgeView(roles, accountList)
          },
          note: 'Status-only. No token is minted or refreshed and no browser is opened by this call.'
        });
      }

      if (req.method === 'GET' && url.pathname === '/accounts/bridge/facebook') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Account endpoints are local-only');
        const roles = await bridge.getFacebookRoles();
        const accountList = await listAccountStatuses(kc, selectors, registry);
        return send(res, 200, {
          roles: buildFacebookBridgeView(roles, accountList),
          note: 'Readiness is derived from cached/local metadata only. No token mint, refresh, or browser open occurs on this call.'
        });
      }

      // ── Accounts Bridge: native profile-manager status (token-free, NO browser launch) ──────────
      // Powers the Swift native "Open Profile / Close Profile / Refresh Status" UI. This is a pure
      // read: it NEVER opens a browser, mints/refreshes a token, reads a credential, or returns any
      // secret. It reports only profile presence + whether a browser is currently using the profile
      // (and whether that is the operator-visible session this bridge owns). Open/Close keep using
      // /login (visible=1&autofill=0&submit=0) and /login/close — this endpoint must never side-effect.
      if (req.method === 'GET' && url.pathname === '/accounts/profile-status') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Account endpoints are local-only');
        const account = url.searchParams.get('account');
        if (account) {
          try { sanitizeAccount(account); }
          catch { return sendError(res, 400, 'Invalid account parameter'); }
          return send(res, 200, {
            profile: safeProfileStatus(br, account),
            note: 'Status-only. No token is minted/refreshed and no browser is opened by this call.'
          });
        }
        const accountList = await listAccountStatuses(kc, selectors, registry);
        return send(res, 200, {
          profiles: accountList.map(a => safeProfileStatus(br, a.account)),
          note: 'Status-only. No token is minted/refreshed and no browser is opened by this call.'
        });
      }

      if ((req.method === 'POST' || req.method === 'PUT') && url.pathname === '/accounts/bridge/facebook') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Account endpoints are local-only');
        const body = await parseBody(req);
        // Only roles explicitly present in the body are changed; pass null/'' to clear a role.
        const patch = {};
        for (const role of bridge.FACEBOOK_ROLES) {
          if (!Object.prototype.hasOwnProperty.call(body, role)) continue;
          const raw = body[role];
          patch[role] = raw == null || String(raw).trim() === '' ? null : String(raw).trim();
        }
        if (Object.keys(patch).length === 0) {
          return sendError(res, 400, `Provide at least one role: ${bridge.FACEBOOK_ROLES.join(', ')}`);
        }
        const accountList = await listAccountStatuses(kc, selectors, registry);
        const knownKeys = new Set(accountList.map(a => a.key));
        for (const [role, value] of Object.entries(patch)) {
          if (!value) continue;
          const { key, display } = sanitizeAccount(value); // throws 400 on a malformed alias
          if (!knownKeys.has(key)) return sendError(res, 400, 'Account not found for role', { role, account: display });
        }
        const roles = await bridge.setFacebookRoles(patch);
        return send(res, 200, { roles: buildFacebookBridgeView(roles, accountList), updated: true });
      }

      if (req.method === 'POST' && url.pathname === '/accounts/bridge/facebook/check') {
        if (!isLocalRequest(req)) return sendError(res, 403, 'Account endpoints are local-only');
        const body = await parseBody(req);
        // dry_run defaults TRUE — a default check is status-only. A browser opens only when the
        // operator explicitly passes dry_run=false AND open_browser=true (and browser login is
        // enabled); even then it is non-visible and never autofills or submits credentials.
        const dryRun = body.dry_run !== false && body.dry_run !== 'false' && body.dry_run !== 0;
        const openBrowser = body.open_browser === true || body.open_browser === '1' || body.open_browser === 'true';
        const role = body.role == null || body.role === '' ? null : String(body.role);
        if (role && !bridge.FACEBOOK_ROLES.includes(role)) {
          return sendError(res, 400, 'Unknown facebook role', { role, allowedRoles: bridge.FACEBOOK_ROLES });
        }
        const roles = await bridge.getFacebookRoles();
        const account = hasValue(body.account) ? String(body.account).trim() : role ? roles[role] : null;
        if (!account) return sendError(res, 400, 'Missing account (provide account or a configured role)');
        const { key, display } = sanitizeAccount(account);
        const accountList = await listAccountStatuses(kc, selectors, registry);
        const matched = accountList.find(a => a.key === key) || null;
        const readiness = { source: 'local_metadata', ...facebookRoleReadiness(matched) };
        let browserOpened = false;
        let browserNote = 'browser_not_opened';
        if (!dryRun && openBrowser) {
          if (process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED !== '1') {
            browserNote = 'browser_login_disabled';
          } else {
            try {
              const opened = await br.openPage(account, 'https://www.facebook.com/login', { visible: false, reuse: true });
              browserOpened = true;
              browserNote = sanitizeUrlSecrets(opened.page.url());
            } catch (e) {
              browserNote = sanitizePublicReason(String((e && (e.code || e.reason)) || 'browser_open_failed'), 'browser_open_failed');
            }
          }
        }
        return send(res, 200, {
          account: display,
          role: role || null,
          dryRun,
          accountExists: !!matched,
          browserOpened,
          browserNote,
          readiness,
          note: 'Check is token-free and status-only; it never mints or refreshes a token. A browser opens only with dry_run=false and open_browser=true while browser login is enabled.'
        });
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

      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/login/close') {
        const account = url.searchParams.get('account') || (req.method === 'POST' ? (await parseBody(req)).account : '');
        if (!account) return sendError(res, 400, 'Missing account parameter');
        const { display } = sanitizeAccount(account);
        const result = await br.closeAccountContext(account);
        // BrowserSaving-style save-on-close: after Chromium has flushed the profile, compress the
        // allowlisted browser state, seal it locally, then upload opaque ciphertext to Accounts Bridge
        // Worker/R2. Response is metadata/status only — never archive bytes or secrets.
        const archiveSync = await profileArchiveSync.uploadAfterClose(account);
        return send(res, 200, {
          success: true,
          account: display,
          state: result.state || (result.closed ? 'closed' : 'not_open'),
          closed: !!result.closed,
          archiveSync,
          ...(result.reason ? { reason: sanitizePublicReason(result.reason, 'close_failed') } : {})
        });
      }

      if (req.method === 'GET' && url.pathname === '/login') {
        const account = url.searchParams.get('account');
        if (!account) return sendError(res, 400, 'Missing account parameter');
        const { display } = sanitizeAccount(account);
        const visible = parseBool(url.searchParams.get('visible'), false);
        const autofill = parseBool(url.searchParams.get('autofill'), true);
        const submit = parseBool(url.searchParams.get('submit'), false);
        // Credential autofill + login submit stay gated behind the explicit env flag (they read a
        // stored secret and drive a real login). The ONE thing allowed when that flag is off is the
        // safe operator debug case: open a VISIBLE session with autofill=0 AND submit=0 so the
        // operator can SEE which user is logged in and whether Facebook is stuck at
        // checkpoint/CAPTCHA/2FA. That path never reads a credential, never submits, never mints a
        // token, and returns no secret. Any autofill=1/submit=1 while disabled is refused.
        if (process.env.FACEBOOK_TOKEN_CLOAK_BROWSER_LOGIN_ENABLED !== '1' && (autofill || submit)) {
          return sendError(res, 410, 'browser_login_disabled', {
            account: display,
            state: 'browser_login_disabled',
            reason: 'browser_login_disabled',
            note: 'Credential autofill/submit is disabled. Only a visible no-autofill, no-submit session may be opened from Accounts Bridge to inspect login state.'
          });
        }
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
        // Reuse the live context this process already owns for the account instead of launching a
        // second persistentContext on the same (locked) profile dir — that double-launch is what
        // surfaced as a generic 500 ("session disappeared") when a visible window was already open.
        // The persistent profile/cookies are never reset; we just navigate the existing window.
        // BrowserSaving-style restore-on-open: download the current sealed archive from Worker/R2,
        // unseal locally, and extract it BEFORE launching CloakBrowser. If no archive exists yet,
        // continue with the local/new profile but report that fact in archiveSync.
        const archiveSync = await profileArchiveSync.restoreBeforeOpen(account);
        let opened;
        try {
          opened = await br.openPage(account, 'https://www.facebook.com/login', { visible, reuse: true });
        } catch (e) {
          // Sanitize so the UI sees a useful, non-secret reason — not "Internal server error". A
          // profile locked by an orphan/external Chrome answers profile_already_open (409 Conflict),
          // not 500, so the operator knows the session is intact and only the window is busy.
          const code = String((e && (e.code || e.reason)) || 'browser_open_failed');
          const isLock = code === 'profile_already_open' || code === 'profile_locked';
          const reason = sanitizePublicReason(code, 'browser_open_failed');
          return sendError(res, isLock ? 409 : 502, reason, {
            account: display,
            credentialProvider,
            state: isLock ? 'profile_already_open' : 'browser_unavailable',
            reason,
            ...(isLock ? { note: 'Session is preserved; the profile is already open in another window. Close it or reuse the open session.' } : {}),
            archiveSync,
            ...selectorStatus
          });
        }
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
          archiveSync,
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
        // Facebook Lite export moved ENTIRELY to the IDLogin/IDBridge stack (receiver 8799 mints from
        // iOS-Keychain credentials and profile-syncs the page token). This route now serves ONLY the
        // CloakBrowser/Power-Editor session export; a Facebook Lite request (numeric uid or explicit
        // flag) fails closed here instead of minting.
        if (wantsFacebookLiteBridge(account, exportBody)) return facebookLiteRemoved(res, { account: display });
        const tokenSource = 'cloak_session_bridge';

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

        let effectiveAccount = display;
        // CloakBrowser/Power-Editor session export only (Facebook Lite already failed closed above).
        let resolved = await resolvePageForExport(account);
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
        // Facebook Lite bulk page import removed. Minting/enumeration/profile-sync now lives ONLY in
        // the IDLogin/IDBridge stack (receiver 8799 mints from iOS-Keychain credentials and pushes
        // page tokens to the Worker). Fail closed — this service no longer mints Facebook Lite.
        return facebookLiteRemoved(res);
      }

      if (req.method === 'POST' && url.pathname === '/token/auto-sync') {
        // Facebook Lite auto-sync/re-mint removed. A stale page token is recovered by the operator
        // re-logging in through the IDLogin/IDBridge app (receiver 8799), which mints in-memory and
        // profile-syncs a fresh token to the Worker. Fail closed — no machine re-mint from 8820.
        return facebookLiteRemoved(res);
      }

      // ── Worker posting bridge routes (CloakBrowser) ──────────────────────────────────────
      // All resolve a fresh user token from the persistent logged-in profile, run their Graph
      // work through the cookie-bound browser client, and ALWAYS close the context in `finally`.
      // Raw tokens/cookies/fb_dtsg are never returned or logged.

      if (req.method === 'GET' && url.pathname === '/token') {
        const account = url.searchParams.get('account') || POST_ACCOUNT;
        if (wantsFacebookLiteBridge(account, { facebook_lite: url.searchParams.get('facebook_lite') || url.searchParams.get('token_source') || '' })) {
          // Facebook Lite token readiness moved to the IDLogin/IDBridge stack — fail closed here.
          return facebookLiteRemoved(res, { account: sanitizeAccount(account).display });
        }
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          const accessToken = !!session.token;
          let fbDtsg = !!session.fbDtsgPresent;
          if (!fbDtsg && session.context) {
            try { fbDtsg = await posting.hasLoggedInSession(session.context); } catch {}
          }
          // When no token resolved, surface the sanitized blocker reason (profile_already_open /
          // token_not_found …) so a session probe is diagnosable instead of a bare accessToken:false.
          const rawReason = String(session.reason || '').trim();
          return send(res, 200, {
            ok: true,
            accessToken,
            fbDtsg,
            source: session.source || 'browser_session',
            account: sanitizeAccount(account).display,
            ...(!accessToken && rawReason && rawReason !== 'no_session' ? { reason: sanitizePublicReason(rawReason, 'token_not_found') } : {})
          });
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'GET' && url.pathname === '/pages') {
        const account = url.searchParams.get('account') || POST_ACCOUNT;
        const includeToken = ['1', 'true', 'yes'].includes(String(url.searchParams.get('includeToken') || '').trim().toLowerCase());
        if (includeToken && !isLocalRequest(req)) return sendError(res, 403, 'includeToken is only allowed for local requests');
        // Facebook Lite page enumeration moved to the IDLogin/IDBridge stack (the receiver mints and
        // profile-syncs page tokens directly to the Worker) — fail closed here for a Lite account.
        if (wantsFacebookLiteBridge(account, { facebook_lite: url.searchParams.get('facebook_lite') || url.searchParams.get('token_source') || '' })) {
          return facebookLiteRemoved(res, { account: sanitizeAccount(account).display });
        }
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) {
            // Surface the sanitized blocker reason (profile_already_open / token_not_found …) alongside
            // the stable no_session code instead of an empty list with no explanation.
            const raw = String(session.reason || '').trim();
            return send(res, 200, {
              data: [],
              error: 'no_session',
              ...(raw && raw !== 'no_session' ? { reason: sanitizePublicReason(raw, 'no_session') } : {}),
              ...(session.currentUrl ? { current_url: sanitizeUrlSecrets(String(session.currentUrl)).slice(0, 500) } : {})
            });
          }
          const result = await posting.listPagesPublic(session.graphFetch, session.token, includeToken && isLocalRequest(req));
          return send(res, 200, result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/post') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        // Organic Facebook Lite publishing moved to the IDLogin/IDBridge stack — the Worker now posts
        // directly with its profile-synced Lite page token. Fail closed here for a Lite account.
        if (wantsFacebookLiteBridge(account, body)) {
          return facebookLiteRemoved(res, { account: sanitizeAccount(account).display });
        }
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, sessionFailureBody(session));
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
            // Facebook Lite comment-token minting removed — the Worker comments directly with its
            // profile-synced Lite page token. Fail closed (no EAAD6V mint here).
            return { ok: false, status: 410, step: 'facebook_lite_removed', error: 'facebook_lite_removed', source: 'facebook_lite_eaad6' };
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
          if (!session.token) return send(res, 200, sessionFailureBody(session));
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

      if (req.method === 'POST' && url.pathname === '/media-library/upload') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const adAccount = String(body.ad_account || body.adAccount || ADS_AD_ACCOUNT || '').trim();
        const videoUrl = String(body.video_url || body.videoUrl || '').trim();
        if (!adAccount || !videoUrl) return send(res, 400, { ok: false, step: 'validate', error: 'Missing: ad_account, video_url' });
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, sessionFailureBody(session));
          const up = await posting.uploadAdVideoFromUrl(session.graphFetch, {
            adAccount,
            userToken: session.token,
            videoUrl,
            download: downloadVideo
          });
          const data = up.data || {};
          if (data.error) {
            return send(res, 200, {
              ok: false,
              step: 'upload_video',
              error: sanitizePublicReason(data.error.message || data.error.type || 'graph_upload_error'),
              fb_error_code: data.error.code,
              fb_error_subcode: data.error.error_subcode,
              fb_trace_id: data.error.fbtrace_id,
              upload_mode: up.uploadMode
            });
          }
          const advideoId = String(data.id || '').trim();
          if (!advideoId) return send(res, 200, { ok: false, step: 'upload_video', error: 'advideo_id_missing', upload_mode: up.uploadMode });
          return send(res, 200, { ok: true, advideo_id: advideoId, video_id: advideoId, upload_mode: up.uploadMode });
        } finally {
          await posting.closeSession(session);
        }
      }

      // Resolve the REAL Meta/Facebook media for an advideo_id so the คลังสื่อ dashboard can play the
      // genuine source (scontent…fbcdn.net mp4) + preferred thumbnail instead of our system file_url.
      // Read-only: reads ONE advideo via the Power Editor Graph session and never creates an ad/post.
      // Output is token-free — only Graph source/thumbnail/status/permalink fields, URL-sanitized.
      if (req.method === 'POST' && url.pathname === '/media-library/resolve') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const advideoId = String(body.advideo_id || body.advideoId || body.video_id || body.videoId || '').trim();
        if (!advideoId) return send(res, 400, { ok: false, step: 'validate', error: 'Missing: advideo_id' });
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, sessionFailureBody(session));
          const meta = await posting.resolveAdVideoMeta(session.graphFetch, { advideoId, userToken: session.token });
          if (!meta.ok) {
            const err = meta.error || {};
            return send(res, 200, {
              ok: false,
              step: 'resolve',
              advideo_id: advideoId,
              error: sanitizePublicReason((err && (err.message || err.type)) || 'graph_resolve_error', 'graph_resolve_error'),
              fb_error_code: err && err.code,
              fb_error_subcode: err && err.error_subcode
            });
          }
          const data = meta.data || {};
          const status = (data.status && typeof data.status === 'object') ? data.status : {};
          const phaseStatus = (key) => (status[key] && typeof status[key] === 'object') ? String(status[key].status || '').trim() : '';
          const thumbs = (data.thumbnails && Array.isArray(data.thumbnails.data)) ? data.thumbnails.data : [];
          const preferredThumb = thumbs.find((t) => t && t.is_preferred) || thumbs[0] || null;
          const thumbUri = preferredThumb && preferredThumb.uri ? sanitizeUrlSecrets(String(preferredThumb.uri))
            : (data.picture ? sanitizeUrlSecrets(String(data.picture)) : '');
          const sourceUrl = data.source ? sanitizeUrlSecrets(String(data.source)) : '';
          const publishPhase = (status.publishing_phase && typeof status.publishing_phase === 'object') ? status.publishing_phase : {};
          return send(res, 200, {
            ok: true,
            advideo_id: String(data.id || advideoId),
            video_status: String(status.video_status || '').trim(),
            uploading_status: phaseStatus('uploading_phase'),
            processing_status: phaseStatus('processing_phase'),
            publishing_status: phaseStatus('publishing_phase'),
            publish_status: String(publishPhase.publish_status || '').trim(),
            meta_source_url: sourceUrl,
            source: sourceUrl,
            meta_thumbnail_url: thumbUri,
            permalink_url: data.permalink_url ? sanitizeUrlSecrets(String(data.permalink_url)) : '',
            created_time: String(data.created_time || '').trim(),
            updated_time: String(data.updated_time || '').trim()
          });
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/create-ad') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, sessionFailureBody(session));
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
          if (!session.token) return send(res, 200, sessionFailureBody(session));
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
          if (!session.token) return send(res, 200, sessionFailureBody(session));
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
          if (!session.token) return send(res, 200, sessionFailureBody(session));
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
          if (!session.token) return send(res, 200, sessionFailureBody(session));
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
          if (!session.token) return send(res, 200, sessionFailureBody(session));
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

      if (req.method === 'POST' && url.pathname === '/archive-ad-only') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, sessionFailureBody(session));
          // REMOVE (archive) a finished Follow/Page-like ad from Ads so its LIKE_PAGE button detaches
          // from the story — the corrected Follow lifecycle (NOT pause). archiveAdOnlyObjects issues a
          // recoverable status='ARCHIVED' (or 'DELETED') POST, NEVER an HTTP DELETE, and reads back
          // status/effective_status so the worker can record proof of removal. The ad is always
          // archived; the adset/campaign only when archive_adset/archive_campaign is set.
          const result = await posting.archiveAdOnlyObjects(session.graphFetch, {
            userToken: session.token,
            adId: body.ad_id,
            adsetId: body.adset_id,
            campaignId: body.campaign_id,
            archiveAdset: body.archive_adset,
            archiveCampaign: body.archive_campaign,
            archiveStatus: body.archive_status
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      // ── Cloud Browser (remote browser) ─────────────────────────────────────────────────────────
      // Open + stream + drive a single visible page on this Mac's persistent profile so the dashboard
      // Accounts page can SEE and CONTROL a logged-in Facebook profile WITHOUT remoting the desktop.
      // All routes are token-free: status/input return JSON with no secret; screenshot returns a
      // rasterized JPEG. No JS-eval route exists. The session id is an unguessable crypto handle.
      // The capability-granting routes are gated by a shared secret header (the dashboard proxy injects
      // it) because cloudflared makes tunnel traffic indistinguishable from loopback. Fail closed.
      if (isRemoteBrowserCorsPath(url.pathname) && !remoteBrowserAuthorized(req)) {
        return sendError(res, 401, 'remote_browser_unauthorized');
      }
      if (req.method === 'POST' && url.pathname === '/remote-browser/start') {
        const body = await parseBody(req);
        const result = await remoteBrowser.start({ account_uid: body.account_uid || body.account, initial_url: body.initial_url || body.url });
        return send(res, 200, { success: true, session: result });
      }
      // Diagnostic: report the resolved Virtual Display config (sanitized geometry/flags only — no
      // secrets). Matched BEFORE the session-id route below since 'display' would otherwise look like a
      // session id. Gated by the same shared-secret check as the other remote-browser routes.
      if (req.method === 'GET' && url.pathname === '/remote-browser/display/status') {
        return send(res, 200, { success: true, display: remoteBrowser.displayStatus() });
      }
      {
        const rb = url.pathname.match(/^\/remote-browser\/([A-Za-z0-9_-]+)\/(status|screenshot|input|stop)$/);
        if (rb) {
          const sessionId = rb[1];
          const op = rb[2];
          if (req.method === 'GET' && op === 'status') {
            const status = await remoteBrowser.status(sessionId);
            return send(res, 200, { success: true, session: status });
          }
          if (req.method === 'GET' && op === 'screenshot') {
            const shot = await remoteBrowser.screenshot(sessionId);
            res.writeHead(200, {
              'Content-Type': shot.contentType,
              'Content-Length': shot.buffer.length,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff'
            });
            return res.end(shot.buffer);
          }
          if (req.method === 'POST' && op === 'input') {
            const body = await parseBody(req);
            const result = await remoteBrowser.input(sessionId, body.action, body.payload || body);
            return send(res, 200, { success: true, ...result });
          }
          if (req.method === 'POST' && op === 'stop') {
            const result = await remoteBrowser.stop(sessionId);
            return send(res, 200, { success: true, ...result });
          }
          return sendError(res, 405, 'method_not_allowed');
        }
      }

      return sendError(res, 404, 'Not found');
    } catch (e) {
      return sendError(res, e.status || 500, e.status ? e.message : 'Internal server error');
    }
  };
}

function createServer(deps = {}) {
  // Build the Cloud Browser manager ONCE so the HTTP handler and the WebSocket `upgrade` handler share
  // the same session map (the LIVE stream attaches a CDP screencast to a session opened over HTTP).
  const remoteBrowser = deps.remoteBrowser || createRemoteBrowserManager({
    browser: deps.browser || browser,
    profileArchiveSync: deps.profileArchiveSync || profileArchiveSync,
  });
  const server = http.createServer(createHandler({ ...deps, remoteBrowser }));
  // LIVE CDP screencast stream: /remote-browser/:id/stream upgrades to a WebSocket. Gated by the SAME
  // shared-secret check the HTTP routes use (cloudflared makes tunnel traffic look like loopback). The
  // HTTP /screenshot route stays as a polling fallback for clients/proxies without WebSocket support.
  attachRemoteBrowserUpgrade(server, remoteBrowser, { authorized: remoteBrowserAuthorized });
  return server;
}

function start(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  const server = createServer();
  server.listen(port, host, () => console.log(`facebook-token-cloak listening on ${host}:${port}`));
  return server;
}

module.exports = { createHandler, createServer, start, DEFAULT_PORT, DEFAULT_HOST, DEFAULT_TEMPLATE_ADSET };
