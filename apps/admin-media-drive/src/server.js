import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';

import config, { defaultIndexStatus } from './config.js';
import { openDb } from './db.js';
import { DiscordService, isMediaUpload } from './discord.js';
import { NativeFfmpegProcessor } from './processor.js';
import {
  ProcessingError,
  ProcessingService,
  processedChannelConfigured,
} from './processing-service.js';
import {
  localPathFor,
  downloadTo,
  writeBuffer,
} from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

/**
 * Build the Express app + its dependencies. Exported so tests / callers can
 * construct it without necessarily connecting to Discord.
 */
export function createApp({
  cfg = config,
  discord,
  db,
  processor,
  processingService,
  downloadFile,
} = {}) {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cfg.maxUploadBytes, files: 1 },
  });

  const svc = discord || new DiscordService(cfg.discord);
  const index = db || openDb(cfg.dbPath);
  const nativeProcessor = processor || new NativeFfmpegProcessor(cfg.processor);
  const processorSvc = processingService || new ProcessingService({
    cfg,
    db: index,
    discord: svc,
    processor: nativeProcessor,
    downloadFile,
  });

  // Discord-backed storage is the default: Discord holds 100% of the media,
  // the Mac mini only indexes metadata. `mirror` is the legacy local-copy mode.
  const mirrorMode = cfg.storageMode === 'mirror';

  function requireBot(res) {
    if (!svc.configured) {
      res.status(503).json({ error: 'Discord bot is not configured', configured: false });
      return false;
    }
    if (!svc.ready) {
      res.status(503).json({
        error: svc.error || 'Discord bot is still connecting',
        configured: true,
        ready: false,
      });
      return false;
    }
    return true;
  }

  function sendProcessingError(res, error) {
    const status = error?.status || 500;
    return res.status(status).json({
      error: error?.message || 'processor_error',
      job: error instanceof ProcessingError ? error.job : undefined,
    });
  }

  // Map a Discord attachment description into a media_items row and index it,
  // optionally recording a local mirror path.
  function indexAttachment(item, { localPath = null, status = defaultIndexStatus(cfg.storageMode) } = {}) {
    return index.upsert({
      namespace_id: cfg.namespaceId,
      channel_id: item.channelId,
      message_id: item.messageId,
      attachment_id: item.id,
      filename: item.filename,
      content_type: item.contentType,
      size: item.size,
      local_path: localPath,
      discord_url: item.url,
      jump_url: item.jumpUrl,
      status,
      created_at: item.createdAt,
    });
  }

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors());
  app.use(express.json());
  app.use(express.static(publicDir));

  // --- Health (no Discord required) ---------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'admin-media-drive',
      namespaceId: cfg.namespaceId,
      storageMode: cfg.storageMode,
      configured: svc.configured,
      ready: svc.ready,
      // In discord mode mediaRoot is only a transient temp/cache dir.
      mediaRoot: cfg.mediaRoot,
      dbPath: cfg.dbPath,
      sourceChannelId: cfg.discord.sourceChannelId,
      processedChannelId: cfg.discord.processedChannelId,
      maxUploadBytes: cfg.maxUploadBytes,
      counts: {
        mediaItems: index.count(cfg.namespaceId),
        processingJobs: index.countProcessingJobs(cfg.namespaceId),
      },
    });
  });

  // --- Status (used by the UI) --------------------------------------------
  app.get('/api/status', async (_req, res) => {
    let channels = [];
    if (svc.ready) {
      try {
        channels = await svc.getTextChannels();
      } catch (error) {
        svc.error = error?.message || 'Failed to read Discord channels';
      }
    }
    res.json({
      configured: svc.configured,
      ready: svc.ready,
      error: svc.error,
      bot: svc.user ? {
        id: svc.user.id,
        username: svc.user.username,
        tag: svc.user.tag,
        avatarUrl: svc.user.displayAvatarURL(),
      } : null,
      guildId: cfg.discord.guildId,
      defaultChannelId: cfg.discord.defaultChannelId,
      sourceChannelId: cfg.discord.sourceChannelId,
      processedChannelId: cfg.discord.processedChannelId,
      storageMode: cfg.storageMode,
      maxUploadBytes: cfg.maxUploadBytes,
      namespaceId: cfg.namespaceId,
      channels,
    });
  });

  // --- Channels (preserved) -----------------------------------------------
  app.get('/api/channels', async (_req, res) => {
    if (!requireBot(res)) return;
    try {
      res.json({ channels: await svc.getTextChannels(), maxUploadBytes: cfg.maxUploadBytes });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list channels' });
    }
  });

  // --- Recent media in a channel (preserved) ------------------------------
  app.get('/api/channels/:channelId/media', async (req, res) => {
    if (!requireBot(res)) return;
    try {
      const items = await svc.fetchMediaItems(req.params.channelId, req.query.limit);
      res.json({ items });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list media' });
    }
  });

  // --- Fresh CDN url redirect (preserved) ---------------------------------
  app.get('/api/media/:channelId/:messageId/:attachmentId', async (req, res) => {
    if (!requireBot(res)) return;
    try {
      const url = await svc.resolveFreshUrl(
        req.params.channelId, req.params.messageId, req.params.attachmentId,
      );
      return res.redirect(302, url);
    } catch (error) {
      return res.status(error?.status || 500)
        .json({ error: error?.message || 'Failed to refresh attachment URL' });
    }
  });

  // --- Indexed media items from the local SQLite index --------------------
  app.get('/api/media-items', (req, res) => {
    try {
      const items = index.list({
        namespaceId: cfg.namespaceId,
        channelId: req.query.channelId ? String(req.query.channelId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ items, namespaceId: cfg.namespaceId });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list indexed media' });
    }
  });

  // --- Sync a channel ------------------------------------------------------
  // discord mode (default): index recent-message metadata only. No attachment
  //   bodies are downloaded. Reports indexed / skipped / failed.
  // mirror mode (legacy): also downloads missing local mirrors.
  app.post('/api/sync-channel', async (req, res) => {
    if (!requireBot(res)) return;
    const channelId = String(req.body?.channelId || cfg.discord.defaultChannelId || '').trim();
    const limit = req.body?.limit;
    if (!channelId) {
      return res.status(400).json({ error: 'channelId is required' });
    }
    try {
      const items = await svc.fetchMediaItems(channelId, limit);

      if (!mirrorMode) {
        // Discord-backed: metadata only, never fetch the file body.
        let indexed = 0;
        let skipped = 0;
        let failed = 0;
        for (const item of items) {
          try {
            const existed = index.getByAttachment(cfg.namespaceId, item.id);
            indexAttachment(item, { localPath: null, status: 'discord_indexed' });
            if (existed) skipped += 1; else indexed += 1;
          } catch {
            failed += 1;
          }
        }
        return res.json({
          mode: 'discord',
          channelId,
          total: items.length,
          indexed,
          skipped,
          failed,
          downloaded: 0,
        });
      }

      // Legacy mirror mode: download missing local copies.
      let downloaded = 0;
      let skipped = 0;
      let failed = 0;
      for (const item of items) {
        const target = localPathFor(cfg.mediaRoot, item.id, item.filename, item.createdAt);
        let localPath = null;
        let status = 'indexed';
        try {
          const result = await downloadTo(item.url, target);
          localPath = result.path;
          status = 'mirrored';
          if (result.skipped) skipped += 1; else downloaded += 1;
        } catch {
          // Non-fatal: keep the index row without a local mirror.
          failed += 1;
          status = 'index_only';
        }
        indexAttachment(item, { localPath, status });
      }

      res.json({
        mode: 'mirror',
        channelId,
        total: items.length,
        downloaded,
        skipped,
        failed,
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to sync channel' });
    }
  });

  // --- File access for an indexed item ------------------------------------
  // discord mode (default): redirect to a FRESH Discord CDN url resolved from
  //   the DB row (no local file is kept). mirror mode: serve the local mirror
  //   with HTTP Range support.
  app.get('/api/local-media/:id/file', async (req, res) => {
    const row = index.getById(req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Unknown media item' });
    }

    if (!mirrorMode) {
      // Discord-backed: no local bytes — hand back a fresh CDN url.
      if (!requireBot(res)) return;
      try {
        const url = await svc.resolveFreshUrl(row.channel_id, row.message_id, row.attachment_id);
        return res.redirect(302, url);
      } catch (error) {
        return res.status(error?.status || 500)
          .json({ error: error?.message || 'Failed to resolve fresh Discord URL' });
      }
    }

    if (!row.local_path) {
      return res.status(404).json({ error: 'No local mirror for this item' });
    }
    // Confirm the stored path is still under MEDIA_ROOT before serving.
    const resolved = path.resolve(row.local_path);
    const rel = path.relative(cfg.mediaRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(403).json({ error: 'Path outside media root' });
    }

    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return res.status(404).json({ error: 'Local file missing' });
    }
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Local file missing' });
    }

    const contentType = row.content_type || 'application/octet-stream';
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      let start = match[1] === '' ? undefined : Number(match[1]);
      let end = match[2] === '' ? undefined : Number(match[2]);
      if (start === undefined) {
        // suffix range: last N bytes
        start = Math.max(stat.size - (end || 0), 0);
        end = stat.size - 1;
      } else if (end === undefined || end >= stat.size) {
        end = stat.size - 1;
      }
      if (start > end || start >= stat.size) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(resolved, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(resolved).pipe(res);
  });

  // --- Upload: Discord attachment + local mirror + DB row ------------------
  app.post('/api/upload', (req, res, next) => {
    upload.single('file')(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `File is larger than ${cfg.maxUploadBytes} bytes`,
          maxUploadBytes: cfg.maxUploadBytes,
        });
      }
      return res.status(400).json({ error: error?.message || 'Invalid upload' });
    });
  }, async (req, res) => {
    if (!requireBot(res)) return;
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file uploaded' });
      if (!isMediaUpload(file)) {
        return res.status(400).json({ error: 'Only image and video files are supported' });
      }
      const channelId = String(req.body.channelId || cfg.discord.defaultChannelId || '').trim();
      if (!channelId) {
        return res.status(400).json({ error: 'Select a Discord channel first' });
      }

      const item = await svc.uploadFile({
        channelId,
        buffer: file.buffer,
        filename: file.originalname,
        mimetype: file.mimetype,
        caption: req.body.caption,
      });

      // discord mode (default): Discord keeps the only copy — index metadata
      // only, never write a permanent local file. mirror mode: also mirror it.
      let localPath = null;
      let status = 'discord_indexed';
      if (mirrorMode) {
        status = 'indexed';
        try {
          const target = localPathFor(cfg.mediaRoot, item.id, item.filename, item.createdAt);
          await writeBuffer(target, file.buffer);
          localPath = target;
          status = 'mirrored';
        } catch {
          status = 'index_only';
        }
      }

      const row = indexAttachment(item, { localPath, status });
      // In discord mode this url 302-redirects to a fresh CDN link; in mirror
      // mode it streams the local file. Same route, mode-aware behaviour.
      const fileUrl = row?.id ? `/api/local-media/${row.id}/file` : null;
      res.status(201).json({
        ...item,
        dbId: row?.id,
        storageMode: cfg.storageMode,
        localPath,
        fileUrl,
        localFileUrl: fileUrl,
        status,
      });
    } catch (error) {
      res.status(error?.status || 500)
        .json({ error: error?.message || 'Failed to upload to Discord' });
    }
  });

  // --- Local processor -----------------------------------------------------
  app.get('/api/processor/health', async (_req, res) => {
    try {
      const health = await processorSvc.health();
      res.json({
        ok: true,
        service: 'admin-media-drive-processor',
        namespaceId: cfg.namespaceId,
        processedChannelConfigured: processedChannelConfigured(cfg),
        processedChannelId: cfg.discord.processedChannelId || null,
        defaultChannelId: cfg.discord.defaultChannelId || null,
        ...health,
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'processor_health_failed' });
    }
  });

  app.post('/api/processor/jobs', (req, res) => {
    try {
      const mediaItemId = req.body?.mediaItemId;
      const attachmentId = req.body?.attachmentId;
      if (!mediaItemId && !attachmentId) {
        return res.status(400).json({ error: 'mediaItemId_or_attachmentId_required' });
      }
      const job = processorSvc.enqueue({
        mediaItemId,
        attachmentId,
        options: req.body?.options,
      });
      return res.status(201).json({ job });
    } catch (error) {
      return sendProcessingError(res, error);
    }
  });

  app.get('/api/processor/jobs', (req, res) => {
    try {
      const jobs = index.listProcessingJobs({
        namespaceId: cfg.namespaceId,
        status: req.query.status ? String(req.query.status) : undefined,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({
        jobs,
        counts: index.countProcessingJobs(cfg.namespaceId),
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'processor_jobs_list_failed' });
    }
  });

  app.post('/api/processor/jobs/:id/run', async (req, res) => {
    if (!requireBot(res)) return;
    try {
      const job = await processorSvc.runJob(req.params.id);
      res.json({ job });
    } catch (error) {
      sendProcessingError(res, error);
    }
  });

  app.post('/api/processor/run-next', async (_req, res) => {
    if (!requireBot(res)) return;
    try {
      const job = await processorSvc.runNext();
      res.json({ job });
    } catch (error) {
      sendProcessingError(res, error);
    }
  });

  app.post('/api/processor/jobs/:id/retry', (req, res) => {
    try {
      const job = processorSvc.retryJob(req.params.id);
      res.json({ job });
    } catch (error) {
      sendProcessingError(res, error);
    }
  });

  // SPA fallback.
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return { app, svc, index };
}

export async function start() {
  const { app, svc } = createApp();
  const connected = await svc.connect();
  if (connected) {
    // Never log the token — only the resolved bot tag.
    console.log(`admin-media-drive bot ready as ${svc.user?.tag}`);
  } else if (svc.error) {
    console.warn(`admin-media-drive: Discord not ready — ${svc.error}`);
  }
  app.listen(config.port, config.host, () => {
    console.log(`admin-media-drive running at http://${config.host}:${config.port}`);
    console.log(`  media root: ${config.mediaRoot}`);
    console.log(`  db path:    ${config.dbPath}`);
  });
}

// Only auto-start when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  start();
}

export default createApp;
