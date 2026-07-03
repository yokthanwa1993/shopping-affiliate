import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';

// Minimal fake of DiscordService: always configured + ready, never touches the
// network. Records nothing to disk.
class FakeDiscord {
  constructor() {
    this.configured = true;
    this.ready = true;
    this.error = '';
    this.user = null;
    this.uploads = [];
  }

  async fetchMediaItems() {
    return [{
      id: 'att1',
      messageId: 'm1',
      channelId: 'c1',
      guildId: 'g1',
      filename: 'a.png',
      size: 3,
      contentType: 'image/png',
      url: 'https://cdn.example/original-att1',
      proxyUrl: '/api/media/c1/m1/att1',
      jumpUrl: 'https://discord.com/channels/g1/c1/m1',
      createdAt: '2026-07-02T00:00:00.000Z',
    }];
  }

  async resolveFreshUrl(_channelId, _messageId, attachmentId) {
    return `https://cdn.example/fresh/${attachmentId}`;
  }

  async uploadFile({ channelId = 'c1', filename, mimetype, filePath }) {
    this.uploads.push({ channelId, filename, mimetype, filePath });
    return {
      id: `up${this.uploads.length}`,
      messageId: `m9${this.uploads.length}`,
      channelId,
      guildId: 'g1',
      filename,
      size: 3,
      contentType: mimetype || 'image/png',
      url: `https://cdn.example/original-up${this.uploads.length}`,
      proxyUrl: `/api/media/${channelId}/m9/up${this.uploads.length}`,
      jumpUrl: `https://discord.com/channels/g1/${channelId}/m9${this.uploads.length}`,
      createdAt: '2026-07-02T00:00:00.000Z',
    };
  }
}

class FakeProcessor {
  async health() {
    return {
      ffmpeg: { bin: 'ffmpeg', present: true, version: 'ffmpeg fake' },
      ffprobe: { bin: 'ffprobe', present: true, version: 'ffprobe fake' },
      encoder: {
        preference: 'auto',
        selected: 'libx264',
        reason: 'fake',
        h264VideotoolboxAvailable: false,
        libx264Available: true,
      },
    };
  }

  async processVideo({ outputPath }) {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, Buffer.from('processed mp4'));
    return { outputPath, encoder: 'libx264' };
  }
}

function tempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-srv-'));
  return path.join(dir, name);
}

async function encodeBody(method, body, headers) {
  if (body === undefined || body === null) {
    return { bodyBuffer: Buffer.alloc(0), headers };
  }
  if (body instanceof FormData) {
    const req = new Request('http://127.0.0.1/', { method, body });
    const bodyBuffer = Buffer.from(await req.arrayBuffer());
    return {
      bodyBuffer,
      headers: {
        ...headers,
        ...Object.fromEntries(req.headers),
        'content-length': String(bodyBuffer.length),
      },
    };
  }
  if (Buffer.isBuffer(body)) {
    return { bodyBuffer: body, headers: { ...headers, 'content-length': String(body.length) } };
  }
  if (typeof body === 'string') {
    const bodyBuffer = Buffer.from(body);
    return { bodyBuffer, headers: { ...headers, 'content-length': String(bodyBuffer.length) } };
  }
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  return {
    bodyBuffer,
    headers: {
      'content-type': 'application/json',
      ...headers,
      'content-length': String(bodyBuffer.length),
    },
  };
}

async function requestApp(app, url, {
  method = 'GET',
  headers = {},
  body,
  redirect = 'follow',
} = {}) {
  const encoded = await encodeBody(method, body, headers);
  let pushed = false;
  const req = new Readable({
    read() {
      if (pushed) return;
      pushed = true;
      this.push(encoded.bodyBuffer);
      this.push(null);
    },
  });
  req.method = method;
  req.url = url;
  req.originalUrl = url;
  req.headers = Object.fromEntries(
    Object.entries(encoded.headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  req.headers['content-length'] ??= String(encoded.bodyBuffer.length);
  req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, value]);
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.aborted = false;
  req.complete = true;
  req._destroy = (_error, callback) => {
    callback();
  };
  req.socket = new PassThrough();
  req.socket.remoteAddress = '127.0.0.1';
  req.socket.encrypted = false;
  req.client = req.socket;
  req.connection = req.socket;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const headerMap = new Map();
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.statusCode = 200;
    res.headersSent = false;
    res.locals = {};
    res.setHeader = (key, value) => {
      headerMap.set(String(key).toLowerCase(), value);
    };
    res.getHeader = (key) => headerMap.get(String(key).toLowerCase());
    res.getHeaders = () => Object.fromEntries(headerMap);
    res.removeHeader = (key) => {
      headerMap.delete(String(key).toLowerCase());
    };
    res.writeHead = (statusCode, maybeHeaders) => {
      res.statusCode = statusCode;
      if (maybeHeaders) {
        for (const [key, value] of Object.entries(maybeHeaders)) {
          res.setHeader(key, value);
        }
      }
      res.headersSent = true;
      return res;
    };
    const originalEnd = res.end.bind(res);
    res.end = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      res.headersSent = true;
      originalEnd(callback);
      const bodyBuffer = Buffer.concat(chunks);
      const response = {
        status: res.statusCode,
        headers: {
          get(key) {
            return headerMap.get(String(key).toLowerCase()) ?? null;
          },
        },
        async json() {
          return JSON.parse(bodyBuffer.toString() || '{}');
        },
        async text() {
          return bodyBuffer.toString();
        },
      };
      if (redirect === 'manual' || res.statusCode < 300 || res.statusCode >= 400) {
        resolve(response);
      } else {
        resolve(response);
      }
    };
    res.on('error', reject);
    req.on('error', reject);
    app.handle(req, res, reject);
  });
}

function buildServer({ cfgOverrides = {}, discord = new FakeDiscord() } = {}) {
  const mediaRoot = tempPath('media');
  const cfg = {
    port: 0,
    host: '127.0.0.1',
    storageMode: 'discord',
    maxUploadBytes: 10 * 1024 * 1024,
    namespaceId: 'admin',
    mediaRoot,
    dbPath: tempPath('index.sqlite'),
    discord: {
      botToken: 'x',
      guildId: 'g1',
      defaultChannelId: 'c1',
      sourceChannelId: '',
      processedChannelId: '',
    },
    processor: {
      ffmpegBin: 'ffmpeg',
      ffprobeBin: 'ffprobe',
      videoEncoder: 'auto',
      keepTmp: false,
      pollMs: 1000,
    },
    ...cfgOverrides,
  };
  const db = openDb(tempPath('injected.sqlite'));
  const { app } = createApp({
    cfg,
    discord,
    db,
    processor: new FakeProcessor(),
    downloadFile: async (_url, fullPath) => {
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, Buffer.from('source mp4'));
      return { path: fullPath, bytes: 10, skipped: false };
    },
  });
  const api = (url, options) => requestApp(app, url, options);
  return {
    api,
    server: { close() {} },
    mediaRoot,
    db,
    discord,
    cfg,
  };
}

test('discord mode: sync-channel indexes metadata without downloading', async () => {
  const { api, server, mediaRoot } = await buildServer();
  try {
    const res = await api('/api/sync-channel', {
      method: 'POST',
      body: { channelId: 'c1', limit: 10 },
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.mode, 'discord');
    assert.equal(data.total, 1);
    assert.equal(data.indexed, 1);
    assert.equal(data.downloaded, 0, 'nothing downloaded in discord mode');

    // Row is indexed with a null local_path + discord_indexed status.
    const list = await (await api('/api/media-items')).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].local_path, null);
    assert.equal(list.items[0].status, 'discord_indexed');

    // No bytes were written under MEDIA_ROOT.
    const wrote = fs.existsSync(mediaRoot) && fs.readdirSync(mediaRoot).length > 0;
    assert.equal(wrote, false, 'MEDIA_ROOT stays empty in discord mode');
  } finally {
    server.close();
  }
});

test('discord mode: file route redirects to a fresh Discord URL', async () => {
  const { api, server } = await buildServer();
  try {
    await api('/api/sync-channel', {
      method: 'POST',
      body: { channelId: 'c1' },
    });
    const list = await (await api('/api/media-items')).json();
    const id = list.items[0].id;

    const res = await api(`/api/local-media/${id}/file`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /fresh\/att1/);
  } finally {
    server.close();
  }
});

test('discord mode: upload indexes metadata only, no permanent local file', async () => {
  const { api, server, mediaRoot } = await buildServer();
  try {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('abc')], { type: 'image/png' }), 'shot.png');
    form.append('channelId', 'c1');

    const res = await api('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    assert.equal(res.status, 201, JSON.stringify(data));
    assert.equal(data.storageMode, 'discord');
    assert.equal(data.status, 'discord_indexed');
    assert.equal(data.localPath, null, 'no local file path recorded');

    const wrote = fs.existsSync(mediaRoot) && fs.readdirSync(mediaRoot).length > 0;
    assert.equal(wrote, false, 'upload did not persist bytes under MEDIA_ROOT');
  } finally {
    server.close();
  }
});

test('processor health reports local ffmpeg state, queue counts, and output-channel config', async () => {
  const { api, server } = await buildServer();
  try {
    const res = await api('/api/processor/health');
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.ffmpeg.present, true);
    assert.equal(data.ffprobe.present, true);
    assert.equal(data.encoder.selected, 'libx264');
    assert.equal(data.counts, undefined, 'processor health stays concise');
    assert.equal(data.queue.queued, 0);
    assert.equal(data.processedChannelConfigured, true);
  } finally {
    server.close();
  }
});

test('processor health reports missing processed/default channel without secrets', async () => {
  const { api, server } = await buildServer({
    cfgOverrides: {
      discord: {
        botToken: 'x',
        guildId: 'g1',
        defaultChannelId: '',
        sourceChannelId: '',
        processedChannelId: '',
      },
    },
  });
  try {
    const res = await api('/api/processor/health');
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.processedChannelConfigured, false);
    assert.equal(JSON.stringify(data).includes('DISCORD_BOT_TOKEN'), false);
  } finally {
    server.close();
  }
});

test('processor jobs can enqueue from a media item id and list recent jobs', async () => {
  const { api, server, db } = await buildServer();
  try {
    const source = db.upsert({
      namespace_id: 'admin',
      channel_id: 'c1',
      message_id: 'm1',
      attachment_id: 'video1',
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      discord_url: 'https://cdn.example/video1',
      status: 'discord_indexed',
    });

    const res = await api('/api/processor/jobs', {
      method: 'POST',
      body: { mediaItemId: source.id },
    });
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.job.status, 'queued');
    assert.equal(data.job.source_attachment_id, 'video1');

    const list = await (await api('/api/processor/jobs')).json();
    assert.equal(list.jobs.length, 1);
    assert.equal(list.counts.queued, 1);
  } finally {
    server.close();
  }
});

test('processor run uploads processed mp4 to processed channel and indexes output metadata', async () => {
  const discord = new FakeDiscord();
  const { api, server, db, mediaRoot } = await buildServer({
    discord,
    cfgOverrides: {
      discord: {
        botToken: 'x',
        guildId: 'g1',
        defaultChannelId: 'c1',
        sourceChannelId: '',
        processedChannelId: 'processed-channel',
      },
    },
  });
  try {
    const source = db.upsert({
      namespace_id: 'admin',
      channel_id: 'c1',
      message_id: 'm1',
      attachment_id: 'video1',
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      discord_url: 'https://cdn.example/video1',
      status: 'discord_indexed',
    });
    const enqueue = await api('/api/processor/jobs', {
      method: 'POST',
      body: { attachmentId: source.attachment_id },
    });
    const { job } = await enqueue.json();

    const run = await api(`/api/processor/jobs/${job.id}/run`, { method: 'POST' });
    const data = await run.json();
    assert.equal(run.status, 200);
    assert.equal(data.job.status, 'processed');
    assert.equal(data.job.output_channel_id, 'processed-channel');
    assert.equal(discord.uploads.length, 1);
    assert.equal(discord.uploads[0].channelId, 'processed-channel');
    assert.equal(discord.uploads[0].mimetype, 'video/mp4');

    const output = db.getById(data.job.output_media_item_id);
    assert.equal(output.content_type, 'video/mp4');
    assert.equal(output.status, 'processed_discord_indexed');
    assert.equal(output.local_path, null);

    const jobTmp = path.join(mediaRoot, 'tmp', 'admin-media-drive-processing', String(job.id));
    assert.equal(fs.existsSync(jobTmp), false, 'temp processing files are cleaned');
  } finally {
    server.close();
  }
});

test('processor health reports binaries, encoder, queue counts, and channel config', async () => {
  const { api, server } = await buildServer({
    cfgOverrides: {
      discord: {
        botToken: 'x',
        guildId: 'g1',
        defaultChannelId: 'c1',
        sourceChannelId: '',
        processedChannelId: 'c2',
      },
    },
  });
  try {
    const res = await api('/api/processor/health');
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.ffmpeg.present, true);
    assert.equal(data.ffprobe.present, true);
    assert.equal(data.encoder.selected, 'libx264');
    assert.equal(data.processedChannelConfigured, true);
    assert.equal(data.queue.queued, 0);
  } finally {
    server.close();
  }
});

test('processor API enqueues and runs a video job through processed Discord upload', async () => {
  const { api, server, mediaRoot, db, discord } = await buildServer({
    cfgOverrides: {
      discord: {
        botToken: 'x',
        guildId: 'g1',
        defaultChannelId: 'c1',
        sourceChannelId: 'c1',
        processedChannelId: 'c2',
      },
    },
  });
  try {
    const source = db.upsert({
      namespace_id: 'admin',
      channel_id: 'c1',
      message_id: 'm1',
      attachment_id: 'video-att1',
      filename: 'clip.mov',
      content_type: 'video/quicktime',
      size: 100,
      discord_url: 'https://cdn.example/stored/video-att1',
      status: 'discord_indexed',
    });

    const enqueueRes = await api('/api/processor/jobs', {
      method: 'POST',
      body: { mediaItemId: source.id },
    });
    const enqueueData = await enqueueRes.json();
    assert.equal(enqueueRes.status, 201);
    assert.equal(enqueueData.job.status, 'queued');
    assert.equal(enqueueData.job.source_attachment_id, 'video-att1');

    const runRes = await api(`/api/processor/jobs/${enqueueData.job.id}/run`, {
      method: 'POST',
    });
    const runData = await runRes.json();
    assert.equal(runRes.status, 200);
    assert.equal(runData.job.status, 'processed');
    assert.equal(runData.job.output_channel_id, 'c2');
    assert.equal(discord.uploads.length, 1);
    assert.equal(discord.uploads[0].channelId, 'c2');
    assert.equal(discord.uploads[0].mimetype, 'video/mp4');

    const output = db.getById(runData.job.output_media_item_id);
    assert.equal(output.status, 'processed_discord_indexed');
    assert.equal(output.content_type, 'video/mp4');
    assert.equal(output.local_path, null);

    assert.equal(fs.existsSync(runData.job.temp_dir), false, 'job temp dir is cleaned');
    const tmpRoot = path.join(mediaRoot, 'tmp');
    assert.equal(fs.existsSync(tmpRoot), true, 'top-level tmp root may remain absent or empty parent only');
  } finally {
    server.close();
  }
});

test('processor run reports missing processed/default channel and marks job failed', async () => {
  const { api, server, db } = await buildServer({
    cfgOverrides: {
      discord: {
        botToken: 'x',
        guildId: 'g1',
        defaultChannelId: '',
        sourceChannelId: 'c1',
        processedChannelId: '',
      },
    },
  });
  try {
    const source = db.upsert({
      namespace_id: 'admin',
      channel_id: 'c1',
      message_id: 'm1',
      attachment_id: 'video-att2',
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      discord_url: 'https://cdn.example/stored/video-att2',
      status: 'discord_indexed',
    });
    const enqueue = await (await api('/api/processor/jobs', {
      method: 'POST',
      body: { mediaItemId: source.id },
    })).json();

    const res = await api(`/api/processor/jobs/${enqueue.job.id}/run`, { method: 'POST' });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error, 'processed_channel_not_configured');
    assert.equal(data.job.status, 'failed');
  } finally {
    server.close();
  }
});
