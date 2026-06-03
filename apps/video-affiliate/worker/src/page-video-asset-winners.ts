export type ParsedPageVideoSubId = {
    subId: string
    prefix: string
    fbVideoId: string
    pageId: string
}

export type ConversionRawRow = Record<string, unknown>

export type PageVideoConversionAggregate = ParsedPageVideoSubId & {
    orders: number
    commission: number
    purchaseValue: number
    sampleSubIds: string[]
}

export const PAGE_VIDEO_ASSET_WINNERS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS page_video_asset_winners (
    namespace_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    fb_video_id TEXT NOT NULL,
    system_video_id TEXT NOT NULL DEFAULT '',
    ad_account TEXT NOT NULL DEFAULT '',
    advideo_id TEXT NOT NULL DEFAULT '',
    advideo_status TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    source_sub_id TEXT NOT NULL DEFAULT '',
    source_shopee_link TEXT NOT NULL DEFAULT '',
    orders_1d INTEGER NOT NULL DEFAULT 0,
    orders_7d INTEGER NOT NULL DEFAULT 0,
    commission_7d REAL NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (namespace_id, page_id, fb_video_id)
)`

export const PAGE_VIDEO_ASSET_WINNERS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_page_video_asset_winners_rank
ON page_video_asset_winners(namespace_id, page_id, orders_7d DESC, commission_7d DESC, updated_at DESC)`

function normalizeText(value: unknown): string {
    return String(value == null ? '' : value).trim()
}

function pickNumber(value: unknown): number {
    if (value == null || value === '') return 0
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
}

export function pickConversionRowSubId(row: ConversionRawRow): string {
    return normalizeText(
        row.utm_content
        ?? row.utmContent
        ?? row.sub_id
        ?? row.subId
        ?? row.sub_ids
        ?? row.subIds
        ?? '',
    )
}

export function pickConversionRowCommission(row: ConversionRawRow): number {
    return pickNumber(
        row.actual_commission
        ?? row.actualCommission
        ?? row.commission
        ?? row.gross_commission
        ?? row.grossCommission
        ?? row.commission_amount
        ?? 0,
    )
}

export function pickConversionRowPurchaseValue(row: ConversionRawRow): number {
    return pickNumber(
        row.purchase_value
        ?? row.purchaseValue
        ?? row.total_payable_amount
        ?? row.totalPayableAmount
        ?? row.order_amount
        ?? row.gmv
        ?? 0,
    )
}

export function parsePageVideoSubId(subId: string, expectedPageId?: string): ParsedPageVideoSubId | null {
    const value = normalizeText(subId)
    if (!value || /^-+$/.test(value)) return null

    // Expected generated shape from page comments/shortlinks:
    //   <campaign-prefix>-<fb_video_id>-<page_id>--
    // Extra empty sub slots can leave one or more trailing dashes. We only accept
    // numeric FB video id + numeric Page id so generic campaign buckets such as
    // `16MAY26FBSPCAD----` or labels like `...-SALES---` are not misattributed.
    const match = value.match(/^(.+?)-(\d{8,})-(\d{8,})-+$/)
    if (!match) return null

    const pageId = match[3]
    const wantedPageId = normalizeText(expectedPageId)
    if (wantedPageId && pageId !== wantedPageId) return null

    return {
        subId: value,
        prefix: match[1],
        fbVideoId: match[2],
        pageId,
    }
}

export function aggregatePageVideoConversions(
    rows: ConversionRawRow[],
    expectedPageId?: string,
): PageVideoConversionAggregate[] {
    const byKey = new Map<string, PageVideoConversionAggregate>()

    for (const row of rows) {
        const subId = pickConversionRowSubId(row)
        const parsed = parsePageVideoSubId(subId, expectedPageId)
        if (!parsed) continue

        const key = `${parsed.pageId}:${parsed.fbVideoId}`
        let agg = byKey.get(key)
        if (!agg) {
            agg = {
                ...parsed,
                orders: 0,
                commission: 0,
                purchaseValue: 0,
                sampleSubIds: [],
            }
            byKey.set(key, agg)
        }
        agg.orders += 1
        agg.commission += pickConversionRowCommission(row)
        agg.purchaseValue += pickConversionRowPurchaseValue(row)
        if (agg.sampleSubIds.length < 5 && !agg.sampleSubIds.includes(parsed.subId)) {
            agg.sampleSubIds.push(parsed.subId)
        }
    }

    return Array.from(byKey.values()).sort((a, b) => {
        if (b.orders !== a.orders) return b.orders - a.orders
        if (b.commission !== a.commission) return b.commission - a.commission
        return b.purchaseValue - a.purchaseValue
    })
}

export function buildAssetLibraryVideoTitle(params: {
    systemVideoId?: string
    fbVideoId: string
    orders7d?: number
    originalTitle?: string
}): string {
    const systemId = normalizeText(params.systemVideoId)
    const title = normalizeText(params.originalTitle).replace(/\s+/g, ' ').slice(0, 80)
    const sourceId = systemId || params.fbVideoId
    const orders = Math.max(0, Math.trunc(Number(params.orders7d || 0)))
    const prefix = orders > 0 ? `WIN_${orders}orders_` : 'WIN_'
    return `${prefix}${sourceId}${title ? `_${title}` : ''}`.slice(0, 120)
}

export function buildAssetLibraryVideoDescription(params: {
    namespaceId: string
    pageId: string
    fbVideoId: string
    systemVideoId?: string
    sourceSubId?: string
    orders7d?: number
}): string {
    const parts = [
        `source:page-video`,
        `namespace:${normalizeText(params.namespaceId)}`,
        `page:${normalizeText(params.pageId)}`,
        `fb_video:${normalizeText(params.fbVideoId)}`,
        `system_video:${normalizeText(params.systemVideoId)}`,
        `orders_7d:${Math.max(0, Math.trunc(Number(params.orders7d || 0)))}`,
        `sub_id:${normalizeText(params.sourceSubId)}`,
    ]
    return parts.join(' | ').slice(0, 1000)
}
