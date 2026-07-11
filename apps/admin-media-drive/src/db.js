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

    CREATE TABLE IF NOT EXISTS media_submissions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace_id   TEXT NOT NULL DEFAULT 'admin',
      idempotency_key TEXT,
      source_sha256  TEXT NOT NULL,
      media_item_id  INTEGER,
      job_id         INTEGER,
      original_name  TEXT,
      size           INTEGER,
      created_at     TEXT,
      updated_at     TEXT,
      UNIQUE (namespace_id, idempotency_key),
      UNIQUE (namespace_id, source_sha256),
      FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON DELETE SET NULL,
      FOREIGN KEY (job_id) REFERENCES processing_jobs(id) ON DELETE SET NULL
    );
  `);

  // Additive migrations for databases created before these columns existed.
  // SQLite has no ADD COLUMN IF NOT EXISTS, so guard with pragma table_info.
  function ensureColumn(table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }
  ensureColumn('media_items', 'source_sha256', 'source_sha256 TEXT');
  ensureColumn('processing_jobs', 'error_category', 'error_category TEXT');
  ensureColumn('processing_jobs', 'subtitles_required', 'subtitles_required INTEGER');
  ensureColumn('processing_jobs', 'subtitles_verified', 'subtitles_verified INTEGER');
  ensureColumn('processing_jobs', 'audio_changed', 'audio_changed INTEGER');
  ensureColumn('processing_jobs', 'subtitle_verification_json', 'subtitle_verification_json TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_items_sha
      ON media_items (namespace_id, source_sha256);
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO media_items (
      namespace_id, channel_id, message_id, attachment_id,
      filename, content_type, size, local_path, discord_url, jump_url,
      status, source_sha256, created_at, updated_at
    ) VALUES (
      @namespace_id, @channel_id, @message_id, @attachment_id,
      @filename, @content_type, @size, @local_path, @discord_url, @jump_url,
      @status, @source_sha256, @created_at, @updated_at
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
      -- keep an existing content hash if the new row does not carry one
      source_sha256 = COALESCE(excluded.source_sha256, media_items.source_sha256),
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
      error_category = NULL,
      attempts = attempts + 1,
      started_at = COALESCE(started_at, @now),
      finished_at = NULL,
      updated_at = @now
    WHERE id = @id AND status IN ('queued', 'failed')
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
      error_category = @error_category,
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
      error_category = NULL,
      started_at = NULL,
      finished_at = NULL,
      updated_at = @now
    WHERE id = @id AND status = 'failed'
    RETURNING *
  `);
  const verificationJobStmt = db.prepare(`
    UPDATE processing_jobs SET
      subtitles_required = @subtitles_required,
      subtitles_verified = @subtitles_verified,
      audio_changed = @audio_changed,
      subtitle_verification_json = @subtitle_verification_json,
      updated_at = @now
    WHERE id = @id
    RETURNING *
  `);
  const staleJobsStmt = db.prepare(`
    UPDATE processing_jobs SET
      status = 'queued',
      step = 'requeued_stale',
      updated_at = @now
    WHERE namespace_id = @namespace_id
      AND status = 'processing'
      AND updated_at < @cutoff
    RETURNING id
  `);
  const latestJobForItemStmt = db.prepare(`
    SELECT * FROM processing_jobs
    WHERE namespace_id = ? AND source_media_item_id = ?
    ORDER BY id DESC
    LIMIT 1
  `);
  const mediaItemByShaStmt = db.prepare(`
    SELECT * FROM media_items
    WHERE namespace_id = ? AND source_sha256 = ?
    ORDER BY id ASC
    LIMIT 1
  `);
  const submissionByKeyStmt = db.prepare(`
    SELECT * FROM media_submissions
    WHERE namespace_id = ? AND idempotency_key = ?
  `);
  const submissionByShaStmt = db.prepare(`
    SELECT * FROM media_submissions
    WHERE namespace_id = ? AND source_sha256 = ?
  `);
  const createSubmissionStmt = db.prepare(`
    INSERT INTO media_submissions (
      namespace_id, idempotency_key, source_sha256, media_item_id, job_id,
      original_name, size, created_at, updated_at
    ) VALUES (
      @namespace_id, @idempotency_key, @source_sha256, @media_item_id, @job_id,
      @original_name, @size, @created_at, @updated_at
    )
    RETURNING *
  `);
  const updateSubmissionJobStmt = db.prepare(`
    UPDATE media_submissions SET
      job_id = @job_id,
      updated_at = @now
    WHERE id = @id
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
        source_sha256: row.source_sha256 ?? null,
        created_at: row.created_at ?? now,
        updated_at: now,
      });
    },

    getBySourceSha256(namespaceId, sourceSha256) {
      return mediaItemByShaStmt.get(namespaceId, sourceSha256);
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

    markProcessingJobFailed(id, { step = 'failed', error, errorCategory = null }) {
      const message = String(error || 'processing_failed').slice(0, 2000);
      // A category must stay machine-readable; fall back to the message when
      // it already looks like a sanitized snake_case category.
      const category = errorCategory
        || (/^[a-z0-9_]{1,64}$/.test(message) ? message : 'processing_failed');
      return failJobStmt.get({
        id: Number(id),
        step,
        error: message,
        error_category: category,
        now: nowIso(),
      });
    },

    retryProcessingJob(id) {
      return retryJobStmt.get({
        id: Number(id),
        now: nowIso(),
      });
    },

    updateProcessingJobVerification(id, {
      subtitlesRequired = null,
      subtitlesVerified = null,
      audioChanged = null,
      verificationJson = null,
    } = {}) {
      const asFlag = (v) => (v === null || v === undefined ? null : (v ? 1 : 0));
      return verificationJobStmt.get({
        id: Number(id),
        subtitles_required: asFlag(subtitlesRequired),
        subtitles_verified: asFlag(subtitlesVerified),
        audio_changed: asFlag(audioChanged),
        subtitle_verification_json: verificationJson,
        now: nowIso(),
      });
    },

    // Re-queue jobs stuck in 'processing' (e.g. a crashed worker). Returns the
    // number of recovered rows. `olderThanMs` guards against re-queuing a job
    // that is still legitimately running in another process.
    recoverStaleProcessingJobs(namespaceId, { olderThanMs = 2 * 60 * 60_000 } = {}) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      return staleJobsStmt.all({
        namespace_id: namespaceId,
        cutoff,
        now: nowIso(),
      }).length;
    },

    getLatestProcessingJobForMediaItem(namespaceId, mediaItemId) {
      return latestJobForItemStmt.get(namespaceId, Number(mediaItemId));
    },

    findSubmissionByKey(namespaceId, idempotencyKey) {
      return submissionByKeyStmt.get(namespaceId, idempotencyKey);
    },

    findSubmissionBySha(namespaceId, sourceSha256) {
      return submissionByShaStmt.get(namespaceId, sourceSha256);
    },

    createSubmission({
      namespaceId,
      idempotencyKey = null,
      sourceSha256,
      mediaItemId = null,
      jobId = null,
      originalName = null,
      size = null,
    }) {
      const now = nowIso();
      return createSubmissionStmt.get({
        namespace_id: namespaceId,
        idempotency_key: idempotencyKey,
        source_sha256: sourceSha256,
        media_item_id: mediaItemId,
        job_id: jobId,
        original_name: originalName,
        size,
        created_at: now,
        updated_at: now,
      });
    },

    updateSubmissionJob(id, jobId) {
      return updateSubmissionJobStmt.get({
        id: Number(id),
        job_id: jobId === null || jobId === undefined ? null : Number(jobId),
        now: nowIso(),
      });
    },

    close() {
      db.close();
    },
  };
}

export default openDb;
