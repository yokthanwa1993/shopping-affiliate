import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import path from 'node:path';

import { ensureDir, fsp } from './storage.js';
import { VertexCredentialsError, loadVertexServiceAccount } from './vertex-credentials.js';
import {
  DEFAULT_TTS_PROMPT_TEMPLATE,
  DEFAULT_TTS_STYLE_INSTRUCTIONS,
  DEFAULT_VOICE_NAME,
  DEFAULT_VOICE_SCRIPT_PROMPT,
} from './voice-defaults.js';

const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_JOB_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_START_TIMEOUT_MS = 180_000;
const MAX_CALLBACK_BODY_BYTES = 512 * 1024 * 1024;

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** True when `value` is a URL whose host is loopback. */
export function isLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.includes(parsed.hostname.toLowerCase());
}

function jsonResponse(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
  });
  res.end(payload);
}

function textResponse(res, statusCode, body) {
  const payload = Buffer.from(String(body || ''));
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.length),
  });
  res.end(payload);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeR2Key(rawKey) {
  const decoded = safeDecodeURIComponent(String(rawKey || ''));
  const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('invalid_r2_key');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('invalid_r2_key');
  }
  return parts.join('/');
}

export function parseCallbackKey(pathname, prefix) {
  const pathOnly = String(pathname || '').split('?')[0];
  const normalizedPrefix = String(prefix || '').replace(/\/+$/, '');
  if (!pathOnly.startsWith(`${normalizedPrefix}/`)) return null;
  return normalizeR2Key(pathOnly.slice(normalizedPrefix.length + 1));
}

function safePathSegment(value, fallback = 'default') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function contentTypeForKey(key) {
  const ext = path.extname(key).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.srt') return 'application/x-subrip';
  if (ext === '.ass') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function readRequestBody(req, maxBytes = MAX_CALLBACK_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      const error = new Error('callback_body_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(Buffer.from(buffer || '').toString('utf8') || '{}');
  } catch {
    return null;
  }
}

export class LocalR2CallbackStore {
  constructor({
    rootDir,
    token,
    botId = 'admin',
    videoId,
    maxBodyBytes = MAX_CALLBACK_BODY_BYTES,
  }) {
    this.rootDir = path.resolve(rootDir);
    this.token = token;
    this.botId = botId || 'admin';
    this.videoId = videoId;
    this.maxBodyBytes = maxBodyBytes;
    this.contentTypes = new Map();
    this.events = new EventEmitter();
    this.finalVideoPath = '';
    this.metadata = null;
    this.failure = null;
    this.refreshed = false;
  }

  authOk(req) {
    return String(req.headers['x-auth-token'] || '').trim() === this.token;
  }

  scopedRoot(botId = this.botId) {
    return path.join(this.rootDir, 'r2', safePathSegment(botId));
  }

  pathForKey(key, botId = this.botId) {
    const normalizedKey = normalizeR2Key(key);
    const scopedRoot = path.resolve(this.scopedRoot(botId));
    const fullPath = path.resolve(scopedRoot, normalizedKey);
    const rel = path.relative(scopedRoot, fullPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('r2_key_outside_store');
    }
    return { key: normalizedKey, fullPath };
  }

  contentTypeMapKey(botId, key) {
    return `${safePathSegment(botId)}:${key}`;
  }

  async put(rawKey, body, { botId = this.botId, contentType } = {}) {
    const { key, fullPath } = this.pathForKey(rawKey, botId);
    await ensureDir(path.dirname(fullPath));
    await fsp.writeFile(fullPath, body);
    this.contentTypes.set(this.contentTypeMapKey(botId, key), contentType || contentTypeForKey(key));

    if (key === `videos/${this.videoId}.mp4`) {
      this.finalVideoPath = fullPath;
      this.events.emit('change');
    } else if (key === `videos/${this.videoId}.json`) {
      this.metadata = parseJsonBuffer(body) || {};
      this.events.emit('change');
    } else if (key === `_processing/${this.videoId}.json`) {
      const data = parseJsonBuffer(body);
      if (String(data?.status || '').toLowerCase() === 'failed') {
        this.failure = new Error(String(data?.error || 'merge_rust_pipeline_failed').slice(0, 2000));
        this.events.emit('change');
      }
    }

    return { key, fullPath, size: body.length };
  }

  async get(rawKey, { botId = this.botId } = {}) {
    const { key, fullPath } = this.pathForKey(rawKey, botId);
    let body;
    try {
      body = await fsp.readFile(fullPath);
    } catch {
      return null;
    }
    return {
      key,
      fullPath,
      body,
      contentType: this.contentTypes.get(this.contentTypeMapKey(botId, key)) || contentTypeForKey(key),
    };
  }

  async delete(rawKey, { botId = this.botId } = {}) {
    const { key, fullPath } = this.pathForKey(rawKey, botId);
    await fsp.rm(fullPath, { force: true }).catch(() => {});
    this.contentTypes.delete(this.contentTypeMapKey(botId, key));
    return { key };
  }

  markRefresh(videoId) {
    if (String(videoId || '') === String(this.videoId || '')) {
      this.refreshed = true;
      this.events.emit('change');
    }
  }

  isComplete() {
    return Boolean(this.finalVideoPath && this.metadata);
  }

  waitForCompletion({ timeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.isComplete()) {
      return Promise.resolve({
        finalVideoPath: this.finalVideoPath,
        metadata: this.metadata,
        refreshed: this.refreshed,
      });
    }

    return new Promise((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve({
          finalVideoPath: this.finalVideoPath,
          metadata: this.metadata,
          refreshed: this.refreshed,
        });
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const onChange = () => {
        if (this.failure) {
          fail(this.failure);
          return;
        }
        if (this.isComplete()) done();
      };
      const timer = setTimeout(() => {
        fail(new Error('merge_rust_pipeline_timeout'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off('change', onChange);
      };
      this.events.on('change', onChange);
    });
  }
}

export class LocalPipelineCallbackServer {
  constructor({
    host = '127.0.0.1',
    port = 0,
    publicUrl = '',
    store,
  }) {
    this.host = host;
    this.port = port;
    this.publicUrl = trimTrailingSlash(publicUrl);
    this.store = store;
    this.server = null;
    this.url = '';
  }

  async start() {
    if (this.server) return this;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        jsonResponse(res, error?.status || 500, { error: error?.message || 'callback_failed' });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    const address = this.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : this.port;
    this.url = this.publicUrl || `http://${this.host}:${actualPort}`;
    return this;
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  async handle(req, res) {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsed.pathname;

    if (req.method === 'PUT') {
      const key = parseCallbackKey(pathname, '/api/r2-upload');
      if (key) {
        if (!this.store.authOk(req)) return jsonResponse(res, 401, { error: 'unauthorized' });
        const body = await readRequestBody(req, this.store.maxBodyBytes);
        const stored = await this.store.put(key, body, {
          botId: String(req.headers['x-bot-id'] || this.store.botId || 'admin'),
          contentType: String(req.headers['content-type'] || contentTypeForKey(key)),
        });
        return jsonResponse(res, 200, { ok: true, key: stored.key, size: stored.size });
      }
    }

    if (req.method === 'GET') {
      const key = parseCallbackKey(pathname, '/api/r2-proxy');
      if (key) {
        if (!this.store.authOk(req)) return jsonResponse(res, 401, { error: 'unauthorized' });
        const found = await this.store.get(key, {
          botId: String(req.headers['x-bot-id'] || this.store.botId || 'admin'),
        });
        if (!found) return jsonResponse(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'content-type': found.contentType,
          'content-length': String(found.body.length),
        });
        return res.end(found.body);
      }

      const publicKey = parseCallbackKey(pathname, `/r2-public/${safePathSegment(this.store.botId)}`);
      if (publicKey) {
        const found = await this.store.get(publicKey);
        if (!found) return jsonResponse(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'content-type': found.contentType,
          'content-length': String(found.body.length),
        });
        return res.end(found.body);
      }
    }

    if (req.method === 'DELETE') {
      const key = parseCallbackKey(pathname, '/api/r2-proxy');
      if (key) {
        if (!this.store.authOk(req)) return jsonResponse(res, 401, { error: 'unauthorized' });
        const deleted = await this.store.delete(key, {
          botId: String(req.headers['x-bot-id'] || this.store.botId || 'admin'),
        });
        return jsonResponse(res, 200, { ok: true, key: deleted.key });
      }
    }

    if (req.method === 'POST') {
      const refreshId = parseCallbackKey(pathname, '/api/gallery/refresh');
      if (refreshId) {
        if (!this.store.authOk(req)) return jsonResponse(res, 401, { error: 'unauthorized' });
        this.store.markRefresh(refreshId);
        return jsonResponse(res, 200, { ok: true });
      }
      if (pathname === '/api/queue/next') {
        if (!this.store.authOk(req)) return jsonResponse(res, 401, { error: 'unauthorized' });
        return jsonResponse(res, 200, { ok: true, accepted: true, started: false });
      }
    }

    return textResponse(res, 404, 'not found');
  }
}

export class MergeRustProcessManager {
  constructor({
    mergeRustUrl = '',
    mergeRustRoot = '',
    mergeRustBin = '',
    cargoBin = 'cargo',
    mergeRustPort = 18080,
    mergeRustStartTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    finalUploadMaxBytes = 10 * 1024 * 1024,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.mergeRustUrl = trimTrailingSlash(mergeRustUrl);
    this.mergeRustRoot = mergeRustRoot;
    this.mergeRustBin = mergeRustBin;
    this.cargoBin = cargoBin;
    this.mergeRustPort = mergeRustPort;
    this.mergeRustStartTimeoutMs = mergeRustStartTimeoutMs;
    this.finalUploadMaxBytes = finalUploadMaxBytes;
    this.fetchImpl = fetchImpl;
    this.child = null;
    this.spawnFailure = null;
  }

  serviceUrl() {
    return this.mergeRustUrl || `http://127.0.0.1:${this.mergeRustPort}`;
  }

  // Where the merge-rust service is expected to live. Empty MERGE_RUST_URL and
  // loopback URLs are "locally owned": this process may spawn/supervise the
  // service on that port. Anything else (or an unparseable URL) is an external
  // service that is never spawned from here.
  localTarget() {
    if (!this.mergeRustUrl) return { local: true, port: this.mergeRustPort };
    let parsed;
    try {
      parsed = new URL(this.mergeRustUrl);
    } catch {
      return { local: false };
    }
    const host = parsed.hostname.toLowerCase();
    if (!LOOPBACK_HOSTS.includes(host)) {
      return { local: false };
    }
    // A loopback URL without an explicit port falls back to MERGE_RUST_PORT;
    // keep the two consistent or health checks will probe the wrong port.
    return { local: true, port: parsed.port ? Number(parsed.port) : this.mergeRustPort };
  }

  async health(timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
    try {
      const resp = await fetchWithTimeout(this.fetchImpl, `${this.serviceUrl()}/health`, {}, timeoutMs);
      const text = await resp.text();
      const json = text && !text.startsWith('<') ? JSON.parse(text) : {};
      return {
        ok: resp.ok,
        url: this.serviceUrl(),
        status: resp.status,
        ...json,
      };
    } catch (error) {
      return {
        ok: false,
        url: this.serviceUrl(),
        error: error?.name === 'AbortError' ? 'health_timeout' : error?.message || 'health_failed',
      };
    }
  }

  async ensureStarted() {
    const target = this.localTarget();
    // External (non-loopback) MERGE_RUST_URL: never spawn, just hand it out.
    if (!target.local) return this.serviceUrl();
    const existing = await this.health(1500);
    if (existing.ok) return this.serviceUrl();
    if (!this.child) this.spawnLocal(target.port);
    await this.waitForHealth();
    return this.serviceUrl();
  }

  spawnLocal(port = this.mergeRustPort) {
    this.spawnFailure = null;
    const env = {
      ...process.env,
      PORT: String(port),
      R2_UPLOAD_MAX_BYTES: String(this.finalUploadMaxBytes),
      PIPELINE_FONTS_DIR: path.join(this.mergeRustRoot, 'fonts'),
    };
    const command = this.mergeRustBin || this.cargoBin;
    const args = this.mergeRustBin ? [] : ['run', '--quiet'];
    const child = spawn(command, args, {
      cwd: this.mergeRustRoot || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    // A failed exec (cargo/binary missing) emits 'error'; without a listener
    // the EventEmitter throw would crash the whole worker/supervisor process.
    child.once('error', (error) => {
      this.spawnFailure = error;
      if (this.child === child) this.child = null;
    });
    child.once('exit', () => {
      if (this.child === child) this.child = null;
    });
  }

  async waitForHealth() {
    const deadline = Date.now() + this.mergeRustStartTimeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      // Our exec failed outright — it can never become healthy, so surface
      // the real reason instead of polling out the full start timeout.
      if (this.spawnFailure) break;
      // Keep polling even if the child exited (e.g. it lost the port to a
      // sibling instance that is still warming up): health is the contract.
      last = await this.health(3000);
      if (last.ok) return last;
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
    }
    if (this.spawnFailure) {
      throw new Error(`merge_rust_spawn_failed: ${this.spawnFailure.message || 'spawn_error'}`);
    }
    throw new Error(last?.error || 'merge_rust_service_not_ready');
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const DEFAULT_SUPERVISE_POLL_MS = 15_000;

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

/**
 * Foreground supervision loop for the locally owned merge-rust service — the
 * body of src/start-merge-rust.js (launchd agent
 * com.affiliate.admin-media-drive.merge-rust and `npm run start:merge-rust`).
 *
 * Resolves `{ supervised: false }` when MERGE_RUST_URL is external
 * (non-loopback), so the caller can exit 0 and a KeepAlive/SuccessfulExit=false
 * agent stays stopped. Otherwise it runs forever: it starts the service (or
 * adopts an already-healthy local process and watches it), and throws the
 * moment the supervised service dies so the caller exits non-zero and launchd
 * restarts it.
 */
export async function superviseMergeRust(manager, {
  log = () => {},
  pollMs = DEFAULT_SUPERVISE_POLL_MS,
  sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }),
} = {}) {
  if (!manager.localTarget().local) {
    log(`merge-rust supervisor: ${manager.serviceUrl()} is external (non-loopback) - nothing local to supervise`);
    return { supervised: false, reason: 'external_url', url: manager.serviceUrl() };
  }
  const readyLine = () => `merge-rust service ready at ${manager.serviceUrl()}${
    manager.child ? ` (pid ${manager.child.pid})` : ' (adopted already-running local process)'}`;

  await manager.ensureStarted();
  log(readyLine());
  for (;;) {
    if (manager.child) {
      const code = await waitForChildExit(manager.child);
      throw new Error(`merge_rust_exited_code_${code ?? 'signal'}`);
    }
    // A local process we did not spawn serves the port: watch its health and
    // take over the moment it goes away.
    await sleep(pollMs);
    const health = await manager.health();
    if (!health.ok) {
      log(`merge-rust supervisor: adopted local service went unhealthy (${health.error || `http_${health.status}`}) - starting our own`);
      await manager.ensureStarted();
      log(readyLine());
    }
  }
}

export class MergeRustPipelineProcessor {
  constructor({
    namespaceId = 'admin',
    processorConfig = {},
    fetchImpl = globalThis.fetch,
    processManager,
    callbackServerFactory,
  } = {}) {
    this.inputMode = 'url';
    this.namespaceId = namespaceId;
    this.cfg = processorConfig;
    this.fetchImpl = fetchImpl;
    this.processManager = processManager || new MergeRustProcessManager({
      ...processorConfig,
      fetchImpl,
    });
    this.callbackServerFactory = callbackServerFactory || (async ({
      tempDir,
      token,
      botId,
      videoId,
    }) => {
      const store = new LocalR2CallbackStore({
        rootDir: tempDir,
        token,
        botId,
        videoId,
      });
      const server = new LocalPipelineCallbackServer({
        host: processorConfig.callbackHost || '127.0.0.1',
        port: processorConfig.callbackPort ?? 0,
        publicUrl: processorConfig.callbackPublicUrl || '',
        store,
      });
      await server.start();
      return server;
    });
  }

  async health() {
    const mergeRust = await this.processManager.health().catch((error) => ({
      ok: false,
      error: error?.message || 'health_failed',
    }));
    return {
      mode: 'merge_rust',
      mergeRust,
      queueProcessor: 'video-affiliate/merge-rust',
      model: this.cfg.geminiModel || 'gemini-3-flash-preview',
      vertexTtsModel: this.cfg.vertexTtsModel || 'gemini-3.1-flash-tts-preview',
      voiceName: this.cfg.voiceName || DEFAULT_VOICE_NAME,
    };
  }

  buildVideoId(job, source) {
    const jobId = safePathSegment(job?.id, crypto.randomBytes(4).toString('hex'));
    const attachment = safePathSegment(source?.attachment_id, '');
    return attachment ? `amd_${jobId}_${attachment}` : `amd_${jobId}`;
  }

  buildPipelinePayload({
    token,
    sourceUrl,
    callbackUrl,
    videoId,
    botId,
    vertexCredentials = null,
  }) {
    const payload = {
      token,
      video_url: sourceUrl,
      chat_id: 0,
      model: this.cfg.geminiModel || 'gemini-3-flash-preview',
      vertex_tts_endpoint: this.cfg.vertexTtsEndpoint || 'https://aiplatform.googleapis.com',
      vertex_tts_project_id: this.cfg.vertexTtsProjectId || vertexCredentials?.projectId || undefined,
      vertex_tts_location: this.cfg.vertexTtsLocation || 'global',
      vertex_tts_model: this.cfg.vertexTtsModel || 'gemini-3.1-flash-tts-preview',
      script_prompt: this.cfg.scriptPrompt || DEFAULT_VOICE_SCRIPT_PROMPT,
      voice_name: this.cfg.voiceName || DEFAULT_VOICE_NAME,
      tts_prompt_template: this.cfg.ttsPromptTemplate || DEFAULT_TTS_PROMPT_TEMPLATE,
      tts_style_instructions: this.cfg.ttsStyleInstructions || DEFAULT_TTS_STYLE_INSTRUCTIONS,
      r2_public_url: `${callbackUrl}/r2-public`,
      worker_url: callbackUrl,
      video_id: videoId,
      bot_id: botId,
    };
    // Attached only for a loopback target (resolveVertexCredentials): the
    // credential travels solely inside this request body.
    if (vertexCredentials?.serviceAccountJson) {
      payload.vertex_tts_service_account_json = vertexCredentials.serviceAccountJson;
    }
    return payload;
  }

  // The service-account JSON is read lazily per job — only at dispatch time in
  // the process that runs the job — and only for a loopback merge-rust target:
  // the credential must never be sent to a non-loopback service, which
  // authenticates from its own environment instead. Operators may also give
  // merge-rust the credential directly via VERTEX_TTS_SERVICE_ACCOUNT_JSON in
  // the shared environment; the worker never reads that value, it only skips
  // injection when no file path is configured so that setup keeps working.
  async resolveVertexCredentials(mergeRustUrl) {
    if (!isLoopbackUrl(mergeRustUrl)) return null;
    const credentialsPath = String(this.cfg.vertexTtsCredentialsPath || '').trim();
    if (!credentialsPath && this.cfg.vertexTtsServiceAccountEnvSet) return null;
    const credentials = await loadVertexServiceAccount(credentialsPath);
    if (!String(this.cfg.vertexTtsProjectId || '').trim() && !credentials.projectId) {
      throw new VertexCredentialsError('vertex_credentials_missing_project_id');
    }
    return credentials;
  }

  async processVideo({
    outputPath,
    job,
    source,
    sourceUrl,
    tempDir,
  }) {
    if (!sourceUrl) throw new Error('source_url_required_for_merge_rust');
    if (!tempDir) throw new Error('temp_dir_required_for_merge_rust');

    const botId = this.namespaceId || 'admin';
    const videoId = this.buildVideoId(job, source);
    const token = crypto.randomBytes(32).toString('hex');
    const callback = await this.callbackServerFactory({
      tempDir,
      token,
      botId,
      videoId,
    });

    try {
      const mergeRustUrl = await this.processManager.ensureStarted();
      const vertexCredentials = await this.resolveVertexCredentials(mergeRustUrl);
      const payload = this.buildPipelinePayload({
        token,
        sourceUrl,
        callbackUrl: callback.url,
        videoId,
        botId,
        vertexCredentials,
      });
      const resp = await fetchWithTimeout(this.fetchImpl, `${mergeRustUrl}/pipeline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, 15_000);
      const bodyText = await resp.text();
      if (!resp.ok || bodyText.startsWith('<')) {
        throw new Error(`merge_rust_pipeline_dispatch_failed_http_${resp.status}`);
      }
      const completion = await callback.store.waitForCompletion({
        timeoutMs: this.cfg.mergeRustJobTimeoutMs || DEFAULT_JOB_TIMEOUT_MS,
      });
      await ensureDir(path.dirname(outputPath));
      await fsp.copyFile(completion.finalVideoPath, outputPath);

      // Subtitle context for the fail-closed gate. merge-rust burns fail-OPEN
      // when the local FFmpeg lacks libass, so the caller must verify burned
      // subtitles before treating this output as processed. A metadata without
      // skip flags counts as "subtitles required" on purpose.
      const metadata = completion.metadata || {};
      const skipped = (metadata.subtitlesSkipped ?? metadata.skipSubtitles) === true;
      const srtKey = `debug/${videoId}/final_subtitles.srt`;
      const srtEntry = await callback.store.get(srtKey).catch(() => null);

      return {
        outputPath,
        pipeline: 'merge_rust',
        videoId,
        metadata: completion.metadata,
        refreshed: completion.refreshed,
        subtitles: {
          skipped,
          srtKey,
          srtPath: srtEntry?.fullPath || null,
        },
      };
    } finally {
      await callback.close();
    }
  }

  async close() {
    if (this.processManager?.close) await this.processManager.close();
  }
}

export default MergeRustPipelineProcessor;
