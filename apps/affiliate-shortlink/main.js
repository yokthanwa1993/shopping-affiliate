const { app, BrowserWindow, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const url = require('url');
const { execFileSync } = require('child_process');

function ensureMacBackgroundOnly() {
    if (process.platform !== 'darwin') return;
    try { app.setActivationPolicy('accessory'); } catch { }
    try { app.dock?.hide(); } catch { }
    try {
        const plistPath = path.resolve(path.dirname(process.execPath), '..', 'Info.plist');
        if (!fs.existsSync(plistPath)) return;
        try {
            execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :LSUIElement true', plistPath], { stdio: 'ignore' });
        } catch {
            execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', plistPath], { stdio: 'ignore' });
        }
    } catch { }
}

ensureMacBackgroundOnly();

// Single instance — prevent duplicate
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

// ==================== CONFIG ====================
const SHOPEE_URL = 'https://affiliate.shopee.co.th/offer/custom_link';
const LAZADA_URL = 'https://www.lazada.co.th';
const API_PORT = 8800;
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const HEALTHCHECK_INTERVAL_MS = 30 * 1000;
const HEALTHCHECK_TIMEOUT_MS = 3000;

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
        skipTaskbar: true,
        webPreferences: {
            partition: shopeeSession,
            contextIsolation: false,
            nodeIntegration: false,
        },
    });

    shopeeWindow.loadURL(SHOPEE_URL, { userAgent: CHROME_UA });
    shopeeWindow.once('ready-to-show', () => {
        if (process.platform === 'darwin') {
            try { app.dock.hide(); } catch { }
        }
    });
    shopeeWindow.on('close', (e) => {
        if (!app.isQuitting) { e.preventDefault(); shopeeWindow.hide(); }
    });
    shopeeWindow.on('show', () => {
        if (process.platform === 'darwin') {
            try { app.dock.hide(); } catch { }
        }
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
        skipTaskbar: true,
        webPreferences: {
            partition: lazadaSession,
            contextIsolation: false,
            nodeIntegration: false,
        },
    });

    lazadaWindow.loadURL(LAZADA_URL, { userAgent: CHROME_UA });
    lazadaWindow.once('ready-to-show', () => {
        if (process.platform === 'darwin') {
            try { app.dock.hide(); } catch { }
        }
    });
    lazadaWindow.on('close', (e) => {
        if (!app.isQuitting) { e.preventDefault(); lazadaWindow.hide(); }
    });
    lazadaWindow.on('show', () => {
        if (process.platform === 'darwin') {
            try { app.dock.hide(); } catch { }
        }
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

// ==================== SESSION RESILIENCE ====================
// Track active requests so periodic refresh skips busy windows.
const activeRequests = { shopee: 0, lazada: 0 };
// Serialise reloads so concurrent session failures don't thrash the window.
const reloadLocks = { shopee: null, lazada: null };

// Last-resort app restart when in-wrapper reloads can't recover.
// pm2 autorestart brings the process back up on exit(0).
const consecutiveFailures = { shopee: 0, lazada: 0 };
const FAILURES_BEFORE_RESTART = 3;                // 3 full-wrapper failures in a row → relaunch
const MIN_RESTART_INTERVAL_MS = 10 * 60 * 1000;   // rate-limit: at most 1 restart per 10 min
let lastAppRestartAt = 0;
let restartScheduled = false;

function triggerAppRestartIfStuck(platform) {
    if (restartScheduled) return;
    const now = Date.now();
    if (now - lastAppRestartAt < MIN_RESTART_INTERVAL_MS) {
        const leftSec = Math.ceil((MIN_RESTART_INTERVAL_MS - (now - lastAppRestartAt)) / 1000);
        console.warn(`[restart] skip — cooldown ${leftSec}s left since last restart`);
        return;
    }
    restartScheduled = true;
    lastAppRestartAt = now;
    const failureCount = consecutiveFailures[platform] || 0;
    console.error(`[restart] ${platform} hit ${failureCount} consecutive failures — exiting app (pm2 will restart)`);
    // Short delay so the current failing response flushes back to caller before we exit.
    setTimeout(() => {
        try { app.exit(1); } catch (e) { console.warn('[restart] app.exit failed:', e && e.message); process.exit(1); }
    }, 1500);
}

function isSessionLikelyExpired(err) {
    const msg = String((err && err.message) || err || '').toUpperCase();
    // Session/auth errors (cookie expired, login required) — reload window to restore login state.
    if (/SESSION|TOKEN_EMPTY|TOKEN_EXPIRED|ILLEGAL_ACCESS|UNAUTHORIZED|LOGIN|CSRF|FAIL_SYS|401|403/.test(msg)) return true;
    // Transient browser/network errors from webContents.executeJavaScript's inner fetch —
    // reloading the window gives the renderer a fresh network context and usually succeeds on retry.
    if (/FAILED TO FETCH|NETWORKERROR|NETWORK ERROR|ERR_NETWORK|ERR_INTERNET|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|LOAD FAILED|ABORTED/.test(msg)) return true;
    return false;
}

async function reloadAndWait(win, loadUrl) {
    if (!win || win.isDestroyed()) return;
    await new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            try { win.webContents.removeListener('did-finish-load', done); } catch {}
            resolve();
        };
        try { win.webContents.once('did-finish-load', done); } catch {}
        try {
            win.webContents.reloadIgnoringCache();
        } catch {
            try { win.loadURL(loadUrl); } catch {}
        }
        // Safety net: resolve after 10s even if did-finish-load never fires
        setTimeout(done, 10000);
    });
    // Let client JS settle (cookies, tokens)
    await new Promise(r => setTimeout(r, 1500));
}

async function reloadWindowSerialized(platform, win, loadUrl) {
    if (reloadLocks[platform]) return reloadLocks[platform];
    const p = reloadAndWait(win, loadUrl);
    reloadLocks[platform] = p;
    try { await p; } finally { reloadLocks[platform] = null; }
    return p;
}

async function shortenShopeeOnce(productUrl, subIds) {
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
        if (resp.status === 401 || resp.status === 403) {
            throw new Error('HTTP ' + resp.status + ' UNAUTHORIZED (likely SESSION_EXPIRED)');
        }
        var text = await resp.text();
        var json;
        try { json = JSON.parse(text); }
        catch (e) {
            // HTML login page instead of JSON means the session is gone
            var snippet = text.substring(0, 200);
            if (/login|sign[- ]?in|csrf/i.test(snippet)) throw new Error('SESSION_EXPIRED (login page returned)');
            throw new Error('Invalid JSON: ' + snippet);
        }
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

async function shortenLazadaOnce(productUrl) {
    const win = createLazadaWindow();
    const currentUrl = win.webContents.getURL();
    if (!currentUrl.includes('lazada.co.th')) {
        win.loadURL(LAZADA_URL);
        await new Promise(r => setTimeout(r, 3000));
    }

    const safeUrl = productUrl.replace(/'/g, "\\'");
    const result = await executeInWindow(win, `(${LAZADA_JS})('${safeUrl}')`);

    if (!result) throw new Error('No result from Lazada');

    // Surface explicit session errors before the "No promotionLink" fallback
    const retText = Array.isArray(result.ret) ? result.ret.join(', ') : '';
    if (retText && /SESSION|TOKEN_EMPTY|TOKEN_EXPIRED|ILLEGAL_ACCESS|FAIL_SYS/i.test(retText)) {
        throw new Error(retText);
    }

    // Extract from nested structure
    let d = result;
    if (result.data && typeof result.data === 'object') {
        d = result.data.data || result.data;
    }
    if (!d || !d.promotionLink) {
        throw new Error(retText || 'No promotionLink: ' + JSON.stringify(result).substring(0, 200));
    }
    return d;
}

// Public wrappers with multi-attempt reactive reload on session/network errors.
// Up to 3 attempts per request; between attempts we reload the browser window
// and wait briefly so the renderer has a fresh network/cookie context.
const MAX_SHORTEN_ATTEMPTS = 3;
const BETWEEN_ATTEMPT_DELAY_MS = [0, 1500, 3500];

async function shortenShopee(productUrl, subIds) {
    activeRequests.shopee++;
    let lastErr = null;
    try {
        for (let attempt = 1; attempt <= MAX_SHORTEN_ATTEMPTS; attempt++) {
            try {
                const result = await shortenShopeeOnce(productUrl, subIds);
                consecutiveFailures.shopee = 0;
                return result;
            } catch (err) {
                lastErr = err;
                const recoverable = isSessionLikelyExpired(err);
                console.warn(`[Shopee] attempt ${attempt}/${MAX_SHORTEN_ATTEMPTS} failed (${recoverable ? 'recoverable' : 'non-recoverable'}): ${err.message}`);
                if (!recoverable || attempt === MAX_SHORTEN_ATTEMPTS) break;
                await new Promise(r => setTimeout(r, BETWEEN_ATTEMPT_DELAY_MS[attempt] || 3500));
                await reloadWindowSerialized('shopee', createShopeeWindow(), SHOPEE_URL);
            }
        }
        consecutiveFailures.shopee++;
        if (consecutiveFailures.shopee >= FAILURES_BEFORE_RESTART) {
            triggerAppRestartIfStuck('shopee');
        }
        throw lastErr;
    } finally {
        activeRequests.shopee = Math.max(0, activeRequests.shopee - 1);
    }
}

async function shortenLazada(productUrl) {
    activeRequests.lazada++;
    let lastErr = null;
    try {
        for (let attempt = 1; attempt <= MAX_SHORTEN_ATTEMPTS; attempt++) {
            try {
                const result = await shortenLazadaOnce(productUrl);
                consecutiveFailures.lazada = 0;
                return result;
            } catch (err) {
                lastErr = err;
                const recoverable = isSessionLikelyExpired(err);
                console.warn(`[Lazada] attempt ${attempt}/${MAX_SHORTEN_ATTEMPTS} failed (${recoverable ? 'recoverable' : 'non-recoverable'}): ${err.message}`);
                if (!recoverable || attempt === MAX_SHORTEN_ATTEMPTS) break;
                await new Promise(r => setTimeout(r, BETWEEN_ATTEMPT_DELAY_MS[attempt] || 3500));
                await reloadWindowSerialized('lazada', createLazadaWindow(), LAZADA_URL);
            }
        }
        consecutiveFailures.lazada++;
        if (consecutiveFailures.lazada >= FAILURES_BEFORE_RESTART) {
            triggerAppRestartIfStuck('lazada');
        }
        throw lastErr;
    } finally {
        activeRequests.lazada = Math.max(0, activeRequests.lazada - 1);
    }
}

// Periodic refresh — keep cookies warm so CRON shortlinks never hit a cold session.
// Lowered from 20m to 10m because 20m was occasionally long enough for the renderer
// to enter a bad network state (manifests as "Failed to fetch" in the inner fetch()).
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
function schedulePeriodicRefresh(platform, getWin, loadUrl, offsetMs = 0) {
    setTimeout(() => {
        setInterval(async () => {
            const win = getWin();
            if (!win || win.isDestroyed()) return;
            if (activeRequests[platform] > 0) {
                console.log(`[${platform}] periodic refresh skipped (active=${activeRequests[platform]})`);
                return;
            }
            if (reloadLocks[platform]) {
                console.log(`[${platform}] periodic refresh skipped (reload already in progress)`);
                return;
            }
            console.log(`[${platform}] periodic refresh (every ${REFRESH_INTERVAL_MS / 60000}m)`);
            try {
                await reloadWindowSerialized(platform, win, loadUrl);
            } catch (e) {
                console.warn(`[${platform}] periodic refresh failed:`, e.message || e);
            }
        }, REFRESH_INTERVAL_MS);
    }, offsetMs);
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

    apiServer.on('error', (err) => {
        console.error('[API] server error:', err && err.message ? err.message : err);
        triggerAppRestartIfStuck('api');
    });
    apiServer.on('close', () => {
        if (app.isQuitting) return;
        console.error('[API] server closed unexpectedly');
        triggerAppRestartIfStuck('api');
    });

    apiServer.listen(API_PORT, () => {
        console.log(`[API] Shortlink API running on http://localhost:${API_PORT}`);
    });
}

function startApiHealthWatchdog() {
    setInterval(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
        try {
            const resp = await fetch(`http://127.0.0.1:${API_PORT}/health`, {
                method: 'GET',
                signal: controller.signal,
            });
            if (!resp.ok) throw new Error(`health_http_${resp.status}`);
            const data = await resp.json().catch(() => null);
            if (!data || data.status !== 'ok') throw new Error('health_bad_payload');
        } catch (err) {
            console.error('[watchdog] API health failed:', err && err.message ? err.message : err);
            triggerAppRestartIfStuck('api');
        } finally {
            clearTimeout(timer);
        }
    }, HEALTHCHECK_INTERVAL_MS);
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

// macOS autostart is owned by LaunchAgent. Electron's Login Item can start a
// second unsupervised instance and race the managed one, so keep it disabled.
if (process.platform === 'darwin') {
    try { app.setLoginItemSettings({ openAtLogin: false, path: app.getPath('exe') }); } catch { }
}

app.on('ready', () => {
    console.log('Affiliate Shortlink starting...');
    if (process.platform === 'darwin') {
        try { app.dock.hide(); } catch { }
    }
    createTray();

    // Open both browsers in background
    createShopeeWindow(false);
    createLazadaWindow(false);

    // Start API server
    startApiServer();
    startApiHealthWatchdog();

    // Update tray status periodically
    setInterval(updateTrayMenu, 10000);

    // Periodic refresh keeps session cookies warm for CRON shortlinks.
    // Offset Lazada by 10 min so both windows never reload simultaneously.
    schedulePeriodicRefresh('shopee', () => shopeeWindow, SHOPEE_URL, 0);
    schedulePeriodicRefresh('lazada', () => lazadaWindow, LAZADA_URL, REFRESH_INTERVAL_MS / 2);

    console.log('Ready! Shopee + Lazada browsers open, API on port ' + API_PORT);
});

app.on('browser-window-created', () => {
    if (process.platform === 'darwin') {
        try { app.dock.hide(); } catch { }
    }
});

app.on('activate', () => {
    if (process.platform === 'darwin') {
        try { app.dock.hide(); } catch { }
    }
});

app.on('before-quit', () => {
    app.isQuitting = true;
});

app.on('window-all-closed', (e) => {
    // Don't quit when windows close - keep running in menu bar
    e.preventDefault();
});
