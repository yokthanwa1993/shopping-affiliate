const { app, BrowserWindow, Tray, Menu, nativeImage, shell, protocol, session } = require('electron');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3001;
const ACCOUNT = { username: 'affiliate@neezs.com', password: '!Affiliate@neezs' };
let tray = null;
let mainWindow = null;

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

// ── Shopee GraphQL via WebView XHR ─────────────────────────────────────────────
// Runs in Shopee's page context → Shopee SDK auto-injects security headers

async function generateLink(url, subIds) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('WebView ยังไม่พร้อม');
  }

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

  // executeJavaScript runs in renderer (Shopee page context)
  // Shopee's SDK hooks XMLHttpRequest and adds security headers automatically
  const result = await mainWindow.webContents.executeJavaScript(`
    (function() {
      return new Promise((resolve) => {
        try {
          const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
          const csrfToken = csrfMatch ? csrfMatch[1] : '';

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

// ── HTTP Server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const [pathname, qs] = req.url.split('?');
  const params = new URLSearchParams(qs || '');
  const rawUrl = params.get('url');
  const expandedUrl = rawUrl ? await expandUrl(rawUrl) : null;
  const url = expandedUrl ? normalizeShopeeUrl(expandedUrl) : null;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/status') {
    const webviewReady = !!(mainWindow && !mainWindow.isDestroyed());
    const currentUrl = webviewReady ? mainWindow.webContents.getURL() : '';
    const isAffiliatePage = currentUrl.includes('affiliate.shopee.co.th');
    const isOnCustomLink = currentUrl.includes('/offer/custom_link') || currentUrl.includes('/offer');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      server: true,
      webview: webviewReady,
      url: currentUrl,
      loggedIn: isAffiliatePage && isOnCustomLink,
    }));
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
      const info = await mainWindow.webContents.executeJavaScript(`({
        url: location.href,
        cookie: document.cookie.substring(0, 200),
        title: document.title,
        readyState: document.readyState,
      })`);
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
    const { shortLink, utmSource } = await generateLink(url, subIds);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      originalLink: rawUrl || null,
      longLink: url,
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
});

// ── Cloudflare Worker Bridge (poll loop) ──────────────────────────────────────
// รัน polling loop ใน main process — แทน Chrome extension

const WORKER_URL = 'https://neezs-shopee-shortlink.yokthanwa1993-bc9.workers.dev';
const WORKER_WS  = 'wss://neezs-shopee-shortlink.yokthanwa1993-bc9.workers.dev/ws';
let bridgeRunning = false;
let bridgeWs = null;

async function startBridge() {
  if (bridgeRunning) return;
  bridgeRunning = true;
  connectBridgeWs();
}

function connectBridgeWs() {
  if (!bridgeRunning) return;

  console.log('[Bridge] Connecting WebSocket →', WORKER_WS);
  const ws = new WebSocket(WORKER_WS);
  bridgeWs = ws;

  ws.on('open', () => {
    console.log('[Bridge] WebSocket connected ✅');
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    const { jobId, payload } = msg;
    if (!jobId || !payload) return;

    const { rawUrl, subId1, subId2, subId3, subId4, subId5 } = payload;
    const subIds = [subId1, subId2, subId3, subId4, subId5].map(v => v || '');

    // expand s.shopee.co.th → full URL, then normalize
    const expandedUrl = await expandUrl(rawUrl);
    const productUrl = normalizeShopeeUrl(expandedUrl);
    console.log('[Bridge] Job:', jobId, rawUrl, '→', productUrl);

    try {
      const { shortLink, utmSource } = await generateLink(productUrl, subIds);
      ws.send(JSON.stringify({ jobId, ok: true, shortLink, utmSource, normalizedUrl: productUrl, redirectUrl: expandedUrl !== rawUrl ? expandedUrl.split('?')[0] : undefined }));
      console.log('[Bridge] Done:', shortLink);
    } catch (err) {
      ws.send(JSON.stringify({ jobId, ok: false, error: err.message }));
      console.error('[Bridge] Error:', err.message);
    }
  });

  ws.on('close', () => {
    bridgeWs = null;
    console.log('[Bridge] Disconnected — reconnecting in 3s...');
    if (bridgeRunning) setTimeout(connectBridgeWs, 3000);
  });

  ws.on('error', (err) => {
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
      label: 'เปิด localhost:3000',
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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    title: 'Shopee Affiliate',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Allow mixed content & local resources
      allowRunningInsecureContent: false,
      webSecurity: true,
    },
  });

  mainWindow.loadURL('https://affiliate.shopee.co.th/offer/custom_link');

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

  // ── Start Cloudflare Worker bridge after WebView loads ──
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
