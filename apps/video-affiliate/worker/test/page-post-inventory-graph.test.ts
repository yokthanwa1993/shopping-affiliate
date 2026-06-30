import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    DEFAULT_PAGE_POST_INVENTORY_PAGE_ID,
    PAGE_POST_INVENTORY_GRAPH_DEFAULT_MAX_PAGES,
    PAGE_POST_INVENTORY_GRAPH_MAX_PAGES,
    PAGE_POST_INVENTORY_GRAPH_SOURCE,
    PAGE_POST_INVENTORY_SYNC_STATE_TABLE_SQL,
    type PagePostInventoryGraphBatch,
    type PagePostInventoryRow,
    crawlPagePostInventoryFromGraph,
    extractPagePostInventoryGraphCursor,
    normalizePagePostInventoryGraphMaxPages,
    normalizePagePostInventoryGraphPost,
    splitGraphCreatedTime,
} from '../src/page-post-inventory.js'

const PAGE_ID = DEFAULT_PAGE_POST_INVENTORY_PAGE_ID

function graphPost(tail: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: `${PAGE_ID}_${tail}`,
        message: `caption ${tail}`,
        permalink_url: `https://www.facebook.com/reel/${tail}`,
        created_time: '2026-05-16T09:30:00+0000',
        ...overrides,
    }
}

function getGraphSyncRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.post('/api/dashboard/page-post-inventory/graph-sync'")
    assert.notEqual(start, -1, 'POST /api/dashboard/page-post-inventory/graph-sync route must exist')
    const end = source.indexOf("app.get('/api/dashboard/page-post-inventory/graph-sync/status'", start)
    assert.notEqual(end, -1, 'graph-sync route end marker must exist')
    return source.slice(start, end)
}

function getGraphUpsertSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function upsertPagePostInventoryGraphRows')
    assert.notEqual(start, -1, 'upsertPagePostInventoryGraphRows must exist')
    const end = source.indexOf('\napp.post', start)
    assert.notEqual(end, -1, 'upsert function end marker must exist')
    return source.slice(start, end)
}

test('graph cursor prefers cursors.after but only when paging.next exists', () => {
    assert.equal(
        extractPagePostInventoryGraphCursor({ next: 'https://graph.facebook.com/x?after=URLCUR', cursors: { after: 'CUR1' } }),
        'CUR1',
    )
    // No cursors.after → fall back to the after param embedded in paging.next.
    assert.equal(
        extractPagePostInventoryGraphCursor({ next: 'https://graph.facebook.com/x?after=URLCUR&access_token=z' }),
        'URLCUR',
    )
    // No paging.next → exhausted, even though cursors.after is still echoed.
    assert.equal(extractPagePostInventoryGraphCursor({ cursors: { after: 'CUR_LAST' } }), '')
    assert.equal(extractPagePostInventoryGraphCursor(null), '')
    assert.equal(extractPagePostInventoryGraphCursor(undefined), '')
})

test('graph max-pages normalizer is clamped to safe bounds', () => {
    assert.equal(normalizePagePostInventoryGraphMaxPages(undefined), PAGE_POST_INVENTORY_GRAPH_DEFAULT_MAX_PAGES)
    assert.equal(normalizePagePostInventoryGraphMaxPages(0), 1)
    assert.equal(normalizePagePostInventoryGraphMaxPages(-10), 1)
    assert.equal(normalizePagePostInventoryGraphMaxPages(9999), PAGE_POST_INVENTORY_GRAPH_MAX_PAGES)
    assert.equal(normalizePagePostInventoryGraphMaxPages(3), 3)
})

test('graph created_time splits into bounded date and time columns', () => {
    assert.deepEqual(splitGraphCreatedTime('2026-05-16T09:30:00+0000'), { date: '2026-05-16', time: '09:30' })
    assert.deepEqual(splitGraphCreatedTime('not-a-date'), { date: '', time: '' })
    assert.deepEqual(splitGraphCreatedTime(undefined), { date: '', time: '' })
})

test('graph post normalizer produces a graph-sourced inventory row with blank comment columns', () => {
    const row = normalizePagePostInventoryGraphPost(graphPost('1277041784600517'), PAGE_ID)
    assert.ok(row)
    assert.equal(row.page_id, PAGE_ID)
    assert.equal(row.post_id, `${PAGE_ID}_1277041784600517`)
    assert.equal(row.post_id_tail, '1277041784600517')
    assert.equal(row.date, '2026-05-16')
    assert.equal(row.time, '09:30')
    assert.equal(row.type, 'reel')
    assert.equal(row.source, PAGE_POST_INVENTORY_GRAPH_SOURCE)
    assert.equal(row.page_commented, '')
    assert.equal(row.page_comment_id, '')
    assert.equal(row.page_comment_link, '')
    assert.equal(row.page_comment, '')
    // attachments media_type wins over permalink heuristics.
    const photo = normalizePagePostInventoryGraphPost(
        graphPost('22', { attachments: { data: [{ media_type: 'photo' }] }, permalink_url: 'https://www.facebook.com/reel/22' }),
        PAGE_ID,
    )
    assert.equal(photo?.type, 'photo')
    // Missing created_time → unusable date → null.
    assert.equal(normalizePagePostInventoryGraphPost(graphPost('33', { created_time: '' }), PAGE_ID), null)
})

test('crawl follows the cursor across pages until paging.next is absent', async () => {
    const calls: string[] = []
    const persisted: PagePostInventoryRow[][] = []
    const pages: PagePostInventoryGraphBatch[] = [
        { posts: [graphPost('1'), graphPost('2')], paging: { next: 'n1', cursors: { after: 'CUR1' } } },
        { posts: [graphPost('3'), graphPost('4')], paging: { next: 'n2', cursors: { after: 'CUR2' } } },
        { posts: [graphPost('5')], paging: { cursors: { after: 'CUR_LAST' } } },
    ]
    const result = await crawlPagePostInventoryFromGraph({
        pageId: PAGE_ID,
        fetchBatch: async (after) => {
            calls.push(after)
            return pages[calls.length - 1]
        },
        persistBatch: (rows) => { persisted.push(rows) },
    })
    assert.deepEqual(calls, ['', 'CUR1', 'CUR2'])
    assert.equal(result.rows.length, 5)
    assert.equal(result.pages_scanned, 3)
    assert.equal(result.next_after, '')
    assert.equal(result.fully_scanned, true)
    assert.equal(result.reached_limit, false)
    assert.equal(result.error, '')
    // persistBatch streamed per page (2, 2, 1).
    assert.deepEqual(persisted.map((b) => b.length), [2, 2, 1])
})

test('crawl stops at the page cap and preserves the resume cursor', async () => {
    const calls: string[] = []
    const pages: PagePostInventoryGraphBatch[] = [
        { posts: [graphPost('1'), graphPost('2')], paging: { next: 'n1', cursors: { after: 'CUR1' } } },
        { posts: [graphPost('3'), graphPost('4')], paging: { next: 'n2', cursors: { after: 'CUR2' } } },
        { posts: [graphPost('5')], paging: { cursors: { after: 'CUR_LAST' } } },
    ]
    const result = await crawlPagePostInventoryFromGraph({
        pageId: PAGE_ID,
        maxPages: 2,
        fetchBatch: async (after) => {
            calls.push(after)
            return pages[calls.length - 1]
        },
    })
    assert.equal(result.pages_scanned, 2)
    assert.equal(result.rows.length, 4)
    assert.equal(result.next_after, 'CUR2')
    assert.equal(result.fully_scanned, false)
})

test('crawl stops at the caller row limit and keeps the cursor for resume', async () => {
    const pages: PagePostInventoryGraphBatch[] = [
        { posts: [graphPost('1'), graphPost('2')], paging: { next: 'n1', cursors: { after: 'CUR1' } } },
        { posts: [graphPost('3'), graphPost('4')], paging: { next: 'n2', cursors: { after: 'CUR2' } } },
    ]
    let i = 0
    const result = await crawlPagePostInventoryFromGraph({
        pageId: PAGE_ID,
        maxRows: 3,
        fetchBatch: async () => pages[i++],
    })
    assert.equal(result.reached_limit, true)
    assert.equal(result.pages_scanned, 2)
    assert.equal(result.rows.length, 4)
    assert.equal(result.next_after, 'CUR2')
    assert.equal(result.fully_scanned, false)
})

test('crawl dedupes posts that repeat across pages', async () => {
    const pages: PagePostInventoryGraphBatch[] = [
        { posts: [graphPost('1'), graphPost('2')], paging: { next: 'n1', cursors: { after: 'CUR1' } } },
        { posts: [graphPost('2'), graphPost('3')], paging: {} },
    ]
    let i = 0
    const result = await crawlPagePostInventoryFromGraph({
        pageId: PAGE_ID,
        fetchBatch: async () => pages[i++],
    })
    assert.equal(result.rows.length, 3)
    assert.equal(result.fully_scanned, true)
    const ids = result.rows.map((r) => r.post_id_tail).sort()
    assert.deepEqual(ids, ['1', '2', '3'])
})

test('crawl records the error and preserves the resume cursor on Graph failure', async () => {
    const persisted: PagePostInventoryRow[][] = []
    let call = 0
    const result = await crawlPagePostInventoryFromGraph({
        pageId: PAGE_ID,
        fetchBatch: async (after) => {
            call++
            if (call === 1) {
                assert.equal(after, '')
                return { posts: [graphPost('1'), graphPost('2')], paging: { next: 'n1', cursors: { after: 'CUR1' } } }
            }
            throw new Error('facebook_rate_limited:368')
        },
        persistBatch: (rows) => { persisted.push(rows) },
    })
    assert.equal(result.error, 'facebook_rate_limited:368')
    assert.equal(result.pages_scanned, 1)
    assert.equal(result.rows.length, 2)
    assert.equal(result.next_after, 'CUR1') // resume from the page that failed
    assert.equal(result.fully_scanned, false)
    assert.deepEqual(persisted.map((b) => b.length), [2])
})

test('graph-sync sync-state table mirrors the video cache cursor shape', () => {
    assert.match(PAGE_POST_INVENTORY_SYNC_STATE_TABLE_SQL, /CREATE TABLE IF NOT EXISTS facebook_page_post_inventory_sync_state/)
    assert.match(PAGE_POST_INVENTORY_SYNC_STATE_TABLE_SQL, /page_id TEXT NOT NULL PRIMARY KEY/)
    assert.match(PAGE_POST_INVENTORY_SYNC_STATE_TABLE_SQL, /next_after TEXT NOT NULL DEFAULT ''/)
    assert.match(PAGE_POST_INVENTORY_SYNC_STATE_TABLE_SQL, /fully_scanned INTEGER NOT NULL DEFAULT 0/)
})

test('graph-sync route is auth-gated, token-scoped, and uses the cursor crawler', () => {
    const routeSource = getGraphSyncRouteSource()
    assert.match(routeSource, /requireAuthSession\(c\)/)
    assert.match(routeSource, /resolveFacebookSyncToken\(c\.env\.DB, pageId\)/)
    assert.match(routeSource, /facebook_sync_token_missing/)
    assert.match(routeSource, /crawlPagePostInventoryFromGraph\(/)
    assert.match(routeSource, /fetchPagePostInventoryBatchFromGraphToken\(token, pageId, after\)/)
    assert.match(routeSource, /upsertPagePostInventoryGraphRows\(c\.env\.DB, rows\)/)
    assert.match(routeSource, /upsertPagePostInventorySyncState\(/)
    assert.match(routeSource, /next_after: result\.next_after/)
    assert.match(routeSource, /fully_scanned: result\.fully_scanned \? 1 : 0/)
    // The crawl must never log or echo a raw token.
    assert.doesNotMatch(routeSource, /console\.[a-z]+\([^\n)]*token/i, 'graph-sync must not log tokens')
    assert.doesNotMatch(routeSource, /access_token['"]?\s*:/i, 'graph-sync must not echo access_token')
})

test('graph crawl upsert never clobbers imported comment columns', () => {
    const upsertSource = getGraphUpsertSource()
    assert.match(upsertSource, /INSERT INTO facebook_page_post_inventory/)
    assert.match(upsertSource, /ON CONFLICT\(page_id, post_id\) DO UPDATE SET/)
    // The DO UPDATE clause must touch post-level fields only, never comment columns
    // or the source tag (so CSV-imported comment data survives a re-crawl).
    const doUpdate = upsertSource.slice(upsertSource.indexOf('DO UPDATE SET'))
    assert.match(doUpdate, /message = excluded\.message/)
    assert.doesNotMatch(doUpdate, /page_commented\s*=/, 'must not overwrite page_commented')
    assert.doesNotMatch(doUpdate, /page_comment_id\s*=/, 'must not overwrite page_comment_id')
    assert.doesNotMatch(doUpdate, /page_comment_link\s*=/, 'must not overwrite page_comment_link')
    assert.doesNotMatch(doUpdate, /page_comment\s*=/, 'must not overwrite page_comment')
    assert.doesNotMatch(doUpdate, /\bsource\s*=/, 'must not downgrade an imported source tag')
})
