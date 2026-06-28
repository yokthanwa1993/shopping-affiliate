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

// ── Live screencast (CDP) constants ────────────────────────────────────────────────────────────────
// The LIVE stream uses Chrome DevTools Protocol Page.startScreencast + Input.dispatch* over a WebSocket.
// We accept only a fixed vocabulary of CDP event types and mouse buttons — NO raw CDP method passthrough
// and NO JS eval — so a hostile client can never escalate the WS into arbitrary DevTools control.
const SCREENCAST_MOUSE_EVENTS = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']);
const SCREENCAST_KEY_EVENTS = new Set(['keyDown', 'keyUp', 'rawKeyDown', 'char']);
const SCREENCAST_MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);
// Inbound WS control messages are tiny JSON; bound the raw string so a buggy/hostile client can't flood.
const MAX_WS_MESSAGE_LEN = 64 * 1024;
const DEFAULT_SCREENCAST_QUALITY = 70;
const DEFAULT_EVERY_NTH_FRAME = 1;

function clampQuality(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SCREENCAST_QUALITY;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function clampEveryNthFrame(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_EVERY_NTH_FRAME;
  return Math.min(8, Math.max(1, Math.round(n)));
}

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

  // ── Live screencast over a WebSocket (CDP) ─────────────────────────────────────────────────────
  // startScreencast attaches a CDP session to the ONE driven page, streams Page.screencastFrame events
  // as JSON `frame` messages over the supplied ws, and relays a fixed input vocabulary back via
  // Input.dispatchMouseEvent / dispatchKeyEvent. The ws is an abstract object: send(string), on('message'
  // |'close'|'error'), readyState (1 = OPEN), close(). On ws close the screencast is torn down and the
  // CDP session detached. This NEVER carries a secret — frames are rasterized image bytes (base64) and
  // status carries only url/title/viewport. There is NO raw CDP passthrough and NO eval.
  async function startScreencast(sessionId, ws, opts = {}) {
    const s = getSession(sessionId);
    if (!ws || typeof ws.send !== 'function' || typeof ws.on !== 'function') {
      throw badRequest('a websocket is required for screencast', 'ws_required');
    }
    const page = s.page;
    if (!page || typeof page.context !== 'function') {
      throw Object.assign(new Error('screencast unsupported by backend'), { status: 500, code: 'screencast_unsupported' });
    }
    const context = page.context();
    if (!context || typeof context.newCDPSession !== 'function') {
      throw Object.assign(new Error('CDP session unavailable (chromium only)'), { status: 500, code: 'cdp_unavailable' });
    }

    // One screencast per session — tear down a prior one (e.g. a reconnecting viewer) first.
    if (s.screencast) {
      try { await stopScreencast(s); } catch { /* best effort */ }
    }

    const cdp = await context.newCDPSession(page);
    const cast = { cdp, ws, seq: 0, closed: false, frameHandler: null, onMessage: null, onClose: null, onError: null };
    s.screencast = cast;

    const wsSend = (obj) => {
      if (cast.closed) return;
      // readyState may be undefined for fakes; only suppress when explicitly not OPEN.
      if (ws.readyState !== undefined && ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(obj)); } catch { /* peer gone */ }
    };

    // Stream each screencast frame, then ACK it so CDP keeps producing frames (un-ACK'd frames stall it).
    cast.frameHandler = (event) => {
      if (cast.closed || !event) return;
      cast.seq += 1;
      wsSend({ type: 'frame', sessionId: s.session_id, seq: cast.seq, data: event.data, metadata: event.metadata || null });
      touch(s);
      Promise.resolve(cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })).catch(() => {});
    };
    cdp.on('Page.screencastFrame', cast.frameHandler);

    cast.onMessage = (raw) => { handleScreencastMessage(s, cast, raw, wsSend).catch(() => {}); };
    cast.onClose = () => { stopScreencast(s).catch(() => {}); };
    cast.onError = () => { stopScreencast(s).catch(() => {}); };
    ws.on('message', cast.onMessage);
    ws.on('close', cast.onClose);
    ws.on('error', cast.onError);

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: clampQuality(opts.quality),
      everyNthFrame: clampEveryNthFrame(opts.everyNthFrame),
      maxWidth: 1920,
      maxHeight: 1920,
    });

    // Send an initial status so the viewer's address bar / title populate immediately.
    await sendScreencastStatus(s, wsSend);
    return { ok: true, id: s.session_id };
  }

  async function sendScreencastStatus(s, wsSend) {
    const out = publicStatus(s);
    try { out.title = typeof s.page.title === 'function' ? await s.page.title() : null; } catch { out.title = null; }
    wsSend({ type: 'status', sessionId: s.session_id, url: out.url, title: out.title, viewport: out.viewport, status: out.status });
  }

  // Translate ONE validated client control message into a CDP input dispatch (or navigation/command).
  async function handleScreencastMessage(s, cast, raw, wsSend) {
    if (cast.closed) return;
    const text = typeof raw === 'string' ? raw : (Buffer.isBuffer(raw) ? raw.toString('utf8') : '');
    if (!text || text.length > MAX_WS_MESSAGE_LEN) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const cdp = cast.cdp;
    const type = String(msg.type || '').toLowerCase();

    try {
      switch (type) {
        case 'mouse': {
          const event = String(msg.event || '');
          if (!SCREENCAST_MOUSE_EVENTS.has(event)) return;
          const params = {
            type: event,
            x: validateCoord('x', Number(msg.x)),
            y: validateCoord('y', Number(msg.y)),
          };
          if (event === 'mouseWheel') {
            params.deltaX = validateDelta('deltaX', msg.deltaX);
            params.deltaY = validateDelta('deltaY', msg.deltaY);
          }
          if (event === 'mousePressed' || event === 'mouseReleased') {
            const button = msg.button == null ? 'left' : String(msg.button);
            if (!SCREENCAST_MOUSE_BUTTONS.has(button)) throw badRequest('bad mouse button', 'button_invalid');
            params.button = button;
            params.clickCount = Number.isFinite(Number(msg.clickCount)) ? Math.min(3, Math.max(1, Math.round(Number(msg.clickCount)))) : 1;
          } else if (event === 'mouseMoved' && msg.button && SCREENCAST_MOUSE_BUTTONS.has(String(msg.button))) {
            params.button = String(msg.button);
          }
          await cdp.send('Input.dispatchMouseEvent', params);
          touch(s);
          break;
        }
        case 'key': {
          const event = String(msg.event || '');
          if (!SCREENCAST_KEY_EVENTS.has(event)) return;
          const params = { type: event };
          if (msg.key != null) {
            const key = String(msg.key);
            if (key.length > MAX_KEY_LEN) throw badRequest('key too long', 'key_invalid');
            params.key = key;
          }
          if (msg.code != null) {
            const code = String(msg.code);
            if (code.length > MAX_KEY_LEN) throw badRequest('code too long', 'code_invalid');
            params.code = code;
          }
          if (msg.text != null) {
            const t = String(msg.text);
            if (t.length > MAX_TEXT_LEN) throw badRequest('text too long', 'text_too_long');
            params.text = t;
          }
          if (Number.isFinite(Number(msg.windowsVirtualKeyCode))) {
            params.windowsVirtualKeyCode = Math.round(Number(msg.windowsVirtualKeyCode));
          }
          await cdp.send('Input.dispatchKeyEvent', params);
          touch(s);
          break;
        }
        case 'navigate': {
          const url = validateHttpUrl(msg.url);
          if (typeof s.page.goto === 'function') {
            await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          }
          await sendScreencastStatus(s, wsSend);
          touch(s);
          break;
        }
        case 'command': {
          const command = String(msg.command || '').toLowerCase();
          const page = s.page;
          if (command === 'back' && typeof page.goBack === 'function') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          else if (command === 'forward' && typeof page.goForward === 'function') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          else if (command === 'reload' && typeof page.reload === 'function') await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          else if (command === 'stop') { await stopScreencast(s); try { cast.ws.close(); } catch {} return; }
          else return;
          await sendScreencastStatus(s, wsSend);
          touch(s);
          break;
        }
        case 'status': {
          await sendScreencastStatus(s, wsSend);
          break;
        }
        default:
          return;
      }
    } catch (e) {
      // Never let one bad message kill the stream; surface a safe error code only.
      wsSend({ type: 'error', error: (e && e.code) ? String(e.code) : 'input_failed' });
    }
  }

  // Tear down a session's screencast: detach the frame listener, stop CDP screencast, detach the CDP
  // session. Idempotent and best-effort so it is safe to call on ws close, command:stop, and stop().
  async function stopScreencast(s) {
    const cast = s && s.screencast;
    if (!cast || cast.closed) return;
    cast.closed = true;
    s.screencast = null;
    const { cdp, ws, frameHandler, onMessage, onClose, onError } = cast;
    try {
      if (frameHandler) {
        if (typeof cdp.off === 'function') cdp.off('Page.screencastFrame', frameHandler);
        else if (typeof cdp.removeListener === 'function') cdp.removeListener('Page.screencastFrame', frameHandler);
      }
    } catch { /* ignore */ }
    if (ws && typeof ws.off === 'function') {
      try { if (onMessage) ws.off('message', onMessage); } catch {}
      try { if (onClose) ws.off('close', onClose); } catch {}
      try { if (onError) ws.off('error', onError); } catch {}
    } else if (ws && typeof ws.removeListener === 'function') {
      try { if (onMessage) ws.removeListener('message', onMessage); } catch {}
      try { if (onClose) ws.removeListener('close', onClose); } catch {}
      try { if (onError) ws.removeListener('error', onError); } catch {}
    }
    try { await cdp.send('Page.stopScreencast'); } catch { /* page may be gone */ }
    try { if (typeof cdp.detach === 'function') await cdp.detach(); } catch { /* ignore */ }
  }

  async function stop(sessionId) {
    const s = getSession(sessionId);
    sessions.delete(s.session_id);
    s.status = 'closing';
    // Tear down any live screencast first so its CDP session detaches before we close the context.
    try { await stopScreencast(s); } catch { /* best effort */ }
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

  return { start, status, screenshot, input, stop, listSessionIds, startScreencast };
}

module.exports = { createRemoteBrowserManager, DEFAULT_URL };
