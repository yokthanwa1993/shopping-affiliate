const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const STEALTH_PRELOAD = path.join(__dirname, 'stealth-preload.js');

app.userAgentFallback = CHROME_UA;
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('no-sandbox');
app.setAppUserModelId('com.yok.lazada-shortlink');

const DEFAULT_WORKER_URL = 'https://lazada-short.yokthanwa1993-bc9.workers.dev';
const DEFAULT_ACCOUNTS = ['NEEZS', 'CHEARB', 'GOLF', 'FIRST', 'SIAMNEWS'];
const LAZADA_DASHBOARD_URL = 'http://adsense.lazada.co.th/index.htm?hybrid=1#!/';
const LAZADA_LOGIN_URL = 'https://member.lazada.co.th/user/login?lzdmflt=p&redirect=http%3A%2F%2Fadsense.lazada.co.th%2Findex.htm%3Fhybrid%3D1';
const MTOP_API = 'https://acs-m.lazada.co.th/h5/mtop.lazada.affiliate.lania.offer.getpromotionlinkfromjumpurl/1.1/';
const APP_KEY = '24677475';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');
const logFile = path.join(userDataPath, 'agent.log');

let config = {
    workerUrl: '',
    autoAgent: true,
    accounts: [...DEFAULT_ACCOUNTS],
};

try {
    Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
} catch {}

if (
    !Array.isArray(config.accounts) ||
    config.accounts.length === 0 ||
    (config.accounts.length === 1 && config.accounts[0] === 'default')
) {
    config.accounts = [...DEFAULT_ACCOUNTS];
}

const lazadaWindows = new Map();
const loginWindows = new Map();
let tray = null;
let agentRunning = false;

function broadcastToDashboards(channel, payload) {
    for (const win of lazadaWindows.values()) {
        if (win && !win.isDestroyed()) {
            win.webContents.send(channel, payload);
        }
    }
}

function ensureUserDataDir() {
    try {
        fs.mkdirSync(userDataPath, { recursive: true });
    } catch {}
}

function log(msg, cls, account) {
    ensureUserDataDir();
    const prefix = account ? `[${account}] ` : '';
    const line = `${new Date().toISOString()} ${prefix}${msg}`;
    console.log(line);
    try {
        fs.appendFileSync(logFile, line + '\n');
    } catch {}

    broadcastToDashboards('log-entry', {
        msg,
        cls: cls || 'info',
        account: account || '',
    });
}

function getEffectiveWorkerUrl() {
    return String(config.workerUrl || '').trim() || DEFAULT_WORKER_URL;
}

function getPrimaryAccount() {
    return config.accounts[0] || DEFAULT_ACCOUNTS[0];
}

function shouldShowDashboardOnLaunch() {
    return process.argv.includes('--show-dashboard') || process.argv.includes('--show-panel') || process.argv.includes('--show');
}

function buildTrayTooltip() {
    return 'Lazada Shortlink';
}

function getIconPath() {
    const iconCandidates = [
        path.join(process.resourcesPath, 'icon.ico'),
        path.join(process.resourcesPath, 'icon.png'),
        path.join(__dirname, 'icon.ico'),
        path.join(__dirname, 'icon.png'),
        path.join(path.dirname(process.execPath), 'icon.ico'),
        path.join(path.dirname(process.execPath), 'icon.png'),
    ];

    for (const iconPath of iconCandidates) {
        try {
            if (fs.existsSync(iconPath)) {
                return iconPath;
            }
        } catch {}
    }

    return null;
}

function prepareSession(ses) {
    if (!ses || ses.__codexPrepared) {
        return;
    }

    ses.__codexPrepared = true;

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = CHROME_UA;
        details.requestHeaders['Accept-Language'] = 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7';
        delete details.requestHeaders['X-Electron-Version'];
        callback({ requestHeaders: details.requestHeaders });
    });
}

async function createLazadaWindow(account, show = true) {
    if (lazadaWindows.has(account)) {
        const existing = lazadaWindows.get(account);
        if (!existing.isDestroyed()) {
            if (show) {
                existing.show();
                existing.maximize();
                existing.focus();
            }
            return existing;
        }
    }

    const ses = session.fromPartition(`persist:lazada-${account}`);
    prepareSession(ses);

    const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show,
        title: `Lazada Dashboard - ${account}`,
        autoHideMenuBar: false,
        backgroundColor: '#ffffff',
        icon: getIconPath() || undefined,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            session: ses,
        },
    });

    if (show) {
        win.maximize();
    }
    win.webContents.setUserAgent(CHROME_UA, 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7');
    win.webContents.on('did-finish-load', async () => {
        const currentUrl = win.webContents.getURL();
        log(`Dashboard page loaded: ${currentUrl}`, 'ok', account);
        setTimeout(() => {
            win.webContents.executeJavaScript(`
                ({
                    title: document.title || '',
                    textLength: (document.body && document.body.innerText ? document.body.innerText.length : 0),
                    childCount: (document.body ? document.body.children.length : 0),
                    htmlLength: (document.documentElement && document.documentElement.outerHTML ? document.documentElement.outerHTML.length : 0),
                    readyState: document.readyState,
                })
            `).then((info) => {
                if (info) {
                    log(`Dashboard DOM: title=${info.title || '-'} text=${info.textLength} children=${info.childCount} html=${info.htmlLength} state=${info.readyState}`, 'info', account);
                    if (
                        info.htmlLength <= 39 &&
                        !win.isDestroyed() &&
                        !win.__dashboardFallbackTried
                    ) {
                        win.__dashboardFallbackTried = true;
                        log('Dashboard empty document, redirecting to Lazada login', 'warn', account);
                        win.loadURL(LAZADA_LOGIN_URL);
                    }
                }
            }).catch((error) => {
                log(`Dashboard DOM inspect failed: ${error.message}`, 'warn', account);
            });
        }, 2000);
    });
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        log(`Dashboard load failed: ${errorCode} ${errorDescription} ${validatedURL}`, 'err', account);
    });
    win.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            win.hide();
        }
    });
    win.on('closed', () => {
        lazadaWindows.delete(account);
    });

    lazadaWindows.set(account, win);
    win.loadURL(LAZADA_DASHBOARD_URL);
    return win;
}

function getLazadaWindow(account) {
    const win = lazadaWindows.get(account);
    if (win && !win.isDestroyed()) {
        return Promise.resolve(win);
    }
    return createLazadaWindow(account, false);
}

function showDashboard(account = getPrimaryAccount()) {
    return createLazadaWindow(account, true).catch((error) => {
        log(`Open dashboard failed: ${error.message}`, 'err', account);
    });
}

async function getSessionStatus(account = getPrimaryAccount()) {
    const ses = session.fromPartition(`persist:lazada-${account}`);
    prepareSession(ses);
    const cookies = await ses.cookies.get({});
    const hasToken = cookies.some((cookie) => cookie.name === '_m_h5_tk');
    const tokenCookie = cookies.find((cookie) => cookie.name === '_m_h5_tk');

    return {
        account,
        loggedIn: hasToken,
        cookieCount: cookies.length,
        hasToken,
        tokenPreview: tokenCookie && tokenCookie.value ? `${tokenCookie.value.slice(0, 10)}...` : null,
    };
}

async function openLoginWindow(account = getPrimaryAccount()) {
    if (loginWindows.has(account)) {
        const existing = loginWindows.get(account);
        if (existing && !existing.isDestroyed()) {
            existing.show();
            existing.focus();
            return true;
        }
    }

    const ses = session.fromPartition(`persist:lazada-${account}`);
    prepareSession(ses);

    const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show: true,
        title: `Lazada Login - ${account}`,
        autoHideMenuBar: false,
        backgroundColor: '#ffffff',
        icon: getIconPath() || undefined,
        webPreferences: {
            preload: STEALTH_PRELOAD,
            contextIsolation: false,
            nodeIntegration: false,
            sandbox: false,
            session: ses,
        },
    });

    loginWindows.set(account, win);
    win.maximize();
    win.webContents.setUserAgent(CHROME_UA, 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7');
    win.webContents.on('console-message', (_event, level, message) => {
        if (level <= 2 && message) {
            log(`Login console: ${message}`, level === 2 ? 'err' : 'warn', account);
        }
    });
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        log(`Login load failed: ${errorCode} ${errorDescription} ${validatedURL}`, 'err', account);
    });
    win.webContents.on('did-finish-load', async () => {
        const currentUrl = win.webContents.getURL();
        log(`Login page loaded: ${currentUrl}`, 'info', account);
        const status = await getSessionStatus(account);
        broadcastToDashboards('session-status', status);
        setTimeout(() => {
            win.webContents.executeJavaScript(`
                ({
                    title: document.title || '',
                    textLength: (document.body && document.body.innerText ? document.body.innerText.length : 0),
                    childCount: (document.body ? document.body.children.length : 0),
                    readyState: document.readyState,
                })
            `).then((info) => {
                if (info) {
                    log(`Login DOM: title=${info.title || '-'} text=${info.textLength} children=${info.childCount} state=${info.readyState}`, 'info', account);
                }
            }).catch((error) => {
                log(`Login DOM inspect failed: ${error.message}`, 'warn', account);
            });
        }, 1500);
    });
    win.on('closed', () => {
        loginWindows.delete(account);
    });
    win.loadURL(LAZADA_LOGIN_URL);
    return true;
}

function loadTrayImage() {
    const iconCandidates = [getIconPath()].filter(Boolean);

    for (const iconPath of iconCandidates) {
        try {
            if (fs.existsSync(iconPath)) {
                const image = nativeImage.createFromPath(iconPath);
                if (!image.isEmpty()) {
                    log(`Tray icon loaded: ${iconPath}`, 'ok');
                    return image;
                }
            }
        } catch {}
    }

    log('Tray icon fallback to empty image', 'warn');
    return nativeImage.createEmpty();
}

function updateTrayMenu() {
    if (!tray) {
        return;
    }

    const menu = Menu.buildFromTemplate(
        config.accounts.map((account) => ({
            label: account,
            click: () => {
                showDashboard(account);
            },
        })),
    );

    tray.setContextMenu(menu);
    tray.setToolTip(buildTrayTooltip());
}

function createTray() {
    tray = new Tray(loadTrayImage());
    tray.setToolTip(buildTrayTooltip());
    tray.on('double-click', () => {
        showDashboard(getPrimaryAccount());
    });
    updateTrayMenu();
}

function normalizeLazadaLongLink(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (!/(\.|^)lazada\.co\.th$/i.test(parsed.hostname)) {
            return null;
        }
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

function extractLazadaTrackingSource(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return null;
    }

    const findMarker = (value) => {
        if (!value || typeof value !== 'string') {
            return null;
        }
        const decoded = (() => {
            try {
                return decodeURIComponent(value);
            } catch {
                return value;
            }
        })();

        const exact = decoded.match(/(mm_\d+_\d+_\d+!\d+)/i);
        if (exact) {
            return exact[1];
        }

        const fallback = decoded.match(/(mm_\d+_\d+_\d+)/i);
        if (fallback) {
            return fallback[1];
        }

        return null;
    };

    const direct = findMarker(rawUrl);
    if (direct) {
        return direct;
    }

    try {
        const parsed = new URL(rawUrl);
        for (const key of ['exlaz', 'laz_trackid', 'utm_source']) {
            const value = parsed.searchParams.get(key);
            const marker = findMarker(value);
            if (marker) {
                return marker;
            }
        }
    } catch {}

    return null;
}

function extractLazadaMemberId(rawValue) {
    const marker = extractLazadaTrackingSource(rawValue) || (typeof rawValue === 'string' ? rawValue : '');
    if (!marker || typeof marker !== 'string') {
        return null;
    }

    const match = marker.match(/(?:^|[^0-9])mm_(\d+)_/i) || marker.match(/^(\d+)$/);
    return match ? match[1] : null;
}

function extractLazadaRedirectCandidate(html) {
    if (!html || typeof html !== 'string') {
        return null;
    }

    const patterns = [
        /var\s+REDIRECTURL\s*=\s*new\s+URL\('([^']+)'\)/i,
        /window\.location\.href\s*=\s*"([^"]+)"/i,
        /window\.location\.href\s*=\s*'([^']+)'/i,
        /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i,
        /<link[^>]+rel=["']origin["'][^>]+href=["']([^"']+)["']/i,
        /"(https:\/\/www\.lazada\.co\.th\/products\/[^"\\]+)"/i,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    return null;
}

async function resolveLazadaRedirect(rawUrl, depth = 0, visited = new Set()) {
    if (!rawUrl || depth > 4 || visited.has(rawUrl)) {
        return { redirectLink: null, longLink: null, trackingSource: null };
    }

    visited.add(rawUrl);
    const currentTrackingSource = extractLazadaTrackingSource(rawUrl);

    let response;
    try {
        response = await fetch(rawUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: {
                'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
                'User-Agent': CHROME_UA,
            },
        });
    } catch {
        return { redirectLink: null, longLink: normalizeLazadaLongLink(rawUrl), trackingSource: currentTrackingSource };
    }

    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
            return {
                redirectLink: rawUrl,
                longLink: normalizeLazadaLongLink(rawUrl),
                trackingSource: currentTrackingSource,
            };
        }

        const nextUrl = new URL(location, rawUrl).toString();
        const nested = await resolveLazadaRedirect(nextUrl, depth + 1, visited);
        return {
            redirectLink: nested.redirectLink || nextUrl,
            longLink: nested.longLink || normalizeLazadaLongLink(nextUrl),
            trackingSource: nested.trackingSource || extractLazadaTrackingSource(nextUrl) || currentTrackingSource,
        };
    }

    const html = await response.text().catch(() => '');
    const candidate = extractLazadaRedirectCandidate(html);

    if (candidate && candidate !== rawUrl) {
        const nextUrl = new URL(candidate, rawUrl).toString();
        const nested = await resolveLazadaRedirect(nextUrl, depth + 1, visited);
        return {
            redirectLink: nested.redirectLink || nextUrl,
            longLink: nested.longLink || normalizeLazadaLongLink(nextUrl),
            trackingSource: nested.trackingSource || extractLazadaTrackingSource(candidate) || currentTrackingSource,
        };
    }

    return {
        redirectLink: rawUrl,
        longLink: normalizeLazadaLongLink(rawUrl),
        trackingSource: currentTrackingSource,
    };
}

async function handleShorten(payload) {
    const { productUrl, account, sub1 } = payload || {};
    if (!productUrl) {
        throw new Error('ใส่ลิงก์สินค้าก่อน');
    }

    const accountName = account || getPrimaryAccount();
    const ses = session.fromPartition(`persist:lazada-${accountName}`);
    prepareSession(ses);

    const cookies = await ses.cookies.get({ name: '_m_h5_tk' });
    if (!cookies.length) {
        throw new Error(`[${accountName}] ไม่พบ cookie _m_h5_tk - กรุณาเปิด Dashboard แล้ว login Lazada ก่อน`);
    }

    const token = cookies[0].value.split('_')[0];
    const timestamp = Date.now().toString();
    const dataObj = { jumpUrl: productUrl };
    if (sub1) {
        dataObj.subId = sub1;
    }
    const data = JSON.stringify(dataObj);
    const sign = crypto.createHash('md5').update(token + '&' + timestamp + '&' + APP_KEY + '&' + data).digest('hex');

    const params = new URLSearchParams({
        jsv: '2.6.1',
        appKey: APP_KEY,
        t: timestamp,
        sign,
        api: 'mtop.lazada.affiliate.lania.offer.getPromotionLinkFromJumpUrl',
        v: '1.1',
        type: 'originaljson',
        isSec: '1',
        AntiCreep: 'true',
        timeout: '5000',
        needLogin: 'true',
        dataType: 'json',
        sessionOption: 'AutoLoginOnly',
        'x-i18n-language': 'en',
        'x-i18n-regionID': 'TH',
        data,
    });

    const apiUrl = MTOP_API + '?' + params.toString();
    function visit(node, callback, seen) {
        if (!node || typeof node !== 'object') return null;
        if (!seen) seen = new WeakSet();
        if (seen.has(node)) return null;
        seen.add(node);

        if (Array.isArray(node)) {
            for (const item of node) {
                const hit = visit(item, callback, seen);
                if (hit != null) return hit;
            }
            return null;
        }

        for (const [key, value] of Object.entries(node)) {
            const hit = callback(key, value);
            if (hit != null) return hit;

            if (typeof value === 'string') {
                const trimmed = value.trim();
                if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        const nestedHit = visit(parsed, callback, seen);
                        if (nestedHit != null) return nestedHit;
                    } catch {}
                }
            } else if (value && typeof value === 'object') {
                const childHit = visit(value, callback, seen);
                if (childHit != null) return childHit;
            }
        }

        return null;
    }

    function findStringValue(node, keys) {
        const wanted = new Set(keys.map((key) => String(key).toLowerCase()));
        return visit(node, (key, value) => {
            if (wanted.has(String(key).toLowerCase()) && typeof value === 'string' && value.trim()) {
                return value.trim();
            }
            return null;
        });
    }

    function findUrlValue(node) {
        return visit(node, (_key, value) => {
            if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
                return value.trim();
            }
            return null;
        });
    }

    const allCookies = await ses.cookies.get({});
    const cookieHeader = allCookies
        .filter((cookie) => cookie.domain.includes('lazada.co.th'))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');

    const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cookie': cookieHeader,
            'Origin': 'https://affiliate.lazada.co.th',
            'Referer': 'https://affiliate.lazada.co.th/',
            'User-Agent': CHROME_UA,
        },
    });

    if (!response.ok) {
        throw new Error(`Lazada API ${response.status}`);
    }

    const rawText = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        log(`Lazada raw response: ${rawText.slice(0, 1500)}`, 'warn', accountName);
        throw new Error(error.message);
    }

    const result = {
        ok: false,
        shortLink:
            findStringValue(parsed, ['promotionLink', 'shortLink', 'promotionUrl', 'promotionURL', 'short_url']) ||
            findUrlValue(parsed),
        promotionCode:
            findStringValue(parsed, ['promotionCode', 'promotion_code', 'code']) ||
            '',
        error: (parsed.ret && parsed.ret.length) ? parsed.ret.join(', ') : 'ไม่ได้ผลลัพธ์',
        debug: rawText.slice(0, 1500),
    };

    if (result.shortLink) {
        result.ok = true;
    }
    if (!result || !result.ok) {
        if (result && result.debug) {
            log(`Lazada raw response: ${result.debug}`, 'warn', accountName);
        }
        throw new Error(result && result.error ? result.error : 'ย่อลิงก์ไม่สำเร็จ');
    }

    log(`Shorten success: ${result.shortLink}`, 'ok', accountName);
    const resolvedOutput = await resolveLazadaRedirect(result.shortLink);
    const resolvedInput = (!resolvedOutput.redirectLink && /^https:\/\/s\.lazada\.co\.th\//i.test(productUrl))
        ? await resolveLazadaRedirect(productUrl)
        : { redirectLink: null, longLink: null };

    const redirectLink = resolvedOutput.redirectLink || resolvedInput.redirectLink || null;
    const longLink =
        resolvedOutput.longLink ||
        resolvedInput.longLink ||
        normalizeLazadaLongLink(productUrl) ||
        null;
    const utmSource =
        resolvedOutput.trackingSource ||
        resolvedInput.trackingSource ||
        extractLazadaTrackingSource(redirectLink) ||
        extractLazadaTrackingSource(productUrl) ||
        extractLazadaTrackingSource(result.shortLink) ||
        null;
    const memberId =
        extractLazadaMemberId(utmSource) ||
        extractLazadaMemberId(redirectLink) ||
        extractLazadaMemberId(productUrl) ||
        extractLazadaMemberId(result.shortLink) ||
        null;

    return {
        shortLink: result.shortLink,
        promotionCode: result.promotionCode || null,
        longLink,
        redirectLink,
        utmSource,
        memberId,
    };
}

async function startAgent() {
    if (agentRunning) {
        return;
    }

    agentRunning = true;
    log('Agent started', 'ok');
    broadcastToDashboards('agent-status', true);
    updateTrayMenu();

    while (agentRunning) {
        try {
            const resp = await fetch(`${getEffectiveWorkerUrl()}/api/poll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timeoutMs: 25000 }),
            });

            if (!agentRunning) {
                break;
            }
            if (resp.status === 204) {
                continue;
            }
            if (!resp.ok) {
                log(`Poll failed: HTTP ${resp.status}`, 'err');
                await sleep(2000);
                continue;
            }

            const job = await resp.json();
            if (!job || !job.jobId || !job.payload) {
                continue;
            }

            const accountName = job.payload.account || getPrimaryAccount();
            log(`Job ${job.jobId.slice(0, 8)} received`, 'info', accountName);

            let result;
            try {
                const shortenResult = await handleShorten(job.payload);
                result = {
                    jobId: job.jobId,
                    ok: true,
                    shortLink: shortenResult.shortLink,
                    longLink: shortenResult.longLink,
                    redirectLink: shortenResult.redirectLink,
                    utmSource: shortenResult.utmSource,
                    memberId: shortenResult.memberId,
                    promotionCode: shortenResult.promotionCode,
                };
            } catch (error) {
                result = {
                    jobId: job.jobId,
                    ok: false,
                    error: error.message,
                };
            }

            await fetch(`${getEffectiveWorkerUrl()}/api/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result),
            });

            log(result.ok ? `Done: ${result.shortLink}` : `Done with error: ${result.error}`, result.ok ? 'ok' : 'err', accountName);
        } catch (error) {
            log(`Poll error: ${error.message}`, 'err');
            await sleep(3000);
        }
    }

    agentRunning = false;
    log('Agent stopped', 'warn');
    broadcastToDashboards('agent-status', false);
    updateTrayMenu();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveConfig(nextConfig) {
    config = { ...config, ...nextConfig };
    if (!Array.isArray(config.accounts) || config.accounts.length === 0) {
        config.accounts = [...DEFAULT_ACCOUNTS];
    }
    ensureUserDataDir();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

ipcMain.handle('shorten', async (_event, payload) => handleShorten(payload));
ipcMain.handle('get-config', () => ({ ...config, workerUrl: getEffectiveWorkerUrl() }));
ipcMain.handle('save-config', (_event, nextConfig) => {
    saveConfig(nextConfig);
    updateTrayMenu();
    return { ...config, workerUrl: getEffectiveWorkerUrl() };
});
ipcMain.handle('start-agent', async () => {
    if (!agentRunning) {
        startAgent();
    }
    return true;
});
ipcMain.handle('stop-agent', async () => {
    agentRunning = false;
    broadcastToDashboards('agent-status', false);
    updateTrayMenu();
    return true;
});
ipcMain.handle('get-agent-status', () => agentRunning);
ipcMain.handle('get-session-status', (_event, account) => getSessionStatus(account || getPrimaryAccount()));
ipcMain.handle('open-login', (_event, account) => openLoginWindow(account || getPrimaryAccount()));

app.on('second-instance', () => {
    showDashboard();
});

app.whenReady().then(() => {
    log(`App ready, argv=${process.argv.join(' ')}`, 'info');
    createTray();

    if (config.autoAgent) {
        startAgent();
    }

    if (shouldShowDashboardOnLaunch()) {
        showDashboard();
    }
}).catch((error) => {
    log(`Startup fatal: ${error.message}`, 'err');
});

app.on('before-quit', () => {
    app.isQuitting = true;
    agentRunning = false;
});

app.on('window-all-closed', () => {});
