const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');

// Single instance - prevent duplicate
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.on('second-instance', () => {
    // Someone tried to open a second instance - show first account window
    if (shopeeWindows.size > 0) {
        const first = shopeeWindows.values().next().value;
        if (first && !first.isDestroyed()) { first.show(); first.maximize(); first.focus(); }
    }
});

// Auto-start on login
app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe') });

const GQL_ENDPOINT = 'https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink';
const SHOPEE_URL = 'https://affiliate.shopee.co.th';

// --- Config ---
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');
let config = { workerUrl: '', autoAgent: false, accounts: ['default'] };
try { Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8'))); } catch {}

// account name -> BrowserWindow
const shopeeWindows = new Map();
let tray = null;
let logWindow = null;
let agentRunning = false;

// Captcha health check status per account
// { account: { status: 'ok'|'solved'|'failed'|'error', time: Date, detail: string } }
const captchaStatus = new Map();

// === Logging ===

function log(msg, cls, account) {
    const entry = { msg, cls: cls || 'info', account: account || '' };
    console.log(`${account ? '[' + account + '] ' : ''}${msg}`);
    if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('log-entry', entry);
    }
}

function createLogWindow() {
    if (logWindow && !logWindow.isDestroyed()) {
        logWindow.show();
        logWindow.focus();
        return;
    }
    logWindow = new BrowserWindow({
        width: 700, height: 500,
        title: 'Shortlink Logs',
        webPreferences: {
            preload: path.join(__dirname, 'logs-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    logWindow.loadFile('logs.html');
    logWindow.on('close', (e) => {
        if (!app.isQuitting) { e.preventDefault(); logWindow.hide(); }
    });

    // Send agent status
    logWindow.webContents.once('did-finish-load', () => {
        logWindow.webContents.send('agent-status', agentRunning);
    });
}

// === Shopee Windows (one per account, separate session) ===

function createShopeeWindow(account, show = true) {
    if (shopeeWindows.has(account)) {
        const existing = shopeeWindows.get(account);
        if (!existing.isDestroyed()) {
            if (show) { existing.show(); existing.maximize(); existing.focus(); }
            return existing;
        }
    }

    const ses = session.fromPartition(`persist:${account}`);
    const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            session: ses,
        },
        title: `Shopee - ${account}`,
    });
    if (show) win.maximize();

    win.loadURL(SHOPEE_URL);
    win.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            win.hide();
        }
    });

    shopeeWindows.set(account, win);
    return win;
}

function getShopeeWindow(account) {
    const win = shopeeWindows.get(account);
    if (win && !win.isDestroyed()) return win;
    return createShopeeWindow(account, false);
}

// === Tray ===

function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip('Shopee Shortlink');
    tray.on('double-click', () => {
        if (config.accounts.length > 0) {
            createShopeeWindow(config.accounts[0], true);
        }
    });
    updateTrayMenu();
}

function getCaptchaStatusEmoji(status) {
    if (!status) return '⏳';
    switch (status.status) {
        case 'ok': return '✅';
        case 'solved': return '🔧';
        case 'failed': return '❌';
        case 'error': return '⚠️';
        default: return '⏳';
    }
}

function getCaptchaStatusText(status) {
    if (!status) return 'ยังไม่ได้เช็ค';
    const timeStr = status.time.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    switch (status.status) {
        case 'ok': return `ผ่าน (${timeStr})`;
        case 'solved': return `แก้ captcha สำเร็จ (${timeStr})`;
        case 'failed': return `แก้ captcha ไม่ได้! (${timeStr})`;
        case 'error': return `เช็คไม่ได้: ${status.detail} (${timeStr})`;
        default: return `ไม่ทราบ (${timeStr})`;
    }
}

function updateTrayTooltip() {
    if (!tray) return;
    tray.setToolTip('Shopee Shortlink');
}

function updateTrayMenu() {
    const contextMenu = Menu.buildFromTemplate(
        config.accounts.map((acc) => ({
            label: acc,
            click: () => createShopeeWindow(acc, true),
        })),
    );

    tray.setContextMenu(contextMenu);
    updateTrayTooltip();
}

// === App lifecycle ===

app.whenReady().then(() => {
    createTray();
    // Create all Shopee windows (hidden) to keep sessions alive
    for (const acc of config.accounts) {
        createShopeeWindow(acc, false);
    }
    if (config.autoAgent && config.workerUrl) startAgent();
});

app.on('before-quit', () => {
    app.isQuitting = true;
    agentRunning = false;
    if (ws) { ws.close(); ws = null; }
});

app.on('window-all-closed', () => {
    // Don't quit - keep running in tray
});

// === IPC ===

ipcMain.handle('shorten', async (_e, payload) => handleShorten(payload));
ipcMain.handle('get-config', () => config);

ipcMain.handle('save-config', (_e, newConfig) => {
    Object.assign(config, newConfig);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    updateTrayMenu();
    return config;
});

ipcMain.handle('start-agent', () => { if (!agentRunning) startAgent(); });
ipcMain.handle('stop-agent', () => { agentRunning = false; });

// === Core: Shorten via Shopee page ===

async function handleShorten(payload) {
    const { productUrl, account, subId1, subId2, subId3, subId4, subId5 } = payload || {};
    if (!productUrl) throw new Error('ใส่ลิงก์สินค้าก่อน');

    const accName = account || config.accounts[0] || 'default';
    const win = getShopeeWindow(accName);

    // Wait for page to load if needed
    if (win.webContents.isLoading()) {
        await new Promise(r => win.webContents.once('did-finish-load', r));
    }

    const advancedLinkParams = {};
    if (subId1) advancedLinkParams.subId1 = subId1;
    if (subId2) advancedLinkParams.subId2 = subId2;
    if (subId3) advancedLinkParams.subId3 = subId3;
    if (subId4) advancedLinkParams.subId4 = subId4;
    if (subId5) advancedLinkParams.subId5 = subId5;

    const gqlBody = {
        operationName: 'batchGetCustomLink',
        query: `query batchGetCustomLink($linkParams: [CustomLinkParam!], $sourceCaller: SourceCaller){
            batchCustomLink(linkParams: $linkParams, sourceCaller: $sourceCaller){
                shortLink longLink failCode
            }
        }`,
        variables: {
            linkParams: [{ originalLink: productUrl, advancedLinkParams }],
            sourceCaller: 'CUSTOM_LINK_CALLER',
        },
    };

    const code = `
    (function() {
        const endpoint = ${JSON.stringify(GQL_ENDPOINT)};
        const bodyStr = ${JSON.stringify(JSON.stringify(gqlBody))};
        return new Promise(function(resolve) {
            try {
                var csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
                var csrfToken = csrfMatch ? csrfMatch[1] : '';
                var xhr = new XMLHttpRequest();
                xhr.open('POST', endpoint, true);
                xhr.withCredentials = true;
                xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
                xhr.setRequestHeader('affiliate-program-type', '1');
                if (csrfToken) xhr.setRequestHeader('csrf-token', csrfToken);
                xhr.onload = function() {
                    try {
                        if (xhr.status !== 200) { resolve({ ok: false, error: 'Shopee API ' + xhr.status }); return; }
                        var data = JSON.parse(xhr.responseText);
                        var links = data && data.data && data.data.batchCustomLink;
                        if (!links || !links.length) { resolve({ ok: false, error: 'Shopee ไม่ส่งผลลัพธ์กลับมา' }); return; }
                        var link = links[0];
                        if (link.failCode && link.failCode !== 0) { resolve({ ok: false, error: 'Shopee error code: ' + link.failCode }); return; }
                        if (!link.shortLink) { resolve({ ok: false, error: 'ไม่ได้ short link กลับมา' }); return; }
                        resolve({ ok: true, shortLink: link.shortLink, longLink: link.longLink || '' });
                    } catch (err) { resolve({ ok: false, error: err.message }); }
                };
                xhr.onerror = function() { resolve({ ok: false, error: 'เชื่อมต่อ Shopee API ไม่ได้' }); };
                xhr.ontimeout = function() { resolve({ ok: false, error: 'Shopee API timeout' }); };
                xhr.timeout = 15000;
                xhr.send(bodyStr);
            } catch (err) { resolve({ ok: false, error: err.message }); }
        });
    })()`;

    const result = await win.webContents.executeJavaScript(code);
    if (!result || !result.ok) throw new Error(result?.error || 'ย่อลิงก์ไม่สำเร็จ');

    // Follow redirect to extract utm_source
    let redirectLink = null;
    let utmSource = null;
    try {
        const resp = await fetch(result.shortLink, { redirect: 'manual' });
        let location = resp.headers.get('location') || '';
        if (location && !location.includes('utm_source')) {
            try { const r2 = await fetch(location, { redirect: 'manual' }); const l2 = r2.headers.get('location'); if (l2) location = l2; } catch {}
        }
        if (location) {
            const parsed = new URL(location);
            utmSource = parsed.searchParams.get('utm_source') || null;
            redirectLink = location;
        }
    } catch {}

    return { shortLink: result.shortLink, longLink: result.longLink || '', redirectLink, utmSource };
}

// === Captcha Solver (OmoCaptcha API + PointerEvent) ===

const OMO_KEY = 'OMO_7BDGC56EKB8NTPSR5JZL8OLIFYAHVN9GEP1KBKBRKX7PKD60ACGNTYI17UDJPC1773815218';
const OMO_CREATE = 'https://api.omocaptcha.com/v2/createTask';
const OMO_RESULT = 'https://api.omocaptcha.com/v2/getTaskResult';
const MAX_CAPTCHA_ATTEMPTS = 10;

function dlog(msg) {
    log(msg, 'captcha');
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'captcha_debug.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}

async function hasCaptchaOnPage(win) {
    return win.webContents.executeJavaScript(`
        !!document.querySelector('#NEW_CAPTCHA') ||
        !!document.querySelector('#captchaMask') ||
        !!document.querySelector('aside[aria-modal=true]') ||
        !!document.querySelector('#sliderContainer') ||
        document.body.innerText.includes('ยืนยันตัวตน')
    `);
}

async function checkAndSolveCaptcha(win) {
    if (!win || win.isDestroyed()) return false;

    try {
        // ต้อง show window เพื่อให้ sendInputEvent ทำงาน
        const wasVisible = win.isVisible();
        if (!wasVisible) { win.show(); win.maximize(); }
        await sleep(1500);

        let lastVal = null;

        for (let attempt = 0; attempt < MAX_CAPTCHA_ATTEMPTS; attempt++) {
            log(`--- Attempt ${attempt + 1} ---`, 'captcha');

            if (!(await hasCaptchaOnPage(win))) {
                log('Captcha solved!', 'ok'); dlog('*** CAPTCHA SOLVED! ***');
                if (!wasVisible) win.hide();
                return true;
            }

            // 1. ดึงรูปจาก DOM (ง่ายๆ ไม่ต้องลาก 10px ก่อน)
            const captchaData = await win.webContents.executeJavaScript(`
            (function() {
                var container = document.querySelector('aside[aria-modal=true]') ||
                    document.querySelector('#NEW_CAPTCHA') || document.querySelector('#captchaMask');
                if (!container) return null;
                var imgs = [];
                container.querySelectorAll('img').forEach(function(img) {
                    if (!img.src || !img.src.includes('base64,')) return;
                    var r = img.getBoundingClientRect();
                    if (r.width < 20 || r.height < 20) return;
                    // แปลงเป็น JPEG เสมอ (OmoCaptcha ไม่รองรับ PNG)
                    var canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || r.width;
                    canvas.height = img.naturalHeight || r.height;
                    var ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0);
                    var jpegB64 = canvas.toDataURL('image/jpeg', 0.85).split('base64,')[1];
                    imgs.push({ b64: jpegB64, w: r.width, h: r.height, area: r.width*r.height, draggable: img.draggable });
                });
                imgs.sort(function(a, b) { return b.area - a.area; });

                // หา slider button
                var btn = null;
                var allDivs = container.querySelectorAll('div');
                var bgR = imgs.length ? null : null;
                if (imgs.length) {
                    var bgImgEl = null, maxA = 0;
                    container.querySelectorAll('img').forEach(function(img) { var r = img.getBoundingClientRect(); if (r.width*r.height > maxA) { maxA=r.width*r.height; bgImgEl=img; } });
                    bgR = bgImgEl ? bgImgEl.getBoundingClientRect() : null;
                }
                for (var d of allDivs) {
                    var r = d.getBoundingClientRect();
                    if (r.width >= 28 && r.width <= 60 && r.height >= 28 && r.height <= 60) {
                        if (bgR && r.y > bgR.y + bgR.height * 0.5) {
                            if (!btn || r.x < btn.getBoundingClientRect().x) btn = d;
                        }
                    }
                }
                var btnR = btn ? btn.getBoundingClientRect() : null;
                return {
                    imgs: imgs,
                    bgW: imgs.length ? Math.round(imgs[0].w) : 280,
                    btnX: btnR ? Math.round(btnR.x + btnR.width/2) : null,
                    btnY: btnR ? Math.round(btnR.y + btnR.height/2) : null,
                };
            })()`);

            if (!captchaData || !captchaData.imgs.length) {
                dlog('No captcha images found');
                await sleep(2000); continue;
            }
            const puzzleB64 = captchaData.imgs[0].b64;
            const pieceB64 = captchaData.imgs.length >= 2 ? captchaData.imgs[1].b64 : puzzleB64;
            dlog(`imgs: ${captchaData.imgs.length} bgW=${captchaData.bgW} btn=(${captchaData.btnX},${captchaData.btnY}) puzzle_b64_len=${puzzleB64.length} piece_b64_len=${pieceB64.length} img0: ${captchaData.imgs[0].w}x${captchaData.imgs[0].h} draggable=${captchaData.imgs[0].draggable} ${captchaData.imgs.length >= 2 ? 'img1: '+captchaData.imgs[1].w+'x'+captchaData.imgs[1].h+' draggable='+captchaData.imgs[1].draggable : ''}`);
            // Save รูปเพื่อ debug
            try {
                fs.writeFileSync('C:\\shortlink\\dom_bg.txt', puzzleB64.substring(0, 100));
                fs.writeFileSync('C:\\shortlink\\dom_puzzle.b64', puzzleB64);
                fs.writeFileSync('C:\\shortlink\\dom_piece.b64', pieceB64);
            } catch {}

            // 2. ส่งรูปให้ OmoCaptcha API (Shopee เฉพาะ)
            let slideX = null;
            try {
                // ลองทั้ง 2 type: ปกติ + rotate
                for (const taskType of [null, 'rotate']) {
                    const taskBody = {
                        type: 'ShopeeSliderWebTask',
                        imageBase64s: [pieceB64, puzzleB64],
                    };
                    if (taskType) taskBody.typeCaptcha = taskType;
                    dlog(`OmoCaptcha createTask (${taskType || 'normal'})...`);

                    const createResp = await fetch(OMO_CREATE, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ clientKey: OMO_KEY, task: taskBody }),
                    });
                    const createData = await createResp.json();
                    dlog(`createTask: ${JSON.stringify(createData)}`);

                    if (createData.errorId === 0 && createData.taskId) {
                        for (let poll = 0; poll < 10; poll++) {
                            await sleep(2000);
                            const resultResp = await fetch(OMO_RESULT, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ clientKey: OMO_KEY, taskId: createData.taskId }),
                            });
                            const resultData = await resultResp.json();
                            dlog(`poll ${poll}: ${JSON.stringify(resultData)}`);

                            if (resultData.status === 'ready' && resultData.solution) {
                                slideX = resultData.solution.end?.x || resultData.solution.point?.x;
                                dlog(`OmoCaptcha solved! x=${slideX} type=${taskType || 'normal'}`);
                                break;
                            } else if (resultData.status === 'fail') {
                                dlog(`OmoCaptcha failed (${taskType || 'normal'})`);
                                break;
                            }
                        }
                        if (slideX !== null) break;
                    }
                }

                // Gemini fallback ถ้า OmoCaptcha fail ทั้ง 2 type
                if (slideX === null) {
                    dlog('OmoCaptcha failed all types, trying Gemini...');
                    const img = await win.webContents.capturePage();
                    const b64 = img.toJPEG(75).toString('base64');
                    const gresp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=' + GEMINI_KEY, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [
                            { inlineData: { mimeType: 'image/jpeg', data: puzzleB64 } },
                            { text: 'Slider captcha. Where is puzzle hole LEFT EDGE? Answer ONLY 0.0-1.0. Example: 0.68' },
                        ]}]}),
                    });
                    if (gresp.ok) {
                        const text = (await gresp.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
                        dlog(`Gemini fallback: "${text}"`);
                        const m = text.match(/\d+\.?\d*/);
                        const prop = m ? parseFloat(m[0]) : null;
                        if (prop !== null && prop >= 0 && prop <= 1) {
                            slideX = Math.round(prop * captchaData.bgW);
                            dlog(`Gemini slideX=${slideX}`);
                        }
                    }
                }
            } catch (e) { dlog(`API fail: ${e.message}`); }

            if (slideX === null) {
                dlog('No slideX'); await sleep(2000); continue;
            }

            // 3. OmoCaptcha ตอบ pixel X ของรูปต้นฉบับ → แปลงเป็น display pixels
            if (!captchaData.btnX) { dlog('No button'); await sleep(2000); continue; }
            const dist = slideX; // ใช้ตรงๆ เพราะ bgW=280 = natural width = display width
            dlog(`slideX=${slideX} dist=${dist}px btn=(${captchaData.btnX},${captchaData.btnY})`);

            // PointerEvent (พิสูจน์แล้วว่าลากได้จริง กับ dpr=2)
            const dragR = await win.webContents.executeJavaScript(`
            (async function() {
                function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
                var sx = ${captchaData.btnX}, sy = ${captchaData.btnY}, dist = ${dist};
                var btn = document.elementFromPoint(sx, sy);
                function fire(t, type, x, y) {
                    var o = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
                    t.dispatchEvent(new PointerEvent(type, o));
                    t.dispatchEvent(new MouseEvent(type.replace('pointer','mouse'), o));
                }
                fire(btn || document, 'pointerdown', sx, sy);
                await delay(100);
                for (var i = 1; i <= dist; i++) {
                    fire(document, 'pointermove', sx + i, sy);
                    if (i % 3 === 0) await delay(5);
                }
                fire(document, 'pointermove', sx + dist, sy);
                await delay(200);
                fire(document, 'pointerup', sx + dist, sy);
                return 'ok ' + sx + ' to ' + (sx+dist);
            })()`);
            dlog('Drag: ' + dragR);

            /* --- ข้ามส่วนเก่า (ถูกแทนที่ด้วย drag ด้านบน) --- */
            if (false) {
            const info = await win.webContents.executeJavaScript(`
            (function() {
                var log = [];

                // หา slider track (parent of button)
                var track = document.querySelector('#sliderContainer') ||
                    document.querySelector('aside[aria-modal=true] div[style*="height: 40px"]') ||
                    document.querySelector('aside[aria-modal=true] div[style*="height: 44px"]');

                // หาทุก element ใน captcha ที่อาจเป็น slider
                var container = document.querySelector('aside[aria-modal=true]') ||
                    document.querySelector('#NEW_CAPTCHA') || document.querySelector('#captchaMask');

                // หา background image ตำแหน่งจริง
                var bgImg = null;
                if (container) {
                    var imgs = container.querySelectorAll('img');
                    var maxArea = 0;
                    for (var img of imgs) {
                        var r = img.getBoundingClientRect();
                        if (r.width * r.height > maxArea) { maxArea = r.width * r.height; bgImg = img; }
                    }
                }
                var bgRect = bgImg ? bgImg.getBoundingClientRect() : null;
                log.push('bgImg: ' + (bgRect ? bgRect.x+','+bgRect.y+' '+bgRect.width+'x'+bgRect.height : 'null'));

                // หา slider button
                var btn = null;
                var btnMethod = 'none';
                // ลองหาปุ่มที่มี arrow/ลูกศร
                if (container) {
                    var allEls = container.querySelectorAll('div, button, span');
                    for (var el of allEls) {
                        var r = el.getBoundingClientRect();
                        var style = window.getComputedStyle(el);
                        // ปุ่ม slider มักเป็นสี่เหลี่ยม 30-55px และอยู่ล่างรูป
                        if (r.width >= 30 && r.width <= 55 && r.height >= 30 && r.height <= 55) {
                            if (bgRect && r.y > bgRect.y + bgRect.height - 20) {
                                if (!btn || r.x < btn.getBoundingClientRect().x) {
                                    btn = el;
                                    btnMethod = 'square-below-img';
                                }
                            }
                        }
                    }
                }

                if (!btn) return null;
                var btnRect = btn.getBoundingClientRect();
                log.push('btn: ' + btnRect.x+','+btnRect.y+' '+btnRect.width+'x'+btnRect.height + ' via:'+btnMethod);

                // หา slider track width
                var trackEl = btn.parentElement;
                var trackRect = trackEl ? trackEl.getBoundingClientRect() : null;
                log.push('track: ' + (trackRect ? trackRect.x+','+trackRect.y+' '+trackRect.width+'x'+trackRect.height : 'null'));

                return {
                    btnX: Math.round(btnRect.x + btnRect.width/2),
                    btnY: Math.round(btnRect.y + btnRect.height/2),
                    bgX: bgRect ? Math.round(bgRect.x) : 0,
                    bgW: bgRect ? Math.round(bgRect.width) : 0,
                    trackX: trackRect ? Math.round(trackRect.x) : 0,
                    trackW: trackRect ? Math.round(trackRect.width) : 0,
                    log: log.join(' | ')
                };
            })()`);

            if (!info) { log('Slider not found', 'err'); await sleep(2000); continue; }
            log(`DOM: ${info.log}`, 'captcha');

            // คำนวณ dist
            const bgW = captchaImgs[0].w;
            const dist = Math.round(proportion * bgW);
            dlog(`proportion=${proportion} bgW=${bgW} dist=${dist}px`);

            // เขียน log ลงไฟล์ด้วย
            try {
                fs.appendFileSync(path.join(app.getPath('userData'), 'captcha_debug.log'),
                    `${new Date().toISOString()} prop=${proportion} trackW=${trackW} bgW=${info.bgW} dist=${dist} btn=(${info.btnX},${info.btnY}) ${info.log}\n`);
            } catch {}

            // 3. sendInputEvent (trusted events) — PointerEvent dispatch ไม่ trusted
            const sliderInfo = await win.webContents.executeJavaScript(`
            (function() {
                var container = document.querySelector('aside[aria-modal=true]') ||
                    document.querySelector('#NEW_CAPTCHA') || document.querySelector('#captchaMask');
                if (!container) return null;
                var imgs = container.querySelectorAll('img');
                var bgImg = null, maxA = 0;
                for (var img of imgs) { var r = img.getBoundingClientRect(); if (r.width*r.height > maxA) { maxA=r.width*r.height; bgImg=img; } }
                if (!bgImg) return null;
                var bgR = bgImg.getBoundingClientRect();
                var btn = null;
                for (var el of container.querySelectorAll('div, button, span')) {
                    var r = el.getBoundingClientRect();
                    if (r.width >= 30 && r.width <= 55 && r.height >= 30 && r.height <= 55 && r.y >= bgR.y + bgR.height - 20) {
                        if (!btn || r.x < btn.getBoundingClientRect().x) btn = el;
                    }
                }
                if (!btn) return null;
                var bR = btn.getBoundingClientRect();
                return { x: Math.round(bR.x + bR.width/2), y: Math.round(bR.y + bR.height/2), dpr: window.devicePixelRatio || 1 };
            })()`);

            if (!sliderInfo) { dlog('No slider found'); await sleep(2000); continue; }

            const sx = sliderInfo.x;
            const sy = sliderInfo.y;
            const ex = sx + dist;
            // PointerEvent dispatch ใน JS (เคยลากได้จริง)
            dlog(`PointerEvent drag: dist=${dist}px`);
            const dragResult = await win.webContents.executeJavaScript(`
            (async function() {
                function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
                var dist = ${dist};
                var container = document.querySelector('aside[aria-modal=true]') ||
                    document.querySelector('#NEW_CAPTCHA') || document.querySelector('#captchaMask');
                if (!container) return 'no container';
                var imgs = container.querySelectorAll('img');
                var bgImg = null, maxA = 0;
                for (var img of imgs) { var r = img.getBoundingClientRect(); if (r.width*r.height > maxA) { maxA=r.width*r.height; bgImg=img; } }
                if (!bgImg) return 'no img';
                var bgR = bgImg.getBoundingClientRect();
                var btn = null;
                for (var el of container.querySelectorAll('div, button, span')) {
                    var r = el.getBoundingClientRect();
                    if (r.width >= 30 && r.width <= 55 && r.height >= 30 && r.height <= 55 && r.y >= bgR.y + bgR.height - 20) {
                        if (!btn || r.x < btn.getBoundingClientRect().x) btn = el;
                    }
                }
                if (!btn) return 'no btn';
                var bR = btn.getBoundingClientRect();
                var sx = bR.x + bR.width/2, sy = bR.y + bR.height/2;
                function fire(t, type, x, y) {
                    var o = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 };
                    t.dispatchEvent(new PointerEvent(type, o));
                    t.dispatchEvent(new MouseEvent(type.replace('pointer','mouse'), o));
                }
                fire(btn, 'pointerdown', sx, sy);
                await delay(100);
                var steps = Math.max(15, Math.abs(dist) / 4);
                for (var i = 1; i <= steps; i++) {
                    fire(document, 'pointermove', sx + Math.round(dist * i / steps), sy);
                    await delay(12);
                }
                fire(document, 'pointermove', sx + dist, sy);
                await delay(150);
                fire(document, 'pointerup', sx + dist, sy);
                return 'ok from=' + Math.round(sx) + ' to=' + Math.round(sx+dist);
            })()`);
            dlog('OLD drag (skipped)');
            } /* end if(false) */

            log('Drag done', 'ok');
            await sleep(3000);

            if (!(await hasCaptchaOnPage(win))) {
                log(`SOLVED attempt ${attempt + 1}!`, 'ok'); dlog(`*** SOLVED attempt ${attempt + 1}! ***`);
                if (!wasVisible) win.hide();
                return true;
            }
            log('Still captcha...', 'warn');
            await sleep(1000);
        }

        log('FAILED', 'err');
        if (!wasVisible) win.hide();
        win.loadURL('https://affiliate.shopee.co.th');
        await sleep(5000);
        return false;
    } catch (err) {
        log('Captcha error: ' + err.message, 'err');
        return false;
    }
}

// === Captcha Health Check (every 1 hour) ===
// Reload custom_link page for each account, check for captcha, solve if needed

const CAPTCHA_CHECK_URL = 'https://affiliate.shopee.co.th/offer/custom_link';
const CAPTCHA_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

async function captchaHealthCheckOne(account) {
    const win = shopeeWindows.get(account);
    if (!win || win.isDestroyed()) {
        log('Window not found', 'err', account);
        return;
    }

    try {
        log('Checking for captcha...', 'captcha', account);

        // Navigate to custom_link page to trigger captcha if any
        win.loadURL(CAPTCHA_CHECK_URL);
        await sleep(8000);

        // Check if captcha appeared
        const hasCaptcha = await win.webContents.executeJavaScript(`
            !!document.querySelector('#NEW_CAPTCHA') ||
            !!document.querySelector('#captchaMask') ||
            !!document.querySelector('aside[aria-modal=true]') ||
            !!document.querySelector('#sliderContainer') ||
            document.body.innerText.includes('ยืนยันตัวตน')
        `);

        if (hasCaptcha) {
            log('Captcha found! Solving...', 'warn', account);
            const solved = await checkAndSolveCaptcha(win);
            if (solved) {
                log('Captcha SOLVED', 'ok', account);
                captchaStatus.set(account, { status: 'solved', time: new Date(), detail: '' });
            } else {
                log('Captcha FAILED to solve!', 'err', account);
                captchaStatus.set(account, { status: 'failed', time: new Date(), detail: 'แก้ captcha ไม่สำเร็จ' });
            }
        } else {
            log('No captcha - OK', 'ok', account);
            captchaStatus.set(account, { status: 'ok', time: new Date(), detail: '' });
        }

        // Make sure we end up on affiliate page
        const finalUrl = win.webContents.getURL();
        if (!finalUrl.includes('affiliate.shopee.co.th')) {
            win.loadURL('https://affiliate.shopee.co.th');
            await sleep(5000);
        }
    } catch (err) {
        log('Health check error: ' + err.message, 'err', account);
        captchaStatus.set(account, { status: 'error', time: new Date(), detail: err.message });
    }

    updateTrayMenu();
}

async function captchaHealthCheck() {
    log('--- Health Check ALL START ---', 'captcha');
    for (const [account] of shopeeWindows) {
        await captchaHealthCheckOne(account);
        await sleep(3000);
    }
    log('--- Health Check ALL DONE ---', 'captcha');
}

// Run first check 30s after startup, then every hour at :00
setTimeout(captchaHealthCheck, 30000);

function scheduleNextHourlyCheck() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0); // ชั่วโมงถัดไป ที่นาทีที่ 0
    const delay = next - now;
    log(`Next captcha check at ${next.toLocaleTimeString('th-TH')} (${Math.round(delay/60000)} min)`, 'info');
    setTimeout(() => {
        captchaHealthCheck();
        scheduleNextHourlyCheck();
    }, delay);
}
scheduleNextHourlyCheck();

// === Keep-alive: refresh Shopee sessions every 15 min ===
const KEEPALIVE_INTERVAL = 15 * 60 * 1000;

async function keepAliveSessions() {
    for (const [account, win] of shopeeWindows) {
        if (!win || win.isDestroyed()) continue;
        try {
            // เรียก API เบาๆ เพื่อรักษา session/cookie ไม่ให้หมดอายุ
            await win.webContents.executeJavaScript(`
                fetch('/api/v3/gql?q=keepalive', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ operationName: 'ping', query: '{ __typename }', variables: {} })
                }).catch(() => {})
            `);
            log('Keep-alive OK', 'info', account);
        } catch {}
    }
}

setInterval(keepAliveSessions, KEEPALIVE_INTERVAL);

// === Agent: Long Polling ===

async function startAgent() {
    if (!config.workerUrl) return;
    agentRunning = true;
    console.log('Agent started (polling)');

    while (agentRunning) {
        try {
            const resp = await fetch(`${config.workerUrl}/api/poll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timeoutMs: 25000 }),
            });

            if (!agentRunning) break;
            if (resp.status === 204) continue;
            if (!resp.ok) { await sleep(2000); continue; }

            const job = await resp.json();
            if (!job?.jobId || !job?.payload) continue;

            console.log(`Job ${job.jobId.slice(0, 8)} -> ${job.payload.productUrl} [${job.payload.account || 'default'}]`);

            let result;
            try {
                const r = await handleShorten(job.payload);
                result = { jobId: job.jobId, ok: true, shortLink: r.shortLink, longLink: r.longLink, redirectLink: r.redirectLink, utmSource: r.utmSource };
            } catch (err) {
                result = { jobId: job.jobId, ok: false, error: err.message };
            }

            await fetch(`${config.workerUrl}/api/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result),
            });
        } catch (err) {
            console.error('Poll error:', err.message);
            await sleep(3000);
        }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
