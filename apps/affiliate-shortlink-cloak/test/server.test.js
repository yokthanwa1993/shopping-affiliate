'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testProfileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-cloak-server-test-'));
process.env.AFFILIATE_CLOAK_PROFILE_DIR = testProfileRoot;
process.on('exit', () => {
  fs.rmSync(testProfileRoot, { recursive: true, force: true });
});

const browser = require('../src/browser');
const keychain = require('../src/keychain');
const server = require('../src/server');

// Module-level keychain stubbing: swaps named exports for the duration of the
// test so the real /usr/bin/security and macOS Keychain are never touched.
function stubKeychain(t, overrides) {
  const restore = {};
  for (const key of Object.keys(overrides)) {
    restore[key] = keychain[key];
    keychain[key] = overrides[key];
  }
  t.after(() => {
    Object.assign(keychain, restore);
  });
}

function httpRequest(serverInstance, { method = 'GET', path = '/', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const address = serverInstance.address();
    const opts = {
      host: address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address,
      port: address.port,
      method,
      path,
      headers: { ...headers },
    };
    if (body != null && !opts.headers['Content-Type']) {
      opts.headers['Content-Type'] = 'application/json';
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function startTestServer() {
  return new Promise((resolve) => {
    const instance = server.createServer();
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
}

function stopTestServer(instance) {
  return new Promise((resolve) => instance.close(() => resolve()));
}

function stubShopeeShortenSuccess(t, opts = {}) {
  const originalGetPage = browser.getPage;
  const originalEnsureOnPlatformPage = browser.ensureOnPlatformPage;
  const originalFetch = global.fetch;
  const shortLink = opts.shortLink || 'https://s.shopee.co.th/STUB';
  const longLink = opts.longLink || 'https://shopee.co.th/product/111/222?utm_content=stub-sub2-sub3-sub4-sub5';
  const resolvedShortLinkUrl = opts.resolvedShortLinkUrl
    || 'https://shopee.co.th/product/111/222?utm_source=an_999999999&utm_content=stub-sub2-sub3-sub4-sub5';
  const getPageCalls = [];
  const posts = [];

  t.after(() => {
    browser.getPage = originalGetPage;
    browser.ensureOnPlatformPage = originalEnsureOnPlatformPage;
    global.fetch = originalFetch;
    server._resetSessionStateCacheForTest();
  });

  global.fetch = async (input) => {
    const requested = String(input || '');
    return {
      url: requested === shortLink ? resolvedShortLinkUrl : requested,
      headers: { get: () => 'text/plain' },
      text: async () => '',
    };
  };

  browser.getPage = async (platform, account, browserOpts = {}) => {
    getPageCalls.push({ platform, account, opts: browserOpts });
    return {
      record: {
        context: {
          cookies: async () => [],
          request: {
            post: async (requestUrl, requestOptions) => {
              posts.push({ requestUrl, options: requestOptions });
              return {
                status: () => 200,
                text: async () => JSON.stringify({
                  data: {
                    batchCustomLink: [
                      { shortLink, longLink, failCode: 0 },
                    ],
                  },
                }),
              };
            },
          },
        },
      },
      page: {
        url: () => 'https://affiliate.shopee.co.th/',
        goto: async () => {},
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => {
          throw new Error('page.evaluate should not run when context.request succeeds');
        },
      },
    };
  };
  browser.ensureOnPlatformPage = async () => {};

  return { getPageCalls, posts };
}

test('handleHealth returns ok + backend info shape', () => {
  const h = server.handleHealth();
  assert.equal(h.status, 'ok');
  assert.equal(typeof h.port, 'number');
  assert.equal(typeof h.backend, 'object');
  assert.ok('source' in h.backend);
});

test('handleAccounts shape includes profileRoot and platform buckets', async () => {
  const a = await server.handleAccounts();
  assert.equal(typeof a.profileRoot, 'string');
  assert.equal(a.defaultAccount, 'default');
  assert.ok(Array.isArray(a.accounts.shopee));
  assert.ok(Array.isArray(a.accounts.lazada));
  assert.ok(Array.isArray(a.loaded));
  assert.ok(a.credentialPresence);
  assert.equal(typeof a.credentialPresence.keychainSupported, 'boolean');
});

test('handleAccounts exposes credential presence as booleans only', async (t) => {
  const profileRoot = process.env.AFFILIATE_CLOAK_PROFILE_DIR;
  fs.mkdirSync(path.join(profileRoot, 'shopee', 'affiliate_chearb.com'), { recursive: true });
  stubKeychain(t, {
    isSupported: () => true,
    listCredentials: async () => [
      {
        platform: 'shopee',
        account: 'affiliate_neezs.com',
        username: 'private-user@example.com',
        configured: true,
      },
    ],
    hasCredential: async (platform, account) => {
      if (platform === 'shopee' && account === 'affiliate_chearb.com') {
        return { service: 'svc1', username: 'private-chearb@example.com' };
      }
      if (platform === 'shopee' && account === 'affiliate_neezs.com') {
        return { service: 'svc2', username: 'private-neezs@example.com' };
      }
      return null;
    },
  });

  const a = await server.handleAccounts();
  assert.equal(a.credentialPresence.keychainSupported, true);
  assert.equal(a.credentialPresence.accounts.shopee['affiliate_chearb.com'], true);
  assert.equal(a.credentialPresence.accounts.shopee['affiliate_neezs.com'], true);
  assert.equal(/private|example\.com|username|password/i.test(JSON.stringify(a.credentialPresence)), false);
});

test('handleDebug is sanitized — no cookies or tokens field', () => {
  const d = server.handleDebug();
  const keys = Object.keys(d);
  for (const k of keys) {
    assert.equal(/cookie|token|password|secret/i.test(k), false, `debug must not surface ${k}`);
  }
  assert.ok('profileRoot' in d);
  assert.ok('backend' in d);
  assert.ok('loaded' in d);
});

test('handleShorten rejects missing url', async () => {
  await assert.rejects(() => server.handleShorten({}), /Missing required parameter: url/);
});

test('handleShorten rejects unknown platform url', async () => {
  await assert.rejects(
    () => server.handleShorten({ url: 'https://example.com/foo' }),
    /Cannot detect platform/,
  );
});

test('handleShorten sends canonical Shopee product URL to batch API and preserves raw link output', async (t) => {
  const originalGetPage = browser.getPage;
  const originalEnsureOnPlatformPage = browser.ensureOnPlatformPage;
  const originalFetch = global.fetch;
  t.after(() => {
    browser.getPage = originalGetPage;
    browser.ensureOnPlatformPage = originalEnsureOnPlatformPage;
    global.fetch = originalFetch;
    server._resetSessionStateCacheForTest();
  });
  // Pre-populate a valid session snapshot so the new pre-shorten readiness
  // gate (which would otherwise hit /usr/bin/security via hasCredential) is
  // a no-op for this canonical-URL test.
  server._resetSessionStateCacheForTest();
  server.recordSessionState('shopee', 'affiliate_chearb.com', {
    sessionValid: true,
    customLinkAuthenticated: true,
  });

  const rawUrl = 'https://s.shopee.co.th/raw-input';
  let postedOriginalLink = '';

  global.fetch = async (input) => {
    const requested = String(input || '');
    return {
      url: requested === rawUrl
        ? 'https://shopee.co.th/opaanlp/818732663/26493987387?utm_source=tracking'
        : requested,
      headers: { get: () => 'text/plain' },
      text: async () => '',
    };
  };

  browser.getPage = async () => ({
    record: {
      context: {
        cookies: async () => [],
        request: {
          post: async (_requestUrl, options) => {
            postedOriginalLink = options.data.variables.linkParams[0].originalLink;
            return {
              status: () => 200,
              text: async () => JSON.stringify({
                data: {
                  batchCustomLink: [
                    {
                      shortLink: 'https://s.shopee.co.th/CANON',
                      longLink: postedOriginalLink + '?utm_content=canonical_probe',
                      failCode: 0,
                    },
                  ],
                },
              }),
            };
          },
        },
      },
    },
    page: {
      url: () => 'https://affiliate.shopee.co.th/',
      goto: async () => {},
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      evaluate: async () => {
        throw new Error('page.evaluate should not run when context.request succeeds');
      },
    },
  });
  browser.ensureOnPlatformPage = async () => {};

  const result = await server.handleShorten({
    account: 'affiliate_chearb.com',
    url: rawUrl,
    sub1: 'canonical_probe',
  });

  assert.equal(postedOriginalLink, 'https://shopee.co.th/product/818732663/26493987387');
  assert.equal(result.link, rawUrl);
  assert.equal(result.originalLink, 'https://shopee.co.th/product/818732663/26493987387');
  assert.equal(result.sub1, 'canonical_probe');
});

test('handleShorten resolves Shopee account from id when account is omitted', async (t) => {
  server._resetSessionStateCacheForTest();
  server.recordSessionState('shopee', 'affiliate_neezs.com', {
    sessionValid: true,
    customLinkAuthenticated: true,
  });
  const stub = stubShopeeShortenSuccess(t, {
    shortLink: 'https://s.shopee.co.th/IDONLY',
    longLink: 'https://shopee.co.th/product/111/222?utm_content=idonly-sub2-sub3-sub4-sub5',
  });

  const result = await server.handleShorten({
    url: 'https://shopee.co.th/-i.111.222',
    id: '15142270000',
    sub1: 'idonly',
  });

  assert.equal(result.account, 'affiliate@neezs.com');
  assert.equal(stub.getPageCalls[0].platform, 'shopee');
  assert.equal(stub.getPageCalls[0].account, 'affiliate_neezs.com');
});

test('handleShorten resolves Shopee account from 15130770000 id alias', async (t) => {
  server._resetSessionStateCacheForTest();
  server.recordSessionState('shopee', 'affiliate_neezs.com', {
    sessionValid: true,
    customLinkAuthenticated: true,
  });
  const stub = stubShopeeShortenSuccess(t, {
    shortLink: 'https://s.shopee.co.th/ID151307',
    longLink: 'https://shopee.co.th/product/111/222?utm_content=id151307-sub2-sub3-sub4-sub5',
  });

  const result = await server.handleShorten({
    url: 'https://shopee.co.th/-i.111.222',
    id: '15130770000',
    sub1: 'id151307',
  });

  assert.equal(result.account, 'affiliate@neezs.com');
  assert.equal(stub.getPageCalls[0].platform, 'shopee');
  assert.equal(stub.getPageCalls[0].account, 'affiliate_neezs.com');
});

test('handleShorten keeps explicit Shopee account authoritative over id alias', async (t) => {
  server._resetSessionStateCacheForTest();
  server.recordSessionState('shopee', 'affiliate_chearb.com', {
    sessionValid: true,
    customLinkAuthenticated: true,
  });
  const stub = stubShopeeShortenSuccess(t, {
    shortLink: 'https://s.shopee.co.th/EXPLICIT',
    longLink: 'https://shopee.co.th/product/333/444?utm_content=explicit-sub2-sub3-sub4-sub5',
  });

  const result = await server.handleShorten({
    account: 'affiliate_chearb.com',
    url: 'https://shopee.co.th/-i.333.444',
    id: '15142270000',
    sub1: 'explicit',
  });

  assert.equal(result.account, 'affiliate_chearb.com');
  assert.equal(stub.getPageCalls[0].account, 'affiliate_chearb.com');
});

test('handleShorten rejects unknown Shopee id alias before opening a browser', async (t) => {
  server._resetSessionStateCacheForTest();
  t.after(() => server._resetSessionStateCacheForTest());
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not run for an unknown id alias');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  await assert.rejects(
    () => server.handleShorten({
      url: 'https://shopee.co.th/-i.111.222',
      id: '999999999999',
    }),
    /Unknown Shopee affiliate id: 999999999999/,
  );
  assert.equal(getPageCalls.length, 0);
});

test('handleShorten uses explicit Shopee id in payload even when tracking utm_source differs', async (t) => {
  server._resetSessionStateCacheForTest();
  server.recordSessionState('shopee', 'affiliate_neezs.com', {
    sessionValid: true,
    customLinkAuthenticated: true,
  });
  stubShopeeShortenSuccess(t, {
    shortLink: 'https://s.shopee.co.th/PAYLOADID',
    longLink: 'https://shopee.co.th/product/555/666?utm_content=payload-sub2-sub3-sub4-sub5',
    resolvedShortLinkUrl: 'https://shopee.co.th/product/555/666?utm_source=an_999999999&utm_content=payload-sub2-sub3-sub4-sub5',
  });

  const result = await server.handleShorten({
    url: 'https://shopee.co.th/-i.555.666',
    id: 'an_15142270000',
    sub1: 'payload',
  });

  assert.equal(result.id, '15142270000');
  assert.equal(result.utm_source, 'an_999999999');
  assert.equal(result.account, 'affiliate@neezs.com');
});

test('handleShorten reuses authenticated Shopee dashboard context after auto reauth and returns shortLink', async (t) => {
  const originalGetPage = browser.getPage;
  const originalEnsureOnPlatformPage = browser.ensureOnPlatformPage;
  const originalFetch = global.fetch;
  t.after(() => {
    browser.getPage = originalGetPage;
    browser.ensureOnPlatformPage = originalEnsureOnPlatformPage;
    global.fetch = originalFetch;
    server._resetSessionStateCacheForTest();
  });
  // Pre-populate a valid session snapshot so the new pre-shorten readiness
  // gate short-circuits cleanly; the test still exercises the in-flight
  // off-domain reauth recovery path inside shortenShopee.
  server._resetSessionStateCacheForTest();
  server.recordSessionState('shopee', 'affiliate_chearb.com', {
    sessionValid: true,
    customLinkAuthenticated: true,
  });

  const PW = 'dashboard-auth-secret-never-returned';
  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => ({ username: 'stored-user@example.com', password: PW }),
  });

  global.fetch = async (input) => {
    const requested = String(input || '');
    return {
      url: requested.includes('s.shopee.co.th/1qR4b07pQ6')
        ? 'https://shopee.co.th/product/6817918/28499498718'
        : requested,
      headers: { get: () => 'text/plain' },
      text: async () => '',
    };
  };

  let reauthComplete = false;
  let preservedAuthenticatedContext = false;
  const getPageCalls = [];
  const posts = [];

  const makeStatefulPage = (initialUrl, options = {}) => {
    let currentUrl = initialUrl;
    return {
      url: () => currentUrl,
      bringToFront: async () => {},
      goto: async (target) => {
        if (options.kind === 'reauth') {
          currentUrl = 'https://affiliate.shopee.co.th/dashboard';
          reauthComplete = true;
          return;
        }
        if (options.kind === 'preserved-resettle') {
          currentUrl = target;
          preservedAuthenticatedContext = true;
          return;
        }
        currentUrl = 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2F';
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      evaluate: async () => {
        throw new Error('page.evaluate should not run when context.request is available');
      },
    };
  };

  browser.getPage = async (platform, account, opts = {}) => {
    const phase = reauthComplete ? 'after-reauth' : 'before-reauth';
    getPageCalls.push({ platform, account, opts, phase });

    if (!reauthComplete && opts.forceNew) {
      return { page: makeStatefulPage('https://shopee.co.th/buyer/login', { kind: 'reauth' }), record: {} };
    }

    if (reauthComplete && Object.prototype.hasOwnProperty.call(opts, 'forceNew')) {
      const kind = opts.forceNew ? 'fresh-resettle' : 'preserved-resettle';
      return { page: makeStatefulPage('https://affiliate.shopee.co.th/dashboard', { kind }), record: {} };
    }

    if (preservedAuthenticatedContext) {
      return {
        record: {
          context: {
            cookies: async () => [{ name: 'csrftoken', value: 'csrf-after-reauth' }],
            request: {
              post: async (requestUrl, options) => {
                posts.push({ requestUrl, options });
                return {
                  status: () => 200,
                  text: async () => JSON.stringify({
                    data: {
                      batchCustomLink: [
                        {
                          shortLink: 'https://s.shopee.co.th/AUTHCTX',
                          longLink: 'https://shopee.co.th/product/1/2?utm_content=hermes_dashboardauth',
                          failCode: 0,
                        },
                      ],
                    },
                  }),
                };
              },
            },
          },
        },
        page: makeStatefulPage('https://affiliate.shopee.co.th/'),
      };
    }

    return {
      page: makeStatefulPage('https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2F'),
      record: {},
    };
  };
  browser.ensureOnPlatformPage = async () => {};

  const result = await server.handleShorten({
    account: 'affiliate_chearb.com',
    url: 'https://s.shopee.co.th/1qR4b07pQ6',
    sub1: 'hermes_dashboardauth',
  });

  assert.equal(result.shortLink, 'https://s.shopee.co.th/AUTHCTX');
  assert.equal(result.account, 'affiliate_chearb.com');
  assert.equal(result.sub1, 'hermes_dashboardauth');
  assert.equal(posts.length, 1, 'retry should create a Shopee shortlink from the authenticated context');
  assert.equal(
    posts[0].options.data.variables.linkParams[0].originalLink,
    'https://shopee.co.th/product/6817918/28499498718',
    'Shopee batchCustomLink must receive the resolved product URL, not the incoming s.shopee.co.th short URL',
  );
  assert.equal(
    getPageCalls.some((call) => call.phase === 'after-reauth' && call.opts && call.opts.forceNew === true),
    false,
    'authenticated dashboard reauth must not be discarded before retry',
  );
  assert.equal(JSON.stringify(result).includes(PW), false, 'password must not appear in shorten result');
});

test('handleLogin rejects unknown platform', async () => {
  await assert.rejects(() => server.handleLogin({ platform: 'amazon' }), /Invalid or missing platform/);
});

test('handleLogin requests a headed visible browser context', async (t) => {
  const originalGetPage = browser.getPage;
  const calls = [];
  const navigations = [];
  browser.getPage = async (...args) => {
    calls.push(args);
    return {
      page: {
        bringToFront: async () => {},
        goto: async (...gotoArgs) => {
          navigations.push(gotoArgs);
        },
      },
    };
  };
  t.after(() => {
    browser.getPage = originalGetPage;
  });

  const result = await server.handleLogin({ platform: 'shopee', account: 'CHEARB' });

  assert.equal(result.status, 'login_window_opened');
  assert.equal(calls[0][0], 'shopee');
  assert.equal(calls[0][1], 'CHEARB');
  assert.deepEqual(calls[0][2], { headless: false, forceVisible: true });
  assert.match(navigations[0][0], /shopee\.co\.th\/buyer\/login/);
  assert.match(navigations[0][0], /next=https%3A%2F%2Faffiliate\.shopee\.co\.th%2F/);
});

test('loginUiHtml renders only username/password as visible inputs (no platform/account/url/sub1 visible fields)', () => {
  const html = server.loginUiHtml({
    account: 'CHEARB',
    url: 'https://shopee.co.th/-i.6817918.28499498718',
    sub1: 'yok',
  });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<form[^>]*id="f"/);
  assert.match(html, /name="username"[^>]*required/);
  assert.match(html, /name="password"[^>]*type="password"[^>]*required/);
  assert.match(html, /\/api\/login-and-shorten/);

  // Hidden inputs carry the context from the query string.
  assert.match(html, /<input type="hidden" name="platform" value="shopee">/);
  assert.match(html, /<input type="hidden" name="account" value="CHEARB">/);
  assert.match(
    html,
    /<input type="hidden" name="url" value="https:\/\/shopee\.co\.th\/-i\.6817918\.28499498718">/,
  );
  assert.match(html, /<input type="hidden" name="sub1" value="yok">/);

  // No visible <select> or text <input> for platform/account/url/sub1.
  assert.equal(/<select[^>]*name="platform"/.test(html), false, 'platform must not be a visible select');
  assert.equal(
    /<input(?![^>]*type="hidden")[^>]*name="platform"/.test(html), false,
    'platform must not be a visible input',
  );
  assert.equal(
    /<input(?![^>]*type="hidden")[^>]*name="account"/.test(html), false,
    'account must not be a visible input',
  );
  assert.equal(
    /<input(?![^>]*type="hidden")[^>]*name="url"/.test(html), false,
    'url must not be a visible input',
  );
  assert.equal(
    /<input(?![^>]*type="hidden")[^>]*name="sub1"/.test(html), false,
    'sub1 must not be a visible input',
  );
});

test('loginUiHtml infers platform from the url when platform is not provided', () => {
  const shopee = server.loginUiHtml({
    account: 'CHEARB',
    url: 'https://shopee.co.th/-i.1.2',
  });
  assert.match(shopee, /<input type="hidden" name="platform" value="shopee">/);

  const lazada = server.loginUiHtml({
    account: 'CHEARB',
    url: 'https://www.lazada.co.th/products/xyz.html',
  });
  assert.match(lazada, /<input type="hidden" name="platform" value="lazada">/);
});

test('loginUiHtml html-escapes query values into hidden inputs', () => {
  const html = server.loginUiHtml({
    account: 'A"B<script>',
    url: 'https://shopee.co.th/?a=1&b=2',
    sub1: '"><x',
  });
  assert.equal(html.includes('A"B<script>'), false, 'raw account value must not appear in attribute');
  assert.match(html, /name="account" value="A&quot;B&lt;script&gt;"/);
  assert.match(html, /name="url" value="https:\/\/shopee\.co\.th\/\?a=1&amp;b=2"/);
  assert.match(html, /name="sub1" value="&quot;&gt;&lt;x"/);
});

test('loginUiHtml shows a helpful message when url is missing (no form, no leak)', () => {
  const html = server.loginUiHtml({});
  assert.equal(/<form/.test(html), false, 'must NOT render a form when url is missing');
  assert.equal(/name="password"/.test(html), false, 'must NOT render a password field when url is missing');
  assert.match(html, /Missing required query parameter/i);
  assert.match(html, /\/login-ui\?/);
});

test('loginUiHtml shows a helpful message when platform cannot be inferred from url', () => {
  const html = server.loginUiHtml({ url: 'https://example.com/foo' });
  assert.equal(/<form/.test(html), false, 'must NOT render a form when platform is unknown');
  assert.match(html, /Cannot detect platform/i);
});

test('GET /login-ui with query renders form with hidden context and visible username/password only', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const qs = '?account=CHEARB&url=' + encodeURIComponent('https://shopee.co.th/-i.6817918.28499498718') + '&sub1=yok';
  const res = await httpRequest(instance, { method: 'GET', path: '/login-ui' + qs });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/);
  assert.match(res.body, /<form[^>]*id="f"/);
  assert.match(res.body, /name="username"/);
  assert.match(res.body, /name="password"/);
  assert.match(res.body, /<input type="hidden" name="platform" value="shopee">/);
  assert.match(res.body, /<input type="hidden" name="account" value="CHEARB">/);
  assert.match(res.body, /<input type="hidden" name="sub1" value="yok">/);
  assert.equal(
    /<input(?![^>]*type="hidden")[^>]*name="url"/.test(res.body), false,
    'url must not appear as a visible input',
  );
});

test('GET /login-ui without query shows the helpful message and does not render a form', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, { method: 'GET', path: '/login-ui' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/);
  assert.equal(/<form/.test(res.body), false);
  assert.equal(/name="password"/.test(res.body), false);
  assert.match(res.body, /Missing required query parameter/i);
});

test('GET /?account=...&url=... still returns JSON (not the login-ui HTML form)', async (t) => {
  // Stub handleShorten via the shopee/lazada paths by intercepting before they run.
  // We just need the route to attempt JSON (with a domain url) and return JSON content-type,
  // even on failure. Use an unknown-platform url so the handler short-circuits to a JSON 500.
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    method: 'GET',
    path: '/?account=CHEARB&url=' + encodeURIComponent('https://example.com/foo') + '&sub1=yok',
  });
  assert.match(String(res.headers['content-type'] || ''), /application\/json/);
  assert.equal(/<form/.test(res.body), false, 'GET / with url must NOT return an HTML form');
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error || '', /Cannot detect platform/);
});

test('POST /api/login-and-shorten requires POST (GET returns 405)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, { method: 'GET', path: '/api/login-and-shorten' });
  assert.equal(res.statusCode, 405);
  assert.match(String(res.headers['allow'] || ''), /POST/);
});

test('handleLoginAndShorten rejects missing platform', async () => {
  await assert.rejects(
    () => server.handleLoginAndShorten({
      account: 'CHEARB', username: 'u', password: 'p', url: 'https://shopee.co.th/x',
    }),
    /Invalid or missing platform/,
  );
});

test('handleLoginAndShorten rejects missing username', async () => {
  await assert.rejects(
    () => server.handleLoginAndShorten({
      platform: 'shopee', account: 'CHEARB', password: 'p', url: 'https://shopee.co.th/x',
    }),
    /Missing required field: username/,
  );
});

test('handleLoginAndShorten rejects missing password', async () => {
  await assert.rejects(
    () => server.handleLoginAndShorten({
      platform: 'shopee', account: 'CHEARB', username: 'u', url: 'https://shopee.co.th/x',
    }),
    /Missing required field: password/,
  );
});

test('handleLoginAndShorten rejects missing url and does NOT echo the password in the error', async () => {
  const PW = 'SUPER_SECRET_PW_!@#';
  await assert.rejects(
    () => server.handleLoginAndShorten({
      platform: 'shopee', account: 'CHEARB', username: 'u', password: PW, url: '',
    }),
    (err) => {
      assert.match(err.message, /Missing required field: url/);
      assert.equal(err.message.includes(PW), false, 'password must not appear in error message');
      return true;
    },
  );
});

test('POST /api/login-and-shorten returns 400 for missing fields without leaking password', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const PW = 'do-not-leak-pw-9001';
  const res = await httpRequest(instance, {
    method: 'POST',
    path: '/api/login-and-shorten',
    body: { platform: 'shopee', account: 'CHEARB', username: 'u', password: PW },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.includes(PW), false, 'password must not appear in HTTP error body');
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error, /Missing required field: url/);
});

// --- /login HTML routes & /api/login (login-only) ---------------------------

test('loginHtmlPage renders form with platform select + username/password only (no visible account/url/sub1 fields)', () => {
  const html = server.loginHtmlPage({});
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<form[^>]*id="f"/);
  assert.match(html, /<select[^>]*name="platform"[^>]*id="platform"/);
  assert.match(html, /<option value="shopee"/);
  assert.match(html, /<option value="lazada"/);
  assert.match(html, /name="username"[^>]*required/);
  assert.match(html, /name="password"[^>]*type="password"[^>]*required/);
  assert.match(html, /name="remember"/);
  assert.match(html, /กำลัง login:/);
  assert.match(html, /<span id="ctxLabel"/);
  // No hardcoded passwords or platform-fixed labels in heading
  assert.match(html, /เข้าสู่ระบบ Affiliate/);

  // Credential-only UX: no url/sub1 fields (visible or hidden) on /login.
  assert.equal(/name="url"/.test(html), false, 'url must NOT appear as a form field on credential-only /login');
  assert.equal(/name="sub1"/.test(html), false, 'sub1 must NOT appear as a form field on credential-only /login');

  // No visible account dropdown / input / select / hidden field on the new /login form.
  assert.equal(/<select[^>]*name="account"/.test(html), false, 'account must NOT be a select');
  assert.equal(/<input[^>]*name="account"/.test(html), false, 'account must NOT be an input (visible or hidden)');
  assert.equal(/<input[^>]*name="accountCustom"/.test(html), false, 'accountCustom must NOT be an input');
});

test('loginHtmlPage uses a polished card layout with gradient + viewport meta (mobile-friendly)', () => {
  const html = server.loginHtmlPage({});
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<main class="card">/, 'must wrap content in a card');
  assert.match(html, /linear-gradient/, 'must use a gradient background for polish');
  assert.match(html, /box-shadow:/, 'card must have shadow styling');
  assert.match(html, /border-radius:/, 'must use rounded corners');
  assert.match(html, /@media \(max-width:/, 'must include a mobile media query');
});

test('loginHtmlPage shows a Keychain status card with label + body and a derived-account preview', () => {
  const html = server.loginHtmlPage({});
  assert.match(html, /<div id="cred">/, 'status card container');
  assert.match(html, /สถานะ Keychain/, 'status card label in Thai');
  assert.match(html, /id="credBody"/, 'status body element for JS updates');
  assert.match(html, /id="accountPreview"/, 'derived account preview element');
  assert.match(html, /Account ที่จะใช้/, 'preview label in Thai');
});

test('loginHtmlPage uses toast-style output (div with role=status), no <pre> dump', () => {
  const html = server.loginHtmlPage({});
  assert.match(html, /<div id="out"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.equal(/<pre[^>]*id="out"/.test(html), false, 'must NOT use a <pre> output dump');
});

test('loginHtmlPage status JS calls /api/credentials (GET status + DELETE for forget)', () => {
  const html = server.loginHtmlPage({});
  assert.match(html, /fetch\("\/api\/credentials\?platform="\+encodeURIComponent\(p\)\+"&account="\+encodeURIComponent\(a\)/);
  assert.match(html, /method:"DELETE"/, 'must support DELETE to forget credential');
  assert.match(html, /ลบ credential นี้/, 'must label the forget button in Thai');
});

test('loginHtmlPage embeds Thai status copy for configured + none cases and never echoes password in output', () => {
  const html = server.loginHtmlPage({});
  assert.match(html, /มี credential ใน macOS Keychain แล้ว/, 'configured Thai copy');
  assert.match(html, /ยังไม่มี credential/, 'not-configured Thai copy');
  // submit-success path uses friendly Thai toast (not a raw JSON dump)
  assert.match(html, /บันทึก credential ลง macOS Keychain เรียบร้อย/);
  // No raw response dumps that could leak secrets back into DOM
  assert.equal(/HTTP "\+res\.status\+"\\n"\+pretty/.test(html), false, 'must NOT pretty-print raw response into the DOM');
});

test('loginHtmlPage submit body uses platform/username/password/remember only (no url/sub1/account in payload)', () => {
  const html = server.loginHtmlPage({});
  assert.match(html, /var body=\{platform:p,username:u,password:pw,remember:remember\};/);
  assert.equal(/body\.url\b/.test(html), false, 'body must not carry a url field');
  assert.equal(/body\.sub1\b/.test(html), false, 'body must not carry a sub1 field');
  assert.equal(/body\.account\b/.test(html), false, 'body must not carry an account field');
});

test('loginHtmlPage has no visible account control on /login (default platform)', () => {
  const html = server.loginHtmlPage({});
  assert.equal(/<select[^>]*name="account"/.test(html), false);
  assert.equal(/<input[^>]*name="account"/.test(html), false);
  assert.equal(/<input[^>]*name="accountCustom"/.test(html), false);
});

test('loginHtmlPage has no visible account control on /login/shopee', () => {
  const html = server.loginHtmlPage({ platform: 'shopee' });
  assert.equal(/<select[^>]*name="account"/.test(html), false);
  assert.equal(/<input[^>]*name="account"/.test(html), false);
});

test('loginHtmlPage has no visible account control on /login/lazada', () => {
  const html = server.loginHtmlPage({ platform: 'lazada' });
  assert.equal(/<select[^>]*name="account"/.test(html), false);
  assert.equal(/<input[^>]*name="account"/.test(html), false);
});

test('loginHtmlPage remember checkbox is CHECKED by default', () => {
  const html = server.loginHtmlPage({});
  assert.match(
    html,
    /<input[^>]*type="checkbox"[^>]*name="remember"[^>]*\bchecked\b/,
    'remember checkbox must be checked by default',
  );
});

test('loginHtmlPage notes that credential is remembered in macOS Keychain by default and account derived from username', () => {
  const html = server.loginHtmlPage({});
  assert.match(html, /macOS Keychain/, 'must mention macOS Keychain');
  assert.match(html, /account จะสร้างจาก username/, 'must say account is derived from username');
});

test('loginHtmlPage with platform=shopee locks the platform (hidden input) and shows Shopee heading', () => {
  const html = server.loginHtmlPage({ platform: 'shopee' });
  assert.match(html, /<input type="hidden" name="platform" id="platform" value="shopee">/);
  // platform must NOT be a visible select
  assert.equal(/<select[^>]*name="platform"/.test(html), false, 'platform select must not render when locked');
  assert.match(html, /เข้าสู่ระบบ Shopee/);
  // JS context label uses Shopee label
  assert.match(html, /PRESET_PLATFORM=\"shopee\"|PRESET_PLATFORM='shopee'/);
  assert.match(html, /PLATFORM_LOCKED=true/);
});

test('loginHtmlPage with platform=lazada locks the platform and shows Lazada heading', () => {
  const html = server.loginHtmlPage({ platform: 'lazada' });
  assert.match(html, /<input type="hidden" name="platform" id="platform" value="lazada">/);
  assert.equal(/<select[^>]*name="platform"/.test(html), false);
  assert.match(html, /เข้าสู่ระบบ Lazada/);
  assert.match(html, /PRESET_PLATFORM=\"lazada\"|PRESET_PLATFORM='lazada'/);
});

test('loginHtmlPage ignores invalid platform value (falls back to unlocked dropdown)', () => {
  const html = server.loginHtmlPage({ platform: 'amazon' });
  assert.match(html, /<select[^>]*name="platform"[^>]*id="platform"/);
  assert.match(html, /PLATFORM_LOCKED=false/);
});

test('loginHtmlPage never embeds password-shaped literals (no literal password)', () => {
  const html = server.loginHtmlPage({ platform: 'shopee' });
  // No literal "password: '...'" / "password: \"...\"" content (only HTML name/type attributes are allowed)
  const stripped = html.replace(/name="password"/g, '').replace(/type="password"/g, '');
  assert.equal(/password\s*:\s*["']/.test(stripped), false);
});

test('loginHtmlPage does NOT embed the legacy ACCOUNTS dropdown data or "+ เพิ่มบัญชีใหม่" custom-account option', () => {
  const html = server.loginHtmlPage({ platform: 'shopee' });
  assert.equal(/var ACCOUNTS\s*=/.test(html), false, 'must not embed ACCOUNTS list');
  assert.equal(/__new__/.test(html), false, 'must not render the legacy custom-account option');
  assert.equal(/เพิ่มบัญชีใหม่/.test(html), false, 'must not show the custom-account label');
  assert.equal(/id="accountCustom"/.test(html), false, 'must not render the accountCustom input');
});

test('loginHtmlPage does NOT include the legacy advanced URL+sub1 collapsed details (credential-only UX)', () => {
  const html = server.loginHtmlPage({});
  assert.equal(/<details>/.test(html), false, 'must NOT render <details> advanced section on credential-only /login');
  assert.equal(/ใส่ URL สินค้า/.test(html), false, 'must NOT render the legacy "ใส่ URL สินค้า" label');
  assert.equal(/id="url"/.test(html), false, 'must NOT render the legacy url input');
  assert.equal(/id="sub1"/.test(html), false, 'must NOT render the legacy sub1 input');
});

test('loginHtmlPage submit JS posts to /api/login (credential-only — no /api/login-and-shorten branch)', () => {
  const html = server.loginHtmlPage({ platform: 'shopee' });
  assert.match(html, /fetch\(\"\/api\/login\"/);
  assert.equal(
    /\/api\/login-and-shorten/.test(html), false,
    '/login HTML must not reference /api/login-and-shorten (credential-only flow)',
  );
});

test('loginHtmlPage contains no links to /login/shopee or /login/lazada (those are compatibility redirects, not primary)', () => {
  for (const opts of [{}, { platform: 'shopee' }, { platform: 'lazada' }]) {
    const html = server.loginHtmlPage(opts);
    assert.equal(
      /\/login\/shopee/.test(html), false,
      '/login HTML must not advertise /login/shopee',
    );
    assert.equal(
      /\/login\/lazada/.test(html), false,
      '/login HTML must not advertise /login/lazada',
    );
  }
});

test('accountListsForHtml always includes "default" even when no profiles exist yet', () => {
  const lists = server.accountListsForHtml();
  assert.ok(Array.isArray(lists.shopee));
  assert.ok(Array.isArray(lists.lazada));
  assert.ok(lists.shopee.includes('default'));
  assert.ok(lists.lazada.includes('default'));
});

test('accountListsForHtml surfaces profile directories that exist on disk', () => {
  // Create a fake profile under the test profile root for shopee/CUSTOMACC
  const profileRoot = process.env.AFFILIATE_CLOAK_PROFILE_DIR;
  const target = path.join(profileRoot, 'shopee', 'CUSTOMACC');
  fs.mkdirSync(target, { recursive: true });
  const lists = server.accountListsForHtml();
  assert.ok(lists.shopee.includes('CUSTOMACC'), 'profile-backed accounts should appear in dropdown list');
  assert.ok(lists.shopee.includes('default'));
});

test('clientWantsJson honors Accept: application/json', () => {
  const fakeReq = { headers: { accept: 'application/json' } };
  assert.equal(server.clientWantsJson(fakeReq, {}), true);
});

test('clientWantsJson honors ?json=1 even when Accept is HTML', () => {
  const fakeReq = { headers: { accept: 'text/html,application/xhtml+xml' } };
  assert.equal(server.clientWantsJson(fakeReq, { json: '1' }), true);
});

test('clientWantsJson returns false for browser Accept (text/html)', () => {
  const fakeReq = { headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } };
  assert.equal(server.clientWantsJson(fakeReq, {}), false);
});

test('clientWantsJson returns false when no Accept header and no json flag', () => {
  assert.equal(server.clientWantsJson({ headers: {} }, {}), false);
});

test('GET /login (browser Accept) returns the HTML login form', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));
  const res = await httpRequest(instance, {
    method: 'GET',
    path: '/login',
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/);
  assert.match(res.body, /<form[^>]*id="f"/);
  assert.match(res.body, /name="username"/);
  assert.match(res.body, /<select[^>]*name="platform"/);
});

test('GET /login/shopee is a 302 compatibility redirect to /login?platform=shopee', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));
  const res = await httpRequest(instance, { method: 'GET', path: '/login/shopee' });
  assert.equal(res.statusCode, 302);
  assert.equal(String(res.headers['location'] || ''), '/login?platform=shopee');
});

test('GET /login/lazada is a 302 compatibility redirect to /login?platform=lazada', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));
  const res = await httpRequest(instance, { method: 'GET', path: '/login/lazada' });
  assert.equal(res.statusCode, 302);
  assert.equal(String(res.headers['location'] || ''), '/login?platform=lazada');
});

test('GET /login/shopee with ?account=CHEARB still redirects (account is ignored — derived from username on /login)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));
  const res = await httpRequest(instance, { method: 'GET', path: '/login/shopee?account=CHEARB' });
  assert.equal(res.statusCode, 302);
  assert.equal(String(res.headers['location'] || ''), '/login?platform=shopee');
});

test('GET /login with Accept: application/json preserves the legacy JSON handleLogin behavior', async (t) => {
  const originalGetPage = browser.getPage;
  const calls = [];
  browser.getPage = async (...args) => {
    calls.push(args);
    return {
      page: {
        bringToFront: async () => {},
        goto: async () => {},
      },
    };
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    method: 'GET',
    path: '/login?platform=shopee&account=CHEARB',
    headers: { Accept: 'application/json' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /application\/json/);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.status, 'login_window_opened');
  assert.equal(parsed.platform, 'shopee');
  assert.equal(parsed.account, 'CHEARB');
  assert.equal(calls[0][0], 'shopee');
  assert.equal(calls[0][1], 'CHEARB');
  assert.deepEqual(calls[0][2], { headless: false, forceVisible: true });
});

test('GET /login?json=1&platform=shopee&account=CHEARB also returns JSON (no Accept header needed)', async (t) => {
  const originalGetPage = browser.getPage;
  browser.getPage = async () => ({
    page: { bringToFront: async () => {}, goto: async () => {} },
  });
  t.after(() => { browser.getPage = originalGetPage; });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    method: 'GET',
    path: '/login?json=1&platform=shopee&account=CHEARB',
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /application\/json/);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.status, 'login_window_opened');
});

test('handleLogin autofill reports missing Keychain credential without opening browser', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called when Keychain credential is absent');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => null,
  });

  const parsed = await server.handleLogin({
    autofill: '1',
    platform: 'shopee',
    account: 'affiliate_chearb.com',
  });
  assert.equal(parsed.status, 'keychain_credential_not_found');
  assert.equal(parsed.reason, 'keychain_credential_not_found');
  assert.equal(parsed.autofill.attempted, true);
  assert.equal(parsed.autofill.ok, false);
  assert.equal(parsed.keychainCredential.present, false);
  assert.deepEqual(parsed.keychainCredential.expectedServices, [
    'com.affiliate.shortlink-cloak.shopee.affiliate_chearb.com',
  ]);
  assert.equal(getPageCalls.length, 0);
  assert.equal(/password|secret/i.test(JSON.stringify(parsed)), false);
});

test('GET /login without query and with HTML Accept renders the dropdown form (no JSON error)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));
  const res = await httpRequest(instance, {
    method: 'GET',
    path: '/login',
    headers: { Accept: 'text/html' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/);
  assert.match(res.body, /<select[^>]*name="platform"/);
  // legacy JSON error "Invalid or missing platform" must NOT appear in HTML branch
  assert.equal(/Invalid or missing platform/.test(res.body), false);
});

test('POST /api/login requires POST (GET returns 405)', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));
  const res = await httpRequest(instance, { method: 'GET', path: '/api/login' });
  assert.equal(res.statusCode, 405);
  assert.match(String(res.headers['allow'] || ''), /POST/);
});

test('handleLoginOnly rejects missing platform', async () => {
  await assert.rejects(
    () => server.handleLoginOnly({ account: 'CHEARB', username: 'u', password: 'p' }),
    /Invalid or missing platform/,
  );
});

test('handleLoginOnly rejects missing username', async () => {
  await assert.rejects(
    () => server.handleLoginOnly({ platform: 'shopee', account: 'CHEARB', password: 'p' }),
    /Missing required field: username/,
  );
});

test('handleLoginOnly rejects missing password and does NOT echo the password', async () => {
  await assert.rejects(
    () => server.handleLoginOnly({ platform: 'shopee', account: 'CHEARB', username: 'u' }),
    /Missing required field: password/,
  );
});

test('POST /api/login returns 400 for missing fields without leaking password', async (t) => {
  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const PW = 'do-not-leak-login-only-pw-9001';
  const res = await httpRequest(instance, {
    method: 'POST',
    path: '/api/login',
    body: { platform: 'shopee', account: 'CHEARB', password: PW }, // missing username
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.includes(PW), false, 'password must not appear in HTTP error body');
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error, /Missing required field: username/);
});

test('handleLoginOnly is credential-save-only: never calls browser.getPage and never echoes password', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called by handleLoginOnly');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const PW = 'LoginOnlyTopSecret!9000_never_echo';
  const result = await server.handleLoginOnly({
    platform: 'lazada',
    account: 'CHEARB',
    username: 'someuser',
    password: PW,
    remember: '0',
  });

  assert.equal(getPageCalls.length, 0, 'browser.getPage must NOT be called for credential-save-only /api/login');
  assert.equal(savedArgs.length, 0, 'keychain.saveCredential must be skipped when remember is false');
  assert.equal(result.status, 'ok');
  assert.equal(result.platform, 'lazada');
  assert.equal(result.account, 'CHEARB');
  assert.equal(result.credential.requested, false);
  assert.equal(result.credential.saved, false);
  assert.equal(result.credential.status, 'credential_save_skipped');
  assert.equal('login' in result, false, 'credential-only response must not expose a login automation report');

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(PW), false, 'password must not appear anywhere in /api/login response');
});

test('handleLoginOnly defaults remember to true when the field is missing and saves credential without touching the browser', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called by handleLoginOnly');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const PW = 'default-remember-pw-!@#';
  const result = await server.handleLoginOnly({
    platform: 'shopee',
    account: 'CHEARB',
    username: 'cheargby',
    password: PW,
    // remember intentionally omitted -> must default to true
  });

  assert.equal(getPageCalls.length, 0, 'browser.getPage must NOT be called');
  assert.equal(savedArgs.length, 1, 'keychain.saveCredential must be called when remember defaults to true');
  assert.equal(savedArgs[0][0], 'shopee');
  assert.equal(savedArgs[0][1], 'CHEARB');
  assert.equal(savedArgs[0][2], 'cheargby');
  assert.equal(savedArgs[0][3], PW);
  assert.equal(result.credential.requested, true);
  assert.equal(result.credential.saved, true);
  assert.equal(result.credential.status, 'credential_saved');
  assert.equal(JSON.stringify(result).includes(PW), false, 'password must not appear in response payload');
});

test('handleLoginOnly defaults remember to true when the field is an empty string', async (t) => {
  const originalGetPage = browser.getPage;
  browser.getPage = async () => { throw new Error('browser.getPage must not be called by handleLoginOnly'); };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const result = await server.handleLoginOnly({
    platform: 'lazada',
    username: 'someuser',
    password: 'pw1',
    remember: '',
  });

  assert.equal(savedArgs.length, 1, 'empty remember defaults to true and saves');
  assert.equal(result.credential.requested, true);
  assert.equal(result.credential.saved, true);
  assert.equal(result.credential.status, 'credential_saved');
});

test('handleLoginOnly with remember:true saves credential via keychain and never echoes password', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called by handleLoginOnly');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const PW = 'remember-me-pw_!@#';
  const result = await server.handleLoginOnly({
    platform: 'shopee',
    account: 'CHEARB',
    username: 'cheargby',
    password: PW,
    remember: '1',
  });

  assert.equal(getPageCalls.length, 0, 'browser.getPage must NOT be called by /api/login');
  assert.equal(savedArgs.length, 1, 'keychain.saveCredential must be called');
  assert.equal(savedArgs[0][0], 'shopee');
  assert.equal(savedArgs[0][1], 'CHEARB');
  assert.equal(savedArgs[0][2], 'cheargby');
  assert.equal(savedArgs[0][3], PW, 'keychain must receive the actual password (not redacted) for storage');
  assert.equal(result.credential.requested, true);
  assert.equal(result.credential.saved, true);
  assert.equal(result.credential.status, 'credential_saved');
  assert.equal(JSON.stringify(result).includes(PW), false, 'password must not appear in response payload');
});

test('handleLoginOnly derives account from sanitizeAccount(username) when body.account is missing', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called by handleLoginOnly');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const result = await server.handleLoginOnly({
    platform: 'shopee',
    // no account field at all
    username: 'cheargby',
    password: 'pw1',
    remember: '0',
  });
  assert.equal(getPageCalls.length, 0);
  assert.equal(savedArgs.length, 0, 'remember:0 must skip saving');
  assert.equal(result.account, 'cheargby', 'account must be derived from username');
  assert.equal(result.credential.status, 'credential_save_skipped');
});

test('handleLoginOnly derives account from username when body.account is an empty/whitespace string', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called by handleLoginOnly');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const result = await server.handleLoginOnly({
    platform: 'lazada',
    account: '   ',
    username: 'someone',
    password: 'pw1',
  });
  assert.equal(getPageCalls.length, 0);
  assert.equal(result.account, 'someone');
  // remember defaults to true -> credential is saved against derived account
  assert.equal(savedArgs.length, 1);
  assert.equal(savedArgs[0][1], 'someone');
});

test('handleLoginOnly sanitizes email-style username affiliate@neezs.com -> affiliate_neezs.com when account is omitted', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called by handleLoginOnly');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const result = await server.handleLoginOnly({
    platform: 'shopee',
    username: 'affiliate@neezs.com',
    password: 'pw1',
  });
  assert.equal(getPageCalls.length, 0);
  assert.equal(result.account, 'affiliate_neezs.com');
  assert.equal(savedArgs.length, 1);
  assert.equal(savedArgs[0][1], 'affiliate_neezs.com');
});

test('handleLoginOnly honors explicit account when provided (legacy API compat)', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called by handleLoginOnly');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const result = await server.handleLoginOnly({
    platform: 'shopee',
    account: 'CHEARB',
    username: 'affiliate@neezs.com',
    password: 'pw1',
  });
  assert.equal(getPageCalls.length, 0);
  assert.equal(result.account, 'CHEARB', 'explicit account must take priority over derived');
  assert.equal(savedArgs.length, 1);
  assert.equal(savedArgs[0][1], 'CHEARB');
});

test('attemptReauthWithStoredCredential uses stored credential and reports manual challenge without leaking password', async (t) => {
  const originalGetPage = browser.getPage;
  const calls = [];
  const PW = 'reauth-secret-password-never-returned';

  browser.getPage = async (...args) => {
    calls.push(args);
    return {
      page: {
        url: () => 'https://affiliate.shopee.co.th/login',
        bringToFront: async () => {},
        goto: async () => {},
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        content: async () => '<html><body>OTP verification required</body></html>',
      },
    };
  };
  t.after(() => { browser.getPage = originalGetPage; });

  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => ({ username: 'stored-user', password: PW }),
  });

  const result = await server.attemptReauthWithStoredCredential('shopee', 'CHEARB', {
    headless: true,
    forceNew: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.manualLoginRequired, true);
  assert.equal(result.reason, 'captcha_or_otp_detected');
  assert.deepEqual(calls[0][2], { headless: true, forceNew: true });
  assert.equal(JSON.stringify(result).includes(PW), false, 'password must not appear in reauth result');
});

test('attemptReauthWithStoredCredential returns keychain_credential_not_found metadata when absent', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called without a stored credential');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const lookups = [];
  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async (platform, account) => {
      lookups.push({ platform, account });
      return null;
    },
  });

  const result = await server.attemptReauthWithStoredCredential('shopee', 'CHEARB', {
    headless: true,
    forceNew: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.manualLoginRequired, true);
  assert.equal(result.reason, 'keychain_credential_not_found');
  assert.equal(result.keychainCredential.present, false);
  assert.deepEqual(result.keychainCredential.checkedAccounts, [
    'CHEARB',
    'chearb',
    'affiliate_chearb.com',
    'affiliate_chearb',
  ]);
  assert.ok(result.keychainCredential.expectedServices.includes(
    'com.affiliate.shortlink-cloak.shopee.affiliate_chearb.com',
  ));
  assert.equal(result.diagnostic.reason, 'keychain_credential_not_found');
  assert.equal(getPageCalls.length, 0);
  assert.deepEqual(lookups.map((it) => it.account), [
    'CHEARB',
    'chearb',
    'affiliate_chearb.com',
    'affiliate_chearb',
  ]);
  assert.equal(/password|secret/i.test(JSON.stringify(result)), false);
});

test('attemptReauthWithStoredCredential reports Shopee affiliate 404 as route-not-found without leaking password', async (t) => {
  const originalGetPage = browser.getPage;
  const calls = [];
  const navigations = [];
  const PW = 'route-404-secret-password-never-returned';

  browser.getPage = async (...args) => {
    calls.push(args);
    return {
      page: {
        url: () => 'https://affiliate.shopee.co.th/404',
        bringToFront: async () => {},
        goto: async (...gotoArgs) => { navigations.push(gotoArgs); },
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        mainFrame: () => null,
        frames: () => [],
        evaluate: async (_fn, arg) => {
          if (arg && arg.action === 'capture-login-diagnostics') {
            return {
              ...arg.meta,
              title: 'Shopee Affiliate Program',
              inputCount: 0,
              inputs: [],
              textSnippets: [
                'Affiliate Program',
                'Not Found',
                'The page you are visiting does not exist',
                'Back to homepage',
              ],
              blockerMarkers: [],
            };
          }
          return null;
        },
      },
    };
  };
  t.after(() => { browser.getPage = originalGetPage; });

  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => ({ username: 'stored-user@example.com', password: PW }),
  });

  const result = await server.attemptReauthWithStoredCredential('shopee', 'CHEARB', {
    headless: true,
    forceNew: true,
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, false);
  assert.equal(result.manualLoginRequired, true);
  assert.equal(result.reason, 'shopee_custom_link_route_not_found');
  assert.equal(result.diagnostic.reason, 'shopee_custom_link_route_not_found');
  assert.equal(result.diagnostic.domain, 'affiliate.shopee.co.th');
  assert.equal(serialized.includes('username_field_not_found'), false);
  assert.equal(serialized.includes(PW), false, 'password must not appear in reauth result');
  assert.equal(serialized.includes('stored-user@example.com'), false, 'username must be redacted in diagnostics');
  assert.equal(calls[0][0], 'shopee');
  assert.deepEqual(calls[0][2], { headless: true, forceNew: true });
  assert.match(navigations[0][0], /shopee\.co\.th\/buyer\/login/);
});

test('credentialAccountCandidates maps legacy account aliases without changing sanitizeAccount', () => {
  assert.deepEqual(
    server.credentialAccountCandidates('CHEARB'),
    ['CHEARB', 'chearb', 'affiliate_chearb.com', 'affiliate_chearb'],
  );
  assert.deepEqual(
    server.credentialAccountCandidates('affiliate_chearb.com'),
    ['affiliate_chearb.com'],
  );
});

test('attemptReauthWithStoredCredential can use a unique stored credential alias without changing profile account', async (t) => {
  const originalGetPage = browser.getPage;
  const calls = [];
  const keychainLookups = [];
  const PW = 'alias-reauth-secret-never-returned';

  browser.getPage = async (...args) => {
    calls.push(args);
    return {
      page: {
        url: () => 'https://affiliate.shopee.co.th/',
        bringToFront: async () => {},
        goto: async () => {},
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        content: async () => '<html><body>login form here</body></html>',
        fill: async () => {},
        click: async () => {},
        keyboard: { press: async () => {} },
      },
    };
  };
  t.after(() => { browser.getPage = originalGetPage; });

  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async (platform, account) => {
      keychainLookups.push({ platform, account });
      if (platform === 'shopee' && account === 'affiliate_chearb.com') {
        return { username: 'stored-user', password: PW };
      }
      return null;
    },
  });

  const result = await server.attemptReauthWithStoredCredential('shopee', 'CHEARB', {
    headless: true,
    forceNew: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reuseAuthenticatedContext, true);
  assert.deepEqual(keychainLookups.map((it) => it.account), ['CHEARB', 'chearb', 'affiliate_chearb.com']);
  assert.deepEqual(calls[0], ['shopee', 'CHEARB', { headless: true, forceNew: true }]);
  assert.equal(JSON.stringify(result).includes(PW), false, 'password must not appear in reauth result');
});

test('attemptReauthWithStoredCredential treats authenticated Shopee affiliate origin as success', async (t) => {
  const originalGetPage = browser.getPage;
  t.after(() => { browser.getPage = originalGetPage; });

  const PW = 'authenticated-origin-secret-never-returned';
  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => ({ username: 'stored-user', password: PW }),
  });

  for (const authenticatedUrl of [
    'https://affiliate.shopee.co.th/dashboard',
    'https://affiliate.shopee.co.th/',
  ]) {
    let currentUrl = 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2F';

    browser.getPage = async () => ({
      page: {
        url: () => currentUrl,
        bringToFront: async () => {},
        goto: async () => { currentUrl = authenticatedUrl; },
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        content: async () => {
          throw new Error('attemptLogin should not inspect an already authenticated dashboard');
        },
      },
    });

    const result = await server.attemptReauthWithStoredCredential('shopee', 'CHEARB', {
      headless: true,
      forceNew: true,
    });

    assert.equal(result.ok, true, authenticatedUrl);
    assert.equal(result.manualLoginRequired, false, authenticatedUrl);
    assert.equal(result.alreadyAuthenticated, true, authenticatedUrl);
    assert.equal(result.reuseAuthenticatedContext, true, authenticatedUrl);
    assert.equal(JSON.stringify(result).includes(PW), false, 'password must not appear in reauth result');
  }
});

test('buildManualLoginRequiredPayload preserves manual-login JSON contract with explicit flags', () => {
  const err = new Error('MANUAL_LOGIN_REQUIRED');
  err.reason = 'captcha_or_otp_detected';
  err.diagnostic = {
    reason: 'captcha_or_otp_detected',
    domain: 'shopee.co.th',
    title: 'Shopee Login',
    frameCount: 1,
    frames: [
      {
        index: 0,
        kind: 'page',
        url: 'https://shopee.co.th/buyer/login?next=%5BREDACTED%5D',
        domain: 'shopee.co.th',
        inputCount: 1,
        inputs: [{ tag: 'input', type: 'text', name: 'loginKey', visible: false }],
        textSnippets: ['Phone number / Username / Email'],
        blockerMarkers: ['qr_login'],
      },
    ],
  };
  const payload = server.buildManualLoginRequiredPayload({
    account: 'CHEARB',
    url: 'https://shopee.co.th/-i.6817918.28499498718',
    sub1: 'yok',
  }, err);

  assert.equal(payload.status, 'manual_login_required');
  assert.equal(payload.error, 'manual_login_required');
  assert.equal(payload.manualLoginRequired, true);
  assert.equal(payload.needsManual, true);
  assert.equal(payload.reason, 'captcha_or_otp_detected');
  assert.equal(payload.platform, 'shopee');
  assert.equal(payload.account, 'CHEARB');
  assert.equal(payload.loginUi, '/login?platform=shopee');
  assert.equal(payload.debug, '/debug');
  assert.equal(payload.diagnostic.domain, 'shopee.co.th');
  assert.equal(payload.diagnostic.frames[0].inputs[0].name, 'loginKey');
  assert.equal(/password|secret|cookie|token/i.test(JSON.stringify(payload.diagnostic)), false);
});

test('handleDebug exposes only sanitized recent login diagnostics', () => {
  const err = new Error('MANUAL_LOGIN_REQUIRED');
  err.reason = 'username_field_not_found';
  err.diagnostic = {
    reason: 'username_field_not_found',
    domain: 'shopee.co.th',
    title: 'Shopee Login',
    frameCount: 1,
    frames: [
      {
        index: 0,
        kind: 'page',
        domain: 'shopee.co.th',
        inputCount: 0,
        inputs: [],
        textSnippets: ['Login form rendered without a username textbox'],
        blockerMarkers: [],
      },
    ],
  };
  server.buildManualLoginRequiredPayload({
    account: 'CHEARB',
    url: 'https://shopee.co.th/-i.1.2',
  }, err);

  const debug = server.handleDebug();
  assert.ok(Array.isArray(debug.recentLoginDiagnostics));
  assert.ok(debug.recentLoginDiagnostics.length >= 1);
  assert.equal(debug.recentLoginDiagnostics[0].reason, 'username_field_not_found');
  assert.equal(debug.recentLoginDiagnostics[0].account, 'CHEARB');
  assert.equal(JSON.stringify(debug.recentLoginDiagnostics).includes('password'), false);
});

test('POST /api/login derives account from username when body has no account field', async (t) => {
  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must not be called by /api/login');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  const savedArgs = [];
  stubKeychain(t, {
    isSupported: () => true,
    saveCredential: async (...args) => { savedArgs.push(args); return { service: 'svc', username: args[2] }; },
  });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    method: 'POST',
    path: '/api/login',
    body: {
      platform: 'shopee',
      username: 'affiliate@neezs.com',
      password: 'pw1',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(getPageCalls.length, 0, 'browser.getPage must NOT be called by /api/login');
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.account, 'affiliate_neezs.com', 'server must derive account from username when body.account missing');
  assert.equal(savedArgs.length, 1);
  assert.equal(savedArgs[0][1], 'affiliate_neezs.com');
  assert.equal(parsed.credential.saved, true);
  assert.equal(parsed.credential.status, 'credential_saved');
});

test('handleLoginAndShorten derives account from sanitizeAccount(username) when body.account is missing, and propagates it to handleShorten', async (t) => {
  const originalGetPage = browser.getPage;
  const originalFetch = global.fetch;
  const calls = [];

  browser.getPage = async (platform, account, opts) => {
    calls.push({ platform, account, opts });
    if (opts && opts.forceVisible) {
      return {
        page: {
          bringToFront: async () => {},
          goto: async () => {},
          waitForLoadState: async () => {},
          waitForTimeout: async () => {},
          content: async () => '<html><body>login form here</body></html>',
          fill: async () => {},
          click: async () => {},
          keyboard: { press: async () => {} },
        },
      };
    }
    return {
      page: {
        url: () => 'https://shopee.co.th/',
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => { throw new Error('intentional_stub_evaluate_failure'); },
      },
    };
  };
  global.fetch = async () => { throw new Error('network_disabled_in_test'); };

  t.after(() => {
    browser.getPage = originalGetPage;
    global.fetch = originalFetch;
  });

  const result = await server.handleLoginAndShorten({
    platform: 'shopee',
    // no account
    username: 'affiliate@neezs.com',
    password: 'pw1',
    url: 'https://shopee.co.th/-i.123.456',
  });
  assert.equal(result.account, 'affiliate_neezs.com');

  const loginCall = calls.find((c) => c.opts && c.opts.forceVisible);
  assert.ok(loginCall, 'getPage must be called for the login window');
  assert.equal(loginCall.account, 'affiliate_neezs.com');
});

test('handleLoginAndShorten honors explicit account when provided (legacy API compat)', async (t) => {
  const originalGetPage = browser.getPage;
  const originalFetch = global.fetch;
  const calls = [];

  browser.getPage = async (platform, account, opts) => {
    calls.push({ platform, account, opts });
    if (opts && opts.forceVisible) {
      return {
        page: {
          bringToFront: async () => {},
          goto: async () => {},
          waitForLoadState: async () => {},
          waitForTimeout: async () => {},
          content: async () => '<html><body>login form here</body></html>',
          fill: async () => {},
          click: async () => {},
          keyboard: { press: async () => {} },
        },
      };
    }
    return {
      page: {
        url: () => 'https://shopee.co.th/',
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => { throw new Error('intentional_stub_evaluate_failure'); },
      },
    };
  };
  global.fetch = async () => { throw new Error('network_disabled_in_test'); };

  t.after(() => {
    browser.getPage = originalGetPage;
    global.fetch = originalFetch;
  });

  const result = await server.handleLoginAndShorten({
    platform: 'shopee',
    account: 'CHEARB',
    username: 'affiliate@neezs.com',
    password: 'pw1',
    url: 'https://shopee.co.th/-i.123.456',
  });
  assert.equal(result.account, 'CHEARB');
  const loginCall = calls.find((c) => c.opts && c.opts.forceVisible);
  assert.ok(loginCall);
  assert.equal(loginCall.account, 'CHEARB');
});

test('handleLoginAndShorten opens headed forceVisible window, attempts shorten, never echoes password', async (t) => {
  const originalGetPage = browser.getPage;
  const originalFetch = global.fetch;
  const calls = [];

  browser.getPage = async (platform, account, opts) => {
    calls.push({ platform, account, opts });
    if (opts && opts.forceVisible) {
      return {
        page: {
          bringToFront: async () => {},
          goto: async () => {},
          waitForLoadState: async () => {},
          waitForTimeout: async () => {},
          content: async () => '<html><body>login form here</body></html>',
          fill: async () => {},
          click: async () => {},
          keyboard: { press: async () => {} },
        },
      };
    }
    return {
      page: {
        url: () => 'https://shopee.co.th/',
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => { throw new Error('intentional_stub_evaluate_failure'); },
      },
    };
  };
  global.fetch = async () => { throw new Error('network_disabled_in_test'); };

  t.after(() => {
    browser.getPage = originalGetPage;
    global.fetch = originalFetch;
  });

  const PW = 'TopSecret!123_should_never_appear';
  const result = await server.handleLoginAndShorten({
    platform: 'shopee',
    account: 'CHEARB',
    username: 'someuser',
    password: PW,
    url: 'https://shopee.co.th/-i.123.456',
    sub1: 'yo',
  });

  const loginCall = calls.find((c) => c.opts && c.opts.forceVisible);
  assert.ok(loginCall, 'getPage must be called for the login window');
  assert.equal(loginCall.platform, 'shopee');
  assert.equal(loginCall.account, 'CHEARB');
  assert.deepEqual(loginCall.opts, { headless: false, forceVisible: true });

  assert.equal(result.login.filled, true, 'login should report filled true with stub page');
  assert.equal(result.login.submitted, true, 'login should report submitted true with stub page');
  assert.ok(result.shortenError, 'shorten should fail with the stubbed evaluate');
  assert.equal(result.shorten, null);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(PW), false, 'password must not appear anywhere in response payload');
});

// --- Production hardening: pre-shorten readiness gate -----------------------

test('handleAccounts marks directory-only profile as not ready (profileExists but no credential, no session probe)', async (t) => {
  server._resetSessionStateCacheForTest();
  t.after(() => server._resetSessionStateCacheForTest());

  const profileRoot = process.env.AFFILIATE_CLOAK_PROFILE_DIR;
  const dirOnly = path.join(profileRoot, 'shopee', 'orphan_directory_only');
  fs.mkdirSync(dirOnly, { recursive: true });

  stubKeychain(t, {
    isSupported: () => true,
    listCredentials: async () => [],
    hasCredential: async () => null,
  });

  const a = await server.handleAccounts();
  const entry = a.sessionState && a.sessionState.shopee && a.sessionState.shopee['orphan_directory_only'];
  assert.ok(entry, 'directory-only profile must surface in sessionState');
  assert.equal(entry.credentialPresent, false);
  assert.equal(entry.profileExists, true);
  assert.equal(entry.sessionValid, null);
  assert.equal(entry.customLinkAuthenticated, null);
  assert.equal(entry.ready, false, 'directory-only profile must NEVER report ready=true');
  assert.equal(entry.needsManual, true);
});

test('handleAccounts readiness fields include credentialPresent, profileExists, loaded, launchMode, sessionValid, customLinkAuthenticated, lastCheckedAt, ready, needsManual', async (t) => {
  server._resetSessionStateCacheForTest();
  t.after(() => server._resetSessionStateCacheForTest());

  const profileRoot = process.env.AFFILIATE_CLOAK_PROFILE_DIR;
  fs.mkdirSync(path.join(profileRoot, 'shopee', 'readiness_validated'), { recursive: true });

  stubKeychain(t, {
    isSupported: () => true,
    listCredentials: async () => [],
    hasCredential: async (platform, account) => (
      platform === 'shopee' && account === 'readiness_validated'
        ? { service: 'svc', username: 'redacted' }
        : null
    ),
  });

  server.recordSessionState('shopee', 'readiness_validated', {
    sessionValid: true,
    customLinkAuthenticated: true,
    currentUrl: 'https://affiliate.shopee.co.th/offer/custom_link',
  });

  const a = await server.handleAccounts();
  const entry = a.sessionState.shopee['readiness_validated'];
  assert.ok(entry, 'validated account must appear in sessionState');
  for (const field of [
    'credentialPresent',
    'profileExists',
    'loaded',
    'launchMode',
    'sessionValid',
    'customLinkAuthenticated',
    'currentUrl',
    'lastCheckedAt',
    'lastSuccessAt',
    'lastFailureReason',
    'needsManual',
    'ready',
  ]) {
    assert.ok(field in entry, `sessionState must expose readiness field: ${field}`);
  }
  assert.equal(entry.credentialPresent, true);
  assert.equal(entry.profileExists, true);
  assert.equal(entry.sessionValid, true);
  assert.equal(entry.customLinkAuthenticated, true);
  assert.equal(entry.ready, true);
  assert.equal(entry.needsManual, false);
  assert.ok(entry.lastSuccessAt, 'lastSuccessAt must be set after a successful session record');

  const serialized = JSON.stringify(a.sessionState);
  assert.equal(
    /password|cookie|token|csrf|secret/i.test(serialized),
    false,
    'sessionState must contain no secrets',
  );
});

test('handleShorten fails fast with keychain_credential_not_found when account has no credential — never opens a browser', async (t) => {
  server._resetSessionStateCacheForTest();
  t.after(() => server._resetSessionStateCacheForTest());

  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must NOT be called when account has no credential');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => null,
    hasCredential: async () => null,
    listCredentials: async () => [],
  });

  let thrown;
  try {
    await server.handleShorten({
      account: 'blank_no_credential',
      url: 'https://shopee.co.th/-i.6817918.28499498718',
      sub1: 'yok',
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'preflight must throw before reaching shortenShopee');
  assert.equal(thrown.manualLoginRequired, true);
  assert.equal(thrown.reason, 'keychain_credential_not_found');
  assert.equal(getPageCalls.length, 0, 'browser.getPage must not be called for an unauthenticated account');
  assert.ok(thrown.keychainCredential, 'error must carry keychainCredential metadata');
  assert.equal(thrown.keychainCredential.present, false);
  assert.ok(
    Array.isArray(thrown.keychainCredential.expectedServices)
    && thrown.keychainCredential.expectedServices.length > 0,
    'expectedServices must list keychain service candidates so operators know what to add',
  );
  assert.ok(Array.isArray(thrown.readyAccounts), 'error must include readyAccounts list (may be empty)');

  // The unauthenticated account is now tracked in sessionState as not ready.
  const snap = server.getSessionStateSnapshot('shopee', 'blank_no_credential');
  assert.ok(snap, 'pre-shorten gate must record the rejection in sessionState');
  assert.equal(snap.sessionValid, false);
  assert.equal(snap.needsManual, true);
});

test('GET /?url=...&account=blank returns manual_login_required payload (no browser call, no batch API call)', async (t) => {
  server._resetSessionStateCacheForTest();
  t.after(() => server._resetSessionStateCacheForTest());

  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must NOT be called when account has no credential');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => null,
    hasCredential: async () => null,
    listCredentials: async () => [],
  });

  const instance = await startTestServer();
  t.after(() => stopTestServer(instance));

  const res = await httpRequest(instance, {
    method: 'GET',
    path: '/?url=' + encodeURIComponent('https://shopee.co.th/-i.6817918.28499498718') + '&account=blank_no_credential&sub1=yok',
  });
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.status, 'manual_login_required');
  assert.equal(parsed.manualLoginRequired, true);
  assert.equal(parsed.reason, 'keychain_credential_not_found');
  assert.equal(parsed.platform, 'shopee');
  assert.equal(parsed.account, 'blank_no_credential');
  assert.ok(parsed.keychainCredential, 'manual_login_required payload must surface keychainCredential metadata');
  assert.equal(parsed.keychainCredential.present, false);
  assert.ok(Array.isArray(parsed.readyAccounts), 'payload must include readyAccounts list (metadata only)');
  assert.equal(getPageCalls.length, 0, 'no browser call should have been made');
});

test('handleShorten with known-invalid Shopee session re-validates via Keychain reauth and refuses batchCustomLink when reauth fails', async (t) => {
  server._resetSessionStateCacheForTest();
  t.after(() => server._resetSessionStateCacheForTest());

  const PW = 'invalid-session-reauth-pw-never-returned';
  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => null,
    hasCredential: async (platform, account) => (
      platform === 'shopee' && account === 'CHEARB'
        ? { service: 'svc', username: 'redacted' }
        : null
    ),
    listCredentials: async () => [],
  });

  // Mark the session as known-invalid so the gate must re-validate via reauth.
  server.recordSessionState('shopee', 'CHEARB', {
    sessionValid: false,
    customLinkAuthenticated: false,
    reason: 'shopee_custom_link_login_required',
  });

  const originalGetPage = browser.getPage;
  const getPageCalls = [];
  // attemptReauthWithStoredCredential first looks up findCredential — we
  // stubbed it to return null, so reauth returns keychain_credential_not_found
  // WITHOUT touching the browser. The preflight then surfaces the manual
  // requirement and shortenShopee/batchCustomLink is never reached.
  browser.getPage = async (...args) => {
    getPageCalls.push(args);
    throw new Error('browser.getPage must NOT be called when session is known-invalid and reauth has no credential');
  };
  t.after(() => { browser.getPage = originalGetPage; });

  let thrown;
  try {
    await server.handleShorten({
      account: 'CHEARB',
      url: 'https://shopee.co.th/-i.6817918.28499498718',
      sub1: 'yok',
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'preflight must throw when session is invalid and reauth cannot recover');
  assert.equal(thrown.manualLoginRequired, true);
  assert.equal(getPageCalls.length, 0, 'no batch API path should have run');
  assert.equal(JSON.stringify(thrown).includes(PW), false, 'password must never appear in error payload');
});

test('attemptReauthWithStoredCredential populates sessionState after a successful protected-route probe', async (t) => {
  server._resetSessionStateCacheForTest();
  t.after(() => server._resetSessionStateCacheForTest());

  const PW = 'protected-route-probe-secret-never-returned';
  stubKeychain(t, {
    isSupported: () => true,
    findCredential: async () => ({ username: 'stored-user@example.com', password: PW }),
  });

  let currentUrl = 'https://affiliate.shopee.co.th/dashboard';
  const originalGetPage = browser.getPage;
  browser.getPage = async () => ({
    page: {
      url: () => currentUrl,
      bringToFront: async () => {},
      goto: async (target) => {
        if (target && String(target).includes('/offer/custom_link')) {
          currentUrl = 'https://affiliate.shopee.co.th/offer/custom_link';
          return;
        }
        currentUrl = 'https://affiliate.shopee.co.th/dashboard';
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
    },
  });
  t.after(() => { browser.getPage = originalGetPage; });

  const result = await server.attemptReauthWithStoredCredential('shopee', 'CHEARB', {
    headless: true,
    forceNew: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionValid, true);
  assert.equal(result.customLinkAuthenticated, true);

  const snap = server.getSessionStateSnapshot('shopee', 'CHEARB');
  assert.ok(snap, 'protected-route probe must populate sessionState');
  assert.equal(snap.sessionValid, true);
  assert.equal(snap.customLinkAuthenticated, true);
  assert.ok(snap.lastCheckedAt, 'lastCheckedAt must be stamped');
  assert.ok(snap.lastSuccessAt, 'lastSuccessAt must be stamped on a successful probe');
  assert.equal(snap.needsManual, false);
  assert.equal(JSON.stringify(snap).includes(PW), false, 'sessionState must not contain the password');
});

test('handleShorten skips preflight when a fresh sessionValid snapshot exists (no extra reauth, no keychain lookup needed)', async (t) => {
  server._resetSessionStateCacheForTest();
  t.after(() => server._resetSessionStateCacheForTest());

  server.recordSessionState('shopee', 'fresh_authenticated_acct', {
    sessionValid: true,
    customLinkAuthenticated: true,
  });

  let keychainLookups = 0;
  stubKeychain(t, {
    isSupported: () => true,
    hasCredential: async () => { keychainLookups++; return null; },
    findCredential: async () => { keychainLookups++; return null; },
  });

  // Preflight should be a no-op; the shortenShopee call below would fail
  // independently, so we only assert the preflight didn't call the keychain.
  // To prove that, we call the exported helper directly.
  await server.ensureShopeeReadyForShorten('fresh_authenticated_acct');
  assert.equal(keychainLookups, 0, 'fresh valid session must not trigger a keychain lookup');
});
