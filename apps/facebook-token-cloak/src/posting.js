'use strict';
// Worker-compatible Facebook posting bridge logic for facebook-token-cloak.
//
// This module ports the Graph API orchestration of the retired Electron
// `apps/video-onecard/electron.js` (organic One Card /post, page comment, create-ad)
// but uses PLAIN NODE fetch + the existing CloakBrowser/Playwright logged-in profile to
// resolve a user access token internally. It NEVER imports/runs Electron, never binds
// port 3847, and never targets video-onecard.wwoom.com.
//
// Token discipline: the user/page access tokens resolved here are used ONLY against
// graph.facebook.com. They are never returned to callers, never logged. `/token` and
// `/pages` callers receive booleans / id+name only.

const { FACEBOOK_OAUTH_URL, extractAccessTokenFromUrl, sanitizePages } = require('./facebook');

const GRAPH = 'https://graph.facebook.com';
const GRAPH_V = 'v21.0';
// Ads Manager page used by the in-page extractor fallback. A logged-in Ads Manager session
// exposes window.__accessToken + DTSGInitData — the mechanism the retired Electron app used.
const ADS_MANAGER_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns';

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Format a unix-seconds instant as a Graph-compatible Bangkok ISO 8601 string, e.g.
// "2026-06-16T21:04:36+0700". Graph rejected adset schedules sent as a bare unix timestamp
// (code=100 subcode=1487793 / 1487057); the live-proven accepted form is this offset ISO string.
// Bangkok is UTC+7 with no DST, so shift the epoch by +7h and read the UTC parts.
function toBangkokIso(epochSeconds) {
  const d = new Date((Number(epochSeconds) + 7 * 3600) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0700`;
}

// Runs INSIDE the logged-in browser page (via page.evaluate). Reads the live Ads Manager
// access token and a *boolean* presence of fb_dtsg + a safe numeric user id. It deliberately
// never returns the raw fb_dtsg value — only `fbDtsgPresent` — so no dtsg ever leaves the
// page. Fully self-contained (no closure refs) so it serializes for page.evaluate.
function inPageTokenExtractor() {
  var out = { token: null, fbDtsgPresent: false, userId: null };
  try { if (typeof window !== 'undefined' && window.__accessToken) out.token = String(window.__accessToken); } catch (e) {}
  var html = '';
  try { html = (typeof document !== 'undefined' && document.documentElement) ? document.documentElement.innerHTML : ''; } catch (e) {}
  try {
    if (typeof require === 'function') {
      try { var d = require('DTSGInitData'); if (d && d.token) out.fbDtsgPresent = true; } catch (e) {}
    }
  } catch (e) {}
  try {
    if (!out.token && html) {
      var m = html.match(/"accessToken":"(EAA[^"]+)"/) || html.match(/__accessToken"?\s*[:=]\s*"(EAA[^"]+)"/);
      if (m) out.token = m[1];
    }
    if (!out.fbDtsgPresent && html) {
      out.fbDtsgPresent = /DTSGInitData[\s\S]{0,80}"token":"[^"]+"/.test(html) || /name="fb_dtsg"\s+value="[^"]+"/.test(html);
    }
    if (!out.userId && html) {
      var um = html.match(/"USER_ID":"(\d+)"/) || html.match(/"actorID":"(\d+)"/);
      if (um && um[1] !== '0') out.userId = um[1];
    }
  } catch (e) {}
  return out;
}

// Build a fetch-like Graph client (mirrors the minimal interface gJson() expects:
// { ok, status, json() }) that carries the logged-in session cookies. The AdsManager
// window.__accessToken is only accepted by Graph alongside those cookies; a plain Node fetch
// with the same token fails (OAuthException code=1 Invalid request).
//
// Transport preference:
//   1. context.request (Playwright APIRequestContext) — shares the context cookies and runs
//      OUTSIDE the page, so it is NOT subject to page CORS/preflight. This is the reliable
//      path (page.evaluate(fetch) can fail browser_graph_fetch_failed on Graph CORS), and it
//      mirrors the retired Electron net.request({ useSessionCookies: true }).
//   2. Fallback: in-page page.evaluate(fetch(url, { credentials: 'include' })).
//
// It only ever returns the Graph response body — never the token/cookies.
function makeBrowserGraphFetch(target) {
  const page = target && target.page ? target.page : (target && typeof target.evaluate === 'function' ? target : null);
  const context = target && target.context ? target.context : (target && target.request ? target : null);
  const browserGraphFetch = async function browserGraphFetch(url, init = {}) {
    const method = (init && init.method) || 'GET';
    const headers = (init && init.headers) || null;
    const body = init && init.body != null ? init.body : null;

    const apiRequest = context && context.request;
    if (apiRequest && typeof apiRequest.fetch === 'function') {
      try {
        const opts = { method };
        if (headers) opts.headers = headers;
        if (body != null) opts.data = body;
        const resp = await apiRequest.fetch(String(url), opts);
        const status = typeof resp.status === 'function' ? resp.status() : resp.status;
        const ok = typeof resp.ok === 'function' ? resp.ok() : resp.ok;
        let text = '';
        try { text = await resp.text(); } catch (e) { text = ''; }
        return {
          ok: !!ok,
          status: status || 0,
          json: async () => { try { return JSON.parse(text || '{}'); } catch { return {}; } }
        };
      } catch (e) {
        return { ok: false, status: 0, json: async () => ({ error: { message: 'browser_graph_request_failed' } }) };
      }
    }

    if (!page || typeof page.evaluate !== 'function') {
      return { ok: false, status: 0, json: async () => ({ error: { message: 'browser_context_unavailable' } }) };
    }
    let result;
    try {
      result = await page.evaluate(async (args) => {
        const opts = { method: args.method, credentials: 'include' };
        if (args.headers) opts.headers = args.headers;
        if (args.body != null) opts.body = args.body;
        const resp = await fetch(args.url, opts);
        let text = '';
        try { text = await resp.text(); } catch (e) { text = ''; }
        return { status: resp.status, ok: resp.ok, text: text };
      }, { url: String(url), method: method, headers: headers, body: body });
    } catch (e) {
      return { ok: false, status: 0, json: async () => ({ error: { message: 'browser_graph_fetch_failed' } }) };
    }
    const payload = result || {};
    return {
      ok: !!payload.ok,
      status: payload.status || 0,
      json: async () => { try { return JSON.parse(payload.text || '{}'); } catch { return {}; } }
    };
  };

  return browserGraphFetch;
}

// Close the browser context opened for a request's Graph work. Safe on any shape; swallows
// errors. Call in a `finally` after all Graph calls complete so contexts never leak.
async function closeSession(session) {
  try {
    if (session && session.context && typeof session.context.close === 'function') {
      await session.context.close();
    }
  } catch {}
}

// Resolve a fresh user access token from the persistent CloakBrowser profile. Two paths:
//   1. The Facebook OAuth dialog redirect (same mechanism as /token/refresh).
//   2. FALLBACK — when OAuth yields no token (e.g. a deprecated/invalid client_id returns
//      /oauth/error): reuse the SAME logged-in profile/page, navigate to Ads Manager, and
//      read window.__accessToken + dtsg presence in-page (the retired Electron mechanism).
// Returns the token plus the live browser context. The token is for internal Graph use only;
// callers must never echo it back to clients. Raw fb_dtsg is never extracted (boolean only).
async function resolveSessionToken({ browser, account, visible = false } = {}) {
  if (!browser || typeof browser.openPage !== 'function') {
    return { token: null, reason: 'browser_unavailable', fbDtsgPresent: false, userId: null };
  }
  let opened;
  try {
    opened = await browser.openPage(account, FACEBOOK_OAUTH_URL, { visible: !!visible });
  } catch (e) {
    return { token: null, reason: (e && (e.code || e.message)) || 'browser_open_failed', fbDtsgPresent: false, userId: null };
  }

  let currentUrl = '';
  try { currentUrl = opened.page.url(); } catch {}
  let token = extractAccessTokenFromUrl(currentUrl);
  let source = token ? 'oauth' : null;
  let fbDtsgPresent = false;
  let userId = null;

  if (!token) {
    const page = opened.page;
    try {
      if (page && typeof page.goto === 'function') {
        await page.goto(ADS_MANAGER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      }
      if (page && typeof page.evaluate === 'function') {
        const info = await page.evaluate(inPageTokenExtractor).catch(() => null);
        if (info && typeof info === 'object') {
          if (info.token) { token = String(info.token); source = 'adsmanager'; }
          fbDtsgPresent = !!info.fbDtsgPresent;
          if (info.userId) userId = String(info.userId);
        }
      }
      try { currentUrl = page.url(); } catch {}
    } catch {}
  }

  return {
    token: token || null,
    reason: token ? null : 'token_not_found',
    source,
    fbDtsgPresent,
    userId,
    currentUrl,
    backend: opened.backend,
    profileDir: opened.profileDir,
    context: opened.context,
    page: opened.page,
    // Graph client bound to the logged-in session: prefers context.request (APIRequestContext,
    // cookie-sharing, no page CORS), falls back to in-page fetch(credentials:'include').
    graphFetch: makeBrowserGraphFetch({ page: opened.page, context: opened.context })
  };
}

// Best-effort, token-free liveness probe: a logged-in Facebook session has a `c_user`
// cookie. Used to report `fbDtsg` presence as a boolean without ever reading/returning the
// fb_dtsg value itself. Returns false on any error.
async function hasLoggedInSession(context) {
  try {
    if (!context || typeof context.cookies !== 'function') return false;
    const cookies = await context.cookies('https://www.facebook.com');
    return Array.isArray(cookies) && cookies.some((c) => c && c.name === 'c_user' && c.value);
  } catch {
    return false;
  }
}

// Forward the bad-reused-campaign recovery diagnostics from a buildAdFromCreative result onto the
// reshaped success responses of createAd/promoteOneCardPost (error responses pass adEntities through
// verbatim, but success responses are rebuilt field-by-field and would otherwise drop these). Only
// includes keys that are present, so non-recovery responses are unchanged. Never carries a token.
function pickRecoveryDiag(adEntities = {}) {
  const out = {};
  for (const k of ['recovered_from_bad_reused_campaign', 'bad_reused_campaign_id', 'cleaned_bad_reused_campaign_id', 'bad_reused_campaign_cleanup_error', 'retry_campaign_id']) {
    if (adEntities[k] !== undefined) out[k] = adEntities[k];
  }
  return out;
}

function normalizeGraphId(id) {
  return String(id == null ? '' : id).trim().replace(/^act_/, '');
}

function looksLikeInternalVideoCode(value) {
  const text = String(value == null ? '' : value).trim();
  return /^[a-f0-9]{8,12}$/i.test(text) || (/^[A-Z0-9_-]{6,16}$/i.test(text) && /\d/.test(text) && !/\s/.test(text));
}

function sanitizePublicCardTitle(value) {
  const text = String(value == null ? '' : value).trim().slice(0, 120);
  return looksLikeInternalVideoCode(text) ? '' : text;
}

async function gJson(fetchImpl, url, opts) {
  const res = await fetchImpl(url, opts);
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, ok: res.ok, data: data || {} };
}

const crypto = require('crypto');

// Ceiling for the locally-downloaded video buffer (the PRIMARY upload path). Current OneCard videos
// are ~5–30MB; 200MB is a generous guard so a runaway/wrong URL can never load gigabytes into the
// bridge process. Exceeding it makes the download throw, which routes to the file_url fallback
// (see uploadAdVideoFromUrl) — Meta fetches the URL itself rather than the bridge buffering it.
const MAX_DOWNLOAD_VIDEO_BYTES = 200 * 1024 * 1024;

// Download a video URL into a Buffer for the multipart upload. The asset URL is a PUBLIC Worker
// asset (no auth), so a plain fetch is used — NEVER the cookie-bearing Graph transport, and no
// token is involved. Guards: an AbortController timeout and a hard byte ceiling (checked against
// content-length up front AND the materialized buffer) so a wrong/huge URL fails closed instead of
// exhausting memory. Returns { buffer, contentType }; throws a clear non-secret Error otherwise.
async function downloadVideoToBuffer(videoUrl, { fetchImpl, maxBytes = MAX_DOWNLOAD_VIDEO_BYTES, timeoutMs = 120000 } = {}) {
  const doFetch = fetchImpl || global.fetch;
  if (typeof doFetch !== 'function') throw new Error('video_download_fetch_unavailable');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0 ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;
  try {
    const resp = await doFetch(String(videoUrl), controller ? { signal: controller.signal } : {});
    const status = typeof resp.status === 'number' ? resp.status : 0;
    const ok = typeof resp.ok === 'boolean' ? resp.ok : (status >= 200 && status < 300);
    if (!ok) throw new Error(`video_download_http_${status || 'error'}`);
    const headerGet = resp.headers && typeof resp.headers.get === 'function' ? (k) => resp.headers.get(k) : () => null;
    const declared = Number(headerGet('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`video_too_large_${declared}_bytes_max_${maxBytes}`);
    }
    let buffer;
    if (typeof resp.arrayBuffer === 'function') {
      const ab = await resp.arrayBuffer();
      buffer = Buffer.from(ab);
    } else if (typeof resp.body === 'function') {
      buffer = Buffer.from(await resp.body());
    } else {
      throw new Error('video_download_body_unavailable');
    }
    if (buffer.length === 0) throw new Error('video_download_empty');
    if (buffer.length > maxBytes) throw new Error(`video_too_large_${buffer.length}_bytes_max_${maxBytes}`);
    const ctRaw = String(headerGet('content-type') || '').split(';')[0].trim();
    return { buffer, contentType: ctRaw || 'video/mp4' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Build a multipart/form-data body (as a Buffer) carrying the video bytes under `source`, the field
// Graph advideos expects for a direct file upload. Uses Node built-ins only; the boundary is random
// so it can never collide with the binary payload. Returns { body, contentType }.
function buildVideoMultipart({ buffer, filename = 'video.mp4', contentType = 'video/mp4', fieldName = 'source', fields = {} }) {
  const boundary = '----fbTokenCloak' + crypto.randomBytes(16).toString('hex');
  const fieldParts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    const cleanName = String(name || '').replace(/"/g, '');
    if (!cleanName) continue;
    const cleanValue = String(value == null ? '' : value);
    fieldParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${cleanName}"\r\n\r\n` +
      `${cleanValue}\r\n`,
      'utf8'
    ));
  }
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([...fieldParts, head, buffer, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Upload a video to {adAccount}/advideos as a multipart file (the PRIMARY transport). access_token
// stays in the URL query (never in the multipart body), so the token discipline is unchanged — the
// body carries only the video bytes. Goes through the SAME Graph transport (fetchImpl) as every other
// call so the logged-in session cookies are carried. Returns the parsed Graph response data.
async function uploadAdVideoMultipart(fetchImpl, { adAccount, userToken, buffer, contentType = 'video/mp4', filename = 'video.mp4' }) {
  const part = buildVideoMultipart({ buffer, filename, contentType });
  const res = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/advideos?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': part.contentType },
    body: part.body
  });
  return res.data || {};
}

// Upload a video to {adAccount}/advideos. PRIMARY path is a DIRECT multipart file upload: the bridge
// downloads the video bytes itself, then POSTs them as multipart/form-data. This never depends on Meta
// being able to fetch our (Worker public asset) URL — the live-incident failure mode where Graph
// returns "Unable to fetch video file from URL." for a Cheiab/OneCard publish. The reliable path is
// therefore Meta-fetch-free.
//
// FALLBACK — file_url: used ONLY when the LOCAL download cannot proceed (a download/fetch failure or
// the byte-ceiling guard tripping). In that single case we let Meta fetch the URL itself as a last
// resort so a transient bridge-side problem (or an oversized video) still has a chance to publish.
// A Graph ERROR from the multipart upload (validation/permission/etc.) is returned AS-IS and never
// triggers a file_url retry — so a real error is never hidden behind a fallback loop.
//
// Returns { data, uploadMode } where uploadMode is one of:
//   'multipart'         — primary direct multipart upload (success, or a real Graph error returned as-is)
//   'file_url_fallback' — the local download could not proceed; fell back to letting Meta fetch the URL
// No token/secret is ever logged or returned.
async function uploadAdVideoFromUrl(fetchImpl, {
  adAccount,
  userToken,
  videoUrl,
  download = downloadVideoToBuffer,
  maxBytes = MAX_DOWNLOAD_VIDEO_BYTES,
  downloadTimeoutMs = 120000
} = {}) {
  // PRIMARY: download the bytes and upload them directly as multipart so Meta never fetches our URL.
  let dl;
  try {
    dl = await download(videoUrl, { maxBytes, timeoutMs: downloadTimeoutMs });
  } catch (e) {
    // The bridge could not download the file (network/fetch failure or the byte ceiling tripped).
    // Last resort: let Meta fetch the file_url itself. The download reason is surfaced (non-secret)
    // on any file_url error so the failure stays diagnosable.
    const downloadReason = (e && e.message) || String(e);
    const fb = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/advideos?access_token=${encodeURIComponent(userToken)}&file_url=${encodeURIComponent(videoUrl)}`, { method: 'POST' });
    const fbData = fb.data || {};
    if (fbData.error) {
      const err = fbData.error;
      return {
        data: { error: { message: `${err.message} (multipart_download_unavailable: ${downloadReason})`, code: err.code, error_subcode: err.error_subcode, fbtrace_id: err.fbtrace_id } },
        uploadMode: 'file_url_fallback'
      };
    }
    return { data: fbData, uploadMode: 'file_url_fallback' };
  }
  const data = await uploadAdVideoMultipart(fetchImpl, { adAccount, userToken, buffer: dl.buffer, contentType: dl.contentType });
  return { data, uploadMode: 'multipart' };
}

async function uploadAdImageFromUrl(fetchImpl, {
  adAccount,
  userToken,
  imageUrl,
  download = downloadVideoToBuffer,
  maxBytes = 10 * 1024 * 1024,
  downloadTimeoutMs = 60000,
  fetchForDownload = null
} = {}) {
  if (!imageUrl) return { data: { error: { message: 'image_url_missing' } }, uploadMode: 'missing' };
  let dl;
  try {
    dl = await download(imageUrl, { maxBytes, timeoutMs: downloadTimeoutMs, ...(fetchForDownload ? { fetchImpl: fetchForDownload } : {}) });
  } catch (e) {
    return { data: { error: { message: `image_download_failed: ${(e && e.message) || String(e)}` } }, uploadMode: 'download_failed' };
  }
  const part = buildVideoMultipart({
    buffer: dl.buffer,
    filename: 'thumbnail.jpg',
    contentType: dl.contentType || 'image/jpeg',
    fieldName: 'filename'
  });
  const res = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adimages?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': part.contentType },
    body: part.body
  });
  return { data: res.data || {}, uploadMode: 'multipart' };
}

function firstAdImageHash(data) {
  const images = data && data.images;
  if (!images || typeof images !== 'object') return '';
  for (const item of Object.values(images)) {
    const hash = item && item.hash ? String(item.hash) : '';
    if (hash) return hash;
  }
  return '';
}

// Publish a NEW Page video post directly through the Page video endpoint, not through an adcreative.
// This is the Create Ads Phase A path: old high-view posts are signals only; the bridge first creates
// a fresh Page story from the system video, then the Worker mints the final post-specific shortlink
// and calls /promote with use_object_story_id so the paid ad sponsors this same story. No token is
// returned or logged.
async function publishPageVideoPost(fetchImpl, params = {}) {
  const userToken = params.userToken;
  const pageId = String(params.pageId || params.page_id || '').trim();
  const videoUrl = String(params.videoUrl || params.video_url || '').trim();
  const caption = String(params.caption || params.message || '').trim();
  const title = sanitizePublicCardTitle(params.title || params.adName || params.ad_name || '');
  const sleep = params.sleep || realSleep;
  const pollMs = Number.isInteger(params.pollMs) ? params.pollMs : 3000;
  const thumbPolls = Number.isInteger(params.thumbPolls) ? params.thumbPolls : 40;

  if (!userToken) return { ok: false, phase: 'post', step: 'session', error: 'no_session' };
  if (!pageId || !videoUrl) return { ok: false, phase: 'post', step: 'validate', error: 'Missing: page_id, video_url' };

  const pageTokenInfo = await resolvePageToken(fetchImpl, userToken, pageId);
  if (!pageTokenInfo.pageToken) {
    return { ok: false, phase: 'post', step: 'page_token', error: pageTokenInfo.error || 'page_token_not_found', page_id: pageId };
  }
  const pageToken = pageTokenInfo.pageToken;

  let uploadMode = 'page_video_multipart';
  let upData = {};
  try {
    const dl = await (params.downloadVideo || downloadVideoToBuffer)(videoUrl, {
      maxBytes: MAX_DOWNLOAD_VIDEO_BYTES,
      timeoutMs: 120000
    });
    const part = buildVideoMultipart({
      buffer: dl.buffer,
      filename: 'page-video.mp4',
      contentType: dl.contentType,
      fieldName: 'source',
      fields: {
        published: 'true',
        description: caption,
        ...(title ? { title } : {})
      }
    });
    const up = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${pageId}/videos?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': part.contentType },
      body: part.body
    });
    upData = up.data || {};
  } catch (e) {
    uploadMode = 'page_video_file_url_fallback';
    const downloadReason = (e && e.message) || String(e);
    const up = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${pageId}/videos?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_url: videoUrl,
        published: true,
        description: caption,
        ...(title ? { title } : {})
      })
    });
    upData = up.data || {};
    if (upData.error && upData.error.message) {
      upData = {
        error: {
          message: `${upData.error.message} (multipart_download_unavailable: ${downloadReason})`,
          code: upData.error.code,
          error_subcode: upData.error.error_subcode,
          fbtrace_id: upData.error.fbtrace_id
        }
      };
    }
  }

  if (upData.error) {
    return {
      ok: false,
      phase: 'post',
      step: 'publish_video',
      error: upData.error.message || 'page_video_publish_failed',
      fb_error_code: upData.error.code,
      fb_error_subcode: upData.error.error_subcode,
      fb_trace_id: upData.error.fbtrace_id,
      upload_mode: uploadMode
    };
  }

  const videoId = String(upData.id || upData.video_id || '').trim();
  if (!videoId) {
    return { ok: false, phase: 'post', step: 'publish_video', error: 'page_video_id_missing', upload_mode: uploadMode };
  }

  let storyId = String(upData.post_id || upData.postId || upData.story_id || '').trim();
  let postUrl = '';
  let thumb = '';
  let storyIdSource = storyId ? 'upload_response' : '';
  for (let i = 0; i < Math.max(1, thumbPolls); i++) {
    if (i > 0) await sleep(pollMs);
    try {
      const read = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(videoId)}?fields=post_id,permalink_url,thumbnails&access_token=${encodeURIComponent(pageToken)}`);
      const d = read.data || {};
      if (!storyId && d.post_id) {
        storyId = String(d.post_id).trim();
        storyIdSource = 'video_readback';
      }
      if (!postUrl) postUrl = String(d.permalink_url || '').trim();
      const thumbs = d.thumbnails && d.thumbnails.data;
      if (!thumb && Array.isArray(thumbs) && thumbs[0] && thumbs[0].uri) thumb = String(thumbs[0].uri).trim();
      if (storyId) break;
    } catch {}
  }

  if (!storyId) {
    storyId = `${pageId}_${videoId}`;
    storyIdSource = 'page_video_id_fallback';
  }
  if (!postUrl) postUrl = `https://www.facebook.com/${String(storyId).replace('_', '/posts/')}`;

  return {
    ok: true,
    phase: 'post',
    story_id: storyId,
    video_id: videoId,
    post_url: postUrl,
    thumbnail_url: thumb || undefined,
    published_to_page: true,
    upload_mode: uploadMode,
    story_id_source: storyIdSource
  };
}

// GET /pages — list the pages the session administers, id/name/category only. Page access
// tokens are stripped (sanitizePages with includeToken=false). Shape: { data: [...] } to
// match the Worker's `pagesData.data` authorization check.
async function listPagesPublic(fetchImpl, userToken) {
  const url = `${GRAPH}/me/accounts?fields=access_token,id,name,category&limit=200&access_token=${encodeURIComponent(userToken)}`;
  const { data } = await gJson(fetchImpl, url);
  if (data && data.error) {
    return { data: [], error: (data.error && data.error.message) || 'me_accounts_failed' };
  }
  const pages = sanitizePages(data.data || [], false); // false => never includes access_token
  return { data: pages, pagesCount: pages.length };
}

// Resolve the PAGE access token for a page_id via the session user token. Returns the page
// token for INTERNAL Graph use only (never surfaced to clients) plus the page name. Fails
// closed: `found:false` / empty pageToken when the session does not administer the page.
async function resolvePageToken(fetchImpl, userToken, pageId) {
  const url = `${GRAPH}/me/accounts?fields=access_token,id,name&limit=200&access_token=${encodeURIComponent(userToken)}`;
  const { data } = await gJson(fetchImpl, url);
  if (data && data.error) {
    return { error: (data.error && data.error.message) || 'me_accounts_failed' };
  }
  const page = (data.data || []).find((pg) => String(pg.id) === String(pageId));
  return {
    found: !!page,
    pageToken: page && page.access_token ? page.access_token : '',
    pageName: page && page.name ? String(page.name) : ''
  };
}

// POST /post — organic One Card page video post. Ports electron.js /post:
// upload advideo → poll thumbnail → adcreative(object_story_spec) → poll story id →
// publish to page (is_published). Returns { ok, story_id, video_id, post_url } or a
// step-tagged error. Uses page token to publish (fails open to user token only for publish,
// matching electron behavior). No token is ever returned.
async function postOneCardVideo(fetchImpl, params = {}) {
  const sleep = params.sleep || realSleep;
  const userToken = params.userToken;
  const adAccount = String(params.adAccount || '').trim();
  const pageId = String(params.pageId || '').trim();
  const videoUrl = String(params.videoUrl || '').trim();
  const message = String(params.message || '');
  const title = String(params.title || '');
  const description = String(params.description || '');
  const websiteUrl = String(params.websiteUrl || '').trim();
  const cta = params.cta === 'NO_BUTTON' ? 'NO_BUTTON' : 'SHOP_NOW';
  const thumbPolls = Number.isInteger(params.thumbPolls) ? params.thumbPolls : 60;
  const storyPolls = Number.isInteger(params.storyPolls) ? params.storyPolls : 20;
  const pollMs = Number.isInteger(params.pollMs) ? params.pollMs : 3000;

  if (!adAccount || !pageId || !videoUrl) {
    return { ok: false, step: 'validate', error: 'Missing: ad_account, page_id, video_url' };
  }

  // 1. Upload video to the ad account. Direct multipart upload first (the bridge downloads the bytes
  // so Meta never has to fetch our URL); file_url is only a fallback (see uploadAdVideoFromUrl).
  const up = await uploadAdVideoFromUrl(fetchImpl, { adAccount, userToken, videoUrl, download: params.downloadVideo });
  const v = up.data;
  if (v.error) return { ok: false, step: 'upload_video', error: v.error.message, upload_mode: up.uploadMode };
  const videoId = v.id;

  // 2. Wait for a thumbnail.
  let thumbUrl = null;
  for (let i = 0; i < thumbPolls; i++) {
    await sleep(pollMs);
    const s = await gJson(fetchImpl, `${GRAPH}/${videoId}?access_token=${encodeURIComponent(userToken)}&fields=thumbnails`);
    const sd = s.data;
    if (sd.thumbnails && sd.thumbnails.data && sd.thumbnails.data.length >= 1) { thumbUrl = sd.thumbnails.data[0].uri; break; }
  }
  if (!thumbUrl) return { ok: false, step: 'thumbnails', error: 'Timeout' };

  // 3. Create adcreative (dark post via object_story_spec).
  const videoData = { video_id: videoId, image_url: thumbUrl, message: message || '' };
  if (title) videoData.title = title;
  if (description) videoData.link_description = description;
  if (cta !== 'NO_BUTTON' && websiteUrl) videoData.call_to_action = { type: cta, value: { link: websiteUrl } };
  const crBody = JSON.stringify({ object_story_spec: { page_id: pageId, video_data: videoData } });
  const cr = await gJson(fetchImpl, `${GRAPH}/v16.0/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}&fields=effective_object_story_id,object_story_id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: crBody
  });
  const c = cr.data;
  if (c.error) return { ok: false, step: 'adcreative', error: c.error.message };

  // 4. Poll for the story id.
  let storyId = c.effective_object_story_id || c.object_story_id || null;
  for (let i = 0; !storyId && i < storyPolls; i++) {
    await sleep(pollMs);
    const p4 = await gJson(fetchImpl, `${GRAPH}/${c.id}?access_token=${encodeURIComponent(userToken)}&fields=effective_object_story_id,object_story_id`);
    const d4 = p4.data;
    if (d4.error) return { ok: false, step: 'story_id', error: d4.error.message, adcreative_id: c.id };
    if (d4.effective_object_story_id || d4.object_story_id) { storyId = d4.effective_object_story_id || d4.object_story_id; break; }
  }
  if (!storyId) return { ok: false, step: 'story_id', error: 'Timeout', adcreative_id: c.id, video_id: videoId };

  // 5. Publish to the page feed using the PAGE token.
  const pageTokenInfo = await resolvePageToken(fetchImpl, userToken, pageId);
  const publishToken = pageTokenInfo.pageToken || userToken;
  const pub = await gJson(fetchImpl, `${GRAPH}/v16.0/${storyId}?access_token=${encodeURIComponent(publishToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_published: true })
  });
  const pubR = pub.data;
  if (pubR.error && pubR.error.code !== 1) return { ok: false, step: 'publish', error: pubR.error.message };

  return { ok: true, story_id: storyId, video_id: videoId, post_url: `https://www.facebook.com/${String(storyId).replace('_', '/posts/')}` };
}

// POST /page-comment — comment AS THE PAGE only. Resolves the page token internally and
// fails closed (page_token_not_found) when the session does not administer the page —
// NEVER falls back to the session user token (would author the comment as the user).
async function pageComment(fetchImpl, params = {}) {
  const userToken = params.userToken;
  const pageId = String(params.pageId || '').trim();
  const target = String(params.target || params.storyId || params.postId || '').trim();
  const message = String(params.message || '').trim();
  if (!pageId || !target || !message) {
    return { ok: false, status: 400, step: 'validate', error: 'Missing: page_id, story_id (or post_id), message' };
  }
  if (!userToken) {
    return { ok: false, status: 409, step: 'session', error: 'no_session' };
  }
  const info = await resolvePageToken(fetchImpl, userToken, pageId);
  if (info.error) {
    return { ok: false, status: 200, step: 'pages', error: info.error, page_id: pageId };
  }
  // Fail closed: no page token → do NOT comment as the user.
  if (!info.pageToken) {
    return { ok: false, status: 403, step: 'page_token', error: 'page_token_not_found', page_id: pageId };
  }
  const cm = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(target)}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, access_token: info.pageToken })
  });
  const data = cm.data;
  if (data.error || !data.id) {
    return { ok: false, status: 200, step: 'comment', error: (data.error && data.error.message) || 'comment_failed', page_id: pageId };
  }
  return { ok: true, status: 200, id: String(data.id), page_id: pageId, page_name: info.pageName, author_expected: 'page' };
}

// POST /edit-page-comment-link — EDIT (never create) the Shopee link inside an EXISTING Page-owned
// comment. The ad-only flow re-mints the post-specific shortlink AFTER the Page comment is dropped,
// so the live comment can still carry the OLD campaign link while the visible CTA was already
// repaired by /update-cta. This edits the SAME comment in place using the official Graph edit
// (POST /{comment_id} { message }), so no duplicate comment is ever created and nothing is deleted.
//
// Discovery order is strict: read comments on the FULL Page story first; only if NO matching
// Page-owned comment is found there do we read the alternate_targets (e.g. the visible Reel target)
// as additional READ candidates. A comment is only ever EDITED on the id that was actually read back
// from one of those reads — we never POST to /{target}/comments (that would CREATE).
//
// Fails closed: the matched comment must be authored by the page (from.id == page_id); a comment
// from any other author is never edited. allow_create_new is accepted but intentionally NOT honored
// here — when true the call returns ok:false / create_new_not_supported and creates nothing. The
// page token is used only against Graph and is never returned/logged.
async function editPageCommentLink(fetchImpl, params = {}) {
  const userToken = params.userToken;
  const pageId = String(params.pageId || params.page_id || '').trim();
  const storyId = String(params.storyId || params.story_id || params.postId || params.post_id || '').trim();
  const oldLink = String(params.oldLink || params.old_link || '').trim();
  const newLink = String(params.newLink || params.new_link || '').trim();
  const allowCreateNew = params.allowCreateNew === true || params.allow_create_new === true;
  // Alternate READ candidates (visible Reel target / bare post id). Never written to unless the
  // matching comment id was actually read back from that candidate.
  const altRaw = Array.isArray(params.alternateTargets) ? params.alternateTargets
    : (Array.isArray(params.alternate_targets) ? params.alternate_targets : []);
  const alternateTargets = altRaw.map((t) => String(t || '').trim()).filter(Boolean);

  // Validation: required ids/links, http(s) links only.
  if (!pageId || !storyId) return { ok: false, step: 'validate', error: 'Missing: page_id, story_id' };
  if (!oldLink || !newLink) return { ok: false, step: 'validate', error: 'Missing: old_link, new_link' };
  if (!/^https?:\/\//i.test(oldLink) || !/^https?:\/\//i.test(newLink)) {
    return { ok: false, step: 'validate', error: 'old_link/new_link must be http(s) URLs' };
  }
  // This endpoint is EDIT-ONLY. allow_create_new is never honored here — fail closed and create
  // nothing rather than silently creating a duplicate comment.
  if (allowCreateNew) {
    return { ok: false, status: 400, step: 'validate', error: 'create_new_not_supported', page_id: pageId, story_id: storyId };
  }
  if (!userToken) return { ok: false, status: 409, step: 'session', error: 'no_session' };

  // Editing a Page-owned comment requires the PAGE token. Fail closed when the session does not
  // administer the page — never fall back to the user token.
  const info = await resolvePageToken(fetchImpl, userToken, pageId);
  if (info.error) return { ok: false, status: 200, step: 'pages', error: info.error, page_id: pageId };
  if (!info.pageToken) return { ok: false, status: 403, step: 'page_token', error: 'page_token_not_found', page_id: pageId };
  const pageToken = info.pageToken;

  // READ comments on one target and return the first Page-owned comment whose message carries the
  // old link. READ ONLY — a GET on /{target}/comments. Returns { match } or {} (never throws).
  const readMatchOnTarget = async (target) => {
    try {
      const r = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(target)}/comments?fields=id,message,from,created_time,permalink_url&limit=200&access_token=${encodeURIComponent(pageToken)}`);
      if (!r.data || r.data.error) return {};
      const list = Array.isArray(r.data.data) ? r.data.data : [];
      const match = list.find((c) => c
        && c.from && String(c.from.id) === String(pageId)
        && typeof c.message === 'string' && c.message.includes(oldLink));
      return match ? { match } : {};
    } catch {
      return {};
    }
  };

  // 1. Read the FULL story first; only fall back to alternate_targets if it yields no match.
  let matched = null;
  let targetUsed = '';
  const storyRead = await readMatchOnTarget(storyId);
  if (storyRead.match) { matched = storyRead.match; targetUsed = storyId; }
  if (!matched) {
    for (const alt of alternateTargets) {
      if (String(alt) === String(storyId)) continue; // already read
      const altRead = await readMatchOnTarget(alt);
      if (altRead.match) { matched = altRead.match; targetUsed = alt; break; }
    }
  }

  if (!matched || !matched.id) {
    return { ok: false, status: 200, step: 'find_comment', error: 'matching_comment_not_found', page_id: pageId, story_id: storyId };
  }
  // Defense in depth: never edit a comment that is not authored by the page.
  if (!matched.from || String(matched.from.id) !== String(pageId)) {
    return { ok: false, status: 403, step: 'author_check', error: 'comment_not_authored_by_page', page_id: pageId, story_id: storyId, comment_id: String(matched.id) };
  }

  const commentId = String(matched.id);
  const originalMessage = typeof matched.message === 'string' ? matched.message : '';
  // Replace EVERY occurrence of the old link with the new link, in place (the rest of the comment
  // text — emoji, label, sub ids — is preserved verbatim).
  const replacedMessage = originalMessage.split(oldLink).join(newLink);

  // 2. EDIT the same comment id (official Graph edit — POST /{comment_id} { message }). This never
  //    creates a new comment. The access_token rides in the JSON body, matching pageComment.
  const upd = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(commentId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: replacedMessage, access_token: pageToken })
  });
  if (upd.data && upd.data.error) {
    return {
      ok: false, status: 200, step: 'edit', error: String(upd.data.error.message || 'comment_edit_failed').substring(0, 200),
      fb_error_code: upd.data.error.code, fb_error_subcode: upd.data.error.error_subcode, fb_trace_id: upd.data.error.fbtrace_id,
      page_id: pageId, story_id: storyId, comment_id: commentId, target_used: targetUsed
    };
  }

  // 3. Verify via a DIRECT readback of the SAME comment id: the new link is present, the old link is
  //    gone, and the comment is still authored by the page.
  let confirmedMessage = '';
  let authorPageVerified = false;
  let permalinkUrl = matched.permalink_url ? String(matched.permalink_url) : '';
  try {
    const rb = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(commentId)}?fields=id,message,from,permalink_url&access_token=${encodeURIComponent(pageToken)}`);
    if (rb.data && !rb.data.error) {
      confirmedMessage = typeof rb.data.message === 'string' ? rb.data.message : '';
      authorPageVerified = !!(rb.data.from && String(rb.data.from.id) === String(pageId));
      if (rb.data.permalink_url) permalinkUrl = String(rb.data.permalink_url);
    }
  } catch {}

  const newLinkPresent = confirmedMessage.includes(newLink);
  const oldLinkGone = !confirmedMessage.includes(oldLink);
  const verified = newLinkPresent && oldLinkGone && authorPageVerified;
  const firstLine = confirmedMessage.split('\n')[0] || '';

  return {
    ok: verified,
    status: 200,
    phase: 'edit_page_comment_link',
    page_id: pageId,
    story_id: storyId,
    target_used: targetUsed,
    comment_id: commentId,
    old_link_gone: oldLinkGone,
    new_link_present: newLinkPresent,
    author_page_verified: authorPageVerified,
    final_message_first_line: firstLine,
    ...(permalinkUrl ? { permalink_url: permalinkUrl } : {}),
    ...(verified ? {} : { step: 'verify', error: 'comment_edit_unverified' })
  };
}

// Token-free readback that a story is ACTUALLY on the page feed: a published page post reports
// is_published:true (and exposes a permalink_url). Used to CONFIRM a publish whose POST returned a
// Graph error (a "transient" error like code 1 / "please reduce the amount of data" sometimes still
// publishes, but must never be ASSUMED to have — that assumption is exactly how a post that never
// appeared got recorded as a success). Returns { published, permalinkUrl }; published is false on
// any error/ambiguity so we fail closed. The page token is used only against Graph, never returned.
async function readbackStoryPublished(fetchImpl, { pageToken, storyId }) {
  try {
    const rb = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(storyId)}?fields=is_published,permalink_url&access_token=${encodeURIComponent(pageToken)}`);
    if (!rb || !rb.data || rb.data.error) return { published: false, permalinkUrl: '' };
    const permalinkUrl = rb.data.permalink_url ? String(rb.data.permalink_url) : '';
    return { published: rb.data.is_published === true, permalinkUrl };
  } catch {
    return { published: false, permalinkUrl: '' };
  }
}

// Facebook returns misleading GENERIC messages for momentary backend hiccups on the page-publish
// POST — most prominently code 1 / "Please reduce the amount of data you're asking for, then retry
// your request" — and the SAME request commonly succeeds seconds later (the Worker classifies these
// identically in isTransientFacebookPublishError, with live FAIL→SUCCESS-on-retry history). So an
// errored publish is RETRIED (not abandoned) before we fail closed.
function isRetryablePublishError(error) {
  const code = Number(error && error.code);
  const message = String((error && error.message) || '').toLowerCase();
  if (
    message.includes('please reduce the amount of data') ||
    message.includes('please try again') ||
    message.includes('temporarily unavailable') ||
    message.includes('an unknown error occurred') ||
    message.includes('service temporarily unavailable')
  ) return true;
  // Meta's generic OAuthException (code 1) on this publish endpoint is the live-observed transient
  // shape; it is retryable (a HARD error like permission/code 200/190 is not, and fails closed).
  return code === 1;
}

// Publish a dark story (effective_object_story_id) to the page feed using the PAGE token.
// Shared by createAd (step 8.5) and the post-first skip_ad early return. Fails soft:
// returns { publishedToPage:false, publishError } rather than throwing, and never uses the
// user token to publish (page token only, resolved internally).
//
// A Graph ERROR on the publish POST is NEVER trusted as success on its own. Previously code 1 /
// "please reduce the amount of data" was treated as published, which let the visible-post-missing
// incident be recorded as a success. Now the publish is RETRIED on transient errors, and is only
// reported as published when a token-free is_published readback CONFIRMS the post is actually on the
// page feed; otherwise it fails closed with publishedToPage:false and an actionable publish_error.
//
// `pollMs` scales the retry backoff (0 in tests → no real waiting). `publishAttempts` is the total
// number of publish POSTs to make (default 4: immediate + 3 retries).
async function publishStoryToPage(fetchImpl, { userToken, pageId, storyId, sleep = realSleep, pollMs = 3000, publishAttempts = 4 } = {}) {
  try {
    const info = await resolvePageToken(fetchImpl, userToken, pageId);
    if (!info.pageToken) return { publishedToPage: false, publishError: 'page_token_not_found' };
    const pageToken = info.pageToken;
    const baseDelay = Number.isFinite(pollMs) && pollMs >= 0 ? pollMs : 3000;
    const totalAttempts = Number.isInteger(publishAttempts) && publishAttempts > 0 ? publishAttempts : 4;

    const publishOnce = () => gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${storyId}?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_published: true })
    });

    let lastPublishError = '';
    let lastError = null;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (attempt > 1) await sleep(baseDelay * (attempt - 1)); // escalating backoff: 0, base, 2*base, ...
      attemptsMade = attempt;
      const pub = await publishOnce();
      if (!(pub.data && pub.data.error)) {
        return { publishedToPage: true, publishError: '', publishAttempts: attemptsMade };
      }
      lastError = pub.data.error;
      lastPublishError = String(pub.data.error.message || '').substring(0, 200);
      // A transient error MAY have still published — confirm via readback before deciding.
      const rb = await readbackStoryPublished(fetchImpl, { pageToken, storyId });
      if (rb.published) {
        return {
          publishedToPage: true, publishError: lastPublishError, publishAttempts: attemptsMade,
          publishWarning: 'publish_story_error_but_readback_confirmed_published',
          ...(rb.permalinkUrl ? { permalink_url: rb.permalinkUrl } : {})
        };
      }
      // A HARD (non-transient) error will not clear on retry — fail closed immediately.
      if (!isRetryablePublishError(pub.data.error)) {
        return { publishedToPage: false, publishError: lastPublishError, publishAttempts: attemptsMade };
      }
    }

    // Retries exhausted. One last readback in case a late-arriving publish landed after the final POST.
    const finalRb = await readbackStoryPublished(fetchImpl, { pageToken, storyId });
    if (finalRb.published) {
      return {
        publishedToPage: true, publishError: lastPublishError, publishAttempts: attemptsMade,
        publishWarning: 'publish_story_error_but_readback_confirmed_published',
        ...(finalRb.permalinkUrl ? { permalink_url: finalRb.permalinkUrl } : {})
      };
    }
    return {
      publishedToPage: false,
      publishError: lastPublishError || (lastError && String(lastError.message || '')) || 'publish_failed',
      publishAttempts: attemptsMade,
      publishExhaustedRetries: true
    };
  } catch (e) {
    return { publishedToPage: false, publishError: (e && e.message) || String(e) };
  }
}

// Template CAMPAIGN-level fields safe to MIRROR onto a freshly created campaign. Kept small and
// known-creatable so Graph never rejects an immutable/invalid field (req: do not include fields
// that would make Graph reject). Only fields actually present on the template are forwarded.
const TEMPLATE_CAMPAIGN_MIRROR_FIELDS = ['smart_promotion_type'];
// Template AD SET fields carrying the customer-lifecycle / customer-acquisition strategy
// ("Reach new and existing customers" vs "Acquire new customers only"). Per Meta's Marketing API
// this lives on the AD SET (existing_customer_budget_percentage), NOT the campaign — so a fresh
// daily campaign cannot carry it; it must be re-applied to the COPIED adset. deep_copy:false copies
// the adset shell but was live-observed to drop this strategy, so we re-apply it explicitly.
const TEMPLATE_ADSET_LIFECYCLE_FIELDS = ['existing_customer_budget_percentage'];
// Additional template adset fields READ for diagnostics only (not re-applied — they are not safely
// settable via a plain adset POST). Surfaced under copied_template_settings for live verification.
const TEMPLATE_ADSET_DIAGNOSTIC_FIELDS = ['targeting_optimization_types'];

// Read the template's objective + the customer-lifecycle / campaign-level settings in ONE Graph
// GET on the template adset (campaign{...} is an edge expansion). Returns safe defaults on any
// failure so the ads flow still runs. The returned settings maps contain ONLY fields that are
// present (non-null/non-empty) on the template, so callers can spread them unconditionally.
async function readTemplateSettings(fetchImpl, { userToken, templateAdset }) {
  const out = { objective: 'OUTCOME_ENGAGEMENT', campaignId: '', campaignSettings: {}, adsetSettings: {}, adsetDiagnostics: {} };
  try {
    const adsetFields = [...TEMPLATE_ADSET_LIFECYCLE_FIELDS, ...TEMPLATE_ADSET_DIAGNOSTIC_FIELDS].join(',');
    const campaignFields = ['id', 'objective', ...TEMPLATE_CAMPAIGN_MIRROR_FIELDS].join(',');
    const res = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${templateAdset}?fields=${adsetFields},campaign{${campaignFields}}&access_token=${encodeURIComponent(userToken)}`);
    const d = (res && res.data) || {};
    const camp = d.campaign || {};
    if (camp.objective && typeof camp.objective === 'string') out.objective = camp.objective;
    if (camp.id) out.campaignId = String(camp.id);
    for (const f of TEMPLATE_CAMPAIGN_MIRROR_FIELDS) {
      if (camp[f] !== undefined && camp[f] !== null && camp[f] !== '') out.campaignSettings[f] = camp[f];
    }
    for (const f of TEMPLATE_ADSET_LIFECYCLE_FIELDS) {
      if (d[f] !== undefined && d[f] !== null && d[f] !== '') out.adsetSettings[f] = d[f];
    }
    for (const f of TEMPLATE_ADSET_DIAGNOSTIC_FIELDS) {
      if (d[f] !== undefined && d[f] !== null && d[f] !== '') out.adsetDiagnostics[f] = d[f];
    }
  } catch {}
  return out;
}

// Steps 5–8 of the ads flow: resolve/create a campaign, copy the template adset shell into
// it, create the ad referencing `creativeId`, then rename + activate the adset/ad and clean
// up deep_copy straggler ads. Shared by createAd and promoteOneCardPost so the two flows
// cannot diverge. Returns { ok:true, campaign_id, adset_id, ad_id } or a step-tagged
// { ok:false, ... } error (extraErrorFields are merged into the 'ad' error for caller context).
//
// Template parity: the new campaign mirrors the template campaign's safe lifecycle/strategy fields
// (TEMPLATE_CAMPAIGN_MIRROR_FIELDS), and the COPIED adset re-applies the template's customer-
// lifecycle strategy (TEMPLATE_ADSET_LIFECYCLE_FIELDS). Both are best-effort and reported under
// `copied_template_settings` (+ `template_campaign_id`) so Hermes can live-verify.
async function buildAdFromCreative(fetchImpl, params = {}) {
  const sleep = params.sleep || realSleep;
  const userToken = params.userToken;
  const adAccount = String(params.adAccount || '').trim();
  const templateAdset = String(params.templateAdset || '').trim();
  const creativeId = params.creativeId;
  const storyId = params.storyId;
  const adName = params.adName;
  const body = params.body || {};
  const pollMs = Number.isInteger(params.pollMs) ? params.pollMs : 3000;
  const extraErrorFields = params.extraErrorFields || {};
  const now = Number.isFinite(params.now) ? params.now : Date.now();
  // Ad-only / non-spending path. When true, the copied adset (already created status_option:'PAUSED')
  // and the ad (created status:'PAUSED') are LEFT paused: NO schedule/budget, NO activation, NO
  // ACTIVE readback. Legacy callers never set this, so the ACTIVE path below is byte-for-byte
  // unchanged and stays the default.
  const paused = params.paused === true;
  // A campaign NEWLY created by this request inherits the ad lifecycle: PAUSED for ad-only (so a
  // brand-new campaign is never created ACTIVE), ACTIVE for the default path. A REUSED existing
  // campaign keeps its own status — we never flip an existing campaign. createdCampaignStatus is the
  // status we created a campaign WITH this request (null when we reused one), surfaced in the result.
  const campaignCreateStatus = paused ? 'PAUSED' : 'ACTIVE';
  let createdCampaignStatus = null;

  // 5. Resolve / create the campaign.
  const maxAdsetsPerCampaign = 10;
  const maxCampaigns = 10;
  const campaignPrefix = body.campaign_name || 'ADS_PUBLISH_';
  // Daily campaign reuse: posts created on the same Bangkok calendar date share ONE campaign
  // named e.g. "15/Jun/2026" (DD/Mon/YYYY). Reuse an existing same-name + same-objective campaign
  // when present; otherwise create it once. DISTINCT from `new_campaign_name`, which ALWAYS
  // force-creates a brand-new campaign (dashboard behavior — must not reuse). `campaign_id` (when
  // explicit) still wins. `reuse_campaign_name` is an accepted alias for `daily_campaign_name`.
  const dailyCampaignName = String(body.daily_campaign_name || body.reuse_campaign_name || '').trim();
  let targetCampaignId = body.campaign_id || null;
  let resolvedCampaignName = '';
  // Apply the 24h run-hours schedule (below) ONLY for the daily-campaign path. The daily campaign
  // now carries a CAMPAIGN-level (CBO) daily_budget — matching the operator's updated Ads Manager
  // template — so the copied adset must NOT get its own daily_budget (Meta rejects an adset budget
  // under a CBO campaign). The prefix/new_campaign_name campaigns also carry a campaign budget and
  // keep the legacy activate-only behavior.
  let usedDailyCampaign = false;
  // Campaign-level (CBO) daily budget in Meta minor units (THB*100) for the daily-campaign path. The
  // worker sends it as `campaign_daily_budget`; default 1_000_000 = 10,000 THB/day.
  const campaignDailyBudget = Number.isInteger(body.campaign_daily_budget) && body.campaign_daily_budget > 0
    ? body.campaign_daily_budget
    : 1000000;
  // The CBO budget actually applied to / read from the daily campaign (reported as campaign_budget).
  let campaignBudgetMinor = null;

  // Read template objective + lifecycle/strategy settings once (campaign-level mirror fields +
  // adset-level customer-lifecycle fields). campaignMirror is spread into every campaign we CREATE;
  // it is empty when the template carries none of the allowlisted fields, so existing behavior is
  // unchanged when there is nothing to mirror.
  const templateSettings = await readTemplateSettings(fetchImpl, { userToken, templateAdset });
  const templateObjective = templateSettings.objective;
  const campaignMirror = templateSettings.campaignSettings || {};
  // Did we CREATE a campaign and apply the campaign-level mirror (vs. reuse an existing campaign,
  // where we cannot retro-apply campaign settings)? Tracked for the copied_template_settings report.
  let campaignSettingsApplied = false;
  let campaignReuse = null;
  // Track a campaign CREATED by THIS request (daily / new_campaign_name / prefix paths). A downstream
  // failure deletes this now-empty campaign so Ads Manager never keeps an orphan "ไม่มีโฆษณา" row
  // (the live symptom: a 16/Jun/2026 campaign with no ads after a failed force-post). A REUSED
  // existing campaign (campaignReuse set) is NEVER deleted — other live ads may share it.
  let createdCampaignId = null;
  // Set ONLY when this request REUSED an existing daily campaign (exact name + objective). A copy
  // failure into such a campaign is the signature of a bad/orphan EMPTY daily campaign left by a
  // prior failed run (live: code=100 subcode=1885272 "Invalid parameter"); the copy step does one
  // safe recovery (delete-if-empty + recreate + retry) keyed on this id.
  let reusedDailyCampaignId = null;

  // Non-secret diagnostics merged into EVERY step-tagged error so the caller/history can show the
  // exact bridge step + ids (never a token). Reads live values at call time.
  const diag = () => ({
    template_adset: templateAdset || undefined,
    target_campaign: targetCampaignId || undefined,
    campaign_id: targetCampaignId || undefined,
    campaign_name: resolvedCampaignName || undefined,
    daily_campaign_name: dailyCampaignName || undefined,
    used_daily_campaign: usedDailyCampaign || undefined,
    created_new_campaign: createdCampaignId ? true : undefined
  });

  // Quietly set status:'DELETED' on an adset OR campaign (both accept it). Returns '' on success or
  // a short error string. Never throws, never logs/returns the token.
  const deleteEntityQuiet = async (entityId) => {
    if (!entityId) return '';
    try {
      const del = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${entityId}?access_token=${encodeURIComponent(userToken)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'DELETED' })
      });
      if (del.data && del.data.error) return String(del.data.error.message || 'delete_failed').substring(0, 200);
      return '';
    } catch (e) { return (e && e.message) || 'delete_exception'; }
  };

  // On a downstream failure: delete the copied adset (cascades to its ad) and, when THIS request
  // CREATED the campaign, delete that now-empty campaign too. Returns cleanup diagnostics to merge
  // into the error — cleaned_campaign_id on success, or orphan_campaign_id + campaign_cleanup_error
  // when the campaign delete fails. A reused existing campaign is left untouched.
  const failCleanup = async (adsetId) => {
    if (adsetId) await deleteEntityQuiet(adsetId);
    if (!createdCampaignId) return {};
    const cErr = await deleteEntityQuiet(createdCampaignId);
    if (cErr) return { orphan_campaign_id: createdCampaignId, campaign_cleanup_error: cErr };
    return { cleaned_campaign_id: createdCampaignId };
  };

  if (body.new_campaign_name) {
    targetCampaignId = '';
    const newCamp = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/campaigns?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: String(body.new_campaign_name).trim(), objective: templateObjective, status: campaignCreateStatus, special_ad_categories: [], daily_budget: '100000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', ...campaignMirror })
    });
    if (newCamp.data.error) return { ok: false, step: 'campaign', error: newCamp.data.error.message, fb_error_code: newCamp.data.error.code, fb_error_subcode: newCamp.data.error.error_subcode, fb_trace_id: newCamp.data.error.fbtrace_id, attempted_objective: templateObjective, ...diag() };
    targetCampaignId = newCamp.data.id;
    createdCampaignId = targetCampaignId;
    createdCampaignStatus = campaignCreateStatus;
    resolvedCampaignName = String(body.new_campaign_name).trim();
    campaignSettingsApplied = Object.keys(campaignMirror).length > 0;
  } else if (!targetCampaignId && dailyCampaignName) {
    // Exact-name reuse within the ad account, scoped to the template objective. CONTAIN narrows
    // the fetch; the exact `name ===` match guarantees we never reuse a different campaign.
    const filtering = encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: dailyCampaignName }]));
    const search = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/campaigns?access_token=${encodeURIComponent(userToken)}&fields=id,name,status,objective,daily_budget&limit=200&filtering=${filtering}`);
    const match = ((search.data && search.data.data) || []).find((c) => c.status !== 'DELETED' && String(c.name) === dailyCampaignName && c.objective === templateObjective);
    if (match) {
      targetCampaignId = match.id;
      resolvedCampaignName = String(match.name);
      campaignReuse = 'reused_existing_campaign';
      reusedDailyCampaignId = match.id;
      // The date-named daily campaign carries the CBO budget shared by every adset created into it.
      // Read its current daily_budget; ONLY when an explicit campaign_daily_budget was requested AND
      // differs, update it (never overwrite a reused campaign's budget blindly). Reported as
      // campaign_budget so history shows the live CBO budget.
      const curBudget = Number(match.daily_budget);
      campaignBudgetMinor = Number.isFinite(curBudget) && curBudget > 0 ? curBudget : null;
      const wantBudget = Number.isInteger(body.campaign_daily_budget) && body.campaign_daily_budget > 0 ? body.campaign_daily_budget : null;
      if (wantBudget && wantBudget !== campaignBudgetMinor) {
        const upd = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${match.id}?access_token=${encodeURIComponent(userToken)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ daily_budget: String(wantBudget) })
        });
        // Best-effort: a failed update leaves the existing CBO budget in place rather than blocking
        // an otherwise-valid ad; campaign_budget then reports the read value.
        if (!(upd.data && upd.data.error)) campaignBudgetMinor = wantBudget;
      }
    } else {
      // Create the daily campaign WITH the campaign-level (CBO) daily_budget + LOWEST_COST bid
      // strategy, matching the operator's Ads Manager template. The copied adset therefore must NOT
      // get its own daily_budget (see "8. schedule" below). Mirror the template campaign's safe
      // lifecycle/strategy fields (campaignMirror) so the daily campaign matches the template.
      const newCamp = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/campaigns?access_token=${encodeURIComponent(userToken)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dailyCampaignName, objective: templateObjective, status: campaignCreateStatus, special_ad_categories: [], daily_budget: String(campaignDailyBudget), bid_strategy: 'LOWEST_COST_WITHOUT_CAP', ...campaignMirror })
      });
      if (newCamp.data.error) return { ok: false, step: 'campaign', error: newCamp.data.error.message, fb_error_code: newCamp.data.error.code, fb_error_subcode: newCamp.data.error.error_subcode, fb_trace_id: newCamp.data.error.fbtrace_id, attempted_objective: templateObjective, ...diag() };
      targetCampaignId = newCamp.data.id;
      createdCampaignId = targetCampaignId;
      createdCampaignStatus = campaignCreateStatus;
      resolvedCampaignName = dailyCampaignName;
      campaignSettingsApplied = Object.keys(campaignMirror).length > 0;
      campaignBudgetMinor = campaignDailyBudget;
    }
    usedDailyCampaign = true;
  }

  if (!targetCampaignId) {
    const camps = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/campaigns?access_token=${encodeURIComponent(userToken)}&fields=id,name,status,objective&limit=50&filtering=[{"field":"name","operator":"CONTAIN","value":"${campaignPrefix}"}]`);
    const activeCamps = ((camps.data && camps.data.data) || []).filter((c) => c.status !== 'DELETED' && c.objective === templateObjective);
    for (const camp of activeCamps) {
      const adsets = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${camp.id}/adsets?access_token=${encodeURIComponent(userToken)}&fields=id,status&limit=50`);
      const count = ((adsets.data && adsets.data.data) || []).filter((a) => a.status !== 'DELETED').length;
      if (count < maxAdsetsPerCampaign) { targetCampaignId = camp.id; resolvedCampaignName = String(camp.name || ''); campaignReuse = 'reused_existing_campaign'; break; }
    }
    if (!targetCampaignId) {
      if (activeCamps.length >= maxCampaigns) return { ok: false, step: 'campaign', error: 'Max ' + maxCampaigns + ' campaigns reached for objective ' + templateObjective };
      const newCampNum = activeCamps.length + 1;
      const newCamp = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/campaigns?access_token=${encodeURIComponent(userToken)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: campaignPrefix + newCampNum, objective: templateObjective, status: campaignCreateStatus, special_ad_categories: [], daily_budget: '100000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', ...campaignMirror })
      });
      if (newCamp.data.error) return { ok: false, step: 'campaign', error: newCamp.data.error.message, fb_error_code: newCamp.data.error.code, fb_error_subcode: newCamp.data.error.error_subcode, fb_trace_id: newCamp.data.error.fbtrace_id, attempted_objective: templateObjective, ...diag() };
      targetCampaignId = newCamp.data.id;
      createdCampaignId = targetCampaignId;
      createdCampaignStatus = campaignCreateStatus;
      resolvedCampaignName = campaignPrefix + newCampNum;
      campaignSettingsApplied = Object.keys(campaignMirror).length > 0;
    }
  }

  // 6. Copy the template adset shell into the campaign.
  const copyTemplateAdset = (campaignId) => gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${templateAdset}/copies?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deep_copy: false, status_option: 'PAUSED', campaign_id: campaignId })
  });
  let copy = await copyTemplateAdset(targetCampaignId);
  // Diagnostics describing a bad-reused-campaign recovery (empty), merged into the success and any
  // subsequent error so Hermes can see what happened. Empty when no recovery was attempted.
  let recoveryDiag = {};

  // RECOVERY: a copy failure into a REUSED daily campaign is the signature of a bad/orphan EMPTY
  // daily campaign left by a prior failed run (live: code=100 subcode=1885272 "Invalid parameter").
  // Do ONE safe recovery: if that reused campaign has NO non-DELETED adsets, delete it (orphan
  // cleanup), create a fresh duplicate daily campaign (same name/objective/mirror), and retry the
  // copy once. A reused campaign that still has adsets is NEVER deleted.
  if (copy.data.error && reusedDailyCampaignId && String(reusedDailyCampaignId) === String(targetCampaignId)) {
    const firstError = copy.data.error || {};
    const adsetsRes = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${reusedDailyCampaignId}/adsets?fields=id,status,effective_status&limit=50&access_token=${encodeURIComponent(userToken)}`);
    const liveAdsets = ((adsetsRes.data && adsetsRes.data.data) || []).filter((a) => String((a && a.status) || '').toUpperCase() !== 'DELETED');
    if (liveAdsets.length > 0) {
      // Non-empty reused campaign — do NOT delete it. Return the original copy error.
      return { ok: false, step: 'copy', error: firstError.message, fb_error_code: firstError.code, fb_error_subcode: firstError.error_subcode, fb_trace_id: firstError.fbtrace_id, ...diag(), reused_campaign_had_adsets: true };
    }
    // Empty reused campaign — safe orphan cleanup, then recreate fresh.
    recoveryDiag = { recovered_from_bad_reused_campaign: true, bad_reused_campaign_id: reusedDailyCampaignId };
    const badDelErr = await deleteEntityQuiet(reusedDailyCampaignId);
    if (badDelErr) recoveryDiag.bad_reused_campaign_cleanup_error = badDelErr;
    else recoveryDiag.cleaned_bad_reused_campaign_id = reusedDailyCampaignId;
    // Create a fresh duplicate daily campaign (same name/objective/mirror) WITH the campaign-level
    // (CBO) daily_budget + LOWEST_COST bid strategy, matching the daily-create path above.
    const freshCamp = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/campaigns?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: dailyCampaignName, objective: templateObjective, status: campaignCreateStatus, special_ad_categories: [], daily_budget: String(campaignDailyBudget), bid_strategy: 'LOWEST_COST_WITHOUT_CAP', ...campaignMirror })
    });
    if (freshCamp.data.error) {
      return { ok: false, step: 'campaign', error: freshCamp.data.error.message, fb_error_code: freshCamp.data.error.code, fb_error_subcode: freshCamp.data.error.error_subcode, fb_trace_id: freshCamp.data.error.fbtrace_id, attempted_objective: templateObjective, ...diag(), ...recoveryDiag };
    }
    targetCampaignId = freshCamp.data.id;
    createdCampaignId = targetCampaignId; // fresh campaign IS deletable on a later failure
    createdCampaignStatus = campaignCreateStatus;
    campaignReuse = null;
    reusedDailyCampaignId = null;
    campaignSettingsApplied = Object.keys(campaignMirror).length > 0;
    campaignBudgetMinor = campaignDailyBudget;
    recoveryDiag.retry_campaign_id = targetCampaignId;
    // Retry the copy ONCE into the fresh campaign.
    copy = await copyTemplateAdset(targetCampaignId);
  }

  if (copy.data.error) {
    // The copy failed BEFORE any adset exists — only clean up a campaign we created this request
    // (the fresh duplicate when recovery ran; nothing for a first-attempt reused campaign).
    const cleanup = await failCleanup(null);
    return { ok: false, step: 'copy', error: copy.data.error.message, fb_error_code: copy.data.error.code, fb_error_subcode: copy.data.error.error_subcode, fb_trace_id: copy.data.error.fbtrace_id, ...diag(), ...recoveryDiag, ...cleanup };
  }
  const newAdset = copy.data.copied_adset_id;

  // 6.5. Re-apply the template's customer-lifecycle strategy to the COPIED adset. The strategy
  // ("Reach new and existing customers" vs "Acquire new customers only") lives on the ad set
  // (existing_customer_budget_percentage); deep_copy:false copies the adset shell but was live-
  // observed to drop it, so re-apply it explicitly. Fail SOFT — the ad still runs without it; the
  // outcome is recorded under copied_template_settings.adset for live verification (req: do not
  // fail closed unless the setting is explicitly required).
  let adsetLifecycle = { applied: false };
  if (Object.keys(templateSettings.adsetSettings).length > 0) {
    const life = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${newAdset}?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(templateSettings.adsetSettings)
    });
    if (life.data && life.data.error) {
      adsetLifecycle = { applied: false, error: String(life.data.error.message || 'lifecycle_apply_failed').substring(0, 200), fields: { ...templateSettings.adsetSettings } };
    } else {
      adsetLifecycle = { applied: true, fields: { ...templateSettings.adsetSettings } };
    }
  }

  // 7. Create the ad (retry transient errors).
  let adData = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const adResp = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/ads?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: adName, adset_id: newAdset, creative: { creative_id: creativeId }, status: 'PAUSED' })
    });
    adData = adResp.data;
    if (!adData.error) break;
    const retryable = adData.error.is_transient === true;
    if (!retryable || attempt === 4) break;
    await sleep(attempt * pollMs);
  }
  if (adData.error) {
    const cleanup = await failCleanup(newAdset);
    return { ok: false, step: 'ad', error: adData.error.message, fb_error_code: adData.error.code, fb_error_subcode: adData.error.error_subcode, fb_error_user_title: adData.error.error_user_title, fb_error_user_msg: adData.error.error_user_msg, fb_is_transient: adData.error.is_transient, fb_trace_id: adData.error.fbtrace_id, adset_id: newAdset, creative_id: creativeId, ...diag(), ...cleanup, ...extraErrorFields };
  }
  const newAd = adData.id;

  // 8. Schedule (daily-campaign path) → rename + activate → readback-confirm ACTIVE. The daily
  // campaign carries the CAMPAIGN-level (CBO) budget, so NO per-adset daily_budget is set here.
  // The adset update response was previously IGNORED, which let a Graph error (live-observed:
  // code=100 subcode=1487057 "Invalid parameter" on an invalid schedule) silently leave the adset
  // PAUSED while this route reported success. The fix: (a) keep the run-hours schedule on its own
  // activation POST, (b) check EVERY response and fail closed (deleting the orphan adset), and
  // (c) read the adset back and require status === 'ACTIVE' (a POST can "succeed" yet leave it
  // PAUSED — also live-observed).
  const adsetRunHours = Number.isFinite(body.adset_run_hours) && body.adset_run_hours > 0 ? body.adset_run_hours : 24;
  const runMs = Math.round(adsetRunHours * 3600 * 1000);
  let scheduleReport = null;

  // Daily/post-first ADSET name = the post tail / sub2 (e.g. "984538171215406") — never the hash
  // and never page_id_post_id. Derived from the source post id (storyId) tail. The AD name is left
  // untouched (it stays the system video code/hash set at creation). Legacy paths keep the full
  // storyId adset name.
  //
  // Ad-only paths can pass an EXPLICIT campaign_id (so usedDailyCampaign stays false) yet still want
  // the tail-only adset name — without this they would get the full page_id_post_id name. Detect the
  // ad-only flow (skip_publish_to_page / a campaign_daily_budget / an adset_run_hours / an explicit
  // force_adset_name_tail) and apply the same tail-only naming. Legacy (non-ad-only) callers without
  // a daily campaign are unchanged and keep the full storyId.
  const storyIdStr = String(storyId || '');
  const adOnlyTailSignal = body.skip_publish_to_page === true || body.skip_publish_to_page === 'true'
    || body.campaign_daily_budget != null
    || body.adset_run_hours != null
    || body.force_adset_name_tail === true || body.force_adset_name_tail === 'true';
  const adsetName = ((usedDailyCampaign || adOnlyTailSignal) && storyIdStr.includes('_'))
    ? storyIdStr.split('_').slice(1).join('_')
    : storyIdStr;

  // PAUSED ad-only path — see `paused` above. The copied adset is already status_option:'PAUSED'
  // and the ad was created status:'PAUSED'; leave both paused (a non-spending ad). Do a best-effort
  // adset rename for naming parity (a NAME-only POST — never a status change), clean up the
  // deep_copy straggler ads (same as the ACTIVE path), and return the known PAUSED statuses. No
  // budget/schedule POST, no activation POST, no ACTIVE readback — so an ad-only call can never
  // start spending.
  if (paused) {
    try {
      await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${newAdset}?access_token=${encodeURIComponent(userToken)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: adsetName })
      });
    } catch {}
    try {
      const adsList = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${newAdset}/ads?fields=id&limit=50&access_token=${encodeURIComponent(userToken)}`);
      const stragglers = ((adsList.data && adsList.data.data) || []).filter((a) => String(a.id) !== String(newAd));
      for (const a of stragglers) {
        await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${a.id}?access_token=${encodeURIComponent(userToken)}`, { method: 'DELETE' });
      }
    } catch {}
    return {
      ok: true,
      paused: true,
      campaign_id: targetCampaignId,
      campaign_name: resolvedCampaignName || undefined,
      adset_id: newAdset,
      ad_id: newAd,
      // The copied adset and the ad are both left in their created PAUSED state (never activated).
      adset_status: 'PAUSED',
      ad_status: 'PAUSED',
      // The daily campaign's CAMPAIGN-level (CBO) budget (minor units). On the paused/review path the
      // campaign is PAUSED, so this budget never spends — it is reported for proof/parity only.
      ...(campaignBudgetMinor != null ? { campaign_budget: campaignBudgetMinor } : {}),
      // A campaign CREATED by this request was created PAUSED too (never ACTIVE). Omitted when we
      // REUSED an existing campaign — we never flip an existing campaign's status, and its current
      // status is not re-read here.
      ...(createdCampaignStatus ? { campaign_status: createdCampaignStatus } : {}),
      ...recoveryDiag,
      ...(templateSettings.campaignId ? { template_campaign_id: templateSettings.campaignId } : {}),
      copied_template_settings: {
        campaign: { applied: campaignSettingsApplied, fields: { ...campaignMirror }, ...(campaignReuse ? { reuse: campaignReuse } : {}) },
        adset: { ...adsetLifecycle, diagnostics: { ...templateSettings.adsetDiagnostics } }
      }
    };
  }

  // Bangkok offset ISO schedule (daily path only). end_time is sent on the ACTIVATION POST.
  // start_time is NEVER sent (a now/past start_time is a known cause of subcode 1487057). Meta
  // additionally requires end_time >= the COPIED adset's OWN start_time + the run window; the copy
  // assigns a start_time a few seconds after our local `now`, so an end_time computed from `now`
  // lands just short and is rejected as 1487793. So we read the copied adset's start_time back and
  // compute end_time = that start + adsetRunHours.
  let startIso = '';
  let endIso = '';
  if (usedDailyCampaign) {
    let baseStartMs = null;
    try {
      const sr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${newAdset}?fields=start_time&access_token=${encodeURIComponent(userToken)}`);
      const rbStart = sr.data && sr.data.start_time ? String(sr.data.start_time) : '';
      const parsed = rbStart ? Date.parse(rbStart) : NaN;
      if (Number.isFinite(parsed)) { baseStartMs = parsed; startIso = rbStart; }
    } catch {}
    if (baseStartMs == null) {
      // Fallback: no readable start_time. Anchor to now + a safety buffer so end_time is
      // comfortably past the (unknown) actual copied start + run window.
      baseStartMs = now;
      startIso = toBangkokIso(Math.floor(now / 1000));
      endIso = toBangkokIso(Math.floor((now + runMs + 60000) / 1000));
    } else {
      endIso = toBangkokIso(Math.floor((baseStartMs + runMs) / 1000));
    }

    // 8a. NO per-adset daily_budget. The daily campaign carries the CAMPAIGN-level (CBO) budget, so
    // setting an adset budget here would be rejected by Meta (and double-budget the ad). Only the
    // run-hours schedule + activation are applied to the copied adset (8b below).
    scheduleReport = { start_time: startIso, end_time: endIso };
  }

  // 8b. Rename + activate the adset — fail closed on any Graph error (never ignore the response).
  // Daily path: this single POST also carries the 24h end_time as an offset ISO string — the
  // live-proven shape { name, status:'ACTIVE', end_time } (NO daily_budget here, NO start_time).
  const adsetActBody = usedDailyCampaign
    ? { name: adsetName, status: 'ACTIVE', end_time: endIso }
    : { name: adsetName, status: 'ACTIVE' };
  const adsetAct = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${newAdset}?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(adsetActBody)
  });
  if (adsetAct.data && adsetAct.data.error) {
    const cleanup = await failCleanup(newAdset);
    return { ok: false, step: 'adset_activate', error: adsetAct.data.error.message, fb_error_code: adsetAct.data.error.code, fb_error_subcode: adsetAct.data.error.error_subcode, fb_trace_id: adsetAct.data.error.fbtrace_id, adset_id: newAdset, ...(usedDailyCampaign ? { start_time: startIso || undefined, end_time: endIso } : {}), ...diag(), ...cleanup, ...extraErrorFields };
  }

  // 8c. Activate the ad — likewise fail closed on error.
  const adAct = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${newAd}?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ACTIVE' })
  });
  if (adAct.data && adAct.data.error) {
    const cleanup = await failCleanup(newAdset);
    return { ok: false, step: 'ad_activate', error: adAct.data.error.message, fb_error_code: adAct.data.error.code, fb_error_subcode: adAct.data.error.error_subcode, fb_trace_id: adAct.data.error.fbtrace_id, adset_id: newAdset, ad_id: newAd, ...diag(), ...cleanup, ...extraErrorFields };
  }

  // 8d. Readback (daily path): require the adset to actually be ACTIVE and to carry the schedule
  // end_time. A POST can return success while the adset stays PAUSED (live-observed) — never
  // report success on a paused adset, and never claim the 24h schedule applied if end_time is
  // missing on read-back.
  if (usedDailyCampaign) {
    const rb = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${newAdset}?fields=name,status,effective_status,daily_budget,start_time,end_time&access_token=${encodeURIComponent(userToken)}`);
    const adsetStatus = String((rb.data && rb.data.status) || '').toUpperCase();
    if (adsetStatus !== 'ACTIVE') {
      const cleanup = await failCleanup(newAdset);
      return { ok: false, step: 'adset_activate', error: 'adset_not_active_after_update', adset_status: adsetStatus || null, adset_effective_status: (rb.data && rb.data.effective_status) || null, adset_id: newAdset, ad_id: newAd, ...diag(), ...cleanup, ...extraErrorFields };
    }
    const rbEndTime = String((rb.data && rb.data.end_time) || '').trim();
    if (!rbEndTime) {
      const cleanup = await failCleanup(newAdset);
      return { ok: false, step: 'adset_activate', error: 'adset_end_time_missing_after_update', adset_status: adsetStatus, adset_id: newAdset, ad_id: newAd, ...diag(), ...cleanup, ...extraErrorFields };
    }
  }

  // 8.25. Cleanup deep_copy straggler ads.
  try {
    const adsList = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${newAdset}/ads?fields=id&limit=50&access_token=${encodeURIComponent(userToken)}`);
    const stragglers = ((adsList.data && adsList.data.data) || []).filter((a) => String(a.id) !== String(newAd));
    for (const a of stragglers) {
      await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${a.id}?access_token=${encodeURIComponent(userToken)}`, { method: 'DELETE' });
    }
  } catch {}

  return {
    ok: true,
    campaign_id: targetCampaignId,
    campaign_name: resolvedCampaignName || undefined,
    adset_id: newAdset,
    ad_id: newAd,
    // The default (non-paused) path activates the copied adset + ad to ACTIVE above (and the daily
    // path read it back to confirm). Reported so callers can distinguish a live ad from a paused one.
    adset_status: 'ACTIVE',
    ad_status: 'ACTIVE',
    // Surfaced when this request CREATED a campaign (ACTIVE on the default path). Omitted on reuse.
    ...(createdCampaignStatus ? { campaign_status: createdCampaignStatus } : {}),
    // The daily campaign's CAMPAIGN-level (CBO) budget (minor units) — the live spend budget shared
    // by every adset in the date-named campaign. Replaces the old per-adset daily_budget report.
    ...(campaignBudgetMinor != null ? { campaign_budget: campaignBudgetMinor } : {}),
    ...(scheduleReport ? { start_time: scheduleReport.start_time, end_time: scheduleReport.end_time } : {}),
    // Bad-reused-campaign recovery (empty orphan deleted + fresh duplicate created + copy retried).
    // Empty when no recovery ran, so existing successful responses are unchanged.
    ...recoveryDiag,
    // Diagnostics so Hermes can live-verify template parity. template_campaign_id is the source
    // template campaign; copied_template_settings reports what was mirrored at each level (campaign-
    // level fields applied only when we CREATED the campaign; adset-level customer-lifecycle re-apply
    // outcome). adset.diagnostics carries read-only template fields not safely re-applicable.
    ...(templateSettings.campaignId ? { template_campaign_id: templateSettings.campaignId } : {}),
    copied_template_settings: {
      campaign: { applied: campaignSettingsApplied, fields: { ...campaignMirror }, ...(campaignReuse ? { reuse: campaignReuse } : {}) },
      adset: { ...adsetLifecycle, diagnostics: { ...templateSettings.adsetDiagnostics } }
    }
  };
}

// Read the template adset's CTA type + Instagram actor/user ids from its first ad creative.
// Returns safe defaults on any failure. Shared by createAd and promoteOneCardPost.
async function readTemplateCreativeMeta(fetchImpl, { userToken, templateAdset }) {
  let ctaType = 'SHOP_NOW';
  let instagramActorId = '';
  let instagramUserId = '';
  try {
    const tplAds = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${templateAdset}/ads?fields=creative{id}&limit=1&access_token=${encodeURIComponent(userToken)}`);
    const tplCreativeId = tplAds.data && tplAds.data.data && tplAds.data.data[0] && tplAds.data.data[0].creative && tplAds.data.data[0].creative.id;
    if (tplCreativeId) {
      const tplCr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${tplCreativeId}?fields=call_to_action_type,instagram_actor_id,object_story_spec&access_token=${encodeURIComponent(userToken)}`);
      const d = tplCr.data;
      if (d && d.call_to_action_type) ctaType = String(d.call_to_action_type).trim();
      instagramActorId = String((d && (d.instagram_actor_id || (d.object_story_spec && d.object_story_spec.instagram_actor_id))) || '').trim();
      instagramUserId = String((d && d.object_story_spec && d.object_story_spec.instagram_user_id) || '').trim();
    }
  } catch {}
  return { ctaType, instagramActorId, instagramUserId };
}

// Resolve the attachment video id from a freshly posted page video. The verified legacy
// /create-ad flow promotes a Page video by its video_id; when the caller only knows the
// source post (story_id/post_id), read attachments{media_type,target{id,url}} and take the
// attachment target id. Returns '' on any failure so callers fail closed.
async function resolveVideoIdFromSourcePost(fetchImpl, { userToken, sourcePostId }) {
  const postId = String(sourcePostId || '').trim();
  if (!postId) return '';
  try {
    const res = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(postId)}?fields=attachments{media_type,target{id,url}}&access_token=${encodeURIComponent(userToken)}`);
    const att = res.data && res.data.attachments && res.data.attachments.data;
    const target = Array.isArray(att) && att[0] && att[0].target;
    return target && target.id ? String(target.id).trim() : '';
  } catch {
    return '';
  }
}

// POST /create-ad — OneCard/Ads via Cloak. Faithful port of electron.js /create-ad Graph
// orchestration (upload → thumbnail → creative → campaign/adset → ad → activate → publish
// to page). Compatible with the Worker's existing create-ad payload + response fields.
//
// POST-FIRST SUPPORT: when body.skip_ad is set, this returns AFTER publishing the page post
// (story_id + reusable video_id + thumbnail) and does NOT create a campaign/adset/ad. Phase A
// publishes a VISIBLE OneCard post: the page video carries an INITIAL (temporary) Shopee CTA
// (shortlink/shopee_url) so the post immediately shows the Shopee link card + the SHOP_NOW
// button under the video — never an organic/linkless Reel. The final post-specific Shopee
// shortlink needs the post id (sub2), so the Worker mints it after story_id and then calls
// /update-cta to replace this initial CTA with the final link (and /promote builds the paid ad).
// Phase A never bakes a Worker redirect (onecard-cta / api.pubilo.com) into the visible UI.
async function createAd(fetchImpl, params = {}) {
  const sleep = params.sleep || realSleep;
  const userToken = params.userToken;
  const body = params.body || {};
  const pageId = body.page_id;
  const videoUrl = String(body.video_url || '').trim();
  const existingVideoId = String(body.video_id || '').trim();
  const caption = body.caption || '';
  const adAccount = String(body.ad_account || params.defaultAdAccount || '').trim();
  const templateAdset = String(body.template_adset || params.defaultTemplateAdset || '').trim();
  const shortlink = String(body.shortlink || '').trim();
  const shopeeUrl = String(body.shopee_url || '').trim();
  const thumbnailUrl = String(body.thumbnail_url || body.image_url || '').trim();
  const skipPublishToPage = body.skip_publish_to_page === true || body.skip_publish_to_page === 'true';
  const skipComment = body.skip_comment === true || body.skip_comment === 'true';
  const skipAd = body.skip_ad === true || body.skip_ad === 'true';
  // Ad-only / non-spending mode: create the campaign/adset/ad but leave them PAUSED (never
  // activate). Accept either `paused:true` or `status_option:'PAUSED'`. Default (unset) keeps the
  // legacy ACTIVE behavior.
  const paused = body.paused === true || body.paused === 'true' || String(body.status_option || '').toUpperCase() === 'PAUSED';
  const requestedAdName = String(body.ad_name || body.source_video_id || '').trim();
  const ctaLink = shortlink || shopeeUrl;
  const thumbPolls = Number.isInteger(params.thumbPolls) ? params.thumbPolls : 60;
  const storyPolls = Number.isInteger(params.storyPolls) ? params.storyPolls : 50;
  const pollMs = Number.isInteger(params.pollMs) ? params.pollMs : 3000;

  if (!pageId || (!videoUrl && !existingVideoId)) {
    return { ok: false, step: 'validate', error: 'Missing: page_id, video_url or video_id' };
  }
  if (!adAccount || !templateAdset) {
    return { ok: false, step: 'config', error: 'Missing: ad_account / template_adset' };
  }

  if (skipAd && (body.publish_as_page_video === true || body.publish_as_page_video === 'true')) {
    return await publishPageVideoPost(fetchImpl, {
      userToken,
      pageId,
      videoUrl,
      caption,
      title: requestedAdName,
      sleep,
      pollMs,
      downloadVideo: params.downloadVideo
    });
  }

  // Read CTA type + IG actor from the template adset's first ad creative.
  const { ctaType, instagramActorId, instagramUserId } = await readTemplateCreativeMeta(fetchImpl, { userToken, templateAdset });

  // 1. Upload video (or reuse existing video id).
  let vid;
  let uploadedForInstagram = false;
  let resolvedVideoUrl = videoUrl;
  if (skipPublishToPage && !resolvedVideoUrl && existingVideoId) {
    try {
      const src = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(existingVideoId)}?fields=source&access_token=${encodeURIComponent(userToken)}`);
      if (src.data && src.data.source && /^https?:\/\//i.test(String(src.data.source))) resolvedVideoUrl = String(src.data.source).trim();
    } catch {}
  }
  let uploadMode = null;
  if (skipPublishToPage && resolvedVideoUrl) {
    const uv = await uploadAdVideoFromUrl(fetchImpl, { adAccount, userToken, videoUrl: resolvedVideoUrl, download: params.downloadVideo });
    vid = uv.data;
    // upload_mode for this IG path reports both the 'instagram_advideo' intent and the transport
    // used: multipart is now primary ('instagram_advideo_multipart'); only a download failure routes
    // to the file_url fallback ('instagram_advideo_file_url_fallback').
    uploadMode = uv.uploadMode === 'file_url_fallback' ? 'instagram_advideo_file_url_fallback' : 'instagram_advideo_multipart';
    if (vid.error) return { ok: false, step: 'upload', error: vid.error.message, fb_error_code: vid.error.code, fb_error_subcode: vid.error.error_subcode, fb_trace_id: vid.error.fbtrace_id, upload_mode: uploadMode };
    uploadedForInstagram = true;
  } else if (existingVideoId) {
    vid = { id: existingVideoId };
  } else {
    const uv = await uploadAdVideoFromUrl(fetchImpl, { adAccount, userToken, videoUrl: resolvedVideoUrl, download: params.downloadVideo });
    vid = uv.data;
    uploadMode = uv.uploadMode;
    if (vid.error) return { ok: false, step: 'upload', error: vid.error.message, fb_error_code: vid.error.code, fb_error_subcode: vid.error.error_subcode, fb_trace_id: vid.error.fbtrace_id, upload_mode: uploadMode };
  }

  // 2. Wait for a thumbnail (or use the supplied one).
  let thumb = /^https?:\/\//i.test(thumbnailUrl) ? thumbnailUrl : null;
  if (!thumb) {
    for (let i = 0; i < thumbPolls; i++) {
      await sleep(pollMs);
      const t = await gJson(fetchImpl, `${GRAPH}/${vid.id}?access_token=${encodeURIComponent(userToken)}&fields=thumbnails`);
      const td = t.data;
      if (td.error) return { ok: false, step: 'thumbnails', error: td.error.message || 'Graph thumbnails error', fb_error_code: td.error.code, fb_error_subcode: td.error.error_subcode, fb_trace_id: td.error.fbtrace_id, used_existing_video: !!existingVideoId && !uploadedForInstagram, uploaded_for_instagram: uploadedForInstagram };
      if (td.thumbnails && td.thumbnails.data && td.thumbnails.data.length >= 1) { thumb = td.thumbnails.data[0].uri; break; }
    }
  }
  if (!thumb) return { ok: false, step: 'thumbnails', error: 'Timeout (FB still processing)' };

  // 3. Create the creative.
  // POST-FIRST (skipAd) builds the VISIBLE OneCard page post. It DOES attach an INITIAL CTA so
  // the post shows the Shopee link card + the SHOP_NOW button immediately — using the pre-final
  // Shopee link (shortlink/shopee_url) the Worker provides before the post-specific shortlink is
  // minted. /update-cta swaps in the final post-specific link once story_id exists. The visible
  // CTA must NEVER carry a Worker redirect (onecard-cta / api.pubilo.com); strip it if present so
  // the visible UI only ever shows a direct Shopee link.
  let effectiveCtaLink = ctaLink;
  if (/\/onecard-cta(?:\/|$)/i.test(effectiveCtaLink) || /^https?:\/\/api\.pubilo\.com(?:\/|$)/i.test(effectiveCtaLink)) {
    effectiveCtaLink = '';
  }
  const hasCtaLink = !!effectiveCtaLink;
  const isLikePageCta = ctaType === 'LIKE_PAGE' || (!hasCtaLink && !skipAd);
  // Attach a CTA when there is a usable link, when the template itself is LIKE_PAGE, or for the
  // full ad path. In skip_ad mode with no usable link, publish linkless rather than inject a
  // LIKE_PAGE button that the OneCard flow never intended.
  const attachCta = hasCtaLink || ctaType === 'LIKE_PAGE' || !skipAd;
  const ctaSpec = isLikePageCta
    ? { type: 'LIKE_PAGE', value: { page: pageId } }
    : { type: ctaType, value: { link: effectiveCtaLink, link_format: 'VIDEO_LPP' } };
  let uploadedImageHash = '';
  let creativeImageUploadMode = '';
  let creativeImageUploadError = '';
  const videoData = { video_id: vid.id, message: caption, image_url: thumb };
  if (attachCta) videoData.call_to_action = ctaSpec;
  const buildCreativeBody = (includeInstagram = true, includeLinkFormat = true, includeCta = true, includeImage = true, imageHash = '') => {
    const spec = { ...ctaSpec };
    if (!includeLinkFormat && spec && spec.value) delete spec.value.link_format;
    const localVideoData = { ...videoData };
    if (imageHash) {
      delete localVideoData.image_url;
      localVideoData.image_hash = imageHash;
    }
    if (!includeImage) delete localVideoData.image_url;
    if (!includeCta) delete localVideoData.call_to_action;
    if (localVideoData.call_to_action && !includeLinkFormat) localVideoData.call_to_action = spec;
    const storySpec = {
      page_id: pageId,
      ...(includeInstagram && instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
      ...(includeInstagram && instagramUserId ? { instagram_user_id: instagramUserId } : {}),
      video_data: localVideoData
    };
    return {
      name: String(caption).substring(0, 50),
      ...(includeInstagram && instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
      object_story_spec: storySpec
    };
  };
  let crBody = buildCreativeBody(true, true);
  let creativeRetryWithoutInstagram = false;
  let creativeRetryWithoutLinkFormat = false;
  let creativeRetryWithoutCta = false;
  let creativeRetryWithoutImage = false;
  let cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
  });
  let crData = cr.data;
  if (crData.error && skipPublishToPage && (instagramActorId || instagramUserId)) {
    creativeRetryWithoutInstagram = true;
    crBody = buildCreativeBody(false, true);
    cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
    });
    crData = cr.data;
  }
  if (crData.error && skipPublishToPage && effectiveCtaLink) {
    creativeRetryWithoutLinkFormat = true;
    crBody = buildCreativeBody(false, false, true);
    cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
    });
    crData = cr.data;
  }
  if (crData.error && skipPublishToPage && attachCta) {
    creativeRetryWithoutCta = true;
    crBody = buildCreativeBody(false, false, false, true);
    cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
    });
    crData = cr.data;
  }
  if (crData.error && skipPublishToPage && thumb) {
    const img = await uploadAdImageFromUrl(fetchImpl, { adAccount, userToken, imageUrl: thumb, download: params.downloadImage || params.downloadVideo });
    creativeImageUploadMode = img.uploadMode || '';
    creativeImageUploadError = img.data && img.data.error && img.data.error.message ? String(img.data.error.message).slice(0, 200) : '';
    uploadedImageHash = firstAdImageHash(img.data);
    if (uploadedImageHash) {
      crBody = buildCreativeBody(false, false, false, true, uploadedImageHash);
      cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
      });
      crData = cr.data;
    }
  }
  if (crData.error && skipPublishToPage && thumb) {
    creativeRetryWithoutImage = true;
    crBody = buildCreativeBody(false, false, false, false);
    cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
    });
    crData = cr.data;
  }
  if (crData.error) return { ok: false, step: 'creative', error: crData.error.message, fb_error_code: crData.error.code, fb_error_subcode: crData.error.error_subcode, fb_trace_id: crData.error.fbtrace_id, cta_type: ctaType, cta_link: effectiveCtaLink || null, used_existing_video: !!existingVideoId && !uploadedForInstagram, uploaded_for_instagram: uploadedForInstagram, creative_retry_without_instagram: creativeRetryWithoutInstagram, creative_retry_without_link_format: creativeRetryWithoutLinkFormat, creative_retry_without_cta: creativeRetryWithoutCta, creative_retry_without_image: creativeRetryWithoutImage, creative_image_upload_mode: creativeImageUploadMode, creative_image_upload_error: creativeImageUploadError, creative_uploaded_image_hash: !!uploadedImageHash };

  // 4. Poll for the story id.
  let storyId = null;
  for (let i = 0; i < storyPolls; i++) {
    await sleep(pollMs);
    const cc = await gJson(fetchImpl, `${GRAPH}/${crData.id}?access_token=${encodeURIComponent(userToken)}&fields=effective_object_story_id`);
    if (cc.data && cc.data.effective_object_story_id) { storyId = cc.data.effective_object_story_id; break; }
  }
  if (!storyId) return { ok: false, step: 'story_id', error: 'Timeout (FB still creating story)', creative_id: crData.id };
  const adName = String(requestedAdName || existingVideoId || String(vid.id || '') || caption).substring(0, 255);

  // PHASE A (post-first): publish the page post and STOP — no campaign/adset/ad. Return the
  // ids the post-first caller needs to (a) mint the final link with this story/post id and
  // (b) reuse this uploaded video in /promote without a second upload.
  if (skipAd) {
    let pa = { publishedToPage: false, publishError: 'skipped_by_placement_template' };
    if (!skipPublishToPage) pa = await publishStoryToPage(fetchImpl, { userToken, pageId, storyId, sleep, pollMs });
    // Fail closed: when a page publish was ATTEMPTED (not skip_publish_to_page) but NOT confirmed,
    // never return ok:true. ok:true here let the Worker record a visible-post success for a post
    // that is not actually on the page feed (the live incident). skip_publish_to_page is the only
    // intentional non-publish path; it stays ok:true with published_to_page:false (truthful) and
    // callers must not record it as a visible page post. No token is ever included.
    if (!skipPublishToPage && !pa.publishedToPage) {
      return {
        ok: false,
        phase: 'post',
        step: 'publish',
        error: pa.publishError || 'publish_to_page_failed',
        publish_error: pa.publishError || 'publish_to_page_failed',
        published_to_page: false,
        story_id: storyId,
        video_id: vid.id,
        creative_id: crData.id,
        uploaded_for_instagram: uploadedForInstagram,
        upload_mode: uploadMode || undefined
      };
    }
    // The INITIAL visible CTA link actually baked onto the post (null when the post is linkless
    // or carries a LIKE_PAGE CTA). It is the pre-final Shopee link; the post-specific final link
    // is applied later by /update-cta — so visible_page_cta_final stays false here.
    const visibleInitialCtaLink = (attachCta && !isLikePageCta) ? effectiveCtaLink : null;
    return {
      ok: true,
      phase: 'post',
      story_id: storyId,
      video_id: vid.id,
      creative_id: crData.id,
      thumbnail_url: thumb,
      cta_type: ctaType,
      // Phase A publishes the visible OneCard post with an INITIAL (temporary) Shopee CTA. It is
      // not the post-specific final link yet, so visible_page_cta_final remains false; the
      // visible_page_cta_initial flag signals the post already shows a Shopee CTA card/button.
      cta_link: visibleInitialCtaLink,
      visible_page_cta_link: visibleInitialCtaLink,
      visible_page_cta_initial: !!visibleInitialCtaLink,
      visible_page_cta_final: false,
      post_url: `https://www.facebook.com/${String(storyId).replace('_', '/posts/')}`,
      published_to_page: pa.publishedToPage,
      publish_error: pa.publishError || undefined,
      uploaded_for_instagram: uploadedForInstagram,
      upload_mode: uploadMode || undefined
    };
  }

  // 5–8. Resolve/create campaign, copy adset, create + activate the ad.
  const adEntities = await buildAdFromCreative(fetchImpl, {
    userToken, adAccount, templateAdset, creativeId: crData.id, storyId, adName, body, sleep, pollMs, paused,
    extraErrorFields: { uploaded_for_instagram: uploadedForInstagram }
  });
  if (!adEntities.ok) return adEntities;
  const targetCampaignId = adEntities.campaign_id;
  const newAdset = adEntities.adset_id;
  const newAd = adEntities.ad_id;

  // 8.5. Publish the dark post to the page feed via the PAGE token.
  let publishedToPage = false;
  let publishError = '';
  if (skipPublishToPage) {
    publishError = 'skipped_by_placement_template';
  } else {
    const pubRes = await publishStoryToPage(fetchImpl, { userToken, pageId, storyId, sleep, pollMs });
    publishedToPage = pubRes.publishedToPage;
    publishError = pubRes.publishError;
  }

  // Fail closed: the full create-ad contract publishes the page post (unless skip_publish_to_page
  // is set). When a publish was attempted but NOT confirmed, do NOT return ok:true — that let the
  // Worker record a success for a post the page feed never showed. The ad entities already exist
  // and their ids are surfaced for diagnosis; only the visible-page publish failed. No token leaks.
  if (!skipPublishToPage && !publishedToPage) {
    return {
      ok: false,
      step: 'publish',
      error: publishError || 'publish_to_page_failed',
      publish_error: publishError || 'publish_to_page_failed',
      published_to_page: false,
      story_id: storyId,
      campaign_id: targetCampaignId,
      adset_id: newAdset,
      ad_id: newAd,
      video_id: vid.id,
      creative_id: crData.id,
      uploaded_for_instagram: uploadedForInstagram,
      upload_mode: uploadMode || undefined
    };
  }

  // Active ad-only path (skip_publish_to_page, NOT paused): no Page post is published, so drop ONE
  // Page comment carrying the Shopee link instead — the spending ad still needs the affiliate link
  // surfaced under the (dark) story. Targets the FULL storyId. Never runs on the paused/review path
  // and never on the normal publish path (which already publishes a visible post). Honors skip_comment
  // and fails SOFT: a comment failure is reported (comment_error) but never fails the ad.
  let commentStatus;
  let commentFbId;
  let commentError;
  if (skipPublishToPage && !paused && !skipComment) {
    // Prefer an explicit rendered comment template (comment_message/comment_text) when the caller
    // supplies one, so this path never forces a bare-link comment. Only fall back to the raw
    // shortlink/shopee fields when no rendered message was provided.
    const commentMessage = String(body.comment_message || body.comment_text || body.comment_shortlink || body.final_cta_link || body.shortlink || body.shopee_url || '').trim();
    if (commentMessage) {
      try {
        const cm = await pageComment(fetchImpl, { userToken, pageId, target: storyId, message: commentMessage });
        if (cm && cm.ok && cm.id) {
          commentStatus = 'commented';
          commentFbId = String(cm.id);
        } else {
          commentStatus = 'comment_failed';
          commentError = (cm && cm.error) || 'comment_failed';
        }
      } catch (e) {
        commentStatus = 'comment_failed';
        commentError = (e && e.message) || String(e);
      }
    } else {
      commentStatus = 'comment_skipped_no_link';
    }
  }

  return {
    ok: true,
    story_id: storyId,
    campaign_id: targetCampaignId,
    campaign_name: adEntities.campaign_name,
    // CAMPAIGN-level (CBO) daily budget in minor units (daily path). Replaces the old adset budget.
    campaign_budget: adEntities.campaign_budget,
    start_time: adEntities.start_time,
    end_time: adEntities.end_time,
    adset_id: newAdset,
    ad_id: newAd,
    // Surface the real adset/ad lifecycle status (PAUSED for ad-only, ACTIVE for the default path)
    // so callers/history can tell a non-spending ad from a live one.
    adset_status: adEntities.adset_status,
    ad_status: adEntities.ad_status,
    ...(adEntities.campaign_status ? { campaign_status: adEntities.campaign_status } : {}),
    ...(paused ? { paused: true } : {}),
    video_id: vid.id,
    creative_id: crData.id,
    post_url: `https://www.facebook.com/${String(storyId).replace('_', '/posts/')}`,
    published_to_page: publishedToPage,
    publish_error: publishError || undefined,
    // Active ad-only comment outcome (only set on the skip_publish_to_page + non-paused path). Lets
    // the Worker/history record whether the affiliate-link comment landed (and its fb id) or failed.
    ...(commentStatus ? { comment_status: commentStatus } : {}),
    ...(commentFbId ? { comment_fb_id: commentFbId } : {}),
    ...(commentError ? { comment_error: commentError } : {}),
    uploaded_for_instagram: uploadedForInstagram,
    creative_retry_without_instagram: creativeRetryWithoutInstagram,
    creative_retry_without_link_format: creativeRetryWithoutLinkFormat,
    creative_retry_without_cta: creativeRetryWithoutCta,
    creative_retry_without_image: creativeRetryWithoutImage,
    creative_image_upload_mode: creativeImageUploadMode || undefined,
    creative_image_upload_error: creativeImageUploadError || undefined,
    creative_uploaded_image_hash: !!uploadedImageHash,
    upload_mode: uploadMode || undefined,
    template_campaign_id: adEntities.template_campaign_id,
    copied_template_settings: adEntities.copied_template_settings,
    ...pickRecoveryDiag(adEntities)
  };
}

// POST /promote — PHASE B of the post-first One Card flow. Build a PAID ad creative for a
// freshly posted Page video using the verified legacy /create-ad flow: a NEW dark-post
// adcreative whose object_story_spec.video_data carries the video_id plus the FINAL Shopee
// CTA link, then reuse buildAdFromCreative() to copy the template adset + create the paused
// ad. This does NOT touch the organic page post CTA and does NOT build the creative from an
// existing object_story_id (that path produced a preview with no Shopee/CTA — rejected).
//
// The promoted ad mints its OWN effective_object_story_id (ad_story_id), which is DISTINCT
// from the source page post (story_id/post_id). The source post is used only for ad naming
// and adset grouping; promote never publishes a second page post.
//
// Inputs (params.body): page_id, video_id (from Phase A; resolved from the source post
// attachment when absent but story_id/post_id is present), final_cta_link (direct Shopee
// shortlink), thumbnail_url (optional — polled from the video if absent), caption, story_id /
// post_id (the source page post, for naming/reference), ad_account, template_adset, campaign
// options.
async function promoteOneCardPost(fetchImpl, params = {}) {
  const sleep = params.sleep || realSleep;
  const userToken = params.userToken;
  const body = params.body || {};
  const pageId = String(body.page_id || '').trim();
  let videoId = String(body.video_id || '').trim();
  const caption = body.caption || '';
  const adAccount = String(body.ad_account || params.defaultAdAccount || '').trim();
  const templateAdset = String(body.template_adset || params.defaultTemplateAdset || '').trim();
  const finalCtaLink = String(body.final_cta_link || body.shortlink || '').trim();
  const thumbnailUrl = String(body.thumbnail_url || body.image_url || '').trim();
  // The source page post — used for ad naming/reference + adset grouping. Distinct from the
  // ad creative's own dark story (ad_story_id).
  const sourcePostId = String(body.story_id || body.post_id || '').trim();
  const requestedAdName = String(body.ad_name || body.source_video_id || '').trim();
  // Ad-only / non-spending mode (same flag contract as createAd): build the paid ad but leave the
  // campaign/adset/ad PAUSED. Default (unset) keeps the legacy ACTIVE behavior.
  const paused = body.paused === true || body.paused === 'true' || String(body.status_option || '').toUpperCase() === 'PAUSED';
  // Create Ads post-new-then-promote mode: the Worker already published and finalized the NEW Page
  // story, so the paid ad should sponsor that exact story via object_story_id instead of minting a
  // second video_data dark story.
  const useObjectStoryId = body.use_object_story_id === true || body.use_object_story_id === 'true';
  const thumbPolls = Number.isInteger(params.thumbPolls) ? params.thumbPolls : 60;
  const storyPolls = Number.isInteger(params.storyPolls) ? params.storyPolls : 50;
  const pollMs = Number.isInteger(params.pollMs) ? params.pollMs : 3000;

  if (!pageId) return { ok: false, step: 'validate', error: 'Missing: page_id' };
  if (!videoId && !sourcePostId) return { ok: false, step: 'validate', error: 'Missing: video_id (or story_id to resolve it)' };
  if (!finalCtaLink) return { ok: false, step: 'validate', error: 'Missing: final_cta_link' };
  if (!/^https?:\/\//i.test(finalCtaLink)) return { ok: false, step: 'validate', error: 'final_cta_link must be an http(s) URL' };
  if (/\/onecard-cta(?:\/|$)/i.test(finalCtaLink) || /^https?:\/\/api\.pubilo\.com(?:\/|$)/i.test(finalCtaLink)) {
    return { ok: false, step: 'validate', error: 'final_cta_link_must_be_direct_shopee_link' };
  }
  if (!/^https:\/\/s\.shopee\.co\.th(?:\/|$)/i.test(finalCtaLink)) {
    return { ok: false, step: 'validate', error: 'final_cta_link_must_be_direct_shopee_link' };
  }
  if (!adAccount || !templateAdset) return { ok: false, step: 'config', error: 'Missing: ad_account / template_adset' };

  const { ctaType, instagramActorId, instagramUserId } = await readTemplateCreativeMeta(fetchImpl, { userToken, templateAdset });

  if (useObjectStoryId) {
    if (!sourcePostId) return { ok: false, step: 'validate', error: 'Missing: story_id for object_story_id promote' };
    const crBody = {
      name: String(caption || sourcePostId).substring(0, 50),
      ...(instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
      object_story_id: sourcePostId
    };
    const cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
    });
    const crData = cr.data || {};
    if (crData.error) {
      return {
        ok: false,
        step: 'creative',
        error: crData.error.message,
        fb_error_code: crData.error.code,
        fb_error_subcode: crData.error.error_subcode,
        fb_trace_id: crData.error.fbtrace_id,
        object_story_id: sourcePostId,
        cta_link: finalCtaLink,
        video_id: videoId || undefined,
        promote_uses_object_story_id: true
      };
    }
    const creativeId = String(crData.id || '').trim();
    if (!creativeId) return { ok: false, step: 'creative', error: 'creative_id_missing', object_story_id: sourcePostId };
    const adName = String(requestedAdName || sourcePostId || videoId || caption).substring(0, 255);
    const adEntities = await buildAdFromCreative(fetchImpl, {
      userToken,
      adAccount,
      templateAdset,
      creativeId,
      storyId: sourcePostId,
      adName,
      body: { ...body, force_adset_name_tail: true },
      sleep,
      pollMs,
      paused
    });
    if (!adEntities.ok) return adEntities;
    return {
      ok: true,
      phase: 'promote',
      promote_mode: 'object_story_id',
      promote_uses_object_story_id: true,
      source_post_id: sourcePostId,
      story_id: sourcePostId,
      effective_object_story_id: sourcePostId,
      ad_story_id: sourcePostId,
      campaign_id: adEntities.campaign_id,
      campaign_name: adEntities.campaign_name,
      campaign_budget: adEntities.campaign_budget,
      start_time: adEntities.start_time,
      end_time: adEntities.end_time,
      adset_id: adEntities.adset_id,
      ad_id: adEntities.ad_id,
      adset_status: adEntities.adset_status,
      ad_status: adEntities.ad_status,
      ...(adEntities.campaign_status ? { campaign_status: adEntities.campaign_status } : {}),
      ...(paused ? { paused: true } : {}),
      creative_id: creativeId,
      video_id: videoId || undefined,
      cta_link: finalCtaLink,
      promoted_ad_cta_link: finalCtaLink,
      promoted_ad_cta_final: true,
      visible_page_cta_final: true,
      published_to_page: true,
      template_campaign_id: adEntities.template_campaign_id,
      copied_template_settings: adEntities.copied_template_settings,
      ...pickRecoveryDiag(adEntities)
    };
  }

  // Resolve the video id from the source post attachment when the caller did not supply it.
  // Some callers historically passed the full page story id (`<page_id>_<post_id>`) as
  // `video_id`; that is not a Graph video object and fails `fields=thumbnails`. Treat it as
  // missing so the bridge resolves the real attachment target from the source post instead.
  if (videoId.includes('_') && sourcePostId) {
    videoId = '';
  }
  // Fail closed when no video_id can be resolved — promote cannot build the video creative.
  if (!videoId && sourcePostId) {
    videoId = await resolveVideoIdFromSourcePost(fetchImpl, { userToken, sourcePostId });
  }
  if (!videoId) {
    return { ok: false, step: 'resolve_video', error: 'video_id_unresolved', source_post_id: sourcePostId || null };
  }

  // Promote MUST bake the FINAL link into the CTA — that is the whole point (ad CTA == comment
  // link). A LIKE_PAGE template CTA has no destination link, so it would silently drop the
  // final link. Fail closed BEFORE creating any creative/ad rather than ship a linkless ad.
  if (ctaType === 'LIKE_PAGE') {
    return { ok: false, step: 'creative', error: 'template_cta_type_does_not_support_final_link', cta_type: 'LIKE_PAGE', video_id: videoId };
  }

  // Thumbnail: reuse the supplied thumb when provided, else poll the video.
  let thumb = /^https?:\/\//i.test(thumbnailUrl) ? thumbnailUrl : null;
  if (!thumb) {
    for (let i = 0; i < thumbPolls; i++) {
      await sleep(pollMs);
      const t = await gJson(fetchImpl, `${GRAPH}/${videoId}?access_token=${encodeURIComponent(userToken)}&fields=thumbnails`);
      const td = t.data;
      if (td.error) return { ok: false, step: 'thumbnails', error: td.error.message || 'Graph thumbnails error', fb_error_code: td.error.code, fb_error_subcode: td.error.error_subcode, fb_trace_id: td.error.fbtrace_id, video_id: videoId };
      if (td.thumbnails && td.thumbnails.data && td.thumbnails.data.length >= 1) { thumb = td.thumbnails.data[0].uri; break; }
    }
  }
  if (!thumb) return { ok: false, step: 'thumbnails', error: 'Timeout (FB still processing)', video_id: videoId };

  // Build the NEW paid ad creative via video_data.video_id with the FINAL Shopee CTA link.
  const ctaSpec = { type: ctaType, value: { link: finalCtaLink, link_format: 'VIDEO_LPP' } };
  const crBody = {
    name: String(caption).substring(0, 50),
    ...(instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
    object_story_spec: {
      page_id: pageId,
      ...(instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
      ...(instagramUserId ? { instagram_user_id: instagramUserId } : {}),
      video_data: { video_id: videoId, message: caption, image_url: thumb, call_to_action: ctaSpec }
    }
  };
  const cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
  });
  const crData = cr.data;
  if (crData.error) return { ok: false, step: 'creative', error: crData.error.message, fb_error_code: crData.error.code, fb_error_subcode: crData.error.error_subcode, fb_trace_id: crData.error.fbtrace_id, cta_type: ctaType, cta_link: finalCtaLink, video_id: videoId };

  // The ad creative mints its OWN dark story (we do NOT publish it — the visible post is the
  // source page post). Poll the new story id (ad_story_id) for the adset name + reporting.
  let adStoryId = null;
  for (let i = 0; i < storyPolls; i++) {
    await sleep(pollMs);
    const cc = await gJson(fetchImpl, `${GRAPH}/${crData.id}?access_token=${encodeURIComponent(userToken)}&fields=effective_object_story_id`);
    if (cc.data && cc.data.effective_object_story_id) { adStoryId = cc.data.effective_object_story_id; break; }
  }
  if (!adStoryId) return { ok: false, step: 'story_id', error: 'Timeout (FB still creating ad story)', creative_id: crData.id };
  const adName = String(requestedAdName || sourcePostId || videoId || caption).substring(0, 255);

  // Campaign / adset / ad / activate — the adset is named after the SOURCE page post (when
  // known) so ads stay grouped with the visible post the comment lives on.
  const adEntities = await buildAdFromCreative(fetchImpl, {
    userToken, adAccount, templateAdset, creativeId: crData.id, storyId: sourcePostId || adStoryId, adName, body, sleep, pollMs, paused
  });
  if (!adEntities.ok) return adEntities;

  return {
    ok: true,
    phase: 'promote',
    // The source page post (where the comment lives) — DISTINCT from the ad's own dark story.
    source_post_id: sourcePostId || null,
    ad_story_id: adStoryId,
    campaign_id: adEntities.campaign_id,
    campaign_name: adEntities.campaign_name,
    // CAMPAIGN-level (CBO) daily budget in minor units (daily path). Replaces the old adset budget.
    campaign_budget: adEntities.campaign_budget,
    start_time: adEntities.start_time,
    end_time: adEntities.end_time,
    adset_id: adEntities.adset_id,
    ad_id: adEntities.ad_id,
    // PAUSED for ad-only, ACTIVE for the default path (lets callers/history flag a non-spending ad).
    adset_status: adEntities.adset_status,
    ad_status: adEntities.ad_status,
    ...(adEntities.campaign_status ? { campaign_status: adEntities.campaign_status } : {}),
    ...(paused ? { paused: true } : {}),
    creative_id: crData.id,
    video_id: videoId,
    cta_link: finalCtaLink,
    // The PROMOTED AD creative carries the final link (ad CTA == comment link). This is the
    // promoted-ad CTA report only: no Worker redirect and no pre-final link.
    promoted_ad_cta_link: finalCtaLink,
    promoted_ad_cta_final: true,
    // Promote does NOT update the organic page post CTA — the only CTA it sets is on the new
    // paid ad creative. Never claim a visible page CTA success here.
    visible_page_cta_final: false,
    published_to_page: false,
    template_campaign_id: adEntities.template_campaign_id,
    copied_template_settings: adEntities.copied_template_settings,
    ...pickRecoveryDiag(adEntities)
  };
}

// POST /update-cta — update the VISIBLE page post / Reel CTA to the final post-specific Shopee
// shortlink after story_id exists. This is the step that changes what users actually see on the
// Reel, and is DISTINCT from /promote (which only sets the PAID ad creative's CTA). Live-proven
// mutation order (the reason this exists: editing the upload/ad video id "succeeds" but does NOT
// change the visible post — only the attachment target id does):
//   GET  /{story_id}?fields=call_to_action,permalink_url,attachments{target,type,url}
//        → cta_update_target_id = attachments.data[0].target.id (the visible Reel/video object)
//   POST /{cta_update_target_id}  call_to_action={ type, value:{ link, link_format:'VIDEO_LPP' } }
//   GET  /{story_id}?fields=call_to_action,permalink_url,attachments{target}  (read back to verify)
// Uses the PAGE token (a page post's CTA can only be edited with the page token); fails closed
// (page_token_not_found) and NEVER uses the user token to mutate. The final link must be a direct
// Shopee shortlink (never a Worker redirect / onecard-cta / api.pubilo.com URL) so the visible
// Facebook UI never carries a redirect. No token is ever returned or logged.
async function updateVisiblePostCta(fetchImpl, params = {}) {
  const userToken = params.userToken;
  const pageId = String(params.pageId || params.page_id || '').trim();
  const storyId = String(params.storyId || params.story_id || params.postId || params.post_id || '').trim();
  const finalCtaLink = String(params.finalCtaLink || params.final_cta_link || params.shortlink || '').trim();
  const ctaType = (String(params.ctaType || params.cta_type || 'SHOP_NOW').trim() || 'SHOP_NOW');
  // Conservative fallback target only when the visible post exposes no attachment target id.
  const fallbackTargetId = String(params.reelId || params.reel_id || params.videoId || params.video_id || '').trim();

  if (!pageId || !storyId) return { ok: false, step: 'validate', error: 'Missing: page_id, story_id' };
  if (!finalCtaLink) return { ok: false, step: 'validate', error: 'Missing: final_cta_link' };
  if (!/^https?:\/\//i.test(finalCtaLink)) return { ok: false, step: 'validate', error: 'final_cta_link must be an http(s) URL' };
  if (/\/onecard-cta(?:\/|$)/i.test(finalCtaLink) || /^https?:\/\/api\.pubilo\.com(?:\/|$)/i.test(finalCtaLink)) {
    return { ok: false, step: 'validate', error: 'final_cta_link_must_be_direct_shopee_link' };
  }
  if (!/^https:\/\/s\.shopee\.co\.th(?:\/|$)/i.test(finalCtaLink)) {
    return { ok: false, step: 'validate', error: 'final_cta_link_must_be_direct_shopee_link' };
  }
  if (!userToken) return { ok: false, step: 'session', error: 'no_session' };

  // Page post CTA edits require the PAGE token. Fail closed when the session does not administer
  // the page — never fall back to the user token.
  const info = await resolvePageToken(fetchImpl, userToken, pageId);
  if (info.error) return { ok: false, status: 200, step: 'pages', error: info.error, page_id: pageId };
  if (!info.pageToken) return { ok: false, status: 403, step: 'page_token', error: 'page_token_not_found', page_id: pageId };

  // 1. Read the visible post to resolve the CTA update target (the attachment target id is the
  //    visible Reel/video object). Updating the story id itself does not change the visible CTA.
  let ctaUpdateTargetId = '';
  let permalinkUrl = '';
  try {
    const pre = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(storyId)}?fields=call_to_action,permalink_url,attachments{target,type,url}&access_token=${encodeURIComponent(info.pageToken)}`);
    if (pre.data && !pre.data.error) {
      const att = pre.data.attachments && pre.data.attachments.data;
      const target = Array.isArray(att) && att[0] && att[0].target;
      if (target && target.id) ctaUpdateTargetId = String(target.id).trim();
      if (pre.data.permalink_url) permalinkUrl = String(pre.data.permalink_url);
    }
  } catch {}
  // Conservative fallback: the supplied reel/video id, then the story id itself.
  if (!ctaUpdateTargetId) ctaUpdateTargetId = fallbackTargetId || storyId;

  // 2. Apply the CTA on the visible target.
  const ctaSpec = { type: ctaType, value: { link: finalCtaLink, link_format: 'VIDEO_LPP' } };
  const upd = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(ctaUpdateTargetId)}?access_token=${encodeURIComponent(info.pageToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ call_to_action: ctaSpec })
  });
  if (upd.data && upd.data.error) {
    return {
      ok: false, step: 'update', error: String(upd.data.error.message || 'cta_update_failed').substring(0, 200),
      fb_error_code: upd.data.error.code, fb_error_subcode: upd.data.error.error_subcode, fb_trace_id: upd.data.error.fbtrace_id,
      page_id: pageId, story_id: storyId, cta_update_target_id: ctaUpdateTargetId, final_cta_link: finalCtaLink
    };
  }

  // 3. Read back the visible post CTA to verify the change applied (a POST that "succeeds" but
  //    leaves the visible CTA unchanged must be reported as visible_page_cta_final:false).
  let confirmedCtaLink = '';
  try {
    const post = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(storyId)}?fields=call_to_action,permalink_url,attachments{target}&access_token=${encodeURIComponent(info.pageToken)}`);
    if (post.data && !post.data.error) {
      const cta = post.data.call_to_action;
      const val = cta && cta.value;
      confirmedCtaLink = String((val && (val.link || val.link_caption)) || '').trim();
      if (!permalinkUrl && post.data.permalink_url) permalinkUrl = String(post.data.permalink_url);
    }
  } catch {}

  const visiblePageCtaFinal = !!confirmedCtaLink && confirmedCtaLink === finalCtaLink;
  return {
    ok: true,
    phase: 'update_cta',
    page_id: pageId,
    story_id: storyId,
    cta_update_target_id: ctaUpdateTargetId,
    final_cta_link: finalCtaLink,
    // The verified visible CTA link read back from Graph (empty if the read-back did not echo it).
    visible_page_cta_link: confirmedCtaLink,
    // True only when the read-back confirms the visible post now carries the final link.
    visible_page_cta_final: visiblePageCtaFinal,
    permalink_url: permalinkUrl || undefined
  };
}

// POST /repair-ad-cta — repair the PAID ad creative's CTA link in Ads Manager. DISTINCT from
// /update-cta (which edits the VISIBLE page post / Reel CTA) and /promote (which builds a brand-new
// paid ad from scratch). The ad-only ACTIVE flow creates the paid ad BEFORE the final post-specific
// shortlink is minted, so the paid creative carries a PLACEHOLDER link (sub2/sub3 unset — the live
// incident where Ads Manager previews showed utm_content=…AD----). Graph does NOT allow editing an
// existing adcreative's destination link inline, so this:
//   1. reads the OLD creative (object_story_spec) to backfill video_id / image_url / message so the
//      new creative is identical except for the CTA link,
//   2. creates a NEW adcreative whose object_story_spec.video_data.call_to_action.value.link is the
//      FINAL direct Shopee link,
//   3. re-points the existing ad at the new creative (POST /{ad_id} { creative:{ creative_id } }),
//   4. reads back the ad's creative to CONFIRM the paid CTA now carries the final link.
// Uses the user (ad-account) token for ad-account writes; no page token is needed. The final link
// MUST be a direct https://s.shopee.co.th/… link (never a Worker redirect / onecard-cta /
// api.pubilo.com). No token is ever returned or logged.
async function repairPaidAdCta(fetchImpl, params = {}) {
  const sleep = params.sleep || realSleep;
  const userToken = params.userToken;
  const pageId = String(params.pageId || params.page_id || '').trim();
  const adId = String(params.adId || params.ad_id || '').trim();
  let oldCreativeId = String(params.creativeId || params.creative_id || '').trim();
  let videoId = String(params.videoId || params.video_id || '').trim();
  const finalCtaLink = String(params.finalCtaLink || params.final_cta_link || params.shortlink || '').trim();
  let caption = params.caption != null ? String(params.caption) : '';
  let thumbnailUrl = String(params.thumbnailUrl || params.thumbnail_url || params.image_url || '').trim();
  const adAccount = String(params.adAccount || params.ad_account || params.defaultAdAccount || '').trim();
  const templateAdset = String(params.templateAdset || params.template_adset || params.defaultTemplateAdset || '').trim();
  const sourceStoryId = String(params.sourceStoryId || params.source_story_id || params.storyId || params.story_id || '').trim();
  const requestedAdName = String(params.adName || params.ad_name || '').trim();
  const thumbPolls = Number.isInteger(params.thumbPolls) ? params.thumbPolls : 60;
  const pollMs = Number.isInteger(params.pollMs) ? params.pollMs : 3000;

  if (!pageId || !adId) return { ok: false, step: 'validate', error: 'Missing: page_id, ad_id' };
  if (!finalCtaLink) return { ok: false, step: 'validate', error: 'Missing: final_cta_link' };
  if (!/^https?:\/\//i.test(finalCtaLink)) return { ok: false, step: 'validate', error: 'final_cta_link must be an http(s) URL' };
  // The paid CTA must point at a DIRECT Shopee shortlink — never a Worker redirect (the whole point
  // of the repair is to surface the real sub2/sub3-bearing Shopee link in the paid ad preview).
  if (/\/onecard-cta(?:\/|$)/i.test(finalCtaLink) || /^https?:\/\/api\.pubilo\.com(?:\/|$)/i.test(finalCtaLink)) {
    return { ok: false, step: 'validate', error: 'final_cta_link_must_be_direct_shopee_link' };
  }
  if (!/^https:\/\/s\.shopee\.co\.th(?:\/|$)/i.test(finalCtaLink)) {
    return { ok: false, step: 'validate', error: 'final_cta_link_must_be_direct_shopee_link' };
  }
  if (!userToken) return { ok: false, step: 'session', error: 'no_session' };
  if (!adAccount) return { ok: false, step: 'config', error: 'Missing: ad_account' };

  // Resolve the OLD creative id off the ad when the caller did not supply it (defensive).
  if (!oldCreativeId) {
    try {
      const adCr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(adId)}?fields=creative{id}&access_token=${encodeURIComponent(userToken)}`);
      const cid = adCr.data && adCr.data.creative && adCr.data.creative.id;
      if (cid) oldCreativeId = String(cid).trim();
    } catch {}
  }

  // Read the OLD creative's object_story_spec to backfill the video/image/message so the NEW creative
  // is identical except for the CTA link. Best-effort; the caller-supplied fields win when present.
  let oldPaidCtaLink = '';
  if (oldCreativeId) {
    try {
      const old = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(oldCreativeId)}?fields=object_story_spec,call_to_action_type&access_token=${encodeURIComponent(userToken)}`);
      const spec = old.data && old.data.object_story_spec;
      const vd = spec && spec.video_data;
      if (vd) {
        if (!videoId && vd.video_id) videoId = String(vd.video_id).trim();
        if (!thumbnailUrl && vd.image_url) thumbnailUrl = String(vd.image_url).trim();
        if (!caption && vd.message != null) caption = String(vd.message);
        const oldLink = vd.call_to_action && vd.call_to_action.value && vd.call_to_action.value.link;
        if (oldLink) oldPaidCtaLink = String(oldLink).trim();
      }
    } catch {}
  }

  // Resolve the video id from the source post attachment when it is still unknown.
  if (!videoId && sourceStoryId) {
    videoId = await resolveVideoIdFromSourcePost(fetchImpl, { userToken, sourcePostId: sourceStoryId });
  }
  if (!videoId) return { ok: false, step: 'resolve_video', error: 'video_id_unresolved', ad_id: adId, old_creative_id: oldCreativeId || null };

  // CTA type + IG actor from the template adset's first creative (mirror create-ad/promote shape).
  const { ctaType, instagramActorId, instagramUserId } = await readTemplateCreativeMeta(fetchImpl, { userToken, templateAdset });
  // A LIKE_PAGE template CTA has no destination link, so it cannot carry the final link — fail closed
  // before creating any creative rather than ship a linkless paid ad.
  if (ctaType === 'LIKE_PAGE') {
    return { ok: false, step: 'creative', error: 'template_cta_type_does_not_support_final_link', cta_type: 'LIKE_PAGE', ad_id: adId, video_id: videoId };
  }

  // Thumbnail: reuse the backfilled/supplied image, else poll the video.
  let thumb = /^https?:\/\//i.test(thumbnailUrl) ? thumbnailUrl : null;
  if (!thumb) {
    for (let i = 0; i < thumbPolls; i++) {
      await sleep(pollMs);
      const t = await gJson(fetchImpl, `${GRAPH}/${videoId}?access_token=${encodeURIComponent(userToken)}&fields=thumbnails`);
      const td = t.data;
      if (td.error) return { ok: false, step: 'thumbnails', error: td.error.message || 'Graph thumbnails error', fb_error_code: td.error.code, fb_error_subcode: td.error.error_subcode, fb_trace_id: td.error.fbtrace_id, ad_id: adId, video_id: videoId };
      if (td.thumbnails && td.thumbnails.data && td.thumbnails.data.length >= 1) { thumb = td.thumbnails.data[0].uri; break; }
    }
  }
  if (!thumb) return { ok: false, step: 'thumbnails', error: 'Timeout (FB still processing)', ad_id: adId, video_id: videoId };

  // 1. Create a NEW paid ad creative with the FINAL Shopee CTA link baked into video_data.
  const ctaSpec = { type: ctaType, value: { link: finalCtaLink, link_format: 'VIDEO_LPP' } };
  const crBody = {
    name: String(caption || requestedAdName || 'ad').substring(0, 50),
    ...(instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
    object_story_spec: {
      page_id: pageId,
      ...(instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
      ...(instagramUserId ? { instagram_user_id: instagramUserId } : {}),
      video_data: { video_id: videoId, message: caption, image_url: thumb, call_to_action: ctaSpec }
    }
  };
  const cr = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${adAccount}/adcreatives?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(crBody)
  });
  const crData = cr.data;
  if (crData.error) return { ok: false, step: 'creative', error: crData.error.message, fb_error_code: crData.error.code, fb_error_subcode: crData.error.error_subcode, fb_trace_id: crData.error.fbtrace_id, ad_id: adId, video_id: videoId, old_creative_id: oldCreativeId || null };
  const newCreativeId = String(crData.id || '').trim();
  if (!newCreativeId) return { ok: false, step: 'creative', error: 'new_creative_id_missing', ad_id: adId, old_creative_id: oldCreativeId || null };

  // 2. Re-point the existing ad at the new creative (Graph cannot edit a live creative's link inline).
  const upd = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(adId)}?access_token=${encodeURIComponent(userToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creative: { creative_id: newCreativeId } })
  });
  if (upd.data && upd.data.error) {
    return {
      ok: false, step: 'update_ad', error: String(upd.data.error.message || 'ad_creative_update_failed').substring(0, 200),
      fb_error_code: upd.data.error.code, fb_error_subcode: upd.data.error.error_subcode, fb_trace_id: upd.data.error.fbtrace_id,
      ad_id: adId, old_creative_id: oldCreativeId || null, new_creative_id: newCreativeId, final_cta_link: finalCtaLink
    };
  }

  // 3. Read back the ad's creative to CONFIRM the paid CTA now carries the final link. A POST that
  // "succeeds" but leaves the old creative in place must be reported as paid_ad_cta_final:false.
  let confirmedCreativeId = '';
  let confirmedCtaLink = '';
  try {
    const rb = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(adId)}?fields=creative{id,object_story_spec}&access_token=${encodeURIComponent(userToken)}`);
    const creative = rb.data && rb.data.creative;
    if (creative) {
      if (creative.id) confirmedCreativeId = String(creative.id).trim();
      const vd = creative.object_story_spec && creative.object_story_spec.video_data;
      const link = vd && vd.call_to_action && vd.call_to_action.value && vd.call_to_action.value.link;
      if (link) confirmedCtaLink = String(link).trim();
    }
  } catch {}

  const paidAdCtaFinal = !!confirmedCreativeId && confirmedCreativeId === newCreativeId && confirmedCtaLink === finalCtaLink;
  return {
    ok: true,
    phase: 'repair_ad_cta',
    page_id: pageId,
    ad_id: adId,
    old_creative_id: oldCreativeId || null,
    new_creative_id: newCreativeId,
    video_id: videoId,
    final_cta_link: finalCtaLink,
    // The verified paid ad CTA link read back from Graph (empty if the read-back did not echo it).
    paid_ad_cta_link: confirmedCtaLink,
    // True only when the read-back confirms the ad now points at the NEW creative carrying the link.
    paid_ad_cta_final: paidAdCtaFinal,
    ...(oldPaidCtaLink ? { old_paid_ad_cta_link: oldPaidCtaLink } : {})
  };
}

// POST /pause-ad-only — turn OFF (status=PAUSED) one or more FINISHED system-created ad objects
// (campaign / adset / ad). DISTINCT from every other ad route: it makes NO new objects and CHANGES
// NOTHING except the run state. The operator contract is close/off, NEVER destroy:
//   • the ONLY write this performs is `status: 'PAUSED'`,
//   • it NEVER issues a DELETE request and NEVER sets status='DELETED',
//   • each object is read back (status + effective_status) so the caller can PROVE it is paused.
// Uses the user (ad-account) token for ad-object writes; no page token is needed. At least one of
// campaign_id / adset_id is required; ad_id is optional. No token is ever returned or logged.
async function pauseAdOnlyObjects(fetchImpl, params = {}) {
  const userToken = params.userToken;
  const campaignId = String(params.campaignId || params.campaign_id || '').trim();
  const adsetId = String(params.adsetId || params.adset_id || '').trim();
  const adId = String(params.adId || params.ad_id || '').trim();

  if (!campaignId && !adsetId) return { ok: false, step: 'validate', error: 'Missing: campaign_id or adset_id' };
  if (!userToken) return { ok: false, step: 'session', error: 'no_session' };

  // Pause ONE ad object by id. The request body is EXACTLY { status: 'PAUSED' } — never DELETED,
  // never a DELETE method — then a read-back of status/effective_status confirms the off-state.
  const pauseOne = async (objectId) => {
    const upd = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(objectId)}?access_token=${encodeURIComponent(userToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'PAUSED' })
    });
    if (upd.data && upd.data.error) {
      return {
        ok: false,
        error: String(upd.data.error.message || 'pause_failed').substring(0, 200),
        fb_error_code: upd.data.error.code, fb_error_subcode: upd.data.error.error_subcode, fb_trace_id: upd.data.error.fbtrace_id
      };
    }
    let status = '';
    let effectiveStatus = '';
    try {
      const rb = await gJson(fetchImpl, `${GRAPH}/${GRAPH_V}/${encodeURIComponent(objectId)}?fields=status,effective_status&access_token=${encodeURIComponent(userToken)}`);
      if (rb.data && !rb.data.error) {
        status = String(rb.data.status || '').trim();
        effectiveStatus = String(rb.data.effective_status || '').trim();
      }
    } catch {}
    return { ok: true, status, effective_status: effectiveStatus };
  };

  const result = { ok: true, phase: 'pause_ad_only' };
  if (campaignId) { result.campaign_id = campaignId; result.campaign = await pauseOne(campaignId); }
  if (adsetId) { result.adset_id = adsetId; result.adset = await pauseOne(adsetId); }
  if (adId) { result.ad_id = adId; result.ad = await pauseOne(adId); }

  // Overall ok only when every attempted object paused without a Graph error.
  result.ok = [result.campaign, result.adset, result.ad].filter(Boolean).every((r) => r && r.ok);
  return result;
}

module.exports = {
  GRAPH,
  GRAPH_V,
  resolveSessionToken,
  hasLoggedInSession,
  closeSession,
  makeBrowserGraphFetch,
  listPagesPublic,
  resolvePageToken,
  publishStoryToPage,
  buildAdFromCreative,
  readTemplateSettings,
  readTemplateCreativeMeta,
  publishPageVideoPost,
  postOneCardVideo,
  pageComment,
  editPageCommentLink,
  createAd,
  promoteOneCardPost,
  updateVisiblePostCta,
  repairPaidAdCta,
  pauseAdOnlyObjects,
  downloadVideoToBuffer,
  buildVideoMultipart,
  uploadAdVideoMultipart,
  uploadAdVideoFromUrl,
  MAX_DOWNLOAD_VIDEO_BYTES
};
