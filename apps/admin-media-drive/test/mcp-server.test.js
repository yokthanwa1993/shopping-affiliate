import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  McpToolError,
  assertLoopbackBaseUrl,
  buildToolset,
  createMcpServer,
  parseAllowedRoots,
  validateSubmitPath,
} from '../src/mcp-server.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amd-mcp-'));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// --- transport safety ---------------------------------------------------------

test('the MCP server only accepts loopback API base URLs', () => {
  assert.equal(assertLoopbackBaseUrl('http://127.0.0.1:3100'), 'http://127.0.0.1:3100');
  assert.equal(assertLoopbackBaseUrl('http://localhost:3100/'), 'http://localhost:3100');
  assert.throws(() => assertLoopbackBaseUrl('http://192.168.1.5:3100'), (e) => e.category === 'mcp_api_url_must_be_loopback');
  assert.throws(() => assertLoopbackBaseUrl('https://example.com'), (e) => e.category === 'mcp_api_url_must_be_loopback');
  assert.throws(() => assertLoopbackBaseUrl('file:///etc/passwd'), (e) => e.category === 'mcp_api_url_must_be_loopback');
  assert.throws(() => assertLoopbackBaseUrl('not a url'), (e) => e.category === 'mcp_api_url_invalid');
});

// --- submit path validation ----------------------------------------------------

test('validateSubmitPath enforces absolute allowlisted real paths, extensions, and size', () => {
  const root = tempDir();
  const other = tempDir();
  const good = path.join(root, 'clip.mp4');
  fs.writeFileSync(good, 'bytes');

  const ok = validateSubmitPath(good, { allowedRoots: [root], maxBytes: 100 });
  assert.equal(ok.realPath, fs.realpathSync(good));
  assert.equal(ok.extension, '.mp4');
  assert.equal(ok.filename, 'clip.mp4');

  assert.throws(() => validateSubmitPath('relative/clip.mp4', { allowedRoots: [root] }), (e) => e.category === 'submit_path_must_be_absolute');
  assert.throws(() => validateSubmitPath(path.join(root, 'missing.mp4'), { allowedRoots: [root] }), (e) => e.category === 'submit_path_not_found');
  assert.throws(() => validateSubmitPath(root, { allowedRoots: [root] }), (e) => e.category === 'submit_path_not_a_file');

  const outside = path.join(other, 'clip.mp4');
  fs.writeFileSync(outside, 'bytes');
  assert.throws(() => validateSubmitPath(outside, { allowedRoots: [root] }), (e) => e.category === 'submit_path_outside_allowed_roots');

  const wrongExt = path.join(root, 'movie.mkv');
  fs.writeFileSync(wrongExt, 'bytes');
  assert.throws(() => validateSubmitPath(wrongExt, { allowedRoots: [root] }), (e) => e.category === 'submit_extension_not_allowed');

  const big = path.join(root, 'big.mp4');
  fs.writeFileSync(big, Buffer.alloc(200));
  assert.throws(() => validateSubmitPath(big, { allowedRoots: [root], maxBytes: 100 }), (e) => e.category === 'submit_file_too_large');
});

test('validateSubmitPath resolves symlinks before the allowlist check (no escape via links)', () => {
  const root = tempDir();
  const secret = tempDir();
  const target = path.join(secret, 'secret.mp4');
  fs.writeFileSync(target, 'bytes');
  const link = path.join(root, 'link.mp4');
  fs.symlinkSync(target, link);
  assert.throws(
    () => validateSubmitPath(link, { allowedRoots: [root] }),
    (e) => e.category === 'submit_path_outside_allowed_roots',
  );
});

test('parseAllowedRoots falls back to safe defaults', () => {
  const roots = parseAllowedRoots('', '/Users/yok-macmini');
  assert.ok(roots.includes('/Users/yok-macmini/Desktop'));
  assert.ok(roots.includes('/Users/yok-macmini/Downloads'));
  const custom = parseAllowedRoots('/a/b:/c d/e', '/Users/yok-macmini');
  assert.deepEqual(custom, ['/a/b', '/c d/e']);
});

// --- toolset schemas + handlers -------------------------------------------------

test('toolset exposes exactly the five contract tools with strict input schemas', () => {
  const { tools } = buildToolset({ fetchImpl: async () => jsonResponse({}) });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['media_health', 'media_submit_video', 'media_job_status', 'media_result', 'media_verify'],
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} documented`);
    assert.ok(tool.outputShape, `${tool.name} has a typed output schema`);
  }

  const submit = tools.find((t) => t.name === 'media_submit_video');
  const submitSchema = z.object(submit.inputShape).strict();
  assert.equal(submitSchema.safeParse({ path: '/x/y.mp4' }).success, true);
  assert.equal(submitSchema.safeParse({ path: '/x/y.mp4', idempotencyKey: 'ok-key_1' }).success, true);
  assert.equal(submitSchema.safeParse({}).success, false, 'path required');
  assert.equal(submitSchema.safeParse({ path: '/x.mp4', idempotencyKey: 'bad key!' }).success, false);
  assert.equal(submitSchema.safeParse({ path: '/x.mp4', channelId: 'c9' }).success, false, 'no arbitrary channel input');

  const status = tools.find((t) => t.name === 'media_job_status');
  const statusSchema = z.object(status.inputShape).strict();
  assert.equal(statusSchema.safeParse({ jobId: 3 }).success, true);
  assert.equal(statusSchema.safeParse({ jobId: -1 }).success, false);
  assert.equal(statusSchema.safeParse({ jobId: 'three' }).success, false);
});

test('media_job_status returns a sanitized job (categories only, no raw error text)', async () => {
  const { tools } = buildToolset({
    fetchImpl: async (url) => {
      assert.match(String(url), /http:\/\/127\.0\.0\.1:3100\/api\/processor\/jobs\/7$/);
      return jsonResponse({
        job: {
          id: 7,
          status: 'failed',
          step: 'verifying_subtitles',
          attempts: 1,
          error: 'Download failed: HTTP 500 https://cdn.discordapp.com/secret?token=abc',
          error_category: 'subtitle_pixels_not_detected',
          subtitles_required: 1,
          subtitles_verified: 0,
          audio_changed: null,
          source_media_item_id: 3,
          source_attachment_id: 'att3',
          created_at: 't1',
          started_at: 't2',
          finished_at: 't3',
        },
      });
    },
  });
  const status = tools.find((t) => t.name === 'media_job_status');
  const result = await status.handler({ jobId: 7 });
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'verifying_subtitles');
  assert.equal(result.errorCategory, 'subtitle_pixels_not_detected');
  assert.equal(result.subtitlesRequired, true);
  assert.equal(result.subtitlesVerified, false);
  assert.equal(JSON.stringify(result).includes('token=abc'), false, 'raw error/URLs never leak');
  const outSchema = z.object(status.outputShape).strict();
  assert.equal(outSchema.safeParse(result).success, true, 'matches declared output schema');
});

test('media_submit_video validates locally then posts multipart to the loopback API', async () => {
  const root = tempDir();
  const file = path.join(root, 'clip.mp4');
  fs.writeFileSync(file, Buffer.from('video-bytes'));
  const calls = [];
  const { tools } = buildToolset({
    allowedRoots: [root],
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      if (String(url).endsWith('/api/health')) {
        return jsonResponse({ ok: true, maxUploadBytes: 1024 });
      }
      assert.ok(init.body instanceof FormData);
      const uploaded = init.body.get('file');
      assert.equal(uploaded.name, 'clip.mp4');
      assert.equal(init.body.get('idempotencyKey'), 'key-9');
      return jsonResponse({
        deduplicated: false,
        submission: { id: 1, source_sha256: 'deadbeef' },
        mediaItem: { id: 11, attachment_id: 'att11', channel_id: 'source-channel', message_id: 'm11' },
        job: { id: 21, status: 'queued' },
      }, 201);
    },
  });
  const submit = tools.find((t) => t.name === 'media_submit_video');
  const result = await submit.handler({ path: file, idempotencyKey: 'key-9' });
  assert.deepEqual(result, {
    deduplicated: false,
    submissionId: 1,
    sourceSha256: 'deadbeef',
    mediaItemId: 11,
    attachmentId: 'att11',
    channelId: 'source-channel',
    messageId: 'm11',
    jobId: 21,
    jobStatus: 'queued',
  });
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:3100/api/processor/submissions');

  await assert.rejects(
    submit.handler({ path: path.join(root, 'nope.mp4') }),
    (e) => e instanceof McpToolError && e.category === 'submit_path_not_found',
  );
});

test('media_result requires a processed job and reports proof + fresh-url status', async () => {
  const { tools } = buildToolset({
    fetchImpl: async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/processor/jobs/5')) {
        return jsonResponse({
          job: {
            id: 5, status: 'processed', audio_changed: 1, subtitles_required: 1, subtitles_verified: 1,
          },
          output: {
            id: 9, attachment_id: 'att9', channel_id: 'processed-channel', message_id: 'm9', filename: 'out.mp4', size: 123, jump_url: 'https://discord.com/channels/g/c/m9',
          },
          verification: {
            pass: true,
            mode: 'png_overlay',
            srt: { cueCount: 8 },
            frames: { sampledCues: [{}, {}, {}] },
            proofSheet: { path: '/v/proof-sheet.png', sha256: 'aa11' },
            artifactPath: '/v/verification.json',
          },
        });
      }
      if (init.method === 'HEAD') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example/fresh' } });
      }
      throw new Error(`unexpected ${u}`);
    },
  });
  const result = await tools.find((t) => t.name === 'media_result').handler({ jobId: 5 });
  assert.equal(result.freshUrlOk, true);
  assert.equal(result.output.attachmentId, 'att9');
  assert.equal(result.subtitlesVerified, true);
  assert.equal(result.proof.cueCount, 8);
  assert.equal(result.proof.sampledCues, 3);
  assert.equal(result.proof.proofSheetSha256, 'aa11');

  const notDone = buildToolset({
    fetchImpl: async () => jsonResponse({ job: { id: 6, status: 'processing' } }),
  });
  await assert.rejects(
    notDone.tools.find((t) => t.name === 'media_result').handler({ jobId: 6 }),
    (e) => e.category === 'processing_job_not_processed',
  );
});

test('media_verify maps the reverify record into a sanitized summary', async () => {
  const { tools } = buildToolset({
    fetchImpl: async (url, init = {}) => {
      assert.match(String(url), /\/api\/processor\/jobs\/5\/verify$/);
      assert.equal(init.method, 'POST');
      return jsonResponse({
        job: { id: 5 },
        reverify: {
          pass: true,
          mode: 'full',
          decode: { ok: true },
          durationOk: true,
          frames: [{ textDetected: true }, { textDetected: true }],
          finishedAt: '2026-07-12T00:00:00Z',
        },
      });
    },
  });
  const result = await tools.find((t) => t.name === 'media_verify').handler({ jobId: 5 });
  assert.deepEqual(result, {
    jobId: 5,
    pass: true,
    mode: 'full',
    decodeOk: true,
    durationOk: true,
    framesChecked: 2,
    framesDetected: 2,
    verifiedAt: '2026-07-12T00:00:00Z',
  });
});

test('createMcpServer registers all tools against the SDK without connecting', () => {
  const { server, toolset } = createMcpServer({ fetchImpl: async () => jsonResponse({}) });
  assert.ok(server, 'server constructed');
  assert.equal(toolset.tools.length, 5);
  assert.deepEqual(toolset.allowedExtensions, DEFAULT_ALLOWED_EXTENSIONS);
});
