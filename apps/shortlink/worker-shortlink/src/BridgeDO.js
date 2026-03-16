export class BridgeDO {
  constructor(state, env) {
    this.state = state;
    this.pendingJobs = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      for (const socket of this.state.getWebSockets('bridge')) {
        try {
          socket.close(1012, 'Replacing stale bridge');
        } catch (_) {}
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, ['bridge']);
      return new Response(null, { status: 101, webSocket: client });
    }

    return this.handleJob(request);
  }

  async webSocketMessage(ws, message) {
    try {
      const result = JSON.parse(message);
      if (result?.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: result.ts || Date.now() }));
        return;
      }
      if (result?.type === 'hello') {
        ws.send(JSON.stringify({ type: 'hello-ack', now: Date.now() }));
        return;
      }
      const { jobId, ok, shortLink, utmSource, normalizedUrl, redirectUrl, error } = result;
      const job = this.pendingJobs.get(jobId);
      if (!job) return;
      job.resolve({ ok, shortLink, utmSource, normalizedUrl, redirectUrl, error });
    } catch (_) {}
  }

  async webSocketClose() {
    for (const [jobId, job] of this.pendingJobs) {
      clearTimeout(job.timer);
      job.resolve({ ok: false, error: 'Electron disconnected' });
    }
    this.pendingJobs.clear();
  }

  async webSocketError() {
    await this.webSocketClose();
  }

  async handleJob(request) {
    const url = new URL(request.url);
    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) return json({ error: 'url param required' }, 400);

    const sockets = this.state.getWebSockets('bridge');
    if (sockets.length === 0) {
      return json({ error: 'Electron app is not connected' }, 503);
    }
    const bridgeSocket = sockets[sockets.length - 1];

    const jobId = crypto.randomUUID();
    const payload = {
      rawUrl,
      subId1: url.searchParams.get('sub1') || undefined,
      subId2: url.searchParams.get('sub2') || undefined,
      subId3: url.searchParams.get('sub3') || undefined,
      subId4: url.searchParams.get('sub4') || undefined,
      subId5: url.searchParams.get('sub5') || undefined,
    };

    try {
      bridgeSocket.send(JSON.stringify({ jobId, payload }));
    } catch (_) {
      try {
        bridgeSocket.close(1011, 'Send failed');
      } catch (_) {}
      return json({ error: 'Electron app is not connected' }, 503);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(jobId);
        resolve(json({ error: 'Timed out waiting for Electron response' }, 504));
      }, 30000);

      this.pendingJobs.set(jobId, {
        timer,
        resolve: ({ ok, shortLink, utmSource, normalizedUrl, redirectUrl, error }) => {
          clearTimeout(timer);
          this.pendingJobs.delete(jobId);
          if (ok) {
            resolve(json({
              originalLink: rawUrl,
              ...(redirectUrl ? { redirectLink: redirectUrl } : {}),
              longLink: normalizedUrl || rawUrl,
              shortLink,
              ...(utmSource ? { utm_source: utmSource } : {}),
              sub1: url.searchParams.get('sub1') || null,
              sub2: url.searchParams.get('sub2') || null,
              sub3: url.searchParams.get('sub3') || null,
              sub4: url.searchParams.get('sub4') || null,
              sub5: url.searchParams.get('sub5') || null,
            }));
          } else {
            resolve(json({ error: error || 'Failed to create shortlink' }, 500));
          }
        },
      });
    });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
