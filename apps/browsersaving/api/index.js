// BrowserSaving API - Postcron Token Extraction
import http from 'http';
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
const WORKER_URL = process.env.WORKER_URL || 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev';
const COMMENT_TOKEN_API_URL = process.env.COMMENT_TOKEN_API_URL || 'https://comment-token-api.lslly.com/api/comment-token';

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/' || url.pathname === '/health') {
        return json(res, 200, { status: 'ok', service: 'browsersaving-api', version: 5 });
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

function json(res, status, data) {
    res.writeHead(status);
    res.end(JSON.stringify(data, null, 2));
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

        const extract = await extractToken(cookies);
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

import { spawn } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

async function extractToken(cookies) {
    const wsUrl = `${BROWSERLESS_WS}/?token=${BROWSERLESS_TOKEN}`;
    let browser;
    try {
        browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
        const page = await browser.newPage();

        const params = cookies
            .filter(c => c.name && c.value && c.domain)
            .map(c => ({
                name: c.name, value: c.value, domain: c.domain,
                path: c.path || '/', secure: c.secure ?? true,
                httpOnly: c.http_only ?? c.httpOnly ?? false,
            }));

        await page.setCookie(...params);
        console.log(`🍪 Set ${params.length} cookies`);

        await page.goto(
            'https://postcron.com/api/v2.0/social-accounts/url-redirect/?should_redirect=true&social_network=facebook',
            { waitUntil: 'networkidle2', timeout: 15000 }
        );

        const url1 = page.url();
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

        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 2000));

        for (let i = 0; i < 5; i++) {
            const currentUrl = page.url();
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

        const finalUrl = page.url();
        const finalAutomated = await detectFacebookAutomatedBehavior(page);
        await page.close();
        return {
            token: null,
            reason: classifyFacebookBarrier(finalUrl) || (finalAutomated.detected ? 'facebook_automated_behavior' : 'session_expired'),
            url: finalUrl,
            detail: finalAutomated.keyword || null,
        };
    } finally {
        if (browser) try { browser.disconnect(); } catch { }
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
        const beforeUrl = page.url();

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

        const afterUrl = page.url();
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

    return { ok: false, url: page.url(), note: 'barrier-still-open' };
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
