const { app, BrowserWindow, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');

// Single instance — prevent duplicate
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

// ==================== CONFIG ====================
const SHOPEE_URL = 'https://affiliate.shopee.co.th/offer/custom_link';
const LAZADA_URL = 'https://www.lazada.co.th';
const API_PORT = 8800;
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// Separate sessions for each platform
const shopeeSession = 'persist:shopee-affiliate';
const lazadaSession = 'persist:lazada-affiliate';

// Load shortlink JS
const SHOPEE_JS = fs.readFileSync(path.join(__dirname, 'shopee-shorten.js'), 'utf8');
const LAZADA_JS = fs.readFileSync(path.join(__dirname, 'lazada-shorten.js'), 'utf8');

// ==================== STATE ====================
let tray = null;
let shopeeWindow = null;
let lazadaWindow = null;
let apiServer = null;

// ==================== BROWSER WINDOWS ====================
function createShopeeWindow(show = false) {
    if (shopeeWindow && !shopeeWindow.isDestroyed()) {
        if (show) { shopeeWindow.show(); shopeeWindow.focus(); }
        return shopeeWindow;
    }

    const ses = session.fromPartition(shopeeSession);
    ses.setUserAgent(CHROME_UA);

    shopeeWindow = new BrowserWindow({
        width: 1200, height: 800,
        title: 'Shopee Affiliate',
        show: show,
        webPreferences: {
            partition: shopeeSession,
            contextIsolation: false,
            nodeIntegration: false,
        },
    });

    shopeeWindow.loadURL(SHOPEE_URL, { userAgent: CHROME_UA });
    shopeeWindow.on('close', (e) => {
        if (!app.isQuitting) { e.preventDefault(); shopeeWindow.hide(); }
    });

    return shopeeWindow;
}

function createLazadaWindow(show = false) {
    if (lazadaWindow && !lazadaWindow.isDestroyed()) {
        if (show) { lazadaWindow.show(); lazadaWindow.focus(); }
        return lazadaWindow;
    }

    const ses = session.fromPartition(lazadaSession);
    ses.setUserAgent(CHROME_UA);

    lazadaWindow = new BrowserWindow({
        width: 1200, height: 800,
        title: 'Lazada Affiliate',
        show: show,
        webPreferences: {
            partition: lazadaSession,
            contextIsolation: false,
            nodeIntegration: false,
        },
    });

    lazadaWindow.loadURL(LAZADA_URL, { userAgent: CHROME_UA });
    lazadaWindow.on('close', (e) => {
        if (!app.isQuitting) { e.preventDefault(); lazadaWindow.hide(); }
    });

    return lazadaWindow;
}

// ==================== SHORTLINK API ====================
async function executeInWindow(win, js, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
        win.webContents.executeJavaScript(js)
            .then(result => { clearTimeout(timer); resolve(result); })
            .catch(err => { clearTimeout(timer); reject(err); });
    });
}

async function shortenShopee(productUrl) {
    const win = createShopeeWindow();
    const currentUrl = win.webContents.getURL();
    if (!currentUrl.includes('affiliate.shopee.co.th')) {
        win.loadURL(SHOPEE_URL);
        await new Promise(r => setTimeout(r, 3000));
    }

    // Get csrf token from session cookies (httpOnly cookies can't be read via document.cookie)
    const ses = session.fromPartition(shopeeSession);
    const cookies = await ses.cookies.get({ domain: '.shopee.co.th', name: 'csrftoken' });
    const csrfToken = cookies.length > 0 ? cookies[0].value : null;
    if (!csrfToken) {
        throw new Error('No csrftoken cookie - not logged in to Shopee Affiliate');
    }

    const safeUrl = productUrl.replace(/'/g, "\\'");
    const js = `(async function(productUrl, csrfToken) {
        var resp = await fetch('https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'affiliate-program-type': '1',
                'csrf-token': csrfToken
            },
            credentials: 'include',
            body: JSON.stringify({
                operationName: 'batchGetCustomLink',
                variables: {
                    linkParams: [{ originalLink: productUrl }],
                    sourceCaller: 'CUSTOM_LINK_CALLER'
                },
                query: 'query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){ batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){ shortLink longLink failCode } }'
            })
        });
        var json = await resp.json();
        var results = json && json.data && json.data.batchCustomLink;
        if (!results || !results.length) throw new Error('No results: ' + JSON.stringify(json).substring(0, 200));
        var r = results[0];
        if (r.failCode && r.failCode !== 0) throw new Error('failCode: ' + r.failCode);
        return { shortLink: r.shortLink || '', longLink: r.longLink || '', originalLink: productUrl };
    })('${safeUrl}', '${csrfToken}')`;

    const result = await executeInWindow(win, js);

    if (!result || !result.shortLink) {
        throw new Error('No shortLink from Shopee: ' + JSON.stringify(result).substring(0, 200));
    }
    return result;
}

async function shortenLazada(productUrl) {
    const win = createLazadaWindow();
    const currentUrl = win.webContents.getURL();
    if (!currentUrl.includes('lazada.co.th')) {
        win.loadURL(LAZADA_URL);
        await new Promise(r => setTimeout(r, 3000));
    }

    const safeUrl = productUrl.replace(/'/g, "\\'");
    const result = await executeInWindow(win, `(${LAZADA_JS})('${safeUrl}')`);

    if (!result) throw new Error('No result from Lazada');

    // Extract from nested structure
    let d = result;
    if (result.data && typeof result.data === 'object') {
        d = result.data.data || result.data;
    }
    if (!d || !d.promotionLink) {
        const ret = (result.ret || []).join(', ');
        throw new Error(ret || 'No promotionLink: ' + JSON.stringify(result).substring(0, 200));
    }
    return d;
}

function extractMemberId(data) {
    try {
        const utLogMap = typeof data.utLogMap === 'string' ? JSON.parse(data.utLogMap) : data.utLogMap;
        if (utLogMap && utLogMap.member_id && utLogMap.member_id !== '-1') return String(utLogMap.member_id);
    } catch {}
    const links = [data.promotionLink, data.clickUrl, data.eurl].filter(Boolean);
    for (const link of links) {
        const m = link.match(/mm_(\d+)_/);
        if (m) return m[1];
    }
    return null;
}

function extractUtmSource(shortLink) {
    try {
        const u = new URL(shortLink);
        return u.searchParams.get('utm_source') || '';
    } catch { return ''; }
}

// ==================== HTTP SERVER ====================
function startApiServer() {
    apiServer = http.createServer(async (req, res) => {
        const parsed = url.parse(req.url, true);
        const pathname = parsed.pathname;
        const query = parsed.query;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        try {
            // Health
            if (pathname === '/health') {
                res.end(JSON.stringify({
                    status: 'ok',
                    shopee: !!(shopeeWindow && !shopeeWindow.isDestroyed()),
                    lazada: !!(lazadaWindow && !lazadaWindow.isDestroyed()),
                }));
                return;
            }

            // Lazada: GET / or GET /shorten
            if ((pathname === '/' || pathname === '/shorten') && query.url && query.url.includes('lazada')) {
                const d = await shortenLazada(query.url);
                res.end(JSON.stringify({
                    originalLink: query.url,
                    shortLink: d.promotionLink,
                    redirectLink: d.promotionLink,
                    longLink: query.url,
                    member_id: extractMemberId(d),
                    promotionCode: d.promotionCode || '',
                    account: query.account || '',
                    sub1: query.sub1 || '',
                }));
                return;
            }

            // Shopee: GET /shopee or GET / with shopee URL
            if (pathname === '/shopee' || pathname === '/shopee/shorten' || ((pathname === '/' || pathname === '/shorten') && query.url && query.url.includes('shopee'))) {
                const d = await shortenShopee(query.url);
                res.end(JSON.stringify({
                    originalLink: query.url,
                    shortLink: d.shortLink,
                    redirectLink: d.shortLink,
                    longLink: d.longLink || '',
                    utm_source: extractUtmSource(d.shortLink),
                    account: query.account || '',
                    sub1: query.sub1 || '',
                }));
                return;
            }

            // Auto-detect: GET /?url=...
            if ((pathname === '/' || pathname === '/shorten') && query.url) {
                if (query.url.includes('shopee')) {
                    const d = await shortenShopee(query.url);
                    res.end(JSON.stringify({ originalLink: query.url, shortLink: d.shortLink, redirectLink: d.shortLink, longLink: d.longLink || '', utm_source: extractUtmSource(d.shortLink), account: query.account || '', sub1: query.sub1 || '' }));
                } else {
                    const d = await shortenLazada(query.url);
                    res.end(JSON.stringify({ originalLink: query.url, shortLink: d.promotionLink, redirectLink: d.promotionLink, longLink: query.url, member_id: extractMemberId(d), promotionCode: d.promotionCode || '', account: query.account || '', sub1: query.sub1 || '' }));
                }
                return;
            }

            // Index
            if (pathname === '/' && !query.url) {
                res.setHeader('Content-Type', 'text/html');
                res.end('<h1>Affiliate Shortlink API</h1><p>GET /?url=SHOPEE_OR_LAZADA_URL&account=X&sub1=Y</p><p>Auto-detects Shopee vs Lazada from URL</p>');
                return;
            }

            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Not found' }));

        } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err.message || String(err) }));
        }
    });

    apiServer.listen(API_PORT, () => {
        console.log(`[API] Shortlink API running on http://localhost:${API_PORT}`);
    });
}

// ==================== TRAY MENU ====================
function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    icon.setTemplateImage(true);

    tray = new Tray(icon);
    tray.setToolTip('Affiliate Shortlink');
    updateTrayMenu();
}

function updateTrayMenu() {
    const shopeeReady = shopeeWindow && !shopeeWindow.isDestroyed();
    const lazadaReady = lazadaWindow && !lazadaWindow.isDestroyed();

    const menu = Menu.buildFromTemplate([
        { label: 'Affiliate Shortlink', enabled: false },
        { type: 'separator' },
        {
            label: `Shopee ${shopeeReady ? '(พร้อม ✅)' : '(ปิดอยู่)'}`,
            click: () => createShopeeWindow(true),
        },
        {
            label: `Lazada ${lazadaReady ? '(พร้อม ✅)' : '(ปิดอยู่)'}`,
            click: () => createLazadaWindow(true),
        },
        { type: 'separator' },
        {
            label: 'เปิดแดชบอร์ด',
            click: () => {
                const { shell } = require('electron');
                shell.openExternal('https://liff.line.me/2009652996-DJtEhoDn');
            },
        },
        {
            label: `API: http://localhost:${API_PORT}`,
            click: () => {
                const { shell } = require('electron');
                shell.openExternal(`http://localhost:${API_PORT}`);
            },
        },
        { type: 'separator' },
        {
            label: 'ออกจากโปรแกรม',
            click: () => {
                app.isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(menu);
}

// ==================== APP LIFECYCLE ====================
app.dock.hide(); // Hide from dock, show only in menu bar

// Auto-start on login
app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe') });

app.on('ready', () => {
    console.log('Affiliate Shortlink starting...');
    createTray();

    // Open both browsers in background
    createShopeeWindow(false);
    createLazadaWindow(false);

    // Start API server
    startApiServer();

    // Update tray status periodically
    setInterval(updateTrayMenu, 10000);

    console.log('Ready! Shopee + Lazada browsers open, API on port ' + API_PORT);
});

app.on('before-quit', () => {
    app.isQuitting = true;
});

app.on('window-all-closed', (e) => {
    // Don't quit when windows close - keep running in menu bar
    e.preventDefault();
});
