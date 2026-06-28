// A minimal D1-compatible adapter over node:sqlite, used ONLY by the test suite.
//
// It runs the REAL migration SQL and the REAL store queries against an in-process SQLite engine, so
// the schema and every prepared statement are exercised for real — not mocked. The shape mirrors the
// slice of the Cloudflare D1 API that AccountsStore uses: prepare(sql).bind(...).first()/all()/run().

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, '..', 'migrations');

// Apply EVERY migration in lexical order (0001_init.sql, 0002_profile_archives.sql, ...) so the test
// DB matches what `wrangler d1 migrations apply` produces in production.
function allMigrationsSql() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

class Prepared {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...args) {
    return new Prepared(this.db, this.sql, args);
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row == null ? null : row;
  }

  async all() {
    const results = this.db.prepare(this.sql).all(...this.params);
    return { results, success: true };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}

export class D1Sqlite {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(allMigrationsSql());
  }

  prepare(sql) {
    return new Prepared(this.db, sql);
  }
}

// Minimal in-memory R2 shim mirroring the slice of the Cloudflare R2 API the store uses:
// put(key, bytes, opts) / get(key) -> { body, arrayBuffer(), size, customMetadata } / head(key).
export class R2Memory {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, opts = {}) {
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
    this.objects.set(key, { bytes, customMetadata: opts.customMetadata || {}, httpMetadata: opts.httpMetadata || {} });
    return { key, size: bytes.byteLength };
  }

  async get(key) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return {
      key,
      size: obj.bytes.byteLength,
      body: obj.bytes,
      customMetadata: obj.customMetadata,
      httpMetadata: obj.httpMetadata,
      arrayBuffer: async () => obj.bytes.buffer.slice(obj.bytes.byteOffset, obj.bytes.byteOffset + obj.bytes.byteLength)
    };
  }

  async head(key) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return { key, size: obj.bytes.byteLength, customMetadata: obj.customMetadata };
  }
}

// Build an `env`-like object with a fresh in-memory D1 + R2 each call.
export function makeEnv(overrides = {}) {
  return { DB: new D1Sqlite(), PROFILE_ARCHIVES: new R2Memory(), ACCOUNTS_BRIDGE_API_KEY: 'test-bridge-key-AAAA', ...overrides };
}
