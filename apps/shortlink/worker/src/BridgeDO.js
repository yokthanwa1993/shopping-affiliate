
export class BridgeDO {
  constructor(state, env) {
    this.state = state;
    this.pendingJobs = new Map(); // jobId → { resolve, timer, rawUrl, productUrl, params }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Electron เชื่อมต่อผ่าน WebSocket
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, ['bridge']);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Client เรียก ?url=...
    return this.handleJob(request);
  }

  // ── WebSocket: รับผลลัพธ์จาก Electron ────────────────────────────────────────
  async webSocketMessage(ws, message) {
    try {
      const result = JSON.parse(message);
      const { jobId, ok, shortLink, normalizedUrl, redirectUrl, error } = result;
      const job = this.pendingJobs.get(jobId);
      if (!job) return;
      job.resolve({ ok, shortLink, normalizedUrl, redirectUrl, error });
    } catch (_) {}
  }

  async webSocketClose(ws) {
    // WebSocket ปิด — reject jobs ที่ค้างอยู่
    for (const [jobId, job] of this.pendingJobs) {
      clearTimeout(job.timer);
      job.resolve({ ok: false, error: 'Electron disconnected' });
    }
    this.pendingJobs.clear();
  }

  async webSocketError(ws, error) {
    await this.webSocketClose(ws);
  }

  // ── ส่งงานไปให้ Electron ──────────────────────────────────────────────────────
  async handleJob(request) {
    const url = new URL(request.url);
    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) return json({ error: 'url param required' }, 400);

    // เช็ค WebSocket connection
    const sockets = this.state.getWebSockets('bridge');
    if (sockets.length === 0) {
      return json({ error: 'Electron app ไม่ได้เชื่อมต่อ — เปิด app ก่อน' }, 503);
    }

    const jobId = crypto.randomUUID();
    const payload = {
      rawUrl,  // ส่ง rawUrl ให้ Electron — Electron จะ expand+normalize เอง
      subId1: url.searchParams.get('sub1') || undefined,
      subId2: url.searchParams.get('sub2') || undefined,
      subId3: url.searchParams.get('sub3') || undefined,
      subId4: url.searchParams.get('sub4') || undefined,
      subId5: url.searchParams.get('sub5') || undefined,
    };

    // ส่ง job ไปทาง WebSocket ทันที
    sockets[0].send(JSON.stringify({ jobId, payload }));

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(jobId);
        resolve(json({ error: 'หมดเวลา — Electron ไม่ตอบกลับ' }, 504));
      }, 20000);

      this.pendingJobs.set(jobId, {
        timer,
        resolve: ({ ok, shortLink, normalizedUrl, redirectUrl, error }) => {
          clearTimeout(timer);
          this.pendingJobs.delete(jobId);
          if (ok) {
            resolve(json({
              originalLink: rawUrl,
              ...(redirectUrl ? { redirectLink: redirectUrl } : {}),
              longLink: normalizedUrl || rawUrl,
              shortLink: shortLink,
              sub1: url.searchParams.get('sub1') || null,
              sub2: url.searchParams.get('sub2') || null,
              sub3: url.searchParams.get('sub3') || null,
              sub4: url.searchParams.get('sub4') || null,
              sub5: url.searchParams.get('sub5') || null,
            }));
          } else {
            resolve(json({ error: error || 'ย่อลิ้งไม่สำเร็จ' }, 500));
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
