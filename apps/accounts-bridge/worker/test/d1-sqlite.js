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
const MIGRATION = path.join(here, '..', 'migrations', '0001_init.sql');

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
    this.db.exec(fs.readFileSync(MIGRATION, 'utf8'));
  }

  prepare(sql) {
    return new Prepared(this.db, sql);
  }
}

// Build an `env`-like object with a fresh in-memory D1 each call.
export function makeEnv(overrides = {}) {
  return { DB: new D1Sqlite(), ACCOUNTS_BRIDGE_API_KEY: 'test-bridge-key-AAAA', ...overrides };
}
