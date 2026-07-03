import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Open (and lazily initialise) the SQLite index at dbPath.
 * The parent directory is created if missing. Returns a small typed API rather
 * than the raw handle so callers never see SQL.
 */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS media_items (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace_id   TEXT NOT NULL DEFAULT 'admin',
      channel_id     TEXT NOT NULL,
      message_id     TEXT NOT NULL,
      attachment_id  TEXT NOT NULL,
      filename       TEXT,
      content_type   TEXT,
      size           INTEGER,
      local_path     TEXT,
      discord_url    TEXT,
      jump_url       TEXT,
      status         TEXT NOT NULL DEFAULT 'indexed',
      created_at     TEXT,
      updated_at     TEXT,
      UNIQUE (namespace_id, attachment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_items_channel
      ON media_items (namespace_id, channel_id);
    CREATE INDEX IF NOT EXISTS idx_media_items_created
      ON media_items (created_at DESC);

    CREATE TABLE IF NOT EXISTS processing_jobs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace_id          TEXT NOT NULL DEFAULT 'admin',
      source_media_item_id  INTEGER,
      source_attachment_id  TEXT,
      source_channel_id     TEXT,
      source_message_id     TEXT,
      status                TEXT NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'processing', 'processed', 'failed')),
      step                  TEXT,
      options_json          TEXT,
      temp_dir              TEXT,
      input_path            TEXT,
      output_path           TEXT,
      output_media_item_id  INTEGER,
      output_attachment_id  TEXT,
      output_channel_id     TEXT,
      output_message_id     TEXT,
      error                 TEXT,
      attempts              INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT,
      updated_at            TEXT,
      started_at            TEXT,
      finished_at           TEXT,
      FOREIGN KEY (source_media_item_id) REFERENCES media_items(id) ON DELETE SET NULL,
      FOREIGN KEY (output_media_item_id) REFERENCES media_items(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_status
      ON processing_jobs (namespace_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_processing_jobs_created
      ON processing_jobs (namespace_id, created_at DESC, id DESC);
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO media_items (
      namespace_id, channel_id, message_id, attachment_id,
      filename, content_type, size, local_path, discord_url, jump_url,
      status, created_at, updated_at
    ) VALUES (
      @namespace_id, @channel_id, @message_id, @attachment_id,
      @filename, @content_type, @size, @local_path, @discord_url, @jump_url,
      @status, @created_at, @updated_at
    )
    ON CONFLICT (namespace_id, attachment_id) DO UPDATE SET
      channel_id   = excluded.channel_id,
      message_id   = excluded.message_id,
      filename     = excluded.filename,
      content_type = excluded.content_type,
      size         = excluded.size,
      -- keep an existing local_path if the new row does not carry one
      local_path   = COALESCE(excluded.local_path, media_items.local_path),
      discord_url  = excluded.discord_url,
      jump_url     = excluded.jump_url,
      status       = excluded.status,
      created_at   = COALESCE(media_items.created_at, excluded.created_at),
      updated_at   = excluded.updated_at
    RETURNING *
  `);

  const getByIdStmt = db.prepare('SELECT * FROM media_items WHERE id = ?');
  const getByAttachmentStmt = db.prepare(
    'SELECT * FROM media_items WHERE namespace_id = ? AND attachment_id = ?',
  );
  const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM media_items');
  const countByNamespaceStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM media_items WHERE namespace_id = ?',
  );
  const createJobStmt = db.prepare(`
    INSERT INTO processing_jobs (
      namespace_id, source_media_item_id, source_attachment_id,
      source_channel_id, source_message_id, status, step, options_json,
      temp_dir, input_path, output_path, error, attempts,
      created_at, updated_at
    ) VALUES (
      @namespace_id, @source_media_item_id, @source_attachment_id,
      @source_channel_id, @source_message_id, 'queued', 'queued', @options_json,
      NULL, NULL, NULL, NULL, 0,
      @created_at, @updated_at
    )
    RETURNING *
  `);
  const getJobStmt = db.prepare('SELECT * FROM processing_jobs WHERE id = ?');
  const nextQueuedJobStmt = db.prepare(`
    SELECT * FROM processing_jobs
    WHERE namespace_id = ? AND status = 'queued'
    ORDER BY datetime(created_at) ASC, id ASC
    LIMIT 1
  `);
  const countJobsByStatusStmt = db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM processing_jobs
    WHERE namespace_id = ?
    GROUP BY status
  `);
  const startJobStmt = db.prepare(`
    UPDATE processing_jobs SET
      status = 'processing',
      step = @step,
      temp_dir = @temp_dir,
      input_path = @input_path,
      output_path = @output_path,
      error = NULL,
      attempts = attempts + 1,
      started_at = COALESCE(started_at, @now),
      finished_at = NULL,
      updated_at = @now
    WHERE id = @id
    RETURNING *
  `);
  const updateJobStepStmt = db.prepare(`
    UPDATE processing_jobs SET
      step = @step,
      temp_dir = COALESCE(@temp_dir, temp_dir),
      input_path = COALESCE(@input_path, input_path),
      output_path = COALESCE(@output_path, output_path),
      updated_at = @now
    WHERE id = @id
    RETURNING *
  `);
  const completeJobStmt = db.prepare(`
    UPDATE processing_jobs SET
      status = 'processed',
      step = @step,
      output_media_item_id = @output_media_item_id,
      output_attachment_id = @output_attachment_id,
      output_channel_id = @output_channel_id,
      output_message_id = @output_message_id,
      error = NULL,
      finished_at = @now,
      updated_at = @now
    WHERE id = @id
    RETURNING *
  `);
  const failJobStmt = db.prepare(`
    UPDATE processing_jobs SET
      status = 'failed',
      step = @step,
      error = @error,
      finished_at = @now,
      updated_at = @now
    WHERE id = @id
    RETURNING *
  `);
  const retryJobStmt = db.prepare(`
    UPDATE processing_jobs SET
      status = 'queued',
      step = 'queued',
      error = NULL,
      started_at = NULL,
      finished_at = NULL,
      updated_at = @now
    WHERE id = @id AND status = 'failed'
    RETURNING *
  `);

  function nowIso() {
    return new Date().toISOString();
  }

  return {
    raw: db,

    upsert(row) {
      const now = nowIso();
      return upsertStmt.get({
        namespace_id: row.namespace_id,
        channel_id: row.channel_id,
        message_id: row.message_id,
        attachment_id: row.attachment_id,
        filename: row.filename ?? null,
        content_type: row.content_type ?? null,
        size: row.size ?? null,
        local_path: row.local_path ?? null,
        discord_url: row.discord_url ?? null,
        jump_url: row.jump_url ?? null,
        status: row.status ?? 'indexed',
        created_at: row.created_at ?? now,
        updated_at: now,
      });
    },

    getById(id) {
      return getByIdStmt.get(Number(id));
    },

    getByAttachment(namespaceId, attachmentId) {
      return getByAttachmentStmt.get(namespaceId, attachmentId);
    },

    // Total indexed media rows. Pass a namespaceId to scope the count.
    // Safe on a freshly-initialised (empty) DB: returns 0.
    count(namespaceId) {
      const row = namespaceId
        ? countByNamespaceStmt.get(namespaceId)
        : countAllStmt.get();
      return row?.n ?? 0;
    },

    list({ namespaceId, channelId, status, limit = 100, offset = 0 } = {}) {
      const clauses = ['namespace_id = @namespace_id'];
      const params = {
        namespace_id: namespaceId,
        limit: Math.min(Math.max(Number(limit) || 100, 1), 500),
        offset: Math.max(Number(offset) || 0, 0),
      };
      if (channelId) {
        clauses.push('channel_id = @channel_id');
        params.channel_id = channelId;
      }
      if (status) {
        clauses.push('status = @status');
        params.status = status;
      }
      const sql = `
        SELECT * FROM media_items
        WHERE ${clauses.join(' AND ')}
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT @limit OFFSET @offset
      `;
      return db.prepare(sql).all(params);
    },

    createProcessingJob({
      namespaceId,
      sourceMediaItemId = null,
      sourceAttachmentId = null,
      sourceChannelId = null,
      sourceMessageId = null,
      options = {},
    }) {
      const now = nowIso();
      return createJobStmt.get({
        namespace_id: namespaceId,
        source_media_item_id: sourceMediaItemId,
        source_attachment_id: sourceAttachmentId,
        source_channel_id: sourceChannelId,
        source_message_id: sourceMessageId,
        options_json: JSON.stringify(options ?? {}),
        created_at: now,
        updated_at: now,
      });
    },

    getProcessingJob(id) {
      return getJobStmt.get(Number(id));
    },

    getNextQueuedProcessingJob(namespaceId) {
      return nextQueuedJobStmt.get(namespaceId);
    },

    countProcessingJobs(namespaceId) {
      const counts = {
        queued: 0,
        processing: 0,
        processed: 0,
        failed: 0,
      };
      for (const row of countJobsByStatusStmt.all(namespaceId)) {
        counts[row.status] = row.n;
      }
      return counts;
    },

    listProcessingJobs({
      namespaceId,
      status,
      limit = 50,
      offset = 0,
    } = {}) {
      const clauses = ['namespace_id = @namespace_id'];
      const params = {
        namespace_id: namespaceId,
        limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
        offset: Math.max(Number(offset) || 0, 0),
      };
      if (status) {
        clauses.push('status = @status');
        params.status = status;
      }
      const sql = `
        SELECT * FROM processing_jobs
        WHERE ${clauses.join(' AND ')}
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT @limit OFFSET @offset
      `;
      return db.prepare(sql).all(params);
    },

    markProcessingJobStarted(id, {
      step = 'processing',
      tempDir = null,
      inputPath = null,
      outputPath = null,
    } = {}) {
      return startJobStmt.get({
        id: Number(id),
        step,
        temp_dir: tempDir,
        input_path: inputPath,
        output_path: outputPath,
        now: nowIso(),
      });
    },

    updateProcessingJobStep(id, {
      step,
      tempDir = null,
      inputPath = null,
      outputPath = null,
    }) {
      return updateJobStepStmt.get({
        id: Number(id),
        step,
        temp_dir: tempDir,
        input_path: inputPath,
        output_path: outputPath,
        now: nowIso(),
      });
    },

    markProcessingJobProcessed(id, {
      step = 'uploaded',
      outputMediaItemId = null,
      outputAttachmentId = null,
      outputChannelId = null,
      outputMessageId = null,
    } = {}) {
      return completeJobStmt.get({
        id: Number(id),
        step,
        output_media_item_id: outputMediaItemId,
        output_attachment_id: outputAttachmentId,
        output_channel_id: outputChannelId,
        output_message_id: outputMessageId,
        now: nowIso(),
      });
    },

    markProcessingJobFailed(id, { step = 'failed', error }) {
      return failJobStmt.get({
        id: Number(id),
        step,
        error: String(error || 'processing_failed').slice(0, 2000),
        now: nowIso(),
      });
    },

    retryProcessingJob(id) {
      return retryJobStmt.get({
        id: Number(id),
        now: nowIso(),
      });
    },

    close() {
      db.close();
    },
  };
}

export default openDb;
