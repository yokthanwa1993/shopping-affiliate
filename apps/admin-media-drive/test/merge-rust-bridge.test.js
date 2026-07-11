import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  LocalR2CallbackStore,
  MergeRustPipelineProcessor,
  MergeRustProcessManager,
  normalizeR2Key,
  parseCallbackKey,
  superviseMergeRust,
} from '../src/merge-rust-bridge.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amd-merge-'));
}

test('normalizeR2Key and parseCallbackKey reject traversal and keep nested keys', () => {
  assert.equal(normalizeR2Key('/videos/abc.mp4'), 'videos/abc.mp4');
  assert.equal(normalizeR2Key('debug%2Fabc%2Ftiming.json'), 'debug/abc/timing.json');
  assert.equal(parseCallbackKey('/api/r2-upload/debug/abc/timing.json', '/api/r2-upload'), 'debug/abc/timing.json');
  assert.equal(parseCallbackKey('/api/nope/debug/abc/timing.json', '/api/r2-upload'), null);
  assert.throws(() => normalizeR2Key('../secret'), /invalid_r2_key/);
  assert.throws(() => normalizeR2Key('debug/../secret'), /invalid_r2_key/);
});

test('local callback store writes, reads, and deletes Worker-compatible R2 objects', async () => {
  const rootDir = tempDir();
  const token = 'test-token';
  const store = new LocalR2CallbackStore({
    rootDir,
    token,
    botId: 'admin',
    videoId: 'vid1',
  });

  const put = await store.put('videos/vid1.mp4', Buffer.from('mp4'), {
    botId: 'admin',
    contentType: 'video/mp4',
  });
  assert.equal(put.key, 'videos/vid1.mp4');
  assert.equal(store.finalVideoPath.endsWith(path.join('videos', 'vid1.mp4')), true);

  const get = await store.get('videos/vid1.mp4', { botId: 'admin' });
  assert.equal(get.body.toString('utf8'), 'mp4');
  assert.equal(get.contentType, 'video/mp4');

  const del = await store.delete('videos/vid1.mp4', { botId: 'admin' });
  assert.equal(del.key, 'videos/vid1.mp4');
  assert.equal(fs.existsSync(store.finalVideoPath), false);
});

test('process manager treats empty and loopback MERGE_RUST_URL as locally owned, remote as external', () => {
  const empty = new MergeRustProcessManager({ mergeRustPort: 18080 });
  assert.deepEqual(empty.localTarget(), { local: true, port: 18080 });

  const loopback = new MergeRustProcessManager({
    mergeRustUrl: 'http://127.0.0.1:18081/',
    mergeRustPort: 18080,
  });
  assert.deepEqual(loopback.localTarget(), { local: true, port: 18081 });
  assert.equal(loopback.serviceUrl(), 'http://127.0.0.1:18081');

  const localhost = new MergeRustProcessManager({ mergeRustUrl: 'http://localhost:9999' });
  assert.equal(localhost.localTarget().local, true);
  assert.equal(localhost.localTarget().port, 9999);

  const remote = new MergeRustProcessManager({ mergeRustUrl: 'https://merge.example.com' });
  assert.deepEqual(remote.localTarget(), { local: false });

  const garbage = new MergeRustProcessManager({ mergeRustUrl: 'not a url', mergeRustPort: 18080 });
  assert.deepEqual(garbage.localTarget(), { local: false });
});

test('ensureStarted spawns on the loopback URL port when unhealthy and never for a remote URL', async () => {
  const failingFetch = async () => {
    throw new Error('fetch failed');
  };

  const loopback = new MergeRustProcessManager({
    mergeRustUrl: 'http://127.0.0.1:18099',
    mergeRustPort: 18080,
    mergeRustStartTimeoutMs: 50,
    fetchImpl: failingFetch,
  });
  const spawnedPorts = [];
  loopback.spawnLocal = (port) => {
    spawnedPorts.push(port);
    loopback.child = { once() {}, kill() {} };
  };
  await assert.rejects(() => loopback.ensureStarted(), /merge_rust_service_not_ready|fetch failed/);
  assert.deepEqual(spawnedPorts, [18099], 'spawn uses the port from the loopback URL');

  const remote = new MergeRustProcessManager({
    mergeRustUrl: 'https://merge.example.com',
    fetchImpl: failingFetch,
  });
  remote.spawnLocal = () => {
    throw new Error('must_not_spawn_for_remote_url');
  };
  assert.equal(await remote.ensureStarted(), 'https://merge.example.com');
});

test('ensureStarted adopts an already-healthy local service without spawning', async () => {
  const manager = new MergeRustProcessManager({
    mergeRustUrl: 'http://127.0.0.1:18100',
    fetchImpl: async () => new Response('{"pipeline":"merge_rust"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  manager.spawnLocal = () => {
    throw new Error('must_not_spawn_when_healthy');
  };
  assert.equal(await manager.ensureStarted(), 'http://127.0.0.1:18100');
  assert.equal(manager.child, null);
});

test('ensureStarted surfaces a fast, clear error when the merge-rust binary cannot exec', async () => {
  const manager = new MergeRustProcessManager({
    mergeRustBin: path.join(tempDir(), 'missing-merge-rust-binary'),
    mergeRustRoot: tempDir(),
    mergeRustPort: 18101,
    mergeRustStartTimeoutMs: 10_000,
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
  });
  const startedAt = Date.now();
  await assert.rejects(() => manager.ensureStarted(), /merge_rust_spawn_failed/);
  assert.ok(Date.now() - startedAt < 8_000, 'fails well before the start timeout');
});

test('superviseMergeRust: external URL means nothing to supervise', async () => {
  const manager = new MergeRustProcessManager({ mergeRustUrl: 'https://merge.example.com' });
  manager.ensureStarted = async () => {
    throw new Error('must_not_start_external');
  };
  const result = await superviseMergeRust(manager, { log: () => {} });
  assert.equal(result.supervised, false);
  assert.equal(result.reason, 'external_url');
});

test('superviseMergeRust throws when the owned child exits so launchd restarts the agent', async () => {
  const listeners = {};
  const child = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    once(event, fn) {
      listeners[event] = fn;
    },
  };
  const manager = {
    localTarget: () => ({ local: true, port: 18080 }),
    serviceUrl: () => 'http://127.0.0.1:18080',
    ensureStarted: async () => 'http://127.0.0.1:18080',
    health: async () => ({ ok: true }),
    child,
  };
  const supervision = assert.rejects(
    superviseMergeRust(manager, { log: () => {}, pollMs: 1 }),
    /merge_rust_exited_code_101/,
  );
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  listeners.exit(101);
  await supervision;
});

test('superviseMergeRust watches an adopted local service and takes over when it dies', async () => {
  let ensureCalls = 0;
  const manager = {
    child: null,
    localTarget: () => ({ local: true, port: 18080 }),
    serviceUrl: () => 'http://127.0.0.1:18080',
    ensureStarted: async () => {
      ensureCalls += 1;
      if (ensureCalls >= 2) {
        // Second start spawns our own child, which promptly exits: the loop
        // must notice and throw (already-exited child must not hang).
        manager.child = { pid: 77, exitCode: 7, signalCode: null, once() {} };
      }
      return 'http://127.0.0.1:18080';
    },
    health: async () => ({ ok: false, error: 'fetch failed' }),
  };
  await assert.rejects(
    superviseMergeRust(manager, { log: () => {}, pollMs: 1 }),
    /merge_rust_exited_code_7/,
  );
  assert.equal(ensureCalls, 2, 'restarted the service after the adopted process died');
});

test('MergeRustPipelineProcessor dispatches Worker-compatible payload and returns final mp4', async () => {
  const rootDir = tempDir();
  const outputPath = path.join(rootDir, 'out.mp4');
  let seenPayload = null;
  let callbackStore = null;

  const processor = new MergeRustPipelineProcessor({
    namespaceId: 'admin',
    processorConfig: {
      mergeRustJobTimeoutMs: 10_000,
      geminiModel: 'gemini-3-flash-preview',
      vertexTtsModel: 'gemini-3.1-flash-tts-preview',
      voiceName: 'Puck',
    },
    processManager: {
      ensureStarted: async () => 'http://merge.local',
      health: async () => ({ ok: true }),
      close: async () => {},
    },
    callbackServerFactory: async ({
      tempDir,
      token,
      botId,
      videoId,
    }) => {
      callbackStore = new LocalR2CallbackStore({
        rootDir: tempDir,
        token,
        botId,
        videoId,
      });
      return {
        url: 'http://callback.local',
        store: callbackStore,
        close: async () => {},
      };
    },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://merge.local/pipeline');
      assert.equal(init.method, 'POST');
      const payload = JSON.parse(init.body);
      seenPayload = payload;
      await callbackStore.put(`_processing/${payload.video_id}.json`, Buffer.from(JSON.stringify({
        id: payload.video_id,
        status: 'processing',
        step: 5,
      })), { botId: payload.bot_id, contentType: 'application/json' });
      await callbackStore.put(`videos/${payload.video_id}.mp4`, Buffer.from('processed-by-merge-rust'), {
        botId: payload.bot_id,
        contentType: 'video/mp4',
      });
      await callbackStore.put(`videos/${payload.video_id}.json`, Buffer.from(JSON.stringify({
        id: payload.video_id,
        publicUrl: `${payload.r2_public_url}/${payload.bot_id}/videos/${payload.video_id}.mp4`,
        pipelineEngineVersion: 'test',
      })), { botId: payload.bot_id, contentType: 'application/json' });
      callbackStore.markRefresh(payload.video_id);
      return new Response(JSON.stringify({ status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  try {
    const result = await processor.processVideo({
      outputPath,
      tempDir: path.join(rootDir, 'job'),
      sourceUrl: 'https://cdn.example/fresh/source-video',
      job: { id: 42 },
      source: { attachment_id: 'att1' },
    });

    assert.equal(result.pipeline, 'merge_rust');
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'processed-by-merge-rust');
    assert.equal(seenPayload.video_url, 'https://cdn.example/fresh/source-video');
    assert.equal(seenPayload.chat_id, 0);
    assert.equal(seenPayload.model, 'gemini-3-flash-preview');
    assert.equal(seenPayload.vertex_tts_model, 'gemini-3.1-flash-tts-preview');
    assert.equal(seenPayload.voice_name, 'Puck');
    assert.equal('skip_subtitles' in seenPayload, false);
    assert.equal(seenPayload.worker_url, 'http://callback.local');
  } finally {
    await processor.close();
  }
});
