import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SCALE_FILTER,
  buildFfmpegArgs,
  selectVideoEncoder,
} from '../src/processor.js';
import { LocalR2CallbackStore, MergeRustPipelineProcessor } from '../src/merge-rust-bridge.js';
import { VertexCredentialsError } from '../src/vertex-credentials.js';

const ENCODERS = `
 V....D h264_videotoolbox VideoToolbox H.264 Encoder
 V....D libx264 libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
`;

function fakeExec(encodersText) {
  return (_bin, args, _options, callback) => {
    if (args.includes('-encoders')) {
      callback(null, encodersText, '');
      return;
    }
    callback(null, 'ffmpeg version fake', '');
  };
}

test('selectVideoEncoder prefers h264_videotoolbox on macOS when available', async () => {
  const selected = await selectVideoEncoder({
    platform: 'darwin',
    preference: 'auto',
    execFileImpl: fakeExec(ENCODERS),
  });
  assert.equal(selected.selected, 'h264_videotoolbox');
  assert.equal(selected.availability.h264Videotoolbox, true);
});

test('selectVideoEncoder uses libx264 when forced or hardware is unavailable', async () => {
  assert.equal((await selectVideoEncoder({
    platform: 'darwin',
    preference: 'libx264',
    execFileImpl: fakeExec(ENCODERS),
  })).selected, 'libx264');

  const unavailable = await selectVideoEncoder({
    platform: 'darwin',
    preference: 'h264_videotoolbox',
    execFileImpl: fakeExec(' V....D libx264 libx264 H.264'),
  });
  assert.equal(unavailable.selected, 'libx264');
  assert.equal(unavailable.reason, 'videotoolbox_unavailable');
});

test('legacy ffmpeg fallback normalizes to MP4 H.264/AAC faststart without crop', () => {
  const args = buildFfmpegArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp4',
    encoder: 'libx264',
  });

  assert.deepEqual(args.slice(0, 4), ['-hide_banner', '-y', '-i', '/tmp/in.mov']);
  assert.ok(args.includes('-map'));
  assert.ok(args.includes('0:a:0?'), 'optional audio map keeps silent videos valid');
  assert.ok(args.includes('-sn'), 'legacy ffmpeg fallback drops existing subtitle streams');
  assert.ok(args.includes('-dn'), 'legacy ffmpeg fallback drops data streams');
  assert.equal(args[args.indexOf('-vf') + 1], SCALE_FILTER);
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
  assert.equal(args.at(-3), '-f');
  assert.equal(args.at(-2), 'mp4');
  assert.equal(args.at(-1), '/tmp/out.mp4');
});

test('legacy ffmpeg fallback uses VideoToolbox-safe bitrate flags for hardware encode', () => {
  const args = buildFfmpegArgs({
    inputPath: '/tmp/in.mov',
    outputPath: '/tmp/out.mp4',
    encoder: 'h264_videotoolbox',
  });
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_videotoolbox');
  assert.ok(args.includes('-allow_sw'));
  assert.ok(!args.includes('-crf'), 'VideoToolbox does not use libx264 CRF');
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amd-processor-'));
}

// Obviously fake material: the structural shape of a service-account key with
// dummy values only. Never put real credentials in tests.
const DUMMY_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nZHVtbXktbm90LWEta2V5\n-----END PRIVATE KEY-----\n';

function dummyServiceAccount(overrides = {}) {
  return {
    type: 'service_account',
    project_id: 'dummy-project',
    private_key_id: 'dummy-key-id',
    private_key: DUMMY_PRIVATE_KEY,
    client_email: 'dummy-sa@dummy-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  };
}

function writeCredentials(value) {
  const filePath = path.join(tempDir(), 'sa.json');
  fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
  return filePath;
}

// Processor-level harness around MergeRustPipelineProcessor.processVideo: the
// fake process manager pins the dispatch URL, and the fake fetch records every
// /pipeline payload then completes the callback store so the job resolves.
function vertexProcessor({ mergeRustUrl, processorConfig = {} }) {
  const dispatches = [];
  let callbackStore = null;
  const processor = new MergeRustPipelineProcessor({
    namespaceId: 'admin',
    processorConfig: { mergeRustJobTimeoutMs: 10_000, ...processorConfig },
    processManager: {
      ensureStarted: async () => mergeRustUrl,
      health: async () => ({ ok: true }),
      close: async () => {},
    },
    callbackServerFactory: async ({
      tempDir: jobDir,
      token,
      botId,
      videoId,
    }) => {
      callbackStore = new LocalR2CallbackStore({
        rootDir: jobDir,
        token,
        botId,
        videoId,
      });
      return { url: 'http://callback.local', store: callbackStore, close: async () => {} };
    },
    fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body);
      dispatches.push({ url, payload });
      await callbackStore.put(`videos/${payload.video_id}.mp4`, Buffer.from('processed'), {
        botId: payload.bot_id,
        contentType: 'video/mp4',
      });
      await callbackStore.put(`videos/${payload.video_id}.json`, Buffer.from('{"id":"done"}'), {
        botId: payload.bot_id,
        contentType: 'application/json',
      });
      return new Response(JSON.stringify({ status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { processor, dispatches };
}

async function runVertexJob(processor, jobId = 7) {
  const rootDir = tempDir();
  return processor.processVideo({
    outputPath: path.join(rootDir, 'out.mp4'),
    tempDir: path.join(rootDir, 'job'),
    sourceUrl: 'https://cdn.example/source-video',
    job: { id: jobId },
    source: { attachment_id: `att${jobId}` },
  });
}

test('merge-rust processor injects the credential file into a loopback /pipeline dispatch', async () => {
  const { processor, dispatches } = vertexProcessor({
    mergeRustUrl: 'http://127.0.0.1:18080',
    processorConfig: { vertexTtsCredentialsPath: writeCredentials(dummyServiceAccount()) },
  });
  try {
    await runVertexJob(processor);
  } finally {
    await processor.close();
  }
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].url, 'http://127.0.0.1:18080/pipeline');
  const injected = JSON.parse(dispatches[0].payload.vertex_tts_service_account_json);
  assert.equal(injected.type, 'service_account');
  assert.equal(injected.client_email, 'dummy-sa@dummy-project.iam.gserviceaccount.com');
  // No explicit override: the project id falls back to the credential's own.
  assert.equal(dispatches[0].payload.vertex_tts_project_id, 'dummy-project');
});

test('credential file is re-read lazily on every dispatch, not cached at startup', async () => {
  const credentialsPath = writeCredentials(dummyServiceAccount());
  const { processor, dispatches } = vertexProcessor({
    mergeRustUrl: 'http://127.0.0.1:18080',
    processorConfig: { vertexTtsCredentialsPath: credentialsPath },
  });
  try {
    await runVertexJob(processor, 1);
    fs.writeFileSync(credentialsPath, JSON.stringify(dummyServiceAccount({
      client_email: 'rotated-sa@dummy-project.iam.gserviceaccount.com',
    })));
    await runVertexJob(processor, 2);
  } finally {
    await processor.close();
  }
  const emails = dispatches.map((d) => JSON.parse(d.payload.vertex_tts_service_account_json).client_email);
  assert.deepEqual(emails, [
    'dummy-sa@dummy-project.iam.gserviceaccount.com',
    'rotated-sa@dummy-project.iam.gserviceaccount.com',
  ], 'second dispatch picks up the rotated key file');
});

test('explicit VERTEX_TTS_PROJECT_ID overrides the credential file project id', async () => {
  const { processor, dispatches } = vertexProcessor({
    mergeRustUrl: 'http://127.0.0.1:18080',
    processorConfig: {
      vertexTtsCredentialsPath: writeCredentials(dummyServiceAccount()),
      vertexTtsProjectId: 'override-project',
    },
  });
  try {
    await runVertexJob(processor);
  } finally {
    await processor.close();
  }
  assert.equal(dispatches[0].payload.vertex_tts_project_id, 'override-project');
  assert.ok(dispatches[0].payload.vertex_tts_service_account_json, 'override does not disable injection');
});

test('remote merge-rust URL never reads or injects the credential file', async () => {
  // Deliberately invalid JSON at the configured path: any read would fail
  // closed, so a successful remote dispatch proves the file was never read.
  const { processor, dispatches } = vertexProcessor({
    mergeRustUrl: 'https://merge.example.com',
    processorConfig: { vertexTtsCredentialsPath: writeCredentials('{never-read-me') },
  });
  try {
    await runVertexJob(processor);
  } finally {
    await processor.close();
  }
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].url, 'https://merge.example.com/pipeline');
  assert.equal('vertex_tts_service_account_json' in dispatches[0].payload, false);
  // Remote services authenticate from their own environment; the worker must
  // not enforce a local project id either.
  assert.equal('vertex_tts_project_id' in dispatches[0].payload, false);
});

test('env-json setup (VERTEX_TTS_SERVICE_ACCOUNT_JSON present) skips the file requirement on loopback', async () => {
  const { processor, dispatches } = vertexProcessor({
    mergeRustUrl: 'http://127.0.0.1:18080',
    processorConfig: { vertexTtsCredentialsPath: '', vertexTtsServiceAccountEnvSet: true },
  });
  try {
    await runVertexJob(processor);
  } finally {
    await processor.close();
  }
  assert.equal(dispatches.length, 1);
  // merge-rust reads the credential from its own environment; the worker sends
  // neither the credential nor a locally enforced project id.
  assert.equal('vertex_tts_service_account_json' in dispatches[0].payload, false);
  assert.equal('vertex_tts_project_id' in dispatches[0].payload, false);
});

test('credential failures are sanitized categories and prevent the /pipeline dispatch', async () => {
  const noProject = dummyServiceAccount();
  delete noProject.project_id;
  const cases = [
    ['vertex_credentials_not_configured', { vertexTtsCredentialsPath: '' }],
    ['vertex_credentials_missing', { vertexTtsCredentialsPath: path.join(tempDir(), 'nope.json') }],
    ['vertex_credentials_invalid_json', { vertexTtsCredentialsPath: writeCredentials('{not json') }],
    ['vertex_credentials_invalid_shape', { vertexTtsCredentialsPath: writeCredentials(dummyServiceAccount({ type: 'authorized_user' })) }],
    ['vertex_credentials_missing_project_id', { vertexTtsCredentialsPath: writeCredentials(noProject) }],
  ];
  for (const [category, processorConfig] of cases) {
    const { processor, dispatches } = vertexProcessor({
      mergeRustUrl: 'http://127.0.0.1:18080',
      processorConfig,
    });
    try {
      const error = await runVertexJob(processor).then(
        () => assert.fail(`expected rejection ${category}`),
        (e) => e,
      );
      assert.equal(error instanceof VertexCredentialsError, true, category);
      assert.equal(error.category, category);
      // Sanitized: the message is exactly the category — no path, no
      // credential contents — which markProcessingJobFailed adopts as the
      // job row's error_category.
      assert.equal(error.message, category);
      assert.equal(dispatches.length, 0, `${category} must fail closed before any dispatch`);
    } finally {
      await processor.close();
    }
  }
});
