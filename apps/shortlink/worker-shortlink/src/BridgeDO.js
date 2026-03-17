export class BridgeDO {
  constructor(state, env) {
    this.state = state;
    this.pendingJobs = new Map();
    this.jobQueue = [];
    this.waitingPolls = [];
    this.lastPollAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/poll') {
      return this.handlePoll(request);
    }

    if (url.pathname === '/api/complete') {
      return this.handleComplete(request);
    }

    return this.handleJob(request);
  }

  async handlePoll(request) {
    this.lastPollAt = Date.now();

    let timeoutMs = 25000;
    if (request.method === 'POST') {
      try {
        const body = await request.json();
        if (Number.isFinite(body?.timeoutMs)) {
          timeoutMs = Math.max(1000, Math.min(60000, Number(body.timeoutMs)));
        }
      } catch (_) {}
    }

    const nextJob = this.jobQueue.shift();
    if (nextJob) {
      nextJob.inFlight = true;
      nextJob.dispatchedAt = Date.now();
      return json({ jobId: nextJob.jobId, payload: nextJob.payload });
    }

    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waitingPolls = this.waitingPolls.filter((entry) => entry !== waiter);
          resolve(new Response(null, { status: 204 }));
        }, timeoutMs),
      };
      this.waitingPolls.push(waiter);
    });
  }

  async handleComplete(request) {
    let result;
    try {
      result = await request.json();
    } catch (_) {
      return json({ error: 'invalid completion payload' }, 400);
    }

    const jobId = String(result?.jobId || result?.requestId || '').trim();
    if (!jobId) {
      return json({ error: 'jobId required' }, 400);
    }

    const job = this.pendingJobs.get(jobId);
    if (!job) {
      return json({ ok: true, ignored: true });
    }

    job.resolve({
      ok: Boolean(result?.ok),
      shortLink: result?.shortLink || '',
      utmSource: result?.utmSource || '',
      normalizedUrl: result?.normalizedUrl || '',
      redirectUrl: result?.redirectUrl || '',
      error: result?.error || '',
    });

    return json({ ok: true });
  }

  dispatchJob(jobEnvelope) {
    const waiter = this.waitingPolls.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      jobEnvelope.inFlight = true;
      jobEnvelope.dispatchedAt = Date.now();
      waiter.resolve(json({ jobId: jobEnvelope.jobId, payload: jobEnvelope.payload }));
      return;
    }

    this.jobQueue.push(jobEnvelope);
  }

  removeQueuedJob(jobId) {
    this.jobQueue = this.jobQueue.filter((job) => job.jobId !== jobId);
  }

  async handleJob(request) {
    const url = new URL(request.url);
    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) return json({ error: 'url param required' }, 400);

    const jobId = crypto.randomUUID();
    const payload = {
      rawUrl,
      subId1: url.searchParams.get('sub1') || undefined,
      subId2: url.searchParams.get('sub2') || undefined,
      subId3: url.searchParams.get('sub3') || undefined,
      subId4: url.searchParams.get('sub4') || undefined,
      subId5: url.searchParams.get('sub5') || undefined,
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(jobId);
        this.removeQueuedJob(jobId);

        const idleForMs = this.lastPollAt ? Date.now() - this.lastPollAt : Number.POSITIVE_INFINITY;
        if (idleForMs > 45000) {
          resolve(json({ error: 'Chrome extension is not connected' }, 503));
          return;
        }

        resolve(json({ error: 'Timed out waiting for Chrome bridge response' }, 504));
      }, 45000);

      const job = {
        jobId,
        timer,
        payload,
        inFlight: false,
        resolve: ({ ok, shortLink, utmSource, normalizedUrl, redirectUrl, error }) => {
          clearTimeout(timer);
          this.pendingJobs.delete(jobId);
          this.removeQueuedJob(jobId);

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
            return;
          }

          resolve(json({ error: error || 'Failed to create shortlink' }, 500));
        },
      };

      this.pendingJobs.set(jobId, job);
      this.dispatchJob(job);
    });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
