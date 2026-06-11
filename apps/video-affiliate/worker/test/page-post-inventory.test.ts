import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    DEFAULT_PAGE_POST_INVENTORY_PAGE_ID,
    PAGE_POST_INVENTORY_CSV_COLUMNS,
    PAGE_POST_INVENTORY_DATE_INDEX_SQL,
    PAGE_POST_INVENTORY_RUNTIME_IMPORT_MAX_ROWS,
    PAGE_POST_INVENTORY_SOURCE,
    PAGE_POST_INVENTORY_TABLE_SQL,
    PAGE_POST_INVENTORY_TAIL_INDEX_SQL,
    derivePageStoryPostIdTail,
    normalizePagePostInventoryDate,
    normalizePagePostInventoryImportRow,
    normalizePagePostInventoryLimit,
    normalizePagePostInventoryOffset,
    normalizePageStoryPostId,
    parsePagePostInventoryCsv,
} from '../src/page-post-inventory.js'

function getPagePostInventoryRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.get('/api/dashboard/page-post-inventory'")
    assert.notEqual(start, -1, 'GET /api/dashboard/page-post-inventory route must exist')
    const end = source.indexOf("\napp.post('/api/dashboard/page-post-inventory/import'", start)
    assert.notEqual(end, -1, 'page-post-inventory route end marker must exist')
    return source.slice(start, end)
}

function getPagePostInventoryImportRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.post('/api/dashboard/page-post-inventory/import'")
    assert.notEqual(start, -1, 'POST /api/dashboard/page-post-inventory/import route must exist')
    const end = source.indexOf('\n// READ-ONLY audit of the comment/affiliate-link registry', start)
    assert.notEqual(end, -1, 'page-post-inventory import route end marker must exist')
    return source.slice(start, end)
}

function getPagePostInventoryImportScriptSource(): string {
    return readFileSync('scripts/import-page-post-inventory.mjs', 'utf8')
}

test('page post inventory SQL stores full page-story id with page/post uniqueness', () => {
    assert.match(PAGE_POST_INVENTORY_TABLE_SQL, /CREATE TABLE IF NOT EXISTS facebook_page_post_inventory/)
    assert.match(PAGE_POST_INVENTORY_TABLE_SQL, /page_id TEXT NOT NULL/)
    assert.match(PAGE_POST_INVENTORY_TABLE_SQL, /date TEXT NOT NULL/)
    assert.match(PAGE_POST_INVENTORY_TABLE_SQL, /post_id TEXT NOT NULL/)
    assert.match(PAGE_POST_INVENTORY_TABLE_SQL, /post_id_tail TEXT NOT NULL DEFAULT ''/)
    assert.match(PAGE_POST_INVENTORY_TABLE_SQL, /page_comment_id TEXT NOT NULL DEFAULT ''/)
    assert.match(PAGE_POST_INVENTORY_TABLE_SQL, /source TEXT NOT NULL DEFAULT 'graph_page_export_csv'/)
    assert.match(PAGE_POST_INVENTORY_TABLE_SQL, /PRIMARY KEY \(page_id, post_id\)/)
    assert.match(PAGE_POST_INVENTORY_DATE_INDEX_SQL, /page_id, date, time/)
    assert.match(PAGE_POST_INVENTORY_TAIL_INDEX_SQL, /page_id, post_id_tail/)
})

test('page post inventory CSV parser handles quoted commas, quotes and newlines', () => {
    const csv = [
        PAGE_POST_INVENTORY_CSV_COLUMNS.join(','),
        [
            '2026-05-16',
            '09:30',
            '1008898512617594_1277041784600517',
            'reel',
            'https://www.facebook.com/reel/1277041784600517',
            '"caption, with ""quoted"" text\nsecond line"',
            'yes',
            '1008898512617594_1277041784600517_555',
            'https://s.shopee.co.th/abc',
            '"cart link https://s.shopee.co.th/abc"',
        ].join(','),
    ].join('\n')

    const parsed = parsePagePostInventoryCsv(csv)
    assert.equal(parsed.input_rows, 1)
    assert.equal(parsed.valid_rows, 1)
    assert.equal(parsed.invalid_rows, 0)
    assert.equal(parsed.rows[0].page_id, DEFAULT_PAGE_POST_INVENTORY_PAGE_ID)
    assert.equal(parsed.rows[0].post_id, '1008898512617594_1277041784600517')
    assert.equal(parsed.rows[0].post_id_tail, '1277041784600517')
    assert.equal(parsed.rows[0].message, 'caption, with "quoted" text\nsecond line')
    assert.equal(parsed.rows[0].page_comment, 'cart link https://s.shopee.co.th/abc')
    assert.equal(parsed.rows[0].source, PAGE_POST_INVENTORY_SOURCE)
})

test('page post inventory normalization preserves full story id invariant', () => {
    assert.equal(
        normalizePageStoryPostId('1277041784600517', DEFAULT_PAGE_POST_INVENTORY_PAGE_ID),
        '1008898512617594_1277041784600517',
    )
    assert.equal(
        normalizePageStoryPostId('1008898512617594_1277041784600517', DEFAULT_PAGE_POST_INVENTORY_PAGE_ID),
        '1008898512617594_1277041784600517',
    )
    assert.equal(derivePageStoryPostIdTail('1008898512617594_1277041784600517'), '1277041784600517')
    assert.equal(derivePageStoryPostIdTail('1277041784600517'), '1277041784600517')
})

test('page post inventory runtime import normalizer accepts inventory-shaped rows', () => {
    const normalized = normalizePagePostInventoryImportRow({
        page_id: DEFAULT_PAGE_POST_INVENTORY_PAGE_ID,
        date: '2026-05-16',
        time: '09:30',
        post_id: '1277041784600517',
        post_id_tail: 'ignored',
        type: 'reel',
        post_url: 'https://www.facebook.com/reel/1277041784600517',
        message: 'caption text',
        page_commented: 'yes',
        page_comment_id: '1008898512617594_1277041784600517_555',
        page_comment_link: 'https://s.shopee.co.th/abc',
        page_comment: 'comment text',
        source: 'ignored',
    })

    assert.ok(normalized)
    assert.equal(normalized.page_id, DEFAULT_PAGE_POST_INVENTORY_PAGE_ID)
    assert.equal(normalized.post_id, '1008898512617594_1277041784600517')
    assert.equal(normalized.post_id_tail, '1277041784600517')
    assert.equal(normalized.source, PAGE_POST_INVENTORY_SOURCE)
})

test('page post inventory parser skips invalid rows and counts duplicate keys', () => {
    const csv = [
        PAGE_POST_INVENTORY_CSV_COLUMNS.join(','),
        'bad-date,09:30,1008898512617594_1,reel,,,,,,',
        '2026-05-16,09:31,1008898512617594_2,reel,,,,,,',
        '2026-05-16,09:32,1008898512617594_2,reel,,,,,,',
    ].join('\n')
    const parsed = parsePagePostInventoryCsv(csv)
    assert.equal(parsed.input_rows, 3)
    assert.equal(parsed.valid_rows, 2)
    assert.equal(parsed.invalid_rows, 1)
    assert.equal(parsed.duplicate_keys, 1)
    assert.equal(parsed.errors[0].reason, 'invalid_date_or_post_id')
})

test('page post inventory date, limit and offset are bounded', () => {
    assert.equal(normalizePagePostInventoryDate('2026-05-16'), '2026-05-16')
    assert.equal(normalizePagePostInventoryDate('2026-5-16'), '')
    assert.equal(normalizePagePostInventoryLimit(undefined), 100)
    assert.equal(normalizePagePostInventoryLimit('0'), 1)
    assert.equal(normalizePagePostInventoryLimit('99999'), 500)
    assert.equal(normalizePagePostInventoryOffset('-5'), 0)
    assert.equal(normalizePagePostInventoryOffset('99999'), 10000)
})

test('page post inventory route is bounded read-only D1 inventory query', () => {
    const routeSource = getPagePostInventoryRouteSource()

    assert.match(routeSource, /app\.get\('\/api\/dashboard\/page-post-inventory'/)
    assert.match(routeSource, /DEFAULT_PAGE_POST_INVENTORY_PAGE_ID/)
    assert.match(routeSource, /normalizePagePostInventoryDate\(rawDate\)/)
    assert.match(routeSource, /normalizePagePostInventoryLimit\(c\.req\.query\('limit'\)\)/)
    assert.match(routeSource, /normalizePagePostInventoryOffset\(c\.req\.query\('offset'\)\)/)
    assert.match(routeSource, /ensurePagePostInventoryTable\(c\.env\.DB\)/)
    assert.match(routeSource, /FROM facebook_page_post_inventory/)
    assert.match(routeSource, /LIMIT \? OFFSET \?/)
    assert.match(routeSource, /\.bind\(\.\.\.binds, limit, offset\)/)
    assert.match(routeSource, /page_commented_yes/)
    assert.match(routeSource, /page_comment_id_present/)
    assert.match(routeSource, /shopee_link_present/)
    assert.match(routeSource, /rows,\s*\n\s*items: rows/)
    assert.doesNotMatch(routeSource, /fetch\s*\(/, 'inventory route must not call Graph or any network fetch')
    assert.doesNotMatch(routeSource, /INSERT\s+INTO/i, 'inventory GET route must not INSERT')
    assert.doesNotMatch(routeSource, /\bUPDATE\s+\w/i, 'inventory GET route must not UPDATE')
    assert.doesNotMatch(routeSource, /DELETE\s+FROM/i, 'inventory GET route must not DELETE')
    assert.doesNotMatch(routeSource, /https:\/\/graph\.facebook\.com/i, 'inventory route must not read Graph')
})

test('page post inventory import endpoint is secret-protected and count-only', () => {
    const routeSource = getPagePostInventoryImportRouteSource()

    assert.match(routeSource, /app\.post\('\/api\/dashboard\/page-post-inventory\/import'/)
    assert.match(routeSource, /PAGE_POST_INVENTORY_IMPORT_KEY/)
    assert.match(routeSource, /X-Page-Inventory-Import-Key/)
    assert.match(routeSource, /providedSecret !== configuredSecret/)
    assert.match(routeSource, /return c\.json\(\{ ok: false, error: 'forbidden' \}, 403/)
    assert.match(routeSource, /PAGE_POST_INVENTORY_RUNTIME_IMPORT_MAX_ROWS/)
    assert.match(routeSource, /ensurePagePostInventoryTable\(c\.env\.DB\)/)
    assert.match(routeSource, /normalizePagePostInventoryImportRow/)
    assert.match(routeSource, /INSERT INTO facebook_page_post_inventory/)
    assert.match(routeSource, /ON CONFLICT\(page_id, post_id\) DO UPDATE SET/)
    assert.match(routeSource, /c\.env\.DB\.batch\(statements\)/)
    assert.match(routeSource, /mode: 'worker_runtime_import'/)
    assert.match(routeSource, /received_rows: receivedRows/)
    assert.match(routeSource, /upserted_rows: upsertedRows/)
    assert.match(routeSource, /invalid_rows: invalidRows/)
    assert.match(routeSource, /source: PAGE_POST_INVENTORY_SOURCE/)
    assert.doesNotMatch(routeSource, /fetch\s*\(/, 'inventory import route must not call Graph or any network fetch')
    assert.doesNotMatch(routeSource, /https:\/\/graph\.facebook\.com/i, 'inventory import route must not read Graph')
    assert.doesNotMatch(routeSource, /\bfacebook\.com\/v\d+\.\d+\b/i, 'inventory import route must not build Graph URLs')
    assert.doesNotMatch(routeSource, /items:\s*rows|rows:\s*rows/, 'inventory import response must not echo row content')
    assert.equal(PAGE_POST_INVENTORY_RUNTIME_IMPORT_MAX_ROWS, 100)
})

test('page post inventory import script supports Worker runtime fallback without printing rows', () => {
    const scriptSource = getPagePostInventoryImportScriptSource()

    assert.match(scriptSource, /--worker-url <url>/)
    assert.match(scriptSource, /--import-key-file <path>/)
    assert.match(scriptSource, /PAGE_POST_INVENTORY_IMPORT_KEY/)
    assert.match(scriptSource, /X-Page-Inventory-Import-Key/)
    assert.match(scriptSource, /\/api\/dashboard\/page-post-inventory\/import/)
    assert.match(scriptSource, /process\.env\[IMPORT_KEY_ENV\]/)
    assert.match(scriptSource, /fetch\(url/)
    assert.match(scriptSource, /mode = args\.dryRun \? 'dry_run' : args\.workerUrl \? 'worker_runtime'/)
    assert.match(scriptSource, /received_rows: receivedRows/)
    assert.match(scriptSource, /upserted_rows: upsertedRows/)
    assert.doesNotMatch(scriptSource, /console\.log\([^\n)]*rows/, 'script must print summary counts, not row payloads')
    assert.doesNotMatch(scriptSource, /console\.log\([^\n)]*message/, 'script must not print message text')
    assert.doesNotMatch(scriptSource, /console\.log\([^\n)]*page_comment/, 'script must not print comment text')
})
