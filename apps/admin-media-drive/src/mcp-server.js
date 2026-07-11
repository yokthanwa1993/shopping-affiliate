/**
 * Typed stdio MCP server for the Admin Media Drive local processing pipeline.
 *
 * Design contract (see the video-affiliate-processing-reliability skill):
 *  - This process is thin, typed orchestration ONLY. All business logic stays
 *    in Admin Media Drive / merge-rust behind the loopback REST API.
 *  - It talks exclusively to http://127.0.0.1:<port> — the API base URL is
 *    refused unless it is loopback. No shell, no SQL, no raw HTTP passthrough,
 *    no arbitrary channel ids, no arbitrary destination paths.
 *  - It never holds Discord/Vertex credentials: the LaunchAgent-owned API
 *    process owns `.env`; this server only reads its own MCP_* / MEDIA_* envs.
 *  - Local file submission is restricted to allowlisted roots + extensions
 *    and the server-side upload size cap.
 *
 * Tools: media_health, media_submit_video, media_job_status, media_result,
 *        media_verify.
 *
 * Run: `npm run mcp` (stdio transport).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3100';
export const DEFAULT_ALLOWED_EXTENSIONS = Object.freeze(['.mp4', '.mov', '.m4v', '.webm']);
const API_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 10 * 60_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class McpToolError extends Error {
  constructor(category, detail = '') {
    super(category);
    this.name = 'McpToolError';
    this.category = category;
    this.detail = String(detail || '').slice(0, 300);
  }
}

/** The MCP server may only ever call the local Admin Media Drive API. */
export function assertLoopbackBaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new McpToolError('mcp_api_url_invalid', rawUrl);
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!loopback || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new McpToolError('mcp_api_url_must_be_loopback', host);
  }
  return `${parsed.origin}`;
}

export function defaultAllowedRoots(homeDir = os.homedir()) {
  return [
    path.join(homeDir, 'Desktop'),
    path.join(homeDir, 'Downloads'),
    path.join(homeDir, 'Movies'),
    path.join(homeDir, 'AffiliateMedia', 'inbox'),
  ];
}

export function parseAllowedRoots(raw, homeDir = os.homedir()) {
  const entries = String(raw || '')
    .split(':')
    .map((p) => p.trim())
    .filter(Boolean);
  const roots = entries.length ? entries : defaultAllowedRoots(homeDir);
  return roots.map((p) => path.resolve(p));
}

function isUnder(rootPath, candidate) {
  const rel = path.relative(rootPath, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Validate a local submission path: absolute, real (symlinks resolved), a
 * regular file, allowlisted root, allowlisted extension, within size cap.
 */
export function validateSubmitPath(rawPath, {
  allowedRoots,
  allowedExtensions = DEFAULT_ALLOWED_EXTENSIONS,
  maxBytes,
  fsImpl = fs,
} = {}) {
  const asString = String(rawPath || '');
  if (!path.isAbsolute(asString)) {
    throw new McpToolError('submit_path_must_be_absolute');
  }
  let realPath;
  try {
    realPath = fsImpl.realpathSync(asString);
  } catch {
    throw new McpToolError('submit_path_not_found');
  }
  let stat;
  try {
    stat = fsImpl.statSync(realPath);
  } catch {
    throw new McpToolError('submit_path_not_found');
  }
  if (!stat.isFile()) throw new McpToolError('submit_path_not_a_file');
  const extension = path.extname(realPath).toLowerCase();
  if (!allowedExtensions.includes(extension)) {
    throw new McpToolError('submit_extension_not_allowed', extension);
  }
  const roots = (allowedRoots || []).map((p) => {
    try {
      return fsImpl.realpathSync(p);
    } catch {
      return null;
    }
  }).filter(Boolean);
  if (!roots.some((root) => isUnder(root, realPath))) {
    throw new McpToolError('submit_path_outside_allowed_roots');
  }
  if (Number.isFinite(maxBytes) && stat.size > maxBytes) {
    throw new McpToolError('submit_file_too_large', `${stat.size}b>${maxBytes}b`);
  }
  return {
    realPath,
    size: stat.size,
    extension,
    filename: path.basename(realPath),
  };
}

function safeCategory(value, fallback = null) {
  const v = String(value || '').trim();
  return /^[a-z0-9_]{1,64}$/.test(v) ? v : fallback;
}

function asBoolOrNull(v) {
  if (v === null || v === undefined) return null;
  return Boolean(v);
}

function sanitizeJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    status: job.status,
    phase: job.step || null,
    attempts: job.attempts ?? 0,
    errorCategory: safeCategory(job.error_category, job.error ? 'processing_failed' : null),
    subtitlesRequired: asBoolOrNull(job.subtitles_required),
    subtitlesVerified: asBoolOrNull(job.subtitles_verified),
    audioChanged: asBoolOrNull(job.audio_changed),
    sourceMediaItemId: job.source_media_item_id ?? null,
    sourceAttachmentId: job.source_attachment_id || null,
    outputMediaItemId: job.output_media_item_id ?? null,
    outputAttachmentId: job.output_attachment_id || null,
    createdAt: job.created_at || null,
    startedAt: job.started_at || null,
    finishedAt: job.finished_at || null,
  };
}

const JOB_OUTPUT_SHAPE = {
  jobId: z.number().int(),
  status: z.string(),
  phase: z.string().nullable(),
  attempts: z.number().int(),
  errorCategory: z.string().nullable(),
  subtitlesRequired: z.boolean().nullable(),
  subtitlesVerified: z.boolean().nullable(),
  audioChanged: z.boolean().nullable(),
  sourceMediaItemId: z.number().int().nullable(),
  sourceAttachmentId: z.string().nullable(),
  outputMediaItemId: z.number().int().nullable(),
  outputAttachmentId: z.string().nullable(),
  createdAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
};

/**
 * Build the typed toolset. Separated from the MCP transport so tests can
 * exercise schemas + handlers with a stubbed fetch and no stdio.
 */
export function buildToolset({
  apiBaseUrl = process.env.ADMIN_MEDIA_DRIVE_API_URL || DEFAULT_API_BASE_URL,
  allowedRoots = parseAllowedRoots(process.env.MEDIA_SUBMIT_ALLOWED_ROOTS),
  allowedExtensions = DEFAULT_ALLOWED_EXTENSIONS,
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
} = {}) {
  const baseUrl = assertLoopbackBaseUrl(apiBaseUrl);

  async function apiFetch(pathname, { method = 'GET', body, headers, timeoutMs = API_TIMEOUT_MS, redirect } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        method,
        body,
        headers,
        redirect,
        signal: controller.signal,
      });
    } catch (error) {
      throw new McpToolError(
        error?.name === 'AbortError' ? 'api_timeout' : 'api_unreachable',
        error?.message,
      );
    } finally {
      clearTimeout(timer);
    }
    return response;
  }

  async function apiJson(pathname, init = {}) {
    const response = await apiFetch(pathname, init);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new McpToolError(
        safeCategory(data?.error, 'api_error'),
        `HTTP ${response.status}`,
      );
    }
    return data || {};
  }

  let cachedMaxBytes = null;
  async function submitMaxBytes() {
    if (cachedMaxBytes && Date.now() - cachedMaxBytes.at < 60_000) return cachedMaxBytes.value;
    const health = await apiJson('/api/health');
    const value = Number(health.maxUploadBytes) || 10 * 1024 * 1024;
    cachedMaxBytes = { at: Date.now(), value };
    return value;
  }

  async function fetchJobDetail(jobId) {
    return apiJson(`/api/processor/jobs/${jobId}`);
  }

  const tools = [
    {
      name: 'media_health',
      title: 'Admin Media Drive health',
      description: 'Sanitized health of the local Admin Media Drive API and the merge-rust '
        + 'processing pipeline: storage mode, queue counts, processed/source channel readiness, '
        + 'subtitle verification gate readiness. Never returns tokens or credentials.',
      annotations: { readOnlyHint: true },
      inputShape: {},
      outputShape: {
        ok: z.boolean(),
        api: z.object({}).passthrough(),
        processor: z.object({}).passthrough(),
      },
      async handler() {
        const [api, processor] = await Promise.all([
          apiJson('/api/health'),
          apiJson('/api/processor/health'),
        ]);
        return {
          ok: Boolean(api.ok && processor.ok),
          api: {
            service: api.service,
            namespaceId: api.namespaceId,
            storageMode: api.storageMode,
            discordConfigured: Boolean(api.configured),
            discordReady: Boolean(api.ready),
            sourceChannelConfigured: Boolean(api.sourceChannelId),
            processedChannelConfigured: Boolean(api.processedChannelId),
            maxUploadBytes: api.maxUploadBytes,
            counts: api.counts || {},
          },
          processor: {
            mode: processor.mode,
            mergeRustOk: Boolean(processor.mergeRust?.ok),
            model: processor.model,
            vertexTtsModel: processor.vertexTtsModel,
            voiceName: processor.voiceName,
            queue: processor.queue || {},
            processedChannelConfigured: Boolean(processor.processedChannelConfigured),
            subtitleGate: processor.subtitleGate || null,
          },
        };
      },
    },
    {
      name: 'media_submit_video',
      title: 'Submit a local video for processing',
      description: 'Submit an absolute local video path for the full dubbing/subtitle pipeline. '
        + `The path must be a real file under an allowlisted root, with an allowlisted video `
        + `extension (${DEFAULT_ALLOWED_EXTENSIONS.join(', ')}), within the upload size cap. `
        + 'The file is uploaded to the configured SOURCE Discord channel and enqueued exactly '
        + 'once per distinct file (sha256 + optional idempotency key). Returns job/media identity.',
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputShape: {
        path: z.string().min(2)
          .describe('Absolute local path of the video file to submit'),
        idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_RE)
          .optional()
          .describe('Optional caller idempotency key (1-128 chars of A-Za-z0-9._:-)'),
      },
      outputShape: {
        deduplicated: z.boolean(),
        submissionId: z.number().int().nullable(),
        sourceSha256: z.string().nullable(),
        mediaItemId: z.number().int().nullable(),
        attachmentId: z.string().nullable(),
        channelId: z.string().nullable(),
        messageId: z.string().nullable(),
        jobId: z.number().int().nullable(),
        jobStatus: z.string().nullable(),
      },
      async handler({ path: rawPath, idempotencyKey }) {
        const maxBytes = await submitMaxBytes();
        const file = validateSubmitPath(rawPath, {
          allowedRoots,
          allowedExtensions,
          maxBytes,
          fsImpl,
        });
        const buffer = await fsImpl.promises.readFile(file.realPath);
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: 'video/mp4' }), file.filename);
        if (idempotencyKey) form.append('idempotencyKey', idempotencyKey);
        const data = await apiJson('/api/processor/submissions', {
          method: 'POST',
          body: form,
          timeoutMs: 120_000,
        });
        return {
          deduplicated: Boolean(data.deduplicated),
          submissionId: data.submission?.id ?? null,
          sourceSha256: data.submission?.source_sha256 || null,
          mediaItemId: data.mediaItem?.id ?? null,
          attachmentId: data.mediaItem?.attachment_id || null,
          channelId: data.mediaItem?.channel_id || null,
          messageId: data.mediaItem?.message_id || null,
          jobId: data.job?.id ?? null,
          jobStatus: data.job?.status || null,
        };
      },
    },
    {
      name: 'media_job_status',
      title: 'Processing job status',
      description: 'Sanitized status of one processing job: lifecycle status '
        + '(queued|processing|processed|failed), current phase/step, attempts, sanitized error '
        + 'category, and the subtitle/audio verification flags.',
      annotations: { readOnlyHint: true },
      inputShape: {
        jobId: z.number().int().positive().describe('Processing job id'),
      },
      outputShape: JOB_OUTPUT_SHAPE,
      async handler({ jobId }) {
        const data = await fetchJobDetail(jobId);
        return sanitizeJob(data.job);
      },
    },
    {
      name: 'media_result',
      title: 'Processed job result',
      description: 'Final result identity for a PROCESSED job: output Discord identity '
        + '(channel/message/attachment + jump URL), the local fresh-URL proxy path and its '
        + 'current resolvability, audioChanged / subtitlesRequired / subtitlesVerified flags, '
        + 'and the subtitle proof-sheet identity. Never returns credentials or bot tokens.',
      annotations: { readOnlyHint: true },
      inputShape: {
        jobId: z.number().int().positive().describe('Processing job id'),
      },
      outputShape: {
        jobId: z.number().int(),
        status: z.string(),
        output: z.object({
          mediaItemId: z.number().int().nullable(),
          attachmentId: z.string().nullable(),
          channelId: z.string().nullable(),
          messageId: z.string().nullable(),
          filename: z.string().nullable(),
          size: z.number().nullable(),
          jumpUrl: z.string().nullable(),
        }).nullable(),
        localProxyPath: z.string().nullable(),
        freshUrlOk: z.boolean().nullable(),
        audioChanged: z.boolean().nullable(),
        subtitlesRequired: z.boolean().nullable(),
        subtitlesVerified: z.boolean().nullable(),
        proof: z.object({
          mode: z.string().nullable(),
          pass: z.boolean().nullable(),
          cueCount: z.number().nullable(),
          sampledCues: z.number().nullable(),
          proofSheetPath: z.string().nullable(),
          proofSheetSha256: z.string().nullable(),
          artifactPath: z.string().nullable(),
        }).nullable(),
      },
      async handler({ jobId }) {
        const data = await fetchJobDetail(jobId);
        const job = data.job;
        if (!job) throw new McpToolError('processing_job_not_found');
        if (job.status !== 'processed') {
          throw new McpToolError('processing_job_not_processed', job.status);
        }
        const output = data.output || null;
        const verification = data.verification || null;
        const localProxyPath = output?.id ? `/api/local-media/${output.id}/file` : null;
        let freshUrlOk = null;
        if (localProxyPath) {
          try {
            const head = await apiFetch(localProxyPath, { method: 'HEAD', redirect: 'manual' });
            freshUrlOk = head.status === 302;
          } catch {
            freshUrlOk = false;
          }
        }
        return {
          jobId: job.id,
          status: job.status,
          output: output ? {
            mediaItemId: output.id ?? null,
            attachmentId: output.attachment_id || null,
            channelId: output.channel_id || null,
            messageId: output.message_id || null,
            filename: output.filename || null,
            size: output.size ?? null,
            jumpUrl: output.jump_url || null,
          } : null,
          localProxyPath,
          freshUrlOk,
          audioChanged: asBoolOrNull(job.audio_changed),
          subtitlesRequired: asBoolOrNull(job.subtitles_required),
          subtitlesVerified: asBoolOrNull(job.subtitles_verified),
          proof: verification ? {
            mode: verification.mode || null,
            pass: verification.pass ?? null,
            cueCount: verification.srt?.cueCount ?? null,
            sampledCues: verification.frames?.sampledCues?.length ?? null,
            proofSheetPath: verification.proofSheet?.path || null,
            proofSheetSha256: verification.proofSheet?.sha256 || null,
            artifactPath: verification.artifactPath || null,
          } : null,
        };
      },
    },
    {
      name: 'media_verify',
      title: 'Re-verify a processed job',
      description: 'Re-run the deterministic verification for a PROCESSED job: download the '
        + 'processed Discord attachment via a fresh URL, ffprobe + full decode, duration bound '
        + 'against the recorded value, and (when the original run stored per-cue proof data) '
        + 'a subtitle text-presence check at each recorded cue midpoint. Slow (video download '
        + '+ full decode); returns a sanitized verification summary.',
      annotations: { readOnlyHint: true },
      inputShape: {
        jobId: z.number().int().positive().describe('Processed job id'),
      },
      outputShape: {
        jobId: z.number().int(),
        pass: z.boolean(),
        mode: z.string().nullable(),
        decodeOk: z.boolean().nullable(),
        durationOk: z.boolean().nullable(),
        framesChecked: z.number().nullable(),
        framesDetected: z.number().nullable(),
        verifiedAt: z.string().nullable(),
      },
      async handler({ jobId }) {
        const data = await apiJson(`/api/processor/jobs/${jobId}/verify`, {
          method: 'POST',
          timeoutMs: VERIFY_TIMEOUT_MS,
        });
        const record = data.reverify || {};
        return {
          jobId: Number(jobId),
          pass: Boolean(record.pass),
          mode: record.mode || null,
          decodeOk: record.decode?.ok ?? null,
          durationOk: record.durationOk ?? null,
          framesChecked: Array.isArray(record.frames) ? record.frames.length : null,
          framesDetected: Array.isArray(record.frames)
            ? record.frames.filter((f) => f.textDetected).length
            : null,
          verifiedAt: record.finishedAt || null,
        };
      },
    },
  ];

  return { baseUrl, allowedRoots, allowedExtensions, tools };
}

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function toolError(error) {
  const category = error instanceof McpToolError
    ? error.category
    : safeCategory(error?.category, 'tool_failed');
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: category, detail: error?.detail || undefined }),
    }],
    isError: true,
  };
}

export function createMcpServer(options = {}) {
  const toolset = buildToolset(options);
  const server = new McpServer({ name: 'admin-media-drive', version: '0.2.0' });
  for (const tool of toolset.tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputShape,
      outputSchema: tool.outputShape,
      annotations: tool.annotations,
    }, async (args) => {
      try {
        return toolResult(await tool.handler(args || {}));
      } catch (error) {
        return toolError(error);
      }
    });
  }
  return { server, toolset };
}

async function main() {
  const { server, toolset } = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP transport.
  console.error(`admin-media-drive MCP ready (api=${toolset.baseUrl}, tools=${toolset.tools.map((t) => t.name).join(',')})`);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`admin-media-drive MCP failed: ${error?.category || error?.message || 'failed'}`);
    process.exit(1);
  });
}

export default createMcpServer;
