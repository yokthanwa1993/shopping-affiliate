// Pure helpers for CHEARB Facebook Page post/comment inventory imported from a
// Graph/Page export CSV. Dashboard reads and maintenance imports share these
// normalization invariants.

export const DEFAULT_PAGE_POST_INVENTORY_PAGE_ID = '1008898512617594'
export const PAGE_POST_INVENTORY_SOURCE = 'graph_page_export_csv'
// Source tag for rows discovered by the live Graph cursor crawl (distinct from the
// CSV/export importer above so the two ingestion paths never masquerade as each
// other and the crawl upsert can avoid clobbering imported comment columns).
export const PAGE_POST_INVENTORY_GRAPH_SOURCE = 'graph_page_posts_crawl'
export const PAGE_POST_INVENTORY_DEFAULT_LIMIT = 100
export const PAGE_POST_INVENTORY_MAX_LIMIT = 500
export const PAGE_POST_INVENTORY_RUNTIME_IMPORT_MAX_ROWS = 100

// Bounds for the live Graph posts crawl. A single sync walks at most
// PAGE_POST_INVENTORY_GRAPH_DEFAULT_MAX_PAGES batches so it can never derail the
// posting cron, and is hard-capped at PAGE_POST_INVENTORY_GRAPH_MAX_PAGES.
export const PAGE_POST_INVENTORY_GRAPH_DEFAULT_MAX_PAGES = 25
export const PAGE_POST_INVENTORY_GRAPH_MAX_PAGES = 50
export const PAGE_POST_INVENTORY_GRAPH_DEFAULT_BATCH_SIZE = 100

export const PAGE_POST_INVENTORY_CSV_COLUMNS = [
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
] as const

export type PagePostInventoryCsvColumn = typeof PAGE_POST_INVENTORY_CSV_COLUMNS[number]

export type PagePostInventoryRow = {
    page_id: string
    date: string
    time: string
    post_id: string
    post_id_tail: string
    type: string
    post_url: string
    message: string
    page_commented: string
    page_comment_id: string
    page_comment_link: string
    page_comment: string
    source: string
}

export type PagePostInventoryParseResult = {
    rows: PagePostInventoryRow[]
    input_rows: number
    valid_rows: number
    invalid_rows: number
    duplicate_keys: number
    errors: Array<{ line: number; reason: string }>
}

export const PAGE_POST_INVENTORY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS facebook_page_post_inventory (
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
    source TEXT NOT NULL DEFAULT '${PAGE_POST_INVENTORY_SOURCE}',
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (page_id, post_id)
)`

export const PAGE_POST_INVENTORY_DATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_fb_page_post_inventory_page_date_time
ON facebook_page_post_inventory(page_id, date, time)`

export const PAGE_POST_INVENTORY_TAIL_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_fb_page_post_inventory_page_tail
ON facebook_page_post_inventory(page_id, post_id_tail)`

// Per-page cursor/sync bookkeeping for the live Graph posts crawl. Mirrors the
// shape of facebook_page_video_sync_state: next_after carries the resume cursor
// (empty once the page is fully walked) and fully_scanned flips to 1 when Graph
// reports no further pages. Kept in its own table so the CSV import path and the
// read-only inventory query stay completely untouched.
export const PAGE_POST_INVENTORY_SYNC_STATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS facebook_page_post_inventory_sync_state (
    page_id TEXT NOT NULL PRIMARY KEY,
    next_after TEXT NOT NULL DEFAULT '',
    last_attempt_at TEXT NOT NULL DEFAULT '',
    last_synced_at TEXT NOT NULL DEFAULT '',
    last_full_scan_at TEXT NOT NULL DEFAULT '',
    fully_scanned INTEGER NOT NULL DEFAULT 0,
    last_batch_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

function cleanText(value: unknown): string {
    return String(value == null ? '' : value).trim()
}

function cleanHeader(value: unknown): string {
    return cleanText(value).replace(/^\uFEFF/, '').toLowerCase()
}

export function normalizePagePostInventoryDate(value: unknown): string {
    const raw = cleanText(value)
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
}

export function normalizePagePostInventoryLimit(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return PAGE_POST_INVENTORY_DEFAULT_LIMIT
    return Math.min(PAGE_POST_INVENTORY_MAX_LIMIT, Math.max(1, Math.floor(n)))
}

export function normalizePagePostInventoryOffset(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return 0
    return Math.min(10000, Math.max(0, Math.floor(n)))
}

export function derivePageStoryPostIdTail(postId: unknown): string {
    const value = cleanText(postId)
    if (!value) return ''
    const splitAt = value.lastIndexOf('_')
    if (splitAt < 0) return value
    return value.slice(splitAt + 1).trim()
}

export function normalizePageStoryPostId(postId: unknown, pageId: unknown = DEFAULT_PAGE_POST_INVENTORY_PAGE_ID): string {
    const raw = cleanText(postId)
    if (!raw) return ''
    if (raw.includes('_')) return raw
    const page = cleanText(pageId)
    return page ? `${page}_${raw}` : raw
}

export function parseCsvRecords(input: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let inQuotes = false

    const pushRow = () => {
        const next = [...row, field]
        row = []
        field = ''
        if (next.some((cell) => String(cell || '').trim() !== '')) rows.push(next)
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

export function normalizePagePostInventoryCsvRecord(
    raw: Partial<Record<PagePostInventoryCsvColumn, unknown>>,
    pageId: string = DEFAULT_PAGE_POST_INVENTORY_PAGE_ID,
): PagePostInventoryRow | null {
    const normalizedPageId = cleanText(pageId)
    const date = normalizePagePostInventoryDate(raw.date)
    const postId = normalizePageStoryPostId(raw.post_id, normalizedPageId)
    const postIdTail = derivePageStoryPostIdTail(postId)
    if (!normalizedPageId || !date || !postId || !postIdTail) return null
    return {
        page_id: normalizedPageId,
        date,
        time: cleanText(raw.time),
        post_id: postId,
        post_id_tail: postIdTail,
        type: cleanText(raw.type),
        post_url: cleanText(raw.post_url),
        message: cleanText(raw.message),
        page_commented: cleanText(raw.page_commented),
        page_comment_id: cleanText(raw.page_comment_id),
        page_comment_link: cleanText(raw.page_comment_link),
        page_comment: cleanText(raw.page_comment),
        source: PAGE_POST_INVENTORY_SOURCE,
    }
}

export function normalizePagePostInventoryImportRow(
    raw: Record<string, unknown>,
    pageId: string = DEFAULT_PAGE_POST_INVENTORY_PAGE_ID,
): PagePostInventoryRow | null {
    const rowPageId = cleanText(raw.page_id) || cleanText(pageId) || DEFAULT_PAGE_POST_INVENTORY_PAGE_ID
    return normalizePagePostInventoryCsvRecord({
        date: raw.date,
        time: raw.time,
        post_id: raw.post_id,
        type: raw.type,
        post_url: raw.post_url,
        message: raw.message,
        page_commented: raw.page_commented,
        page_comment_id: raw.page_comment_id,
        page_comment_link: raw.page_comment_link,
        page_comment: raw.page_comment,
    }, rowPageId)
}

export function parsePagePostInventoryCsv(
    input: string,
    options: { pageId?: string } = {},
): PagePostInventoryParseResult {
    const records = parseCsvRecords(String(input || ''))
    const errors: Array<{ line: number; reason: string }> = []
    if (records.length === 0) {
        return { rows: [], input_rows: 0, valid_rows: 0, invalid_rows: 0, duplicate_keys: 0, errors }
    }

    const headers = records[0].map(cleanHeader)
    const missing = PAGE_POST_INVENTORY_CSV_COLUMNS.filter((name) => !headers.includes(name))
    if (missing.length > 0) {
        return {
            rows: [],
            input_rows: Math.max(0, records.length - 1),
            valid_rows: 0,
            invalid_rows: Math.max(0, records.length - 1),
            duplicate_keys: 0,
            errors: [{ line: 1, reason: `missing_columns:${missing.join(',')}` }],
        }
    }

    const rows: PagePostInventoryRow[] = []
    const seen = new Set<string>()
    let duplicateKeys = 0
    let invalidRows = 0
    const pageId = cleanText(options.pageId) || DEFAULT_PAGE_POST_INVENTORY_PAGE_ID

    for (let index = 1; index < records.length; index++) {
        const record = records[index]
        if (!record.some((cell) => cleanText(cell))) continue
        const raw: Partial<Record<PagePostInventoryCsvColumn, string>> = {}
        for (let i = 0; i < headers.length; i++) {
            const header = headers[i] as PagePostInventoryCsvColumn
            if ((PAGE_POST_INVENTORY_CSV_COLUMNS as readonly string[]).includes(header)) {
                raw[header] = record[i] ?? ''
            }
        }
        const normalized = normalizePagePostInventoryCsvRecord(raw, pageId)
        if (!normalized) {
            invalidRows++
            errors.push({ line: index + 1, reason: 'invalid_date_or_post_id' })
            continue
        }
        const key = `${normalized.page_id}:${normalized.post_id}`
        if (seen.has(key)) duplicateKeys++
        seen.add(key)
        rows.push(normalized)
    }

    return {
        rows,
        input_rows: rows.length + invalidRows,
        valid_rows: rows.length,
        invalid_rows: invalidRows,
        duplicate_keys: duplicateKeys,
        errors,
    }
}

// ---------------------------------------------------------------------------
// Live Graph posts crawl (cursor pagination)
//
// The CSV importer above only ever sees the rows a human exports. To capture the
// full back-catalogue of a Page's posts we walk the Graph `/{page}/posts` edge
// page-by-page following its cursor. These helpers are pure/deterministic and
// take the Graph fetch as an injected dependency so they can be unit-tested
// without any network. The Worker wires a real fetch + D1 persistence on top.
// ---------------------------------------------------------------------------

export type PagePostInventoryGraphPaging = {
    next?: unknown
    cursors?: { after?: unknown; before?: unknown }
}

export type PagePostInventoryGraphBatch = {
    posts: Array<Record<string, unknown>>
    paging?: PagePostInventoryGraphPaging | null
}

export type PagePostInventoryCrawlResult = {
    rows: PagePostInventoryRow[]
    pages_scanned: number
    next_after: string
    fully_scanned: boolean
    reached_limit: boolean
    error: string
}

export function normalizePagePostInventoryGraphMaxPages(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return PAGE_POST_INVENTORY_GRAPH_DEFAULT_MAX_PAGES
    return Math.min(PAGE_POST_INVENTORY_GRAPH_MAX_PAGES, Math.max(1, Math.floor(n)))
}

// Resolve the cursor for the NEXT Graph page. Returns '' when pagination is
// exhausted. The authoritative "more pages exist" signal is the presence of
// paging.next — paging.cursors.after is echoed even on the final page, so using
// it alone would loop forever. When more pages exist we prefer cursors.after and
// fall back to the `after` query param embedded in the paging.next URL.
export function extractPagePostInventoryGraphCursor(paging: PagePostInventoryGraphPaging | null | undefined): string {
    const next = cleanText(paging?.next)
    if (!next) return ''
    const cursorAfter = cleanText(paging?.cursors?.after)
    if (cursorAfter) return cursorAfter
    try {
        return cleanText(new URL(next).searchParams.get('after'))
    } catch {
        return ''
    }
}

// Split a Graph ISO created_time ("2026-05-16T09:30:00+0000") into the inventory
// date (YYYY-MM-DD) and time (HH:MM) columns. Returns blanks when unparseable.
export function splitGraphCreatedTime(createdTime: unknown): { date: string; time: string } {
    const raw = cleanText(createdTime)
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(raw)
    if (!match) return { date: '', time: '' }
    return { date: match[1], time: match[2] }
}

export function derivePagePostInventoryGraphType(post: Record<string, unknown>): string {
    const attachments = post?.attachments as { data?: Array<Record<string, unknown>> } | undefined
    const atts = Array.isArray(attachments?.data) ? attachments!.data! : []
    const mediaType = cleanText(atts[0]?.media_type).toLowerCase()
    if (mediaType) return mediaType
    const permalink = cleanText(post?.permalink_url).toLowerCase()
    if (permalink.includes('/reel/') || permalink.includes('/reels/')) return 'reel'
    if (permalink.includes('/videos/')) return 'video'
    if (permalink.includes('/photos/') || permalink.includes('/photo')) return 'photo'
    return 'post'
}

// Convert one raw Graph /posts node into an inventory row. Comment columns stay
// blank — the crawl only discovers posts, never their comments — so the Worker's
// upsert must preserve any comment data a prior CSV import already populated.
export function normalizePagePostInventoryGraphPost(
    post: Record<string, unknown>,
    pageId: string = DEFAULT_PAGE_POST_INVENTORY_PAGE_ID,
): PagePostInventoryRow | null {
    if (!post || typeof post !== 'object') return null
    const normalizedPageId = cleanText(pageId) || DEFAULT_PAGE_POST_INVENTORY_PAGE_ID
    const postId = normalizePageStoryPostId(post.id, normalizedPageId)
    const postIdTail = derivePageStoryPostIdTail(postId)
    const { date, time } = splitGraphCreatedTime(post.created_time)
    if (!normalizedPageId || !date || !postId || !postIdTail) return null
    return {
        page_id: normalizedPageId,
        date,
        time,
        post_id: postId,
        post_id_tail: postIdTail,
        type: derivePagePostInventoryGraphType(post),
        post_url: cleanText(post.permalink_url),
        message: cleanText(post.message),
        page_commented: '',
        page_comment_id: '',
        page_comment_link: '',
        page_comment: '',
        source: PAGE_POST_INVENTORY_GRAPH_SOURCE,
    }
}

// Walk the Graph /posts edge following its cursor until exhausted, the page cap
// (maxPages) is hit, or the caller's row limit (maxRows) is reached. fetchBatch
// is injected so this stays network-free and unit-testable; persistBatch (when
// supplied) is invoked per page so callers can stream rows to D1 instead of
// buffering everything. The crawl is resumable: next_after carries the cursor to
// continue from and fully_scanned is true ONLY when Graph reported no more pages.
export async function crawlPagePostInventoryFromGraph(options: {
    pageId: string
    startAfter?: string
    maxPages?: number
    maxRows?: number
    fetchBatch: (after: string) => Promise<PagePostInventoryGraphBatch>
    persistBatch?: (rows: PagePostInventoryRow[]) => Promise<void> | void
}): Promise<PagePostInventoryCrawlResult> {
    const pageId = cleanText(options.pageId) || DEFAULT_PAGE_POST_INVENTORY_PAGE_ID
    const maxPages = normalizePagePostInventoryGraphMaxPages(options.maxPages)
    const maxRowsRaw = Number(options.maxRows)
    const maxRows = Number.isFinite(maxRowsRaw) && maxRowsRaw > 0 ? Math.floor(maxRowsRaw) : 0

    const rows: PagePostInventoryRow[] = []
    const seen = new Set<string>()
    let after = cleanText(options.startAfter)
    let nextAfter = after
    let pagesScanned = 0
    let reachedLimit = false
    let error = ''

    for (let i = 0; i < maxPages; i++) {
        let batch: PagePostInventoryGraphBatch
        try {
            batch = await options.fetchBatch(after)
        } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            // Keep `after` as the resume cursor so a later sync retries this page.
            nextAfter = after
            break
        }
        pagesScanned++

        const posts = Array.isArray(batch?.posts) ? batch.posts : []
        const batchRows: PagePostInventoryRow[] = []
        for (const post of posts) {
            const normalized = normalizePagePostInventoryGraphPost(post, pageId)
            if (!normalized) continue
            const key = `${normalized.page_id}:${normalized.post_id}`
            if (seen.has(key)) continue
            seen.add(key)
            batchRows.push(normalized)
            rows.push(normalized)
        }
        if (batchRows.length > 0 && options.persistBatch) {
            await options.persistBatch(batchRows)
        }

        const cursor = extractPagePostInventoryGraphCursor(batch?.paging)

        if (maxRows > 0 && rows.length >= maxRows) {
            // Hit the caller's row budget. Preserve the cursor so the next sync
            // resumes rather than treating the page as fully scanned.
            nextAfter = cursor
            reachedLimit = true
            break
        }

        nextAfter = cursor
        after = cursor
        if (!cursor) break // Graph reported no further pages → fully scanned.
    }

    return {
        rows,
        pages_scanned: pagesScanned,
        next_after: nextAfter,
        fully_scanned: !error && !nextAfter,
        reached_limit: reachedLimit,
        error,
    }
}
