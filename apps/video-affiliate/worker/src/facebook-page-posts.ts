// Pure helpers for the clean Facebook Page Posts inventory.
//
// Goal: capture EVERY real post of a Page using the official Graph API only
// (no HTML/browser scraping), with no artificial total-post cap. A single Worker
// invocation walks a bounded number of Graph cursor pages and is fully resumable:
// the per-page sync state stores `next_after`, and the caller (UI/cron) keeps
// invoking until `fully_scanned` flips true.
//
// Everything here is network-free and deterministic — the Graph fetch is injected
// — so the crawl/normalization invariants can be unit-tested without any I/O. The
// Worker wires a real fetch + D1 persistence on top.

import { extractPagePostInventoryGraphCursor } from './page-post-inventory.js'

// Per-request Graph page size. This is the number of posts fetched per cursor
// page — NOT a cap on the total number of posts captured for a Page.
export const FACEBOOK_PAGE_POSTS_GRAPH_DEFAULT_LIMIT = 25
export const FACEBOOK_PAGE_POSTS_GRAPH_MAX_LIMIT = 50

// How many Graph cursor pages a single sync invocation may walk. Bounded so one
// call can never derail the posting cron or hit Graph rate limits; the caller
// resumes via the stored cursor. There is deliberately NO total-post cap.
export const FACEBOOK_PAGE_POSTS_DEFAULT_BATCHES = 8
export const FACEBOOK_PAGE_POSTS_MAX_BATCHES = 40

// sync-all fan-out: how many pages to advance per call, and how many cursor pages
// to walk per page within that call.
export const FACEBOOK_PAGE_POSTS_SYNC_ALL_DEFAULT_PAGES = 3
export const FACEBOOK_PAGE_POSTS_SYNC_ALL_MAX_PAGES = 25
export const FACEBOOK_PAGE_POSTS_SYNC_ALL_DEFAULT_BATCHES_PER_PAGE = 4

// Read (cache query) bounds.
export const FACEBOOK_PAGE_POSTS_READ_DEFAULT_LIMIT = 50
export const FACEBOOK_PAGE_POSTS_READ_MAX_LIMIT = 250

export const FACEBOOK_PAGE_POSTS_SOURCE = 'graph_published_posts'

// Graph edge + field selection (mirrors the official pagination Popsters uses).
export const FACEBOOK_PAGE_POSTS_EDGE = 'published_posts'
export const FACEBOOK_PAGE_POSTS_FIELDS =
    'comments.limit(0).summary(total_count){id},' +
    'reactions.limit(0).summary(total_count){id},' +
    'message,shares,attachments,picture,from,created_time,permalink_url'

export type FacebookPagePostCacheRow = {
    namespace_id: string
    page_id: string
    page_name: string
    post_id: string
    video_id: string
    message: string
    permalink_url: string
    picture: string
    source_url: string
    media_type: string
    created_time: string
    reactions_count: number
    comments_count: number
    shares_count: number
    raw_json: string
}

export type FacebookPagePostsGraphPaging = {
    next?: unknown
    cursors?: { after?: unknown; before?: unknown }
}

export type FacebookPagePostsGraphBatch = {
    posts: Array<Record<string, unknown>>
    paging?: FacebookPagePostsGraphPaging | null
}

export type FacebookPagePostsCrawlResult = {
    rows: FacebookPagePostCacheRow[]
    batches_scanned: number
    next_after: string
    fully_scanned: boolean
    // True whenever there is more work to do — either a resume cursor remains
    // (budget stopped us mid-Page) or a Graph error needs a retry. The caller
    // keeps invoking while this is true.
    pending_more: boolean
    error: string
}

function clean(value: unknown): string {
    return String(value == null ? '' : value).trim()
}

function toCount(value: unknown): number {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function normalizeFacebookPagePostsGraphLimit(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return FACEBOOK_PAGE_POSTS_GRAPH_DEFAULT_LIMIT
    return Math.min(FACEBOOK_PAGE_POSTS_GRAPH_MAX_LIMIT, Math.max(1, Math.floor(n)))
}

export function normalizeFacebookPagePostsBatches(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return FACEBOOK_PAGE_POSTS_DEFAULT_BATCHES
    return Math.min(FACEBOOK_PAGE_POSTS_MAX_BATCHES, Math.max(1, Math.floor(n)))
}

export function normalizeFacebookPagePostsReadLimit(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return FACEBOOK_PAGE_POSTS_READ_DEFAULT_LIMIT
    return Math.min(FACEBOOK_PAGE_POSTS_READ_MAX_LIMIT, Math.max(1, Math.floor(n)))
}

export function normalizeFacebookPagePostsOffset(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return 0
    return Math.min(100000, Math.max(0, Math.floor(n)))
}

export function normalizeFacebookPagePostsSyncAllPages(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return FACEBOOK_PAGE_POSTS_SYNC_ALL_DEFAULT_PAGES
    return Math.min(FACEBOOK_PAGE_POSTS_SYNC_ALL_MAX_PAGES, Math.max(1, Math.floor(n)))
}

// Strip any access token / cookie material from a Graph error string before it is
// stored or returned. Tokens live in the request query string, so a leaked URL is
// the realistic risk; redact both the literal token and any access_token= param.
export function sanitizeFacebookPagePostsError(message: unknown, token?: unknown): string {
    let out = clean(message)
    if (!out) return ''
    const tok = clean(token)
    if (tok) out = out.split(tok).join('[redacted]')
    out = out.replace(/access_token=[^&\s"']+/gi, 'access_token=[redacted]')
    // Generic long bearer-ish blobs (EAAB..., EAAD6V...) just in case.
    out = out.replace(/\bEAA[A-Za-z0-9]{12,}\b/g, '[redacted]')
    return out.slice(0, 300)
}

// Build the Graph attachment-derived media facets for a post. Best-effort: source
// (mp4) and large picture are only present when the token/permissions allow, so a
// blank field is normal, never an error.
export function extractFacebookPostMedia(post: Record<string, unknown>): {
    video_id: string
    source_url: string
    media_type: string
    picture: string
} {
    const attachments = post?.attachments as { data?: Array<Record<string, unknown>> } | undefined
    const att = (Array.isArray(attachments?.data) ? attachments!.data! : [])[0] || {}
    const sub = ((att?.subattachments as { data?: Array<Record<string, unknown>> } | undefined)?.data || [])[0] || {}

    const attMedia = att?.media as { source?: unknown; image?: { src?: unknown } } | undefined
    const subMedia = sub?.media as { source?: unknown; image?: { src?: unknown } } | undefined

    const attMt = clean(att?.media_type).toLowerCase()
    const subMt = clean(sub?.media_type).toLowerCase()
    const isVideoMt = (mt: string) => mt.includes('video') || mt.includes('reel')

    let videoId = ''
    const attTarget = clean((att?.target as { id?: unknown } | undefined)?.id)
    const subTarget = clean((sub?.target as { id?: unknown } | undefined)?.id)
    if (attTarget && isVideoMt(attMt)) videoId = attTarget
    else if (subTarget && isVideoMt(subMt)) videoId = subTarget

    const sourceUrl = clean(attMedia?.source) || clean(subMedia?.source)
    const picture = clean(post?.picture) || clean(attMedia?.image?.src) || clean(subMedia?.image?.src)

    let mediaType = attMt || subMt
    if (!mediaType) {
        const permalink = clean(post?.permalink_url).toLowerCase()
        if (permalink.includes('/reel/') || permalink.includes('/reels/')) mediaType = 'reel'
        else if (permalink.includes('/videos/') || permalink.includes('/video')) mediaType = 'video'
        else if (permalink.includes('/photos/') || permalink.includes('/photo')) mediaType = 'photo'
        else mediaType = 'post'
    }

    return { video_id: videoId, source_url: sourceUrl, media_type: mediaType, picture }
}

// Read a Graph summary edge total_count (comments/reactions requested with
// .summary(total_count)).
export function extractGraphSummaryCount(node: unknown): number {
    const summary = (node as { summary?: { total_count?: unknown } } | undefined)?.summary
    return toCount(summary?.total_count)
}

// Convert one raw Graph published_posts node into a cache row. Returns null when
// the node lacks a usable id (we never fabricate keys).
export function normalizeFacebookPagePost(
    post: Record<string, unknown>,
    ctx: { namespaceId: string; pageId: string; pageName?: string },
): FacebookPagePostCacheRow | null {
    if (!post || typeof post !== 'object') return null
    const postId = clean(post.id)
    const pageId = clean(ctx.pageId)
    const namespaceId = clean(ctx.namespaceId)
    if (!postId || !pageId || !namespaceId) return null

    const media = extractFacebookPostMedia(post)
    const from = post?.from as { name?: unknown } | undefined
    const shares = post?.shares as { count?: unknown } | undefined

    return {
        namespace_id: namespaceId,
        page_id: pageId,
        page_name: clean(ctx.pageName) || clean(from?.name),
        post_id: postId,
        video_id: media.video_id,
        message: clean(post.message),
        permalink_url: clean(post.permalink_url),
        picture: media.picture,
        source_url: media.source_url,
        media_type: media.media_type,
        created_time: clean(post.created_time),
        reactions_count: extractGraphSummaryCount(post.reactions),
        comments_count: extractGraphSummaryCount(post.comments),
        shares_count: toCount(shares?.count),
        raw_json: JSON.stringify(post),
    }
}

// Resolve the cursor for the NEXT Graph page (delegates to the inventory crawl's
// well-tested rule: trust paging.next presence, prefer cursors.after).
export function extractFacebookPagePostsCursor(paging: FacebookPagePostsGraphPaging | null | undefined): string {
    return extractPagePostInventoryGraphCursor(paging)
}

// Walk the Graph published_posts edge following its cursor. Stops when:
//   - Graph reports no further pages (paging.next absent) → fully_scanned
//   - the per-invocation `batches` budget is exhausted     → pending_more (resume)
//   - a Graph fetch throws                                 → pending_more (retry)
// The crawl never caps the TOTAL number of posts — only how many cursor pages a
// single invocation walks. fetchBatch is injected for testability; persistBatch
// (when supplied) streams each page's rows to storage so nothing is buffered
// unboundedly across a long backfill.
export async function crawlFacebookPagePosts(options: {
    namespaceId: string
    pageId: string
    pageName?: string
    startAfter?: string
    batches?: number
    limit?: number
    fetchBatch: (after: string, limit: number) => Promise<FacebookPagePostsGraphBatch>
    persistBatch?: (rows: FacebookPagePostCacheRow[]) => Promise<void> | void
}): Promise<FacebookPagePostsCrawlResult> {
    const namespaceId = clean(options.namespaceId)
    const pageId = clean(options.pageId)
    const pageName = clean(options.pageName)
    const batches = normalizeFacebookPagePostsBatches(options.batches)
    const limit = normalizeFacebookPagePostsGraphLimit(options.limit)

    const rows: FacebookPagePostCacheRow[] = []
    const seen = new Set<string>()
    let after = clean(options.startAfter)
    let nextAfter = after
    let batchesScanned = 0
    let error = ''

    for (let i = 0; i < batches; i++) {
        let batch: FacebookPagePostsGraphBatch
        try {
            batch = await options.fetchBatch(after, limit)
        } catch (e) {
            // Sanitization is the fetcher's job (it holds the token); store as-is.
            error = e instanceof Error ? e.message : String(e)
            nextAfter = after // keep resume cursor so a later call retries this page
            break
        }
        batchesScanned++

        const posts = Array.isArray(batch?.posts) ? batch.posts : []
        const batchRows: FacebookPagePostCacheRow[] = []
        for (const post of posts) {
            const normalized = normalizeFacebookPagePost(post, { namespaceId, pageId, pageName })
            if (!normalized) continue
            const key = `${normalized.namespace_id}:${normalized.page_id}:${normalized.post_id}`
            if (seen.has(key)) continue
            seen.add(key)
            batchRows.push(normalized)
            rows.push(normalized)
        }
        if (batchRows.length > 0 && options.persistBatch) {
            await options.persistBatch(batchRows)
        }

        const cursor = extractFacebookPagePostsCursor(batch?.paging)
        nextAfter = cursor
        after = cursor
        if (!cursor) break // Graph reported no further pages → fully scanned.
    }

    const fullyScanned = !error && !nextAfter
    return {
        rows,
        batches_scanned: batchesScanned,
        next_after: nextAfter,
        fully_scanned: fullyScanned,
        pending_more: !!error || !!nextAfter,
        error,
    }
}

// CREATE TABLE statements. Keyed by (namespace_id, page_id, post_id) so the same
// page can be cached under multiple namespaces without collision. Idempotent — no
// separate migration file is needed.
export const FACEBOOK_PAGE_POST_CACHE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS facebook_page_post_cache (
    namespace_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    page_name TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL,
    video_id TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    permalink_url TEXT NOT NULL DEFAULT '',
    picture TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL DEFAULT '',
    created_time TEXT NOT NULL DEFAULT '',
    reactions_count INTEGER NOT NULL DEFAULT 0,
    comments_count INTEGER NOT NULL DEFAULT 0,
    shares_count INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (namespace_id, page_id, post_id)
)`

export const FACEBOOK_PAGE_POST_CACHE_CREATED_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_fb_page_post_cache_ns_page_created
ON facebook_page_post_cache(namespace_id, page_id, created_time DESC)`

export const FACEBOOK_PAGE_POST_CACHE_MEDIA_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_fb_page_post_cache_ns_page_media
ON facebook_page_post_cache(namespace_id, page_id, media_type)`

export const FACEBOOK_PAGE_POST_SYNC_STATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS facebook_page_post_sync_state (
    namespace_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    page_name TEXT NOT NULL DEFAULT '',
    next_after TEXT NOT NULL DEFAULT '',
    fully_scanned INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT NOT NULL DEFAULT '',
    last_synced_at TEXT NOT NULL DEFAULT '',
    last_full_scan_at TEXT NOT NULL DEFAULT '',
    last_batch_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    total_cached INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (namespace_id, page_id)
)`
