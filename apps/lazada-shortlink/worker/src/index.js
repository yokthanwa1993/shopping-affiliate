// lazada-short - Cloudflare Worker + Durable Object (Long Polling)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const id = env.JOB_BRIDGE.idFromName('default');
    const stub = env.JOB_BRIDGE.get(id);

    // GET /?url=<lazada-url>&account=NAME&sub1=xxx
    if (url.pathname === '/' && url.searchParams.has('url')) {
      const productUrl = url.searchParams.get('url');
      const account = url.searchParams.get('account') || 'default';
      const sub1 = url.searchParams.get('sub1') || null;

      const payload = { productUrl, account, sub1: sub1 || '' };

      const res = await stub.fetch(new Request('https://do/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }));

      if (!res.ok) {
        const errText = await res.text();
        return Response.json({ ok: false, error: errText }, { status: res.status, headers: CORS });
      }

      const data = await res.json();

      return Response.json({
        originalLink: productUrl,
        redirectLink: data.redirectLink || null,
        longLink: data.longLink || null,
        shortLink: data.shortLink,
        utm_source: data.utmSource || null,
        member_id: data.memberId || null,
        promotionCode: data.promotionCode || null,
        account,
        sub1,
      }, { headers: CORS });
    }

    // POST /api/poll - Electron agent polls for jobs
    if (url.pathname === '/api/poll' && request.method === 'POST') {
      return stub.fetch(new Request('https://do/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: request.body,
      }));
    }

    // POST /api/complete - Electron agent returns result
    if (url.pathname === '/api/complete' && request.method === 'POST') {
      return stub.fetch(new Request('https://do/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: request.body,
      }));
    }

    // Landing
    if (url.pathname === '/') {
      return new Response('lazada-short - usage: /?url=<lazada-url>&account=NAME&sub1=xxx', {
        headers: { 'Content-Type': 'text/plain', ...CORS },
      });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};

// --- Durable Object: Long Polling bridge ---

export class JobBridge {
  constructor(state) {
    this.pendingJobs = [];
    this.waitingPollers = [];
    this.waitingClients = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/submit') return this.handleSubmit(request);
    if (url.pathname === '/poll') return this.handlePoll(request);
    if (url.pathname === '/complete') return this.handleComplete(request);
    return new Response('Not found', { status: 404 });
  }

  async handleSubmit(request) {
    const payload = await request.json();
    const jobId = crypto.randomUUID();
    const job = { jobId, payload };

    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waitingClients.delete(jobId);
        resolve({ ok: false, error: 'Timeout - no agent connected' });
      }, 30000);

      this.waitingClients.set(jobId, { resolve, timer });

      if (this.waitingPollers.length > 0) {
        const poller = this.waitingPollers.shift();
        clearTimeout(poller.timer);
        poller.resolve(Response.json(job));
      } else {
        this.pendingJobs.push(job);
      }
    });

    if (result.ok) {
      return Response.json({
        shortLink: result.shortLink,
        longLink: result.longLink || null,
        redirectLink: result.redirectLink || null,
        utmSource: result.utmSource || null,
        memberId: result.memberId || null,
        promotionCode: result.promotionCode || null,
      });
    }
    return new Response(result.error || 'Failed', { status: 502 });
  }

  async handlePoll(request) {
    const { timeoutMs = 25000 } = await request.json().catch(() => ({}));

    if (this.pendingJobs.length > 0) {
      return Response.json(this.pendingJobs.shift());
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waitingPollers.findIndex(p => p.timer === timer);
        if (idx >= 0) this.waitingPollers.splice(idx, 1);
        resolve(new Response(null, { status: 204 }));
      }, Math.min(timeoutMs, 25000));

      this.waitingPollers.push({ resolve, timer });
    });
  }

  async handleComplete(request) {
    const { jobId, ok, shortLink, longLink, redirectLink, utmSource, memberId, promotionCode, error } = await request.json();

    const client = this.waitingClients.get(jobId);
    if (client) {
      clearTimeout(client.timer);
      this.waitingClients.delete(jobId);
      client.resolve({ ok, shortLink, longLink, redirectLink, utmSource, memberId, promotionCode, error });
    }

    return new Response('OK');
  }
}
