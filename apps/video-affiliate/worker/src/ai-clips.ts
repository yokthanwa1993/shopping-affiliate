// AI Clips — pure, network-free helpers for the operator-uploaded AI video library.
//
// This is a DEDICATED workspace that is 100% separate from the legacy Chinese/LINE
// "คลังต้นฉบับ" source inventory (`_inbox/` records served by GET /api/inbox). AI clips
// live under their OWN R2 prefix (`_ai_clips/`) so the legacy inbox listing never sees
// them and legacy behavior is untouched. They reuse the SHARED original-video asset key
// (`videos/{id}_original.mp4`) only so the existing /api/gallery/:id/asset/* routes can
// serve playback + on-the-fly thumbnails — no new asset plumbing required.
//
// AI clips are NEVER auto-posted and NEVER trigger Facebook/ads. The operator uploads an
// already AI-generated MP4/MOV/WEBM; it is registered as source inventory only, with the
// same unprocessed/processed lifecycle the old flow exposes (here driven purely by
// `processedAt` presence).
//
// All logic here is pure so it can be unit-tested without a live R2/Worker (see
// test/ai-clips.test.ts). The route handlers in index.ts do the I/O.

export const AI_CLIP_PREFIX = '_ai_clips/'
export const AI_CLIP_SOURCE_TYPE = 'ai_manual_upload'
export const AI_CLIP_SOURCE_LABEL = 'คลิป AI'

export type AiClipView = 'unprocessed' | 'processed'

// MP4/MOV/WEBM (+ m4v) only — the operator uploads finished AI renders. The allowlist is
// enforced on BOTH the content-type and the filename extension so a mislabeled blob is
// rejected rather than stored as an unplayable asset.
const AI_CLIP_ALLOWED_EXTENSIONS = ['mp4', 'mov', 'webm', 'm4v'] as const
const AI_CLIP_ALLOWED_CONTENT_TYPES = [
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-m4v',
    'video/m4v',
] as const

// 1 GiB hard cap — generous for a 9:16 AI reel while still failing closed on a runaway
// upload. The route streams the Blob straight to R2, so this is a sanity bound, not a
// memory bound.
export const AI_CLIP_MAX_BYTES = 1024 * 1024 * 1024

export type AiClipRecord = {
    id: string
    namespaceId: string
    title: string
    sourceType: typeof AI_CLIP_SOURCE_TYPE
    sourceLabel: string
    createdAt: string
    updatedAt: string
    processedAt: string
    contentType: string
    originalFileName: string
    sizeBytes: number
    // Product links paired with THIS specific clip. Optional; stored verbatim when they
    // look like an http(s) URL, otherwise dropped to '' (never a partial/garbage value).
    shopeeLink: string
    lazadaLink: string
}

export function parseAiClipView(raw: unknown): AiClipView {
    return String(raw || '').trim().toLowerCase() === 'processed' ? 'processed' : 'unprocessed'
}

export function sanitizeAiClipNamespaceId(raw: unknown): string {
    return String(raw || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
}

export function aiClipNamespacePrefix(namespaceId: string): string {
    const ns = sanitizeAiClipNamespaceId(namespaceId)
    return ns ? `${AI_CLIP_PREFIX}${ns}/` : ''
}

export function aiClipRecordKey(namespaceId: string, id: string): string {
    const prefix = aiClipNamespacePrefix(namespaceId)
    const normalized = sanitizeAiClipId(id)
    return prefix && normalized ? `${prefix}${normalized}.json` : ''
}

export function aiClipOriginalAssetKey(id: string): string {
    const normalized = sanitizeAiClipId(id)
    return normalized ? `videos/${normalized}_original.mp4` : ''
}

// AI clip ids are always `ai_<base36 timestamp>_<random>` so they sort by time, are easy to
// recognize in R2, and can never collide with legacy inbox ids. `now`/`randomToken` are
// injected so the generator stays pure + testable.
export function generateAiClipId(now: number, randomToken: string): string {
    const ts = Number.isFinite(now) && now > 0 ? Math.floor(now) : 0
    const rand = String(randomToken || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10) || '0'
    return `ai_${ts.toString(36)}_${rand}`
}

// Strip anything that is not a safe id char so a crafted id can never escape the `_ai_clips/`
// prefix or the `videos/{id}_original.mp4` asset key.
export function sanitizeAiClipId(raw: unknown): string {
    return String(raw || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
}

// Product-link guard. Trim, bound length, and accept ONLY when the value looks like an
// http(s) URL. A non-empty value that is not http(s) sanitizes to '' (it is never stored
// half-valid). Use `isAiClipLinkValid` at the route boundary to reject a bad link loudly.
const AI_CLIP_LINK_MAX = 2048

export function sanitizeAiClipLink(raw: unknown): string {
    const value = String(raw || '').trim().slice(0, AI_CLIP_LINK_MAX)
    if (!value) return ''
    return /^https?:\/\/\S+$/i.test(value) ? value : ''
}

// True when the link is empty (links are optional) OR a well-formed http(s) URL. The upload
// route uses this to return a clear `invalid_shopee_link` / `invalid_lazada_link` instead of
// silently dropping a mistyped link.
export function isAiClipLinkValid(raw: unknown): boolean {
    const value = String(raw || '').trim()
    if (!value) return true
    return /^https?:\/\/\S+$/i.test(value.slice(0, AI_CLIP_LINK_MAX))
}

export function sanitizeAiClipTitle(raw: unknown): string {
    return String(raw || '')
        .replace(/[ - \u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
}

function fileExtension(fileName: string): string {
    const match = String(fileName || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/)
    return match ? match[1] : ''
}

// True only when BOTH the content-type and the extension are in the video allowlist. An
// empty/unknown content-type is tolerated as long as the extension is valid (browsers
// occasionally omit it for .mov), but a non-video content-type is always rejected.
export function isAllowedAiClipUpload(contentType: unknown, fileName: unknown): boolean {
    const ct = String(contentType || '').trim().toLowerCase().split(';')[0]
    const ext = fileExtension(String(fileName || ''))
    const extOk = (AI_CLIP_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)
    if (!extOk) return false
    if (!ct) return true
    return (AI_CLIP_ALLOWED_CONTENT_TYPES as readonly string[]).includes(ct) || ct.startsWith('video/')
}

export function isAiClipProcessed(record: Pick<AiClipRecord, 'processedAt'>): boolean {
    return !!String(record?.processedAt || '').trim()
}

export function aiClipStatus(record: Pick<AiClipRecord, 'processedAt'>): AiClipView {
    return isAiClipProcessed(record) ? 'processed' : 'unprocessed'
}

export function normalizeAiClipRecord(input: Partial<AiClipRecord> | null | undefined): AiClipRecord | null {
    const id = sanitizeAiClipId(input?.id)
    if (!id) return null
    const createdAt = String(input?.createdAt || '').trim() || new Date(0).toISOString()
    const updatedAt = String(input?.updatedAt || '').trim() || createdAt
    const sizeRaw = Number(input?.sizeBytes)
    return {
        id,
        namespaceId: sanitizeAiClipNamespaceId(input?.namespaceId),
        title: sanitizeAiClipTitle(input?.title),
        sourceType: AI_CLIP_SOURCE_TYPE,
        sourceLabel: String(input?.sourceLabel || '').trim() || AI_CLIP_SOURCE_LABEL,
        createdAt,
        updatedAt,
        processedAt: String(input?.processedAt || '').trim(),
        contentType: String(input?.contentType || '').trim(),
        originalFileName: String(input?.originalFileName || '').trim().slice(0, 260),
        sizeBytes: Number.isFinite(sizeRaw) && sizeRaw >= 0 ? Math.floor(sizeRaw) : 0,
        shopeeLink: sanitizeAiClipLink(input?.shopeeLink),
        lazadaLink: sanitizeAiClipLink(input?.lazadaLink),
    }
}

export function filterAiClipsByView(records: AiClipRecord[], view: AiClipView): AiClipRecord[] {
    return records.filter((record) => (view === 'processed' ? isAiClipProcessed(record) : !isAiClipProcessed(record)))
}

// Newest first, keyed off processed/updated/created like the legacy inbox sort.
export function sortAiClipRecords(records: AiClipRecord[]): AiClipRecord[] {
    const ts = (value: string): number => {
        const n = new Date(String(value || '')).getTime()
        return Number.isFinite(n) ? n : 0
    }
    return [...records].sort((a, b) => {
        const aTs = ts(a.processedAt) || ts(a.updatedAt) || ts(a.createdAt)
        const bTs = ts(b.processedAt) || ts(b.updatedAt) || ts(b.createdAt)
        return bTs - aTs
    })
}

function galleryAssetUrl(workerUrl: string, namespaceId: string, id: string, variant: 'original' | 'original-thumb'): string {
    const base = String(workerUrl || '').trim().replace(/\/+$/, '')
    const ns = String(namespaceId || '').trim()
    const vid = sanitizeAiClipId(id)
    if (!base || !ns || !vid) return ''
    return `${base}/api/gallery/${encodeURIComponent(vid)}/asset/${variant}?namespace_id=${encodeURIComponent(ns)}`
}

// Shape one AI clip for the dashboard list response. Carries both camelCase and snake_case
// of the rich fields the source-inventory card grid already understands, plus AI-specific
// metadata. Asset/preview/thumbnail URLs point at the existing namespace-scoped Worker asset
// endpoints (no secrets, no tokens).
export function buildAiClipResponse(
    record: AiClipRecord,
    params: { namespaceId: string; workerUrl: string },
): Record<string, unknown> {
    const originalUrl = galleryAssetUrl(params.workerUrl, params.namespaceId, record.id, 'original')
    const thumbnailUrl = galleryAssetUrl(params.workerUrl, params.namespaceId, record.id, 'original-thumb')
    const processed = isAiClipProcessed(record)
    const shopeeLink = sanitizeAiClipLink(record.shopeeLink)
    const lazadaLink = sanitizeAiClipLink(record.lazadaLink)
    return {
        id: record.id,
        video_id: record.id,
        title: record.title || record.originalFileName || `AI ${record.id}`,
        status: processed ? 'processed' : 'unprocessed',
        sourceType: AI_CLIP_SOURCE_TYPE,
        source_type: AI_CLIP_SOURCE_TYPE,
        sourceLabel: record.sourceLabel,
        source_label: record.sourceLabel,
        namespace_id: String(params.namespaceId || '').trim(),
        namespaceId: String(params.namespaceId || '').trim(),
        originalUrl,
        original_url: originalUrl,
        videoUrl: originalUrl,
        video_url: originalUrl,
        previewUrl: originalUrl,
        preview_url: originalUrl,
        thumbnailUrl,
        thumbnail_url: thumbnailUrl,
        fallbackThumbnailUrl: thumbnailUrl,
        created_at: record.createdAt,
        createdAt: record.createdAt,
        updated_at: record.updatedAt,
        updatedAt: record.updatedAt,
        processed_at: record.processedAt,
        processedAt: record.processedAt,
        readyToProcess: !processed,
        canStartProcessing: !processed,
        shopeeLink,
        shopee_link: shopeeLink,
        lazadaLink,
        lazada_link: lazadaLink,
        hasShopeeLink: !!shopeeLink,
        hasLazadaLink: !!lazadaLink,
        sizeBytes: record.sizeBytes,
        contentType: record.contentType,
        originalFileName: record.originalFileName,
    }
}
