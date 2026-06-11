#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_NAME = 'video-affiliate-db'
const DEFAULT_PAGE_ID = '1008898512617594'
const SOURCE = 'graph_page_export_csv'
const BATCH_SIZE = 50
const IMPORT_KEY_ENV = 'PAGE_POST_INVENTORY_IMPORT_KEY'
const WORKER_IMPORT_PATH = '/api/dashboard/page-post-inventory/import'
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS facebook_page_post_inventory (
    page_id TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL,
    post_id_tail TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    post_url TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    page_commented TEXT NOT NULL DEFAULT '',
    page_comment_id TEXT NOT NULL DEFAULT '',
    page_comment_link TEXT NOT NULL DEFAULT '',
    page_comment TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'graph_page_export_csv',
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (page_id, post_id)
);`
const DATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_fb_page_post_inventory_page_date_time
ON facebook_page_post_inventory(page_id, date, time);`
const TAIL_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_fb_page_post_inventory_page_tail
ON facebook_page_post_inventory(page_id, post_id_tail);`
const CSV_COLUMNS = [
  'date',
  'time',
  'post_id',
  'type',
  'post_url',
  'message',
  'page_commented',
  'page_comment_id',
  'page_comment_link',
  'page_comment',
]

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKDIR = path.resolve(SCRIPT_DIR, '..')

function usage() {
  return [
    'Usage:',
    '  node scripts/import-page-post-inventory.mjs --csv ./page-export.csv --dry-run',
    '  node scripts/import-page-post-inventory.mjs --csv ./page-export.csv --local',
    '  node scripts/import-page-post-inventory.mjs --csv ./page-export.csv --remote',
    '  node scripts/import-page-post-inventory.mjs --csv ./page-export.csv --worker-url https://api.example.com --import-key-file ./secret.txt',
    '',
    'Options:',
    '  --csv <path>       CSV with date,time,post_id,type,post_url,message,page_commented,page_comment_id,page_comment_link,page_comment',
    '  --page-id <id>     Facebook Page id (default 1008898512617594)',
    '  --dry-run         Parse and print counts only; do not call Wrangler',
    '  --local           Import into local D1 via Wrangler',
    '  --remote          Import into remote D1 via Wrangler',
    '  --worker-url <url> Runtime fallback: POST parsed batches to the Worker import endpoint',
    `  --import-key-file <path> Read ${IMPORT_KEY_ENV} from a local file for --worker-url mode`,
  ].join('\n')
}

function parseArgs(argv) {
  const args = {
    csv: '',
    pageId: DEFAULT_PAGE_ID,
    dryRun: false,
    local: false,
    remote: false,
    workerUrl: '',
    importKeyFile: '',
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const readValue = (name) => {
      const eq = arg.indexOf('=')
      if (eq >= 0) return arg.slice(eq + 1)
      const value = argv[++i]
      if (!value) throw new Error(`${name}_requires_value`)
      return value
    }
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--local') args.local = true
    else if (arg === '--remote') args.remote = true
    else if (arg === '--csv' || arg.startsWith('--csv=')) args.csv = readValue('csv')
    else if (arg === '--page-id' || arg.startsWith('--page-id=')) args.pageId = readValue('page_id')
    else if (arg === '--worker-url' || arg.startsWith('--worker-url=')) args.workerUrl = readValue('worker_url')
    else if (arg === '--import-key-file' || arg.startsWith('--import-key-file=')) args.importKeyFile = readValue('import_key_file')
    else throw new Error(`unknown_arg:${arg}`)
  }
  return args
}

function clean(value) {
  return String(value == null ? '' : value).trim()
}

function cleanHeader(value) {
  return clean(value).replace(/^\uFEFF/, '').toLowerCase()
}

function normalizeDate(value) {
  const raw = clean(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
}

function normalizePostId(rawPostId, pageId) {
  const raw = clean(rawPostId)
  if (!raw) return ''
  if (raw.includes('_')) return raw
  const page = clean(pageId)
  return page ? `${page}_${raw}` : raw
}

function derivePostIdTail(postId) {
  const value = clean(postId)
  if (!value) return ''
  const splitAt = value.lastIndexOf('_')
  return splitAt >= 0 ? value.slice(splitAt + 1).trim() : value
}

function parseCsvRecords(input) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  const pushRow = () => {
    const next = [...row, field]
    row = []
    field = ''
    if (next.some((cell) => clean(cell))) rows.push(next)
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      pushRow()
    } else if (ch === '\r') {
      if (input[i + 1] === '\n') i++
      pushRow()
    } else {
      field += ch
    }
  }
  if (field || row.length > 0) pushRow()
  return rows
}

function parseInventoryCsv(input, pageId) {
  const records = parseCsvRecords(input)
  if (!records.length) return { rows: [], inputRows: 0, validRows: 0, invalidRows: 0, duplicateKeys: 0 }

  const headers = records[0].map(cleanHeader)
  const missing = CSV_COLUMNS.filter((name) => !headers.includes(name))
  if (missing.length) {
    return { rows: [], inputRows: Math.max(0, records.length - 1), validRows: 0, invalidRows: Math.max(0, records.length - 1), duplicateKeys: 0 }
  }

  const rows = []
  const seen = new Set()
  let invalidRows = 0
  let duplicateKeys = 0

  for (let i = 1; i < records.length; i++) {
    const record = records[i]
    if (!record.some((cell) => clean(cell))) continue
    const raw = {}
    for (let col = 0; col < headers.length; col++) {
      if (CSV_COLUMNS.includes(headers[col])) raw[headers[col]] = record[col] ?? ''
    }
    const postId = normalizePostId(raw.post_id, pageId)
    const row = {
      page_id: clean(pageId),
      date: normalizeDate(raw.date),
      time: clean(raw.time),
      post_id: postId,
      post_id_tail: derivePostIdTail(postId),
      type: clean(raw.type),
      post_url: clean(raw.post_url),
      message: clean(raw.message),
      page_commented: clean(raw.page_commented),
      page_comment_id: clean(raw.page_comment_id),
      page_comment_link: clean(raw.page_comment_link),
      page_comment: clean(raw.page_comment),
      source: SOURCE,
    }
    if (!row.page_id || !row.date || !row.post_id || !row.post_id_tail) {
      invalidRows++
      continue
    }
    const key = `${row.page_id}:${row.post_id}`
    if (seen.has(key)) duplicateKeys++
    seen.add(key)
    rows.push(row)
  }

  return { rows, inputRows: rows.length + invalidRows, validRows: rows.length, invalidRows, duplicateKeys }
}

function sqlString(value) {
  return `'${String(value == null ? '' : value).replace(/\0/g, '').replace(/'/g, "''")}'`
}

function buildUpsertSql(rows) {
  const values = rows.map((row) => `(${[
    row.page_id,
    row.date,
    row.time,
    row.post_id,
    row.post_id_tail,
    row.type,
    row.post_url,
    row.message,
    row.page_commented,
    row.page_comment_id,
    row.page_comment_link,
    row.page_comment,
    row.source,
  ].map(sqlString).join(', ')}, datetime('now'), datetime('now'))`).join(',\n')

  return `INSERT INTO facebook_page_post_inventory (
    page_id, date, time, post_id, post_id_tail, type, post_url, message,
    page_commented, page_comment_id, page_comment_link, page_comment, source,
    imported_at, updated_at
) VALUES
${values}
ON CONFLICT(page_id, post_id) DO UPDATE SET
    date = excluded.date,
    time = excluded.time,
    post_id_tail = excluded.post_id_tail,
    type = excluded.type,
    post_url = excluded.post_url,
    message = excluded.message,
    page_commented = excluded.page_commented,
    page_comment_id = excluded.page_comment_id,
    page_comment_link = excluded.page_comment_link,
    page_comment = excluded.page_comment,
    source = excluded.source,
    updated_at = excluded.updated_at;
`
}

function buildEnsureSql() {
  return `${TABLE_SQL}\n${DATE_INDEX_SQL}\n${TAIL_INDEX_SQL}\n`
}

function runWranglerSql(sql, mode, batchIndex) {
  const tempPath = path.join(os.tmpdir(), `page-post-inventory-${Date.now()}-${process.pid}-${batchIndex}.sql`)
  try {
    fs.writeFileSync(tempPath, sql)
    execFileSync('npx', ['wrangler', 'd1', 'execute', DB_NAME, mode === 'remote' ? '--remote' : '--local', '--file', tempPath], {
      cwd: WORKDIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 'unknown'
    throw new Error(`wrangler_failed_batch_${batchIndex}_status_${status}`)
  } finally {
    try { fs.unlinkSync(tempPath) } catch {}
  }
}

function buildWorkerImportUrl(workerUrl) {
  const base = clean(workerUrl).replace(/\/+$/, '')
  return base ? `${base}${WORKER_IMPORT_PATH}` : ''
}

function readImportKey(args) {
  if (args.importKeyFile) {
    return clean(fs.readFileSync(path.resolve(args.importKeyFile), 'utf8'))
  }
  return clean(process.env[IMPORT_KEY_ENV])
}

async function postWorkerBatch(args, pageId, rows, batchIndex, importKey) {
  const url = buildWorkerImportUrl(args.workerUrl)
  if (!url) throw new Error('worker_url_required')
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Page-Inventory-Import-Key': importKey,
    },
    body: JSON.stringify({ page_id: pageId, rows }),
  })
  if (!response.ok) throw new Error(`worker_import_failed_batch_${batchIndex}_status_${response.status}`)
  const json = await response.json().catch(() => null)
  if (!json || json.ok !== true) throw new Error(`worker_import_failed_batch_${batchIndex}_status_${response.status}`)
  return {
    receivedRows: Number(json.received_rows || 0),
    upsertedRows: Number(json.upserted_rows || 0),
    invalidRows: Number(json.invalid_rows || 0),
  }
}

function printSummary(summary) {
  console.log(JSON.stringify(summary, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.csv) throw new Error('csv_required')
  const writeModeCount = [args.local, args.remote, Boolean(args.workerUrl)].filter(Boolean).length
  if (writeModeCount > 1) throw new Error('choose_only_one_of_remote_local_or_worker_url')
  if (!args.dryRun && writeModeCount === 0) throw new Error('choose_remote_local_worker_url_or_dry_run')

  const pageId = clean(args.pageId) || DEFAULT_PAGE_ID
  const input = fs.readFileSync(args.csv, 'utf8')
  const parsed = parseInventoryCsv(input, pageId)
  const batchCount = Math.ceil(parsed.rows.length / BATCH_SIZE)
  const mode = args.dryRun ? 'dry_run' : args.workerUrl ? 'worker_runtime' : args.remote ? 'remote' : 'local'

  if (args.dryRun) {
    printSummary({
      ok: true,
      dry_run: true,
      mode,
      page_id: pageId,
      source: SOURCE,
      input_rows: parsed.inputRows,
      valid_rows: parsed.validRows,
      invalid_rows: parsed.invalidRows,
      duplicate_keys: parsed.duplicateKeys,
      batches: batchCount,
      batch_size: BATCH_SIZE,
      upserted_rows: 0,
    })
    return
  }

  if (args.workerUrl) {
    const importKey = readImportKey(args)
    if (!importKey) throw new Error('import_key_required')
    let receivedRows = 0
    let upsertedRows = 0
    let runtimeInvalidRows = 0
    for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
      const batch = parsed.rows.slice(i, i + BATCH_SIZE)
      if (!batch.length) continue
      const result = await postWorkerBatch(args, pageId, batch, Math.floor(i / BATCH_SIZE) + 1, importKey)
      receivedRows += result.receivedRows
      upsertedRows += result.upsertedRows
      runtimeInvalidRows += result.invalidRows
    }
    printSummary({
      ok: true,
      dry_run: false,
      mode,
      page_id: pageId,
      source: SOURCE,
      input_rows: parsed.inputRows,
      valid_rows: parsed.validRows,
      invalid_rows: parsed.invalidRows + runtimeInvalidRows,
      duplicate_keys: parsed.duplicateKeys,
      batches: batchCount,
      batch_size: BATCH_SIZE,
      received_rows: receivedRows,
      upserted_rows: upsertedRows,
    })
    return
  }

  runWranglerSql(buildEnsureSql(), mode, 'ensure')
  for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
    const batch = parsed.rows.slice(i, i + BATCH_SIZE)
    if (batch.length) runWranglerSql(buildUpsertSql(batch), mode, Math.floor(i / BATCH_SIZE) + 1)
  }

  printSummary({
    ok: true,
    dry_run: false,
    mode,
    page_id: pageId,
    source: SOURCE,
    input_rows: parsed.inputRows,
    valid_rows: parsed.validRows,
    invalid_rows: parsed.invalidRows,
    duplicate_keys: parsed.duplicateKeys,
    batches: batchCount,
    batch_size: BATCH_SIZE,
    upserted_rows: parsed.validRows,
  })
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
})
