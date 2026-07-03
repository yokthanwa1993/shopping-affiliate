import path from 'node:path';

import { downloadTo, ensureDir, fsp, sanitizeFilename } from './storage.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);

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
    downloadFile = downloadTo,
  }) {
    this.cfg = cfg;
    this.db = db;
    this.discord = discord;
    this.processor = processor;
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

      await ensureDir(tempDir);
      current = this.db.markProcessingJobStarted(current.id, {
        step: 'downloading',
        tempDir,
        inputPath,
        outputPath,
      });

      step = 'downloading';
      const sourceUrl = await this.resolveSourceUrl(source);
      await this.downloadFile(sourceUrl, inputPath);

      step = 'processing';
      current = this.db.updateProcessingJobStep(current.id, { step });
      await this.processor.processVideo({ inputPath, outputPath, job: current, source });

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
        await this.cleanup(tempDir);
        throw error;
      }
      current = this.db.markProcessingJobFailed(current.id, {
        step,
        error: error?.message || 'processing_failed',
      });
      await this.cleanup(tempDir);
      throw new ProcessingError(error?.message || 'processing_failed', {
        status: error?.status || 500,
        job: current,
      });
    }
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
