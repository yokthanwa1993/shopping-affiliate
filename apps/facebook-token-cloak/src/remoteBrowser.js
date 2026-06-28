'use strict';

// Remote (cloud) browser manager for the Accounts page "Cloud Browser" feature.
//
// WHY THIS EXISTS: operators want to SEE and DRIVE a logged-in Facebook profile that lives on this
// Mac mini from the pubilo dashboard — without remoting into the desktop and without exposing the Mac
// screen. This manager opens the SAME BrowserSaving-style persistent profile the Accounts Bridge
// "Open on Mac" command uses (restore sealed archive → launch Chromium), then streams JPEG frames of
// ONE page and relays click/type/scroll/navigate input back to it. On stop it uploads the sealed
// profile archive again so the session persists for the next open.
//
// HARD SAFETY RULES (do not relax):
//   * No JavaScript eval / no arbitrary-script endpoint — input is a fixed, validated action vocabulary.
//   * Never returns cookies, tokens, datr, fb_dtsg, passwords, or any profile bytes. status() exposes
//     only id/account_uid/url/title/status/viewport; screenshot() returns a rasterized image only.
//   * session ids are unpredictable (crypto.randomBytes), so a leaked dashboard tab URL is the only
//     handle and it cannot be guessed.
//   * Only one viewport page per session is ever driven; the desktop is never captured.

const crypto = require('crypto');
const { sanitizeAccount } = require('./accounts');

const DEFAULT_URL = 'https://www.facebook.com/';
// Bound input so a hostile/buggy client cannot drive absurd coordinates or paste megabytes of text.
const MAX_COORD = 20000;
const MAX_SCROLL_DELTA = 100000;
const MAX_TEXT_LEN = 4000;
const MAX_KEY_LEN = 40;
const MAX_URL_LEN = 4096;
// Cap concurrent visible sessions so a runaway client cannot launch unbounded Chromium windows.
const MAX_SESSIONS = 8;

const VALID_ACTIONS = new Set(['click', 'type', 'key', 'scroll', 'navigate', 'back', 'forward', 'reload']);

function badRequest(message, code) {
  return Object.assign(new Error(message), { status: 400, code: code || 'bad_request' });
}
function notFound(message, code) {
  return Object.assign(new Error(message), { status: 404, code: code || 'not_found' });
}

function newSessionId() {
  // 18 bytes → 36 hex chars: unguessable handle for the dashboard tab.
  return 'rb_' + crypto.randomBytes(18).toString('hex');
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateCoord(name, v) {
  if (!isFiniteNumber(v)) throw badRequest(`${name} must be a finite number`, 'coord_invalid');
  if (v < 0 || v > MAX_COORD) throw badRequest(`${name} out of range`, 'coord_out_of_range');
  return v;
}

function validateDelta(name, v) {
  if (v == null) return 0;
  if (!isFiniteNumber(v)) throw badRequest(`${name} must be a finite number`, 'delta_invalid');
  if (Math.abs(v) > MAX_SCROLL_DELTA) throw badRequest(`${name} out of range`, 'delta_out_of_range');
  return v;
}

function validateHttpUrl(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > MAX_URL_LEN) throw badRequest('url missing or too long', 'url_invalid');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw badRequest('url is not parseable', 'url_invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('url must be http(s)', 'url_scheme_blocked');
  }
  return parsed.toString();
}

// createRemoteBrowserManager({ browser, profileArchiveSync, defaultUrl? })
//   browser            the src/browser.js module (openPage / closeAccountContext)
//   profileArchiveSync the src/profileArchiveSync.js module (restoreBeforeOpen / uploadAfterClose)
//   defaultUrl         landing URL when start() omits initial_url (default Facebook home)
function createRemoteBrowserManager({ browser, profileArchiveSync, defaultUrl } = {}) {
  if (!browser || typeof browser.openPage !== 'function') {
    throw new Error('createRemoteBrowserManager requires a browser backend with openPage');
  }
  const archive = profileArchiveSync || {};
  const landingUrl = defaultUrl || DEFAULT_URL;
  // session_id -> { session_id, account_uid, context, page, started_at, last_activity_at, status }
  const sessions = new Map();

  function getSession(sessionId) {
    const s = sessions.get(String(sessionId || ''));
    if (!s) throw notFound('remote browser session not found', 'session_not_found');
    return s;
  }

  function touch(s) {
    s.last_activity_at = new Date().toISOString();
  }

  // Public, secret-free projection of a session. Never includes context/page handles or cookies.
  function publicStatus(s) {
    let url = null;
    let title = null;
    let viewport = null;
    try { url = typeof s.page.url === 'function' ? s.page.url() : null; } catch {}
    try { viewport = typeof s.page.viewportSize === 'function' ? s.page.viewportSize() : null; } catch {}
    return {
      id: s.session_id,
      account_uid: s.account_uid,
      url: url || null,
      title: title, // filled asynchronously by status(); start() returns null title initially
      status: s.status,
      viewport: viewport || null,
      started_at: s.started_at
    };
  }

  async function start({ account_uid, initial_url } = {}) {
    // sanitizeAccount throws a 400 for path-traversal / control chars / empty input.
    const { key } = sanitizeAccount(account_uid);
    if (sessions.size >= MAX_SESSIONS) {
      throw Object.assign(new Error('too many active remote browser sessions'), { status: 429, code: 'too_many_sessions' });
    }
    const target = initial_url ? validateHttpUrl(initial_url) : landingUrl;

    // Mirror the Accounts Bridge "Open on Mac" lifecycle: restore the sealed profile archive BEFORE
    // launching Chromium so the cloud session is cookie-identical to the local one.
    const restore = typeof archive.restoreBeforeOpen === 'function'
      ? await archive.restoreBeforeOpen(key)
      : { ok: true, skipped: true, reason: 'no_archive_sync' };

    // visible+reuse mirrors openProfile in the poller — a cached per-account persistent context so a
    // second open navigates the same window instead of locking the profile dir.
    const opened = await browser.openPage(key, target, { visible: true, reuse: true });
    const session_id = newSessionId();
    const now = new Date().toISOString();
    const session = {
      session_id,
      account_uid: key,
      context: opened.context || null,
      page: opened.page,
      started_at: now,
      last_activity_at: now,
      status: 'running'
    };
    sessions.set(session_id, session);
    return {
      ...publicStatus(session),
      reused: !!opened.reused,
      archiveSync: restore
    };
  }

  async function status(sessionId) {
    const s = getSession(sessionId);
    const out = publicStatus(s);
    try { out.title = typeof s.page.title === 'function' ? await s.page.title() : null; } catch { out.title = null; }
    return out;
  }

  async function screenshot(sessionId) {
    const s = getSession(sessionId);
    if (typeof s.page.screenshot !== 'function') {
      throw Object.assign(new Error('screenshot unsupported by backend'), { status: 500, code: 'screenshot_unsupported' });
    }
    const buffer = await s.page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
    touch(s);
    return { buffer: Buffer.from(buffer), contentType: 'image/jpeg' };
  }

  async function input(sessionId, action, payload = {}) {
    const s = getSession(sessionId);
    const act = String(action || '').trim().toLowerCase();
    if (!VALID_ACTIONS.has(act)) throw badRequest(`unsupported action ${act || '(empty)'}`, 'action_unsupported');
    const page = s.page;
    const data = payload && typeof payload === 'object' ? payload : {};

    switch (act) {
      case 'click': {
        const x = validateCoord('x', data.x);
        const y = validateCoord('y', data.y);
        if (page.mouse && typeof page.mouse.click === 'function') await page.mouse.click(x, y);
        break;
      }
      case 'type': {
        const text = String(data.text == null ? '' : data.text);
        if (text.length > MAX_TEXT_LEN) throw badRequest('text too long', 'text_too_long');
        if (page.keyboard && typeof page.keyboard.type === 'function') await page.keyboard.type(text);
        break;
      }
      case 'key': {
        const key = String(data.key || '').trim();
        if (!key || key.length > MAX_KEY_LEN) throw badRequest('key missing or too long', 'key_invalid');
        if (page.keyboard && typeof page.keyboard.press === 'function') await page.keyboard.press(key);
        break;
      }
      case 'scroll': {
        const dx = validateDelta('deltaX', data.deltaX);
        const dy = validateDelta('deltaY', data.deltaY);
        // Position the cursor first when coordinates are supplied so the wheel targets the hovered region.
        if (data.x != null && data.y != null && page.mouse && typeof page.mouse.move === 'function') {
          await page.mouse.move(validateCoord('x', data.x), validateCoord('y', data.y));
        }
        if (page.mouse && typeof page.mouse.wheel === 'function') await page.mouse.wheel(dx, dy);
        break;
      }
      case 'navigate': {
        const url = validateHttpUrl(data.url);
        if (typeof page.goto === 'function') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        break;
      }
      case 'back': {
        if (typeof page.goBack === 'function') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        break;
      }
      case 'forward': {
        if (typeof page.goForward === 'function') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        break;
      }
      case 'reload': {
        if (typeof page.reload === 'function') await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        break;
      }
    }
    touch(s);
    return { ok: true, action: act };
  }

  async function stop(sessionId) {
    const s = getSession(sessionId);
    sessions.delete(s.session_id);
    s.status = 'closing';
    // Close the operator-visible context this manager opened. Prefer the browser module's
    // closeAccountContext (it owns the cached per-account context) and fall back to direct close.
    try {
      if (typeof browser.closeAccountContext === 'function') {
        await browser.closeAccountContext(s.account_uid);
      } else if (s.page && typeof s.page.close === 'function') {
        await s.page.close();
        if (s.context && typeof s.context.close === 'function') await s.context.close();
      }
    } catch {
      // best-effort close — still attempt the archive upload below
    }
    // Mirror close_profile: after Chromium flushes, seal + upload the allowlisted profile state so the
    // next open restores it. Only metadata is returned — never archive bytes or secrets.
    const upload = typeof archive.uploadAfterClose === 'function'
      ? await archive.uploadAfterClose(s.account_uid)
      : { ok: true, skipped: true, reason: 'no_archive_sync' };
    return {
      ok: true,
      closed: true,
      id: s.session_id,
      account_uid: s.account_uid,
      status: 'closed',
      archiveSync: upload
    };
  }

  function listSessionIds() {
    return [...sessions.keys()];
  }

  return { start, status, screenshot, input, stop, listSessionIds };
}

module.exports = { createRemoteBrowserManager, DEFAULT_URL };
