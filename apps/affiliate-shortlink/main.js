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

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function extractOriginalLinkFromHtml(html) {
    const source = String(html || '');
    if (!source) return '';

    const patterns = [
        /<link[^>]+rel=["']origin["'][^>]+href=["']([^"']+)["']/i,
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
        /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i,
    ];

    for (const pattern of patterns) {
        const match = source.match(pattern);
        const value = decodeHtmlEntities(match && match[1] ? match[1] : '').trim();
        if (value) return value;
    }

    return '';
}

async function resolveOriginalLink(inputUrl) {
    const raw = String(inputUrl || '').trim();
    if (!raw) return '';

    try {
        const resp = await fetch(raw, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': CHROME_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });

        const finalUrl = String(resp.url || '').trim();
        const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html')) {
            const html = await resp.text();
            const extracted = extractOriginalLinkFromHtml(html);
            if (extracted) return extracted;
        }

        return finalUrl || raw;
    } catch {
        return raw;
    }
}

async function resolveRedirectUrl(inputUrl) {
    const raw = String(inputUrl || '').trim();
    if (!raw) return '';

    try {
        const resp = await fetch(raw, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': CHROME_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });
        return String(resp.url || '').trim() || raw;
    } catch {
        return raw;
    }
}

async function resolveTrackingLink(inputUrl) {
    const current = String(inputUrl || '').trim();
    if (!current) return '';

    const extracted = await resolveOriginalLink(current);
    const candidate = extracted || current;
    const redirected = await resolveRedirectUrl(candidate);
    return redirected || candidate || current;
}

function normalizeShopeeOriginalLink(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        const match = parsed.pathname.match(/\/(?:universal-link\/)?product\/(\d+)\/(\d+)/i)
            || parsed.pathname.match(/\/opaanlp\/(\d+)\/(\d+)/i)
            || parsed.pathname.match(/-i[./](\d+)[./](\d+)/i);
        if (match) {
            return `https://shopee.co.th/product/${match[1]}/${match[2]}`;
        }
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return raw;
    }
}

function normalizeLazadaOriginalLink(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return raw;
    }
}

function normalizeAffiliateId(value) {
    const raw = String(value || '').trim().replace(/^an_/i, '');
    const match = raw.match(/(\d{6,})/);
    return match ? match[1] : '';
}

function buildShopeeShortlinkPayload(params) {
    const link = String(params.link || '').trim();
    const longLink = String(params.longLink || '').trim() || link;
    const originalLink = normalizeShopeeOriginalLink(longLink) || longLink || link;
    const id = normalizeAffiliateId(params.id || params.utmSource || '');

    // Extract sub_ids from utm_content in longLink (format: sub1-sub2-sub3-sub4-sub5)
    let utmContent = '';
    try {
        const url = new URL(longLink.includes('://') ? longLink : `https://${longLink}`);
        utmContent = url.searchParams.get('utm_content') || '';
    } catch {}
    const subParts = utmContent.split('-');
    const sub1 = String(subParts[0] || '').trim() || '';
    const sub2 = String(subParts[1] || '').trim() || '';
    const sub3 = String(subParts[2] || '').trim() || '';
    const sub4 = String(subParts[3] || '').trim() || '';
    const sub5 = String(subParts[4] || '').trim() || '';

    return {
        link,
        longLink,
        originalLink,
        shortLink: String(params.shortLink || '').trim(),
        id,
        utm_source: String(params.utmSource || '').trim(),
        utm_content: utmContent,
        account: String(params.account || '').trim(),
        sub1,
        sub2,
        sub3,
        sub4,
        sub5,
    };
}

function buildLazadaShortlinkPayload(params) {
    const link = String(params.link || '').trim();
    const longLink = String(params.longLink || '').trim() || link;
    const originalLink = normalizeLazadaOriginalLink(longLink) || longLink || link;
    const id = normalizeAffiliateId(params.id || params.memberId || '');
    return {
        link,
        longLink,
        originalLink,
        shortLink: String(params.shortLink || '').trim(),
        id,
        member_id: params.memberId ?? null,
        promotionCode: String(params.promotionCode || '').trim(),
        account: String(params.account || '').trim(),
        sub1: String(params.sub1 || '').trim(),
    };
}

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

async function shortenShopee(productUrl, subIds) {
    const sub1 = String((subIds && subIds[0]) || '').trim()
    const sub2 = String((subIds && subIds[1]) || '').trim()
    const sub3 = String((subIds && subIds[2]) || '').trim()
    const sub4 = String((subIds && subIds[3]) || '').trim()
    const sub5 = String((subIds && subIds[4]) || '').trim()
    const win = createShopeeWindow();
    const currentUrl = win.webContents.getURL();
    if (!currentUrl.includes('affiliate.shopee.co.th')) {
        win.loadURL(SHOPEE_URL);
        await new Promise(r => setTimeout(r, 3000));
    }

    const safeUrl = productUrl.replace(/'/g, "\\'");
    const safeSub1 = String(sub1 || '').replace(/'/g, "\\'");
    const safeSub2 = String(sub2 || '').replace(/'/g, "\\'");
    const safeSub3 = String(sub3 || '').replace(/'/g, "\\'");
    const safeSub4 = String(sub4 || '').replace(/'/g, "\\'");
    const safeSub5 = String(sub5 || '').replace(/'/g, "\\'");
    const js = `(async function(productUrl, sub1, sub2, sub3, sub4, sub5) {
        var csrfToken = null;
        var m = document.cookie.match(/csrftoken=([^;]+)/);
        if (m) csrfToken = m[1];
        if (!csrfToken) {
            var meta = document.querySelector('meta[name="csrf-token"]') || document.querySelector('meta[name="csrftoken"]');
            if (meta) csrfToken = meta.getAttribute('content');
        }

        var headers = {
            'Content-Type': 'application/json',
            'affiliate-program-type': '1'
        };
        if (csrfToken) headers['csrf-token'] = csrfToken;

        var linkParam = { originalLink: productUrl };
        if (sub1 || sub2 || sub3 || sub4 || sub5) {
            linkParam.advancedLinkParams = { subId1: sub1 || '', subId2: sub2 || '', subId3: sub3 || '', subId4: sub4 || '', subId5: sub5 || '' };
        }

        var resp = await fetch('https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink', {
            method: 'POST',
            headers: headers,
            credentials: 'include',
            body: JSON.stringify({
                operationName: 'batchGetCustomLink',
                variables: {
                    linkParams: [linkParam],
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
    })('${safeUrl}', '${safeSub1}', '${safeSub2}', '${safeSub3}', '${safeSub4}', '${safeSub5}')`;

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

function extractMemberIdFromUrl(value) {
    const raw = decodeURIComponent(String(value || '').trim());
    if (!raw) return null;
    const match = raw.match(/mm_(\d+)_/);
    return match ? match[1] : null;
}

function extractUtmSource(value) {
    try {
        const u = new URL(value);
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

            // Debug cookies
            if (pathname === '/debug') {
                const ses = session.fromPartition(shopeeSession);
                const allCookies = await ses.cookies.get({});
                const shopeeUrl = shopeeWindow && !shopeeWindow.isDestroyed() ? shopeeWindow.webContents.getURL() : 'N/A';
                let docCookie = '';
                try { docCookie = await shopeeWindow.webContents.executeJavaScript('document.cookie'); } catch(e) { docCookie = e.message; }
                res.end(JSON.stringify({
                    shopeeUrl,
                    totalCookies: allCookies.length,
                    cookieNames: allCookies.map(c => ({ name: c.name, domain: c.domain })),
                    documentCookie: docCookie,
                }, null, 2));
                return;
            }

            // Lazada: GET / or GET /shorten
            if ((pathname === '/' || pathname === '/shorten') && query.url && query.url.includes('lazada')) {
                const resolvedOriginalLink = await resolveOriginalLink(query.url);
                const d = await shortenLazada(query.url);
                const resolvedShortLink = await resolveTrackingLink(d.promotionLink);
                res.end(JSON.stringify(buildLazadaShortlinkPayload({
                    link: query.url,
                    longLink: resolvedOriginalLink,
                    shortLink: d.promotionLink,
                    memberId: extractMemberIdFromUrl(resolvedShortLink) || extractMemberId(d),
                    promotionCode: d.promotionCode || '',
                    account: query.account || '',
                    sub1: query.sub1 || '',
                })));
                return;
            }

            // Shopee: GET /shopee or GET / with shopee URL
            if (pathname === '/shopee' || pathname === '/shopee/shorten' || ((pathname === '/' || pathname === '/shorten') && query.url && query.url.includes('shopee'))) {
                const d = await shortenShopee(query.url, [query.sub1, query.sub2, query.sub3, query.sub4, query.sub5]);
                const resolvedShortLink = await resolveTrackingLink(d.shortLink);
                res.end(JSON.stringify(buildShopeeShortlinkPayload({
                    link: query.url,
                    longLink: d.longLink || '',
                    shortLink: d.shortLink,
                    utmSource: extractUtmSource(resolvedShortLink),
                    account: query.account || '',
                    sub1: query.sub1 || '',
                })));
                return;
            }

            // Auto-detect: GET /?url=...
            if ((pathname === '/' || pathname === '/shorten') && query.url) {
                const resolvedOriginalLink = await resolveOriginalLink(query.url);
                if (query.url.includes('shopee')) {
                    const d = await shortenShopee(query.url, [query.sub1, query.sub2, query.sub3, query.sub4, query.sub5]);
                    const resolvedShortLink = await resolveTrackingLink(d.shortLink);
                    res.end(JSON.stringify(buildShopeeShortlinkPayload({
                        link: query.url,
                        longLink: d.longLink || resolvedOriginalLink || '',
                        shortLink: d.shortLink,
                        utmSource: extractUtmSource(resolvedShortLink),
                        account: query.account || '',
                        sub1: query.sub1 || '',
                    })));
                } else {
                    const d = await shortenLazada(query.url);
                    const resolvedShortLink = await resolveTrackingLink(d.promotionLink);
                    res.end(JSON.stringify(buildLazadaShortlinkPayload({
                        link: query.url,
                        longLink: resolvedOriginalLink,
                        shortLink: d.promotionLink,
                        memberId: extractMemberIdFromUrl(resolvedShortLink) || extractMemberId(d),
                        promotionCode: d.promotionCode || '',
                        account: query.account || '',
                        sub1: query.sub1 || '',
                    })));
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
