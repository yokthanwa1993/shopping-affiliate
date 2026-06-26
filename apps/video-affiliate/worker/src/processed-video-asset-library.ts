export const PROCESSED_VIDEO_ASSET_LIBRARY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS processed_video_asset_library (
    namespace_id TEXT NOT NULL,
    system_video_id TEXT NOT NULL,
    ad_account TEXT NOT NULL,
    advideo_id TEXT NOT NULL DEFAULT '',
    advideo_status TEXT NOT NULL DEFAULT '',
    file_url TEXT NOT NULL DEFAULT '',
    upload_status TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    uploaded_at TEXT NOT NULL DEFAULT '',
    last_checked_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (namespace_id, system_video_id, ad_account)
)`

export const PROCESSED_VIDEO_ASSET_LIBRARY_ADVIDEO_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_processed_video_asset_library_advideo
ON processed_video_asset_library(ad_account, advideo_id)`

function normalizeText(value: unknown): string {
    return String(value == null ? '' : value).trim()
}

export function parseProcessedVideoR2Key(key: string): string | null {
    const normalizedKey = normalizeText(key)
    const match = normalizedKey.match(/^videos\/([^/]+)\.(?:json|mp4)$/i)
    if (!match) return null

    const videoId = normalizeText(match[1])
    if (!videoId) return null
    if (/(?:^|_)(?:original|line_original|thumb|thumbnail)$/i.test(videoId)) return null
    if (/_original$|_line_original$|_thumb$|_thumbnail$/i.test(videoId)) return null

    return videoId
}

export function buildProcessedVideoAssetFileUrl(workerUrl: string, namespaceId: string, videoId: string): string {
    const base = normalizeText(workerUrl).replace(/\/+$/, '')
    const namespace = normalizeText(namespaceId)
    const id = normalizeText(videoId)
    if (!base || !namespace || !id) return ''
    return `${base}/api/gallery/${encodeURIComponent(id)}/asset/public?namespace_id=${encodeURIComponent(namespace)}`
}

function readNestedStatus(value: unknown, keys: string[]): string {
    if (!value || typeof value !== 'object') return ''
    let current: unknown = value
    for (const key of keys) {
        if (!current || typeof current !== 'object') return ''
        current = (current as Record<string, unknown>)[key]
    }
    if (current && typeof current === 'object') return ''
    return normalizeText(current)
}

export function normalizeMetaVideoStatus(response: unknown): string {
    if (!response || typeof response !== 'object') return ''
    const data = response as Record<string, unknown>
    const status = data.status

    if (typeof status === 'string') return normalizeText(status)

    const candidates = [
        readNestedStatus(status, ['video_status']),
        readNestedStatus(status, ['processing']),
        readNestedStatus(status, ['processing', 'status']),
        readNestedStatus(status, ['processing_phase', 'status']),
        readNestedStatus(status, ['uploading']),
        readNestedStatus(status, ['uploading', 'status']),
        readNestedStatus(status, ['uploading_phase', 'status']),
        readNestedStatus(status, ['publishing']),
        readNestedStatus(status, ['publishing', 'status']),
        readNestedStatus(status, ['publishing_phase', 'status']),
        normalizeText(data.video_status),
        normalizeText(data.processing),
        normalizeText(data.uploading),
    ]

    return candidates.find(Boolean) || ''
}

// Shape returned to the dashboard "คลังสื่อ" UI. Deliberately excludes any
// token/secret column — the source table has none, but we map field-by-field
// so a future schema addition can never leak through this projection.
export type VideoMediaLibraryItem = {
    namespace_id: string
    system_video_id: string
    ad_account: string
    advideo_id: string
    advideo_status: string
    upload_status: string
    error: string
    file_url: string
    uploaded_at: string
    last_checked_at: string
    created_at: string
    updated_at: string
}

// Pure mapper: raw processed_video_asset_library D1 row → public item. The error
// column is re-sanitized on the way out (defence in depth — it is sanitized on
// write too) so no access token can ever reach the client through a stored row.
export function mapProcessedVideoAssetLibraryItem(row: unknown): VideoMediaLibraryItem {
    const r = (row && typeof row === 'object') ? row as Record<string, unknown> : {}
    const rawError = normalizeText(r.error)
    return {
        namespace_id: normalizeText(r.namespace_id),
        system_video_id: normalizeText(r.system_video_id),
        ad_account: normalizeText(r.ad_account),
        advideo_id: normalizeText(r.advideo_id),
        advideo_status: normalizeText(r.advideo_status),
        upload_status: normalizeText(r.upload_status),
        error: rawError ? sanitizeMetaGraphError(rawError) : '',
        file_url: normalizeText(r.file_url),
        uploaded_at: normalizeText(r.uploaded_at),
        last_checked_at: normalizeText(r.last_checked_at),
        created_at: normalizeText(r.created_at),
        updated_at: normalizeText(r.updated_at),
    }
}

// Defence-in-depth for a Meta CDN URL that the dashboard will use as a <video src>/poster. Graph's
// scontent…fbcdn.net source/thumbnail URLs carry only short-lived oh/oe signing params (NOT an
// access_token), but if a token ever appeared in a URL we strip it before it can reach the client.
export function sanitizeMetaSourceUrl(url: unknown): string {
    const raw = normalizeText(url)
    if (!raw) return ''
    return raw
        .replace(/([?#&]access_token=)[^&#\s]+/gi, '$1[REDACTED]')
        .replace(/([?#&]token=)[^&#\s]+/gi, '$1[REDACTED]')
        .replace(/\bEA[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
        .slice(0, 2000)
}

// Resolved REAL Meta/Facebook media fields, merged onto a library item so the dashboard plays the
// genuine source instead of the system file_url. Token-free by construction: only source/thumbnail/
// status/permalink, with every URL run through sanitizeMetaSourceUrl. Empty strings when absent.
export type ResolvedMetaVideoFields = {
    meta_source_url: string
    meta_thumbnail_url: string
    meta_video_status: string
    meta_permalink_url: string
    meta_publish_status: string
}

// Pure projection of the cloak bridge `/media-library/resolve` response into the safe meta_* subset.
// Accepts snake/camel and the bare Graph `source` alias; never copies through any unknown field.
export function projectResolvedMetaVideoFields(raw: unknown): ResolvedMetaVideoFields {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
    return {
        meta_source_url: sanitizeMetaSourceUrl(r.meta_source_url ?? r.metaSourceUrl ?? r.source),
        meta_thumbnail_url: sanitizeMetaSourceUrl(r.meta_thumbnail_url ?? r.metaThumbnailUrl ?? r.thumbnail_url),
        meta_video_status: normalizeText(r.meta_video_status ?? r.video_status ?? r.metaVideoStatus),
        meta_permalink_url: sanitizeMetaSourceUrl(r.meta_permalink_url ?? r.permalink_url ?? r.metaPermalinkUrl),
        meta_publish_status: normalizeText(r.meta_publish_status ?? r.publish_status ?? r.metaPublishStatus),
    }
}

// True when the resolve actually yielded a playable Meta source — used to decide whether to merge.
export function hasResolvedMetaSource(fields: ResolvedMetaVideoFields | null | undefined): boolean {
    return !!(fields && fields.meta_source_url)
}

export function sanitizeMetaGraphError(error: unknown): string {
    const raw = error instanceof Error ? error.message : normalizeText(error)
    const sanitized = raw
        .replace(/access_token=([^&\s]+)/gi, 'access_token=[REDACTED]')
        .replace(/(["']?access_token["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi, '$1[REDACTED]')
        .replace(/\bEA[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
        .replace(/\s+/g, ' ')
        .trim()
    return (sanitized || 'unknown_error').slice(0, 1000)
}
