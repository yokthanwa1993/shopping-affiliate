'use strict';
// Side-by-side Stealth Browser (nodriver / Stealth Browser MCP) backend for facebook-token-cloak.
//
// This is an OPT-IN alternative to the default CloakBrowser backend in browser.js. It is selected
// ONLY when an env var explicitly asks for it (see resolveBrowserBackend); otherwise the existing
// CloakBrowser behavior is untouched and the production 8820 LaunchAgent is unaffected.
//
// Design note: this is Node-specific and independent from the retired Shopee shortlink Python sidecar.
//   - The Stealth Browser (nodriver-launched Chromium) is an ALREADY-RUNNING, ALREADY-AUTHENTICATED
//     process that exposes a Chrome DevTools (CDP) endpoint. We ATTACH to it with playwright-core's
//     chromium.connectOverCDP and hand back its live BrowserContext/Page. That context/page is fully
//     compatible with browser.js's openPage abstraction, so resolveSessionToken / graphFetch /
//     /update-cta all run through the EXACT SAME code path as the CloakBrowser backend.
//   - We NEVER launch a persistent profile, autofill credentials, submit a login form, or drive a
//     checkpoint/CAPTCHA here. Attaching to a running browser is the only side effect, so this path
//     never hammers Facebook. Manual/visible login stays the operator's job in the Stealth browser.
//   - The wrapped context's close() DISCONNECTS the CDP link (playwright connectOverCDP semantics)
//     instead of tearing down the operator's real Chrome window/tabs.
//   - Tokens/cookies are never read or returned here; token extraction stays in posting.js and is
//     fail-closed (token_not_found) exactly as with CloakBrowser.
//
// playwright-core is a normal dependency, but it is required LAZILY inside the launcher so importing
// this module (and the unit-test suite) never needs a browser. connectOverCDP is injectable for tests.

const path = require('path');

// Env names (documented in README).
const BACKEND_ENV_PRIMARY = 'FACEBOOK_TOKEN_CLOAK_BROWSER_BACKEND';
const BACKEND_ENV_FALLBACK = 'ACCOUNTS_BRIDGE_BROWSER_BACKEND';
const CDP_URL_ENV = 'FACEBOOK_TOKEN_CLOAK_STEALTH_CDP_URL';
const ACCOUNT_CDP_MAP_ENV = 'FACEBOOK_TOKEN_CLOAK_STEALTH_ACCOUNT_CDP_MAP';

const BACKEND_CLOAKBROWSER = 'cloakbrowser';
const BACKEND_STEALTH = 'stealth';

const STEALTH_ALIASES = new Set([
  'stealth',
  'nodriver',
  'stealth-mcp',
  'stealth-browser',
  'stealth-nodriver',
  'stealth-browser-mcp'
]);

// Map any raw backend string onto a canonical backend id. Anything in the stealth alias set → the
// stealth backend; everything else (empty / unknown) → the default CloakBrowser backend.
function normalizeBrowserBackend(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return STEALTH_ALIASES.has(text) ? BACKEND_STEALTH : BACKEND_CLOAKBROWSER;
}

// Resolve the active backend from env, preserving the default when unset. The facebook-token-cloak
// env wins; ACCOUNTS_BRIDGE_* is a fallback (the bridge shares this process). If neither selects the
// stealth backend, the default CloakBrowser backend is returned so existing behavior is preserved.
function resolveBrowserBackend(environ) {
  const env = environ || process.env;
  let raw = env[BACKEND_ENV_PRIMARY];
  if (raw == null || !String(raw).trim()) raw = env[BACKEND_ENV_FALLBACK];
  if (raw == null || !String(raw).trim()) return BACKEND_CLOAKBROWSER;
  return normalizeBrowserBackend(raw);
}

function isStealthBackendSelected(environ) {
  return resolveBrowserBackend(environ) === BACKEND_STEALTH;
}

// A sanitized single-segment account key (matches how browser.profileDirFor names the profile dir).
function safeAccountKey(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .toLowerCase();
}

// True when a string looks like a usable CDP endpoint (http(s) DevTools URL or a ws(s) debugger URL).
function looksLikeCdpEndpoint(url) {
  const text = String(url == null ? '' : url).trim();
  if (!text) return false;
  return /^(https?|wss?):\/\/[^\s]+$/i.test(text);
}

// Parse `key=endpoint,key2=endpoint2` into a lowercased-key → endpoint map. Keys are account ids /
// names (e.g. 100090320823561=http://127.0.0.1:9222). Malformed / non-CDP entries are skipped so a
// typo can never silently point an account at a bad target.
function parseAccountCdpMap(raw) {
  const out = {};
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return out;
  for (const chunk of text.split(/[,\n;]+/)) {
    const entry = chunk.trim();
    if (!entry || entry.indexOf('=') === -1) continue;
    const idx = entry.indexOf('=');
    const key = safeAccountKey(entry.slice(0, idx));
    const value = entry.slice(idx + 1).trim();
    if (key && looksLikeCdpEndpoint(value)) out[key] = value;
  }
  return out;
}

// Resolve the CDP endpoint for an account: an explicit per-account map entry wins, otherwise the
// single default endpoint. Returns '' when neither is configured (the launcher fails closed on '').
function resolveStealthCdpEndpoint(account, opts = {}) {
  const env = opts.env || process.env;
  const map = opts.map || parseAccountCdpMap(env[ACCOUNT_CDP_MAP_ENV]);
  const key = safeAccountKey(account);
  if (key && map[key]) return map[key];
  const fallback = opts.defaultEndpoint != null ? opts.defaultEndpoint : env[CDP_URL_ENV];
  const text = String(fallback == null ? '' : fallback).trim();
  return looksLikeCdpEndpoint(text) ? text : '';
}

// Lazily obtain playwright-core's chromium.connectOverCDP. Kept out of module scope so importing this
// file never loads playwright; only a live stealth launch touches it. Injectable via opts for tests.
function resolveConnectOverCDP(inject) {
  if (typeof inject === 'function') return inject;
  let pw;
  try {
    pw = require('playwright-core');
  } catch (e) {
    throw Object.assign(new Error('Stealth backend requires playwright-core to attach over CDP'), {
      code: 'stealth_playwright_missing',
      cause: e
    });
  }
  const chromium = pw && pw.chromium;
  if (!chromium || typeof chromium.connectOverCDP !== 'function') {
    throw Object.assign(new Error('playwright-core chromium.connectOverCDP is unavailable'), {
      code: 'stealth_connect_over_cdp_missing'
    });
  }
  return (endpoint) => chromium.connectOverCDP(endpoint);
}

// Wrap a CDP-attached BrowserContext so close() DISCONNECTS the CDP link instead of destroying the
// operator's real Chrome context/tabs. Everything else delegates to the live context unchanged, so
// cookies()/request/pages()/newPage()/evaluate keep working for token extraction + graphFetch.
function wrapAttachedContext(browserConn, context) {
  return new Proxy(context, {
    get(target, prop, receiver) {
      if (prop === 'close') {
        return async () => {
          // connectOverCDP: browser.close() disconnects this client from Chrome; it does NOT kill the
          // operator's Stealth browser process. NEVER call the real context.close() (that would drop
          // the operator's tabs/session).
          try {
            if (browserConn && typeof browserConn.close === 'function') await browserConn.close();
          } catch {}
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

// Build the browser-backend descriptor consumed by browser.loadBrowserBackend(). The launcher's
// launchPersistentContext signature matches the CloakBrowser launcher (profileDir, options) but,
// instead of launching a profile, ATTACHES to the running Stealth browser for that account over CDP
// and returns its live context. Fails CLOSED (never a fake success) when no endpoint is configured
// or the attach fails.
function loadStealthBackend(opts = {}) {
  const env = opts.env || process.env;
  const connectOverCDP = resolveConnectOverCDP(opts.connectOverCDP);
  const accountMap = parseAccountCdpMap(env[ACCOUNT_CDP_MAP_ENV]);
  return {
    backend: BACKEND_STEALTH,
    launcher: {
      async launchPersistentContext(profileDir, options = {}) {
        // browser.profileDirFor names the profile dir after the sanitized account key, so its basename
        // is the account key we map to a CDP endpoint.
        const account = path.basename(String(profileDir || ''));
        const endpoint = resolveStealthCdpEndpoint(account, { env, map: accountMap });
        if (!endpoint) {
          throw Object.assign(
            new Error('Stealth backend has no CDP endpoint for this account; set ' + CDP_URL_ENV + ' or ' + ACCOUNT_CDP_MAP_ENV),
            { code: 'stealth_cdp_endpoint_missing', account }
          );
        }
        let browserConn;
        try {
          browserConn = await connectOverCDP(endpoint);
        } catch (e) {
          throw Object.assign(new Error('Stealth backend could not attach to the running browser over CDP'), {
            code: 'stealth_cdp_connect_failed',
            cause: e
          });
        }
        let context = null;
        try {
          const contexts = (typeof browserConn.contexts === 'function' ? browserConn.contexts() : []) || [];
          context = contexts[0] || (typeof browserConn.newContext === 'function' ? await browserConn.newContext() : null);
        } catch (e) {
          try { if (browserConn && typeof browserConn.close === 'function') await browserConn.close(); } catch {}
          throw Object.assign(new Error('Stealth backend attached but exposed no usable browser context'), {
            code: 'stealth_cdp_context_missing',
            cause: e
          });
        }
        if (!context) {
          try { if (browserConn && typeof browserConn.close === 'function') await browserConn.close(); } catch {}
          throw Object.assign(new Error('Stealth backend attached but exposed no usable browser context'), {
            code: 'stealth_cdp_context_missing'
          });
        }
        // Ignore CloakBrowser-oriented launch options (headless/args/userDataDir); attaching to an
        // already-running browser cannot honor them, and silently doing so is safer than relaunching.
        return wrapAttachedContext(browserConn, context);
      }
    }
  };
}

module.exports = {
  BACKEND_ENV_PRIMARY,
  BACKEND_ENV_FALLBACK,
  CDP_URL_ENV,
  ACCOUNT_CDP_MAP_ENV,
  BACKEND_CLOAKBROWSER,
  BACKEND_STEALTH,
  STEALTH_ALIASES,
  normalizeBrowserBackend,
  resolveBrowserBackend,
  isStealthBackendSelected,
  safeAccountKey,
  looksLikeCdpEndpoint,
  parseAccountCdpMap,
  resolveStealthCdpEndpoint,
  wrapAttachedContext,
  loadStealthBackend
};
