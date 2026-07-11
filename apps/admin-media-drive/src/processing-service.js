import crypto from 'node:crypto';
import path from 'node:path';

import { downloadTo, ensureDir, fsp, sanitizeFilename } from './storage.js';

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class ProcessingError extends Error {
  constructor(message, { status = 500, job = null } = {}) {
    super(message);
    this.name = 'ProcessingError';
    this.status = status;
    this.job = job;
  }
}

function outputChannelId(cfg) {
  return String(cfg.discord?.processedChannelId || cfg.discord?.defaultChannelId || '').trim();
}

export function processedChannelConfigured(cfg) {
  return Boolean(outputChannelId(cfg));
}

function isVideoMediaItem(row) {
  const contentType = String(row?.content_type || '').toLowerCase();
  const extension = path.extname(row?.filename || '').toLowerCase();
  return contentType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension);
}

function safeOptions() {
  // MVP intentionally stores no caller-supplied free-form options so secrets
  // cannot accidentally be persisted in options_json.
  return {};
}

function tempDirForJob(cfg, jobId) {
  const root = path.resolve(cfg.mediaRoot);
  const full = path.resolve(root, 'tmp', 'admin-media-drive-processing', String(jobId));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ProcessingError('processing_temp_dir_outside_media_root', { status: 500 });
  }
  return full;
}

function mediaItemFromUploadedAttachment(cfg, item, { size = null } = {}) {
  return {
    namespace_id: cfg.namespaceId,
    channel_id: item.channelId,
    message_id: item.messageId,
    attachment_id: item.id,
    filename: item.filename,
    content_type: 'video/mp4',
    size: item.size ?? size,
    local_path: null,
    discord_url: item.url,
    jump_url: item.jumpUrl,
    status: 'processed_discord_indexed',
    created_at: item.createdAt,
  };
}

export class ProcessingService {
  constructor({
    cfg,
    db,
    discord,
    processor,
    subtitleGate = null,
    downloadFile = downloadTo,
  }) {
    this.cfg = cfg;
    this.db = db;
    this.discord = discord;
    this.processor = processor;
    this.subtitleGate = subtitleGate;
    this.downloadFile = downloadFile;
  }

  resolveSource({ mediaItemId, attachmentId }) {
    let row = null;
    if (mediaItemId !== undefined && mediaItemId !== null && String(mediaItemId).trim()) {
      row = this.db.getById(mediaItemId);
    } else if (attachmentId) {
      row = this.db.getByAttachment(this.cfg.namespaceId, String(attachmentId));
    }

    if (!row || row.namespace_id !== this.cfg.namespaceId) {
      throw new ProcessingError('source_media_item_not_found', { status: 404 });
    }
    if (!isVideoMediaItem(row)) {
      throw new ProcessingError('source_media_item_is_not_video', { status: 400 });
    }
    if (!row.attachment_id || !row.channel_id || !row.message_id) {
      throw new ProcessingError('source_discord_identity_incomplete', { status: 400 });
    }
    return row;
  }

  enqueue({ mediaItemId, attachmentId, options } = {}) {
    const source = this.resolveSource({ mediaItemId, attachmentId });
    return this.db.createProcessingJob({
      namespaceId: this.cfg.namespaceId,
      sourceMediaItemId: source.id,
      sourceAttachmentId: source.attachment_id,
      sourceChannelId: source.channel_id,
      sourceMessageId: source.message_id,
      options: safeOptions(options),
    });
  }

  /**
   * Idempotent one-shot submission used by the MCP `media_submit_video` tool:
   * upload a local video to the configured SOURCE channel, index it (with its
   * sha256), and enqueue exactly one processing job per distinct file.
   *
   * Dedup rules:
   *  - same `idempotencyKey` + same bytes  -> the original submission
   *  - same `idempotencyKey` + other bytes -> 409 idempotency_key_conflict
   *  - same bytes (any key)                -> the original submission
   *  - previously-indexed identical file   -> reuse the media item; reuse its
   *    latest job unless that job failed, in which case enqueue a fresh one.
   */
  async submitVideo({ buffer, filename, idempotencyKey = null } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw new ProcessingError('submission_file_required', { status: 400 });
    }
    const extension = path.extname(filename || '').toLowerCase();
    if (!VIDEO_EXTENSIONS.has(extension)) {
      throw new ProcessingError('submission_not_a_video', { status: 400 });
    }
    if (idempotencyKey !== null && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new ProcessingError('invalid_idempotency_key', { status: 400 });
    }
    const sourceChannelId = String(this.cfg.discord?.sourceChannelId || '').trim();
    if (!sourceChannelId) {
      throw new ProcessingError('source_channel_not_configured', { status: 400 });
    }

    const sourceSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const ns = this.cfg.namespaceId;

    const describe = (submission) => ({
      submission,
      mediaItem: submission.media_item_id ? this.db.getById(submission.media_item_id) : null,
      job: submission.job_id ? this.db.getProcessingJob(submission.job_id) : null,
    });

    if (idempotencyKey) {
      const byKey = this.db.findSubmissionByKey(ns, idempotencyKey);
      if (byKey) {
        if (byKey.source_sha256 !== sourceSha256) {
          throw new ProcessingError('idempotency_key_conflict', { status: 409 });
        }
        return { deduplicated: true, ...describe(byKey) };
      }
    }
    const bySha = this.db.findSubmissionBySha(ns, sourceSha256);
    if (bySha) {
      return { deduplicated: true, ...describe(bySha) };
    }

    // A file already indexed (e.g. uploaded via the UI) is reused rather than
    // re-uploaded, so Discord never receives duplicate source attachments.
    let mediaItem = this.db.getBySourceSha256(ns, sourceSha256) || null;
    if (!mediaItem) {
      const uploaded = await this.discord.uploadFile({
        channelId: sourceChannelId,
        buffer,
        filename: sanitizeFilename(filename || `submission${extension}`),
        mimetype: extension === '.mp4' ? 'video/mp4' : 'video/*',
        caption: '',
      });
      mediaItem = this.db.upsert({
        namespace_id: ns,
        channel_id: uploaded.channelId,
        message_id: uploaded.messageId,
        attachment_id: uploaded.id,
        filename: uploaded.filename,
        content_type: uploaded.contentType || 'video/mp4',
        size: uploaded.size ?? buffer.length,
        local_path: null,
        discord_url: uploaded.url,
        jump_url: uploaded.jumpUrl,
        status: 'discord_indexed',
        source_sha256: sourceSha256,
        created_at: uploaded.createdAt,
      });
    }

    let job = this.db.getLatestProcessingJobForMediaItem(ns, mediaItem.id) || null;
    if (!job || job.status === 'failed') {
      job = this.enqueue({ mediaItemId: mediaItem.id });
    }

    const submission = this.db.createSubmission({
      namespaceId: ns,
      idempotencyKey,
      sourceSha256,
      mediaItemId: mediaItem.id,
      jobId: job.id,
      originalName: sanitizeFilename(filename || ''),
      size: buffer.length,
    });
    return { deduplicated: false, submission, mediaItem, job };
  }

  /** Sanitized subtitle-gate dependency status for /api/processor/health. */
  async gateHealth() {
    if (!this.subtitleGate) return { enabled: false, configured: false };
    const pre = await this.subtitleGate.preflight().catch(() => null);
    return {
      configured: true,
      enabled: this.subtitleGate.enabled,
      ready: Boolean(pre?.ok),
      python: Boolean(pre?.python),
      pillow: Boolean(pre?.pillow),
      pillowVersion: pre?.pillowVersion || '',
      overlayHelper: Boolean(pre?.overlayHelper),
      proofHelper: Boolean(pre?.proofHelper),
      font: Boolean(pre?.font),
      categories: pre?.categories || ['preflight_failed'],
    };
  }

  async health() {
    const processor = await this.processor.health();
    return {
      ...processor,
      processedChannelConfigured: processedChannelConfigured(this.cfg),
      queue: this.db.countProcessingJobs(this.cfg.namespaceId),
    };
  }

  async runNext() {
    const job = this.db.getNextQueuedProcessingJob(this.cfg.namespaceId);
    if (!job) return null;
    return this.runJob(job.id);
  }

  async runJob(id) {
    const job = this.db.getProcessingJob(id);
    if (!job || job.namespace_id !== this.cfg.namespaceId) {
      throw new ProcessingError('processing_job_not_found', { status: 404 });
    }
    if (job.status === 'processing') {
      throw new ProcessingError('processing_job_already_running', { status: 409, job });
    }
    if (job.status === 'processed') {
      throw new ProcessingError('processing_job_already_processed', { status: 409, job });
    }
    return this.process(job);
  }

  retryJob(id) {
    const row = this.db.retryProcessingJob(id);
    if (!row) {
      throw new ProcessingError('processing_job_not_retryable', { status: 404 });
    }
    return row;
  }

  async process(job) {
    let current = job;
    let tempDir = current.temp_dir || tempDirForJob(this.cfg, current.id);
    let step = current.step || 'queued';

    try {
      const channelId = outputChannelId(this.cfg);
      if (!channelId) {
        current = this.db.markProcessingJobFailed(current.id, {
          step: 'configure_output_channel',
          error: 'processed_channel_not_configured',
        });
        throw new ProcessingError('processed_channel_not_configured', {
          status: 400,
          job: current,
        });
      }

      const source = this.resolveSource({ mediaItemId: current.source_media_item_id });
      const sourceExt = path.extname(source.filename || '').toLowerCase() || '.bin';
      const baseName = sanitizeFilename(path.basename(source.filename || 'source', sourceExt));
      const inputPath = path.join(tempDir, `source-${source.attachment_id}${sourceExt}`);
      const outputFilename = `${baseName || 'source'}-processed-${current.id}.mp4`;
      const outputPath = path.join(tempDir, outputFilename);
      const processorInputMode = this.processor?.inputMode === 'url' ? 'url' : 'file';

      await ensureDir(tempDir);
      const claimed = this.db.markProcessingJobStarted(current.id, {
        step: processorInputMode === 'url' ? 'resolving_source_url' : 'downloading',
        tempDir,
        inputPath: processorInputMode === 'url' ? null : inputPath,
        outputPath,
      });
      if (!claimed) {
        // Another process (API run vs worker poll) claimed this job first.
        // Do NOT clean the temp dir — the winner is using it.
        const raceError = new ProcessingError('processing_job_already_running', {
          status: 409,
          job: this.db.getProcessingJob(current.id),
        });
        raceError.skipCleanup = true;
        throw raceError;
      }
      current = claimed;

      step = processorInputMode === 'url' ? 'resolving_source_url' : 'downloading';
      const sourceUrl = await this.resolveSourceUrl(source);
      if (processorInputMode === 'file') {
        await this.downloadFile(sourceUrl, inputPath);
      }

      step = 'processing';
      current = this.db.updateProcessingJobStep(current.id, { step });
      const processResult = await this.processor.processVideo({
        inputPath: processorInputMode === 'file' ? inputPath : null,
        outputPath,
        job: current,
        source,
        sourceUrl,
        tempDir,
      });

      // Fail-closed subtitle/audio verification gate. When the processor ran
      // the dubbing pipeline, the output must PROVE burned subtitles (and a
      // changed voiceover) before anything is uploaded to Discord. A gate
      // failure marks the job failed — no provisional no-subtitle upload.
      if (this.subtitleGate) {
        step = 'verifying_subtitles';
        current = this.db.updateProcessingJobStep(current.id, { step });
        let gate;
        try {
          gate = await this.subtitleGate.enforce({
            processResult,
            outputPath,
            tempDir,
            sourceUrl,
            jobId: current.id,
          });
        } catch (error) {
          const category = error?.category || 'subtitle_verification_failed';
          if (error?.record) {
            this.db.updateProcessingJobVerification(current.id, {
              subtitlesRequired: error.record.subtitlesRequired,
              subtitlesVerified: false,
              audioChanged: error.record.audioChanged,
              verificationJson: JSON.stringify(error.record),
            });
          }
          current = this.db.markProcessingJobFailed(current.id, {
            step,
            error: category,
            errorCategory: category,
          });
          await this.cleanup(tempDir);
          throw new ProcessingError(category, {
            status: error?.status || 422,
            job: current,
          });
        }
        if (gate?.record) {
          current = this.db.updateProcessingJobVerification(current.id, {
            subtitlesRequired: gate.required,
            subtitlesVerified: gate.verified,
            audioChanged: gate.audioChanged,
            verificationJson: JSON.stringify(gate.record),
          }) || current;
        }
      }

      step = 'uploading';
      current = this.db.updateProcessingJobStep(current.id, { step });
      const stat = await fsp.stat(outputPath);
      const uploaded = await this.discord.uploadFile({
        channelId,
        filePath: outputPath,
        filename: outputFilename,
        mimetype: 'video/mp4',
        caption: `Processed from attachment ${source.attachment_id}`,
      });
      const outputRow = this.db.upsert(mediaItemFromUploadedAttachment(this.cfg, uploaded, {
        size: stat.size,
      }));

      current = this.db.markProcessingJobProcessed(current.id, {
        step: 'uploaded',
        outputMediaItemId: outputRow.id,
        outputAttachmentId: uploaded.id,
        outputChannelId: uploaded.channelId,
        outputMessageId: uploaded.messageId,
      });
      await this.cleanup(tempDir);
      return current;
    } catch (error) {
      if (error instanceof ProcessingError && error.job) {
        if (!error.skipCleanup) await this.cleanup(tempDir);
        throw error;
      }
      current = this.db.markProcessingJobFailed(current.id, {
        step,
        error: error?.message || 'processing_failed',
        errorCategory: error?.category || null,
      });
      await this.cleanup(tempDir);
      throw new ProcessingError(error?.message || 'processing_failed', {
        status: error?.status || 500,
        job: current,
      });
    }
  }

  /**
   * Deterministic re-verification of an already-processed job: download the
   * processed Discord attachment via a fresh URL and re-run the decode /
   * duration / subtitle-presence proof checks. Stores the result alongside the
   * original verification artifact (`lastReverify`).
   */
  async reverifyJob(id) {
    const job = this.db.getProcessingJob(id);
    if (!job || job.namespace_id !== this.cfg.namespaceId) {
      throw new ProcessingError('processing_job_not_found', { status: 404 });
    }
    if (job.status !== 'processed') {
      throw new ProcessingError('processing_job_not_processed', { status: 409, job });
    }
    if (!job.output_channel_id || !job.output_message_id || !job.output_attachment_id) {
      throw new ProcessingError('processed_output_identity_missing', { status: 409, job });
    }
    if (!this.subtitleGate?.reverify) {
      throw new ProcessingError('subtitle_gate_unavailable', { status: 501 });
    }

    const freshUrl = await this.discord.resolveFreshUrl(
      job.output_channel_id,
      job.output_message_id,
      job.output_attachment_id,
    );
    let prior = null;
    try {
      prior = job.subtitle_verification_json ? JSON.parse(job.subtitle_verification_json) : null;
    } catch {
      prior = null;
    }

    let result;
    try {
      result = await this.subtitleGate.reverify({
        videoUrl: freshUrl,
        prior,
        jobId: job.id,
      });
    } catch (error) {
      const category = error?.category || 'reverify_failed';
      if (error?.record && prior) {
        prior.lastReverify = error.record;
        this.db.updateProcessingJobVerification(job.id, {
          subtitlesRequired: job.subtitles_required,
          subtitlesVerified: job.subtitles_verified,
          audioChanged: job.audio_changed,
          verificationJson: JSON.stringify(prior),
        });
      }
      throw new ProcessingError(category, { status: error?.status || 422, job });
    }

    const merged = prior || {};
    merged.lastReverify = result.record;
    const updated = this.db.updateProcessingJobVerification(job.id, {
      subtitlesRequired: job.subtitles_required,
      subtitlesVerified: job.subtitles_verified,
      audioChanged: job.audio_changed,
      verificationJson: JSON.stringify(merged),
    });
    return { job: updated || job, reverify: result.record };
  }

  async resolveSourceUrl(source) {
    try {
      if (this.discord?.resolveFreshUrl) {
        return await this.discord.resolveFreshUrl(
          source.channel_id,
          source.message_id,
          source.attachment_id,
        );
      }
    } catch (error) {
      if (!source.discord_url) throw error;
    }
    if (!source.discord_url) {
      throw new Error('source_discord_url_missing');
    }
    return source.discord_url;
  }

  async cleanup(tempDir) {
    if (this.cfg.processor?.keepTmp || !tempDir) return;
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default ProcessingService;
