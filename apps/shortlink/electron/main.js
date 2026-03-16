const { app, BrowserWindow, Tray, Menu, nativeImage, shell, protocol, session, screen } = require('electron');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

function envOrDefault(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : fallback;
}

const PORT = Number(process.env.SHORTLINK_HTTP_PORT || 3000);
const ACCOUNT = {
  username: envOrDefault('SHORTLINK_ACCOUNT_EMAIL', 'affiliate@chearb.com'),
  password: envOrDefault('SHORTLINK_ACCOUNT_PASSWORD', '!@7EvaYLj986'),
};
const AFFILIATE_URL = envOrDefault('SHORTLINK_AFFILIATE_URL', 'https://affiliate.shopee.co.th/offer/custom_link');
const AFFILIATE_LOGIN_URL = `https://shopee.co.th/buyer/login?next=${encodeURIComponent(AFFILIATE_URL)}`;
const ACCOUNT_KEY = envOrDefault('SHORTLINK_ACCOUNT_KEY', 'chearb').trim().toLowerCase();
const APP_NAME = envOrDefault('SHORTLINK_APP_NAME', `Shopee Shortlink (${ACCOUNT_KEY})`);
const LOCALHOST_LABEL = envOrDefault('SHORTLINK_LOCALHOST_LABEL', `เปิด localhost:${PORT}`);
const BRIDGE_HEARTBEAT_MS = 15000;
const BRIDGE_STALE_MS = 45000;
const BRIDGE_CONNECT_TIMEOUT_MS = 15000;
const BRIDGE_RECONNECT_DELAY_MS = 3000;
const VNC_TARGETS = {
  chearb: process.env.SHORTLINK_VNC_CHEARB || 'https://chearbshortlink.pubilo.com/vnc.html?autoconnect=1&resize=remote',
  neezs: process.env.SHORTLINK_VNC_NEEZS || 'https://neezsshortlink.pubilo.com/vnc.html?autoconnect=1&resize=remote',
  golf: process.env.SHORTLINK_VNC_GOLF || 'https://golfshortlink.pubilo.com/vnc.html?autoconnect=1&resize=remote',
  first: process.env.SHORTLINK_VNC_FIRST || 'https://firstshortlink.pubilo.com/vnc.html?autoconnect=1&resize=remote',
};
let tray = null;
let mainWindow = null;
let lastJobStartedAt = 0;
let lastJobFinishedAt = 0;
let lastJobError = '';
let loadAffiliatePage = null;
let jobQueue = Promise.resolve();

function fitMainWindowToDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  mainWindow.setBounds({ x, y, width, height });
  mainWindow.setFullScreen(true);
}

function resetWebContentsScale() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const { webContents } = mainWindow;
    if (!webContents || webContents.isDestroyed()) return;

    webContents.setZoomLevel(0);
    webContents.setZoomFactor(1);
  } catch (_) {
    // Display topology can change while a frame is being replaced.
  }
}

// ── URL normalizer ─────────────────────────────────────────────────────────────

function normalizeShopeeUrl(url) {
  // รูปแบบ i-i: /i.{shopId}.{itemId} หรือ -i.{shopId}.{itemId}
  const matchI = url.match(/[-./]i\.(\d+)\.(\d+)/);
  if (matchI) return `https://shopee.co.th/product/${matchI[1]}/${matchI[2]}`;

  // รูปแบบ /{username}/{shopId}/{itemId}
  const matchPath = url.match(/shopee\.co\.th\/[^/?]+\/(\d{5,})\/(\d{5,})/);
  if (matchPath) return `https://shopee.co.th/product/${matchPath[1]}/${matchPath[2]}`;

  return url;
}

// ── URL expander (follow s.shopee.co.th redirect) ──────────────────────────────

async function expandUrl(url) {
  if (!url.includes('s.shopee.co.th')) return url;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const location = res.headers.get('location');
    return location || url;
  } catch (_) {
    return url;
  }
}

// ── Auto Login ─────────────────────────────────────────────────────────────────

async function autoLogin() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!ACCOUNT.username || !ACCOUNT.password) {
    console.log('[AutoLogin] Missing credentials — waiting for manual login');
    return;
  }
  const currentUrl = mainWindow.webContents.getURL();
  // หน้า login อยู่ที่ shopee.co.th/buyer/login
  if (!currentUrl.includes('/buyer/login')) return;

  console.log('[AutoLogin] Detected login page — waiting for form...');
  await mainWindow.webContents.executeJavaScript(`
    (function tryFill(attempt) {
      const setVal = (el, val) => {
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      };
      const user = document.querySelector('input[name="loginKey"]');
      const pass = document.querySelector('input[name="password"]');
      if (!user || !pass) {
        if (attempt < 10) setTimeout(() => tryFill(attempt + 1), 500);
        else console.log('[AutoLogin] form not found after retries');
        return;
      }
      setVal(user, ${JSON.stringify(ACCOUNT.username)});
      setVal(pass, ${JSON.stringify(ACCOUNT.password)});
      console.log('[AutoLogin] filled — user:', user.value, 'pass.length:', pass.value.length);
      setTimeout(() => {
        // หา button ด้วย text content (stable กว่า class name)
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().includes('เข้าสู่ระบบ'));
        if (btn) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          console.log('[AutoLogin] clicked btn:', btn.textContent.trim(), 'disabled:', btn.disabled);
        } else {
          // fallback: Enter key
          pass.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          console.log('[AutoLogin] sent Enter key');
        }
      }, 1000);
    })(0)
  `);
}

async function getAffiliateSessionSnapshot() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return {
      cookies: [],
      cookieNames: [],
      csrfToken: '',
      hasAuthCookie: false,
    };
  }

  const webSession = mainWindow.webContents.session || session.defaultSession;
  const cookieUrls = [
    'https://affiliate.shopee.co.th',
    'https://shopee.co.th',
  ];

  try {
    const cookieLists = await Promise.all(cookieUrls.map((url) => webSession.cookies.get({ url })));
    const cookies = [];
    const seen = new Set();

    for (const list of cookieLists) {
      for (const cookie of list) {
        const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cookies.push(cookie);
      }
    }

    const findCookie = (name) => cookies.find((cookie) => cookie.name === name && cookie.value);
    const csrfToken = findCookie('csrftoken')?.value || '';
    const hasAuthCookie = Boolean(
      csrfToken ||
      findCookie('SPC_F') ||
      findCookie('SPC_EC') ||
      findCookie('SPC_T_ID') ||
      findCookie('SPC_CDS') ||
      findCookie('SPC_SI')
    );

    return {
      cookies,
      cookieNames: cookies.map((cookie) => cookie.name),
      csrfToken,
      hasAuthCookie,
    };
  } catch (error) {
    return {
      cookies: [],
      cookieNames: [],
      csrfToken: '',
      hasAuthCookie: false,
      cookieError: error.message,
    };
  }
}

// ── Shopee GraphQL via WebView XHR ─────────────────────────────────────────────
// Runs in Shopee's page context → Shopee SDK auto-injects security headers

async function generateLink(url, subIds) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('WebView ยังไม่พร้อม');
  }

  await ensureAffiliateContext();

  const advancedLinkParams = {};
  const keys = ['subId1', 'subId2', 'subId3', 'subId4', 'subId5'];
  subIds.forEach((val, i) => { if (val) advancedLinkParams[keys[i]] = val; });

  const gqlBody = {
    operationName: 'batchGetCustomLink',
    query: `
      query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){
        batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){
          shortLink longLink failCode
        }
      }
    `,
    variables: {
      linkParams: [{ originalLink: url, advancedLinkParams }],
      sourceCaller: 'CUSTOM_LINK_CALLER',
    },
  };

  const endpoint = 'https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink';
  const bodyStr = JSON.stringify(gqlBody);
  const sessionSnapshot = await getAffiliateSessionSnapshot();
  const sessionCsrfToken = sessionSnapshot.csrfToken;

  // executeJavaScript runs in renderer (Shopee page context)
  // Shopee's SDK hooks XMLHttpRequest and adds security headers automatically
  const result = await mainWindow.webContents.executeJavaScript(`
    (function() {
      return new Promise((resolve) => {
        try {
          let fallbackMatch = null;
          try {
            fallbackMatch = document.cookie.match(/csrftoken=([^;]+)/);
          } catch (_) {}
          const csrfToken = ${JSON.stringify(sessionCsrfToken)} || (fallbackMatch ? fallbackMatch[1] : '');

          const xhr = new XMLHttpRequest();
          xhr.open('POST', ${JSON.stringify(endpoint)}, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
          xhr.setRequestHeader('affiliate-program-type', '1');
          if (csrfToken) xhr.setRequestHeader('csrf-token', csrfToken);

          xhr.onload = () => {
            try {
              if (xhr.status !== 200) {
                resolve({ ok: false, error: 'HTTP ' + xhr.status });
                return;
              }
              const data = JSON.parse(xhr.responseText);
              const links = data && data.data && data.data.batchCustomLink;
              if (!links || !links.length) {
                resolve({ ok: false, error: 'Shopee ไม่ส่งผลลัพธ์กลับมา' });
                return;
              }
              const link = links[0];
              if (link.failCode && link.failCode !== 0) {
                resolve({ ok: false, error: 'Shopee failCode: ' + link.failCode });
                return;
              }
              if (!link.shortLink) {
                resolve({ ok: false, error: 'ไม่ได้ shortLink กลับมา' });
                return;
              }
              const utmSource = (() => {
                try {
                  const u = new URL(link.longLink || '');
                  return u.searchParams.get('utm_source') || undefined;
                } catch (_) { return undefined; }
              })();
              resolve({ ok: true, shortLink: link.shortLink, utmSource });
            } catch (e) {
              resolve({ ok: false, error: 'parse error: ' + e.message });
            }
          };
          xhr.onerror = () => resolve({ ok: false, error: 'XHR network error' });
          xhr.timeout = 15000;
          xhr.ontimeout = () => resolve({ ok: false, error: 'Shopee API timeout' });
          xhr.send(${JSON.stringify(bodyStr)});
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    })()
  `);

  if (!result.ok) throw new Error(result.error);
  return { shortLink: result.shortLink, utmSource: result.utmSource };
}

function enqueueJob(task) {
  const runner = jobQueue.then(task, task);
  jobQueue = runner.catch(() => {});
  return runner;
}

async function runShortlinkJob(rawUrl, subIds) {
  const expandedUrl = await expandUrl(rawUrl);
  const normalizedUrl = normalizeShopeeUrl(expandedUrl);
  console.log('[Shortlink] Job:', rawUrl, '→', normalizedUrl);

  lastJobStartedAt = Date.now();
  lastJobError = '';

  try {
    const result = await generateLink(normalizedUrl, subIds);
    lastJobFinishedAt = Date.now();
    return { ...result, expandedUrl, normalizedUrl };
  } catch (error) {
    lastJobFinishedAt = Date.now();
    lastJobError = error.message;
    throw error;
  }
}

function isAffiliatePageUrl(url = '') {
  return url.includes('affiliate.shopee.co.th');
}

function isCustomLinkPageUrl(url = '') {
  return url.startsWith(AFFILIATE_URL) || url.includes('affiliate.shopee.co.th/offer/custom_link');
}

async function probeAffiliatePageAccess() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { href: '', cookieReadable: false, readyState: 'unknown' };
  }

  try {
    return await mainWindow.webContents.executeJavaScript(`
      (() => {
        try {
          void document.cookie;
          return {
            href: location.href,
            cookieReadable: true,
            readyState: document.readyState
          };
        } catch (error) {
          return {
            href: location.href,
            cookieReadable: false,
            readyState: document.readyState,
            error: error.message
          };
        }
      })()
    `);
  } catch (error) {
    return {
      href: '',
      cookieReadable: false,
      readyState: 'unknown',
      error: error.message,
    };
  }
}

function isLoginPageUrl(url = '') {
  return url.includes('/buyer/login');
}

function isCaptchaPageUrl(url = '') {
  return url.includes('/verify/captcha');
}

async function ensureAffiliateContext() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('WebView ยังไม่พร้อม');
  }

  const deadline = Date.now() + 20000;
  let lastReloadAt = 0;

  while (Date.now() < deadline) {
    const currentUrl = mainWindow.webContents.getURL();
    const probe = await probeAffiliatePageAccess();
    const probeUrl = typeof probe?.href === 'string' ? probe.href : '';
    const sessionSnapshot = await getAffiliateSessionSnapshot();

    if (isCustomLinkPageUrl(currentUrl) && isCustomLinkPageUrl(probeUrl) && probe?.cookieReadable && sessionSnapshot.hasAuthCookie) {
      return currentUrl;
    }

    if (isLoginPageUrl(currentUrl)) {
      await autoLogin();
    } else if (isLoginPageUrl(probeUrl)) {
      await autoLogin();
    } else if (isCaptchaPageUrl(currentUrl)) {
      throw new Error('Shopee ต้องยืนยัน CAPTCHA ในหน้าจอ');
    } else if (isCaptchaPageUrl(probeUrl)) {
      throw new Error('Shopee ต้องยืนยัน CAPTCHA ในหน้าจอ');
    } else if ((isCustomLinkPageUrl(currentUrl) || isCustomLinkPageUrl(probeUrl)) && !sessionSnapshot.hasAuthCookie) {
      if (typeof loadAffiliatePage === 'function' && Date.now() - lastReloadAt >= 4000) {
        lastReloadAt = Date.now();
        void loadAffiliatePage({ forceLogin: true });
      }
    } else if (typeof loadAffiliatePage === 'function' && Date.now() - lastReloadAt >= 4000) {
      lastReloadAt = Date.now();
      void loadAffiliatePage();
    }

    await sleep(1500);
  }

  throw new Error('Shopee custom_link page ไม่พร้อม');
}

// ── HTTP Server ────────────────────────────────────────────────────────────────

function getBridgeReadyState() {
  if (!bridgeWs) return 'CLOSED';
  switch (bridgeWs.readyState) {
    case WebSocket.CONNECTING:
      return 'CONNECTING';
    case WebSocket.OPEN:
      return 'OPEN';
    case WebSocket.CLOSING:
      return 'CLOSING';
    case WebSocket.CLOSED:
    default:
      return 'CLOSED';
  }
}

function getBridgeSnapshot() {
  const now = Date.now();
  const lastSeenAt = Math.max(bridgeLastPongAt, bridgeLastMessageAt, bridgeLastConnectAt, 0);
  const staleForMs = lastSeenAt ? now - lastSeenAt : null;

  return {
    running: bridgeRunning,
    connected: getBridgeReadyState() === 'OPEN',
    readyState: getBridgeReadyState(),
    lastConnectAt: bridgeLastConnectAt || null,
    lastDisconnectAt: bridgeLastDisconnectAt || null,
    lastPongAt: bridgeLastPongAt || null,
    lastMessageAt: bridgeLastMessageAt || null,
    lastSeenAt: lastSeenAt || null,
    staleForMs,
    reconnectAttempts: bridgeReconnectAttempts,
    reconnectScheduled: Boolean(bridgeReconnectTimer),
    lastError: bridgeLastError || null,
  };
}

function renderViewerLauncherHtml() {
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shortlink Viewer</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#f3f4f6;font-family:system-ui,sans-serif}
    .card{width:min(560px,calc(100vw - 32px));background:#171a20;border:1px solid #2a3040;border-radius:20px;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
    h1{margin:0 0 8px;font-size:28px}
    p{margin:0 0 20px;color:#aab2c5;line-height:1.5}
    .actions{display:grid;gap:12px}
    a{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-radius:14px;background:#202634;color:#fff;text-decoration:none;border:1px solid #31394d}
    a:hover{background:#263047}
    code{background:#11151f;border:1px solid #31394d;padding:2px 6px;border-radius:8px;color:#dbe5ff}
  </style>
</head>
<body>
  <div class="card">
    <h1>Shortlink Viewer</h1>
    <p>เลือก account ที่ต้องการเปิดหน้าจอ KasmVNC หรือตรงด้วย query เช่น <code>/vnc.html?launch=chearb</code></p>
    <div class="actions">
      <a href="/vnc.html?launch=chearb">เปิด chearb <span>→</span></a>
      <a href="/vnc.html?launch=neezs">เปิด neezs <span>→</span></a>
      <a href="/vnc.html?launch=golf">เปิด golf <span>→</span></a>
      <a href="/vnc.html?launch=first">เปิด first <span>→</span></a>
    </div>
  </div>
</body>
</html>`;
}

async function buildStatusPayload() {
  const webviewReady = !!(mainWindow && !mainWindow.isDestroyed());
  const currentUrl = webviewReady ? mainWindow.webContents.getURL() : '';
  const isAffiliatePage = isAffiliatePageUrl(currentUrl);
  const isCustomLinkPage = isCustomLinkPageUrl(currentUrl);
  const isLoginPage = isLoginPageUrl(currentUrl);
  const isCaptchaPage = isCaptchaPageUrl(currentUrl);
  const probe = webviewReady ? await probeAffiliatePageAccess() : { cookieReadable: false, readyState: 'unknown', href: '' };
  const sessionSnapshot = webviewReady ? await getAffiliateSessionSnapshot() : { hasAuthCookie: false, cookies: [] };
  const bridge = getBridgeSnapshot();
  const loggedIn = isAffiliatePage && !isLoginPage && !isCaptchaPage && sessionSnapshot.hasAuthCookie;
  const ready = webviewReady && bridge.connected && isCustomLinkPage && !isLoginPage && !isCaptchaPage && sessionSnapshot.hasAuthCookie && probe.cookieReadable;

  return {
    server: true,
    webview: webviewReady,
    url: currentUrl,
    loggedIn,
    affiliatePage: isAffiliatePage,
    customLinkPage: isCustomLinkPage,
    ready,
    captcha: isCaptchaPage,
    rendererReadyState: probe.readyState,
    cookieReadable: probe.cookieReadable,
    rendererUrl: probe.href || null,
    rendererError: probe.error || null,
    sessionCookieCount: sessionSnapshot.cookies.length,
    bridge,
    lastJobStartedAt: lastJobStartedAt || null,
    lastJobFinishedAt: lastJobFinishedAt || null,
    lastJobError: lastJobError || null,
  };
}

function buildLivenessPayload() {
  const webviewReady = !!(mainWindow && !mainWindow.isDestroyed());
  return {
    server: true,
    webview: webviewReady,
    url: webviewReady ? mainWindow.webContents.getURL() : '',
    bridge: getBridgeSnapshot(),
    lastJobStartedAt: lastJobStartedAt || null,
    lastJobFinishedAt: lastJobFinishedAt || null,
    lastJobError: lastJobError || null,
  };
}

async function handleRequest(req, res) {
  const [pathname, qs] = req.url.split('?');
  const params = new URLSearchParams(qs || '');
  const rawUrl = params.get('url');
  const expandedUrl = rawUrl ? await expandUrl(rawUrl) : null;
  const url = expandedUrl ? normalizeShopeeUrl(expandedUrl) : null;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/vnc.html' || pathname === '/viewer') {
    const launch = (params.get('launch') || '').trim().toLowerCase();
    const target = VNC_TARGETS[launch];
    if (target) {
      res.writeHead(302, { Location: target });
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderViewerLauncherHtml());
    return;
  }

  if (pathname === '/livez') {
    const payload = buildLivenessPayload();
    const statusCode = payload.server && payload.webview ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (pathname === '/status') {
    const payload = await buildStatusPayload();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (pathname === '/readyz') {
    const payload = await buildStatusPayload();
    const statusCode = payload.ready ? 200 : 503;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  // Debug: run JS in WebView and return result
  if (pathname === '/debug') {
    if (!mainWindow || mainWindow.isDestroyed()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no webview' }));
      return;
    }
    try {
      const sessionSnapshot = await getAffiliateSessionSnapshot();
      const info = await mainWindow.webContents.executeJavaScript(`({
        url: location.href,
        cookie: document.cookie.substring(0, 200),
        title: document.title,
        readyState: document.readyState,
      })`);
      info.sessionCookieCount = sessionSnapshot.cookies.length;
      info.sessionCookieNames = sessionSnapshot.cookieNames;
      info.hasAuthCookie = sessionSnapshot.hasAuthCookie;
      info.hasCsrfToken = Boolean(sessionSnapshot.csrfToken);
      if (sessionSnapshot.cookieError) info.cookieError = sessionSnapshot.cookieError;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (!url) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shopee Shortlink</title>
<style>body{font-family:system-ui;padding:32px;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:28px;max-width:500px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.brand{font-size:20px;font-weight:800;color:#EE4D2D;margin-bottom:4px}
.sub{color:#999;font-size:13px;margin-bottom:20px}
code{background:#f0f0f0;padding:2px 8px;border-radius:4px;font-size:12px}</style>
</head><body><div class="card">
<div class="brand">Shopee Shortlink</div>
<div class="sub">Electron App — localhost:${PORT}</div>
<p>วิธีใช้: <code>localhost:${PORT}?url=https://shopee.co.th/i-i.xxx.yyy&sub1=yok</code></p>
</div></body></html>`);
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'WebView ยังไม่พร้อม' }));
    return;
  }

  const subIds = [1, 2, 3, 4, 5].map(i => params.get(`sub${i}`) || '');

  try {
    const { shortLink, utmSource, normalizedUrl } = await enqueueJob(() => runShortlinkJob(rawUrl || url, subIds));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      originalLink: rawUrl || null,
      longLink: normalizedUrl,
      shortLink,
      ...(utmSource ? { utm_source: utmSource } : {}),
      sub1: params.get('sub1') || null,
      sub2: params.get('sub2') || null,
      sub3: params.get('sub3') || null,
      sub4: params.get('sub4') || null,
      sub5: params.get('sub5') || null,
    }));
  } catch (err) {
    res.writeHead(504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((error) => {
    console.error(`[HTTP] ${req.method} ${req.url} failed:`, error);
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
  });
});

// ── Cloudflare Worker Bridge (poll loop) ──────────────────────────────────────
// รัน polling loop ใน main process — แทน Chrome extension

const WORKER_URL = process.env.SHORTLINK_WORKER_URL || 'https://chearb-shopee-shortlink.yokthanwa1993-bc9.workers.dev';
const WORKER_WS  = process.env.SHORTLINK_WORKER_WS || `${WORKER_URL.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/ws`;
let bridgeRunning = false;
let bridgeWs = null;
let bridgeReconnectTimer = null;
let bridgeHeartbeatTimer = null;
let bridgeWatchdogTimer = null;
let bridgeConnectStartedAt = 0;
let bridgeLastConnectAt = 0;
let bridgeLastDisconnectAt = 0;
let bridgeLastPongAt = 0;
let bridgeLastMessageAt = 0;
let bridgeReconnectAttempts = 0;
let bridgeLastError = '';

async function startBridge() {
  if (bridgeRunning) return connectBridgeWs();
  bridgeRunning = true;
  startBridgeWatchdog();
  connectBridgeWs();
}

function clearBridgeHeartbeat() {
  if (!bridgeHeartbeatTimer) return;
  clearInterval(bridgeHeartbeatTimer);
  bridgeHeartbeatTimer = null;
}

function startBridgeHeartbeat(ws) {
  clearBridgeHeartbeat();
  bridgeHeartbeatTimer = setInterval(() => {
    if (!bridgeRunning || bridgeWs !== ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch (error) {
      bridgeLastError = error.message;
    }
  }, BRIDGE_HEARTBEAT_MS);
}

function scheduleBridgeReconnect(reason, delayMs = BRIDGE_RECONNECT_DELAY_MS) {
  if (!bridgeRunning || bridgeReconnectTimer) return;
  bridgeReconnectAttempts += 1;
  console.log(`[Bridge] Reconnecting in ${delayMs}ms (${reason})`);
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null;
    connectBridgeWs();
  }, delayMs);
}

function startBridgeWatchdog() {
  if (bridgeWatchdogTimer) return;
  bridgeWatchdogTimer = setInterval(() => {
    if (!bridgeRunning) return;

    const state = getBridgeReadyState();
    if (state === 'OPEN') {
      const lastSeenAt = Math.max(bridgeLastPongAt, bridgeLastMessageAt, bridgeLastConnectAt, 0);
      if (lastSeenAt && Date.now() - lastSeenAt > BRIDGE_STALE_MS) {
        console.error('[Bridge] No heartbeat from Worker — forcing reconnect');
        try {
          bridgeWs?.terminate();
        } catch (_) {}
      }
      return;
    }

    if (state === 'CONNECTING') {
      if (bridgeConnectStartedAt && Date.now() - bridgeConnectStartedAt > BRIDGE_CONNECT_TIMEOUT_MS) {
        console.error('[Bridge] Connect timeout — forcing reconnect');
        try {
          bridgeWs?.terminate();
        } catch (_) {}
      }
      return;
    }

    scheduleBridgeReconnect(`socket state ${state}`, 1000);
  }, 5000);
}

function connectBridgeWs() {
  if (!bridgeRunning) return;
  if (bridgeWs && (bridgeWs.readyState === WebSocket.OPEN || bridgeWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log('[Bridge] Connecting WebSocket →', WORKER_WS);
  const ws = new WebSocket(WORKER_WS);
  bridgeWs = ws;
  bridgeConnectStartedAt = Date.now();

  ws.on('open', () => {
    if (bridgeWs !== ws) return;
    console.log('[Bridge] WebSocket connected ✅');
    bridgeLastConnectAt = Date.now();
    bridgeLastMessageAt = bridgeLastConnectAt;
    bridgeLastPongAt = bridgeLastConnectAt;
    bridgeReconnectAttempts = 0;
    bridgeLastError = '';
    startBridgeHeartbeat(ws);
    try {
      ws.send(JSON.stringify({
        type: 'hello',
        port: PORT,
        account: ACCOUNT.username,
        currentUrl: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '',
      }));
    } catch (error) {
      bridgeLastError = error.message;
    }
  });

  ws.on('message', async (data) => {
    if (bridgeWs !== ws) return;
    bridgeLastMessageAt = Date.now();
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (msg?.type === 'pong' || msg?.type === 'hello-ack') {
      bridgeLastPongAt = Date.now();
      return;
    }
    const { jobId, payload } = msg;
    if (!jobId || !payload) return;

    const { rawUrl, subId1, subId2, subId3, subId4, subId5 } = payload;
    const subIds = [subId1, subId2, subId3, subId4, subId5].map(v => v || '');

    try {
      const { shortLink, utmSource, normalizedUrl, expandedUrl } = await enqueueJob(() => runShortlinkJob(rawUrl, subIds));
      ws.send(JSON.stringify({ jobId, ok: true, shortLink, utmSource, normalizedUrl, redirectUrl: expandedUrl !== rawUrl ? expandedUrl.split('?')[0] : undefined }));
      console.log('[Bridge] Done:', shortLink);
    } catch (err) {
      ws.send(JSON.stringify({ jobId, ok: false, error: err.message }));
      console.error('[Bridge] Error:', err.message);
    }
  });

  ws.on('close', () => {
    if (bridgeWs === ws) {
      bridgeWs = null;
    }
    bridgeLastDisconnectAt = Date.now();
    clearBridgeHeartbeat();
    console.log('[Bridge] Disconnected — reconnecting in 3s...');
    scheduleBridgeReconnect('socket closed');
  });

  ws.on('error', (err) => {
    bridgeLastError = err.message;
    console.error('[Bridge] WS error:', err.message);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Tray ───────────────────────────────────────────────────────────────────────

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Shopee Shortlink', enabled: false },
    { label: `localhost:${PORT}`, enabled: false },
    { type: 'separator' },
    {
      label: 'เปิดหน้า Shopee Affiliate',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      },
    },
    {
      label: LOCALHOST_LABEL,
      click: () => shell.openExternal(`http://localhost:${PORT}`),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.exit(0) },
  ]);
}

// ── Register custom schemes early (before app.whenReady) ──────────────────────
// This prevents macOS "no application" dialog for wvjbscheme:// (Shopee's WebViewJavascriptBridge)
protocol.registerSchemesAsPrivileged([
  { scheme: 'wvjbscheme', privileges: { standard: false, secure: false } },
]);

// ── App Ready ──────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Silence wvjbscheme:// requests from Shopee's WebViewJavascriptBridge
  session.defaultSession.protocol.handle('wvjbscheme', () => {
    return new Response('', { status: 200 });
  });

  // Hide Dock icon on macOS (tray-only app)
  if (process.platform === 'darwin') app.dock.hide();

  // ── Main Window (Shopee Affiliate WebView) ──
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    autoHideMenuBar: true,
    fullscreen: true,
    fullscreenable: true,
    maximizable: true,
    title: APP_NAME,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Allow mixed content & local resources
      allowRunningInsecureContent: false,
      webSecurity: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);

  const syncWindowToDisplay = () => {
    fitMainWindowToDisplay();
    resetWebContentsScale();
    mainWindow.show();
    mainWindow.focus();
  };

  screen.on('display-added', syncWindowToDisplay);
  screen.on('display-removed', syncWindowToDisplay);
  screen.on('display-metrics-changed', syncWindowToDisplay);

  mainWindow.once('ready-to-show', syncWindowToDisplay);

  loadAffiliatePage = async function loadAffiliatePageImpl({ forceLogin = false } = {}) {
    resetWebContentsScale();
    const sessionSnapshot = forceLogin ? { hasAuthCookie: false } : await getAffiliateSessionSnapshot();
    const targetUrl = sessionSnapshot.hasAuthCookie ? AFFILIATE_URL : AFFILIATE_LOGIN_URL;
    mainWindow.loadURL(targetUrl);
  };

  void loadAffiliatePage();

  // ถ้าโหลดไม่ได้ (เน็ต/renderer ยังไม่พร้อม) → retry อัตโนมัติ
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDesc) => {
    if (errorCode === -3) return; // ERR_ABORTED (user navigated away) — ไม่ต้อง retry
    console.log(`[Load] failed (${errorCode}: ${errorDesc}) — retrying in 3s...`);
    setTimeout(() => {
      void loadAffiliatePage();
    }, 3000);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    resetWebContentsScale();
  });

  setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const currentUrl = mainWindow.webContents.getURL();
    if (isCaptchaPageUrl(currentUrl)) return;
    const sessionSnapshot = await getAffiliateSessionSnapshot();
    if (isLoginPageUrl(currentUrl)) return;
    if (isCustomLinkPageUrl(currentUrl) && sessionSnapshot.hasAuthCookie) return;
    if (typeof loadAffiliatePage === 'function') {
      await loadAffiliatePage({ forceLogin: !sessionSnapshot.hasAuthCookie });
    }
  }, 15000);

  // Block wvjbscheme:// and other unknown protocols (Shopee WebViewJavascriptBridge)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        event.preventDefault();
      }
    } catch (_) {
      event.preventDefault();
    }
  });

  // Handle external link clicks — open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)) {
        shell.openExternal(url);
      }
    } catch (_) {}
    return { action: 'deny' };
  });

  // Intercept window close → hide instead of quit
  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  // ── Tray ──
  const iconPath = path.join(__dirname, 'icons', 'tray.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
  trayIcon.setTemplateImage(true); // macOS dark/light mode support
  tray = new Tray(trayIcon);

  tray.setToolTip('Shopee Shortlink');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  // ── HTTP Server ──
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`✅ Shopee Shortlink server: http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    console.error('Server error:', err.message);
  });

  // ── Keep Cloudflare Worker bridge alive even if Shopee redirects away temporarily ──
  startBridge();

  mainWindow.webContents.on('did-finish-load', () => {
    const currentUrl = mainWindow.webContents.getURL();
    if (currentUrl.includes('/buyer/login')) {
      autoLogin();
    } else if (currentUrl.includes('affiliate.shopee.co.th')) {
      startBridge();
    }
  });

  // Also start bridge if already on affiliate page (after login)
  mainWindow.webContents.on('did-navigate', (event, url) => {
    if (url.includes('affiliate.shopee.co.th/offer')) {
      startBridge();
    }
  });
});

// Don't quit when all windows are closed (tray app)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  bridgeRunning = false;
  clearBridgeHeartbeat();
  if (bridgeWatchdogTimer) {
    clearInterval(bridgeWatchdogTimer);
    bridgeWatchdogTimer = null;
  }
  if (bridgeReconnectTimer) {
    clearTimeout(bridgeReconnectTimer);
    bridgeReconnectTimer = null;
  }
  try {
    bridgeWs?.terminate();
  } catch (_) {}
});
