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
  if (result && result.ok) return 200;
  if (result && typeof result.status === 'number') return result.status;
  if (result && result.step === 'validate') return 400;
  return 200;
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
        const { account, visible = false, includeToken = false } = await parseBody(req);
        if (!account) return sendError(res, 400, 'Missing account');
        const { display } = sanitizeAccount(account);
        let opened;
        try {
          opened = await br.openPage(account, FACEBOOK_OAUTH_URL, { visible: !!visible });
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
        const { account, target = 'video-affiliate', namespaceId, dryRun = true } = await parseBody(req);
        if (!account) return sendError(res, 400, 'Missing account');
        const { display } = sanitizeAccount(account);
        return send(res, 200, {
          account: display,
          target,
          namespaceId: namespaceId || null,
          dryRun: dryRun !== false,
          status: 'dry_run_only',
          wouldUpdate: ['dedicated_comment_token_v1', 'pages_token_pool_v1', 'pages.access_token'],
          note: 'No Cloudflare/D1 writes performed by this endpoint.'
        });
      }

      // ── Worker posting bridge routes (CloakBrowser) ──────────────────────────────────────
      // All resolve a fresh user token from the persistent logged-in profile, run their Graph
      // work through the cookie-bound browser client, and ALWAYS close the context in `finally`.
      // Raw tokens/cookies/fb_dtsg are never returned or logged.

      if (req.method === 'GET' && url.pathname === '/token') {
        const account = url.searchParams.get('account') || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          const accessToken = !!session.token;
          let fbDtsg = !!session.fbDtsgPresent;
          if (!fbDtsg && session.context) {
            try { fbDtsg = await posting.hasLoggedInSession(session.context); } catch {}
          }
          return send(res, 200, { ok: true, accessToken, fbDtsg, account: sanitizeAccount(account).display });
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'GET' && url.pathname === '/pages') {
        const account = url.searchParams.get('account') || POST_ACCOUNT;
        const session = await posting.resolveSessionToken({ browser: br, account });
        try {
          if (!session.token) return send(res, 200, { data: [], error: 'no_session' });
          const result = await posting.listPagesPublic(session.graphFetch, session.token);
          return send(res, 200, result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/post') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
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
            pollMs: POLL_MS
          });
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
      }

      if (req.method === 'POST' && url.pathname === '/page-comment') {
        const body = await parseBody(req);
        const account = body.account || POST_ACCOUNT;
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
          return send(res, postingStatus(result), result);
        } finally {
          await posting.closeSession(session);
        }
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
