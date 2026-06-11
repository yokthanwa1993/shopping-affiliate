'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testProfileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'affiliate-cloak-shopee-test-'));
process.env.AFFILIATE_CLOAK_PROFILE_DIR = testProfileRoot;
process.on('exit', () => {
  fs.rmSync(testProfileRoot, { recursive: true, force: true });
});

const browser = require('../src/browser');
const {
  shortenShopee,
  isSessionLikelyExpired,
  isContextDestroyed,
  isTransientApiError,
  isShopeeFailCode3,
  isShopeeOffDomainRedirect,
  isShopeeSessionApiError,
  isTimeoutError,
  isRecoverableShortenError,
  isFallbackEligibleError,
  sanitizeShopeeErrorMessageForLog,
  _resetLastSuccessCache,
  _SHOPEE_SHORTEN_SCRIPT_FOR_TEST,
  _buildShortlinkBodyForTest,
  _sanitizeShopeeSubIdForTest,
} = require('../src/shopee');
const {
  SHOPEE_ROUTE_NOT_FOUND_REASON,
  isShopeeRouteNotFoundUrl,
} = require('../src/shopee-route');

function makePage(evaluateImpl, extras = {}) {
  return {
    url: () => 'https://affiliate.shopee.co.th/offer/custom_link',
    goto: async () => {},
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    evaluate: evaluateImpl,
    ...extras,
  };
}

function withBrowserStubs(stubs) {
  const originals = {
    getPage: browser.getPage,
    ensureOnPlatformPage: browser.ensureOnPlatformPage,
  };
  if (stubs.getPage) browser.getPage = stubs.getPage;
  if (stubs.ensureOnPlatformPage) browser.ensureOnPlatformPage = stubs.ensureOnPlatformPage;
  return () => {
    browser.getPage = originals.getPage;
    browser.ensureOnPlatformPage = originals.ensureOnPlatformPage;
  };
}

test('isContextDestroyed flags page.evaluate navigation errors', () => {
  assert.equal(
    isContextDestroyed(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')),
    true,
  );
  assert.equal(isContextDestroyed(new Error('Execution context was destroyed.')), true);
  assert.equal(isContextDestroyed(new Error('Frame was detached')), true);
  assert.equal(isContextDestroyed(new Error('Target closed')), true);
  assert.equal(isContextDestroyed(new Error('Target page, context or browser has been closed')), true);
  assert.equal(isContextDestroyed(new Error('Page has been closed')), true);
});

test('isContextDestroyed does NOT flag unrelated errors', () => {
  assert.equal(isContextDestroyed(new Error('failCode: 50001')), false);
  assert.equal(isContextDestroyed(new Error('No shortLink from Shopee: {}')), false);
  assert.equal(isContextDestroyed(new Error('intentional_stub_evaluate_failure')), false);
  assert.equal(isContextDestroyed(null), false);
  assert.equal(isContextDestroyed(undefined), false);
});

test('isSessionLikelyExpired keeps recognising session/network errors', () => {
  assert.equal(isSessionLikelyExpired(new Error('SESSION_EXPIRED')), true);
  assert.equal(isSessionLikelyExpired(new Error('HTTP 401 UNAUTHORIZED')), true);
  assert.equal(isSessionLikelyExpired(new Error('Failed to fetch')), true);
  // Note: 'Frame was detached' contains 'ABORTED'-like? no, it doesn't. Just guard.
  assert.equal(isSessionLikelyExpired(new Error('Execution context was destroyed, most likely because of a navigation')), false);
});

test('isRecoverableShortenError combines session + nav classifiers', () => {
  assert.equal(isRecoverableShortenError(new Error('SESSION_EXPIRED')), true);
  assert.equal(
    isRecoverableShortenError(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')),
    true,
  );
  assert.equal(isRecoverableShortenError(new Error('failCode: 50001')), false);
});

test('isTransientApiError flags Shopee 90309999 "No results" envelope', () => {
  const noResults90309999 = new Error(
    'No results: {"data":{"batchCustomLink":null},"errors":[{"message":"failed to dispatch","code":90309999,"path":["batchCustomLink"]}]}',
  );
  assert.equal(isTransientApiError(noResults90309999), true);
  assert.equal(isRecoverableShortenError(noResults90309999), true);
});

test('isTransientApiError does NOT flag unrelated No results envelopes or failCodes', () => {
  // Different upstream error code — not the known transient one.
  assert.equal(
    isTransientApiError(new Error('No results: {"errors":[{"code":12345}]}')),
    false,
  );
  // failCode is on a populated result, not the empty envelope path.
  assert.equal(isTransientApiError(new Error('failCode: 90309999')), false);
  assert.equal(isTransientApiError(new Error('failCode: 50001')), false);
  assert.equal(isRecoverableShortenError(new Error('failCode: 50001')), false);
});

test('Shopee failCode 3 is retryable but never fallback-cache eligible', () => {
  const err = new Error('failCode: 3');
  assert.equal(isShopeeFailCode3(err), true);
  assert.equal(isRecoverableShortenError(err), true);
  assert.equal(isFallbackEligibleError(err), false);
  assert.equal(isShopeeFailCode3(new Error('failCode: 50001')), false);
});

test('Shopee off-domain redirect is a session signal, not cache-fallback eligible', () => {
  const err = new Error('Execution context was destroyed: redirected off affiliate.shopee.co.th');
  assert.equal(isShopeeOffDomainRedirect(err), true);
  assert.equal(isSessionLikelyExpired(err), true);
  assert.equal(isRecoverableShortenError(err), true);
  assert.equal(isFallbackEligibleError(err), false);
});

test('sanitizeShopeeErrorMessageForLog redacts request cookies and auth headers', () => {
  const raw = [
    'apiRequestContext.post: socket hang up',
    '  - cookie: SPC_EC=secret; csrftoken=csrf-secret; _ga=ga-secret',
    '  - csrf-token: csrf-secret',
    '  - authorization: Bearer token-secret',
    '  - referer: https://affiliate.shopee.co.th/',
  ].join('\n');
  const safe = sanitizeShopeeErrorMessageForLog(raw);
  assert.match(safe, /cookie: \[REDACTED\]/);
  assert.match(safe, /csrf-token: \[REDACTED\]/);
  assert.match(safe, /authorization: \[REDACTED\]/);
  assert.equal(/secret|token-secret|csrf-secret|ga-secret/.test(safe), false);
  assert.match(safe, /referer: https:\/\/affiliate\.shopee\.co\.th\//);
});

test('Shopee subId sanitizer keeps only alphanumeric chars and caps at 64', () => {
  assert.equal(_sanitizeShopeeSubIdForTest('canonical_probe'), 'canonicalprobe');
  assert.equal(_sanitizeShopeeSubIdForTest('HERMES-TEST'), 'HERMESTEST');
  assert.equal(_sanitizeShopeeSubIdForTest('abc_123'), 'abc123');
  assert.equal(_sanitizeShopeeSubIdForTest('!@#$'), '');
  assert.equal(_sanitizeShopeeSubIdForTest('A'.repeat(70)), 'A'.repeat(64));
});

test('buildShortlinkBody sanitizes Shopee subIds and omits empty advancedLinkParams', () => {
  const body = _buildShortlinkBodyForTest('https://shopee.co.th/product/1/2', [
    'canonical_probe',
    'HERMES-TEST',
    'abc_123',
    'A'.repeat(70),
    '---',
  ]);
  assert.deepEqual(body.variables.linkParams[0].advancedLinkParams, {
    subId1: 'canonicalprobe',
    subId2: 'HERMESTEST',
    subId3: 'abc123',
    subId4: 'A'.repeat(64),
    subId5: '',
  });

  const omitted = _buildShortlinkBodyForTest('https://shopee.co.th/product/1/2', [
    '___',
    '---',
    ' ',
    '',
    null,
  ]);
  assert.equal('advancedLinkParams' in omitted.variables.linkParams[0], false);
});

test('Shopee 90309999 not-logged-in envelope is session-shaped, not cache fallback eligible', () => {
  const err = new Error(
    'No results: {"0":3,"1":"abc","2":false,"3":90309999,"4":2,"5":false,"error":90309999}',
  );
  assert.equal(isTransientApiError(err), true);
  assert.equal(isShopeeSessionApiError(err), true);
  assert.equal(isFallbackEligibleError(err), false);
});

test('isShopeeRouteNotFoundUrl only flags Shopee affiliate 404 pages', () => {
  assert.equal(isShopeeRouteNotFoundUrl('https://affiliate.shopee.co.th/404'), true);
  assert.equal(isShopeeRouteNotFoundUrl('https://affiliate.shopee.co.th/404?next=secret'), true);
  assert.equal(isShopeeRouteNotFoundUrl('https://affiliate.shopee.co.th/'), false);
  assert.equal(isShopeeRouteNotFoundUrl('https://affiliate.shopee.co.th/offer/custom_link'), false);
  assert.equal(isShopeeRouteNotFoundUrl('https://shopee.co.th/buyer/login'), false);
});

test('shortenShopee uses browser context request API before page.evaluate', async (t) => {
  let evalCalls = 0;
  const posts = [];

  const restore = withBrowserStubs({
    getPage: async () => ({
      record: {
        context: {
          cookies: async () => [{ name: 'csrftoken', value: 'csrf-token-from-cookie' }],
          request: {
            post: async (requestUrl, options) => {
              posts.push({ requestUrl, options });
              return {
                status: () => 200,
                text: async () => JSON.stringify({
                  data: {
                    batchCustomLink: [
                      { shortLink: 's.shopee.co.th/CTXREQ', longLink: 'long-from-request', failCode: 0 },
                    ],
                  },
                }),
              };
            },
          },
        },
      },
      page: makePage(async () => {
        evalCalls += 1;
        throw new Error('page.evaluate should not be used when context.request is available');
      }),
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee('CHEARB', 'https://shopee.co.th/-i.1.2', ['canonical_probe']);

  assert.equal(result.shortLink, 's.shopee.co.th/CTXREQ');
  assert.equal(result.longLink, 'long-from-request');
  assert.equal(evalCalls, 0, 'page.evaluate should be skipped on the context request path');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].requestUrl, 'https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink');
  assert.equal(posts[0].options.headers['csrf-token'], 'csrf-token-from-cookie');
  assert.equal(posts[0].options.headers.origin, 'https://affiliate.shopee.co.th');
  assert.equal(posts[0].options.data.variables.linkParams[0].advancedLinkParams.subId1, 'canonicalprobe');
});

test('shortenShopee falls back to in-page browser transport when context request gets 401/403', async (t) => {
  let evalCalls = 0;
  const posts = [];

  const restore = withBrowserStubs({
    getPage: async () => ({
      record: {
        context: {
          cookies: async () => [{ name: 'csrftoken', value: 'csrf-token-from-cookie' }],
          request: {
            post: async (requestUrl, options) => {
              posts.push({ requestUrl, options });
              return {
                status: () => 403,
                text: async () => JSON.stringify({ error: 'login required' }),
              };
            },
          },
        },
      },
      page: makePage(async () => {
        evalCalls += 1;
        return { shortLink: 's.shopee.co.th/PAGEFETCH', longLink: 'long-page', originalLink: 'orig-page' };
      }),
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee('affiliate_chearb.com', 'https://shopee.co.th/-i.1.2', ['hermes']);

  assert.equal(result.shortLink, 's.shopee.co.th/PAGEFETCH');
  assert.equal(result.longLink, 'long-page');
  assert.equal(posts.length, 1);
  assert.equal(evalCalls, 1, 'in-page browser transport should run after context.request auth rejection');
});

test('Shopee in-page shorten script uses credentialed fetch matching the legacy bridge transport', async (t) => {
  const originalDocument = global.document;
  const originalXMLHttpRequest = global.XMLHttpRequest;
  const originalFetch = global.fetch;
  t.after(() => {
    global.document = originalDocument;
    global.XMLHttpRequest = originalXMLHttpRequest;
    global.fetch = originalFetch;
  });

  global.XMLHttpRequest = class XMLHttpRequestNotAllowed {
    constructor() {
      throw new Error('XMLHttpRequest must not be used by the in-page Shopee transport');
    }
  };
  global.document = {
    cookie: 'csrftoken=csrf-from-document; other=value',
    querySelector: () => null,
  };

  const sent = {};
  global.fetch = async (url, init) => {
    sent.url = url;
    sent.init = init;
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          data: {
            batchCustomLink: [
              { shortLink: 'https://s.shopee.co.th/FETCHOK', longLink: 'https://shopee.co.th/product/1/2', failCode: 0 },
            ],
          },
        });
      },
    };
  };

  const run = new Function('return (' + _SHOPEE_SHORTEN_SCRIPT_FOR_TEST + ');')();
  const result = await run(['https://shopee.co.th/-i.1.2', ['sub-a', 'abc_123', '---']]);

  assert.equal(result.shortLink, 'https://s.shopee.co.th/FETCHOK');
  assert.equal(sent.url, 'https://affiliate.shopee.co.th/api/v3/gql?q=batchCustomLink');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.credentials, 'include');
  assert.equal(sent.init.headers['Content-Type'], 'application/json');
  assert.equal(sent.init.headers['affiliate-program-type'], '1');
  assert.equal(sent.init.headers['csrf-token'], 'csrf-from-document');
  const parsedBody = JSON.parse(sent.init.body);
  assert.equal(parsedBody.variables.linkParams[0].originalLink, 'https://shopee.co.th/-i.1.2');
  assert.equal(parsedBody.variables.linkParams[0].advancedLinkParams.subId1, 'suba');
  assert.equal(parsedBody.variables.linkParams[0].advancedLinkParams.subId2, 'abc123');
  assert.equal(parsedBody.variables.linkParams[0].advancedLinkParams.subId3, '');
});

test('shortenShopee recovers an existing Shopee affiliate 404 tab by navigating to affiliate home before API request', async (t) => {
  const gotoCalls = [];
  const posts = [];
  let currentUrl = 'https://affiliate.shopee.co.th/404';

  const restore = withBrowserStubs({
    getPage: async () => ({
      record: {
        context: {
          cookies: async () => [{ name: 'csrftoken', value: 'csrf-token-from-cookie' }],
          request: {
            post: async (requestUrl, options) => {
              posts.push({ requestUrl, options });
              return {
                status: () => 200,
                text: async () => JSON.stringify({
                  data: {
                    batchCustomLink: [
                      { shortLink: 's.shopee.co.th/HOMEOK', longLink: 'long-home', failCode: 0 },
                    ],
                  },
                }),
              };
            },
          },
        },
      },
      page: makePage(async () => {
        throw new Error('page.evaluate should not run on context request success');
      }, {
        url: () => currentUrl,
        goto: async (target) => {
          gotoCalls.push(target);
          currentUrl = target;
        },
      }),
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee('CHEARB', 'https://shopee.co.th/-i.1.2', ['yok']);

  assert.equal(result.shortLink, 's.shopee.co.th/HOMEOK');
  assert.deepEqual(gotoCalls, ['https://affiliate.shopee.co.th/']);
  assert.equal(posts.length, 1, 'API request should run after escaping the 404 route');
  assert.equal(posts[0].options.headers.referer, 'https://affiliate.shopee.co.th/');
});

test('shortenShopee returns a route-specific manual reason when Shopee affiliate 404 cannot be escaped', async (t) => {
  let evalCalls = 0;
  const gotoCalls = [];

  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        evalCalls += 1;
        throw new Error('evaluate must not run on a confirmed affiliate 404');
      }, {
        url: () => 'https://affiliate.shopee.co.th/404',
        goto: async (target) => {
          gotoCalls.push(target);
        },
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  await assert.rejects(
    () => shortenShopee('CHEARB', 'https://shopee.co.th/-i.1.2', ['yok']),
    (err) => {
      assert.equal(err.manualLoginRequired, true);
      assert.equal(err.reason, SHOPEE_ROUTE_NOT_FOUND_REASON);
      assert.equal(err.message, SHOPEE_ROUTE_NOT_FOUND_REASON);
      assert.equal(err.diagnostic.reason, SHOPEE_ROUTE_NOT_FOUND_REASON);
      assert.equal(err.diagnostic.domain, 'affiliate.shopee.co.th');
      return true;
    },
  );
  assert.deepEqual(gotoCalls, ['https://affiliate.shopee.co.th/']);
  assert.equal(evalCalls, 0, 'selector/API evaluation must not run from affiliate 404');
});

test('shortenShopee retries on context-destroyed and succeeds on a fresh page', async (t) => {
  let evalCalls = 0;
  const getPageCalls = [];
  const ensureCalls = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      const page = makePage(async () => {
        evalCalls += 1;
        if (evalCalls === 1) {
          throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
        }
        return { shortLink: 's.shopee.co.th/AB123', longLink: 'long', originalLink: 'orig' };
      });
      return { page, record: {} };
    },
    ensureOnPlatformPage: async (page, platform) => {
      ensureCalls.push(platform);
    },
  });
  t.after(restore);

  const result = await shortenShopee(
    'affiliate@neezs.com',
    'https://shopee.co.th/-i.6817918.28499498718',
    [],
  );

  assert.equal(result.shortLink, 's.shopee.co.th/AB123');
  assert.equal(evalCalls, 2, 'evaluate should be called twice (once failing, once succeeding)');
  // First call is the initial attempt, second is the resettle in between, third is the retry.
  assert.ok(getPageCalls.length >= 2, 'getPage should be invoked at least twice across retries');
  // The retry now recycles immediately; a navigation-destroyed page is often
  // already poisoned for this account/session.
  const retryCall = getPageCalls[1];
  assert.equal(retryCall.opts.forceNew, true, 'first nav retry should force a new context');
});

test('shortenShopee forces a fresh persistent context after repeated nav failures', async (t) => {
  let evalCalls = 0;
  const getPageCalls = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      const page = makePage(async () => {
        evalCalls += 1;
        if (evalCalls <= 2) {
          throw new Error('Execution context was destroyed, most likely because of a navigation');
        }
        return { shortLink: 's.shopee.co.th/OKOK', longLink: 'long', originalLink: 'orig' };
      });
      return { page, record: {} };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee(
    'affiliate@neezs.com',
    'https://shopee.co.th/-i.1.2',
    [],
  );

  assert.equal(result.shortLink, 's.shopee.co.th/OKOK');
  assert.equal(evalCalls, 3, 'should retry until evaluate succeeds');
  const resettleCalls = getPageCalls.filter((c) => c.opts && 'forceNew' in c.opts);
  assert.ok(
    resettleCalls.some((c) => c.opts.forceNew === true),
    'after a second consecutive nav failure, resettle should request forceNew',
  );
});

test('shortenShopee returns immediately on success without retry', async (t) => {
  let evalCalls = 0;
  const getPageCalls = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      return {
        page: makePage(async () => {
          evalCalls += 1;
          return { shortLink: 's.shopee.co.th/CHEARB', longLink: 'long', originalLink: 'orig' };
        }),
        record: {},
      };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee('CHEARB', 'https://shopee.co.th/-i.1.2', ['yok']);
  assert.equal(result.shortLink, 's.shopee.co.th/CHEARB');
  assert.equal(evalCalls, 1, 'should not retry on first success');
  assert.equal(getPageCalls.length, 1, 'should call getPage exactly once on success');
});

test('shortenShopee retries Shopee transient 90309999 "No results" envelope', async (t) => {
  let evalCalls = 0;
  const getPageCalls = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      const page = makePage(async () => {
        evalCalls += 1;
        if (evalCalls === 1) {
          throw new Error(
            'No results: {"data":{"batchCustomLink":null},"errors":[{"message":"failed to dispatch","code":90309999,"path":["batchCustomLink"]}]}',
          );
        }
        return { shortLink: 's.shopee.co.th/RETRY9', longLink: 'long', originalLink: 'orig' };
      });
      return { page, record: {} };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee(
    'affiliate@neezs.com',
    'https://shopee.co.th/-i.6817918.28499498718',
    [],
  );

  assert.equal(result.shortLink, 's.shopee.co.th/RETRY9');
  assert.equal(evalCalls, 2, 'evaluate should be called twice (transient API error then success)');
  assert.ok(getPageCalls.length >= 2, 'getPage should be invoked again for the retry resettle');
  // Transient API failure is not a nav-context destruction, so the retry must not
  // request a brand-new persistent context.
  const retryCall = getPageCalls[1];
  assert.equal(retryCall.opts.forceNew, false, 'transient API retry should not force a new context');
});

test('isTimeoutError flags withTimeout failures and they are recoverable', () => {
  assert.equal(isTimeoutError(new Error('Timeout after 25000ms')), true);
  assert.equal(isTimeoutError(new Error('Timeout after 1ms')), true);
  assert.equal(isTimeoutError(new Error('failCode: 50001')), false);
  assert.equal(isTimeoutError(new Error('Execution context was destroyed')), false);
  assert.equal(isTimeoutError(null), false);
  assert.equal(isTimeoutError(undefined), false);
  // Recoverable classifier must include timeouts so the loop retries them.
  assert.equal(isRecoverableShortenError(new Error('Timeout after 25000ms')), true);
});

test('shortenShopee retries after a Timeout and forces a fresh context on resettle', async (t) => {
  let evalCalls = 0;
  const getPageCalls = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      const page = makePage(async () => {
        evalCalls += 1;
        if (evalCalls === 1) {
          throw new Error('Timeout after 25000ms');
        }
        return { shortLink: 's.shopee.co.th/AFTERTO', longLink: 'long', originalLink: 'orig' };
      });
      return { page, record: {} };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee(
    'affiliate@neezs.com',
    'https://shopee.co.th/-i.6817918.28499498718',
    [],
  );

  assert.equal(result.shortLink, 's.shopee.co.th/AFTERTO');
  assert.equal(evalCalls, 2, 'evaluate should run again after the timeout');
  const resettleCalls = getPageCalls.filter((c) => c.opts && 'forceNew' in c.opts);
  assert.ok(
    resettleCalls.some((c) => c.opts.forceNew === true),
    'after a timeout, resettle MUST request a fresh persistent context',
  );
});

test('shortenShopee does not invoke onSessionExpired for a timeout', async (t) => {
  let evalCalls = 0;
  let sessionCbCalls = 0;

  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        evalCalls += 1;
        if (evalCalls === 1) throw new Error('Timeout after 25000ms');
        return { shortLink: 's.shopee.co.th/NOREAUTH', longLink: 'long', originalLink: 'orig' };
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee(
    'affiliate@neezs.com',
    'https://shopee.co.th/-i.1.2',
    [],
    { onSessionExpired: async () => { sessionCbCalls += 1; return {}; } },
  );
  assert.equal(result.shortLink, 's.shopee.co.th/NOREAUTH');
  assert.equal(sessionCbCalls, 0, 'timeout must NOT trigger reauth');
});

test('shortenShopee invokes reauth and forces a fresh context after failCode 3', async (t) => {
  let evalCalls = 0;
  let sessionCbCalls = 0;
  const getPageCalls = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      return {
        page: makePage(async () => {
          evalCalls += 1;
          if (evalCalls === 1) throw new Error('failCode: 3');
          return { shortLink: 's.shopee.co.th/AFTER3', longLink: 'long', originalLink: 'orig' };
        }),
        record: {},
      };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee(
    'CHEARB',
    'https://shopee.co.th/-i.6817918.28499498718',
    ['yok'],
    { onSessionExpired: async () => { sessionCbCalls += 1; return { ok: true }; } },
  );

  assert.equal(result.shortLink, 's.shopee.co.th/AFTER3');
  assert.equal(evalCalls, 2);
  assert.equal(sessionCbCalls, 1, 'failCode 3 should try Keychain-backed reauth once');
  assert.ok(
    getPageCalls.some((c) => c.opts && c.opts.forceNew === true),
    'failCode 3 should recycle the persistent context before retrying',
  );
});

test('shortenShopee opportunistically reauths once after a fatal-looking Shopee failCode and retries on a fresh context', async (t) => {
  let evalCalls = 0;
  let sessionCbCalls = 0;
  const getPageCalls = [];
  const reauthInfos = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      return {
        page: makePage(async () => {
          evalCalls += 1;
          if (evalCalls === 1) throw new Error('failCode: 2 envelope: {"result":{"failCode":2}}');
          return { shortLink: 's.shopee.co.th/AFTER2', longLink: 'long', originalLink: 'orig' };
        }),
        record: {},
      };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee(
    'CHEARB',
    'https://shopee.co.th/-i.6817918.28499498718',
    ['yok'],
    {
      onSessionExpired: async (info) => {
        sessionCbCalls += 1;
        reauthInfos.push(info);
        return { ok: true };
      },
    },
  );

  assert.equal(result.shortLink, 's.shopee.co.th/AFTER2');
  assert.equal(evalCalls, 2, 'retry should run exactly once after opportunistic reauth');
  assert.equal(sessionCbCalls, 1, 'opportunistic reauth should run at most once');
  assert.equal(reauthInfos[0].opportunistic, true);
  assert.match(reauthInfos[0].error.message, /failCode: 2/);
  assert.ok(
    getPageCalls.some((c) => c.opts && c.opts.forceNew === true),
    'opportunistic reauth must force a fresh persistent context before retrying',
  );
});

test('shortenShopee surfaces manual-login blocker from opportunistic reauth', async (t) => {
  let sessionCbCalls = 0;

  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        throw new Error('failCode: 2 envelope: {"result":{"failCode":2}}');
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  await assert.rejects(
    () => shortenShopee(
      'CHEARB',
      'https://shopee.co.th/-i.6817918.28499498718',
      ['yok'],
      {
        onSessionExpired: async () => {
          sessionCbCalls += 1;
          return {
            ok: false,
            manualLoginRequired: true,
            reason: 'captcha_or_otp_detected',
            diagnostic: {
              reason: 'captcha_or_otp_detected',
              source: 'auto_reauth',
              frames: [],
            },
          };
        },
      },
    ),
    (err) => {
      assert.equal(err.manualLoginRequired, true);
      assert.equal(err.reason, 'captcha_or_otp_detected');
      assert.equal(err.diagnostic.reason, 'captcha_or_otp_detected');
      return true;
    },
  );
  assert.equal(sessionCbCalls, 1, 'manual blocker should still come from exactly one opportunistic reauth');
});

test('shortenShopee does not opportunistically reauth fail-closed Shopee affiliate validation errors', async (t) => {
  const reasons = [
    'shopee_affiliate_id_unknown',
    'shopee_affiliate_account_conflict',
    'shopee_affiliate_utm_source_mismatch',
  ];
  let evalCalls = 0;
  let sessionCbCalls = 0;
  let currentReason = reasons[0];

  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        evalCalls += 1;
        const err = new Error(currentReason);
        err.reason = currentReason;
        throw err;
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  for (const reason of reasons) {
    currentReason = reason;
    await assert.rejects(
      () => shortenShopee(
        'CHEARB',
        'https://shopee.co.th/-i.6817918.28499498718',
        ['yok'],
        { onSessionExpired: async () => { sessionCbCalls += 1; return { ok: true }; } },
      ),
      (err) => {
        assert.equal(err.reason, reason);
        return true;
      },
    );
  }

  assert.equal(evalCalls, reasons.length, 'validation errors should not retry');
  assert.equal(sessionCbCalls, 0, 'validation errors must not be papered over by reauth');
});

test('shortenShopee invokes reauth after Shopee redirects off affiliate origin', async (t) => {
  let evalCalls = 0;
  let sessionCbCalls = 0;
  const getPageCalls = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      const callIndex = getPageCalls.length;
      getPageCalls.push({ platform, account, opts });
      if (callIndex === 0) {
        return {
          page: makePage(async () => {
            throw new Error('evaluate must not run from the login redirect');
          }, {
            url: () => 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2Foffer%2Fcustom_link',
          }),
          record: {},
        };
      }
      return {
        page: makePage(async () => {
          evalCalls += 1;
          return { shortLink: 's.shopee.co.th/AFTERLOGIN', longLink: 'long', originalLink: 'orig' };
        }),
        record: {},
      };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee(
    'CHEARB',
    'https://shopee.co.th/-i.6817918.28499498718',
    ['yok'],
    { onSessionExpired: async () => { sessionCbCalls += 1; return { ok: true }; } },
  );

  assert.equal(result.shortLink, 's.shopee.co.th/AFTERLOGIN');
  assert.equal(evalCalls, 1, 'retry should run after Keychain-backed reauth');
  assert.equal(sessionCbCalls, 1, 'off-domain redirect should try reauth once');
  assert.ok(
    getPageCalls.some((c) => c.opts && c.opts.forceNew === true),
    'off-domain session redirect should recycle the persistent context before retrying',
  );
});

test('shortenShopee retries with the authenticated dashboard context after already-authenticated reauth', async (t) => {
  let reauthComplete = false;
  let preservedAuthenticatedContext = false;
  const getPageCalls = [];
  const posts = [];

  const makeStatefulPage = (initialUrl, options = {}) => {
    let currentUrl = initialUrl;
    return makePage(async () => {
      throw new Error('page.evaluate should not run when context.request is available');
    }, {
      url: () => currentUrl,
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
    });
  };

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts = {}) => {
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
                          { shortLink: 's.shopee.co.th/AUTHCTX', longLink: 'long-authctx', failCode: 0 },
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
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee(
    'affiliate_chearb.com',
    'https://s.shopee.co.th/1qR4b07pQ6',
    ['hermes_dashboardauth'],
    {
      onSessionExpired: async () => {
        reauthComplete = true;
        return {
          ok: true,
          manualLoginRequired: false,
          alreadyAuthenticated: true,
        };
      },
    },
  );

  assert.equal(result.shortLink, 's.shopee.co.th/AUTHCTX');
  assert.equal(posts.length, 1, 'retry must reach the Shopee API with the authenticated context');
  const resettleAfterReauth = getPageCalls.find((call) => (
    call.opts
    && call.phase === 'after-reauth'
    && Object.prototype.hasOwnProperty.call(call.opts, 'forceNew')
  ));
  assert.ok(resettleAfterReauth, 'reauth should be followed by a resettle before retry');
  assert.equal(
    getPageCalls.some((call) => call.phase === 'after-reauth' && call.opts && call.opts.forceNew === true),
    false,
    'already-authenticated reauth must not force a fresh context before retry',
  );
});

test('shortenShopee returns precise diagnostic when Shopee API rejects after authenticated reauth', async (t) => {
  let reauthComplete = false;
  let preservedAuthenticatedContext = false;

  const makeStatefulPage = (initialUrl, options = {}) => {
    let currentUrl = initialUrl;
    return makePage(async () => {
      throw new Error('HTTP 403 UNAUTHORIZED (likely SESSION_EXPIRED)');
    }, {
      url: () => currentUrl,
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
        currentUrl = target;
      },
    });
  };

  const restore = withBrowserStubs({
    getPage: async (_platform, _account, opts = {}) => {
      if (!reauthComplete && opts.forceNew) {
        return { page: makeStatefulPage('https://shopee.co.th/buyer/login', { kind: 'reauth' }), record: {} };
      }
      if (reauthComplete && Object.prototype.hasOwnProperty.call(opts, 'forceNew')) {
        return { page: makeStatefulPage('https://affiliate.shopee.co.th/dashboard', { kind: 'preserved-resettle' }), record: {} };
      }
      if (preservedAuthenticatedContext) {
        return {
          record: {
            context: {
              cookies: async () => [{ name: 'csrftoken', value: 'csrf-after-reauth' }],
              request: {
                post: async () => ({
                  status: () => 401,
                  text: async () => JSON.stringify({ error: 'login required' }),
                }),
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
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  await assert.rejects(
    () => shortenShopee(
      'affiliate_chearb.com',
      'https://s.shopee.co.th/1qR4b07pQ6',
      ['hermes_dashboardauth'],
      {
        onSessionExpired: async () => {
          reauthComplete = true;
          return {
            ok: true,
            manualLoginRequired: false,
            alreadyAuthenticated: true,
          };
        },
      },
    ),
    (err) => {
      assert.equal(err.manualLoginRequired, true);
      assert.equal(err.reason, 'shopee_api_auth_rejected_after_authenticated_reauth');
      assert.equal(err.diagnostic.reason, 'shopee_api_auth_rejected_after_authenticated_reauth');
      assert.equal(err.diagnostic.errorClass, 'http_401_or_403');
      assert.equal(err.diagnostic.reauthAlreadyAuthenticated, true);
      assert.deepEqual(err.diagnostic.apiTransport, {
        contextRequest: 'http_401_or_403',
        pageEvaluateAttempted: true,
        pageEvaluate: 'http_401_or_403',
      });
      assert.equal(/password|secret|cookie|token/i.test(JSON.stringify(err.diagnostic)), false);
      return true;
    },
  );
});

test('shortenShopee surfaces manual-login blocker returned by auto reauth', async (t) => {
  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        throw new Error('failCode: 3');
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  await assert.rejects(
    () => shortenShopee(
      'CHEARB',
      'https://shopee.co.th/-i.6817918.28499498718',
      ['yok'],
      {
        onSessionExpired: async () => ({
          ok: false,
          manualLoginRequired: true,
          reason: 'captcha_or_otp_detected',
          diagnostic: {
            reason: 'captcha_or_otp_detected',
            domain: 'shopee.co.th',
            frames: [],
          },
        }),
      },
    ),
    (err) => {
      assert.equal(err.manualLoginRequired, true);
      assert.equal(err.reason, 'captcha_or_otp_detected');
      assert.equal(err.diagnostic.domain, 'shopee.co.th');
      return true;
    },
  );
});

test('shortenShopee returns precise manual-login diagnostic when reauth does not restore the Shopee session', async (t) => {
  const getPageCalls = [];
  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      return {
        page: makePage(async () => {
          throw new Error('evaluate must not run from the login redirect');
        }, {
          url: () => 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2Foffer%2Fcustom_link',
        }),
        record: {},
      };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  await assert.rejects(
    () => shortenShopee(
      'CHEARB',
      'https://shopee.co.th/-i.6817918.28499498718',
      ['yok'],
      { onSessionExpired: async () => ({ ok: true }) },
    ),
    (err) => {
      assert.equal(err.manualLoginRequired, true);
      assert.equal(err.reason, 'shopee_redirected_off_affiliate_after_reauth');
      assert.equal(err.diagnostic.reason, 'shopee_redirected_off_affiliate_after_reauth');
      assert.equal(err.diagnostic.errorClass, 'off_domain_redirect');
      assert.equal(err.diagnostic.reauthOk, true);
      assert.equal(err.diagnostic.reauthAlreadyAuthenticated, false);
      return true;
    },
  );
  assert.ok(getPageCalls.some((c) => c.opts && c.opts.forceNew === true));
});

test('shortenShopee escalates to forceNew after consecutive 90309999 API errors', async (t) => {
  let evalCalls = 0;
  const getPageCalls = [];

  const restore = withBrowserStubs({
    getPage: async (platform, account, opts) => {
      getPageCalls.push({ platform, account, opts });
      const page = makePage(async () => {
        evalCalls += 1;
        if (evalCalls <= 2) {
          throw new Error(
            'No results: {"data":{"batchCustomLink":null},"errors":[{"message":"failed to dispatch","code":90309999,"path":["batchCustomLink"]}]}',
          );
        }
        return { shortLink: 's.shopee.co.th/CHAIN9', longLink: 'long', originalLink: 'orig' };
      });
      return { page, record: {} };
    },
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const result = await shortenShopee('acc', 'https://shopee.co.th/-i.1.2', []);
  assert.equal(result.shortLink, 's.shopee.co.th/CHAIN9');
  assert.equal(evalCalls, 3, 'should retry until evaluate succeeds');
  const resettleCalls = getPageCalls.filter((c) => c.opts && 'forceNew' in c.opts);
  assert.ok(
    resettleCalls.some((c) => c.opts.forceNew === true),
    'after a second consecutive transient API failure, resettle should request forceNew',
  );
});

test('isFallbackEligibleError gates the cache fallback to safe transients only', () => {
  assert.equal(
    isFallbackEligibleError(new Error(
      'No results: {"data":{"batchCustomLink":null},"errors":[{"code":90309999}]}',
    )),
    true,
  );
  assert.equal(isFallbackEligibleError(new Error('Timeout after 25000ms')), true);
  assert.equal(isFallbackEligibleError(new Error('Execution context was destroyed')), true);
  assert.equal(isFallbackEligibleError(new Error('Failed to fetch')), true);
  // Real auth/session must NOT be masked.
  assert.equal(isFallbackEligibleError(new Error('SESSION_EXPIRED')), false);
  assert.equal(isFallbackEligibleError(new Error('HTTP 401 UNAUTHORIZED')), false);
  // Manual-login signal must NOT be masked.
  const manual = new Error('MANUAL_LOGIN_REQUIRED');
  manual.manualLoginRequired = true;
  assert.equal(isFallbackEligibleError(manual), false);
  // Fatal Shopee failCode must NOT be masked.
  assert.equal(isFallbackEligibleError(new Error('failCode: 50001')), false);
  assert.equal(isFallbackEligibleError(null), false);
  assert.equal(isFallbackEligibleError(undefined), false);
});

test('shortenShopee returns last-known-good shortlink after exhausting 90309999 retries when cache hit', async (t) => {
  _resetLastSuccessCache();
  t.after(() => _resetLastSuccessCache());

  let evalCalls = 0;
  let mode = 'success';

  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        evalCalls += 1;
        if (mode === 'success') {
          return {
            shortLink: 's.shopee.co.th/CACHED1',
            longLink: 'https://shopee.co.th/long-cached',
            originalLink: 'https://shopee.co.th/orig-cached',
          };
        }
        throw new Error(
          'No results: {"data":{"batchCustomLink":null},"errors":[{"message":"failed to dispatch","code":90309999,"path":["batchCustomLink"]}]}',
        );
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const account = 'affiliate@neezs.com';
  const productUrl = 'https://shopee.co.th/-i.6817918.28499498718';
  const subIds = ['yok', '', '', '', ''];

  // Prime the cache with a real success.
  const first = await shortenShopee(account, productUrl, subIds);
  assert.equal(first.shortLink, 's.shopee.co.th/CACHED1');
  assert.equal(first.fallback, undefined, 'first success must not carry fallback marker');
  assert.equal(evalCalls, 1);

  // Next call: every retry hits the transient 90309999 envelope.
  mode = 'transient';
  const evalsBefore = evalCalls;
  const second = await shortenShopee(account, productUrl, subIds);
  assert.equal(second.shortLink, 's.shopee.co.th/CACHED1', 'must serve cached shortLink');
  assert.equal(second.longLink, 'https://shopee.co.th/long-cached');
  assert.equal(second.originalLink, 'https://shopee.co.th/orig-cached');
  assert.equal(second.fallback, 'last_success', 'fallback origin must be flagged');
  assert.equal(evalCalls - evalsBefore, 3, 'must exhaust all retries before falling back');
});

test('shortenShopee does NOT fallback when retries exhaust and no cached success exists', async (t) => {
  _resetLastSuccessCache();
  t.after(() => _resetLastSuccessCache());

  let evalCalls = 0;
  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        evalCalls += 1;
        throw new Error(
          'No results: {"data":{"batchCustomLink":null},"errors":[{"message":"failed to dispatch","code":90309999,"path":["batchCustomLink"]}]}',
        );
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  await assert.rejects(
    () => shortenShopee('nocache@neezs.com', 'https://shopee.co.th/-i.9.9', []),
    /90309999/,
  );
  assert.equal(evalCalls, 3, 'should exhaust MAX_SHORTEN_ATTEMPTS before rejecting');
});

test('shortenShopee does NOT fallback to cache after a fatal failCode', async (t) => {
  _resetLastSuccessCache();
  t.after(() => _resetLastSuccessCache());

  let phase = 'success';
  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        if (phase === 'success') {
          return {
            shortLink: 's.shopee.co.th/PRIMED',
            longLink: 'https://shopee.co.th/long-primed',
            originalLink: 'https://shopee.co.th/orig-primed',
          };
        }
        throw new Error('failCode: 50001');
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  const account = 'fatal@neezs.com';
  const productUrl = 'https://shopee.co.th/-i.50001.X';
  const subIds = [];

  const primed = await shortenShopee(account, productUrl, subIds);
  assert.equal(primed.shortLink, 's.shopee.co.th/PRIMED');

  phase = 'fatal';
  await assert.rejects(
    () => shortenShopee(account, productUrl, subIds),
    /failCode: 50001/,
    'fatal failCode must surface, never be masked by cache fallback',
  );
});

test('shortenShopee throws original error on non-recoverable failure (no retry)', async (t) => {
  let evalCalls = 0;
  const restore = withBrowserStubs({
    getPage: async () => ({
      page: makePage(async () => {
        evalCalls += 1;
        throw new Error('failCode: 50001');
      }),
      record: {},
    }),
    ensureOnPlatformPage: async () => {},
  });
  t.after(restore);

  await assert.rejects(
    () => shortenShopee('CHEARB', 'https://shopee.co.th/-i.1.2', []),
    /failCode: 50001/,
  );
  assert.equal(evalCalls, 1, 'non-recoverable error should not trigger a retry');
});
