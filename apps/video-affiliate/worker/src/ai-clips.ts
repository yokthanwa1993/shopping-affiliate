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

// AI clip ids are 7 numeric digits only, per operator UX preference. They are
// intentionally short for manual handling/screenshots; the upload route checks the
// namespace-scoped R2 record key and retries if this candidate already exists.
// `now`/`randomToken` are injected so the generator stays pure + testable.
export function generateAiClipId(now: number, randomToken: string): string {
    const seed = `${Number.isFinite(now) && now > 0 ? Math.floor(now) : 0}:${String(randomToken || '')}`
    let hash = 2166136261
    for (let i = 0; i < seed.length; i += 1) {
        hash ^= seed.charCodeAt(i)
        hash = Math.imul(hash, 16777619) >>> 0
    }
    return String(1000000 + (hash % 9000000))
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

// ── Processing handoff (pure helpers) ───────────────────────────────────────────────────
// AI clips reuse the legacy `_queue/` durable-queue contract drained by processNextInQueue:
// a job is `{ id, videoUrl, chatId, shopeeLink?, lazadaLink?, status:'queued', createdAt }`.
// The pipeline recognizes an INTERNAL original asset URL (`/api/gallery/:id/asset/original`)
// and pulls the already-uploaded `videos/{id}_original.mp4` straight from R2 — no re-download,
// no _inbox record, no Facebook/ads side effects. These helpers are pure so the enqueue
// decision + job shape can be unit-tested; the route in index.ts does the R2 I/O.

export type AiClipProcessDecisionKind =
    | 'queue'
    | 'skipped_processed'
    | 'skipped_in_flight'
    | 'blocked_missing_links'

export type AiClipProcessDecision = {
    kind: AiClipProcessDecisionKind
    // Stable machine reason surfaced verbatim in the per-id response.
    reason: string
}

// Classify ONE AI clip for processing given the externally-observed in-flight state and
// whether the namespace's pipeline requires paired product links. Pure: callers pass
// `inFlight` (a `_queue/`/`_processing/` record already exists) so the I/O stays in index.ts.
//   - already processed → skip (never re-queue a finished clip)
//   - already queued/processing → skip (never duplicate an in-flight job)
//   - links required but missing → block with `missing_product_links` (no doomed job)
//   - otherwise → queue
export function decideAiClipProcessing(
    record: Pick<AiClipRecord, 'processedAt' | 'shopeeLink' | 'lazadaLink'>,
    ctx: { inFlight: boolean; requireProductLinks: boolean },
): AiClipProcessDecision {
    if (isAiClipProcessed(record)) return { kind: 'skipped_processed', reason: 'already_processed' }
    if (ctx.inFlight) return { kind: 'skipped_in_flight', reason: 'already_queued_or_processing' }
    if (ctx.requireProductLinks) {
        const hasShopee = !!sanitizeAiClipLink(record.shopeeLink)
        const hasLazada = !!sanitizeAiClipLink(record.lazadaLink)
        if (!hasShopee || !hasLazada) {
            return { kind: 'blocked_missing_links', reason: 'missing_product_links' }
        }
    }
    return { kind: 'queue', reason: 'queued' }
}

// Internal original-asset URL the pipeline pulls the source MP4 from. Reuses the same
// namespace-scoped /api/gallery/:id/asset/original route the upload/list responses serve.
export function aiClipProcessingSourceUrl(
    record: Pick<AiClipRecord, 'id'>,
    params: { workerUrl: string; namespaceId: string },
): string {
    return galleryAssetUrl(params.workerUrl, params.namespaceId, record.id, 'original')
}

export type AiClipQueueJob = {
    id: string
    videoUrl: string
    // No Telegram chat for operator uploads — 0 suppresses the completion DM in /api/gallery/refresh.
    chatId: number
    shopeeLink: string
    lazadaLink: string
    status: 'queued'
    createdAt: string
    // Provenance so completion code can recognize an AI clip without a separate lookup.
    sourceType: typeof AI_CLIP_SOURCE_TYPE
    sourceLabel: string
}

// Build the durable `_queue/` job for an AI clip. Returns null when the internal source URL
// cannot be built (missing worker URL / namespace / id) so the caller reports an explicit
// error instead of queuing an unrunnable job. Product links are preserved verbatim.
export function buildAiClipProcessingQueueJob(
    record: AiClipRecord,
    params: { workerUrl: string; namespaceId: string; nowIso: string },
): AiClipQueueJob | null {
    const id = sanitizeAiClipId(record.id)
    const videoUrl = aiClipProcessingSourceUrl(record, params)
    if (!id || !videoUrl) return null
    return {
        id,
        videoUrl,
        chatId: 0,
        shopeeLink: sanitizeAiClipLink(record.shopeeLink),
        lazadaLink: sanitizeAiClipLink(record.lazadaLink),
        status: 'queued',
        createdAt: String(params.nowIso || '').trim() || new Date(0).toISOString(),
        sourceType: AI_CLIP_SOURCE_TYPE,
        sourceLabel: String(record.sourceLabel || '').trim() || AI_CLIP_SOURCE_LABEL,
    }
}

function galleryAssetUrl(workerUrl: string, namespaceId: string, id: string, variant: 'original' | 'original-thumb' | 'public'): string {
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
    const publicUrl = processed ? galleryAssetUrl(params.workerUrl, params.namespaceId, record.id, 'public') : ''
    const playbackUrl = publicUrl || originalUrl
    const shopeeLink = sanitizeAiClipLink(record.shopeeLink)
    const lazadaLink = sanitizeAiClipLink(record.lazadaLink)
    return {
        id: record.id,
        video_id: record.id,
        title: record.title || record.id,
        status: processed ? 'processed' : 'unprocessed',
        sourceType: AI_CLIP_SOURCE_TYPE,
        source_type: AI_CLIP_SOURCE_TYPE,
        sourceLabel: record.sourceLabel,
        source_label: record.sourceLabel,
        namespace_id: String(params.namespaceId || '').trim(),
        namespaceId: String(params.namespaceId || '').trim(),
        originalUrl,
        original_url: originalUrl,
        videoUrl: playbackUrl,
        video_url: playbackUrl,
        previewUrl: playbackUrl,
        preview_url: playbackUrl,
        publicUrl,
        public_url: publicUrl,
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
