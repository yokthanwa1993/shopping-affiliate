'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer } = require('../src/server');
const { createRemoteBrowserManager } = require('../src/remoteBrowser');

// ── Mock Playwright page/context/browser + profile archive sync ────────────────────────────────

function makeMockPage(initialUrl) {
  const calls = [];
  let currentUrl = initialUrl || 'https://www.facebook.com/';
  return {
    calls,
    url: () => currentUrl,
    title: async () => 'Mock Title',
    viewportSize: () => ({ width: 1280, height: 800 }),
    screenshot: async (opts) => {
      calls.push(['screenshot', opts]);
      // A tiny non-empty buffer standing in for JPEG bytes.
      return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    },
    goto: async (u) => { calls.push(['goto', u]); currentUrl = u; },
    goBack: async () => { calls.push(['goBack']); },
    goForward: async () => { calls.push(['goForward']); },
    reload: async () => { calls.push(['reload']); },
    close: async () => { calls.push(['close']); },
    mouse: {
      click: async (x, y) => { calls.push(['click', x, y]); },
      move: async (x, y) => { calls.push(['move', x, y]); },
      wheel: async (dx, dy) => { calls.push(['wheel', dx, dy]); }
    },
    keyboard: {
      type: async (text) => { calls.push(['type', text]); },
      press: async (key) => { calls.push(['press', key]); }
    }
  };
}

function makeMockBackend() {
  const state = { openPageCalls: [], closeCalls: [], page: null };
  return {
    state,
    openPage: async (account, urlArg, options) => {
      state.openPageCalls.push({ account, url: urlArg, options });
      const page = makeMockPage(urlArg);
      state.page = page;
      return { backend: 'mock', profileDir: '/tmp/profiles/' + account, context: { close: async () => {} }, page, reused: false };
    },
    closeAccountContext: async (account) => {
      state.closeCalls.push(account);
      return { closed: true, state: 'closed' };
    }
  };
}

function makeMockArchive() {
  const state = { restored: [], uploaded: [] };
  return {
    state,
    restoreBeforeOpen: async (uid) => { state.restored.push(uid); return { ok: true, restored: true, role: 'page_posting_facebook_lite' }; },
    uploadAfterClose: async (uid) => { state.uploaded.push(uid); return { ok: true, uploaded: true, bytes: 123, files: 4 }; }
  };
}

// ── Manager unit tests ─────────────────────────────────────────────────────────────────────────

test('start restores archive, opens visible reused page, returns secret-free status', async () => {
  const browser = makeMockBackend();
  const archive = makeMockArchive();
  const mgr = createRemoteBrowserManager({ browser, profileArchiveSync: archive });

  const res = await mgr.start({ account_uid: 'CHEARB' });
  assert.equal(archive.state.restored[0], 'chearb'); // restoreBeforeOpen ran first, lowercased key
  assert.equal(browser.state.openPageCalls[0].options.visible, true);
  assert.equal(browser.state.openPageCalls[0].options.reuse, true);
  assert.match(res.id, /^rb_[0-9a-f]{36}$/); // unguessable crypto id
  assert.equal(res.account_uid, 'chearb');
  assert.equal(res.status, 'running');
  // No secret-shaped keys anywhere in the public status.
  assert.ok(!/cookie|token|password|datr|dtsg|context/i.test(JSON.stringify(res)));
});

test('start rejects invalid account uid and bad initial_url', async () => {
  const mgr = createRemoteBrowserManager({ browser: makeMockBackend(), profileArchiveSync: makeMockArchive() });
  await assert.rejects(() => mgr.start({ account_uid: '../etc/passwd' }), /Invalid account/);
  await assert.rejects(() => mgr.start({ account_uid: 'CHEARB', initial_url: 'javascript:alert(1)' }), /http/);
  await assert.rejects(() => mgr.start({ account_uid: 'CHEARB', initial_url: 'file:///etc/hosts' }), /http/);
});

test('input validates the action vocabulary and coordinate/url bounds', async () => {
  const browser = makeMockBackend();
  const mgr = createRemoteBrowserManager({ browser, profileArchiveSync: makeMockArchive() });
  const s = await mgr.start({ account_uid: 'CHEARB' });
  const page = browser.state.page;

  await mgr.input(s.id, 'click', { x: 100, y: 200 });
  assert.deepEqual(page.calls.find((c) => c[0] === 'click'), ['click', 100, 200]);

  await mgr.input(s.id, 'type', { text: 'hello' });
  assert.deepEqual(page.calls.find((c) => c[0] === 'type'), ['type', 'hello']);

  await mgr.input(s.id, 'scroll', { deltaY: 300 });
  assert.deepEqual(page.calls.find((c) => c[0] === 'wheel'), ['wheel', 0, 300]);

  await mgr.input(s.id, 'navigate', { url: 'https://m.facebook.com/' });
  assert.ok(page.calls.some((c) => c[0] === 'goto' && c[1] === 'https://m.facebook.com/'));

  // Rejections
  await assert.rejects(() => mgr.input(s.id, 'evaluate', { script: '1' }), /unsupported action/);
  await assert.rejects(() => mgr.input(s.id, 'click', { x: -5, y: 10 }), /out of range/);
  await assert.rejects(() => mgr.input(s.id, 'click', { x: 999999, y: 10 }), /out of range/);
  await assert.rejects(() => mgr.input(s.id, 'navigate', { url: 'ftp://x' }), /http/);
  await assert.rejects(() => mgr.input(s.id, 'type', { text: 'x'.repeat(5000) }), /too long/);
});

test('screenshot returns a jpeg buffer with quality 70 and fullPage false', async () => {
  const browser = makeMockBackend();
  const mgr = createRemoteBrowserManager({ browser, profileArchiveSync: makeMockArchive() });
  const s = await mgr.start({ account_uid: 'CHEARB' });
  const shot = await mgr.screenshot(s.id);
  assert.equal(shot.contentType, 'image/jpeg');
  assert.ok(Buffer.isBuffer(shot.buffer) && shot.buffer.length > 0);
  const opts = browser.state.page.calls.find((c) => c[0] === 'screenshot')[1];
  assert.equal(opts.type, 'jpeg');
  assert.equal(opts.quality, 70);
  assert.equal(opts.fullPage, false);
});

test('stop closes the context, uploads the archive, returns metadata only', async () => {
  const browser = makeMockBackend();
  const archive = makeMockArchive();
  const mgr = createRemoteBrowserManager({ browser, profileArchiveSync: archive });
  const s = await mgr.start({ account_uid: 'CHEARB' });
  const res = await mgr.stop(s.id);
  assert.equal(browser.state.closeCalls[0], 'chearb');
  assert.equal(archive.state.uploaded[0], 'chearb');
  assert.equal(res.closed, true);
  assert.equal(res.status, 'closed');
  assert.equal(res.archiveSync.uploaded, true);
  // Session is gone; further ops 404.
  await assert.rejects(() => mgr.status(s.id), /not found/);
});

test('unknown session id is a 404-coded not_found', async () => {
  const mgr = createRemoteBrowserManager({ browser: makeMockBackend(), profileArchiveSync: makeMockArchive() });
  await assert.rejects(() => mgr.status('rb_doesnotexist'), (e) => e.status === 404 && e.code === 'session_not_found');
});

// ── Server endpoint tests ──────────────────────────────────────────────────────────────────────

let server;
let backend;
let archive;

function req(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: reqPath,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        resolve({ status: res.statusCode, headers: res.headers, raw: buf, body: ct.includes('json') && buf.length ? JSON.parse(buf.toString()) : null });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

beforeEach(async () => {
  backend = makeMockBackend();
  archive = makeMockArchive();
  const remoteBrowser = createRemoteBrowserManager({ browser: backend, profileArchiveSync: archive });
  server = createServer({ browser: backend, remoteBrowser });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('server: full start → status → screenshot → input → stop lifecycle', async () => {
  const start = await req('POST', '/remote-browser/start', { account_uid: 'CHEARB' });
  assert.equal(start.status, 200);
  assert.equal(start.body.success, true);
  const id = start.body.session.id;
  assert.match(id, /^rb_/);

  const status = await req('GET', `/remote-browser/${id}/status`);
  assert.equal(status.status, 200);
  assert.equal(status.body.session.title, 'Mock Title');

  const shot = await req('GET', `/remote-browser/${id}/screenshot`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers['content-type'], 'image/jpeg');
  assert.ok(shot.raw.length > 0);

  const input = await req('POST', `/remote-browser/${id}/input`, { action: 'click', payload: { x: 10, y: 20 } });
  assert.equal(input.status, 200);
  assert.equal(input.body.success, true);

  const stop = await req('POST', `/remote-browser/${id}/stop`);
  assert.equal(stop.status, 200);
  assert.equal(stop.body.closed, true);
  assert.equal(archive.state.uploaded[0], 'chearb');
});

test('server: input on unknown session returns 404', async () => {
  const r = await req('POST', '/remote-browser/rb_nope/input', { action: 'click', payload: { x: 1, y: 1 } });
  assert.equal(r.status, 404);
});

test('server: start with invalid account returns 400', async () => {
  const r = await req('POST', '/remote-browser/start', { account_uid: '../escape' });
  assert.equal(r.status, 400);
});

test('server: CORS preflight is allowed for remote-browser routes from the dashboard origin', async () => {
  const r = await req('OPTIONS', '/remote-browser/start', null, { Origin: 'https://www.pubilo.com', 'Access-Control-Request-Method': 'POST' });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'https://www.pubilo.com');
});

test('server: a configured shared key gates remote-browser routes (401 without header, ok with it)', async () => {
  const prev = process.env.FACEBOOK_TOKEN_CLOAK_REMOTE_BROWSER_KEY;
  process.env.FACEBOOK_TOKEN_CLOAK_REMOTE_BROWSER_KEY = 'shared-secret-xyz';
  const gatedBackend = makeMockBackend();
  const gated = createServer({
    browser: gatedBackend,
    remoteBrowser: createRemoteBrowserManager({ browser: gatedBackend, profileArchiveSync: makeMockArchive() })
  });
  await new Promise((resolve) => gated.listen(0, '127.0.0.1', resolve));
  const port = gated.address().port;
  const call = (headers) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ account_uid: 'CHEARB' });
    const r = http.request({ hostname: '127.0.0.1', port, path: '/remote-browser/start', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject); r.write(payload); r.end();
  });
  try {
    const denied = await call({});
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error, 'remote_browser_unauthorized');
    const ok = await call({ 'x-remote-browser-key': 'shared-secret-xyz' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.success, true);
  } finally {
    if (prev === undefined) delete process.env.FACEBOOK_TOKEN_CLOAK_REMOTE_BROWSER_KEY;
    else process.env.FACEBOOK_TOKEN_CLOAK_REMOTE_BROWSER_KEY = prev;
    await new Promise((resolve) => gated.close(resolve));
  }
});

// When a remote-browser key is configured the capability routes fail closed without the shared header
// — cloudflared makes tunnel traffic look like loopback, so the secret is the only real gate. The
// dashboard proxy injects x-remote-browser-key server-side; the browser never holds it.
test('server: remote-browser routes require the shared key when one is configured', async () => {
  process.env.FACEBOOK_TOKEN_CLOAK_REMOTE_BROWSER_KEY = 'remote-secret-123';
  try {
    const noKey = await req('POST', '/remote-browser/start', { account_uid: 'CHEARB' });
    assert.equal(noKey.status, 401);
    assert.equal(noKey.body.error, 'remote_browser_unauthorized');

    const wrongKey = await req('POST', '/remote-browser/start', { account_uid: 'CHEARB' }, { 'x-remote-browser-key': 'nope' });
    assert.equal(wrongKey.status, 401);

    const okKey = await req('POST', '/remote-browser/start', { account_uid: 'CHEARB' }, { 'x-remote-browser-key': 'remote-secret-123' });
    assert.equal(okKey.status, 200);
    assert.equal(okKey.body.success, true);
  } finally {
    delete process.env.FACEBOOK_TOKEN_CLOAK_REMOTE_BROWSER_KEY;
  }
});
