'use strict';

const { ensureProfileDir, sanitizeAccount, sanitizePlatform } = require('./accounts');
const { CHROME_UA, SHOPEE_URL, LAZADA_URL } = require('./config');

let chromiumImpl = null;
let chromiumSource = '';
let loadPromise = null;

async function loadChromium() {
  if (chromiumImpl) return chromiumImpl;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const cloak = await import('cloakbrowser');
      const candidate = cloak && cloak.default && typeof cloak.default.launchPersistentContext === 'function'
        ? cloak.default
        : cloak;
      if (candidate && typeof candidate.launchPersistentContext === 'function') {
        chromiumImpl = candidate;
        chromiumSource = 'cloakbrowser';
        return chromiumImpl;
      }
    } catch (err) {
      throw new Error(`[affiliate-shortlink-cloak] cloakbrowser is required; refusing playwright-core fallback: ${err && err.message ? err.message : err}`);
    }
    throw new Error('[affiliate-shortlink-cloak] cloakbrowser is required; launchPersistentContext not found');
  })();
  return loadPromise;
}

function backendInfo() {
  return {
    source: chromiumSource || 'unloaded',
  };
}

const contexts = new Map();

function contextKey(platform, account) {
  return `${platform}::${account}`;
}

function defaultUrlFor(platform) {
  if (platform === 'shopee') return SHOPEE_URL;
  if (platform === 'lazada') return LAZADA_URL;
  return 'about:blank';
}

// Shopee's batchCustomLink endpoint enforces origin === https://affiliate.shopee.co.th
// and reads the csrftoken cookie set on that subdomain. Any other host (including
// the buyer-facing shopee.co.th login redirect) makes the in-page fetch fail with
// "Failed to fetch". Lazada's MTOP signer behaves similarly on lazada.co.th.
function isOnPlatformOrigin(currentUrl, platform) {
  const url = String(currentUrl || '');
  if (!url || url === 'about:blank') return false;
  if (platform === 'shopee') return /^https:\/\/affiliate\.shopee\.co\.th(\/|$)/i.test(url);
  if (platform === 'lazada') return /^https?:\/\/([a-z0-9-]+\.)?lazada\.co\.th(\/|$)/i.test(url);
  return false;
}

async function getContext(platformRaw, accountRaw, opts = {}) {
  const { headless = true, forceVisible = false, forceNew = false } = opts;
  const platform = sanitizePlatform(platformRaw);
  if (!platform) throw new Error(`Invalid platform: ${platformRaw}`);
  const account = sanitizeAccount(accountRaw);
  const key = contextKey(platform, account);
  // Shopee must behave like a normal browser: always launch headed (even when a
  // caller requests headless:true for automatic shorten/reauth) and let
  // CloakBrowser/Chromium supply its own userAgent/viewport/locale/args — we
  // inject none of our own. Lazada keeps the previous configured behavior.
  const isShopee = platform === 'shopee';
  const effectiveHeadless = isShopee ? false : (forceVisible ? false : headless);

  if (contexts.has(key)) {
    const existing = contexts.get(key);
    if (!existing.context.__closed) {
      const launchModeMismatch = existing.headless !== effectiveHeadless;
      if (!forceNew && !launchModeMismatch) return existing;
      contexts.delete(key);
      try { await existing.context.close(); } catch {}
      existing.context.__closed = true;
    } else {
      contexts.delete(key);
    }
  }

  const chromium = await loadChromium();
  const profileDir = ensureProfileDir(platform, account);
  const launchOpts = isShopee
    ? { headless: effectiveHeadless }
    : {
        headless: effectiveHeadless,
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      };
  const context = chromiumSource === 'cloakbrowser'
    ? await chromium.launchPersistentContext({ userDataDir: profileDir, humanize: true, ...launchOpts })
    : await chromium.launchPersistentContext(profileDir, launchOpts);

  context.on('close', () => {
    context.__closed = true;
    const cur = contexts.get(key);
    if (cur && cur.context === context) contexts.delete(key);
  });

  const record = {
    platform,
    account,
    profileDir,
    context,
    headless: effectiveHeadless,
    launchMode: effectiveHeadless ? 'headless' : 'headed',
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
  };
  contexts.set(key, record);
  return record;
}

async function getPage(platform, account, opts) {
  const record = await getContext(platform, account, opts);
  const sanitizedPlatform = sanitizePlatform(platform) || platform;
  const allPages = (() => {
    try { return record.context.pages() || []; } catch { return []; }
  })();
  const live = allPages.filter((p) => {
    try { return !p.isClosed(); } catch { return true; }
  });
  // Prefer a page already on the platform origin so we don't reuse a tab that
  // got redirected to /buyer/login or a Shopee popup — those break the in-page
  // fetch's Origin/csrftoken requirements and surface as "Failed to fetch".
  let page = live.find((p) => {
    try { return isOnPlatformOrigin(p.url() || '', sanitizedPlatform); } catch { return false; }
  }) || live[0] || null;
  if (!page) page = await record.context.newPage();
  // Close any extra stale tabs so the context doesn't accumulate pages across
  // many shorten calls (each accumulated tab is another source of mid-evaluate
  // navigation races).
  for (const other of live) {
    if (other === page) continue;
    try { await other.close(); } catch {}
  }
  record.lastUsedAt = Date.now();
  return { record, page };
}

async function ensureOnPlatformPage(page, platform) {
  const target = defaultUrlFor(platform);
  const sanitizedPlatform = sanitizePlatform(platform) || platform;
  const beforeUrl = (() => { try { return page.url() || ''; } catch { return ''; } })();
  if (!isOnPlatformOrigin(beforeUrl, sanitizedPlatform)) {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  if (typeof page.waitForLoadState === 'function') {
    try { await page.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
  }
  const afterUrl = (() => { try { return page.url() || ''; } catch { return ''; } })();
  // Shopee can bounce us to a login redirect even after a successful goto when
  // the cached session is mid-revalidation; if we're not on the affiliate
  // origin yet, give the page one more nudge so the next page.evaluate runs
  // from the correct Origin (with the csrftoken cookie loaded).
  if (!isOnPlatformOrigin(afterUrl, sanitizedPlatform)) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (typeof page.waitForLoadState === 'function') {
        try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
      }
    } catch {}
  }
}

async function closeAll() {
  const records = Array.from(contexts.values());
  contexts.clear();
  for (const record of records) {
    try {
      await record.context.close();
    } catch {}
  }
}

function listLoadedContexts() {
  return Array.from(contexts.values()).map((r) => ({
    platform: r.platform,
    account: r.account,
    profileDir: r.profileDir,
    headless: r.headless,
    launchMode: r.launchMode,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    pages: (() => {
      try { return r.context.pages().length; } catch { return 0; }
    })(),
  }));
}

async function __resetForTest() {
  await closeAll();
  chromiumImpl = null;
  chromiumSource = '';
  loadPromise = null;
}

function __setChromiumForTest(source, impl) {
  chromiumImpl = impl;
  chromiumSource = source;
  loadPromise = Promise.resolve(impl);
}

module.exports = {
  loadChromium,
  backendInfo,
  getContext,
  getPage,
  ensureOnPlatformPage,
  closeAll,
  listLoadedContexts,
  defaultUrlFor,
  isOnPlatformOrigin,
  __resetForTest,
  __setChromiumForTest,
};
