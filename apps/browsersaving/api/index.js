// BrowserSaving API - Postcron Token Extraction
import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocketServer } from 'ws';
import { gunzipSync } from 'zlib';
import puppeteer from 'puppeteer-core';

// Stealth args to avoid detection
const STEALTH_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
    '--disable-web-security',
    '--disable-features=BlockInsecurePrivateNetworkRequests',
    '--disable-features=InterestCohortFeature',
    '--disable-features=FledgeInterestGroups',
    '--disable-features=FledgeInterestGroupAPI',
    '--disable-features=PrivacySandboxAdsAPIs',
];

const PORT = process.env.PORT || 3000;
const BROWSERLESS_WS = process.env.BROWSERLESS_WS || 'ws://srv-captain--browserless:3000';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '77482ddfd0ec44d1c1a8b55ddf352d98';
const BROWSERLESS_PUBLIC_URL = process.env.BROWSERLESS_PUBLIC_URL || 'https://browserless.lslly.com';
const WORKER_URL = process.env.WORKER_URL || 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev';
const COMMENT_TOKEN_API_URL = process.env.COMMENT_TOKEN_API_URL || 'https://comment-token-api.lslly.com/api/comment-token';
const BROWSERLESS_RELAY_HOST = process.env.BROWSERLESS_RELAY_HOST || 'srv-captain--browsersaving-api';
const BROWSERLESS_RELAY_PORT = Number(process.env.BROWSERLESS_RELAY_PORT || PORT);
const BROWSERLESS_RELAY_TTL_MS = Math.max(30_000, Number(process.env.BROWSERLESS_RELAY_TTL_MS || 5 * 60 * 1000));
const BROWSERLESS_IP_CHECK_URL = process.env.BROWSERLESS_IP_CHECK_URL || 'https://api.ipify.org?format=json';
const BROWSER_VIEW_DEFAULT_URL = process.env.BROWSER_VIEW_DEFAULT_URL || 'https://facebook.com/';
const BROWSER_VIEW_WIDTH = Math.max(640, Number(process.env.BROWSER_VIEW_WIDTH || 1280));
const BROWSER_VIEW_HEIGHT = Math.max(480, Number(process.env.BROWSER_VIEW_HEIGHT || 800));
const BROWSER_VIEW_DEVICE_SCALE_FACTOR = Math.min(3, Math.max(1, Number(process.env.BROWSER_VIEW_DEVICE_SCALE_FACTOR || 2)));
const BROWSER_VIEW_JPEG_QUALITY = Math.min(100, Math.max(20, Number(process.env.BROWSER_VIEW_JPEG_QUALITY || 70)));
const BROWSER_VIEW_FRAME_FORMAT = String(process.env.BROWSER_VIEW_FRAME_FORMAT || 'png').trim().toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
const BROWSER_VIEWER_HTML = readFileSync(new URL('./browser-viewer.html', import.meta.url), 'utf8');
const browserlessRelaySessions = new Map();
const browserViewSessions = new Map();
const URL_SCHEME_WITH_SLASHES_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
let activeBrowserlessProxyConfig = null;
let activeBrowserlessProxyHits = 0;

const server = http.createServer(async (req, res) => {
    if (isProxyHttpRequest(req)) {
        return handleProxyHttpRequest(req, res);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-auth-token, x-profile-proxy');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/' || url.pathname === '/health') {
        return json(res, 200, { status: 'ok', service: 'browsersaving-api', version: 5 });
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
        return handleBrowserViewStatus(req, res);
    }

    if (url.pathname === '/api/sessions/launch' && req.method === 'POST') {
        return handleBrowserViewLaunch(req, res);
    }

    const browserViewStopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (browserViewStopMatch && req.method === 'DELETE') {
        return handleBrowserViewStop(browserViewStopMatch[1], req, res);
    }

    const browserViewRoute = parseBrowserViewRoute(url.pathname);
    if (browserViewRoute && req.method === 'GET' && !browserViewRoute.websocket && !browserViewRoute.close) {
        return handleBrowserViewPage(req, res, browserViewRoute.profileId, browserViewRoute.viewerToken);
    }
    if (browserViewRoute && req.method === 'POST' && browserViewRoute.close) {
        return handleBrowserViewViewerClose(req, res, browserViewRoute.profileId, browserViewRoute.viewerToken);
    }

    if (url.pathname === '/debug/browserless/ip' && req.method === 'GET') {
        const proxyDebug = describeProxyInput(req.headers['x-profile-proxy'] || url.searchParams.get('proxy'));
        try {
            const proxy = proxyDebug.normalized;
            const data = await probeBrowserlessIp(proxy);
            return json(res, 200, {
                success: true,
                proxy: proxyDebug.sanitized,
                proxy_debug: proxyDebug,
                ...data,
            });
        } catch (e) {
            return json(res, 500, {
                success: false,
                proxy: proxyDebug.sanitized,
                proxy_debug: proxyDebug,
                error: e.message || String(e),
            });
        }
    }

    // Debug endpoint
    const debugMatch = url.pathname.match(/^\/debug\/cookies\/([^/]+)$/);
    if (debugMatch) {
        try {
            const cookies = await downloadCookies(debugMatch[1], req);
            return json(res, 200, {
                count: cookies.length,
                fb: cookies.filter(c => c.domain?.includes('facebook')).length,
                sample: cookies.slice(0, 3).map(c => ({ name: c.name, domain: c.domain })),
            });
        } catch (e) {
            return json(res, 500, { error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
        }
    }

    // Single profile token
    const tokenMatch = url.pathname.match(/^\/api\/postcron\/([^/]+)\/token$/);
    if (tokenMatch && req.method === 'GET') {
        return handleToken(tokenMatch[1], req, res);
    }

    // Profile post/comment token aliases
    const postMatch = url.pathname.match(/^\/api\/postcron\/([^/]+)\/post$/);
    if (postMatch && req.method === 'GET') {
        return handleToken(postMatch[1], req, res);
    }
    const commentMatch = url.pathname.match(/^\/api\/postcron\/([^/]+)\/comment$/);
    if (commentMatch && req.method === 'GET') {
        return handleCommentToken(commentMatch[1], req, res);
    }

    // Tag-based post/comment token
    const tagModeMatch = url.pathname.match(/^\/api\/postcron\/tag\/([^/]+)\/(post|comment)$/i);
    if (tagModeMatch && req.method === 'GET') {
        const rawTag = decodeURIComponent(tagModeMatch[1] || '').trim();
        const mode = String(tagModeMatch[2] || '').toLowerCase();
        return handleTagToken(rawTag, mode, req, res);
    }

    // All profiles
    if (url.pathname === '/api/postcron/all/tokens' && req.method === 'GET') {
        return handleAllTokens(req, res);
    }

    // Shopee Affiliate Link Generator
    if (url.pathname === '/api/shopee/affiliate-link' && req.method === 'GET') {
        return handleShopeeAffiliate(req, res, url);
    }

    // Facebook Comment
    if (url.pathname === '/api/facebook/comment' && req.method === 'POST') {
        return handleFacebookComment(req, res);
    }

    return json(res, 404, { error: 'Not found' });
});

const browserViewWss = new WebSocketServer({ noServer: true });

server.on('connect', (req, clientSocket, head) => {
    handleRelayConnect(req, clientSocket, head).catch((err) => {
        console.error('❌ [Relay CONNECT] Error:', err);
        try {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } catch {}
        clientSocket.destroy();
    });
});

server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
    const browserViewRoute = parseBrowserViewRoute(requestUrl.pathname);
    if (!browserViewRoute?.websocket) {
        socket.destroy();
        return;
    }

    const session = getBrowserViewSession(browserViewRoute.profileId, browserViewRoute.viewerToken);
    if (!session) {
        socket.destroy();
        return;
    }

    browserViewWss.handleUpgrade(req, socket, head, (ws) => {
        handleBrowserViewSocket(ws, browserViewRoute.profileId, browserViewRoute.viewerToken).catch((error) => {
            try {
                sendBrowserViewMessage(ws, { type: 'error', message: String(error?.message || error || 'Viewer socket failed') });
            } finally {
                ws.close();
            }
        });
    });
});

setInterval(() => {
    pruneExpiredRelaySessions();
}, Math.min(BROWSERLESS_RELAY_TTL_MS, 60_000)).unref();

function json(res, status, data) {
    res.writeHead(status);
    res.end(JSON.stringify(data, null, 2));
}

function normalizeBrowserViewUrl(raw, fallback = BROWSER_VIEW_DEFAULT_URL) {
    const trimmed = String(raw || '').trim();
    const candidate = trimmed || fallback;
    if (!candidate) return '';
    return URL_SCHEME_WITH_SLASHES_RE.test(candidate) ? candidate : `https://${candidate}`;
}

function mapCookiesForPuppeteer(cookies) {
    return (Array.isArray(cookies) ? cookies : [])
        .filter((cookie) => cookie?.name && cookie?.value && cookie?.domain)
        .map((cookie) => {
            const mapped = {
                name: String(cookie.name),
                value: String(cookie.value),
                domain: String(cookie.domain),
                path: String(cookie.path || '/'),
                secure: cookie.secure ?? true,
                httpOnly: cookie.http_only ?? cookie.httpOnly ?? false,
            };
            const expires = Number(cookie.expires);
            if (Number.isFinite(expires) && expires > 0) {
                mapped.expires = expires;
            }
            return mapped;
        });
}

async function requireWorkerAuth(req) {
    const { resp, data } = await fetchWorkerJson(req, '/api/me');
    if (!resp.ok) {
        throw new Error(String(data?.error || 'Unauthorized'));
    }
    return data;
}

function buildBrowserViewPageUrl(req, profileId, viewerToken) {
    const origin = inferPublicOrigin(req);
    return `${origin}/view/${encodeURIComponent(profileId)}/${encodeURIComponent(viewerToken)}`;
}

function inferPublicOrigin(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').trim() || 'https';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
    return `${proto}://${host}`;
}

function parseBrowserViewRoute(pathname) {
    const pageMatch = pathname.match(/^\/view\/([^/]+)\/([^/]+)$/);
    if (pageMatch) {
        return {
            profileId: decodeURIComponent(pageMatch[1]),
            viewerToken: decodeURIComponent(pageMatch[2]),
            websocket: false,
            close: false,
        };
    }

    const wsMatch = pathname.match(/^\/view\/([^/]+)\/([^/]+)\/ws$/);
    if (wsMatch) {
        return {
            profileId: decodeURIComponent(wsMatch[1]),
            viewerToken: decodeURIComponent(wsMatch[2]),
            websocket: true,
            close: false,
        };
    }

    const closeMatch = pathname.match(/^\/view\/([^/]+)\/([^/]+)\/close$/);
    if (closeMatch) {
        return {
            profileId: decodeURIComponent(closeMatch[1]),
            viewerToken: decodeURIComponent(closeMatch[2]),
            websocket: false,
            close: true,
        };
    }

    return null;
}

function isBrowserViewSessionActive(entry) {
    return !!entry &&
        !!entry.page &&
        !entry.page.isClosed() &&
        !!entry.session?.browser &&
        entry.session.browser.isConnected();
}

function getBrowserViewSession(profileId, viewerToken = '') {
    const session = browserViewSessions.get(profileId);
    if (!isBrowserViewSessionActive(session)) {
        if (session) {
            browserViewSessions.delete(profileId);
        }
        return null;
    }
    if (viewerToken && session.viewerToken !== viewerToken) {
        return null;
    }
    return session;
}

function sendBrowserViewMessage(target, payload) {
    if (!target || target.readyState !== 1) return;
    target.send(JSON.stringify(payload));
}

function broadcastBrowserViewState(entry, type = 'state') {
    if (!entry?.clients?.size) return;
    const payload = {
        type,
        title: String(entry.pageTitle || entry.profileName || 'BrowserSaving Viewer'),
        url: String(entry.pageUrl || ''),
    };
    for (const client of entry.clients) {
        sendBrowserViewMessage(client, payload);
    }
}

function closeBrowserViewClients(entry, message) {
    if (!entry?.clients) return;
    for (const client of entry.clients) {
        try {
            sendBrowserViewMessage(client, { type: 'closed', message });
            client.close();
        } catch {}
    }
    entry.clients.clear();
}

function clampBrowserViewViewport(width, height, deviceScaleFactor) {
    return {
        width: Math.min(2560, Math.max(640, Math.round(Number(width) || BROWSER_VIEW_WIDTH))),
        height: Math.min(1600, Math.max(480, Math.round(Number(height) || BROWSER_VIEW_HEIGHT))),
        deviceScaleFactor: Math.min(3, Math.max(1, Number(deviceScaleFactor) || BROWSER_VIEW_DEVICE_SCALE_FACTOR)),
    };
}

function parseRequestedBrowserViewViewport(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const width = Number(raw.width);
    const height = Number(raw.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }

    return clampBrowserViewViewport(
        width,
        height,
        Number(raw.deviceScaleFactor)
    );
}

async function snapshotBrowserViewCookies(page) {
    const client = await page.target().createCDPSession();
    try {
        const payload = await client.send('Network.getAllCookies').catch(() => ({ cookies: [] }));
        return Array.isArray(payload?.cookies) ? payload.cookies : [];
    } finally {
        await client.detach().catch(() => {});
    }
}

async function uploadBrowserViewCookies(profileId, cookies, workerHeaders = {}) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'browser-view-'));
    const cookiesPath = join(tmpDir, 'cookies.json');
    const tarPath = join(tmpDir, 'browser-data.tar.gz');

    try {
        writeFileSync(cookiesPath, JSON.stringify(Array.isArray(cookies) ? cookies : [], null, 2));

        await new Promise((resolve, reject) => {
            const tar = spawn('tar', ['-czf', tarPath, 'cookies.json'], {
                cwd: tmpDir,
                stdio: ['ignore', 'ignore', 'pipe'],
            });

            let stderr = '';
            tar.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            tar.on('close', (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(stderr.trim() || `tar exited with code ${code}`));
            });
            tar.on('error', reject);
        });

        const resp = await fetch(`${WORKER_URL}/api/sync/${encodeURIComponent(profileId)}/upload`, {
            method: 'POST',
            headers: {
                ...workerHeaders,
                'Content-Type': 'application/gzip',
            },
            body: readFileSync(tarPath),
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(text || `Worker upload failed: HTTP ${resp.status}`);
        }
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function persistBrowserViewCookies(entry) {
    if (!entry?.profileId) return false;

    let cookies = Array.isArray(entry.lastKnownCookies) ? entry.lastKnownCookies : [];
    if (isBrowserViewSessionActive(entry)) {
        cookies = await snapshotBrowserViewCookies(entry.page).catch(() => cookies);
    }
    entry.lastKnownCookies = cookies;
    await uploadBrowserViewCookies(entry.profileId, cookies, entry.workerHeaders || {});
    return true;
}

async function closeBrowserViewSession(entry, options = {}) {
    if (!entry) return { closed: false, uploaded: false };
    if (entry.closingPromise) {
        return entry.closingPromise;
    }

    const {
        message = 'The browser session has been stopped.',
        uploadCookies = false,
    } = options;

    entry.closingPromise = (async () => {
        let uploaded = false;
        try {
            if (uploadCookies) {
                uploaded = await persistBrowserViewCookies(entry).catch((error) => {
                    console.error('Failed to persist browser view cookies:', error);
                    return false;
                });
            }

            await stopBrowserViewScreencast(entry).catch(() => {});
            closeBrowserViewClients(entry, message);

            if (entry.cdp) {
                await entry.cdp.detach().catch(() => {});
                entry.cdp = null;
            }

            await entry.session?.disconnect?.().catch(() => {});
            return { closed: true, uploaded };
        } finally {
            browserViewSessions.delete(entry.profileId);
        }
    })();

    return entry.closingPromise;
}

async function updateBrowserViewPageMeta(entry) {
    if (!isBrowserViewSessionActive(entry)) return;
    entry.pageUrl = String(entry.page.url() || '').trim();
    entry.pageTitle = await entry.page.title().catch(() => entry.pageTitle || entry.profileName || 'BrowserSaving Viewer');
    broadcastBrowserViewState(entry);
}

function attachBrowserViewLifecycle(entry, req) {
    if (entry.lifecycleAttached) return;
    entry.lifecycleAttached = true;

    entry.page.on('framenavigated', (frame) => {
        if (frame !== entry.page.mainFrame()) return;
        entry.pageUrl = String(frame.url() || '').trim();
        broadcastBrowserViewState(entry);
    });

    entry.page.on('load', () => {
        updateBrowserViewPageMeta(entry).catch(() => {});
    });

    entry.page.on('close', () => {
        closeBrowserViewClients(entry, 'The remote page closed.');
        browserViewSessions.delete(entry.profileId);
    });

    entry.session.browser.on('disconnected', () => {
        closeBrowserViewClients(entry, 'The Browserless session disconnected.');
        browserViewSessions.delete(entry.profileId);
    });
}

async function ensureBrowserViewCdp(entry) {
    if (entry.cdp) return entry.cdp;

    const cdp = await entry.page.target().createCDPSession();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable').catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: entry.viewport.width,
        height: entry.viewport.height,
        deviceScaleFactor: entry.viewport.deviceScaleFactor,
        mobile: false,
        screenWidth: entry.viewport.width,
        screenHeight: entry.viewport.height,
    }).catch(() => {});

    cdp.on('Page.screencastFrame', async (payload) => {
        entry.lastFrame = payload;
        entry.pageUrl = String(entry.page.url() || entry.pageUrl || '').trim();
        await cdp.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => {});
        if (!entry.clients.size) return;

        const metadata = payload?.metadata || {};
        const message = {
            type: 'frame',
            data: String(payload?.data || ''),
            format: BROWSER_VIEW_FRAME_FORMAT,
            width: entry.viewport.width,
            height: entry.viewport.height,
            bitmapWidth: Math.max(1, Math.round(Number(metadata.deviceWidth) || (entry.viewport.width * entry.viewport.deviceScaleFactor))),
            bitmapHeight: Math.max(1, Math.round(Number(metadata.deviceHeight) || (entry.viewport.height * entry.viewport.deviceScaleFactor))),
            title: String(entry.pageTitle || entry.profileName || 'BrowserSaving Viewer'),
            url: String(entry.pageUrl || ''),
        };

        for (const client of entry.clients) {
            sendBrowserViewMessage(client, message);
        }
    });

    entry.cdp = cdp;
    return cdp;
}

async function startBrowserViewScreencast(entry) {
    const cdp = await ensureBrowserViewCdp(entry);
    if (entry.screencastStarted) return;
    const payload = {
        format: BROWSER_VIEW_FRAME_FORMAT,
        everyNthFrame: 1,
        maxWidth: Math.round(entry.viewport.width * entry.viewport.deviceScaleFactor),
        maxHeight: Math.round(entry.viewport.height * entry.viewport.deviceScaleFactor),
    };
    if (BROWSER_VIEW_FRAME_FORMAT === 'jpeg') {
        payload.quality = BROWSER_VIEW_JPEG_QUALITY;
    }
    await cdp.send('Page.startScreencast', payload);
    entry.screencastStarted = true;
}

async function stopBrowserViewScreencast(entry) {
    if (!entry?.cdp || !entry.screencastStarted) return;
    entry.screencastStarted = false;
    await entry.cdp.send('Page.stopScreencast').catch(() => {});
}

async function applyBrowserViewViewport(entry, width, height, deviceScaleFactor) {
    const nextViewport = clampBrowserViewViewport(width, height, deviceScaleFactor);
    const current = entry.viewport || {};
    if (
        current.width === nextViewport.width &&
        current.height === nextViewport.height &&
        current.deviceScaleFactor === nextViewport.deviceScaleFactor
    ) {
        return;
    }

    entry.viewport = nextViewport;
    await entry.page.setViewport(nextViewport).catch(() => {});
    const cdp = await ensureBrowserViewCdp(entry);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: nextViewport.width,
        height: nextViewport.height,
        deviceScaleFactor: nextViewport.deviceScaleFactor,
        mobile: false,
        screenWidth: nextViewport.width,
        screenHeight: nextViewport.height,
    }).catch(() => {});

    if (entry.screencastStarted) {
        await stopBrowserViewScreencast(entry);
        await startBrowserViewScreencast(entry);
    }
}

async function dispatchBrowserViewMouse(entry, payload = {}) {
    const cdp = await ensureBrowserViewCdp(entry);
    const eventName = String(payload.event || '').trim();
    const typeMap = {
        mousedown: 'mousePressed',
        mouseup: 'mouseReleased',
        mousemove: 'mouseMoved',
        wheel: 'mouseWheel',
    };
    const type = typeMap[eventName];
    if (!type) return;

    const params = {
        type,
        x: Math.max(0, Number(payload.x) || 0),
        y: Math.max(0, Number(payload.y) || 0),
        modifiers: Number(payload.modifiers) || 0,
        button: String(payload.button || (type === 'mouseWheel' ? 'none' : 'left')),
        buttons: Number(payload.buttons) || 0,
        clickCount: type === 'mouseMoved' || type === 'mouseWheel' ? 0 : 1,
    };

    if (type === 'mouseWheel') {
        params.button = 'none';
        params.deltaX = Number(payload.deltaX) || 0;
        params.deltaY = Number(payload.deltaY) || 0;
    }

    await cdp.send('Input.dispatchMouseEvent', params);
}

async function dispatchBrowserViewKey(entry, payload = {}) {
    const cdp = await ensureBrowserViewCdp(entry);
    const eventName = String(payload.event || '').trim();
    const typeMap = {
        keydown: 'keyDown',
        keyup: 'keyUp',
        keypress: 'char',
    };
    const type = typeMap[eventName];
    if (!type) return;

    const text = String(payload.text || '');
    await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: String(payload.key || ''),
        code: String(payload.code || ''),
        text: type === 'char' ? text : (type === 'keyDown' ? text : ''),
        unmodifiedText: text,
        windowsVirtualKeyCode: Number(payload.keyCode) || 0,
        nativeVirtualKeyCode: Number(payload.keyCode) || 0,
        modifiers: Number(payload.modifiers) || 0,
        autoRepeat: false,
        isKeypad: false,
        isSystemKey: false,
    });
}

async function launchBrowserViewSession(profile, requestedUrl, req, requestedViewport = null) {
    const profileId = String(profile?.id || '').trim();
    if (!profileId) {
        throw new Error('Missing profile id');
    }

    const current = getBrowserViewSession(profileId);
    if (current) {
        if (requestedViewport) {
            await applyBrowserViewViewport(
                current,
                requestedViewport.width,
                requestedViewport.height,
                requestedViewport.deviceScaleFactor
            ).catch(() => {});
        }
        const nextUrl = normalizeBrowserViewUrl(requestedUrl || profile?.homepage || current.pageUrl || '');
        if (nextUrl) {
            await current.page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await updateBrowserViewPageMeta(current).catch(() => {});
        }
        return current;
    }

    const cookies = await downloadCookies(profileId, req);
    const requestedProxy = normalizeRequestedProxy(req.headers['x-profile-proxy']);
    const effectiveProxy = requestedProxy || String(profile?.proxy || '').trim();
    const viewport = requestedViewport || clampBrowserViewViewport(
        BROWSER_VIEW_WIDTH,
        BROWSER_VIEW_HEIGHT,
        BROWSER_VIEW_DEVICE_SCALE_FACTOR
    );
    const session = await connectBrowserless(effectiveProxy, {
        headless: false,
        windowSize: `${viewport.width},${viewport.height}`,
    });

    try {
        const page = await session.browser.newPage();
        await page.setViewport(viewport);
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

        const cookieParams = mapCookiesForPuppeteer(cookies);
        if (cookieParams.length > 0) {
            await page.setCookie(...cookieParams);
        }

        const startUrl = normalizeBrowserViewUrl(requestedUrl || profile?.homepage || '');
        if (startUrl) {
            await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async (err) => {
                const message = String(err?.message || err || '');
                if (!/detached/i.test(message)) {
                    throw err;
                }
            });
        }

        const entry = {
            profileId,
            profileName: String(profile?.name || profileId),
            page,
            session,
            viewerToken: crypto.randomBytes(18).toString('hex'),
            browserId: String(page.browser()?.wsEndpoint?.() || '').trim(),
            pageId: String(page.target()?._targetId || '').trim(),
            pageUrl: String(page.url() || '').trim(),
            pageTitle: String(profile?.name || profileId),
            startedAt: Date.now(),
            clients: new Set(),
            lastFrame: null,
            lastKnownCookies: Array.isArray(cookies) ? cookies : [],
            screencastStarted: false,
            viewport,
            cdp: null,
            lifecycleAttached: false,
            workerHeaders: buildWorkerHeaders(req),
            closingPromise: null,
        };

        attachBrowserViewLifecycle(entry, req);
        await updateBrowserViewPageMeta(entry).catch(() => {});

        browserViewSessions.set(profileId, entry);
        return entry;
    } catch (err) {
        await session.disconnect().catch(() => {});
        throw err;
    }
}

async function handleBrowserViewLaunch(req, res) {
    try {
        await requireWorkerAuth(req);
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const profile = body?.profile || {};
        const requestedUrl = String(body?.url || '').trim();
        const requestedViewport = parseRequestedBrowserViewViewport(body?.viewport);
        const entry = await launchBrowserViewSession(profile, requestedUrl, req, requestedViewport);
        return json(res, 200, {
            success: true,
            viewer_url: buildBrowserViewPageUrl(req, entry.profileId, entry.viewerToken),
            profile_id: entry.profileId,
            browser_id: entry.browserId,
            page_id: entry.pageId,
        });
    } catch (err) {
        const message = String(err?.message || err || 'Failed to launch browser view');
        const status = /unauthorized/i.test(message) ? 401 : 500;
        return json(res, status, { success: false, error: message });
    }
}

async function handleBrowserViewStatus(req, res) {
    try {
        await requireWorkerAuth(req);
        return json(res, 200, {
            running: Array.from(browserViewSessions.keys()),
            uploading: [],
            android_running: [],
            android_uploading: [],
        });
    } catch (err) {
        const message = String(err?.message || err || 'Unauthorized');
        const status = /unauthorized/i.test(message) ? 401 : 500;
        return json(res, status, { error: message });
    }
}

async function handleBrowserViewStop(profileId, req, res) {
    try {
        await requireWorkerAuth(req);
        const session = getBrowserViewSession(profileId);
        if (!session) {
            return json(res, 200, { success: true, stopped: false });
        }

        session.workerHeaders = buildWorkerHeaders(req);
        const result = await closeBrowserViewSession(session, {
            message: 'The browser session has been stopped.',
            uploadCookies: true,
        });

        return json(res, 200, { success: true, stopped: true, uploaded: !!result?.uploaded });
    } catch (err) {
        const message = String(err?.message || err || 'Failed to stop browser view');
        const status = /unauthorized/i.test(message) ? 401 : 500;
        return json(res, status, { success: false, error: message });
    }
}

async function handleBrowserViewViewerClose(req, res, profileId, viewerToken) {
    const session = getBrowserViewSession(profileId, viewerToken);
    if (!session) {
        return json(res, 200, { success: true, stopped: false });
    }

    const result = await closeBrowserViewSession(session, {
        message: 'The browser tab was closed.',
        uploadCookies: true,
    }).catch((error) => {
        console.error('Viewer close failed:', error);
        return { closed: false, uploaded: false };
    });

    return json(res, 200, {
        success: true,
        stopped: !!result?.closed,
        uploaded: !!result?.uploaded,
    });
}

function handleBrowserViewPage(req, res, profileId, viewerToken) {
    const session = getBrowserViewSession(profileId, viewerToken);
    if (!session) {
        res.writeHead(404, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f1218;color:#f6f8fc;display:grid;place-items:center;min-height:100vh">Session not found</body></html>');
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(BROWSER_VIEWER_HTML);
}

async function handleBrowserViewSocket(ws, profileId, viewerToken) {
    const session = getBrowserViewSession(profileId, viewerToken);
    if (!session) {
        ws.close(1008, 'Session not found');
        return;
    }

    session.clients.add(ws);
    await updateBrowserViewPageMeta(session).catch(() => {});
    sendBrowserViewMessage(ws, {
        type: 'hello',
        title: String(session.pageTitle || session.profileName || 'BrowserSaving Viewer'),
        url: String(session.pageUrl || ''),
        width: session.viewport.width,
        height: session.viewport.height,
        deviceScaleFactor: session.viewport.deviceScaleFactor,
    });

    if (session.lastFrame?.data) {
        const metadata = session.lastFrame.metadata || {};
        sendBrowserViewMessage(ws, {
            type: 'frame',
            data: String(session.lastFrame.data || ''),
            format: BROWSER_VIEW_FRAME_FORMAT,
            width: session.viewport.width,
            height: session.viewport.height,
            bitmapWidth: Math.max(1, Math.round(Number(metadata.deviceWidth) || (session.viewport.width * session.viewport.deviceScaleFactor))),
            bitmapHeight: Math.max(1, Math.round(Number(metadata.deviceHeight) || (session.viewport.height * session.viewport.deviceScaleFactor))),
            title: String(session.pageTitle || session.profileName || 'BrowserSaving Viewer'),
            url: String(session.pageUrl || ''),
        });
    }

    await startBrowserViewScreencast(session);

    ws.on('message', async (raw) => {
        try {
            const message = JSON.parse(String(raw || '{}'));
            if (message?.type === 'mouse') {
                await dispatchBrowserViewMouse(session, { event: message.event, ...message.payload });
                return;
            }
            if (message?.type === 'key') {
                await dispatchBrowserViewKey(session, { event: message.event, ...message.payload });
                return;
            }
            if (message?.type === 'resize') {
                await applyBrowserViewViewport(
                    session,
                    message?.payload?.width,
                    message?.payload?.height,
                    message?.payload?.deviceScaleFactor
                );
            }
        } catch (error) {
            sendBrowserViewMessage(ws, { type: 'error', message: String(error?.message || error || 'Viewer input failed') });
        }
    });

    ws.on('close', () => {
        session.clients.delete(ws);
    });
}

function isProxyHttpRequest(req) {
    const url = String(req?.url || '');
    return /^https?:\/\//i.test(url) && (!!req?.headers?.['proxy-authorization'] || !!activeBrowserlessProxyConfig);
}

function normalizeRequestedProxy(raw) {
    if (Array.isArray(raw)) return String(raw[0] || '').trim();
    return String(raw || '').trim();
}

function sanitizeProxyForLogs(raw) {
    const proxy = normalizeRequestedProxy(raw);
    if (!proxy) return '';
    try {
        const normalized = URL_SCHEME_WITH_SLASHES_RE.test(proxy) ? proxy : `socks5://${proxy}`;
        const parsed = new URL(normalized);
        const protocol = parsed.protocol || 'proxy:';
        const host = parsed.hostname || '';
        const port = parsed.port ? `:${parsed.port}` : '';
        const auth = parsed.username ? `${decodeURIComponent(parsed.username)}:***@` : '';
        return `${protocol}//${auth}${host}${port}`;
    } catch {
        return proxy;
    }
}

function parseProxyConfig(raw) {
    const trimmed = normalizeRequestedProxy(raw);
    if (!trimmed) return null;

    const candidate = URL_SCHEME_WITH_SLASHES_RE.test(trimmed) ? trimmed : `socks5://${trimmed}`;
    let parsed;
    try {
        parsed = new URL(candidate);
    } catch (err) {
        throw new Error(`Invalid proxy URL: ${err.message || err}`);
    }

    const protocol = String(parsed.protocol || '').replace(/:$/, '').toLowerCase();
    const host = String(parsed.hostname || '').trim();
    const port = Number(parsed.port || (
        protocol === 'https' ? 443 :
        protocol === 'http' ? 80 :
        1080
    ));

    if (!host || !port) {
        throw new Error('Proxy is missing host or port');
    }

    return {
        raw: candidate,
        protocol,
        host,
        port,
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
    };
}

function describeProxyInput(raw) {
    const normalized = normalizeRequestedProxy(raw);
    let parsed = null;
    try {
        const config = parseProxyConfig(normalized);
        parsed = config ? {
            protocol: config.protocol,
            host: config.host,
            port: config.port,
            username: config.username || '',
            hasPassword: !!config.password,
        } : null;
    } catch (err) {
        parsed = { error: err.message || String(err) };
    }

    return {
        raw_value: Array.isArray(raw) ? raw : String(raw || ''),
        normalized,
        sanitized: sanitizeProxyForLogs(normalized),
        parsed,
    };
}

function registerRelaySession(proxyConfig) {
    pruneExpiredRelaySessions();
    const relayId = crypto.randomUUID();
    const relaySecret = crypto.randomBytes(18).toString('hex');

    browserlessRelaySessions.set(relayId, {
        relaySecret,
        proxyConfig,
        expiresAt: Date.now() + BROWSERLESS_RELAY_TTL_MS,
    });

    const auth = `${encodeURIComponent(relayId)}:${relaySecret}@`;
    return {
        relayId,
        relaySecret,
        externalProxyServer: `http://${auth}${BROWSERLESS_RELAY_HOST}:${BROWSERLESS_RELAY_PORT}`,
        cleanup: () => browserlessRelaySessions.delete(relayId),
    };
}

function pruneExpiredRelaySessions() {
    const now = Date.now();
    for (const [relayId, relay] of browserlessRelaySessions.entries()) {
        if ((relay?.expiresAt || 0) <= now) {
            browserlessRelaySessions.delete(relayId);
        }
    }
}

function getRelaySessionFromHeaders(headers = {}) {
    const rawAuth = String(headers['proxy-authorization'] || headers['Proxy-Authorization'] || '').trim();
    if (!rawAuth.toLowerCase().startsWith('basic ')) return null;

    let decoded = '';
    try {
        decoded = Buffer.from(rawAuth.slice(6), 'base64').toString('utf8');
    } catch {
        return null;
    }

    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex <= 0) return null;
    const relayId = decoded.slice(0, separatorIndex);
    const relaySecret = decoded.slice(separatorIndex + 1);
    const relay = browserlessRelaySessions.get(relayId);
    if (!relay || relay.relaySecret !== relaySecret) return null;
    relay.expiresAt = Date.now() + BROWSERLESS_RELAY_TTL_MS;
    return relay;
}

function parseConnectTarget(rawTarget) {
    const target = String(rawTarget || '').trim();
    if (!target) throw new Error('Missing CONNECT target');

    if (target.startsWith('[')) {
        const closing = target.indexOf(']');
        if (closing < 0) throw new Error(`Invalid CONNECT target: ${target}`);
        const host = target.slice(1, closing);
        const port = Number(target.slice(closing + 2));
        if (!host || !port) throw new Error(`Invalid CONNECT target: ${target}`);
        return { host, port };
    }

    const separatorIndex = target.lastIndexOf(':');
    if (separatorIndex <= 0) throw new Error(`Invalid CONNECT target: ${target}`);
    const host = target.slice(0, separatorIndex);
    const port = Number(target.slice(separatorIndex + 1));
    if (!host || !port) throw new Error(`Invalid CONNECT target: ${target}`);
    return { host, port };
}

function isSocksProxyConfig(proxyConfig) {
    return proxyConfig?.protocol === 'socks5' || proxyConfig?.protocol === 'socks5h';
}

function isHttpProxyConfig(proxyConfig) {
    return proxyConfig?.protocol === 'http' || proxyConfig?.protocol === 'https';
}

function buildProxyAuthorizationHeader(proxyConfig) {
    if (!proxyConfig || (!proxyConfig.username && !proxyConfig.password)) return '';
    const token = Buffer.from(`${proxyConfig.username || ''}:${proxyConfig.password || ''}`, 'utf8').toString('base64');
    return `Basic ${token}`;
}

function createSocketReader(socket) {
    let buffered = Buffer.alloc(0);
    let ended = false;
    let failed = null;
    const waiters = [];

    const flush = () => {
        while (waiters.length > 0) {
            const waiter = waiters[0];
            if (waiter.mode === 'until') {
                const index = buffered.indexOf(waiter.pattern);
                if (index >= 0) {
                    waiters.shift();
                    const end = index + waiter.pattern.length;
                    const chunk = buffered.subarray(0, end);
                    buffered = buffered.subarray(end);
                    waiter.resolve(chunk);
                    continue;
                }
                if (waiter.maxSize && buffered.length > waiter.maxSize) {
                    waiters.shift();
                    waiter.reject(new Error('Socket reader exceeded maximum buffered bytes while waiting for pattern'));
                    continue;
                }
            } else if (buffered.length >= waiter.size) {
                waiters.shift();
                const chunk = buffered.subarray(0, waiter.size);
                buffered = buffered.subarray(waiter.size);
                waiter.resolve(chunk);
                continue;
            }
            if (failed) {
                waiters.shift();
                waiter.reject(failed);
                continue;
            }
            if (ended) {
                waiters.shift();
                waiter.reject(new Error('Socket closed before enough data was received'));
                continue;
            }
            break;
        }
    };

    const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        flush();
    };
    const onError = (err) => {
        failed = err instanceof Error ? err : new Error(String(err));
        flush();
    };
    const onClose = () => {
        ended = true;
        flush();
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('end', onClose);

    return {
        readExact(size) {
            return new Promise((resolve, reject) => {
                waiters.push({ mode: 'exact', size, resolve, reject });
                flush();
            });
        },
        readUntil(pattern, maxSize = 64 * 1024) {
            return new Promise((resolve, reject) => {
                waiters.push({
                    mode: 'until',
                    pattern: Buffer.isBuffer(pattern) ? pattern : Buffer.from(pattern),
                    maxSize,
                    resolve,
                    reject,
                });
                flush();
            });
        },
        takeBuffered() {
            const chunk = buffered;
            buffered = Buffer.alloc(0);
            return chunk;
        },
        destroy() {
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
            socket.off('end', onClose);
        },
    };
}

async function connectViaSocksProxy(proxyConfig, targetHost, targetPort) {
    const upstreamSocket = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: proxyConfig.host, port: proxyConfig.port }, () => resolve(socket));
        socket.once('error', reject);
        socket.setTimeout(30_000, () => {
            socket.destroy(new Error('Upstream SOCKS5 proxy connection timed out'));
        });
    });

    upstreamSocket.setTimeout(0);
    upstreamSocket.setNoDelay(true);

    const reader = createSocketReader(upstreamSocket);
    try {
        const needsAuth = !!(proxyConfig.username || proxyConfig.password);
        const methods = needsAuth ? [0x00, 0x02] : [0x00];
        upstreamSocket.write(Buffer.from([0x05, methods.length, ...methods]));

        const greeting = await reader.readExact(2);
        if (greeting[0] !== 0x05) throw new Error('Invalid SOCKS5 version from upstream proxy');
        if (greeting[1] === 0xff) throw new Error('Upstream SOCKS5 proxy rejected all auth methods');

        if (greeting[1] === 0x02) {
            const username = Buffer.from(proxyConfig.username || '', 'utf8');
            const password = Buffer.from(proxyConfig.password || '', 'utf8');
            if (username.length > 255 || password.length > 255) {
                throw new Error('SOCKS5 username/password must be 255 bytes or less');
            }
            upstreamSocket.write(Buffer.concat([
                Buffer.from([0x01, username.length]),
                username,
                Buffer.from([password.length]),
                password,
            ]));
            const authReply = await reader.readExact(2);
            if (authReply[1] !== 0x00) throw new Error('SOCKS5 authentication failed');
        } else if (greeting[1] !== 0x00) {
            throw new Error(`Unsupported SOCKS5 auth method selected: ${greeting[1]}`);
        }

        let addressBuffer;
        const ipVersion = net.isIP(targetHost);
        if (ipVersion === 4) {
            addressBuffer = Buffer.concat([
                Buffer.from([0x01]),
                Buffer.from(targetHost.split('.').map((part) => Number(part))),
            ]);
        } else if (ipVersion === 6) {
            const ipv6Bytes = Buffer.alloc(16);
            const normalized = targetHost.split(':');
            // Expand compressed IPv6 notation.
            const emptyIndex = normalized.indexOf('');
            if (emptyIndex >= 0) {
                const missing = 8 - (normalized.length - 1);
                normalized.splice(emptyIndex, 1, ...Array(missing + 1).fill('0'));
            }
            normalized.filter(Boolean).slice(0, 8).forEach((part, index) => {
                ipv6Bytes.writeUInt16BE(parseInt(part || '0', 16) || 0, index * 2);
            });
            addressBuffer = Buffer.concat([Buffer.from([0x04]), ipv6Bytes]);
        } else {
            const domain = Buffer.from(targetHost, 'utf8');
            if (domain.length > 255) throw new Error('SOCKS5 domain target is too long');
            addressBuffer = Buffer.concat([Buffer.from([0x03, domain.length]), domain]);
        }

        const portBuffer = Buffer.alloc(2);
        portBuffer.writeUInt16BE(targetPort, 0);
        upstreamSocket.write(Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00]),
            addressBuffer,
            portBuffer,
        ]));

        const connectHead = await reader.readExact(4);
        if (connectHead[0] !== 0x05) throw new Error('Invalid SOCKS5 connect response');
        if (connectHead[1] !== 0x00) throw new Error(`Upstream SOCKS5 proxy connect failed with status ${connectHead[1]}`);

        const atyp = connectHead[3];
        if (atyp === 0x01) await reader.readExact(4);
        else if (atyp === 0x03) {
            const len = await reader.readExact(1);
            await reader.readExact(len[0]);
        } else if (atyp === 0x04) {
            await reader.readExact(16);
        } else {
            throw new Error(`Unsupported SOCKS5 bind address type ${atyp}`);
        }
        await reader.readExact(2);

        reader.destroy();
        return {
            socket: upstreamSocket,
            initialData: reader.takeBuffered(),
        };
    } catch (err) {
        reader.destroy();
        upstreamSocket.destroy();
        throw err;
    }
}

async function connectViaHttpProxy(proxyConfig, targetHost, targetPort) {
    const upstreamSocket = await new Promise((resolve, reject) => {
        const handleConnect = () => {
            upstreamSocket.setTimeout(0);
            upstreamSocket.setNoDelay(true);
            resolve(upstreamSocket);
        };

        const upstreamSocket = proxyConfig.protocol === 'https'
            ? tls.connect({
                host: proxyConfig.host,
                port: proxyConfig.port,
                servername: proxyConfig.host,
            }, handleConnect)
            : net.createConnection({ host: proxyConfig.host, port: proxyConfig.port }, handleConnect);

        upstreamSocket.once('error', reject);
        upstreamSocket.setTimeout(30_000, () => {
            upstreamSocket.destroy(new Error('Upstream HTTP proxy connection timed out'));
        });
    });

    const reader = createSocketReader(upstreamSocket);
    try {
        const proxyAuth = buildProxyAuthorizationHeader(proxyConfig);
        const target = net.isIPv6(targetHost) ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
        const lines = [
            `CONNECT ${target} HTTP/1.1`,
            `Host: ${target}`,
            'Connection: keep-alive',
            'Proxy-Connection: keep-alive',
        ];
        if (proxyAuth) {
            lines.push(`Proxy-Authorization: ${proxyAuth}`);
        }
        lines.push('', '');
        upstreamSocket.write(lines.join('\r\n'));

        const responseHead = await reader.readUntil('\r\n\r\n');
        const statusLine = responseHead.toString('latin1').split('\r\n')[0] || '';
        const statusCode = Number(statusLine.split(/\s+/)[1] || 0);
        if (statusCode !== 200) {
            throw new Error(`Upstream HTTP proxy CONNECT failed: ${statusLine || 'Unknown status'}`);
        }

        const initialData = reader.takeBuffered();
        reader.destroy();
        return {
            socket: upstreamSocket,
            initialData,
        };
    } catch (err) {
        reader.destroy();
        upstreamSocket.destroy();
        throw err;
    }
}

async function connectThroughProxy(proxyConfig, targetHost, targetPort) {
    if (isSocksProxyConfig(proxyConfig)) {
        return connectViaSocksProxy(proxyConfig, targetHost, targetPort);
    }
    if (isHttpProxyConfig(proxyConfig)) {
        return connectViaHttpProxy(proxyConfig, targetHost, targetPort);
    }
    throw new Error(`Unsupported upstream proxy protocol: ${proxyConfig?.protocol || 'unknown'}`);
}

async function handleRelayConnect(req, clientSocket, head, forcedProxyConfig = null) {
    const relay = forcedProxyConfig
        ? { proxyConfig: forcedProxyConfig }
        : getRelaySessionFromHeaders(req.headers) || (activeBrowserlessProxyConfig ? { proxyConfig: activeBrowserlessProxyConfig } : null);
    if (!relay?.proxyConfig) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="BrowserSaving Relay"\r\n\r\n');
        clientSocket.destroy();
        return;
    }

    if (!forcedProxyConfig) {
        activeBrowserlessProxyHits += 1;
    }

    const target = parseConnectTarget(req.url);
    const { socket: upstreamSocket, initialData } = await connectThroughProxy(
        relay.proxyConfig,
        target.host,
        target.port,
    );

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) {
        upstreamSocket.write(head);
    }
    if (initialData?.length) {
        clientSocket.write(initialData);
    }

    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
}

async function handleProxyHttpRequest(req, res, forcedProxyConfig = null) {
    const relay = forcedProxyConfig
        ? { proxyConfig: forcedProxyConfig }
        : getRelaySessionFromHeaders(req.headers) || (activeBrowserlessProxyConfig ? { proxyConfig: activeBrowserlessProxyConfig } : null);
    if (!relay?.proxyConfig) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="BrowserSaving Relay"' });
        res.end('Proxy authentication required');
        return;
    }

    if (!forcedProxyConfig) {
        activeBrowserlessProxyHits += 1;
    }

    let targetUrl;
    try {
        targetUrl = new URL(req.url);
    } catch {
        res.writeHead(400);
        res.end('Invalid proxy URL');
        return;
    }

    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    headers.host = targetUrl.host;
    headers.connection = 'close';

    const proxyHandler = (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
    };
    let proxyReq;

    if (isSocksProxyConfig(relay.proxyConfig)) {
        const client = targetUrl.protocol === 'https:' ? https : http;
        proxyReq = client.request({
            protocol: targetUrl.protocol,
            host: targetUrl.hostname,
            port: Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80)),
            method: req.method,
            path: `${targetUrl.pathname || '/'}${targetUrl.search || ''}`,
            headers,
            createConnection: (_options, callback) => {
                connectViaSocksProxy(
                    relay.proxyConfig,
                    targetUrl.hostname,
                    Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80)),
                ).then(({ socket }) => callback(null, socket)).catch(callback);
            },
        }, proxyHandler);
    } else if (isHttpProxyConfig(relay.proxyConfig)) {
        const proxyAuth = buildProxyAuthorizationHeader(relay.proxyConfig);
        if (proxyAuth) {
            headers['proxy-authorization'] = proxyAuth;
        }
        const proxyClient = relay.proxyConfig.protocol === 'https' ? https : http;
        proxyReq = proxyClient.request({
            protocol: `${relay.proxyConfig.protocol}:`,
            host: relay.proxyConfig.host,
            port: relay.proxyConfig.port,
            method: req.method,
            path: req.url,
            headers,
        }, proxyHandler);
    } else {
        throw new Error(`Unsupported upstream proxy protocol: ${relay.proxyConfig?.protocol || 'unknown'}`);
    }

    proxyReq.on('error', (err) => {
        console.error('❌ [Relay HTTP] Error:', err);
        if (!res.headersSent) res.writeHead(502);
        res.end('Bad Gateway');
    });

    req.pipe(proxyReq);
}

async function startLocalProxyRelay(proxyConfig) {
    const relayServer = http.createServer((req, res) => {
        handleProxyHttpRequest(req, res, proxyConfig).catch((err) => {
            console.error('❌ [Local Relay HTTP] Error:', err);
            if (!res.headersSent) res.writeHead(502);
            res.end('Bad Gateway');
        });
    });

    relayServer.on('connect', (req, clientSocket, head) => {
        handleRelayConnect(req, clientSocket, head, proxyConfig).catch((err) => {
            console.error('❌ [Local Relay CONNECT] Error:', err);
            try {
                clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            } catch {}
            clientSocket.destroy();
        });
    });

    await new Promise((resolve, reject) => {
        const onError = (err) => {
            relayServer.off('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            relayServer.off('error', onError);
            resolve();
        };
        relayServer.once('error', onError);
        relayServer.once('listening', onListening);
        relayServer.listen(0, '0.0.0.0');
    });

    const address = relayServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    if (!port) {
        relayServer.close();
        throw new Error('Failed to allocate local proxy relay port');
    }

    return {
        proxyServer: `http://${BROWSERLESS_RELAY_HOST}:${port}`,
        proxySummary: `${sanitizeProxyForLogs(proxyConfig.raw)} via local relay`,
        cleanup: async () => {
            await new Promise((resolve) => relayServer.close(() => resolve()));
        },
    };
}

async function buildBrowserlessEndpoint(proxy, options = {}) {
    const endpoint = new URL(BROWSERLESS_WS);
    if (!endpoint.searchParams.has('token')) {
        endpoint.searchParams.set('token', BROWSERLESS_TOKEN);
    }
    if (!endpoint.searchParams.has('timeout')) {
        endpoint.searchParams.set('timeout', '120000');
    }

    const appendChromeArg = (name, value) => {
        endpoint.searchParams.set(name, value);
    };

    if (options.headless === false) {
        endpoint.searchParams.set('headless', 'false');
    }
    if (options.windowSize) {
        appendChromeArg('--window-size', String(options.windowSize));
    }

    const proxyConfig = parseProxyConfig(proxy);
    if (!proxyConfig) {
        return {
            browserWSEndpoint: endpoint.toString(),
            cleanup: async () => {},
            proxySummary: 'direct',
        };
    }

    if ((proxyConfig.protocol === 'http' || proxyConfig.protocol === 'https') && !proxyConfig.username && !proxyConfig.password) {
        appendChromeArg('--proxy-server', `${proxyConfig.protocol}://${proxyConfig.host}:${proxyConfig.port}`);
        appendChromeArg('--proxy-bypass-list', '<-loopback>');
        return {
            browserWSEndpoint: endpoint.toString(),
            cleanup: async () => {},
            proxySummary: sanitizeProxyForLogs(proxyConfig.raw),
        };
    }

    if ((proxyConfig.protocol === 'http' || proxyConfig.protocol === 'https') && (proxyConfig.username || proxyConfig.password)) {
        const relaySession = await startLocalProxyRelay(proxyConfig);
        appendChromeArg('--proxy-server', relaySession.proxyServer);
        appendChromeArg('--proxy-bypass-list', '<-loopback>');
        return {
            browserWSEndpoint: endpoint.toString(),
            cleanup: relaySession.cleanup,
            proxySummary: relaySession.proxySummary,
        };
    }

    if (proxyConfig.protocol === 'socks5' || proxyConfig.protocol === 'socks5h') {
        activeBrowserlessProxyHits = 0;
        activeBrowserlessProxyConfig = proxyConfig;
        appendChromeArg('--proxy-server', `http://${BROWSERLESS_RELAY_HOST}:${BROWSERLESS_RELAY_PORT}`);
        appendChromeArg('--proxy-bypass-list', '<-loopback>');
        return {
            browserWSEndpoint: endpoint.toString(),
            cleanup: async () => {
                activeBrowserlessProxyConfig = null;
                activeBrowserlessProxyHits = 0;
            },
            proxySummary: `${sanitizeProxyForLogs(proxyConfig.raw)} via BrowserSaving relay`,
        };
    }

    throw new Error(`Unsupported proxy scheme for Browserless: ${proxyConfig.protocol}`);
}

async function connectBrowserless(proxy = '', options = {}) {
    const relaySession = await buildBrowserlessEndpoint(proxy, options);
    const browser = await puppeteer.connect({ browserWSEndpoint: relaySession.browserWSEndpoint });
    return {
        browser,
        proxySummary: relaySession.proxySummary,
        async disconnect() {
            try { browser.disconnect(); } catch {}
            await relaySession.cleanup();
        }
    };
}

async function probeBrowserlessIp(proxy = '') {
    const session = await connectBrowserless(proxy);
    try {
        const page = await session.browser.newPage();
        await page.goto(BROWSERLESS_IP_CHECK_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        const bodyText = await page.evaluate(() => document.body?.innerText || '');
        await page.close();

        let payload = {};
        try {
            payload = JSON.parse(bodyText || '{}');
        } catch {
            payload = { raw: String(bodyText || '').trim() };
        }

        return {
            ip_check_url: BROWSERLESS_IP_CHECK_URL,
            proxy_summary: session.proxySummary,
            relay_hits: activeBrowserlessProxyHits,
            payload,
        };
    } finally {
        await session.disconnect();
    }
}

function buildWorkerHeaders(req, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    const authToken = String(req?.headers?.['x-auth-token'] || '').trim();
    const authorization = String(req?.headers?.authorization || '').trim();
    if (authToken && !headers['x-auth-token']) headers['x-auth-token'] = authToken;
    if (authorization && !headers.Authorization && !headers.authorization) headers.authorization = authorization;
    return headers;
}

async function fetchWorkerJson(req, path, init = {}) {
    const headers = buildWorkerHeaders(req, init.headers || {});
    const resp = await fetch(`${WORKER_URL}${path}`, { ...init, headers });
    const data = await resp.json().catch(() => null);
    return { resp, data };
}

function extractProfilesList(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.profiles)) return payload.profiles;
    if (Array.isArray(payload?.results)) return payload.results;
    return null;
}

function getProfilesLoadErrorDetails(payload, resp) {
    return payload?.details || payload?.error || `HTTP ${resp.status}`;
}

async function updateWorkerProfile(req, profileId, body) {
    return fetch(`${WORKER_URL}/api/profiles/${profileId}`, {
        method: 'PUT',
        headers: buildWorkerHeaders(req, {
            'Content-Type': 'application/json',
        }),
        body: JSON.stringify(body),
    });
}

async function handleToken(profileId, req, res) {
    const t0 = Date.now();
    console.log(`🔑 [${profileId.substring(0, 8)}] Start`);
    try {
        const { resp: profilesResp, data: profilesData } = await fetchWorkerJson(req, '/api/profiles');
        const profiles = extractProfilesList(profilesData);
        if (!profilesResp.ok || !profiles) {
            return json(res, profilesResp.status || 502, {
                error: 'Failed to load profiles from BrowserSaving worker',
                details: getProfilesLoadErrorDetails(profilesData, profilesResp),
            });
        }
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return json(res, 404, { error: 'Profile not found' });

        const cookies = await downloadCookies(profileId, req);
        const fbCount = cookies.filter(c => c.domain?.includes('facebook.com')).length;
        console.log(`🍪 [${profile.name}] ${cookies.length} cookies, ${fbCount} FB`);

        if (fbCount === 0) {
            return json(res, 400, { error: 'No Facebook cookies', profile: profile.name });
        }

        const requestedProxy = normalizeRequestedProxy(req.headers['x-profile-proxy']);
        const effectiveProxy = requestedProxy || String(profile.proxy || '').trim();
        const extract = await extractToken(cookies, effectiveProxy);
        const token = extract?.token || null;
        const dur = ((Date.now() - t0) / 1000).toFixed(1);

        if (!token) {
            return json(res, 400, buildPostcronFailure(profile.name, dur, extract));
        }

        await updateWorkerProfile(req, profileId, { facebook_token: token });

        console.log(`✅ [${profile.name}] ${dur}s`);
        return json(res, 200, { success: true, profile: profile.name, token, duration: dur + 's' });
    } catch (err) {
        console.error(`❌ Error:`, err);
        return json(res, 500, { error: err.message });
    }
}

function normalizeTags(raw) {
    if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
    const text = String(raw || '').trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            return parsed.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
        }
    } catch {}
    return text.split(',').map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
}

function extractDatrFromCookies(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) return '';
    for (const cookie of cookies) {
        const name = String(cookie?.name || '').trim().toLowerCase();
        if (name !== 'datr') continue;
        const value = String(cookie?.value || '').trim();
        if (!value) continue;
        const domain = String(cookie?.domain || '').trim().toLowerCase();
        if (!domain || domain.includes('facebook.com')) return value;
    }
    return '';
}

async function findProfileByTag(tag, req) {
    const normalizedTag = String(tag || '').trim().toLowerCase();
    if (!normalizedTag) throw new Error('tag_required');

    const { resp: profilesResp, data } = await fetchWorkerJson(req, '/api/profiles');
    const profiles = extractProfilesList(data);
    if (!profilesResp.ok || !profiles) {
        throw new Error(`profiles_fetch_failed:${getProfilesLoadErrorDetails(data, profilesResp)}`);
    }
    const matched = profiles.filter((p) => normalizeTags(p?.tags).includes(normalizedTag));
    if (matched.length === 0) throw new Error(`tag_not_found:${normalizedTag}`);
    if (matched.length > 1) {
        const sample = matched.slice(0, 5).map((p) => `${p.id}:${p.name}`).join(',');
        throw new Error(`tag_ambiguous:${normalizedTag}:${matched.length}:${sample}`);
    }
    return { profile: matched[0], matchedCount: matched.length, tag: normalizedTag };
}

async function handleCommentToken(profileId, req, res) {
    const t0 = Date.now();
    console.log(`💬 [${String(profileId).substring(0, 8)}] Start`);
    try {
        const { resp: profilesResp, data: profilesData } = await fetchWorkerJson(req, '/api/profiles');
        const profiles = extractProfilesList(profilesData);
        if (!profilesResp.ok || !profiles) {
            return json(res, profilesResp.status || 502, {
                error: 'Failed to load profiles from BrowserSaving worker',
                details: getProfilesLoadErrorDetails(profilesData, profilesResp),
            });
        }
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return json(res, 404, { error: 'Profile not found' });

        const loginId = String(profile.uid || profile.username || '').trim();
        const password = String(profile.password || '').trim();
        if (!loginId || !password) {
            return json(res, 400, { error: 'Missing uid/username or password', profile: profile.name });
        }

        let datr = String(profile.datr || '').trim();
        let datrSource = datr ? 'profile' : 'none';
        if (!datr) {
            try {
                const cookies = await downloadCookies(profileId, req);
                const fromCookies = extractDatrFromCookies(cookies);
                if (fromCookies) {
                    datr = fromCookies;
                    datrSource = 'cookies';
                    await updateWorkerProfile(req, profileId, { datr: fromCookies }).catch(() => {});
                }
            } catch (e) {
                console.log(`⚠️ [${profile.name}] datr auto-resolve failed: ${e.message || e}`);
            }
        }

        const tokenResp = await fetch(COMMENT_TOKEN_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                uid: loginId,
                username: loginId,
                password,
                '2fa': profile.totp_secret || null,
                datr: datr || null,
            }),
        });
        const tokenData = await tokenResp.json().catch(() => ({}));
        if (!tokenResp.ok || !tokenData?.success || !tokenData?.token) {
            return json(res, 400, { error: tokenData?.error || `comment_token_api_failed (${tokenResp.status})`, profile: profile.name });
        }

        const token = String(tokenData.token || '').trim();
        if (!token) {
            return json(res, 400, { error: 'token_missing', profile: profile.name });
        }

        await updateWorkerProfile(req, profileId, { comment_token: token });

        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`✅ [${profile.name}] comment ${dur}s`);
        return json(res, 200, { success: true, mode: 'comment', profile: profile.name, token, datr_source: datrSource, duration: dur + 's' });
    } catch (err) {
        console.error(`❌ Comment Error:`, err);
        return json(res, 500, { error: err.message });
    }
}

async function handleTagToken(tag, mode, req, res) {
    try {
        const { profile, matchedCount, tag: normalizedTag } = await findProfileByTag(tag, req);
        if (mode === 'comment') {
            return handleCommentToken(profile.id, req, res);
        }
        return handleToken(profile.id, req, res);
    } catch (err) {
        return json(res, 400, { error: err.message || String(err), tag, mode });
    }
}

async function handleAllTokens(req, res) {
    const { resp: profilesResp, data } = await fetchWorkerJson(req, '/api/profiles');
    const profiles = extractProfilesList(data);
    if (!profilesResp.ok || !profiles) {
        return json(res, profilesResp.status || 502, {
            error: 'Failed to load profiles from BrowserSaving worker',
            details: getProfilesLoadErrorDetails(data, profilesResp),
        });
    }
    const results = [];

    for (const profile of profiles) {
        try {
            const cookies = await downloadCookies(profile.id, req);
            if (cookies.filter(c => c.domain?.includes('facebook.com')).length === 0) {
                results.push({ profile: profile.name, status: 'skip', reason: 'No FB cookies' });
                continue;
            }
            const extract = await extractToken(cookies);
            const token = extract?.token || null;
            if (token) {
                await updateWorkerProfile(req, profile.id, { facebook_token: token });
                results.push({ profile: profile.name, status: 'ok', token: token.substring(0, 20) + '...' });
            } else {
                results.push({
                    profile: profile.name,
                    status: 'expired',
                    reason: extract?.reason || 'session_expired',
                    current_url: extract?.url || null,
                    action_required: 'Open browser for this profile, complete Facebook login/checkpoint, stop profile to sync cookies, then retry Postcron.'
                });
            }
        } catch (e) {
            results.push({ profile: profile.name, status: 'error', reason: e.message });
        }
    }

    return json(res, 200, { total: profiles.length, ok: results.filter(r => r.status === 'ok').length, results });
}

// ==================== DOWNLOAD COOKIES ====================

async function downloadCookies(profileId, req) {
    const url = `${WORKER_URL}/api/sync/${profileId}/download`;
    console.log(`📥 Fetching ${url}`);

    const resp = await fetch(url, {
        headers: buildWorkerHeaders(req),
    });
    if (!resp.ok) {
        console.log(`📥 HTTP ${resp.status}`);
        return [];
    }

    // Get raw bytes
    const arrayBuf = await resp.arrayBuffer();
    let buf = Buffer.from(arrayBuf);
    console.log(`📥 Got ${buf.length} bytes, first4: ${buf.slice(0, 4).toString('hex')}`);

    if (buf.length < 100) return [];

    // Node.js fetch may auto-decompress. Check if data is gzip or already tar.
    // Gzip magic: 1f 8b
    // Tar: filename starts at byte 0 (ASCII chars like 'D', 'c', etc.)
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        console.log(`📥 Decompressing gzip...`);
        try {
            buf = gunzipSync(buf);
        } catch (e) {
            // Truncated gzip - try using system tar command which is more lenient
            console.log(`📥 Gzip decompress failed: ${e.message}, trying tar -xz...`);
            return await extractCookiesWithTar(buf);
        }
        // Double-gzip check
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
            buf = gunzipSync(buf);
        }
    }

    console.log(`📥 Tar size: ${buf.length}, first4: ${buf.slice(0, 4).toString('hex')}`);

    // Parse tar
    return parseTarForCookies(buf);
}

async function extractCookiesWithTar(gzipBuf) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'cookies-'));
    const tarPath = join(tmpDir, 'data.tar.gz');
    
    try {
        writeFileSync(tarPath, gzipBuf);
        
        // Use tar command with error tolerance
        await new Promise((resolve, reject) => {
            const tar = spawn('tar', ['-xzf', tarPath, '-C', tmpDir, 'cookies.json'], {
                stdio: ['ignore', 'ignore', 'ignore']
            });
            tar.on('close', (code) => {
                // tar might exit with error but still extract partial files
                resolve();
            });
            tar.on('error', reject);
        });
        
        const cookiesPath = join(tmpDir, 'cookies.json');
        try {
            const content = readFileSync(cookiesPath, 'utf8');
            console.log(`🍪 Extracted cookies.json via tar command`);
            return JSON.parse(content);
        } catch (e) {
            return [];
        }
    } finally {
        try { rmSync(tmpDir, { recursive: true }); } catch {}
    }
}

function parseTarForCookies(tarBuf) {
    let offset = 0;
    while (offset + 512 <= tarBuf.length) {
        const header = tarBuf.slice(offset, offset + 512);
        if (header.every(b => b === 0)) break;

        // Filename: bytes 0-99
        let nameEnd = 0;
        while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
        const name = header.slice(0, nameEnd).toString('ascii');

        // Size: bytes 124-135 (octal)
        const sizeStr = header.slice(124, 136).toString('ascii').replace(/\0/g, '').trim();
        const size = parseInt(sizeStr, 8) || 0;

        offset += 512; // past header

        if (name === 'cookies.json' || name.endsWith('/cookies.json')) {
            const content = tarBuf.slice(offset, offset + size).toString('utf8');
            console.log(`🍪 Found cookies.json: ${size} bytes`);
            try { return JSON.parse(content); } catch { return []; }
        }

        // Skip to next file (512-byte aligned)
        offset += Math.ceil(size / 512) * 512;
    }

    console.log('📥 cookies.json not found in tar');
    return [];
}

// ==================== EXTRACT TOKEN ====================

async function recoverActiveBrowserPage(browser, currentPage = null) {
    if (currentPage) {
        try {
            if (!currentPage.isClosed()) {
                return currentPage;
            }
        } catch {}
    }

    const pages = await browser.pages().catch(() => []);
    const alivePages = pages.filter((candidate) => {
        try {
            return !candidate.isClosed();
        } catch {
            return false;
        }
    });
    if (alivePages.length === 0) {
        throw new Error('No active browser page available after redirect');
    }

    const nonBlankPages = alivePages.filter((candidate) => {
        try {
            const url = String(candidate.url() || '');
            return url && url !== 'about:blank';
        } catch {
            return false;
        }
    });

    return nonBlankPages[nonBlankPages.length - 1] || alivePages[alivePages.length - 1];
}

async function settleBrowserPage(browser, currentPage = null, delayMs = 1200) {
    if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return recoverActiveBrowserPage(browser, currentPage);
}

function getPageUrlFast(page) {
    try {
        const targetUrl = String(page?.target?.().url?.() || '').trim();
        if (targetUrl) {
            return targetUrl;
        }
    } catch {}

    try {
        return String(page?.url?.() || '').trim();
    } catch {
        return '';
    }
}

async function readStablePageUrl(browser, currentPage = null, attempts = 5) {
    let page = currentPage;
    for (let attempt = 0; attempt < attempts; attempt++) {
        page = await settleBrowserPage(browser, page, attempt === 0 ? 1200 : 1500);
        const url = getPageUrlFast(page);
        if (url) {
            return { page, url };
        }
    }
    return { page, url: '' };
}

async function extractToken(cookies, proxy = '') {
    let session;
    try {
        session = await connectBrowserless(proxy);
        console.log(`🌐 [Postcron] Browserless proxy mode: ${session.proxySummary}`);
        let page = await session.browser.newPage();

        const params = cookies
            .filter(c => c.name && c.value && c.domain)
            .map(c => ({
                name: c.name, value: c.value, domain: c.domain,
                path: c.path || '/', secure: c.secure ?? true,
                httpOnly: c.http_only ?? c.httpOnly ?? false,
            }));

        await page.setCookie(...params);
        console.log(`🍪 Set ${params.length} cookies`);

        try {
            await page.goto(
                'https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook',
                { waitUntil: 'domcontentloaded', timeout: 30000 }
            );
        } catch (err) {
            const message = String(err?.message || err || '');
            if (!/detached/i.test(message)) {
                throw err;
            }
            page = await settleBrowserPage(session.browser, page, 2000);
        }

        let pageState = await readStablePageUrl(session.browser, page);
        page = pageState.page;

        const url1 = pageState.url;
        console.log(`📍 URL: ${url1.substring(0, 80)}`);
        const initialBarrier = classifyFacebookBarrier(url1);
        const initialAutomated = await detectFacebookAutomatedBehavior(page);
        if (initialBarrier === 'facebook_checkpoint' || initialAutomated.detected) {
            const dismissed = await tryDismissFacebookBarrier(page, 'initial');
            if (!dismissed.ok) {
                await page.close();
                return {
                    token: null,
                    reason: initialAutomated.detected ? 'facebook_automated_behavior' : initialBarrier,
                    url: dismissed.url || url1,
                    detail: initialAutomated.keyword || null,
                };
            }
        } else if (initialBarrier) {
            await page.close();
            return { token: null, reason: initialBarrier, url: url1 };
        }

        // Click Continue
        const clickResult = await page.evaluate(() => {
            for (const sel of ['div[aria-label*="ดำเนินการต่อ"]', 'div[aria-label*="Continue"]', 'button[name="__CONFIRM__"]']) {
                try {
                    const el = document.querySelector(sel);
                    if (el) { el.click(); return 'clicked:' + sel; }
                } catch { }
            }
            for (const btn of document.querySelectorAll('div[role="button"], button')) {
                if (/Continue|ดำเนินการต่อ/.test(btn.textContent)) {
                    btn.click();
                    return 'clicked:text';
                }
            }
            return 'not-found';
        }).catch(() => 'eval-error');
        console.log(`🖱️ Continue click result: ${clickResult}`);

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 2000));
        page = await settleBrowserPage(session.browser, page, 1200);

        for (let i = 0; i < 5; i++) {
            pageState = await readStablePageUrl(session.browser, page);
            page = pageState.page;
            const currentUrl = pageState.url;
            const barrier = classifyFacebookBarrier(currentUrl);
            const automated = await detectFacebookAutomatedBehavior(page);
            if (barrier === 'facebook_checkpoint' || automated.detected) {
                const dismissed = await tryDismissFacebookBarrier(page, `loop-${i + 1}`);
                if (!dismissed.ok) {
                    await page.close();
                    return {
                        token: null,
                        reason: automated.detected ? 'facebook_automated_behavior' : barrier,
                        url: dismissed.url || currentUrl,
                        detail: automated.keyword || null,
                    };
                }
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            if (barrier) {
                await page.close();
                return { token: null, reason: barrier, url: currentUrl };
            }

            const m = currentUrl.match(/access_token=([^&]+)/);
            if (m) {
                await page.close();
                return { token: decodeURIComponent(m[1]), reason: null, url: currentUrl };
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        const finalUrl = getPageUrlFast(page);
        const finalAutomated = await detectFacebookAutomatedBehavior(page);
        await page.close();
        return {
            token: null,
            reason: classifyFacebookBarrier(finalUrl) || (finalAutomated.detected ? 'facebook_automated_behavior' : 'session_expired'),
            url: finalUrl,
            detail: finalAutomated.keyword || null,
        };
    } finally {
        if (session) session.disconnect();
    }
}

async function detectFacebookAutomatedBehavior(page) {
    const result = await page.evaluate(() => {
        const text = String((document.body && document.body.innerText) || '').toLowerCase();
        const keywords = [
            'พฤติกรรมอัตโนมัติ',
            'พฤติกรรมที่ไม่ปกติ',
            'เราได้ตรวจพบกิจกรรมที่ผิดปกติ',
            'automated behavior',
            'unusual activity',
            'suspicious activity',
            'we limit how often',
        ];
        let matched = '';
        for (const k of keywords) {
            if (k && text.includes(k.toLowerCase())) {
                matched = k;
                break;
            }
        }
        return { detected: !!matched, keyword: matched };
    }).catch(() => ({ detected: false, keyword: '' }));
    return {
        detected: !!result?.detected,
        keyword: String(result?.keyword || ''),
    };
}

async function tryDismissFacebookBarrier(page, phase = 'unknown') {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const beforeUrl = getPageUrlFast(page);

        const clickResult = await page.evaluate(() => {
            const selectors = [
                'div[role="button"][aria-label="ปิด"]',
                'div[role="button"][aria-label*="ปิด"]',
                '[role="button"][aria-label="Close"]',
                '[role="button"][aria-label*="close" i]',
                'button[aria-label="ปิด"]',
                'button[aria-label="Close"]'
            ];

            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    el.click();
                    return `clicked:${sel}`;
                }
            }

            const buttons = document.querySelectorAll('div[role="button"], button, span, [aria-label]');
            for (const el of buttons) {
                const text = (el.textContent || '').trim().toLowerCase();
                const label = ((el.getAttribute && el.getAttribute('aria-label')) || '').trim().toLowerCase();
                if (text === 'ปิด' || text === 'close' || label === 'ปิด' || label === 'close') {
                    const target = (el.closest && el.closest('[role="button"],button')) || el;
                    target.click();
                    return 'clicked:text';
                }
            }
            return 'not-found';
        }).catch(() => 'eval-error');

        console.log(`🧩 Checkpoint close (${phase}) attempt ${attempt}/${maxAttempts}: ${clickResult}`);

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 1500));

        const afterUrl = getPageUrlFast(page);
        const stillCheckpoint = afterUrl.toLowerCase().includes('facebook.com/checkpoint');
        const automated = await detectFacebookAutomatedBehavior(page);
        if (!stillCheckpoint && !automated.detected) {
            console.log(`✅ Barrier dismissed (${phase}) -> ${afterUrl.substring(0, 90)}`);
            return { ok: true, url: afterUrl, note: clickResult };
        }

        if (clickResult === 'not-found' || clickResult === 'eval-error') {
            break;
        }
    }

    return { ok: false, url: getPageUrlFast(page), note: 'barrier-still-open' };
}

function classifyFacebookBarrier(url = '') {
    const u = String(url).toLowerCase();
    if (!u) return null;
    if (u.includes('facebook.com/checkpoint')) return 'facebook_checkpoint';
    if (u.includes('facebook.com/login')) return 'facebook_login_required';
    if (u.includes('facebook.com/two_factor') || u.includes('approvals_code') || u.includes('save-device')) {
        return 'facebook_security_confirmation';
    }
    return null;
}

function buildPostcronFailure(profileName, dur, extract) {
    const reason = extract?.reason || 'session_expired';
    const currentUrl = extract?.url || null;
    const detail = extract?.detail || null;

    let error = 'Session expired';
    if (reason === 'facebook_checkpoint') error = 'Facebook checkpoint required';
    if (reason === 'facebook_automated_behavior') error = 'Facebook automated behavior warning';
    if (reason === 'facebook_login_required') error = 'Facebook login required';
    if (reason === 'facebook_security_confirmation') error = 'Facebook security confirmation required';

    return {
        error,
        reason,
        detail,
        profile: profileName,
        current_url: currentUrl,
        action_required: reason === 'facebook_automated_behavior'
            ? 'Open browser for this profile, clear Facebook automated-behavior warning, click Stop to sync cookies, then retry Postcron.'
            : 'Open browser for this profile, complete Facebook login/checkpoint, then click Stop to sync cookies and retry Postcron.',
        hint_th: reason === 'facebook_automated_behavior'
            ? 'เปิดเบราเซอร์ของโปรไฟล์นี้ -> ปิด/ยืนยันหน้าเตือนพฤติกรรมอัตโนมัติของ Facebook -> กด Stop เพื่อซิงก์คุกกี้ -> แล้วค่อยกด Postcron ใหม่'
            : 'เปิดเบราเซอร์ของโปรไฟล์นี้ -> ผ่านหน้า Login/Checkpoint ของ Facebook ให้เสร็จ -> กด Stop เพื่อซิงก์คุกกี้ -> แล้วค่อยกด Postcron ใหม่',
        duration: dur + 's'
    };
}

// ==================== SHOPEE AFFILIATE ====================

async function handleShopeeAffiliate(req, res, urlObj) {
    const t0 = Date.now();
    
    try {
        // Get parameters from query string
        const productUrl = urlObj.searchParams.get('url');
        const profileId = urlObj.searchParams.get('profileId');
        const subId1 = urlObj.searchParams.get('subId1') || '';
        
        if (!productUrl) {
            return json(res, 400, { error: 'Missing required param: url' });
        }
        
        if (!profileId) {
            return json(res, 400, { error: 'Missing required param: profileId' });
        }
        
        // Get cookies from archive
        console.log(`📦 [Shopee Affiliate] Extracting cookies from archive for: ${profileId}`);
        const archiveCookies = await downloadCookies(profileId, req);
        const shopeeCookies = archiveCookies.filter(c => 
            c.domain?.includes('shopee.co.th') || 
            c.domain?.includes('affiliate.shopee.co.th')
        );
        
        if (shopeeCookies.length === 0) {
            return json(res, 400, { 
                error: 'No Shopee cookies found. Login to affiliate.shopee.co.th in browser first, then Stop.' 
            });
        }
        
        console.log(`🍪 [Shopee Affiliate] Found ${shopeeCookies.length} Shopee cookies`);
        
        // Use Puppeteer to generate affiliate link
        const result = await extractShopeeAffiliateLink(productUrl, subId1, shopeeCookies);
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        
        if (!result) {
            return json(res, 400, {
                success: false,
                error: 'Failed to generate affiliate link. Please check if you are logged in to Shopee Affiliate.',
                originalUrl: productUrl,
                duration: dur + 's'
            });
        }
        
        return json(res, 200, {
            success: true,
            originalUrl: productUrl,
            result: result,
            duration: dur + 's'
        });
        
    } catch (err) {
        console.error(`❌ [Shopee Affiliate] Error:`, err);
        return json(res, 500, { error: err.message });
    }
}

async function extractShopeeAffiliateLink(productUrl, subId1, cookies) {
    const wsUrl = `${BROWSERLESS_WS}/?token=${BROWSERLESS_TOKEN}&--window-size=1280,800`;
    let browser;
    let debugInfo = {};
    
    try {
        browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
        const page = await browser.newPage();
        
        // Set viewport for screenshot
        await page.setViewport({ width: 1280, height: 800 });
        
        // Set user agent to look like real Chrome
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        
        // Override navigator.webdriver to undefined (hide automation)
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
        });
        
        // Set cookies
        const cookieParams = cookies
            .filter(c => c.name && c.value && c.domain)
            .map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                secure: c.secure ?? true,
                httpOnly: c.http_only ?? c.httpOnly ?? false,
            }));
        
        await page.setCookie(...cookieParams);
        console.log(`🍪 Set ${cookieParams.length} cookies`);
        
        // Navigate to Shopee Affiliate custom link page
        await page.goto('https://affiliate.shopee.co.th/offer/custom_link', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        console.log(`📍 Navigated to Shopee Affiliate`);
        
        // Wait for page to fully load
        await new Promise(r => setTimeout(r, 3000));
        
        // Take screenshot for debugging
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        debugInfo.screenshot = screenshot;
        
        // Get page HTML for debugging
        const html = await page.content();
        debugInfo.html = html.substring(0, 5000);
        
        // Check if logged in (look for login button or user menu)
        const pageTitle = await page.title();
        debugInfo.title = pageTitle;
        debugInfo.url = page.url();
        
        // Wait for the textarea to be available (use more specific selector)
        try {
            await page.waitForSelector('#customLink_original_url textarea, textarea.ant-input', { timeout: 15000 });
        } catch (e) {
            // If selector not found, return debug info
            throw new Error(`Element not found. Debug: title=${pageTitle}, url=${debugInfo.url}, html_preview=${html.substring(0, 1000)}`);
        }
        
        // Step 1: Enter product URL in textarea
        await page.evaluate((url) => {
            const textarea = document.querySelector('#customLink_original_url textarea') || document.querySelector('textarea.ant-input');
            if (textarea) {
                textarea.focus();
                textarea.value = url;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
                textarea.blur();
            }
        }, productUrl);
        
        console.log(`📝 Entered product URL`);
        
        // Step 2: Enter subId1 if provided
        if (subId1) {
            await page.waitForSelector('#customLink_sub_id1', { timeout: 5000 });
            await page.type('#customLink_sub_id1', subId1);
            console.log(`🏷️ Entered subId1: ${subId1}`);
        }
        
        // Step 3: Click the "เอา ลิงก์" button
        await page.click('button.ant-btn-primary span');
        console.log(`🖱️ Clicked "เอา ลิงก์" button`);
        
        // Wait for API response
        await page.waitForResponse(
            response => response.url().includes('batchCustomLink'),
            { timeout: 15000 }
        );
        
        // Wait a bit for UI to update
        await new Promise(r => setTimeout(r, 2000));
        
        // Extract the result from the page
        const result = await page.evaluate(() => {
            // Look for the generated link in the UI
            const linkElements = document.querySelectorAll('a[href*="s.shopee.co.th"]');
            if (linkElements.length > 0) {
                return {
                    shortLink: linkElements[0].href,
                    source: 'ui'
                };
            }
            
            // Or look for input with the link
            const inputs = document.querySelectorAll('input[value*="s.shopee.co.th"]');
            if (inputs.length > 0) {
                return {
                    shortLink: inputs[0].value,
                    source: 'input'
                };
            }
            
            return null;
        });
        
        await page.close();
        
        if (result) {
            console.log(`✅ Generated link: ${result.shortLink}`);
        }
        
        return result;
        
    } finally {
        if (browser) {
            try { browser.disconnect(); } catch {}
        }
    }
}

async function handleFacebookComment(req, res) {
    const t0 = Date.now();
    
    try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        const { profileId, postUrl, message, pageName } = data;
        
        if (!profileId || !postUrl || !message) {
            return json(res, 400, { 
                error: 'Missing required fields: profileId, postUrl, message' 
            });
        }
        
        // Get profile info
        const { resp: profilesResp, data: profilesData } = await fetchWorkerJson(req, '/api/profiles');
        const profiles = extractProfilesList(profilesData);
        if (!profilesResp.ok || !profiles) {
            return json(res, profilesResp.status || 502, {
                error: 'Failed to load profiles from BrowserSaving worker',
                details: getProfilesLoadErrorDetails(profilesData, profilesResp),
            });
        }
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) return json(res, 404, { error: 'Profile not found' });

        // Download cookies
        const cookies = await downloadCookies(profileId, req);
        const fbCount = cookies.filter(c => c.domain?.includes('facebook.com')).length;
        
        if (fbCount === 0) {
            return json(res, 400, { 
                error: 'No Facebook cookies', 
                profile: profile.name 
            });
        }
        
        console.log(`💬 [${profile.name}] Commenting on: ${postUrl}${pageName ? ` as page "${pageName}"` : ''}`);
        
        // Post comment (with optional page switch)
        const result = await postFacebookComment(cookies, postUrl, message, pageName);
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        
        if (result.success) {
            console.log(`✅ [${profile.name}] Comment posted: ${dur}s`);
            return json(res, 200, {
                success: true,
                profile: profile.name,
                postUrl: postUrl,
                comment: message,
                pageName: pageName || null,
                commentId: result.commentId,
                duration: dur + 's'
            });
        } else {
            return json(res, 400, {
                success: false,
                profile: profile.name,
                pageName: pageName || null,
                error: result.error,
                duration: dur + 's'
            });
        }
        
    } catch (err) {
        console.error(`❌ [Facebook Comment] Error:`, err);
        return json(res, 500, { 
            error: err.message,
            stage: 'top-level-catch'
        });
    }
}

async function postFacebookComment(cookies, postUrl, message, pageName = null) {
    const wsUrl = `${BROWSERLESS_WS}/?token=${BROWSERLESS_TOKEN}&--window-size=1280,800`;
    let browser;
    
    try {
        browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
        const page = await browser.newPage();
        
        // Set viewport
        await page.setViewport({ width: 1280, height: 800 });
        
        // Set cookies
        const cookieParams = cookies
            .filter(c => c.name && c.value && c.domain)
            .map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                secure: c.secure ?? true,
                httpOnly: c.http_only ?? c.httpOnly ?? false,
            }));
        
        await page.setCookie(...cookieParams);
        console.log(`🍪 Set ${cookieParams.length} cookies`);
        
        // Navigate to post
        await page.goto(postUrl, { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
        });
        
        console.log(`📍 Loaded: ${page.url()}`);
        
        // Wait for page to load
        await new Promise(r => setTimeout(r, 3000));
        
        // Check if redirected to login
        const currentUrl = page.url();
        if (currentUrl.includes('facebook.com/login')) {
            return { success: false, error: 'Session expired, redirected to login' };
        }
        
        // Try GraphQL method first (faster)
        console.log(`🔄 Trying GraphQL method...`);
        const graphqlResult = await postCommentGraphQL(page, message, pageName);
        
        if (graphqlResult.success) {
            await page.close();
            return graphqlResult;
        }
        
        console.log(`⚠️ GraphQL failed: ${graphqlResult.error}, falling back to Puppeteer`);
        
        // Fallback: Use Puppeteer automation
        if (pageName) {
            const switched = await switchToPage(page, pageName);
            if (!switched.success) {
                return { success: false, error: `Failed to switch to page: ${switched.error}` };
            }
            console.log(`🔄 Switched to page: ${pageName}`);
        }
        
        // Try to find and click comment box
        const commentBoxClicked = await page.evaluate(() => {
            const selectors = [
                'div[role="textbox"]',
                'div[contenteditable="true"]',
                '[aria-label*="Comment"]',
                '[aria-label*="แสดงความคิดเห็น"]',
                '[placeholder*="comment"]',
                '[placeholder*="ความคิดเห็น"]'
            ];
            
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    el.click();
                    el.focus();
                    return true;
                }
            }
            return false;
        });
        
        if (!commentBoxClicked) {
            return { success: false, error: 'Could not find comment box' };
        }
        
        console.log(`📝 Clicked comment box`);
        await new Promise(r => setTimeout(r, 1000));
        
        // Type the message
        await page.keyboard.type(message, { delay: 50 });
        console.log(`⌨️ Typed message: ${message.substring(0, 30)}...`);
        
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');
        console.log(`⏎ Pressed Enter`);
        
        await new Promise(r => setTimeout(r, 3000));
        
        await page.close();
        return { success: true, method: 'puppeteer' };
        
    } catch (err) {
        console.error(`❌ [postFacebookComment] Error:`, err);
        return { success: false, error: err.message };
    } finally {
        if (browser) {
            try { browser.disconnect(); } catch {}
        }
    }
}

async function postCommentGraphQL(page, message, pageName = null) {
    try {
        // Extract fb_dtsg token
        const fbDtsg = await page.evaluate(() => {
            // Method 1: From hidden input
            const input = document.querySelector('input[name="fb_dtsg"]');
            if (input) return input.value;
            
            // Method 2: From script tags
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent || '';
                const match = text.match(/"fb_dtsg":"([^"]+)"/);
                if (match) return match[1];
            }
            
            // Method 3: From data attributes
            const body = document.querySelector('body');
            if (body && body.dataset.fbDtsg) return body.dataset.fbDtsg;
            
            return null;
        });
        
        if (!fbDtsg) {
            return { success: false, error: 'Could not extract fb_dtsg token' };
        }
        console.log(`🔑 Got fb_dtsg: ${fbDtsg.substring(0, 20)}...`);
        
        // Extract feedback_id from the page
        const feedbackData = await page.evaluate(() => {
            // Method 1: From script tags (feedback ID is usually in the initial data)
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent || '';
                // Look for feedback_id or target_id patterns
                const feedbackMatch = text.match(/"feedback_id":"([^"]+)"/);
                if (feedbackMatch) return { feedbackId: feedbackMatch[1] };
                
                // Alternative patterns
                const targetMatch = text.match(/"target_id":"(\d+)"/);
                if (targetMatch) return { targetId: targetMatch[1] };
                
                // Story/Post ID patterns
                const storyMatch = text.match(/"story_id":"(\d+)"/);
                if (storyMatch) return { storyId: storyMatch[1] };
            }
            
            // Method 2: From URL patterns in links
            const links = document.querySelectorAll('a[href*="/story.php"], a[href*="/posts/"]');
            for (const link of links) {
                const href = link.getAttribute('href') || '';
                const storyMatch = href.match(/story_fbid[=:](\d+)/);
                if (storyMatch) return { storyId: storyMatch[1] };
            }
            
            // Method 3: From data attributes on elements
            const feedbackEl = document.querySelector('[data-feedback-id]');
            if (feedbackEl) {
                return { feedbackId: feedbackEl.dataset.feedbackId };
            }
            
            return null;
        });
        
        if (!feedbackData) {
            return { success: false, error: 'Could not extract feedback_id' };
        }
        console.log(`📋 Feedback data:`, feedbackData);
        
        // Build feedback_target from available data
        let feedbackTarget = feedbackData.feedbackId;
        if (!feedbackTarget && feedbackData.storyId) {
            // Construct feedback ID from story ID (format: feedback_id = story_id + some prefix)
            feedbackTarget = feedbackData.storyId;
        }
        
        if (!feedbackTarget) {
            return { success: false, error: 'No valid feedback target found' };
        }
        
        // Get actor_id (the page/profile to comment as)
        let actorId = null;
        if (pageName) {
            // Try to find the page ID from the page switcher
            actorId = await page.evaluate((targetPage) => {
                // Look for page in the document
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    const text = script.textContent || '';
                    // Look for page ID patterns
                    const pageMatch = text.match(new RegExp(`"${targetPage}".*"id":"(\d+)"`, 'i'));
                    if (pageMatch) return pageMatch[1];
                }
                return null;
            }, pageName);
        }
        
        // GraphQL mutation for commenting
        // This is the internal mutation used by Facebook
        const variables = {
            input: {
                client_mutation_id: Math.random().toString(36).substring(2),
                actor_id: actorId || undefined,  // If specified, comment as this page
                feedback_text: message,
                feedback_referrer: 'reels_tab',
                is_tracking_encrypted: true,
                tracking: [],
                feedback_target: feedbackTarget,
                idempotence_token: `reels_tab:${feedbackTarget}:${Date.now()}`,
                source: 'www_reels_tab'
            },
            useDefaultActor: !actorId,  // Use default if no specific actor
            scale: 1
        };
        
        // Common GraphQL doc IDs for comment mutation (these may change)
        // CometUFICreateCommentMutation is commonly used
        const docId = '7182792398477815'; // This is an example, may need updating
        
        const formData = new URLSearchParams();
        formData.append('fb_dtsg', fbDtsg);
        formData.append('variables', JSON.stringify(variables));
        formData.append('doc_id', docId);
        
        // Get cookies for the request
        const cookies = await page.cookies();
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        // Send GraphQL request
        const response = await page.evaluate(async (formDataStr, cookieStr, docId) => {
            const formData = new URLSearchParams(formDataStr);
            formData.set('doc_id', docId);
            
            try {
                const res = await fetch('https://www.facebook.com/api/graphql/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Cookie': cookieStr,
                        'Accept': '*/*',
                        'Origin': 'https://www.facebook.com',
                        'Referer': window.location.href
                    },
                    body: formData.toString(),
                    credentials: 'include'
                });
                
                const text = await res.text();
                return { status: res.status, text: text.substring(0, 2000) };
            } catch (e) {
                return { error: e.message };
            }
        }, formData.toString(), cookieString, docId);
        
        console.log(`📡 GraphQL response:`, response);
        
        if (response.error) {
            return { success: false, error: response.error };
        }
        
        // Check if successful
        if (response.text && (response.text.includes('errors') || response.text.includes('error'))) {
            // Try alternative doc_id
            console.log(`⚠️ First doc_id failed, trying alternative...`);
            return { success: false, error: `GraphQL error: ${response.text.substring(0, 200)}` };
        }
        
        if (response.status === 200) {
            return { success: true, method: 'graphql' };
        }
        
        return { success: false, error: `HTTP ${response.status}` };
        
    } catch (err) {
        console.error(`❌ [GraphQL] Error:`, err);
        return { success: false, error: err.message };
    }
}

async function switchToPage(page, pageName) {
    try {
        // Method 1: Try clicking on profile picture near comment box to open switcher
        const profileClicked = await page.evaluate(() => {
            // Look for profile avatar near comment input
            const selectors = [
                'img[src*="profile"]',  // Profile image
                'div[data-pagelet="Reels"] img', // Reel profile image
                '[role="main"] img[alt*="profile"]', // Main content profile
                'div[role="article"] img', // Article/Post profile image
            ];
            
            for (const sel of selectors) {
                const imgs = document.querySelectorAll(sel);
                for (const img of imgs) {
                    // Check if this image is near a comment area
                    const rect = img.getBoundingClientRect();
                    // Look for comment input nearby
                    const inputs = document.querySelectorAll('div[role="textbox"], div[contenteditable="true"]');
                    for (const input of inputs) {
                        const inputRect = input.getBoundingClientRect();
                        // Check if image is close to comment input (within 200px)
                        const distance = Math.abs(rect.left - inputRect.left) + Math.abs(rect.top - inputRect.top);
                        if (distance < 200) {
                            img.click();
                            return true;
                        }
                    }
                }
            }
            return false;
        });
        
        if (profileClicked) {
            console.log(`🖱️ Clicked profile avatar, waiting for switcher...`);
            await new Promise(r => setTimeout(r, 2000));
            
            // Look for the page in the switcher menu
            const pageSelected = await page.evaluate((targetPage) => {
                // Look for page name in the dropdown/menu
                const elements = document.querySelectorAll('div, span, a');
                for (const el of elements) {
                    if (el.textContent && el.textContent.includes(targetPage)) {
                        el.click();
                        return true;
                    }
                }
                return false;
            }, pageName);
            
            if (pageSelected) {
                await new Promise(r => setTimeout(r, 2000));
                return { success: true };
            }
        }
        
        // Method 2: Try looking for switch page button/link
        const switchButtonClicked = await page.evaluate(() => {
            const keywords = ['สลับ', 'Switch', 'ใช้เพจ', 'Use Page', 'โพสต์ในฐานะ', 'Post as'];
            const elements = document.querySelectorAll('div, span, button, a');
            
            for (const el of elements) {
                const text = el.textContent || '';
                for (const kw of keywords) {
                    if (text.includes(kw)) {
                        el.click();
                        return true;
                    }
                }
            }
            return false;
        });
        
        if (switchButtonClicked) {
            console.log(`🖱️ Clicked switch button, waiting for menu...`);
            await new Promise(r => setTimeout(r, 2000));
            
            // Select the page
            const pageSelected = await page.evaluate((targetPage) => {
                const elements = document.querySelectorAll('div, span, a');
                for (const el of elements) {
                    if (el.textContent && el.textContent.includes(targetPage)) {
                        el.click();
                        return true;
                    }
                }
                return false;
            }, pageName);
            
            if (pageSelected) {
                await new Promise(r => setTimeout(r, 2000));
                return { success: true };
            }
        }
        
        return { success: false, error: `Could not find page "${pageName}" in switcher` };
        
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

server.listen(PORT, () => {
    console.log(`🚀 Port ${PORT} | Browserless: ${BROWSERLESS_WS} | Worker: ${WORKER_URL}`);
});
