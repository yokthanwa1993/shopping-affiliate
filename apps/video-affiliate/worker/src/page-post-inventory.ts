// Pure helpers for CHEARB Facebook Page post/comment inventory imported from a
// Graph/Page export CSV. Dashboard reads and maintenance imports share these
// normalization invariants.

export const DEFAULT_PAGE_POST_INVENTORY_PAGE_ID = '1008898512617594'
export const PAGE_POST_INVENTORY_SOURCE = 'graph_page_export_csv'
export const PAGE_POST_INVENTORY_DEFAULT_LIMIT = 100
export const PAGE_POST_INVENTORY_MAX_LIMIT = 500
export const PAGE_POST_INVENTORY_RUNTIME_IMPORT_MAX_ROWS = 100

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
