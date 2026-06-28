'use strict';

// Minimal, dependency-free WebSocket server for the Cloud Browser LIVE stream. We intentionally do NOT
// pull in the `ws` package here so the Mac bridge keeps its tiny dependency surface (cloakbrowser +
// playwright-core only) and `npm test` runs with just `node --test`.
//
// WHAT THIS DOES: handles the HTTP `upgrade` event for `/remote-browser/:id/stream`, performs the
// RFC6455 handshake, wraps the raw TCP socket in a small EventEmitter (`message` / `close` / `error` +
// `.send()` / `.close()`), and hands it to remoteBrowser.startScreencast(sessionId, ws). The screencast
// uses Chrome DevTools Protocol (Page.startScreencast + Input.dispatchMouseEvent/dispatchKeyEvent) so it
// streams ONLY the one viewport page — never the desktop, never a raw DevTools port to the client.
//
// SAFETY: the upgrade is gated by the SAME shared-secret check the HTTP remote-browser routes use
// (passed in as `authorized`). The session id is an unguessable crypto handle. No eval / no raw CDP
// passthrough is exposed — startScreencast validates a fixed input vocabulary. Inbound frames are size
// bounded so a hostile client cannot exhaust memory.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// Bound a single inbound message / accumulated buffer. Client→server messages are tiny JSON actions;
// nothing legitimate approaches this, so anything larger is hostile/buggy and we drop the connection.
const MAX_INBOUND_BYTES = 1 * 1024 * 1024;

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 426: 'Upgrade Required' };

function computeAcceptValue(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

// Encode a server→client frame (always unmasked, FIN set). Handles the 7-bit / 16-bit / 64-bit length
// forms so large base64 JPEG frames (a full viewport can be hundreds of KB) are framed correctly.
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

class ServerWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1; // OPEN (matches the WebSocket constant the manager checks)
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOpcode = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => { this.emit('error', err); this._onClose(); });
  }

  send(data) {
    if (this.readyState !== 1) return;
    const isBuffer = Buffer.isBuffer(data);
    const payload = isBuffer ? data : Buffer.from(String(data), 'utf8');
    try { this.socket.write(encodeFrame(isBuffer ? 0x2 : 0x1, payload)); } catch { /* peer gone */ }
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    if (this.readyState === 1) {
      this.readyState = 2; // CLOSING
      try {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        this.socket.write(encodeFrame(0x8, payload));
      } catch { /* ignore */ }
    }
    try { this.socket.end(); } catch { /* ignore */ }
  }

  _onClose() {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (this._buf.length > MAX_INBOUND_BYTES) {
      this.close(1009);
      try { this.socket.destroy(); } catch { /* ignore */ }
      return;
    }
    let frame;
    while ((frame = this._decodeFrame()) !== null) {
      this._handleFrame(frame);
      if (this.readyState === 3) return;
    }
  }

  // Pull one complete frame from the buffer, or null when more bytes are needed.
  _decodeFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(MAX_INBOUND_BYTES)) { this.close(1009); try { this.socket.destroy(); } catch {} return null; }
      len = Number(big);
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (masked && maskKey) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    } else {
      payload = Buffer.from(payload); // detach from the shared buffer before we slice it away
    }
    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    switch (opcode) {
      case 0x0: // continuation
        if (this._fragOpcode == null) return;
        this._frags.push(payload);
        if (fin) {
          const full = Buffer.concat(this._frags);
          const op = this._fragOpcode;
          this._frags = [];
          this._fragOpcode = null;
          this._emitMessage(op, full);
        }
        break;
      case 0x1: // text
      case 0x2: // binary
        if (!fin) {
          this._fragOpcode = opcode;
          this._frags = [payload];
        } else {
          this._emitMessage(opcode, payload);
        }
        break;
      case 0x8: // close
        this.close();
        this._onClose();
        break;
      case 0x9: // ping → pong
        try { this.socket.write(encodeFrame(0xA, payload)); } catch { /* ignore */ }
        break;
      case 0xA: // pong
        break;
      default:
        this.close(1002);
        break;
    }
  }

  _emitMessage(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('message', payload);
  }
}

function rejectUpgrade(socket, status) {
  try {
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Error'}\r\nConnection: close\r\n\r\n`);
  } catch { /* ignore */ }
  try { socket.destroy(); } catch { /* ignore */ }
}

// Attach the `upgrade` handler that turns a /remote-browser/:id/stream upgrade into a live screencast.
//   server         the http.Server
//   remoteBrowser  the remote browser manager (must expose startScreencast(sessionId, ws, opts))
//   options.authorized(req) -> boolean   the SAME shared-secret gate the HTTP routes use (fail closed)
function attachRemoteBrowserUpgrade(server, remoteBrowser, options = {}) {
  if (!server || typeof server.on !== 'function') throw new Error('attachRemoteBrowserUpgrade requires an http server');
  if (!remoteBrowser || typeof remoteBrowser.startScreencast !== 'function') {
    throw new Error('attachRemoteBrowserUpgrade requires a remoteBrowser manager with startScreencast');
  }
  const authorized = typeof options.authorized === 'function' ? options.authorized : () => true;

  server.on('upgrade', (req, socket /*, head */) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return rejectUpgrade(socket, 400);
    }
    const match = url.pathname.match(/^\/remote-browser\/([A-Za-z0-9_-]+)\/stream$/);
    if (!match) return rejectUpgrade(socket, 404);

    const upgradeHeader = String(req.headers['upgrade'] || '').toLowerCase();
    const wsKey = String(req.headers['sec-websocket-key'] || '').trim();
    if (upgradeHeader !== 'websocket' || !wsKey) return rejectUpgrade(socket, 426);

    // Same shared-secret capability gate as the HTTP routes — cloudflared makes tunnel traffic look
    // like loopback, so the secret is the real gate. Fail closed.
    if (!authorized(req)) return rejectUpgrade(socket, 401);

    const sessionId = match[1];
    const accept = computeAcceptValue(wsKey);
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
      );
    } catch {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }

    const ws = new ServerWebSocket(socket);
    // Optional quality/fps hints from the query string, clamped inside startScreencast.
    const quality = Number(url.searchParams.get('quality'));
    const everyNthFrame = Number(url.searchParams.get('everyNthFrame'));
    const maxWidth = Number(url.searchParams.get('maxWidth'));
    const maxHeight = Number(url.searchParams.get('maxHeight'));
    Promise.resolve(
      remoteBrowser.startScreencast(sessionId, ws, {
        quality: Number.isFinite(quality) ? quality : undefined,
        everyNthFrame: Number.isFinite(everyNthFrame) ? everyNthFrame : undefined,
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        maxHeight: Number.isFinite(maxHeight) ? maxHeight : undefined,
      }),
    ).catch((err) => {
      const code = err && err.code ? String(err.code) : 'screencast_failed';
      try { ws.send(JSON.stringify({ type: 'error', error: code })); } catch { /* ignore */ }
      try { ws.close(1011); } catch { /* ignore */ }
    });
  });

  return server;
}

module.exports = { attachRemoteBrowserUpgrade, ServerWebSocket, computeAcceptValue, encodeFrame };
