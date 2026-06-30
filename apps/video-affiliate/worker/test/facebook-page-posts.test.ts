import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    FACEBOOK_PAGE_POSTS_EDGE,
    FACEBOOK_PAGE_POSTS_FIELDS,
    FACEBOOK_PAGE_POSTS_GRAPH_DEFAULT_LIMIT,
    FACEBOOK_PAGE_POSTS_GRAPH_MAX_LIMIT,
    FACEBOOK_PAGE_POSTS_SOURCE,
    FACEBOOK_PAGE_POST_CACHE_TABLE_SQL,
    FACEBOOK_PAGE_POST_SYNC_STATE_TABLE_SQL,
    type FacebookPagePostCacheRow,
    type FacebookPagePostsGraphBatch,
    crawlFacebookPagePosts,
    extractFacebookPostMedia,
    extractGraphSummaryCount,
    normalizeFacebookPagePost,
    normalizeFacebookPagePostsBatches,
    normalizeFacebookPagePostsGraphLimit,
    normalizeFacebookPagePostsReadLimit,
    sanitizeFacebookPagePostsError,
} from '../src/facebook-page-posts.js'

const NS = '1774858894802785816'
const PAGE_ID = '1008898512617594'

function graphPost(tail: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: `${PAGE_ID}_${tail}`,
        message: `caption ${tail}`,
        permalink_url: `https://www.facebook.com/reel/${tail}`,
        created_time: '2026-05-16T09:30:00+0000',
        reactions: { summary: { total_count: 12 } },
        comments: { summary: { total_count: 3 } },
        shares: { count: 5 },
        ...overrides,
    }
}

// --- pure normalization -----------------------------------------------------

test('normalizeFacebookPagePost maps Graph node to a cache row', () => {
    const row = normalizeFacebookPagePost(graphPost('100'), { namespaceId: NS, pageId: PAGE_ID, pageName: 'เฉียบ' })
    assert.ok(row)
    assert.equal(row!.namespace_id, NS)
    assert.equal(row!.page_id, PAGE_ID)
    assert.equal(row!.post_id, `${PAGE_ID}_100`)
    assert.equal(row!.page_name, 'เฉียบ')
    assert.equal(row!.message, 'caption 100')
    assert.equal(row!.reactions_count, 12)
    assert.equal(row!.comments_count, 3)
    assert.equal(row!.shares_count, 5)
    assert.equal(row!.media_type, 'reel') // derived from /reel/ permalink
    // raw_json round-trips to the original node.
    assert.equal(JSON.parse(row!.raw_json).id, `${PAGE_ID}_100`)
})

test('normalizeFacebookPagePost requires id + page + namespace', () => {
    assert.equal(normalizeFacebookPagePost({}, { namespaceId: NS, pageId: PAGE_ID }), null)
    assert.equal(normalizeFacebookPagePost(graphPost('x'), { namespaceId: '', pageId: PAGE_ID }), null)
    assert.equal(normalizeFacebookPagePost(graphPost('x'), { namespaceId: NS, pageId: '' }), null)
})

test('extractFacebookPostMedia pulls video_id/source/picture from attachments', () => {
    const post = graphPost('200', {
        permalink_url: 'https://www.facebook.com/videos/200',
        picture: 'https://cdn/pic.jpg',
        attachments: {
            data: [{
                media_type: 'video',
                target: { id: '987654321' },
                media: { source: 'https://cdn/video.mp4', image: { src: 'https://cdn/thumb.jpg' } },
            }],
        },
    })
    const media = extractFacebookPostMedia(post)
    assert.equal(media.video_id, '987654321')
    assert.equal(media.source_url, 'https://cdn/video.mp4')
    assert.equal(media.media_type, 'video')
    assert.equal(media.picture, 'https://cdn/pic.jpg') // top-level picture wins
})

test('extractFacebookPostMedia falls back to subattachments for video id', () => {
    const post = graphPost('201', {
        attachments: {
            data: [{
                media_type: 'album',
                subattachments: { data: [{ media_type: 'video', target: { id: 'sub-vid-1' }, media: { source: 'https://cdn/sub.mp4' } }] },
            }],
        },
    })
    const media = extractFacebookPostMedia(post)
    assert.equal(media.video_id, 'sub-vid-1')
    assert.equal(media.source_url, 'https://cdn/sub.mp4')
})

test('extractGraphSummaryCount reads summary.total_count, defaults to 0', () => {
    assert.equal(extractGraphSummaryCount({ summary: { total_count: 42 } }), 42)
    assert.equal(extractGraphSummaryCount({ summary: {} }), 0)
    assert.equal(extractGraphSummaryCount(undefined), 0)
})

// --- bounds -----------------------------------------------------------------

test('limit/batches normalizers clamp to bounds', () => {
    assert.equal(FACEBOOK_PAGE_POSTS_GRAPH_DEFAULT_LIMIT, 25)
    assert.equal(normalizeFacebookPagePostsGraphLimit(undefined), 25)
    assert.equal(normalizeFacebookPagePostsGraphLimit(999), FACEBOOK_PAGE_POSTS_GRAPH_MAX_LIMIT)
    assert.equal(normalizeFacebookPagePostsGraphLimit(0), 1)
    assert.equal(normalizeFacebookPagePostsReadLimit(99999), 250)
    assert.equal(normalizeFacebookPagePostsBatches(99999), 40)
})

// --- error sanitization -----------------------------------------------------

test('sanitizeFacebookPagePostsError strips token + access_token param', () => {
    const token = 'FAKE_FACEBOOK_TOKEN_SAMPLE_1234567890'
    const dirty = `facebook_graph_http_400:{"error":"bad"} url=https://x?access_token=${token}&after=Y ${token}`
    const clean = sanitizeFacebookPagePostsError(dirty, token)
    assert.ok(!clean.includes(token), 'literal token must be redacted')
    assert.ok(!clean.includes('access_token=' + token), 'access_token param must be redacted')
    assert.ok(clean.includes('[redacted]'))
})

// --- crawl behavior ---------------------------------------------------------

test('crawl: published_posts cursor → pending_more when more pages remain', async () => {
    const calls: Array<{ after: string; limit: number }> = []
    const result = await crawlFacebookPagePosts({
        namespaceId: NS,
        pageId: PAGE_ID,
        batches: 2, // budget ends before Graph is exhausted
        limit: 25,
        fetchBatch: async (after, limit) => {
            calls.push({ after, limit })
            const idx = calls.length
            return {
                posts: [graphPost(`p${idx}a`), graphPost(`p${idx}b`)],
                // Always advertise another page so the crawl stops on the budget, not exhaustion.
                paging: { next: `https://graph.facebook.com/x?after=CUR${idx}`, cursors: { after: `CUR${idx}` } },
            } as FacebookPagePostsGraphBatch
        },
    })
    // limit=25 is forwarded to Graph; the resume cursor is carried.
    assert.equal(calls[0].limit, 25)
    assert.equal(calls[0].after, '') // first page has no cursor
    assert.equal(calls[1].after, 'CUR1') // second page resumes from page 1's cursor
    assert.equal(result.batches_scanned, 2)
    assert.equal(result.next_after, 'CUR2')
    assert.equal(result.fully_scanned, false, 'budget end must NOT mark fully scanned')
    assert.equal(result.pending_more, true)
    assert.equal(result.rows.length, 4)
})

test('crawl: no paging.next on final page → fully_scanned', async () => {
    const result = await crawlFacebookPagePosts({
        namespaceId: NS,
        pageId: PAGE_ID,
        batches: 10,
        fetchBatch: async (after) => ({
            posts: [graphPost(after ? 'second' : 'first')],
            paging: after ? { cursors: { after: 'ECHOED' } } : { next: 'https://graph.facebook.com/x?after=NEXT1', cursors: { after: 'NEXT1' } },
        }),
    })
    // Page 1 had a next; page 2 had no next (cursors.after is echoed but ignored).
    assert.equal(result.batches_scanned, 2)
    assert.equal(result.next_after, '')
    assert.equal(result.fully_scanned, true)
    assert.equal(result.pending_more, false)
})

test('crawl: Graph error preserves resume cursor + does NOT mark fully scanned', async () => {
    const token = 'FAKE_GRAPH_TOKEN_SAMPLE_0987654321'
    const result = await crawlFacebookPagePosts({
        namespaceId: NS,
        pageId: PAGE_ID,
        startAfter: 'RESUME_CUR',
        batches: 5,
        // Simulate the fetch helper having already sanitized the token before throwing.
        fetchBatch: async () => { throw new Error(sanitizeFacebookPagePostsError(`facebook_rate_limited:blocked ${token}:368`, token)) },
    })
    assert.equal(result.fully_scanned, false)
    assert.equal(result.pending_more, true)
    assert.equal(result.next_after, 'RESUME_CUR', 'resume cursor preserved for retry')
    assert.ok(result.error.includes('facebook_rate_limited'))
    assert.ok(!result.error.includes(token), 'stored last_error must not leak the token')
})

test('crawl: persistBatch streams every page and de-dupes within the pass', async () => {
    const persisted: FacebookPagePostCacheRow[] = []
    const result = await crawlFacebookPagePosts({
        namespaceId: NS,
        pageId: PAGE_ID,
        batches: 5,
        fetchBatch: async (after) => after
            ? { posts: [graphPost('dup'), graphPost('unique')], paging: null }
            : { posts: [graphPost('dup')], paging: { next: 'https://x?after=C', cursors: { after: 'C' } } },
        persistBatch: (rows) => { persisted.push(...rows) },
    })
    assert.equal(result.fully_scanned, true)
    // 'dup' appears on both pages but is persisted once; 'unique' once.
    assert.equal(persisted.length, 2)
    assert.deepEqual(persisted.map((r) => r.post_id).sort(), [`${PAGE_ID}_dup`, `${PAGE_ID}_unique`])
})

// --- table SQL --------------------------------------------------------------

test('cache table SQL has required columns + composite key', () => {
    const sql = FACEBOOK_PAGE_POST_CACHE_TABLE_SQL
    for (const col of ['namespace_id', 'page_id', 'post_id', 'video_id', 'message', 'permalink_url',
        'picture', 'source_url', 'media_type', 'created_time', 'reactions_count', 'comments_count',
        'shares_count', 'raw_json', 'fetched_at', 'updated_at']) {
        assert.ok(sql.includes(col), `cache table must declare ${col}`)
    }
    assert.ok(sql.includes('PRIMARY KEY (namespace_id, page_id, post_id)'))
})

test('sync-state table SQL keyed by (namespace_id, page_id) with resume fields', () => {
    const sql = FACEBOOK_PAGE_POST_SYNC_STATE_TABLE_SQL
    for (const col of ['next_after', 'fully_scanned', 'last_attempt_at', 'last_synced_at',
        'last_full_scan_at', 'last_batch_count', 'last_error', 'total_cached']) {
        assert.ok(sql.includes(col), `sync state must declare ${col}`)
    }
    assert.ok(sql.includes('PRIMARY KEY (namespace_id, page_id)'))
})

test('Graph fields request comments + reactions summary counts', () => {
    assert.ok(FACEBOOK_PAGE_POSTS_FIELDS.includes('comments.limit(0).summary(total_count)'))
    assert.ok(FACEBOOK_PAGE_POSTS_FIELDS.includes('reactions.limit(0).summary(total_count)'))
    assert.ok(FACEBOOK_PAGE_POSTS_FIELDS.includes('shares'))
    assert.ok(FACEBOOK_PAGE_POSTS_FIELDS.includes('permalink_url'))
    assert.equal(FACEBOOK_PAGE_POSTS_EDGE, 'published_posts')
})

// --- index.ts wiring (source-text assertions) -------------------------------

function indexSource(): string {
    return readFileSync('src/index.ts', 'utf8')
}

test('index.ts wires the three facebook-page-posts endpoints', () => {
    const src = indexSource()
    assert.ok(src.includes("app.get('/api/dashboard/facebook-page-posts'"), 'read endpoint must exist')
    assert.ok(src.includes("app.post('/api/dashboard/facebook-page-posts/sync-page'"), 'sync-page endpoint must exist')
    assert.ok(src.includes("app.post('/api/dashboard/facebook-page-posts/sync-all'"), 'sync-all endpoint must exist')
})

test('fetch helper hits /published_posts with the official cursor + sanitizes errors', () => {
    const src = indexSource()
    const start = src.indexOf('async function fetchFacebookPagePostsBatchFromToken')
    assert.notEqual(start, -1)
    const body = src.slice(start, start + 2000)
    assert.ok(body.includes('FACEBOOK_PAGE_POSTS_EDGE'), 'must use the published_posts edge constant')
    assert.ok(body.includes("params.set('after', after)"), 'must pass the after cursor when present')
    assert.ok(body.includes('sanitizeFacebookPagePostsError'), 'must sanitize Graph errors before throwing')
})

test('read endpoint exposes data_source + does not gate on min_views', () => {
    const src = indexSource()
    const start = src.indexOf("app.get('/api/dashboard/facebook-page-posts'")
    const end = src.indexOf("app.post('/api/dashboard/facebook-page-posts/sync-page'")
    const body = src.slice(start, end)
    assert.ok(body.includes('FACEBOOK_PAGE_POSTS_SOURCE'))
    assert.ok(!body.includes('min_views'), 'all-post inventory must not filter by min_views')
    assert.equal(FACEBOOK_PAGE_POSTS_SOURCE, 'graph_published_posts')
})

// --- Graph query path (Popsters HAR parity) ---------------------------------

test('Graph query string matches the Popsters published_posts request', () => {
    // Reconstruct the URL exactly the way fetchFacebookPagePostsBatchFromToken
    // does, so the documented contract (edge + fields + limit + after) is locked.
    const params = new URLSearchParams({
        fields: FACEBOOK_PAGE_POSTS_FIELDS,
        limit: String(FACEBOOK_PAGE_POSTS_GRAPH_DEFAULT_LIMIT),
        access_token: 'TEST_TOKEN',
    })
    params.set('after', 'CURSOR_ABC')
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(PAGE_ID)}/${FACEBOOK_PAGE_POSTS_EDGE}?${params.toString()}`

    assert.ok(url.includes('/published_posts?'), 'must hit the published_posts edge')
    assert.ok(url.includes('limit=25'), 'default Graph page size is 25')
    assert.ok(url.includes('after=CURSOR_ABC'), 'cursor must be forwarded as after=')
    // Counts requested as summary(total_count) so we store engagement, not bodies.
    assert.ok(decodeURIComponent(url).includes('comments.limit(0).summary(total_count)'))
    assert.ok(decodeURIComponent(url).includes('reactions.limit(0).summary(total_count)'))
    assert.ok(decodeURIComponent(url).includes('permalink_url'))
})

test('fetch helper forwards the limit + fields to Graph (source contract)', () => {
    const src = indexSource()
    const start = src.indexOf('async function fetchFacebookPagePostsBatchFromToken')
    const body = src.slice(start, start + 2000)
    assert.ok(body.includes('fields: FACEBOOK_PAGE_POSTS_FIELDS'), 'must request the published_posts fields')
    assert.ok(body.includes('limit: String(limit)'), 'must forward the Graph page-size limit')
    assert.ok(body.includes('access_token'), 'must authenticate the Graph call')
})

// --- sync state persistence (budget end must NOT mark fully scanned) ---------

test('sync pass persists next_after + derives fully_scanned from the crawl, not the budget', () => {
    const src = indexSource()
    const start = src.indexOf('async function runFacebookPagePostsSyncPass')
    assert.notEqual(start, -1)
    const end = src.indexOf('async function ', start + 1)
    const body = src.slice(start, end)
    // The resume cursor is always persisted...
    assert.ok(body.includes('next_after: result.next_after'), 'must persist the resume cursor')
    // ...and fully_scanned tracks the crawl result (false on budget end), never a
    // hard-coded 1. crawlFacebookPagePosts only sets fully_scanned when Graph
    // reports no further pages, so a budget-bounded pass leaves it false.
    assert.ok(body.includes('fully_scanned: result.fully_scanned ? 1 : 0'), 'fully_scanned mirrors the crawl result')
    assert.ok(body.includes('startAfter') && body.includes("priorState?.next_after"), 'must resume from the stored cursor')
})

// --- read endpoint: no token leakage ----------------------------------------

test('read query selects cached post fields without raw_json or any token', () => {
    const src = indexSource()
    const start = src.indexOf('async function listFacebookPagePostCache')
    assert.notEqual(start, -1)
    const body = src.slice(start, start + 1400)
    assert.ok(body.includes('FROM facebook_page_post_cache'), 'reads from the post cache table')
    assert.ok(body.includes('permalink_url'), 'returns the Facebook permalink for open-post links')
    // The raw Graph node (raw_json) and any token material must never reach the
    // client — the SELECT column list omits raw_json entirely.
    const selectClause = body.slice(0, body.indexOf('FROM facebook_page_post_cache'))
    assert.ok(!selectClause.includes('raw_json'), 'raw_json must not be returned to the client')
    assert.ok(!selectClause.toLowerCase().includes('access_token'), 'no token column is ever selected')
})
