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
