const {
  app, BrowserWindow, Tray, Menu, clipboard, nativeImage, Notification, net,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const nodeFetch = require("node-fetch");
const os = require("os");
const { execFileSync, spawn } = require("child_process");

function ensureMacBackgroundOnly() {
  if (process.platform !== "darwin") return;
  try { app.setActivationPolicy("accessory"); } catch {}
  try { app.dock?.hide(); } catch {}
  try {
    const plistPath = path.resolve(path.dirname(process.execPath), "..", "Info.plist");
    if (!fs.existsSync(plistPath)) return;
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :LSUIElement true", plistPath], { stdio: "ignore" });
    } catch {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", "Add :LSUIElement bool true", plistPath], { stdio: "ignore" });
    }
  } catch {}
}

ensureMacBackgroundOnly();
if (process.env.ONECARD_REMOTE_DEBUG_PORT) {
  try { app.commandLine.appendSwitch("remote-debugging-port", String(process.env.ONECARD_REMOTE_DEBUG_PORT)); } catch {}
}

const LOCAL_PORT = 3847;
const TUNNEL_NAME = "onecard-wwoom";
const TUNNEL_ID = "13056541-56b1-4c65-aec9-8b5112b14c2e";
const TUNNEL_HOST = "video-onecard.wwoom.com";
const TUNNEL_URL = `https://${TUNNEL_HOST}`;
const CLOUDFLARED_BIN = "/opt/homebrew/bin/cloudflared";
const ADS_MANAGER_URL = "https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1148837732288721";

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

const storePath = path.join(app.getPath("userData"), "appdata.json");
let mainWindow = null, tray = null, accessToken = null, fbDtsg = null, userName = null, isQuitting = false;
let tunnelProc = null;
let tunnelReady = false;
let tunnelError = null;
let sessionReadyLogged = false;

// FB Web comment-edit capture state (in-memory only — never persisted, never
// returned raw). Populated by the page interceptor when the operator edits a
// comment inside the Ads Manager window; replayed by POST /fb-comment/edit.
// rawBody/parsedForm hold the captured x-www-form-urlencoded GraphQL mutation
// (incl. fb_dtsg/doc_id) and MUST NOT leave the process in any response.
let fbCommentCapture = {
  captured: false,
  capturedAt: null,   // ISO string
  friendlyName: null, // fb_api_req_friendly_name (safe to expose)
  docIdPresent: false,
  rawBody: null,      // captured URL-encoded body (memory-only)
  parsedForm: null,   // parsed form fields (memory-only)
};
let fbCommentInterceptorInstalled = false;

function safeLog(...args) {
  try { process.stdout.write(`${args.join(" ")}\n`); } catch (e) { if (e?.code !== "EPIPE") throw e; }
}

process.stdout.on("error", (e) => { if (e?.code !== "EPIPE") throw e; });
process.stderr.on("error", (e) => { if (e?.code !== "EPIPE") throw e; });

function loadStore() { try { return JSON.parse(fs.readFileSync(storePath, "utf8")); } catch { return {}; } }
function saveStore(d) { fs.writeFileSync(storePath, JSON.stringify({ ...loadStore(), ...d }), "utf8"); }

function extractVideoIdFromAssetUrl(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const galleryMatch = parsed.pathname.match(/\/api\/gallery\/([^/]+)\/asset\//i);
    if (galleryMatch?.[1]) return decodeURIComponent(galleryMatch[1]).trim();
    const r2Match = parsed.pathname.match(/\/videos\/([a-zA-Z0-9_-]+)(?:_(?:original|line_original|thumb))?\.(?:mp4|webm|mov|m4v|webp|jpg|jpeg|png)$/i);
    if (r2Match?.[1]) return decodeURIComponent(r2Match[1]).trim();
  } catch {
    const galleryMatch = raw.match(/\/api\/gallery\/([^/?#]+)\/asset\//i);
    if (galleryMatch?.[1]) return decodeURIComponent(galleryMatch[1]).trim();
    const r2Match = raw.match(/\/videos\/([a-zA-Z0-9_-]+)(?:_(?:original|line_original|thumb))?\.(?:mp4|webm|mov|m4v|webp|jpg|jpeg|png)(?:[?#]|$)/i);
    if (r2Match?.[1]) return decodeURIComponent(r2Match[1]).trim();
  }
  return "";
}

function resolveCreateAdName(body, videoUrl, existingVideoId) {
  return String(
    body.ad_name
    || body.source_video_id
    || body.system_video_id
    || extractVideoIdFromAssetUrl(videoUrl)
    || existingVideoId
    || ""
  ).trim();
}

// Electron net.request with session cookies
function elFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: opts.method || "GET", useSessionCookies: true });
    if (opts.headers) Object.entries(opts.headers).forEach(([k, v]) => req.setHeader(k, v));
    let body = "";
    req.on("response", (res) => {
      res.on("data", (c) => body += c.toString());
      res.on("end", () => resolve({ status: res.statusCode, text: () => body, json: () => JSON.parse(body) }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ---- FB Web comment-edit capture + replay helpers -------------------------
// Page-side interceptor: monkeypatches fetch/XMLHttpRequest in mainWindow and
// stashes the most recent /api/graphql/ body that looks like an edit-comment
// mutation onto window.__onecardEditCapture. Idempotent (guarded by a flag).
const FB_COMMENT_INTERCEPTOR_JS = `(function(){
  if (window.__onecardEditCaptureInstalled) return 'already';
  window.__onecardEditCaptureInstalled = true;
  if (typeof window.__onecardEditCapture === 'undefined') window.__onecardEditCapture = null;
  function looksLikeEdit(body){
    if (typeof body !== 'string') return false;
    if (body.indexOf('useCometUFIEditCommentMutation') !== -1) return true;
    var m = body.match(/fb_api_req_friendly_name=([^&]+)/);
    if (m) { try { if (/EditComment/i.test(decodeURIComponent(m[1]))) return true; } catch(e){} }
    return false;
  }
  function store(url, body){
    try {
      if (typeof url === 'string' && url.indexOf('/api/graphql/') !== -1 && looksLikeEdit(body)) {
        window.__onecardEditCapture = { url: String(url), body: String(body), at: Date.now() };
      }
    } catch(e){}
  }
  try {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function(input, init){
        try {
          var url = (typeof input === 'string') ? input : (input && input.url);
          var body = init && init.body;
          if (typeof body === 'string') store(url, body);
        } catch(e){}
        return origFetch.apply(this, arguments);
      };
    }
  } catch(e){}
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url){ this.__onecardUrl = url; return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(body){ try { if (typeof body === 'string') store(this.__onecardUrl, body); } catch(e){} return origSend.apply(this, arguments); };
  } catch(e){}
  return 'installed';
})()`;

function fbParseForm(rawBody) {
  const out = {};
  try {
    const sp = new URLSearchParams(String(rawBody || ""));
    for (const [k, v] of sp.entries()) out[k] = v;
  } catch {}
  return out;
}

// Sanitized view of capture state — safe for HTTP responses (no token, cookie,
// fb_dtsg, or raw body).
function fbCommentSanitizedState() {
  return {
    captured: !!fbCommentCapture.captured,
    doc_id_present: !!fbCommentCapture.docIdPresent,
    friendly_name: fbCommentCapture.friendlyName || null,
    captured_at: fbCommentCapture.capturedAt || null,
  };
}

async function fbInstallCommentInterceptor() {
  if (!mainWindow) return false;
  try {
    await mainWindow.webContents.executeJavaScript(FB_COMMENT_INTERCEPTOR_JS, true);
    fbCommentInterceptorInstalled = true;
    return true;
  } catch { return false; }
}

// Pull the latest captured mutation from the page into the in-memory state.
async function fbPullCaptureFromPage() {
  if (!mainWindow) return;
  try {
    const raw = await mainWindow.webContents.executeJavaScript("JSON.stringify(window.__onecardEditCapture || null)");
    const cap = raw ? JSON.parse(raw) : null;
    if (cap && typeof cap.body === "string" && cap.body) {
      const form = fbParseForm(cap.body);
      fbCommentCapture = {
        captured: true,
        capturedAt: cap.at ? new Date(cap.at).toISOString() : new Date().toISOString(),
        friendlyName: form.fb_api_req_friendly_name || null,
        docIdPresent: !!form.doc_id,
        rawBody: String(cap.body),
        parsedForm: form,
      };
    }
  } catch {}
}

// Recursively walk the GraphQL `variables` object and retarget fields that look
// like a comment id or a comment message/body/text.
//
// Comment-id handling is deliberately conservative. A captured edit mutation
// carries Facebook's OPAQUE internal GraphQL comment id (e.g. a ~56-char string),
// NOT the numeric Graph API comment_id (e.g. 129313..._226...). Blindly swapping
// the opaque id for a numeric one makes Facebook reject the mutation
// (facebook_graphql_error — observed in live testing). So by default we PRESERVE
// an opaque captured id and only retarget the message. This means the caller MUST
// capture on the exact comment being edited; the post-edit verification against
// the numeric Graph comment_id is the safety check that we edited the right one.
//
// We only replace the captured comment id when it already looks like a numeric
// Graph id, or when the caller explicitly opts in with force_comment_id_replace.
// Returns message/comment-id update counts plus whether an opaque id was kept.
function fbApplyEditVariables(variables, targetCommentId, targetMessage, forceReplace) {
  let messageUpdated = 0;
  let commentIdUpdated = 0;
  let commentIdPreserved = false;
  const COMMENT_ID_KEY = /comment[_]?id/i;
  const MESSAGE_KEY = /^(message|body|text)$/i;
  // A numeric Graph comment_id is digits, optionally page_comment underscore form.
  const targetIsNumeric = /^[0-9]+(_[0-9]+)?$/.test(String(targetCommentId));
  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (MESSAGE_KEY.test(k)) {
          if (typeof v === "string") { node[k] = targetMessage; messageUpdated++; }
          else if (v && typeof v === "object") {
            if (typeof v.text === "string") { v.text = targetMessage; messageUpdated++; }
            else walk(v);
          }
        } else if (COMMENT_ID_KEY.test(k) && (typeof v === "string" || typeof v === "number")) {
          const captured = String(v);
          const capturedIsNumeric = /^[0-9]+(_[0-9]+)?$/.test(captured);
          // Opaque captured id + numeric target → keep the opaque id unless forced.
          const looksOpaque = !capturedIsNumeric && captured.length > 30 && targetIsNumeric;
          if (looksOpaque && !forceReplace) {
            commentIdPreserved = true;
          } else {
            node[k] = targetCommentId; commentIdUpdated++;
          }
        } else {
          walk(v);
        }
      }
    }
  }
  walk(variables);
  return { messageUpdated, commentIdUpdated, commentIdPreserved };
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  mainWindow.loadURL(ADS_MANAGER_URL);
  mainWindow.on("close", (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } });

  // Extract __accessToken + fb_dtsg after page loads
  mainWindow.webContents.on("did-finish-load", extractFromPage);
  setInterval(extractFromPage, 15000);

  // Re-install the comment-edit interceptor after navigations/reloads once the
  // operator has opted in (the page JS context is wiped on each load).
  mainWindow.webContents.on("did-finish-load", () => { if (fbCommentInterceptorInstalled) fbInstallCommentInterceptor(); });

  // Auto-reload Ads Manager ทุก 2 ชั่วโมง เพื่อ refresh token/cookies
  setInterval(() => {
    console.log('Auto-reload Ads Manager...');
    mainWindow.loadURL(ADS_MANAGER_URL);
  }, 2 * 60 * 60 * 1000);
}

async function extractFromPage() {
  try {
    const data = await mainWindow.webContents.executeJavaScript(`
      (function() {
        var t = window.__accessToken || null;
        var d = null;
        try { d = require("DTSGInitData").token; } catch(e) {}
        if (!d) { try { var m = document.documentElement.innerHTML.match(/"dtsg":\\{"token":"([^"]+)"/); if(m) d = m[1]; } catch(e) {} }
        var u = null;
        try { var m2 = document.cookie.match(/c_user=([0-9]+)/); u = m2 ? m2[1] : null; } catch(e) {}
        return JSON.stringify({token: t, dtsg: d, userId: u});
      })()
    `);
    const p = JSON.parse(data);
    if (p.token) accessToken = p.token;
    if (p.dtsg) fbDtsg = p.dtsg;
    if (p.userId) userName = "User " + p.userId;
    if (accessToken) {
      saveStore({ accessToken, fbDtsg, userName });
      updateTray();
      if (!sessionReadyLogged) {
        sessionReadyLogged = true;
        safeLog("Session ready");
      }
    }
  } catch {}
}

function updateTray() {
  const s = accessToken ? `✓ ${userName || "Connected"}` : "⏳ Loading...";
  const tunnelLine = tunnelReady ? `Tunnel: ${TUNNEL_URL}` : `Tunnel: ${tunnelError || "starting..."}`;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "FB Video One Card Post", enabled: false }, { label: s, enabled: false },
    { label: `API: http://localhost:${LOCAL_PORT}`, enabled: false },
    { label: tunnelLine, enabled: false },
    { type: "separator" },
    { label: "Show Ads Manager", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const dir = path.join(__dirname, "assets"), icon = path.join(dir, "trayIconTemplate.png");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(icon)) fs.writeFileSync(icon, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAhklEQVR4Ae3SMQrCQBCF4X+LFIKFWHgAb+BhPIm38AAewMZKsLCw0CKN4BZb7MImkV3BwvrBwMDM8DFJKKUw/EewgDMe8YSJYwxjHPCEN5xwwBNOOCOhwA1LbLHCGnuckFBijw222GCNE85IKHHFDntscMQZCRWuOOCAI85IqHHDESecccEbfgCoGirZUMzpYwAAAABJRU5ErkJggg==", "base64"));
  tray = new Tray(icon);
  tray.on("click", () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show());
  updateTray();
}

function ensureTunnelConfig() {
  const configPath = path.join(app.getPath("userData"), "cloudflared-onecard.yml");
  const credentialsFile = path.join(os.homedir(), ".cloudflared", `${TUNNEL_ID}.json`);
  const config = [
    `tunnel: ${TUNNEL_ID}`,
    `credentials-file: ${credentialsFile}`,
    "ingress:",
    `  - hostname: ${TUNNEL_HOST}`,
    `    service: http://localhost:${LOCAL_PORT}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, config, "utf8");
  return configPath;
}

function startTunnel() {
  if (tunnelProc || !fs.existsSync(CLOUDFLARED_BIN)) {
    if (!fs.existsSync(CLOUDFLARED_BIN)) {
      tunnelError = "cloudflared missing";
      updateTray();
    }
    return;
  }
  const configPath = ensureTunnelConfig();
  tunnelReady = false;
  tunnelError = null;
  updateTray();
  tunnelProc = spawn(CLOUDFLARED_BIN, ["tunnel", "--config", configPath, "run", TUNNEL_NAME], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onOutput = (chunk) => {
    const text = String(chunk || "");
    if (!text) return;
    if (text.includes("Registered tunnel connection") || text.includes("Connection") || text.includes("Starting metrics server")) {
      tunnelReady = true;
      tunnelError = null;
      updateTray();
    }
  };
  tunnelProc.stdout.on("data", onOutput);
  tunnelProc.stderr.on("data", onOutput);
  tunnelProc.on("exit", (code) => {
    tunnelProc = null;
    tunnelReady = false;
    tunnelError = `stopped (${code ?? "?"})`;
    updateTray();
    if (!isQuitting) {
      setTimeout(startTunnel, 2000);
    }
  });
}

function stopTunnel() {
  if (!tunnelProc) return;
  try { tunnelProc.kill("SIGTERM"); } catch {}
  tunnelProc = null;
}

// Local API — ทุก Graph API call ผ่าน Electron net (session cookies)
function startServer() {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${LOCAL_PORT}`);
    const p = url.pathname;
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Web UI
    if (p === "/" && req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(getWebUI());
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.end();

    // Parse POST JSON body if present
    let body = {};
    if (req.method === "POST") {
      try {
        const raw = await new Promise((resolve) => {
          let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(d));
        });
        body = JSON.parse(raw);
      } catch {}
    }

    // Merge: POST body + query params (query params override)
    const params = { ...body };
    url.searchParams.forEach((v, k) => { if (v) params[k] = v; });

    if (p === "/token") return res.end(JSON.stringify({ ok: true, accessToken: !!accessToken, fbDtsg: !!fbDtsg, user: userName }));

    if (p === "/session") {
      // Return session info
      const cookies = await mainWindow.webContents.session.cookies.get({ domain: ".facebook.com" });
      return res.end(JSON.stringify({ ok: true, accessToken, fbDtsg, cookies: cookies.length }));
    }

    if (p === "/debug-eval") {
      if (!fs.existsSync("/tmp/onecard-debug-eval-enabled")) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "debug eval disabled" })); }
      try {
        const code = String(params.code || "");
        if (!code) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "Missing: code" })); }
        const value = await mainWindow.webContents.executeJavaScript(code, true);
        return res.end(JSON.stringify({ ok: true, value }));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /graph — local maintenance helper: proxy Graph API through Electron session
    // cookies + current Ads Manager access token. Never returns the token itself.
    if (p === "/graph") {
      try {
        const graphPath = String(params.path || "").replace(/^\/+/, "");
        if (!graphPath || graphPath.includes("..")) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "Missing/invalid graph path" })); }
        const method = String(params.method || req.method || "GET").toUpperCase();
        const fields = String(params.fields || "").trim();
        const qs = new URLSearchParams();
        if (params.query && typeof params.query === "object") {
          Object.entries(params.query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") qs.set(k, String(v)); });
        }
        if (fields) qs.set("fields", fields);
        const graphBody = params.body && typeof params.body === "object" ? { ...params.body } : {};
        // Support both shapes:
        //   1) { body: { message, access_token } } from maintenance scripts
        //   2) { message, access_token } from dashboard Worker POST /graph
        // Before this, dashboard comment POST sent top-level message/access_token,
        // but /graph forwarded an empty body to Facebook → comment was skipped.
        for (const [k, v] of Object.entries(params)) {
          if (["path", "method", "fields", "query", "body"].includes(k)) continue;
          if (v !== undefined && v !== null && v !== "" && graphBody[k] === undefined) graphBody[k] = v;
        }
        const explicitAccessToken = typeof graphBody.access_token === "string" && graphBody.access_token ? graphBody.access_token : "";
        if (explicitAccessToken) delete graphBody.access_token;
        qs.set("access_token", explicitAccessToken || accessToken || "");
        const graphUrl = `https://graph.facebook.com/v21.0/${graphPath}?${qs.toString()}`;
        const graphResp = await elFetch(graphUrl, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method === "GET" ? {} : { body: JSON.stringify(graphBody) }),
        });
        res.writeHead(graphResp.status || 200);
        return res.end(graphResp.text());
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /pages — ดึงเพจผ่าน Electron session
    if (p === "/pages") {
      try {
        const r = await elFetch("https://www.facebook.com/pages/?category=your_pages", { method: "GET" });
        // ใช้ Graph API ผ่าน net module
        const r2 = await elFetch(`https://graph.facebook.com/me/accounts?fields=access_token,id,name&limit=100&access_token=${encodeURIComponent(accessToken)}`);
        const data = r2.json();
        if (data.error) {
          // Fallback: ใช้ user token เดิม
          const saved = loadStore();
          if (saved.userToken) {
            const r3 = await nodeFetch(`https://graph.facebook.com/me/accounts?fields=access_token,id,name&limit=100&access_token=${encodeURIComponent(saved.userToken)}`);
            return res.end(JSON.stringify(await r3.json()));
          }
          return res.end(JSON.stringify(data));
        }
        return res.end(JSON.stringify(data));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /upload-video — อัพวีดีโอ + ดึง thumbnails
    if (p === "/upload-video") {
      const adAccount = params.ad_account || "act_1148837732288721";
      const videoUrl = params.video_url;
      if (!videoUrl) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "Missing: video_url" })); }
      try {
        const step1 = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/advideos?access_token=${encodeURIComponent(accessToken)}&file_url=${encodeURIComponent(videoUrl)}`, { method: "POST" });
        const v = step1.json();
        if (v.error) return res.end(JSON.stringify({ ok: false, error: v.error.message }));
        let thumbnails = [];
        for (let i = 0; i < 25; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const s = await elFetch(`https://graph.facebook.com/${v.id}?access_token=${encodeURIComponent(accessToken)}&fields=thumbnails`);
          const sd = s.json();
          if (sd.thumbnails?.data?.length > 1) { thumbnails = sd.thumbnails.data.map(t => ({ id: t.id, url: t.uri })); break; }
        }
        return res.end(JSON.stringify({ ok: true, video_id: v.id, thumbnails }));
      } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /create-ad — สร้าง LIKE_PAGE ad จาก video URL
    if (p === "/create-ad" && req.method === "POST") {
      try {
        const pageId = body.page_id;
        const videoUrl = body.video_url;
        const existingVideoId = body.video_id || "";
        const caption = body.caption || "";
        const adAccount = body.ad_account || "act_1030797047648459";
        // Retired pre-SALES template 120244361318490263 must not be used as fallback.
        const templateAdset = body.template_adset || "120248134990230263";
        const shortlink = String(body.shortlink || "").trim();
        const shopeeUrl = String(body.shopee_url || "").trim();
        const thumbnailUrl = String(body.thumbnail_url || body.image_url || "").trim();
        const skipPublishToPage = body.skip_publish_to_page === true || body.skip_publish_to_page === "true";
        const requestedAdName = resolveCreateAdName(body, videoUrl, existingVideoId);
        // CTA destination MUST be the wwoom shortlink — it's the only URL that
        // carries our sub_id tracking params (configured in dashboard /settings, e.g.
        // sub_id=20APR26FBSPCAD). The shortlink redirects to Shopee with full attribution.
        // shopee_url is kept around only as a last-resort fallback if shortening failed.
        const ctaLink = shortlink || shopeeUrl;

        if (!pageId || (!videoUrl && !existingVideoId)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "Missing: page_id, video_url or video_id" })); }

        // Read CTA type from the template adset's existing ad creative — so whatever
        // CTA the user sets in their template (SHOP_NOW / LEARN_MORE / LIKE_PAGE / etc.)
        // gets mirrored to every new ad we create. Falls back to SHOP_NOW (matches
        // current "การมีส่วนร่วม" template) if lookup fails.
        let ctaType = "SHOP_NOW";
        let instagramActorId = "";
        let instagramUserId = "";
        try {
          const tplAdsResp = await elFetch(`https://graph.facebook.com/v21.0/${templateAdset}/ads?fields=creative{id}&limit=1&access_token=${encodeURIComponent(accessToken)}`);
          const tplAdsData = tplAdsResp.json();
          const tplCreativeId = tplAdsData?.data?.[0]?.creative?.id;
          if (tplCreativeId) {
            const tplCrResp = await elFetch(`https://graph.facebook.com/v21.0/${tplCreativeId}?fields=call_to_action_type,instagram_actor_id,object_story_spec&access_token=${encodeURIComponent(accessToken)}`);
            const tplCrData = tplCrResp.json();
            if (tplCrData?.call_to_action_type) ctaType = String(tplCrData.call_to_action_type).trim();
            instagramActorId = String(tplCrData?.instagram_actor_id || tplCrData?.object_story_spec?.instagram_actor_id || "").trim();
            instagramUserId = String(tplCrData?.object_story_spec?.instagram_user_id || "").trim();
          }
        } catch (e) {
          console.log(`[CREATE-AD] Could not read template CTA, using fallback ${ctaType}: ${e.message}`);
        }
        console.log(`[CREATE-AD] Template adset=${templateAdset} → CTA type=${ctaType} IG actor=${instagramActorId ? 'y' : 'n'} link=${ctaLink || '(none)'} (shopee=${shopeeUrl ? 'y' : 'n'}, short=${shortlink ? 'y' : 'n'})`);

        // 1. Upload video (or use existing video_id)
        // Instagram-only is more reliable when the creative uses an ad-account
        // advideo object. Reusing a Facebook Page video object is inconsistent:
        // Meta accepts some clips but rejects others at /ads with code=100 /
        // subcode=1443078 (“IG ไม่รองรับสื่อโฆษณา”). For IG-only requests,
        // if the dashboard supplied a source URL we upload it to the ad account;
        // if it only supplied a Page video_id, try to read `source` from Graph
        // and upload that. Facebook-only keeps the old Page-video behavior so
        // page publish + comment can still target the original post.
        let vid;
        let uploadedForInstagram = false;
        let resolvedVideoUrl = String(videoUrl || "").trim();
        if (skipPublishToPage && !resolvedVideoUrl && existingVideoId) {
          try {
            const srcResp = await elFetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(existingVideoId)}?fields=source&access_token=${encodeURIComponent(accessToken)}`);
            const srcData = srcResp.json();
            if (srcData?.source && /^https?:\/\//i.test(String(srcData.source))) {
              resolvedVideoUrl = String(srcData.source).trim();
              console.log(`[CREATE-AD] Resolved Page video source for IG re-upload video_id=${existingVideoId}`);
            } else if (srcData?.error) {
              console.log(`[CREATE-AD] Could not resolve source for IG re-upload code=${srcData.error.code || ""}: ${srcData.error.message || ""}`);
            }
          } catch (e) {
            console.log(`[CREATE-AD] Source resolve exception for IG re-upload: ${e.message || e}`);
          }
        }

        if (skipPublishToPage && resolvedVideoUrl) {
          const uv = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/advideos?access_token=${encodeURIComponent(accessToken)}&file_url=${encodeURIComponent(resolvedVideoUrl)}`, { method: "POST" });
          vid = uv.json();
          if (vid.error) return res.end(JSON.stringify({ ok: false, step: "upload", error: vid.error.message, fb_error_code: vid.error.code, fb_error_subcode: vid.error.error_subcode, fb_trace_id: vid.error.fbtrace_id, upload_mode: "instagram_advideo" }));
          uploadedForInstagram = true;
          console.log(`[CREATE-AD] Uploaded source as ad-account advideo for IG-only: ${vid.id}`);
        } else if (existingVideoId) {
          vid = { id: existingVideoId };
          console.log(`[CREATE-AD] Using existing video_id: ${existingVideoId}`);
        } else {
          const uv = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/advideos?access_token=${encodeURIComponent(accessToken)}&file_url=${encodeURIComponent(resolvedVideoUrl)}`, { method: "POST" });
          vid = uv.json();
          if (vid.error) return res.end(JSON.stringify({ ok: false, step: "upload", error: vid.error.message, fb_error_code: vid.error.code, fb_error_subcode: vid.error.error_subcode, fb_trace_id: vid.error.fbtrace_id }));
        }

        // 2. Wait thumbnails — poll up to 60 × 3s = 180s.
        // FB processing latency is variable: short videos finish in 5–10s, long videos
        // can take 90s+. Previous limit of 20 × 3s (60s) failed on routine 60–120s waits
        // — exactly the symptom the dashboard reported as "[thumbnails] Timeout HTTP 200".
        // Also relax the gate to data.length >= 1: FB always returns at least one auto
        // thumbnail once the encode is ready, and we only use data[0].uri anyway. The old
        // > 1 check waited for an extra optional frame that often never arrives, padding
        // failures by minutes. Matches the /post endpoint below (line ~657).
        let thumb = /^https?:\/\//i.test(thumbnailUrl) ? thumbnailUrl : null;
        if (thumb) {
          console.log(`[CREATE-AD] using cached thumbnail_url for video_id=${vid.id}`);
        } else {
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const t = await elFetch(`https://graph.facebook.com/${vid.id}?access_token=${encodeURIComponent(accessToken)}&fields=thumbnails`);
            const td = t.json();
            if (td.error) {
              console.log(`[CREATE-AD] thumbnail graph error code=${td.error.code || ""} subcode=${td.error.error_subcode || ""}: ${td.error.message || ""}`);
              return res.end(JSON.stringify({
                ok: false,
                step: "thumbnails",
                error: td.error.message || "Graph thumbnails error",
                fb_error_code: td.error.code,
                fb_error_subcode: td.error.error_subcode,
                fb_trace_id: td.error.fbtrace_id || td.__www_request_id,
                used_existing_video: !!existingVideoId && !uploadedForInstagram,
                uploaded_for_instagram: uploadedForInstagram
              }));
            }
            if (td.thumbnails?.data?.length >= 1) { thumb = td.thumbnails.data[0].uri; console.log(`[CREATE-AD] thumbnail ready after ${i+1} polls`); break; }
            if (i % 5 === 0) console.log(`[CREATE-AD] poll ${i+1}/60 — no thumbnail yet`);
          }
        }
        if (!thumb) return res.end(JSON.stringify({ ok: false, step: "thumbnails", error: "Timeout (180s, FB still processing)" }));

        // 3. Create creative
        // CTA value shape depends on type:
        //   - LIKE_PAGE → { page: pageId } (no link)
        //   - SHOP_NOW / LEARN_MORE / BUY_NOW / etc. → { link: ctaLink }
        // ctaLink prefers shopee_url over shortlink so the FB button shows real shopee.co.th
        // domain (matches user's template). If no link at all, fall back to LIKE_PAGE.
        const isLikePageCta = ctaType === "LIKE_PAGE" || !ctaLink;
        const ctaSpec = isLikePageCta
          ? { type: "LIKE_PAGE", value: { page: pageId } }
          : { type: ctaType, value: { link: ctaLink, link_format: "VIDEO_LPP" } };
        const crBody = {
          name: caption.substring(0, 50),
          ...(instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
          object_story_spec: {
            page_id: pageId,
            ...(instagramActorId ? { instagram_actor_id: instagramActorId } : {}),
            ...(instagramUserId ? { instagram_user_id: instagramUserId } : {}),
            video_data: {
              video_id: vid.id, message: caption, image_url: thumb,
              call_to_action: ctaSpec
            }
          }
        };
        const cr = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/adcreatives?access_token=${encodeURIComponent(accessToken)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(crBody)
        });
        const crData = cr.json();
        if (crData.error) return res.end(JSON.stringify({ ok: false, step: "creative", error: crData.error.message, fb_error_code: crData.error.code, fb_error_subcode: crData.error.error_subcode, fb_trace_id: crData.error.fbtrace_id, cta_type: ctaType, cta_link: ctaLink || null, used_existing_video: !!existingVideoId && !uploadedForInstagram, uploaded_for_instagram: uploadedForInstagram }));

        // 4. Get story ID — poll up to 50 × 3s = 150s.
        // FB story-resolution latency is variable (often 30-80s, occasionally
        // 80-120s). Previous limit of 25 × 3s (75s) cut off right at the edge:
        // smoke test on 2026-05-01 hit 83s success on retry of the same 75s
        // timeout. Matches the thumbnails widening from yesterday (also from
        // a poll-too-narrow symptom on transient FB slowness).
        let storyId = null;
        for (let i = 0; i < 50; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const c = await elFetch(`https://graph.facebook.com/${crData.id}?access_token=${encodeURIComponent(accessToken)}&fields=effective_object_story_id`);
          const cd = c.json();
          if (cd.effective_object_story_id) {
            storyId = cd.effective_object_story_id;
            console.log(`[CREATE-AD] story_id ready after ${i+1} polls (${(i+1)*3}s)`);
            break;
          }
          if (i % 5 === 0) console.log(`[CREATE-AD] story_id poll ${i+1}/50 — not ready yet`);
        }
        if (!storyId) return res.end(JSON.stringify({ ok: false, step: "story_id", error: "Timeout (150s, FB still creating story)", creative_id: crData.id }));
        const adName = (requestedAdName || existingVideoId || String(vid.id || '') || caption).substring(0, 255);

        // 5. หาแคมเปญ: ใช้ campaign_id ที่ระบุ / สร้างใหม่ด้วย new_campaign_name / หาอัตโนมัติ
        const maxAdsetsPerCampaign = 10;
        const maxCampaigns = 10;
        const campaignPrefix = body.campaign_name || "ADS_PUBLISH_";

        let targetCampaignId = body.campaign_id || null;

        // Read template's campaign objective to reuse when creating NEW campaigns.
        // FB subcode 1815149 = "objective mismatch" — when template adset has
        // LINK_CLICKS optimization but new campaign is OUTCOME_ENGAGEMENT, the copy
        // adset step fails because adsets must match their campaign's objective.
        // So: fetch the template adset → get its campaign → get that campaign's objective
        // → use same objective for any new campaign we create.
        let templateObjective = "OUTCOME_ENGAGEMENT"; // safe fallback matching old template
        try {
          const tplAdsetResp = await elFetch(`https://graph.facebook.com/v21.0/${templateAdset}?fields=campaign{objective}&access_token=${encodeURIComponent(accessToken)}`);
          const tplAdsetData = tplAdsetResp.json();
          const obj = tplAdsetData?.campaign?.objective;
          if (obj && typeof obj === "string") {
            templateObjective = obj;
            console.log(`[CREATE-AD] Template ${templateAdset} objective=${templateObjective}`);
          }
        } catch (e) {
          console.log(`[CREATE-AD] Could not read template objective, using fallback ${templateObjective}: ${e.message}`);
        }

        // ถ้าระบุชื่อแคมเปญใหม่ → สร้างแคมเปญใหม่ทุกครั้ง แม้ชื่อซ้ำ
        // Operator intentionally uses the same campaign name for multiple separate
        // campaigns. Do not reuse exact-name campaigns here; Meta allows duplicate
        // names and the dashboard label says "สร้างแคมเปญใหม่".
        if (body.new_campaign_name) {
          targetCampaignId = "";
          const exactCampaignName = String(body.new_campaign_name || "").trim();
          const newCampResp = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/campaigns?access_token=${encodeURIComponent(accessToken)}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: exactCampaignName, objective: templateObjective, status: "ACTIVE", special_ad_categories: [], daily_budget: "100000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" })
          });
          const newCamp = newCampResp.json();
          if (newCamp.error) return res.end(JSON.stringify({ ok: false, step: "campaign", error: newCamp.error.message, fb_error_code: newCamp.error.code, fb_error_subcode: newCamp.error.error_subcode, fb_trace_id: newCamp.error.fbtrace_id, attempted_objective: templateObjective }));
          targetCampaignId = newCamp.id;
          console.log(`[CREATE-AD] Created duplicate-name campaign "${exactCampaignName}" objective=${templateObjective}: ${targetCampaignId}`);
        }

        // ถ้ายังไม่มี → หาแคมเปญที่ยังไม่เต็มอัตโนมัติ
        // Filter by BOTH name prefix AND matching template objective (otherwise we could
        // pick an old-objective campaign and hit the same 1815149 mismatch error)
        if (!targetCampaignId) {
          const campsResp = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/campaigns?access_token=${encodeURIComponent(accessToken)}&fields=id,name,status,objective&limit=50&filtering=[{"field":"name","operator":"CONTAIN","value":"${campaignPrefix}"}]`);
          const camps = campsResp.json();
          const activeCamps = (camps.data || []).filter(c => c.status !== "DELETED" && c.objective === templateObjective);

          for (const camp of activeCamps) {
            const adsetsResp = await elFetch(`https://graph.facebook.com/v21.0/${camp.id}/adsets?access_token=${encodeURIComponent(accessToken)}&fields=id,status&limit=50`);
            const adsets = adsetsResp.json();
            const count = (adsets.data || []).filter(a => a.status !== "DELETED").length;
            if (count < maxAdsetsPerCampaign) {
              targetCampaignId = camp.id;
              console.log(`[CREATE-AD] Using campaign ${camp.name} objective=${camp.objective} (${count}/${maxAdsetsPerCampaign} adsets)`);
              break;
            }
          }

          if (!targetCampaignId) {
            if (activeCamps.length >= maxCampaigns) {
              return res.end(JSON.stringify({ ok: false, step: "campaign", error: "Max " + maxCampaigns + " campaigns reached for objective " + templateObjective }));
            }
            const newCampNum = activeCamps.length + 1;
            const newCampResp = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/campaigns?access_token=${encodeURIComponent(accessToken)}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: campaignPrefix + newCampNum, objective: templateObjective, status: "ACTIVE", special_ad_categories: [], daily_budget: "100000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" })
            });
            const newCamp = newCampResp.json();
            if (newCamp.error) return res.end(JSON.stringify({ ok: false, step: "campaign", error: newCamp.error.message, fb_error_code: newCamp.error.code, fb_error_subcode: newCamp.error.error_subcode, fb_trace_id: newCamp.error.fbtrace_id, attempted_objective: templateObjective }));
            targetCampaignId = newCamp.id;
            console.log(`[CREATE-AD] Created new campaign ${campaignPrefix}${newCampNum} objective=${templateObjective}: ${targetCampaignId}`);
          }
        }

        // Copy adset ไปแคมเปญที่เลือก
        // Copy only the adset shell/settings. Do NOT deep-copy ads from the
        // template adset: we create a fresh ad below, and deep_copy=true makes
        // Meta drag old ads/creatives along. On adsets with existing ads this
        // can fail with code=1 "Please reduce the amount of data you're asking
        // for" at the /copies step.
        const copy = await elFetch(`https://graph.facebook.com/v21.0/${templateAdset}/copies?access_token=${encodeURIComponent(accessToken)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deep_copy: false, status_option: "PAUSED", campaign_id: targetCampaignId })
        });
        const copyData = copy.json();
        if (copyData.error) return res.end(JSON.stringify({ ok: false, step: "copy", error: copyData.error.message, fb_error_code: copyData.error.code, fb_error_subcode: copyData.error.error_subcode, fb_trace_id: copyData.error.fbtrace_id, template_adset: templateAdset, target_campaign: targetCampaignId }));
        const newAdset = copyData.copied_adset_id;

        // 6. สร้าง ad ใหม่ใน adset ที่ copy มา
        // Meta sometimes returns code=100/subcode=1443078 immediately after
        // copying/creating a campaign+adset because the copied adset is not fully
        // usable yet. Retry inside the same adset so the operator doesn't have to
        // click again (which would create another campaign/adset).
        let adData = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
          const adResp = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/ads?access_token=${encodeURIComponent(accessToken)}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: adName, adset_id: newAdset, creative: { creative_id: crData.id }, status: "PAUSED" })
          });
          adData = adResp.json();
          if (!adData.error) break;
          const code = Number(adData.error.code || 0);
          const subcode = Number(adData.error.error_subcode || 0);
          const retryable = adData.error.is_transient === true;
          console.log(`[CREATE-AD] Ad create attempt ${attempt} failed: code=${code} subcode=${subcode} transient=${retryable} user_msg=${adData.error.error_user_msg || ''}`);
          if (!retryable || attempt === 4) break;
          await new Promise(resolve => setTimeout(resolve, attempt * 3000));
        }
        if (adData.error) {
          // If ad creation fails after copying the adset, remove the empty copied
          // adset so the operator doesn't see stale "IG - สำเนา" shells.
          try {
            await elFetch(`https://graph.facebook.com/v21.0/${newAdset}?access_token=${encodeURIComponent(accessToken)}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "DELETED" })
            });
          } catch {}
          return res.end(JSON.stringify({
            ok: false,
            step: "ad",
            error: adData.error.message,
            fb_error_code: adData.error.code,
            fb_error_subcode: adData.error.error_subcode,
            fb_error_user_title: adData.error.error_user_title,
            fb_error_user_msg: adData.error.error_user_msg,
            fb_is_transient: adData.error.is_transient,
            fb_trace_id: adData.error.fbtrace_id,
            adset_id: newAdset,
            creative_id: crData.id,
            uploaded_for_instagram: uploadedForInstagram,
          }));
        }
        const newAd = adData.id;

        // 7. Rename adset + activate
        await elFetch(`https://graph.facebook.com/v21.0/${newAdset}?access_token=${encodeURIComponent(accessToken)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: storyId, status: "ACTIVE" })
        });
        await elFetch(`https://graph.facebook.com/v21.0/${newAd}?access_token=${encodeURIComponent(accessToken)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "ACTIVE" })
        });

        // 7.25. Cleanup ads ที่ติดมาจาก deep_copy ของ template adset.
        // /copies?deep_copy=true ก๊อป adset settings + ALL existing ads in the
        // template. Operator sees these as "PAUSED ad with old name like
        // 1MAY26FBSPCAD/3IN1FUCKINGMOTOR" stuck inside every new adset → ดู
        // รก. Delete every ad in newAdset whose id !== newAd.
        try {
          const adsListResp = await elFetch(`https://graph.facebook.com/v21.0/${newAdset}/ads?fields=id&limit=50&access_token=${encodeURIComponent(accessToken)}`);
          const adsList = adsListResp.json();
          const stragglers = (adsList?.data || []).filter(a => String(a.id) !== String(newAd));
          for (const a of stragglers) {
            await elFetch(`https://graph.facebook.com/v21.0/${a.id}?access_token=${encodeURIComponent(accessToken)}`, { method: "DELETE" });
            console.log(`[CREATE-AD] Cleanup deep_copy straggler ad ${a.id}`);
          }
        } catch (e) {
          console.log(`[CREATE-AD] Cleanup deep_copy stragglers failed (non-fatal): ${e.message || e}`);
        }

        // 7.5. Also publish the (dark) post to the page feed.
        // The ad creates a "dark post" by default — only visible as an ad. Setting
        // is_published=true makes it appear on the page wall too, so people can find
        // and engage with it organically. CTA button stays intact.
        // For OUTCOME_ENGAGEMENT campaigns this boosts organic reach + algorithm signal.
        let publishedToPage = false;
        let publishError = "";
        if (skipPublishToPage) {
          publishError = "skipped_by_placement_template";
          console.log(`[CREATE-AD] Skip page publish for placement/template request video=${vid.id}`);
        } else {
        try {
          // Need a PAGE access token to publish (user token can't toggle is_published on a page post)
          const pagesRes = await elFetch(`https://graph.facebook.com/me/accounts?fields=access_token,id&limit=100&access_token=${encodeURIComponent(accessToken)}`);
          const pages = pagesRes.json();
          const page = (pages.data || []).find(p => p.id === pageId);
          const pageToken = page ? page.access_token : "";
          if (pageToken) {
            const pubResp = await elFetch(`https://graph.facebook.com/v21.0/${storyId}?access_token=${encodeURIComponent(pageToken)}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ is_published: true })
            });
            const pubData = pubResp.json();
            if (pubData?.error) {
              publishError = String(pubData.error.message || "").substring(0, 200);
              console.log(`[CREATE-AD] Publish to page failed: ${publishError}`);
            } else {
              publishedToPage = true;
              console.log(`[CREATE-AD] Published to page feed: ${storyId}`);
            }
          } else {
            publishError = "page_token_not_found";
            console.log(`[CREATE-AD] No page token for ${pageId} — cannot publish to feed`);
          }
        } catch (e) {
          publishError = e.message || String(e);
          console.log(`[CREATE-AD] Publish to page exception: ${publishError}`);
        }
        }

        // Mark video as posted
        if (body.video_gallery_id && body.bot_id) {
          try {
            const markUrl = (body.worker_url || "https://api.oomnn.com") + "/api/mark-video-posted";
            await nodeFetch(markUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-auth-token": body.auth_token || "", "x-bot-id": body.bot_id },
              body: JSON.stringify({ video_id: body.video_gallery_id })
            });
          } catch {}
        }

        return res.end(JSON.stringify({ ok: true, story_id: storyId, campaign_id: targetCampaignId, adset_id: newAdset, ad_id: newAd, video_id: vid.id, creative_id: crData.id, published_to_page: publishedToPage, publish_error: publishError || undefined, uploaded_for_instagram: uploadedForInstagram }));
      } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /promote — ลบแอด + ลบปุ่ม CTA + เผยแพร่หน้าเพจ
    if (p === "/promote" && req.method === "POST") {
      try {
        const storyId = body.story_id;
        const adAccount = body.ad_account || "act_1030797047648459";
        if (!storyId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "Missing: story_id" })); }

        const pageId = storyId.split("_")[0];
        const postId = storyId.split("_")[1];

        // Get page token
        const pagesRes = await elFetch(`https://graph.facebook.com/me/accounts?fields=access_token,id&limit=100&access_token=${encodeURIComponent(accessToken)}`);
        const pages = pagesRes.json();
        const page = (pages.data || []).find(p => p.id === pageId);
        const pageToken = page ? page.access_token : accessToken;

        // 1. ลบแอดที่ใช้ story นี้
        const adsets = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/adsets?access_token=${encodeURIComponent(accessToken)}&fields=id,name&limit=50&filtering=[{"field":"name","operator":"CONTAIN","value":"${postId}"}]`);
        const adsetsData = adsets.json();
        for (const a of (adsetsData.data || [])) {
          const ads = await elFetch(`https://graph.facebook.com/v21.0/${a.id}/ads?access_token=${encodeURIComponent(accessToken)}&fields=id&limit=10`);
          for (const ad of (ads.json().data || [])) {
            await elFetch(`https://graph.facebook.com/v21.0/${ad.id}?access_token=${encodeURIComponent(accessToken)}`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "DELETED" })
            });
          }
          await elFetch(`https://graph.facebook.com/v21.0/${a.id}?access_token=${encodeURIComponent(accessToken)}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "DELETED" })
          });
        }

        await new Promise(r => setTimeout(r, 3000));

        // 2. ลบปุ่ม CTA
        const ctaUrl = `https://adsmanager.facebook.com/ads/existing_post/call_to_action/?page_ids[0]=${pageId}&post_ids[0]=${postId}&ad_account_id=${adAccount.replace("act_","")}&source_app_id=119211728144504&call_to_action_type=NO_BUTTON&is_from_cta_upgrade_recommendation=false`;
        const session = { fbDtsg: fbDtsg };
        const formBody = "fb_dtsg=" + encodeURIComponent(fbDtsg) + "&jazoest=25357";
        await elFetch(ctaUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: formBody });

        await new Promise(r => setTimeout(r, 3000));

        // 3. เผยแพร่หน้าเพจ
        await elFetch(`https://graph.facebook.com/v21.0/${storyId}?access_token=${encodeURIComponent(pageToken)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_published: true })
        });

        return res.end(JSON.stringify({ ok: true, story_id: storyId, post_url: "https://www.facebook.com/" + storyId.replace("_", "/posts/") }));
      } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /proxy — ยิง URL ไหนก็ได้ด้วย session cookies
    if (p === "/proxy" && req.method === "POST") {
      try {
        const targetUrl = body.__url;
        delete body.__url;
        const formBody = Object.entries(body).map(([k,v]) => k + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))).join('&');
        const r = await elFetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody
        });
        const rawText = r.text();
        try { return res.end(JSON.stringify(JSON.parse(rawText))); }
        catch { return res.end(JSON.stringify({ ok: true, raw: rawText })); }
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /fbapi — ยิง www.facebook.com/api/graphql ด้วย session cookies
    if (p === "/fbapi" && req.method === "POST") {
      try {
        const formBody = Object.entries(body).map(([k,v]) => k + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))).join('&');
        const r = await elFetch('https://www.facebook.com/api/graphql/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody
        });
        return res.end(JSON.stringify(r.json()));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /fb-comment/capture-edit-mutation — install the page interceptor and report
    // sanitized capture state. The operator edits a comment once in the Ads
    // Manager window; the interceptor stashes that mutation for replay. Response
    // is sanitized: no token/cookie/fb_dtsg/raw body ever leaves the process.
    if (p === "/fb-comment/capture-edit-mutation" && req.method === "POST") {
      try {
        const installed = await fbInstallCommentInterceptor();
        await fbPullCaptureFromPage();
        return res.end(JSON.stringify({ ok: true, interceptor_installed: installed, ...fbCommentSanitizedState() }));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /fb-comment/capture-edit-mutation/status — sanitized capture state.
    if (p === "/fb-comment/capture-edit-mutation/status" && req.method === "GET") {
      try {
        await fbPullCaptureFromPage();
        return res.end(JSON.stringify({ ok: true, interceptor_installed: fbCommentInterceptorInstalled, ...fbCommentSanitizedState() }));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /fb-comment/edit — replay the captured edit-comment mutation against a
    // target comment_id + message. Fails CLOSED: this is strictly an EDIT
    // mutation (fixed doc_id), so it can only edit an existing comment or error
    // — it can never create a new comment. If anything is unknown/missing we
    // return a blocker + fallback_required:true instead of faking success.
    if (p === "/fb-comment/edit" && req.method === "POST") {
      try {
        const commentId = String(body.comment_id || "").trim();
        const message = typeof body.message === "string" ? body.message : "";
        const verify = body.verify !== false && body.verify !== "false"; // default true
        const forceCommentIdReplace = body.force_comment_id_replace === true || body.force_comment_id_replace === "true";

        if (!commentId || !/^[0-9_]+$/.test(commentId)) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, edited: false, verified: false, comment_id: commentId, fallback_required: true, blocker: "invalid_comment_id", error: "comment_id must be numeric (optionally page_comment form)" }));
        }
        if (!message || message.length > 20000) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, edited: false, verified: false, comment_id: commentId, fallback_required: true, blocker: "invalid_message", error: "message required and must be <= 20000 chars" }));
        }

        await fbPullCaptureFromPage();
        if (!fbCommentCapture.captured || !fbCommentCapture.parsedForm) {
          return res.end(JSON.stringify({ ok: false, edited: false, verified: false, comment_id: commentId, fallback_required: true, blocker: "capture_required", error: "No captured edit mutation. Edit a comment once in the Ads Manager window after calling /fb-comment/capture-edit-mutation." }));
        }

        const form = { ...fbCommentCapture.parsedForm };
        const mutationName = fbCommentCapture.friendlyName || null;
        const docIdPresent = fbCommentCapture.docIdPresent;

        let variables;
        try { variables = JSON.parse(form.variables || "null"); } catch { variables = null; }
        if (!variables || typeof variables !== "object") {
          return res.end(JSON.stringify({ ok: false, edited: false, verified: false, comment_id: commentId, mutation_name: mutationName, doc_id_present: docIdPresent, fallback_required: true, blocker: "unknown_payload_shape", error: "Captured payload has no parseable variables." }));
        }

        const applied = fbApplyEditVariables(variables, commentId, message, forceCommentIdReplace);
        if (applied.messageUpdated < 1) {
          // Could not locate the message field — refuse rather than send a
          // mutation that would edit the captured comment with stale text.
          // (The comment id may be intentionally preserved; see fbApplyEditVariables.)
          return res.end(JSON.stringify({ ok: false, edited: false, verified: false, comment_id: commentId, mutation_name: mutationName, doc_id_present: docIdPresent, comment_id_updated: applied.commentIdUpdated, comment_id_preserved: applied.commentIdPreserved, fallback_required: true, blocker: "unknown_payload_shape", error: `Could not locate message field (msg:${applied.messageUpdated}).` }));
        }

        form.variables = JSON.stringify(variables);
        if (fbDtsg) form.fb_dtsg = fbDtsg; // prefer the freshest token
        const outBody = Object.entries(form).map(([k, v]) => k + "=" + encodeURIComponent(typeof v === "object" ? JSON.stringify(v) : String(v))).join("&");

        let edited = false;
        let fbError = null;
        try {
          const r = await elFetch("https://www.facebook.com/api/graphql/", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: outBody,
          });
          const status = r.status || 0;
          const cleaned = String(r.text() || "").replace(/^for ?\(;;\);/, "").trim();
          let parsed = null;
          try { parsed = JSON.parse(cleaned.split("\n")[0]); } catch {}
          if (parsed && (parsed.errors || parsed.error)) {
            fbError = "facebook_graphql_error";
          } else if (status >= 200 && status < 300 && parsed && parsed.data) {
            edited = true;
          } else if (status >= 200 && status < 300 && !parsed) {
            fbError = "ambiguous_response";
          } else {
            fbError = "http_" + status;
          }
        } catch (e) {
          fbError = "request_failed";
        }

        let verified = false;
        if (edited && verify) {
          try {
            const vr = await elFetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(commentId)}?fields=message,from&access_token=${encodeURIComponent(accessToken || "")}`);
            const vd = vr.json();
            if (vd && typeof vd.message === "string" && vd.message === message) verified = true;
          } catch {}
        }

        const ok = edited && (!verify || verified);
        return res.end(JSON.stringify({
          ok,
          edited,
          verified,
          comment_id: commentId,
          mutation_name: mutationName,
          doc_id_present: docIdPresent,
          comment_id_updated: applied.commentIdUpdated,
          comment_id_preserved: applied.commentIdPreserved,
          fallback_required: !ok,
          ...(fbError ? { error: fbError } : {}),
          ...(edited && verify && !verified ? { blocker: "verification_failed" } : {}),
          ...(!edited && !fbError ? { blocker: "edit_failed" } : {}),
        }));
      } catch (e) {
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, edited: false, verified: false, fallback_required: true, blocker: "exception", error: e.message }));
      }
    }

    // /graph — Proxy Graph API ผ่าน Electron net (session cookies + token)
    if (p === "/graph") {
      const graphPath = params.path;
      if (!graphPath) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'Missing: path' })); }
      try {
        const graphUrl = new URL('https://graph.facebook.com/v21.0/' + graphPath);
        Object.entries(params).forEach(([k,v]) => { if (k !== 'path' && v) graphUrl.searchParams.set(k, v); });
        if (!graphUrl.searchParams.has('access_token') && accessToken) graphUrl.searchParams.set('access_token', accessToken);
        const method = req.method === 'POST' ? 'POST' : 'GET';
        const opts = { method };
        if (method === 'POST' && Object.keys(body).length > 1) {
          opts.headers = { 'Content-Type': 'application/json' };
          const bodyClone = { ...body }; delete bodyClone.path;
          opts.body = JSON.stringify(bodyClone);
        }
        const r = await elFetch(graphUrl.toString(), opts);
        return res.end(JSON.stringify(r.json()));
      } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /post — One Card post ผ่าน adcreatives (ใช้ accessToken จาก Ads Manager)
    if (p === "/post") {
      const adAccount = params.ad_account || "act_1148837732288721";
      const pageId = params.page_id;
      const videoUrl = params.video_url;
      const message = params.message || "";
      const title = params.title || "";
      const description = params.description || "";
      const websiteUrl = params.website_url || "";
      const cta = params.cta === "NO_BUTTON" ? "NO_BUTTON" : "SHOP_NOW";

      if (!pageId || !videoUrl) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: "Missing: ad_account, page_id, video_url" }));
      }

      try {
        // Step 1: Upload video
        console.log(`[POST] Step 1: Uploading video for page ${pageId}...`)
        const step1 = await elFetch(`https://graph.facebook.com/v21.0/${adAccount}/advideos?access_token=${encodeURIComponent(accessToken)}&file_url=${encodeURIComponent(videoUrl)}`, { method: "POST" });
        const v = step1.json();
        console.log(`[POST] Step 1 result:`, JSON.stringify(v).substring(0, 200))
        if (v.error) return res.end(JSON.stringify({ ok: false, step: "upload_video", error: v.error.message }));
        const videoId = v.id;

        // Step 2: Wait for thumbnails
        console.log(`[POST] Step 2: Waiting for thumbnails (videoId=${videoId})...`)
        let thumbUrl = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const s = await elFetch(`https://graph.facebook.com/${videoId}?access_token=${encodeURIComponent(accessToken)}&fields=thumbnails`);
          const sd = s.json();
          if (sd.thumbnails?.data?.length >= 1) { thumbUrl = sd.thumbnails.data[0].uri; console.log(`[POST] Step 2: Got thumbnail after ${i+1} polls`); break; }
          if (i % 5 === 0) console.log(`[POST] Step 2: Poll ${i+1}/60 - no thumbnail yet`)
        }
        if (!thumbUrl) { console.log(`[POST] Step 2: TIMEOUT`); return res.end(JSON.stringify({ ok: false, step: "thumbnails", error: "Timeout" })); }

        // Step 3: Create adcreative
        console.log(`[POST] Step 3: Creating adcreative...`)
        const videoData = { video_id: videoId, image_url: thumbUrl, message: message || "" };
        if (title) videoData.title = title;
        if (description) videoData.link_description = description;
        if (cta !== "NO_BUTTON" && websiteUrl) videoData.call_to_action = { type: cta, value: { link: websiteUrl } };
        const body = JSON.stringify({ object_story_spec: { page_id: pageId, video_data: videoData } });
        console.log(`[POST] Step 3: body=`, body.substring(0, 200))

        const s3 = await elFetch(`https://graph.facebook.com/v16.0/${adAccount}/adcreatives?access_token=${encodeURIComponent(accessToken)}&fields=effective_object_story_id,object_story_id`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body
        });
        const c = s3.json();
        console.log(`[POST] Step 3 result:`, JSON.stringify(c).substring(0, 300))
        if (c.error) return res.end(JSON.stringify({ ok: false, step: "adcreative", error: c.error.message }));

        // Step 4: Poll for story ID (reduced to 20 polls × 3s = 60s max)
        console.log(`[POST] Step 4: Polling story ID for adcreative ${c.id}...`)
        let storyId = c.effective_object_story_id || c.object_story_id || null;
        for (let i = 0; !storyId && i < 20; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const p4 = await elFetch(`https://graph.facebook.com/${c.id}?access_token=${encodeURIComponent(accessToken)}&fields=effective_object_story_id,object_story_id`);
          const d4 = p4.json();
          console.log(`[POST] Step 4: Poll ${i+1}/20:`, JSON.stringify(d4).substring(0, 150))
          if (d4.error) {
            console.log(`[POST] Step 4: ERROR:`, d4.error.message)
            return res.end(JSON.stringify({ ok: false, step: "story_id", error: d4.error.message, adcreative_id: c.id }));
          }
          if (d4.effective_object_story_id || d4.object_story_id) {
            storyId = d4.effective_object_story_id || d4.object_story_id;
            console.log(`[POST] Step 4: Got story ID: ${storyId}`)
            break;
          }
        }
        if (!storyId) { console.log(`[POST] Step 4: TIMEOUT`); return res.end(JSON.stringify({ ok: false, step: "story_id", error: "Timeout", adcreative_id: c.id, video_id: videoId })); }

        // Step 5: Get page token & publish
        const pagesRes = await elFetch(`https://graph.facebook.com/me/accounts?fields=access_token,id&limit=100&access_token=${encodeURIComponent(accessToken)}`);
        const pages = pagesRes.json();
        const page = (pages.data || []).find(pg => pg.id === pageId);
        const pageToken = page ? page.access_token : accessToken;

        const pub = await elFetch(`https://graph.facebook.com/v16.0/${storyId}?access_token=${encodeURIComponent(pageToken)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_published: true })
        });
        const pubR = pub.json();
        if (pubR.error && pubR.error.code !== 1) return res.end(JSON.stringify({ ok: false, step: "publish", error: pubR.error.message }));

        return res.end(JSON.stringify({ ok: true, story_id: storyId, video_id: videoId, post_url: `https://www.facebook.com/${storyId.replace("_", "/posts/")}` }));
      } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
    }

    // /page-comment — comment on a post/story as the PAGE (not the logged-in user).
    // Resolves the PAGE access token from /me/accounts internally and posts the comment
    // with that token only. Fails closed if the page token is missing — it NEVER falls
    // back to the session user token (the bug that made comments appear authored by the
    // logged-in user). The session/user/page tokens are used only against Graph and are
    // never returned or logged.
    if (p === "/page-comment" && req.method === "POST") {
      try {
        const pageId = String(params.page_id || "").trim();
        const target = String(params.story_id || params.post_id || "").trim();
        const message = String(params.message || "").trim();
        if (!pageId || !target || !message) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, step: "validate", error: "Missing: page_id, story_id (or post_id), message" }));
        }
        if (!accessToken) {
          res.writeHead(409);
          return res.end(JSON.stringify({ ok: false, step: "session", error: "no_session" }));
        }
        // Resolve the PAGE access token for page_id via the session user token.
        const pagesRes = await elFetch(`https://graph.facebook.com/me/accounts?fields=access_token,id,name&limit=100&access_token=${encodeURIComponent(accessToken)}`);
        const pagesData = pagesRes.json();
        if (pagesData.error) {
          return res.end(JSON.stringify({ ok: false, step: "pages", error: pagesData.error.message || "me_accounts_failed" }));
        }
        const page = (pagesData.data || []).find(pg => String(pg.id) === pageId);
        const pageToken = page && page.access_token ? page.access_token : "";
        const pageName = page && page.name ? String(page.name) : "";
        // Fail closed: no page token → do NOT comment as the user.
        if (!pageToken) {
          res.writeHead(403);
          return res.end(JSON.stringify({ ok: false, step: "page_token", error: "page_token_not_found", page_id: pageId }));
        }
        const commentRes = await elFetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(target)}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, access_token: pageToken }),
        });
        const commentData = commentRes.json();
        if (commentData.error || !commentData.id) {
          return res.end(JSON.stringify({ ok: false, step: "comment", error: (commentData.error && commentData.error.message) || "comment_failed", page_id: pageId }));
        }
        return res.end(JSON.stringify({ ok: true, id: String(commentData.id), page_id: pageId, page_name: pageName, author_expected: "page" }));
      } catch (e) { return res.end(JSON.stringify({ ok: false, step: "exception", error: e.message })); }
    }

    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: "Use /token, /session, /pages, /post, /page-comment" }));
  }).listen(LOCAL_PORT, () => safeLog(`API: http://localhost:${LOCAL_PORT}`));
}

function getWebUI() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FB Video One Card Post</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f0f2f5;color:#1c1e21;min-height:100vh;display:flex;justify-content:center;padding:24px}
  .container{width:100%;max-width:560px}
  .header{background:#1877f2;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0;display:flex;align-items:center;gap:12px}
  .header svg{width:32px;height:32px;fill:#fff;flex-shrink:0}
  .header h1{font-size:20px;font-weight:600}
  .header .sub{font-size:13px;opacity:.85;margin-top:2px}
  .card{background:#fff;border-radius:0 0 12px 12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
  .session-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;margin-bottom:20px;font-size:13px;font-weight:500}
  .session-bar.ok{background:#e7f3e8;color:#1a7f2b}
  .session-bar.err{background:#fde8e8;color:#c0392b}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .session-bar.ok .dot{background:#1a7f2b}
  .session-bar.err .dot{background:#c0392b}
  label{display:block;font-size:13px;font-weight:600;color:#606770;margin-bottom:4px;margin-top:14px}
  label:first-of-type{margin-top:0}
  input,select,textarea{width:100%;padding:10px 12px;border:1.5px solid #dddfe2;border-radius:8px;font-size:14px;font-family:inherit;transition:border .15s}
  input:focus,select:focus,textarea:focus{outline:none;border-color:#1877f2;box-shadow:0 0 0 2px rgba(24,119,242,.15)}
  textarea{resize:vertical;min-height:70px}
  .btn{display:block;width:100%;padding:12px;margin-top:20px;background:#1877f2;color:#fff;font-size:15px;font-weight:600;border:none;border-radius:8px;cursor:pointer;transition:background .15s}
  .btn:hover{background:#166fe5}
  .btn:disabled{background:#a0c4f1;cursor:not-allowed}
  .progress{margin-top:16px;display:none}
  .step{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:#606770}
  .step.active{color:#1877f2;font-weight:600}
  .step.done{color:#1a7f2b}
  .step.fail{color:#c0392b}
  .step .icon{width:18px;text-align:center;flex-shrink:0}
  .result{margin-top:16px;display:none;padding:14px;border-radius:8px;font-size:14px}
  .result.success{background:#e7f3e8;color:#1a7f2b}
  .result.error{background:#fde8e8;color:#c0392b}
  .result a{color:#1877f2;text-decoration:none;font-weight:600;word-break:break-all}
  .result a:hover{text-decoration:underline}
  .row{display:flex;gap:12px}
  .row>div{flex:1}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <svg viewBox="0 0 36 36"><path d="M15 35.8C6.5 34.3 0 26.9 0 18 0 8.1 8.1 0 18 0s18 8.1 18 18c0 8.9-6.5 16.3-15 17.8v-12.6h4.2l.8-4.8H21v-3.1c0-1.3.7-2.6 2.7-2.6h2.1v-4.1s-1.9-.3-3.7-.3c-3.8 0-6.3 2.3-6.3 6.5v3.6h-4.2v4.8H15V35.8z"/></svg>
    <div><h1>Video One Card Post</h1><div class="sub">Create one-card link posts with video</div></div>
  </div>
  <div class="card">
    <div id="session" class="session-bar err"><div class="dot"></div><span>Checking session...</span></div>

    <label>Page</label>
    <select id="page"><option value="">Loading pages...</option></select>

    <label>Ad Account</label>
    <input id="adAccount" value="act_1148837732288721" placeholder="act_XXXXXXX">

    <label>Video URL</label>
    <input id="videoUrl" placeholder="https://example.com/video.mp4">

    <label>Primary Text</label>
    <textarea id="message" placeholder="Post caption / primary text"></textarea>

    <div class="row">
      <div><label>Card Title</label><input id="title" placeholder="Headline on the card"></div>
      <div><label>Card Description</label><input id="description" placeholder="Description below title"></div>
    </div>

    <label>Website URL</label>
    <input id="websiteUrl" placeholder="https://yoursite.com">

    <label>Call to Action</label>
    <select id="cta">
      <option value="SHOP_NOW">Shop Now</option>
      <option value="NO_BUTTON">No Button</option>
    </select>

    <button class="btn" id="publishBtn" onclick="publish()">Publish</button>

    <div class="progress" id="progress">
      <div class="step" id="s1"><span class="icon">&#9711;</span> Uploading video</div>
      <div class="step" id="s2"><span class="icon">&#9711;</span> Waiting for thumbnails</div>
      <div class="step" id="s3"><span class="icon">&#9711;</span> Creating ad creative</div>
      <div class="step" id="s4"><span class="icon">&#9711;</span> Publishing post</div>
    </div>

    <div class="result" id="result"></div>
  </div>
</div>

<script>
const API = "http://localhost:${LOCAL_PORT}";
let pages = [];

async function init() {
  // Check session
  try {
    const r = await fetch(API + "/token");
    const d = await r.json();
    const el = document.getElementById("session");
    if (d.ok && d.accessToken) {
      el.className = "session-bar ok";
      el.innerHTML = '<div class="dot"></div><span>' + (d.user || "Connected") + ' &mdash; session active</span>';
    } else {
      el.className = "session-bar err";
      el.innerHTML = '<div class="dot"></div><span>No session &mdash; open Ads Manager window first</span>';
    }
  } catch(e) {
    document.getElementById("session").innerHTML = '<div class="dot"></div><span>Cannot reach local server</span>';
  }

  // Load pages
  try {
    const r = await fetch(API + "/pages");
    const d = await r.json();
    const sel = document.getElementById("page");
    if (d.data && d.data.length) {
      pages = d.data;
      sel.innerHTML = d.data.map(p => '<option value="' + p.id + '">' + p.name + ' (' + p.id + ')</option>').join("");
    } else if (d.error) {
      sel.innerHTML = '<option value="">Error: ' + d.error.message + '</option>';
    } else {
      sel.innerHTML = '<option value="">No pages found</option>';
    }
  } catch(e) {
    document.getElementById("page").innerHTML = '<option value="">Failed to load pages</option>';
  }
}

function setStep(n, state) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById("s" + i);
    if (i < n) { el.className = "step done"; el.querySelector(".icon").textContent = "\\u2713"; }
    else if (i === n) {
      el.className = "step " + state;
      el.querySelector(".icon").textContent = state === "done" ? "\\u2713" : state === "fail" ? "\\u2717" : "\\u25cb";
    }
    else { el.className = "step"; el.querySelector(".icon").textContent = "\\u25cb"; }
  }
}

async function publish() {
  const btn = document.getElementById("publishBtn");
  const prog = document.getElementById("progress");
  const result = document.getElementById("result");
  btn.disabled = true;
  prog.style.display = "block";
  result.style.display = "none";

  const pageId = document.getElementById("page").value;
  const adAccount = document.getElementById("adAccount").value.trim();
  const videoUrl = document.getElementById("videoUrl").value.trim();
  const message = document.getElementById("message").value;
  const title = document.getElementById("title").value;
  const description = document.getElementById("description").value;
  const websiteUrl = document.getElementById("websiteUrl").value.trim();
  const cta = document.getElementById("cta").value;

  if (!pageId || !adAccount || !videoUrl) {
    result.className = "result error"; result.style.display = "block";
    result.textContent = "Please fill in Page, Ad Account, and Video URL.";
    btn.disabled = false; return;
  }

  setStep(1, "active");

  const params = new URLSearchParams({
    ad_account: adAccount, page_id: pageId, video_url: videoUrl,
    message, title, description, website_url: websiteUrl, cta
  });

  try {
    const r = await fetch(API + "/post?" + params.toString());
    const d = await r.json();

    if (d.ok) {
      setStep(4, "done");
      result.className = "result success"; result.style.display = "block";
      result.innerHTML = 'Published! <a href="' + d.post_url + '" target="_blank">' + d.post_url + '</a>';
    } else {
      const stepMap = { upload_video: 1, thumbnails: 2, adcreative: 3, story_id: 4, publish: 4 };
      const failAt = stepMap[d.step] || 1;
      setStep(failAt, "fail");
      result.className = "result error"; result.style.display = "block";
      result.textContent = "Failed at " + (d.step || "unknown") + ": " + (d.error || JSON.stringify(d));
    }
  } catch(e) {
    setStep(1, "fail");
    result.className = "result error"; result.style.display = "block";
    result.textContent = "Network error: " + e.message;
  }
  btn.disabled = false;
}

init();
</script>
</body>
</html>`;
}

app.dock.hide();
app.whenReady().then(() => {
  createWindow(); createTray(); startServer(); startTunnel();
});
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => { isQuitting = true; stopTunnel(); });
