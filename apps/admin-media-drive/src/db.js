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

    close() {
      db.close();
    },
  };
}

export default openDb;
