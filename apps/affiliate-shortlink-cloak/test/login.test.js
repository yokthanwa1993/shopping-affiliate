'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { attemptLogin, captureLoginDiagnostics } = require('../src/login');
const { SHOPEE_ROUTE_NOT_FOUND_REASON } = require('../src/shopee-route');

function emptyLocator() {
  return {
    first() { return this; },
    all: async () => [],
    isVisible: async () => false,
    fill: async () => { throw new Error('not visible'); },
    click: async () => { throw new Error('not visible'); },
  };
}

function normalizeTargetOptions(options) {
  if (options instanceof Set) return { domKinds: options };
  return options || {};
}

function makeTarget(name, events, options = {}, state = {}) {
  const opts = normalizeTargetOptions(options);
  const domKinds = opts.domKinds || new Set();
  const fillAttempts = new Map();
  return {
    name,
    url: () => opts.url || `https://example.test/${name}`,
    locator: () => emptyLocator(),
    fill: async () => { throw new Error(`${name} selector miss`); },
    click: async () => { throw new Error(`${name} click miss`); },
    content: opts.content === undefined ? undefined : async () => opts.content,
    evaluate: async (_fn, arg) => {
      if (arg && arg.action === 'capture-login-diagnostics') {
        const diagnostic = opts.diagnostic || {};
        return {
          ...arg.meta,
          title: diagnostic.title || `${name} title`,
          inputCount: Number(diagnostic.inputCount || 0),
          inputs: Array.isArray(diagnostic.inputs) ? diagnostic.inputs : [],
          textSnippets: Array.isArray(diagnostic.textSnippets) ? diagnostic.textSnippets : [],
          blockerMarkers: Array.isArray(diagnostic.blockerMarkers) ? diagnostic.blockerMarkers : [],
        };
      }
      if (arg && arg.action === 'click-password-login') {
        state.passwordClickAttempts = (state.passwordClickAttempts || 0) + 1;
        events.push({ target: name, kind: 'password-login-click', attempt: state.passwordClickAttempts });
        if (opts.passwordClickAfter && state.passwordClickAttempts >= opts.passwordClickAfter) {
          state.passwordMode = true;
          return 'dom:password-login';
        }
        return '';
      }
      if (arg && arg.action === 'fill-login-input' && domKinds.has(arg.kind)) {
        if (opts.requiresPasswordMode && !state.passwordMode) return '';
        const previous = fillAttempts.get(arg.kind) || 0;
        const next = previous + 1;
        fillAttempts.set(arg.kind, next);
        const delayedUntil = opts.readyAfter && opts.readyAfter[arg.kind];
        if (delayedUntil && next < delayedUntil) return '';
        events.push({ target: name, kind: arg.kind });
        const resultByKind = opts.resultByKind || {};
        return resultByKind[arg.kind] || `dom:${name}:${arg.kind}`;
      }
      return '';
    },
  };
}

function makePage({
  url = 'https://affiliate.shopee.co.th/login',
  content = '<html><body>login form</body></html>',
  frameContent,
  pageTarget = {},
  frameTarget,
  frameDomKinds = new Set(),
} = {}) {
  const events = [];
  const state = {};
  const main = makeTarget('main', events, {}, state);
  const iframe = makeTarget('iframe', events, frameTarget || {
    domKinds: frameDomKinds,
    content: frameContent,
  }, state);
  const page = {
    ...makeTarget('page', events, pageTarget, state),
    url: () => url,
    content: async () => content,
    mainFrame: () => main,
    frames: () => [main, iframe],
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    keyboard: {
      press: async (key) => {
        events.push({ target: 'page', kind: `key:${key}` });
      },
    },
  };
  return { page, events };
}

test('captureLoginDiagnostics redacts secrets while preserving live page evidence', async () => {
  const username = 'affiliate@example.com';
  const password = 'super-secret-password';
  const { page } = makePage({
    url: 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2Foffer%2Fcustom_link&token=raw-token',
    pageTarget: {
      diagnostic: {
        title: 'Shopee Login affiliate@example.com',
        inputCount: 2,
        inputs: [
          {
            index: 0,
            tag: 'input',
            type: 'text',
            name: 'loginKey',
            placeholder: 'Phone number / Username / Email',
            visible: false,
            rect: { x: 12, y: 20, width: 240, height: 36 },
            candidate: 'username',
            excluded: 'not_visible',
            marker: 'loginKey affiliate@example.com',
          },
        ],
        textSnippets: [
          'Log in with QR code',
          `Current account ${username} ${password}`,
        ],
        blockerMarkers: ['qr_login'],
      },
    },
  });

  const diagnostic = await captureLoginDiagnostics(
    page,
    'shopee',
    'username_field_not_found',
    [username, password],
  );
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.reason, 'username_field_not_found');
  assert.equal(diagnostic.domain, 'shopee.co.th');
  assert.equal(diagnostic.frameCount, 2);
  assert.equal(diagnostic.frames[0].inputCount, 2);
  assert.equal(diagnostic.frames[0].inputs[0].candidate, 'username');
  assert.ok(diagnostic.frames[0].blockerMarkers.includes('qr_login'));
  assert.equal(serialized.includes(username), false, 'username must be redacted from diagnostics');
  assert.equal(serialized.includes(password), false, 'password must be redacted from diagnostics');
  assert.equal(serialized.includes('raw-token'), false, 'sensitive query values must be redacted');
});

test('attemptLogin attaches diagnostics when Shopee username field is not found', async () => {
  const username = 'stored-user@example.com';
  const password = 'stored-password-never-returned';
  const { page } = makePage({
    url: 'https://shopee.co.th/buyer/login?next=https%3A%2F%2Faffiliate.shopee.co.th%2Foffer%2Fcustom_link',
    pageTarget: {
      diagnostic: {
        title: 'Shopee Login',
        inputCount: 1,
        inputs: [
          {
            index: 0,
            tag: 'input',
            type: 'hidden',
            name: 'csrf',
            visible: false,
            candidate: '',
            excluded: 'not_visible',
          },
        ],
        textSnippets: ['Scan QR code to log in'],
        blockerMarkers: ['qr_login'],
      },
    },
  });

  const result = await attemptLogin(page, 'shopee', username, password);
  const serialized = JSON.stringify(result);

  assert.equal(result.filled, false);
  assert.equal(result.submitted, false);
  assert.equal(result.needsManual, true);
  assert.equal(result.reason, 'username_field_not_found');
  assert.equal(result.diagnostic.reason, 'username_field_not_found');
  assert.equal(result.diagnostic.domain, 'shopee.co.th');
  assert.equal(result.diagnostic.frames[0].inputs[0].name, 'csrf');
  assert.equal(serialized.includes(username), false, 'username must not leak through diagnostics');
  assert.equal(serialized.includes(password), false, 'password must not leak through diagnostics');
});

test('attemptLogin reports Shopee affiliate 404 as route-not-found instead of username_field_not_found', async () => {
  const username = 'stored-user@example.com';
  const password = 'stored-password-never-returned';
  const { page } = makePage({
    url: 'https://affiliate.shopee.co.th/404',
    pageTarget: {
      diagnostic: {
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
      },
    },
  });

  const result = await attemptLogin(page, 'shopee', username, password);
  const serialized = JSON.stringify(result);

  assert.equal(result.filled, false);
  assert.equal(result.submitted, false);
  assert.equal(result.needsManual, true);
  assert.equal(result.reason, SHOPEE_ROUTE_NOT_FOUND_REASON);
  assert.equal(result.diagnostic.reason, SHOPEE_ROUTE_NOT_FOUND_REASON);
  assert.equal(result.diagnostic.domain, 'affiliate.shopee.co.th');
  assert.equal(result.diagnostic.frames[0].inputCount, 0);
  assert.equal(serialized.includes('username_field_not_found'), false);
  assert.equal(serialized.includes(username), false, 'username must not leak through diagnostics');
  assert.equal(serialized.includes(password), false, 'password must not leak through diagnostics');
});

test('attemptLogin uses broad visible DOM fallback inside iframes instead of username_field_not_found', async () => {
  const { page, events } = makePage({ frameDomKinds: new Set(['text', 'password']) });

  const result = await attemptLogin(page, 'shopee', 'stored-user', 'stored-password');

  assert.equal(result.filled, true);
  assert.equal(result.submitted, true);
  assert.equal(result.needsManual, false);
  assert.equal(result.reason, '');
  assert.deepEqual(
    events
      .filter((event) => event.target === 'iframe' && (event.kind === 'text' || event.kind === 'password'))
      .map((event) => event.kind),
    ['text', 'password'],
  );
  assert.ok(events.some((event) => event.kind === 'key:Enter'), 'submit should fall back to Enter');
});

test('attemptLogin keeps checking late Shopee password-login tab during client-render delay', async () => {
  const { page, events } = makePage({
    pageTarget: {
      domKinds: new Set(['text', 'password']),
      requiresPasswordMode: true,
      passwordClickAfter: 6,
    },
  });

  const result = await attemptLogin(page, 'shopee', 'stored-user', 'stored-password');

  assert.equal(result.filled, true);
  assert.equal(result.submitted, true);
  assert.equal(result.needsManual, false);
  assert.ok(
    events.filter((event) => event.kind === 'password-login-click').length >= 6,
    'password-login click fallback should be retried beyond the initial prefill probe',
  );
  assert.deepEqual(
    events.filter((event) => event.kind === 'text' || event.kind === 'password').map((event) => event.kind),
    ['text', 'password'],
  );
});

test('attemptLogin can fill contenteditable/open-shadow-style login textboxes from broad DOM fallback', async () => {
  const { page, events } = makePage({
    pageTarget: {
      domKinds: new Set(['text', 'password']),
      resultByKind: {
        text: 'dom:contenteditable:0',
        password: 'dom:input[type="password"]',
      },
    },
  });

  const result = await attemptLogin(page, 'shopee', 'stored-user', 'stored-password');

  assert.equal(result.filled, true);
  assert.equal(result.submitted, true);
  assert.equal(result.needsManual, false);
  assert.deepEqual(
    events.filter((event) => event.kind === 'text' || event.kind === 'password').map((event) => event.kind),
    ['text', 'password'],
  );
});

test('attemptLogin preserves manual_login_required for OTP/CAPTCHA pages before autofill', async () => {
  const { page, events } = makePage({ content: '<html><body>OTP verification required</body></html>' });

  const result = await attemptLogin(page, 'shopee', 'stored-user', 'stored-password');

  assert.equal(result.filled, false);
  assert.equal(result.submitted, false);
  assert.equal(result.needsManual, true);
  assert.equal(result.reason, 'captcha_or_otp_detected');
  assert.equal(events.length, 0, 'manual blocker should stop autofill attempts');
});

test('attemptLogin preserves manual_login_required when OTP/CAPTCHA marker is inside an iframe', async () => {
  const { page, events } = makePage({
    content: '<html><body>login shell</body></html>',
    frameContent: '<html><body>OTP verification required</body></html>',
    frameDomKinds: new Set(['text', 'password']),
  });

  const result = await attemptLogin(page, 'shopee', 'stored-user', 'stored-password');

  assert.equal(result.filled, false);
  assert.equal(result.submitted, false);
  assert.equal(result.needsManual, true);
  assert.equal(result.reason, 'captcha_or_otp_detected');
  assert.equal(events.length, 0, 'manual blocker in frame should stop autofill attempts');
});
