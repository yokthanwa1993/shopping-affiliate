import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  async uploadFile({ filename }) {
    return {
      id: 'up1',
      messageId: 'm9',
      channelId: 'c1',
      guildId: 'g1',
      filename,
      size: 3,
      contentType: 'image/png',
      url: 'https://cdn.example/original-up1',
      proxyUrl: '/api/media/c1/m9/up1',
      jumpUrl: 'https://discord.com/channels/g1/c1/m9',
      createdAt: '2026-07-02T00:00:00.000Z',
    };
  }
}

function tempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amd-srv-'));
  return path.join(dir, name);
}

function buildServer() {
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
  };
  const db = openDb(tempPath('injected.sqlite'));
  const { app } = createApp({ cfg, discord: new FakeDiscord(), db });
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => {
    server.on('listening', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, server, mediaRoot });
    });
  });
}

test('discord mode: sync-channel indexes metadata without downloading', async () => {
  const { base, server, mediaRoot } = await buildServer();
  try {
    const res = await fetch(`${base}/api/sync-channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'c1', limit: 10 }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.mode, 'discord');
    assert.equal(data.total, 1);
    assert.equal(data.indexed, 1);
    assert.equal(data.downloaded, 0, 'nothing downloaded in discord mode');

    // Row is indexed with a null local_path + discord_indexed status.
    const list = await (await fetch(`${base}/api/media-items`)).json();
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
  const { base, server } = await buildServer();
  try {
    await fetch(`${base}/api/sync-channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'c1' }),
    });
    const list = await (await fetch(`${base}/api/media-items`)).json();
    const id = list.items[0].id;

    const res = await fetch(`${base}/api/local-media/${id}/file`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') || '', /fresh\/att1/);
  } finally {
    server.close();
  }
});

test('discord mode: upload indexes metadata only, no permanent local file', async () => {
  const { base, server, mediaRoot } = await buildServer();
  try {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('abc')], { type: 'image/png' }), 'shot.png');
    form.append('channelId', 'c1');

    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.storageMode, 'discord');
    assert.equal(data.status, 'discord_indexed');
    assert.equal(data.localPath, null, 'no local file path recorded');

    const wrote = fs.existsSync(mediaRoot) && fs.readdirSync(mediaRoot).length > 0;
    assert.equal(wrote, false, 'upload did not persist bytes under MEDIA_ROOT');
  } finally {
    server.close();
  }
});
