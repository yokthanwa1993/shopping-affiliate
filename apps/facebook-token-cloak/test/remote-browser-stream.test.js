'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createRemoteBrowserManager } = require('../src/remoteBrowser');
const { computeAcceptValue, encodeFrame, ServerWebSocket } = require('../src/remoteBrowserWs');

// Flush pending microtasks/timers so async ws message handlers complete before we assert.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// ── Fakes: CDP session, page (with context().newCDPSession), browser backend, ws ─────────────────

function makeFakeCdp() {
  const sent = [];
  const listeners = new Map();
  return {
    sent,
    send: async (method, params) => { sent.push([method, params]); return {}; },
    on: (ev, fn) => { listeners.set(ev, fn); },
    off: (ev, fn) => { if (listeners.get(ev) === fn) listeners.delete(ev); },
    detach: async () => { sent.push(['__detach__']); },
    emit: (ev, payload) => { const fn = listeners.get(ev); return fn ? fn(payload) : undefined; },
    hasListener: (ev) => listeners.has(ev),
  };
}

function makeFakePage() {
  const cdp = makeFakeCdp();
  const calls = [];
  return {
    cdp,
    calls,
    url: () => 'https://www.facebook.com/',
    title: async () => 'Mock Title',
    viewportSize: () => ({ width: 1280, height: 800 }),
    context: () => ({ newCDPSession: async () => cdp }),
    goto: async (u) => { calls.push(['goto', u]); },
    goBack: async () => { calls.push(['goBack']); },
    goForward: async () => { calls.push(['goForward']); },
    reload: async () => { calls.push(['reload']); },
    close: async () => { calls.push(['close']); },
    mouse: { click: async () => {}, move: async () => {}, wheel: async () => {} },
    keyboard: { type: async () => {}, press: async () => {} },
  };
}

function makeBackend(page) {
  return {
    state: { closed: [] },
    openPage: async () => ({ backend: 'mock', page, context: page.context(), reused: false }),
    closeAccountContext: async (account) => { return { closed: true }; },
  };
}

function makeArchive() {
  return {
    restoreBeforeOpen: async () => ({ ok: true, restored: true }),
    uploadAfterClose: async () => ({ ok: true, uploaded: true }),
  };
}

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 1;
    this.closedWith = null;
  }
  send(s) { this.sent.push(s); }
  close(code) { this.closedWith = code ?? 1000; this.readyState = 3; this.emit('close'); }
  messages() { return this.sent.map((s) => JSON.parse(s)); }
}

async function startedSession() {
  const page = makeFakePage();
  const mgr = createRemoteBrowserManager({ browser: makeBackend(page), profileArchiveSync: makeArchive() });
  const s = await mgr.start({ account_uid: 'CHEARB' });
  return { page, mgr, s };
}

// ── startScreencast wiring ───────────────────────────────────────────────────────────────────────

test('startScreencast attaches CDP, starts jpeg screencast, sends initial status', async () => {
  const { page, mgr, s } = await startedSession();
  const ws = new FakeWs();
  await mgr.startScreencast(s.id, ws);

  const start = page.cdp.sent.find((c) => c[0] === 'Page.startScreencast');
  assert.ok(start, 'Page.startScreencast was sent');
  assert.equal(start[1].format, 'jpeg');
  assert.ok(start[1].quality >= 1 && start[1].quality <= 100);
  assert.ok(page.cdp.hasListener('Page.screencastFrame'));

  const status = ws.messages().find((m) => m.type === 'status');
  assert.ok(status, 'an initial status frame is sent');
  assert.equal(status.url, 'https://www.facebook.com/');
  assert.equal(status.title, 'Mock Title');
});

test('quality hint is clamped to 1..100', async () => {
  const { page, mgr, s } = await startedSession();
  await mgr.startScreencast(s.id, new FakeWs(), { quality: 9000 });
  const start = page.cdp.sent.find((c) => c[0] === 'Page.startScreencast');
  assert.equal(start[1].quality, 100);
});

// ── frame relay + ACK ────────────────────────────────────────────────────────────────────────────

test('screencastFrame is relayed as a frame message and ACKed', async () => {
  const { page, mgr, s } = await startedSession();
  const ws = new FakeWs();
  await mgr.startScreencast(s.id, ws);

  await page.cdp.emit('Page.screencastFrame', { data: 'QkFTRTY0SlBFRw==', sessionId: 42, metadata: { timestamp: 1 } });
  await flush();

  const frame = ws.messages().find((m) => m.type === 'frame');
  assert.ok(frame, 'a frame message was sent');
  assert.equal(frame.data, 'QkFTRTY0SlBFRw==');
  assert.equal(frame.seq, 1);
  assert.equal(frame.sessionId, s.id);

  const ack = page.cdp.sent.find((c) => c[0] === 'Page.screencastFrameAck');
  assert.ok(ack, 'frame was ACKed so CDP keeps producing frames');
  assert.equal(ack[1].sessionId, 42);
});

// ── input dispatch ─────────────────────────────────────────────────────────────────────────────

test('mouse + key messages dispatch via CDP Input.* with validation', async () => {
  const { page, mgr, s } = await startedSession();
  const ws = new FakeWs();
  await mgr.startScreencast(s.id, ws);

  ws.emit('message', JSON.stringify({ type: 'mouse', event: 'mousePressed', x: 100, y: 200, button: 'left' }));
  ws.emit('message', JSON.stringify({ type: 'mouse', event: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: 240 }));
  ws.emit('message', JSON.stringify({ type: 'key', event: 'keyDown', key: 'Enter', code: 'Enter' }));
  ws.emit('message', JSON.stringify({ type: 'key', event: 'char', text: 'a' }));
  await flush();

  const mouse = page.cdp.sent.find((c) => c[0] === 'Input.dispatchMouseEvent' && c[1].type === 'mousePressed');
  assert.ok(mouse);
  assert.equal(mouse[1].x, 100);
  assert.equal(mouse[1].button, 'left');
  assert.equal(mouse[1].clickCount, 1);

  const wheel = page.cdp.sent.find((c) => c[0] === 'Input.dispatchMouseEvent' && c[1].type === 'mouseWheel');
  assert.ok(wheel);
  assert.equal(wheel[1].deltaY, 240);

  const key = page.cdp.sent.find((c) => c[0] === 'Input.dispatchKeyEvent' && c[1].type === 'keyDown');
  assert.ok(key);
  assert.equal(key[1].key, 'Enter');

  const charKey = page.cdp.sent.find((c) => c[0] === 'Input.dispatchKeyEvent' && c[1].type === 'char');
  assert.ok(charKey);
  assert.equal(charKey[1].text, 'a');
});

test('out-of-vocabulary / out-of-bounds messages never reach CDP and never crash the stream', async () => {
  const { page, mgr, s } = await startedSession();
  const ws = new FakeWs();
  await mgr.startScreencast(s.id, ws);

  ws.emit('message', JSON.stringify({ type: 'mouse', event: 'evil', x: 1, y: 1 }));
  ws.emit('message', JSON.stringify({ type: 'mouse', event: 'mousePressed', x: -5, y: 1 })); // out of range
  ws.emit('message', JSON.stringify({ type: 'evaluate', script: '1+1' }));
  ws.emit('message', 'not-json');
  ws.emit('message', JSON.stringify({ type: 'cdp', method: 'Runtime.evaluate' })); // no raw CDP passthrough
  await flush();

  assert.equal(page.cdp.sent.filter((c) => c[0] === 'Input.dispatchMouseEvent').length, 0);
  // No raw CDP method other than the screencast lifecycle was ever invoked.
  const allowed = new Set(['Page.startScreencast', 'Page.screencastFrameAck', 'Page.stopScreencast', '__detach__']);
  for (const [method] of page.cdp.sent) assert.ok(allowed.has(method), `unexpected CDP method ${method}`);
});

test('navigate + command messages drive the page and re-send status', async () => {
  const { page, mgr, s } = await startedSession();
  const ws = new FakeWs();
  await mgr.startScreencast(s.id, ws);

  ws.emit('message', JSON.stringify({ type: 'navigate', url: 'https://m.facebook.com/' }));
  ws.emit('message', JSON.stringify({ type: 'command', command: 'reload' }));
  await flush();

  assert.ok(page.calls.some((c) => c[0] === 'goto' && c[1] === 'https://m.facebook.com/'));
  assert.ok(page.calls.some((c) => c[0] === 'reload'));
  assert.ok(ws.messages().filter((m) => m.type === 'status').length >= 2);
});

// ── cleanup ──────────────────────────────────────────────────────────────────────────────────────

test('ws close stops the screencast and detaches the CDP session', async () => {
  const { page, mgr, s } = await startedSession();
  const ws = new FakeWs();
  await mgr.startScreencast(s.id, ws);

  ws.close();
  await flush();

  assert.ok(page.cdp.sent.some((c) => c[0] === 'Page.stopScreencast'), 'Page.stopScreencast on ws close');
  assert.ok(page.cdp.sent.some((c) => c[0] === '__detach__'), 'CDP session detached');
  assert.ok(!page.cdp.hasListener('Page.screencastFrame'), 'frame listener removed');

  // Frames emitted after close are not relayed.
  const before = ws.sent.length;
  await page.cdp.emit('Page.screencastFrame', { data: 'late', sessionId: 1 });
  await flush();
  assert.equal(ws.sent.length, before, 'no frames relayed after teardown');
});

test('stop() tears down an active screencast before closing the context', async () => {
  const { page, mgr, s } = await startedSession();
  await mgr.startScreencast(s.id, new FakeWs());
  await mgr.stop(s.id);
  assert.ok(page.cdp.sent.some((c) => c[0] === 'Page.stopScreencast'));
});

test('command:stop closes the ws and tears down', async () => {
  const { page, mgr, s } = await startedSession();
  const ws = new FakeWs();
  await mgr.startScreencast(s.id, ws);
  ws.emit('message', JSON.stringify({ type: 'command', command: 'stop' }));
  await flush();
  assert.equal(ws.readyState, 3);
  assert.ok(page.cdp.sent.some((c) => c[0] === 'Page.stopScreencast'));
});

// ── no secret leakage ──────────────────────────────────────────────────────────────────────────

test('no message carries a secret-shaped field', async () => {
  const { page, mgr, s } = await startedSession();
  const ws = new FakeWs();
  await mgr.startScreencast(s.id, ws);
  await page.cdp.emit('Page.screencastFrame', { data: 'aaa', sessionId: 1 });
  ws.emit('message', JSON.stringify({ type: 'navigate', url: 'https://www.facebook.com/' }));
  await flush();
  const joined = ws.sent.join(' ');
  assert.ok(!/cookie|token|password|datr|dtsg|fb_dtsg/i.test(joined), 'no secret keys in the stream');
});

// ── WebSocket frame codec ────────────────────────────────────────────────────────────────────────

test('computeAcceptValue matches the RFC6455 example', () => {
  // From RFC 6455 §1.3: key "dGhlIHNhbXBsZSBub25jZQ==" → accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
  assert.equal(computeAcceptValue('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame produces unmasked text frames with correct length forms', () => {
  const small = encodeFrame(0x1, Buffer.from('hi'));
  assert.equal(small[0], 0x81); // FIN + text
  assert.equal(small[1], 2); // unmasked, len 2

  const medium = encodeFrame(0x1, Buffer.alloc(200));
  assert.equal(medium[1], 126);
  assert.equal(medium.readUInt16BE(2), 200);

  const large = encodeFrame(0x1, Buffer.alloc(70000));
  assert.equal(large[1], 127);
  assert.equal(Number(large.readBigUInt64BE(2)), 70000);
});

test('ServerWebSocket decodes a masked client text frame', async () => {
  const socket = new EventEmitter();
  socket.setNoDelay = () => {};
  socket.write = () => {};
  socket.end = () => {};
  socket.destroy = () => {};
  const ws = new ServerWebSocket(socket);
  const received = [];
  ws.on('message', (m) => received.push(m));

  // Build a masked client frame for the text "ping".
  const payload = Buffer.from('ping');
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
  socket.emit('data', frame);
  await flush();
  assert.deepEqual(received, ['ping']);
});
