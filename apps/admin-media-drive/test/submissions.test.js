import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';

function tempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-sub-'));
  return path.join(dir, name);
}

class FakeDiscord {
  constructor() {
    this.configured = true;
    this.ready = true;
    this.error = '';
    this.user = null;
    this.uploads = [];
  }

  async resolveFreshUrl(_c, _m, attachmentId) {
    return `https://cdn.example/fresh/${attachmentId}`;
  }

  async uploadFile({ channelId, filename, mimetype }) {
    this.uploads.push({ channelId, filename, mimetype });
    const n = this.uploads.length;
    return {
      id: `att${n}`,
      messageId: `m${n}`,
      channelId,
      guildId: 'g1',
      filename,
      size: 3,
      contentType: mimetype || 'video/mp4',
      url: `https://cdn.example/att${n}`,
      proxyUrl: `/api/media/${channelId}/m${n}/att${n}`,
      jumpUrl: `https://discord.com/channels/g1/${channelId}/m${n}`,
      createdAt: '2026-07-12T00:00:00.000Z',
    };
  }
}

class FakeProcessor {
  constructor() {
    this.inputMode = 'url';
  }

  async health() {
    return { mode: 'merge_rust', mergeRust: { ok: true }, queueProcessor: 'video-affiliate/merge-rust', model: 'm', vertexTtsModel: 'v', voiceName: 'Puck' };
  }

  async processVideo({ outputPath }) {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, 'processed');
    return { outputPath, pipeline: 'merge_rust' };
  }
}

async function startServer({ subtitleGate = null } = {}) {
  const discord = new FakeDiscord();
  const db = openDb(tempPath('index.sqlite'));
  const cfg = {
    port: 0,
    host: '127.0.0.1',
    storageMode: 'discord',
    maxUploadBytes: 1024 * 1024,
    namespaceId: 'admin',
    mediaRoot: tempPath('media'),
    dbPath: tempPath('unused.sqlite'),
    discord: {
      botToken: 'x',
      guildId: 'g1',
      defaultChannelId: 'c1',
      sourceChannelId: 'source-channel',
      processedChannelId: 'processed-channel',
    },
    processor: { ffmpegBin: 'ffmpeg', ffprobeBin: 'ffprobe', videoEncoder: 'auto', keepTmp: false, pollMs: 1000 },
  };
  const { app } = createApp({
    cfg, discord, db, processor: new FakeProcessor(), subtitleGate,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, db, discord };
}

function videoForm(bytes, { name = 'clip.mp4', idempotencyKey } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), name);
  if (idempotencyKey) form.append('idempotencyKey', idempotencyKey);
  return form;
}

test('submissions upload once to the SOURCE channel, enqueue once, and dedupe by content hash', async () => {
  const { base, server, discord } = await startServer();
  try {
    const first = await fetch(`${base}/api/processor/submissions`, {
      method: 'POST',
      body: videoForm(Buffer.from('same-bytes'), { idempotencyKey: 'key-1' }),
    });
    const a = await first.json();
    assert.equal(first.status, 201, JSON.stringify(a));
    assert.equal(a.deduplicated, false);
    assert.equal(a.mediaItem.channel_id, 'source-channel');
    assert.equal(a.job.status, 'queued');
    assert.ok(a.submission.source_sha256);
    assert.equal(discord.uploads.length, 1);
    assert.equal(discord.uploads[0].channelId, 'source-channel');

    // Same bytes + same key -> identical identity, no second upload/job.
    const again = await fetch(`${base}/api/processor/submissions`, {
      method: 'POST',
      body: videoForm(Buffer.from('same-bytes'), { idempotencyKey: 'key-1' }),
    });
    const b = await again.json();
    assert.equal(again.status, 200);
    assert.equal(b.deduplicated, true);
    assert.equal(b.job.id, a.job.id);
    assert.equal(b.mediaItem.id, a.mediaItem.id);
    assert.equal(discord.uploads.length, 1, 'no duplicate Discord upload');

    // Same bytes, no key -> still deduped by sha256.
    const bySha = await fetch(`${base}/api/processor/submissions`, {
      method: 'POST',
      body: videoForm(Buffer.from('same-bytes')),
    });
    const c = await bySha.json();
    assert.equal(c.deduplicated, true);
    assert.equal(c.job.id, a.job.id);

    // Same key, different bytes -> conflict.
    const conflict = await fetch(`${base}/api/processor/submissions`, {
      method: 'POST',
      body: videoForm(Buffer.from('OTHER-bytes'), { idempotencyKey: 'key-1' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'idempotency_key_conflict');
  } finally {
    server.close();
  }
});

test('submissions validate file type, size cap, idempotency key, and source channel config', async () => {
  const { base, server } = await startServer();
  try {
    const notVideo = await fetch(`${base}/api/processor/submissions`, {
      method: 'POST',
      body: videoForm(Buffer.from('x'), { name: 'note.txt' }),
    });
    assert.equal(notVideo.status, 400);
    assert.equal((await notVideo.json()).error, 'submission_not_a_video');

    const tooBig = await fetch(`${base}/api/processor/submissions`, {
      method: 'POST',
      body: videoForm(Buffer.alloc(2 * 1024 * 1024)),
    });
    assert.equal(tooBig.status, 413);
    assert.equal((await tooBig.json()).error, 'submission_too_large');

    const badKey = await fetch(`${base}/api/processor/submissions`, {
      method: 'POST',
      body: videoForm(Buffer.from('x'), { idempotencyKey: 'bad key with spaces!' }),
    });
    assert.equal(badKey.status, 400);
    assert.equal((await badKey.json()).error, 'invalid_idempotency_key');
  } finally {
    server.close();
  }
});

test('GET /api/processor/jobs/:id returns job + output + parsed verification', async () => {
  const { base, server, db } = await startServer();
  try {
    const source = db.upsert({
      namespace_id: 'admin', channel_id: 'c1', message_id: 'm1', attachment_id: 'v1', filename: 'clip.mp4', content_type: 'video/mp4', discord_url: 'https://cdn.example/v1', status: 'discord_indexed',
    });
    const enq = await fetch(`${base}/api/processor/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaItemId: source.id }),
    });
    const { job } = await enq.json();
    db.updateProcessingJobVerification(job.id, {
      subtitlesRequired: true,
      subtitlesVerified: true,
      audioChanged: true,
      verificationJson: JSON.stringify({ pass: true, mode: 'png_overlay' }),
    });

    const res = await fetch(`${base}/api/processor/jobs/${job.id}`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.job.id, job.id);
    assert.equal(data.job.subtitles_verified, 1);
    assert.equal(data.verification.mode, 'png_overlay');

    const missing = await fetch(`${base}/api/processor/jobs/999999`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('POST /api/processor/jobs/:id/verify refuses non-processed jobs', async () => {
  const { base, server, db } = await startServer({
    subtitleGate: { enabled: true, async preflight() { return { ok: true }; }, async reverify() { return { record: { pass: true }, pass: true }; } },
  });
  try {
    const source = db.upsert({
      namespace_id: 'admin', channel_id: 'c1', message_id: 'm1', attachment_id: 'v2', filename: 'clip.mp4', content_type: 'video/mp4', discord_url: 'https://cdn.example/v2', status: 'discord_indexed',
    });
    const enq = await fetch(`${base}/api/processor/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaItemId: source.id }),
    });
    const { job } = await enq.json();

    const res = await fetch(`${base}/api/processor/jobs/${job.id}/verify`, { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'processing_job_not_processed');
  } finally {
    server.close();
  }
});

test('processor health includes the sanitized subtitle gate block', async () => {
  const { base, server } = await startServer({
    subtitleGate: {
      enabled: true,
      async preflight() {
        return { ok: false, python: false, pillow: false, pillowVersion: '', overlayHelper: true, proofHelper: true, font: true, categories: ['subtitle_python_missing'] };
      },
    },
  });
  try {
    const res = await fetch(`${base}/api/processor/health`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.subtitleGate.enabled, true);
    assert.equal(data.subtitleGate.ready, false);
    assert.deepEqual(data.subtitleGate.categories, ['subtitle_python_missing']);
    assert.equal(data.sourceChannelConfigured, true);
    assert.equal(JSON.stringify(data).toLowerCase().includes('token'), false, 'no secret-ish keys');
  } finally {
    server.close();
  }
});
