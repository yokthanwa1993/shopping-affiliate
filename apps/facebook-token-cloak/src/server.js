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
const fbLiteTokenService = require('./fb-lite-token-service.cjs');
const profileArchiveSync = require('./profileArchiveSync');
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

// Parse a caller-supplied `accounts` value (array, or comma/space separated string) into a deduped
// list of sanitized DISPLAY ids for the all-account import. Returns null when nothing usable was
// supplied (the caller then falls back to scanning the local registry). Never returns secrets.
function parseAccountList(raw) {
  let items = [];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === 'string' && raw.trim()) items = raw.split(/[\s,]+/);
  else return null;
  const seen = new Set();
  const out = [];
  for (const item of items) {
    let s;
    try { s = sanitizeAccount(item); } catch { continue; }
    if (!s.display || seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s.display);
  }
  return out.length ? out : null;
}

// Parse an env-configured fallback mapping for the auto-sync recovery: a JSON object whose KEY is an
// account uid (account→fallbacks map) or a page id (page→accounts map) and whose VALUE is an array or
// comma/space separated string of account ids. Each value is sanitized into DISPLAY ids (same shape as
// scanAccounts). Malformed input yields {} (never throws) so a bad env var can never break recovery.
// Token-free: account ids / page ids are public identifiers, never secrets. Not hardcoded — the
// mapping comes entirely from the operator-provided env var.
function parseFallbackMapEnv(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    const key = String(k == null ? '' : k).trim();
    if (!key) continue;
    const list = parseAccountList(v); // sanitized DISPLAY ids, or null
    if (list && list.length) out[key] = list;
  }
  return out;
}

// Build the ordered fallback-account chain (sanitized DISPLAY ids) for a recovery call: an explicit
// per-call hint first, then the page→accounts mapping for the target page, then the account→fallbacks
// mapping for the primary account. The primary account is excluded (it is always scanned first), and
// the chain is deduped by sanitized key so the primary is never re-scanned via a fallback.
function resolveFallbackChain({ explicit, pageId, primaryAccount, envAccountFallbacks, envPageFallbacks }) {
  const seen = new Set();
  const primaryKey = (() => { try { return primaryAccount ? sanitizeAccount(primaryAccount).key : ''; } catch { return ''; } })();
  if (primaryKey) seen.add(primaryKey);
  const out = [];
  const push = (list) => {
    for (const display of (list || [])) {
      let key;
      try { key = sanitizeAccount(display).key; } catch { continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(display);
    }
  };
  push(explicit);
  const pid = String(pageId == null ? '' : pageId).trim();
  if (pid) push(envPageFallbacks && envPageFallbacks[pid]);
  const pk = String(primaryAccount == null ? '' : primaryAccount).trim();
  if (pk) push(envAccountFallbacks && envAccountFallbacks[pk]);
  return out;
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

// Map a raw Graph token-validation error into a stable, sanitized public reason. A token minted
// right after a password change / security reset comes back EAAD6V-shaped but Graph rejects it
// ("The session has been invalidated because the user changed their password…") — surface that as
// session_invalidated. An explicitly invalidated/expired/revoked/not-authorized token becomes
// token_invalidated; anything else degrades to graph_token_invalid. NEVER echoes the raw token.
function classifyGraphTokenError(raw) {
  const text = String(raw || '').toLowerCase();
  if (/password|changed the session|security reason/.test(text)) return 'session_invalidated';
  if (/invalidat|expired|revoked|not authoriz|invalid oauth|malformed|session is invalid/.test(text)) return 'token_invalidated';
  return 'graph_token_invalid';
}

// Validate a freshly-minted Facebook Lite token against the Graph API in REAL TIME. A token
// string/prefix alone is NOT proof of usability — me/accounts is the SAME call the posting paths
// use to resolve a PAGE token, so a pass here proves the token can actually drive Page operations
// right now. Returns { ok, reason }; never returns the token. Gates GET /token + GET /pages
// readiness so an EAAD6V token invalidated by a password/security reset never reads Ready.
async function validateFacebookLiteGraphToken(lite) {
  let result;
  try {
    result = await posting.listPagesPublic(lite.graphFetch, lite.token, false);
  } catch (e) {
    return { ok: false, reason: classifyGraphTokenError((e && (e.reason || e.code || e.message)) || 'graph_token_invalid') };
  }
  if (result && result.error) {
    return { ok: false, reason: classifyGraphTokenError(result.error) };
  }
  return { ok: true, reason: null };
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
  const fbLite = deps.fbLiteTokenService || fbLiteTokenService;
  const downloadVideo = deps.downloadVideo;
  // Shared dependency bundle for the Facebook Lite (EAAD6V) token path.
  const liteDeps = { kc, fbLite, fetchImpl };
  // Per-namespace backoff for LIVE /token/auto-sync. The Worker triggers recovery AUTOMATICALLY on a
  // token-invalidated failure; a burst of such failures across pages/cron must not re-mint a fresh
  // Facebook Lite session every time (that trips Facebook's login rate limiter). One live mint+scan
  // per namespace per TTL window is enough — the scan refreshes EVERY administered page in the
  // namespace at once, so siblings recover from a single call. Scoped to this handler instance.
  const autoSyncLastLiveByNamespace = new Map();
  const AUTO_SYNC_TTL_MS = (() => {
    const raw = process.env.FACEBOOK_TOKEN_CLOAK_AUTOSYNC_TTL_MS;
    if (raw == null || raw === '') return 60000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 60000;
  })();
  return async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
    try {
      // Narrow CORS: only the safe, token-free accounts endpoints are reachable cross-origin from the
      // allowlisted Pubilo dashboard origins. Set the response headers up-front so every send() below
      // carries them, and answer the preflight before any routing/side-effect runs.
      const corsOrigin = resolveCorsOrigin(req);
      const corsSafe = CORS_SAFE_PATHS.has(url.pathname);
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
            note: 'Shopee report/login is handled by the affiliate-shortlink-cloak bridge, not this Accounts Bridge.'
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
        if (!ns) return sendError(res, 400, 'Missing namespaceId');
        const wantDryRun = dryRun !== false;

        // Mode detection. A SPECIFIC account id keeps the original one-account import untouched. The
        // all-account (realtime cross-account fallback) mode triggers when `account` is omitted/empty/
        // "all"/"*", OR an explicit `accounts` list is supplied. Explicit accounts are used verbatim
        // (sanitized); otherwise every Bridge account in the local registry/status list is scanned now.
        const explicitAccounts = parseAccountList(importBody.accounts);
        const rawAccount = String(account == null ? '' : account).trim();
        const allMode = (explicitAccounts && explicitAccounts.length > 0)
          || rawAccount === '' || rawAccount.toLowerCase() === 'all' || rawAccount === '*';

        // Fail closed: only the admin namespace (or an env-allowlisted id) may receive a bulk import.
        // Every other namespace keeps its existing one-by-one manual add behavior, untouched. Enforced
        // for BOTH the one-account and the all-account modes, BEFORE any token resolution.
        const allowed = allowedImportNamespaceIds();
        if (!allowed.has(ns)) {
          return send(res, 403, {
            ok: false, status: 'namespace_not_allowed', namespace_id: ns,
            account: allMode ? 'all' : sanitizeAccount(account).display,
            note: 'Bulk import is restricted to the admin namespace. Other namespaces keep manual add.'
          });
        }

        // ── One-account import (UNCHANGED original behavior) ──────────────────────────────────────
        if (!allMode) {
        const { display } = sanitizeAccount(account);

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
        } // ── end one-account import ──

        // ── All-account realtime import (NEW) ─────────────────────────────────────────────────────
        // Resolve which Bridge accounts to scan: an explicit `accounts` list verbatim, otherwise every
        // FB-Lite-likely account from the local registry/status list (registered / credential / selector
        // present). Each account is minted + me/accounts-listed in REAL TIME on this single call — there
        // is no scheduled/background sync.
        let scanAccounts = explicitAccounts;
        if (!scanAccounts) {
          let statuses = [];
          try { statuses = await listAccountStatuses(kc, selectors, registry); } catch { statuses = []; }
          const seen = new Set();
          scanAccounts = [];
          for (const s of statuses) {
            if (!s || !s.account || seen.has(s.key)) continue;
            const likelyLite = s.inRegistry || s.credentialPresent || s.selectorPresent;
            if (!likelyLite) continue;
            seen.add(s.key);
            scanAccounts.push(s.account);
          }
        }

        // page_id -> { page_id, page_name, primary_account, fallback_accounts[], tokens[] }
        // De-dupe key is page_id: the FIRST account that administers a page becomes its PRIMARY; any
        // other account that also administers it is a FALLBACK (no duplicate page row). The internal
        // `tokens` pool (primary first, then fallbacks) is NEVER serialized into the response.
        const pageMap = new Map();
        const accountResults = [];
        let accountsOk = 0;
        let accountsFailed = 0;
        for (const acct of scanAccounts) {
          const accDisplay = sanitizeAccount(acct).display;
          const lite = await resolveFacebookLiteEAAD6Session(liteDeps, acct).catch((e) => ({ ok: false, reason: (e && (e.code || e.message)) || 'fb_lite_token_error' }));
          if (!lite.ok || !lite.token) {
            accountsFailed += 1;
            accountResults.push({ account: accDisplay, ok: false, status: 'fb_lite_token_not_ready', error: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready'), ...(lite.prefix ? { token_prefix: lite.prefix } : {}) });
            continue;
          }
          let listed;
          try {
            listed = await posting.listPagesPublic(lite.graphFetch, lite.token, true);
          } catch (e) {
            accountsFailed += 1;
            accountResults.push({ account: accDisplay, ok: false, status: 'graph_pages_failed', error: sanitizePublicReason((e && (e.reason || e.code || e.message)) || 'graph_pages_failed', 'graph_pages_failed') });
            continue;
          }
          if (listed && listed.error) {
            accountsFailed += 1;
            accountResults.push({ account: accDisplay, ok: false, status: 'graph_pages_failed', error: sanitizePublicReason(listed.error, 'graph_pages_failed') });
            continue;
          }
          const pages = Array.isArray(listed.data) ? listed.data : [];
          accountsOk += 1;
          let withToken = 0;
          for (const p of pages) {
            const pageId = p && p.id != null ? String(p.id) : '';
            if (!pageId) continue;
            const pageName = p && p.name != null ? String(p.name) : '';
            const pageToken = p && p.access_token ? String(p.access_token) : '';
            if (pageToken) withToken += 1;
            if (!pageMap.has(pageId)) {
              pageMap.set(pageId, { page_id: pageId, page_name: pageName, primary_account: accDisplay, fallback_accounts: [], tokens: [] });
            }
            const entry = pageMap.get(pageId);
            if (!entry.page_name && pageName) entry.page_name = pageName;
            if (accDisplay !== entry.primary_account && !entry.fallback_accounts.includes(accDisplay)) {
              entry.fallback_accounts.push(accDisplay);
            }
            if (pageToken) entry.tokens.push({ account: accDisplay, token: pageToken });
          }
          accountResults.push({ account: accDisplay, ok: true, page_count: pages.length, with_token: withToken, ...(lite.prefix ? { token_prefix: lite.prefix } : {}) });
        }

        const uniquePages = [...pageMap.values()];
        const candidateView = uniquePages.map((e) => ({
          page_id: e.page_id, page_name: e.page_name,
          primary_account: e.primary_account, fallback_accounts: e.fallback_accounts,
          has_token: e.tokens.length > 0
        }));

        // SAFE default: a dry run lists the deduped candidate pages (primary + fallback accounts) and
        // the per-account scan outcome, and performs NO Worker/D1 writes. Token-free.
        if (wantDryRun) {
          return send(res, 200, {
            ok: true, dryRun: true, status: 'dry_run_only', mode: 'all_accounts', target,
            namespace_id: ns, source: 'facebook_lite_eaad6',
            token_source: 'facebook_lite_bridge', import_mode: 'facebook_lite_bridge_import',
            accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed,
            accounts: accountResults,
            counts: {
              candidates: candidateView.length,
              with_token: candidateView.filter((c) => c.has_token).length,
              accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed
            },
            candidates: candidateView,
            note: 'No Cloudflare/D1 writes performed. Duplicate pages across accounts are deduped by page_id (first account = primary, others = fallback). A real import stages each unique page is_active=0 (off).'
          });
        }

        // ── Real all-account import: push each UNIQUE page once with its primary account's page token,
        // automatically falling back to the next account that administers the page if the push fails. ──
        const syncSecretAll = String(
          process.env.BRIDGE_TOKEN_SYNC_SECRET ||
          process.env.TAG_SYNC_PUSH_SECRET ||
          process.env.BROWSERSAVING_TAG_SYNC_SECRET ||
          ''
        ).trim();
        if (!syncSecretAll) {
          return send(res, 200, { ok: false, synced: false, status: 'sync_secret_missing', mode: 'all_accounts', namespace_id: ns, accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed });
        }
        const baseAll = String(
          workerUrl ||
          process.env.VIDEO_AFFILIATE_WORKER_URL ||
          process.env.WORKER_URL ||
          'https://api.pubilo.com'
        ).trim().replace(/\/+$/, '');
        const syncUrlAll = `${baseAll}/api/pages/profile-sync`;

        const countsAll = { created: 0, updated: 0, moved: 0, imported: 0, skipped: 0, errors: 0, fallback_used: 0 };
        const resultsAll = [];
        for (const e of uniquePages) {
          if (!e.tokens.length) {
            countsAll.skipped += 1;
            resultsAll.push({ page_id: e.page_id, page_name: e.page_name, primary_account: e.primary_account, fallback_accounts: e.fallback_accounts, status: 'skipped_no_token' });
            continue;
          }
          let pushed = null;
          let usedAccount = null;
          let lastStatus = 0;
          let unreachable = false;
          // Try the primary account's page token first, then each fallback account's token in turn.
          for (const tk of e.tokens) {
            let workerStatus = 0;
            let data = {};
            try {
              const resp = await fetchImpl(syncUrlAll, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-tag-sync-secret': syncSecretAll },
                body: JSON.stringify({
                  namespace_id: ns,
                  page_id: e.page_id,
                  page_name: e.page_name,
                  access_token: tk.token,
                  comment_token: tk.token,
                  account: tk.account,
                  token_source: 'facebook_lite_bridge',
                  is_active: 0,
                  import_mode: 'facebook_lite_bridge_import'
                })
              });
              workerStatus = Number(resp && resp.status) || 0;
              try { data = await resp.json(); } catch { data = {}; }
            } catch (err) {
              unreachable = true;
              continue; // automatic fallback to the next account that administers this page
            }
            const success = !!(data && data.success === true) && (workerStatus === 0 || (workerStatus >= 200 && workerStatus < 300));
            lastStatus = workerStatus;
            if (success) { pushed = data; usedAccount = tk.account; break; }
          }
          if (!pushed) {
            countsAll.errors += 1;
            resultsAll.push({ page_id: e.page_id, page_name: e.page_name, primary_account: e.primary_account, fallback_accounts: e.fallback_accounts, status: unreachable ? 'worker_unreachable' : 'worker_rejected', worker_status: lastStatus, fallback_used: false });
            continue;
          }
          const fallbackUsed = usedAccount !== e.primary_account;
          countsAll.imported += 1;
          if (pushed.created) countsAll.created += 1;
          if (pushed.updated) countsAll.updated += 1;
          if (pushed.moved) countsAll.moved += 1;
          if (fallbackUsed) countsAll.fallback_used += 1;
          resultsAll.push({
            page_id: e.page_id, page_name: e.page_name,
            primary_account: e.primary_account, fallback_accounts: e.fallback_accounts,
            account: usedAccount, fallback_used: fallbackUsed,
            ...(fallbackUsed ? { fallback_account: usedAccount } : {}),
            status: 'imported',
            created: !!pushed.created, updated: !!pushed.updated, moved: !!pushed.moved,
            staged_inactive: pushed.staged_inactive !== false
          });
        }

        return send(res, 200, {
          ok: countsAll.errors === 0,
          synced: countsAll.imported > 0,
          status: countsAll.errors === 0 ? 'imported' : 'imported_with_errors',
          mode: 'all_accounts', target, namespace_id: ns,
          source: 'facebook_lite_eaad6', token_source: 'facebook_lite_bridge',
          import_mode: 'facebook_lite_bridge_import',
          accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed,
          accounts: accountResults,
          counts: { ...countsAll, accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed },
          results: resultsAll
        });
      }

      if (req.method === 'POST' && url.pathname === '/token/auto-sync') {
        // TRUE-BRIDGE RECOVERY. After Facebook invalidates a session/token and the operator logs
        // the bridge back in, this single call re-mints a FRESH Facebook Lite (EAAD6V) token,
        // lists administered pages over REAL-TIME me/accounts, and refreshes the page token of
        // EVERY matching page in the target namespace via the Worker's secret-authed
        // /api/pages/profile-sync — so posting resumes automatically WITHOUT the Dev exporting
        // page-by-page. Unlike /token/import-pages this is NOT admin-only: it is recovery for the
        // production namespace's EXISTING pages. Safety is preserved by sending the same
        // import_mode=facebook_lite_bridge_import marker the importer uses, so the Worker upsert:
        //   • refreshes an EXISTING page's token (is_active untouched — an active page keeps posting,
        //     a previously-staged inactive page is NEVER auto-activated),
        //   • DECLINES to move/steal a page that already posts in another namespace (returns a
        //     structured conflict), and
        //   • stages any genuinely-new page inactive for the operator to enable later.
        // Local-only for live writes (it resolves Keychain creds + page tokens); dry-run by default;
        // token-free in EVERY response (no raw token ever returned or logged). Event-driven only —
        // there is NO background polling/mint loop here; one call = one real-time scan + push.
        const syncBody = await parseBody(req);
        const { target = 'video-affiliate', workerUrl, dryRun = true } = syncBody;
        // Namespace: explicit body value first, else an env-configured default so the operator/UI can
        // trigger recovery without re-typing the production namespace each time. Never hardcoded.
        const ns = String(
          syncBody.namespaceId || syncBody.namespace_id ||
          process.env.FACEBOOK_TOKEN_CLOAK_SYNC_NAMESPACE || ''
        ).trim();
        if (!ns) return sendError(res, 400, 'Missing namespaceId');
        const wantDryRun = dryRun !== false;

        // Page-targeted recovery: when the caller names the SPECIFIC page whose token was invalidated,
        // the scan is scoped to that page so the response distinguishes "refreshed it" from "no scanned
        // account administers it" (page_not_found_for_all_accounts), instead of silently touching nothing.
        const targetPageId = String(syncBody.pageId || syncBody.page_id || '').trim();
        // Explicit fallback accounts (accepted under several field names) + env-configured mappings. The
        // chain lets Chanalai → Thanwan work without hardcoding any uid: the bridge tries the primary
        // account first, then each fallback, and only syncs from an account that actually lists the page.
        const explicitFallbackAccounts = parseAccountList(
          syncBody.fallbackAccounts || syncBody.accountFallbacks || syncBody.fallback_accounts
        );
        const envAccountFallbacks = parseFallbackMapEnv(process.env.FACEBOOK_TOKEN_CLOAK_ACCOUNT_FALLBACKS);
        const envPageFallbacks = parseFallbackMapEnv(process.env.FACEBOOK_TOKEN_CLOAK_PAGE_FALLBACK_ACCOUNTS);

        // Live writes resolve Keychain credentials + page tokens. INTERNAL machine-to-machine recovery:
        // a LOCAL caller OR a caller presenting the shared bridge sync secret may drive a live recovery,
        // so the remote Worker can trigger auto-sync over the cloudflared tunnel WITHOUT any operator/UI
        // action. A non-local caller without the secret is rejected. The secret is never echoed/logged.
        const autoSyncSecret = String(
          process.env.BRIDGE_TOKEN_SYNC_SECRET ||
          process.env.TAG_SYNC_PUSH_SECRET ||
          process.env.BROWSERSAVING_TAG_SYNC_SECRET ||
          ''
        ).trim();
        const providedAutoSyncSecret = String(
          (req.headers && (req.headers['x-bridge-sync-secret'] || req.headers['x-tag-sync-secret'])) || ''
        ).trim();
        const autoSyncSecretAuthorized = !!autoSyncSecret && providedAutoSyncSecret === autoSyncSecret;
        if (!wantDryRun && !isLocalRequest(req) && !autoSyncSecretAuthorized) {
          return sendError(res, 403, 'Live auto-sync requires localhost or a valid bridge sync secret');
        }

        // Account selection mirrors the all-account importer: an explicit `accounts` list verbatim,
        // a SPECIFIC `account`, or all-mode (account omitted/empty/"all"/"*") which scans every
        // FB-Lite-likely Bridge account from the local registry/status list in REAL TIME now.
        const explicitAccounts = parseAccountList(syncBody.accounts);
        const rawAccount = String(syncBody.account == null ? '' : syncBody.account).trim();
        const allMode = (explicitAccounts && explicitAccounts.length > 0)
          || rawAccount === '' || rawAccount.toLowerCase() === 'all' || rawAccount === '*';
        let scanAccounts;
        if (explicitAccounts && explicitAccounts.length > 0) {
          scanAccounts = explicitAccounts;
        } else if (!allMode) {
          scanAccounts = [rawAccount];
        } else {
          let statuses = [];
          try { statuses = await listAccountStatuses(kc, selectors, registry); } catch { statuses = []; }
          const seen = new Set();
          scanAccounts = [];
          for (const s of statuses) {
            if (!s || !s.account || seen.has(s.key)) continue;
            const likelyLite = s.inRegistry || s.credentialPresent || s.selectorPresent;
            if (!likelyLite) continue;
            seen.add(s.key);
            scanAccounts.push(s.account);
          }
        }
        // Append the configured fallback chain AFTER the primary scan order so the primary account is
        // always tried first; the chain is deduped against what is already scheduled to scan. The primary
        // account for env-mapping lookup is the explicit account (single mode) or the first listed one.
        const primaryAccountForFallback = !allMode
          ? rawAccount
          : ((explicitAccounts && explicitAccounts[0]) || '');
        const fallbackChain = resolveFallbackChain({
          explicit: explicitFallbackAccounts,
          pageId: targetPageId,
          primaryAccount: primaryAccountForFallback,
          envAccountFallbacks,
          envPageFallbacks
        });
        if (fallbackChain.length) {
          const scheduled = new Set(scanAccounts.map((a) => { try { return sanitizeAccount(a).key; } catch { return String(a).toLowerCase(); } }));
          for (const fb of fallbackChain) {
            let key; try { key = sanitizeAccount(fb).key; } catch { continue; }
            if (scheduled.has(key)) continue;
            scheduled.add(key);
            scanAccounts.push(fb);
          }
        }
        // Mode label: a primary account with a configured fallback chain is its own mode (the recovery
        // is targeted, not a blanket all-account scan, but it is no longer a single account either).
        const modeLabel = allMode
          ? 'all_accounts'
          : (fallbackChain.length ? 'primary_with_fallback' : 'single_account');

        if (!scanAccounts.length) {
          return send(res, 200, {
            ok: false, status: 'no_accounts_to_scan', namespace_id: ns, mode: modeLabel,
            note: 'No Facebook Lite account resolved to scan. Pass an explicit account or register one.'
          });
        }

        // LIVE backoff: skip a fresh mint/scan if this namespace was already recovered within the TTL
        // window. The automatic Worker trigger fires per failing page; one live scan refreshes them all,
        // so a repeat within the window is wasted Facebook logins. Dry-run previews are never throttled.
        if (!wantDryRun && AUTO_SYNC_TTL_MS > 0) {
          const lastLive = autoSyncLastLiveByNamespace.get(ns) || 0;
          if (lastLive && (Date.now() - lastLive) < AUTO_SYNC_TTL_MS) {
            return send(res, 200, {
              ok: true, synced: false, status: 'throttled', skipped: true,
              mode: modeLabel, namespace_id: ns,
              note: 'A live auto-sync ran for this namespace within the backoff window; skipped to avoid Facebook login rate limits.'
            });
          }
          // Stamp BEFORE the mint so even a failed attempt counts toward backoff (failures are exactly
          // what we must avoid hammering Facebook with).
          autoSyncLastLiveByNamespace.set(ns, Date.now());
        }

        // Mint + validate + list each account in REAL TIME, de-duping pages by page_id (first account
        // = primary, others = fallback). A token that mints EAAD6V-shaped but is Graph-rejected (e.g.
        // password/session reset, or a fresh rate-limit) is reported NOT ready with a sanitized reason
        // and contributes no pages — Ready never lies. The internal token pool is never serialized.
        const pageMap = new Map();
        const accountResults = [];
        let accountsOk = 0;
        let accountsFailed = 0;
        for (const acct of scanAccounts) {
          const accDisplay = sanitizeAccount(acct).display;
          const lite = await resolveFacebookLiteEAAD6Session(liteDeps, acct).catch((e) => ({ ok: false, reason: (e && (e.code || e.message)) || 'fb_lite_token_error' }));
          if (!lite.ok || !lite.token) {
            accountsFailed += 1;
            accountResults.push({ account: accDisplay, ok: false, status: 'fb_lite_token_not_ready', error: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready'), ...(lite.prefix ? { token_prefix: lite.prefix } : {}) });
            continue;
          }
          // Real-time Graph validation BEFORE listing pages: a minted EAAD6V string is not proof of
          // usability. If me/accounts is rejected (invalidated/rate-limited), report a sanitized
          // reason and skip — never treat a Graph-rejected token as Ready.
          const validation = await validateFacebookLiteGraphToken(lite);
          if (!validation.ok) {
            accountsFailed += 1;
            accountResults.push({ account: accDisplay, ok: false, status: 'token_not_ready', error: validation.reason, ...(lite.prefix ? { token_prefix: lite.prefix } : {}) });
            continue;
          }
          let listed;
          try {
            listed = await posting.listPagesPublic(lite.graphFetch, lite.token, true);
          } catch (e) {
            accountsFailed += 1;
            accountResults.push({ account: accDisplay, ok: false, status: 'graph_pages_failed', error: sanitizePublicReason((e && (e.reason || e.code || e.message)) || 'graph_pages_failed', 'graph_pages_failed') });
            continue;
          }
          if (listed && listed.error) {
            accountsFailed += 1;
            accountResults.push({ account: accDisplay, ok: false, status: 'graph_pages_failed', error: classifyGraphTokenError(listed.error) });
            continue;
          }
          const pages = Array.isArray(listed.data) ? listed.data : [];
          accountsOk += 1;
          let withToken = 0;
          for (const p of pages) {
            const pageId = p && p.id != null ? String(p.id) : '';
            if (!pageId) continue;
            const pageName = p && p.name != null ? String(p.name) : '';
            const pageToken = p && p.access_token ? String(p.access_token) : '';
            if (pageToken) withToken += 1;
            if (!pageMap.has(pageId)) {
              pageMap.set(pageId, { page_id: pageId, page_name: pageName, primary_account: accDisplay, fallback_accounts: [], tokens: [] });
            }
            const entry = pageMap.get(pageId);
            if (!entry.page_name && pageName) entry.page_name = pageName;
            if (accDisplay !== entry.primary_account && !entry.fallback_accounts.includes(accDisplay)) {
              entry.fallback_accounts.push(accDisplay);
            }
            if (pageToken) entry.tokens.push({ account: accDisplay, token: pageToken });
          }
          accountResults.push({ account: accDisplay, ok: true, page_count: pages.length, with_token: withToken, ...(lite.prefix ? { token_prefix: lite.prefix } : {}) });
        }

        const uniquePages = [...pageMap.values()];
        // Page-targeted recovery scopes everything below to the single requested page. When the target
        // page was not administered by ANY scanned account (primary OR fallback), fail CLOSED with a
        // distinct, token-free reason — NEVER silently push nothing. `fallback_account_missing_page` =
        // at least one scanned account WAS ready but did not list the page (e.g. Thanwan is logged in
        // but is not an admin of the Chanalai page); `page_not_found_for_all_accounts` = no account was
        // even ready to list pages.
        const recoveryPages = targetPageId ? uniquePages.filter((e) => e.page_id === targetPageId) : uniquePages;
        if (targetPageId && recoveryPages.length === 0) {
          const someAccountReady = accountsOk > 0;
          return send(res, 200, {
            ok: false, synced: false,
            ...(wantDryRun ? { dryRun: true } : {}),
            status: 'page_not_found_for_all_accounts',
            reason: someAccountReady ? 'fallback_account_missing_page' : 'page_not_found_for_all_accounts',
            mode: modeLabel, target, namespace_id: ns, page_id: targetPageId,
            selected_account: null, fallback_used: false, profile_sync_success: false,
            source: 'facebook_lite_eaad6', token_source: 'facebook_lite_bridge', import_mode: 'facebook_lite_bridge_import',
            accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed,
            accounts: accountResults,
            fallback_accounts_configured: fallbackChain,
            counts: { candidates: 0, with_token: 0, accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed },
            candidates: [],
            note: someAccountReady
              ? 'The target page is not administered by any scanned/fallback account (a ready fallback account does not list it). Add/admin the page on a fallback account, then recovery can complete.'
              : 'No scanned account could list pages (token not ready / rate-limited), so the target page could not be located.'
          });
        }
        const candidateView = recoveryPages.map((e) => ({
          page_id: e.page_id, page_name: e.page_name,
          primary_account: e.primary_account, fallback_accounts: e.fallback_accounts,
          has_token: e.tokens.length > 0
        }));

        // SAFE default: a dry run lists the deduped candidate pages + per-account scan outcomes and
        // performs NO Worker/D1 writes. Token-free.
        if (wantDryRun) {
          return send(res, 200, {
            ok: accountsOk > 0, dryRun: true, status: 'dry_run_only',
            mode: modeLabel, target,
            namespace_id: ns, source: 'facebook_lite_eaad6',
            token_source: 'facebook_lite_bridge', import_mode: 'facebook_lite_bridge_import',
            ...(targetPageId ? { page_id: targetPageId } : {}),
            fallback_accounts_configured: fallbackChain,
            accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed,
            accounts: accountResults,
            counts: {
              candidates: candidateView.length,
              with_token: candidateView.filter((c) => c.has_token).length,
              accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed
            },
            candidates: candidateView,
            note: 'No Cloudflare/D1 writes performed. A live auto-sync refreshes each EXISTING page token (is_active untouched), skips pages owned by another namespace, and stages genuinely-new pages inactive.'
          });
        }

        // ── Live auto-sync: refresh each unique page once via the secret-authed profile-sync, with
        // automatic fallback to the next account that administers the page if a push fails. ──
        const syncSecretAuto = String(
          process.env.BRIDGE_TOKEN_SYNC_SECRET ||
          process.env.TAG_SYNC_PUSH_SECRET ||
          process.env.BROWSERSAVING_TAG_SYNC_SECRET ||
          ''
        ).trim();
        if (!syncSecretAuto) {
          return send(res, 200, { ok: false, synced: false, status: 'sync_secret_missing', mode: modeLabel, namespace_id: ns, accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed });
        }
        const baseAuto = String(
          workerUrl ||
          process.env.VIDEO_AFFILIATE_WORKER_URL ||
          process.env.WORKER_URL ||
          'https://api.pubilo.com'
        ).trim().replace(/\/+$/, '');
        const syncUrlAuto = `${baseAuto}/api/pages/profile-sync`;

        const countsAuto = { refreshed: 0, staged: 0, skipped: 0, errors: 0, no_token: 0, fallback_used: 0, synced: 0 };
        const resultsAuto = [];
        for (const e of recoveryPages) {
          if (!e.tokens.length) {
            countsAuto.no_token += 1;
            resultsAuto.push({ page_id: e.page_id, page_name: e.page_name, primary_account: e.primary_account, fallback_accounts: e.fallback_accounts, status: 'error', reason: 'page_token_unavailable' });
            continue;
          }
          let pushed = null;
          let usedAccount = null;
          let lastStatus = 0;
          let unreachable = false;
          for (const tk of e.tokens) {
            let workerStatus = 0;
            let data = {};
            try {
              const resp = await fetchImpl(syncUrlAuto, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-tag-sync-secret': syncSecretAuto },
                body: JSON.stringify({
                  namespace_id: ns,
                  page_id: e.page_id,
                  page_name: e.page_name,
                  access_token: tk.token,
                  comment_token: tk.token,
                  account: tk.account,
                  token_source: 'facebook_lite_bridge',
                  // No-steal + no-surprise-activate: refresh existing rows, skip cross-namespace pages,
                  // stage truly-new pages inactive. Existing rows' is_active is never changed.
                  import_mode: 'facebook_lite_bridge_import'
                })
              });
              workerStatus = Number(resp && resp.status) || 0;
              try { data = await resp.json(); } catch { data = {}; }
            } catch (err) {
              unreachable = true;
              continue; // automatic fallback to the next account that administers this page
            }
            const success = !!(data && data.success === true) && (workerStatus === 0 || (workerStatus >= 200 && workerStatus < 300));
            lastStatus = workerStatus;
            if (success) { pushed = data; usedAccount = tk.account; break; }
          }
          if (!pushed) {
            countsAuto.errors += 1;
            resultsAuto.push({ page_id: e.page_id, page_name: e.page_name, primary_account: e.primary_account, fallback_accounts: e.fallback_accounts, status: 'error', reason: unreachable ? 'worker_unreachable' : 'worker_rejected', worker_status: lastStatus, profile_sync_success: false });
            continue;
          }
          const fallbackUsed = usedAccount !== e.primary_account;
          if (fallbackUsed) countsAuto.fallback_used += 1;
          // The Worker upsert reports skipped=true with a conflict_namespace_id when a staging refresh
          // declined to move a page already owned by another namespace — surface it as SKIPPED, not synced.
          if (pushed.skipped === true) {
            countsAuto.skipped += 1;
            resultsAuto.push({
              page_id: e.page_id, page_name: e.page_name,
              primary_account: e.primary_account, fallback_accounts: e.fallback_accounts,
              account: usedAccount, fallback_used: fallbackUsed,
              status: 'skipped', reason: 'conflict_other_namespace',
              conflict_namespace_id: pushed.conflict_namespace_id || pushed.conflictNamespaceId || null,
              profile_sync_success: true, worker_status: lastStatus
            });
            continue;
          }
          countsAuto.synced += 1;
          const staged = !!pushed.created; // a new page was inserted (staged inactive)
          if (staged) countsAuto.staged += 1; else countsAuto.refreshed += 1;
          resultsAuto.push({
            page_id: e.page_id, page_name: e.page_name,
            primary_account: e.primary_account, fallback_accounts: e.fallback_accounts,
            account: usedAccount, fallback_used: fallbackUsed,
            ...(fallbackUsed ? { fallback_account: usedAccount } : {}),
            status: staged ? 'staged' : 'synced',
            created: !!pushed.created, updated: !!pushed.updated, moved: !!pushed.moved,
            staged_inactive: staged ? (pushed.staged_inactive !== false) : false,
            profile_sync_success: true, worker_status: lastStatus
          });
        }

        // Page-targeted summary: surface the single page's outcome at the top level so the Worker can
        // act on it directly (which account actually recovered it, whether a fallback was used). Here
        // `fallback_used` is measured against the CONFIGURED primary account (the one named in the
        // request / the head of the scan order), so a recovery via Thanwan for a Chanalai-primary page
        // reads as fallback_used=true even when Chanalai's token was so dead it listed no pages at all.
        const targetRow = targetPageId ? resultsAuto.find((r) => r.page_id === targetPageId) : null;
        const selectedAccount = (targetRow && (targetRow.account || targetRow.primary_account)) || null;
        const configuredPrimaryKey = (() => { try { return primaryAccountForFallback ? sanitizeAccount(primaryAccountForFallback).key : ''; } catch { return ''; } })();
        const selectedKey = (() => { try { return selectedAccount ? sanitizeAccount(selectedAccount).key : ''; } catch { return ''; } })();
        const targetFallbackUsed = configuredPrimaryKey && selectedKey
          ? selectedKey !== configuredPrimaryKey
          : !!(targetRow && targetRow.fallback_used);
        const targetSummary = targetPageId ? {
          page_id: targetPageId,
          selected_account: selectedAccount,
          fallback_used: targetFallbackUsed,
          profile_sync_success: !!(targetRow && targetRow.profile_sync_success),
        } : {};

        return send(res, 200, {
          ok: countsAuto.errors === 0 && accountsOk > 0,
          synced: countsAuto.synced > 0,
          status: countsAuto.errors === 0 ? 'synced' : 'synced_with_errors',
          mode: modeLabel, target, namespace_id: ns,
          source: 'facebook_lite_eaad6', token_source: 'facebook_lite_bridge',
          import_mode: 'facebook_lite_bridge_import',
          ...targetSummary,
          fallback_accounts_configured: fallbackChain,
          accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed,
          accounts: accountResults,
          counts: { ...countsAuto, accounts_scanned: scanAccounts.length, accounts_ok: accountsOk, accounts_failed: accountsFailed },
          results: resultsAuto
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
          // Real-time Graph validation gate: a minted EAAD6V string/prefix is NOT proof of usability.
          // Confirm the token authorizes me/accounts (Page-token operations) NOW. A token invalidated
          // by a password change / security reset is EAAD6V-shaped but Graph-rejected — it must report
          // ok=false/accessToken=false here, never Ready.
          const validation = await validateFacebookLiteGraphToken(lite);
          if (!validation.ok) {
            return send(res, 200, { ok: false, accessToken: false, fbDtsg: false, source: 'facebook_lite_eaad6', account: sanitizeAccount(account).display, error: validation.reason, tokenPrefix: lite.prefix || null });
          }
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
        // Facebook Lite account: list administered pages from the freshly-minted EAAD6V user token via
        // me/accounts (NOT a CloakBrowser session). This is what the Worker's session-bridge organic
        // publish path probes (/token + /pages) before posting, and what /pages?includeToken=1 reads.
        if (wantsFacebookLiteBridge(account, { facebook_lite: url.searchParams.get('facebook_lite') || url.searchParams.get('token_source') || '' })) {
          const lite = await resolveFacebookLiteEAAD6Session(liteDeps, account).catch((e) => ({ ok: false, reason: (e && (e.code || e.message)) || 'fb_lite_token_error' }));
          if (!lite.ok || !lite.token) return send(res, 200, { data: [], source: 'facebook_lite_eaad6', error: sanitizePublicReason(lite.reason || 'fb_lite_token_not_ready', 'fb_lite_token_not_ready') });
          const result = await posting.listPagesPublic(lite.graphFetch, lite.token, includeToken && isLocalRequest(req));
          // Fail closed on a Graph token-validation error (e.g. password/session invalidated): return
          // an empty list with a SANITIZED reason, never the raw Graph message and never source-ready.
          if (result && result.error) {
            return send(res, 200, { data: [], source: 'facebook_lite_eaad6', error: classifyGraphTokenError(result.error) });
          }
          return send(res, 200, { ...result, source: 'facebook_lite_eaad6' });
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
