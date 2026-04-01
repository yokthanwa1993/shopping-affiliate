import type { Env } from './pipeline'
import { BotBucket } from './utils/botBucket'

export type GalleryIndexLinkFilter = 'all' | 'with-link' | 'no-link'

export type GalleryIndexVideo = {
    id: string
    namespace_id: string
    owner_email?: string
    script: string
    duration: number
    originalUrl: string
    createdAt: string
    updatedAt: string
    publicUrl: string
    thumbnailUrl?: string
    shopeeLink?: string
    lazadaLink?: string
    shopeeOriginalLink?: string
    lazadaOriginalLink?: string
    shopeeConvertedAt?: string
    lazadaConvertedAt?: string
    lazadaMemberId?: string
    category?: string
    title?: string
    original_only?: boolean
}

type GalleryIndexDbRow = {
    namespace_id?: string
    video_id?: string
    owner_email?: string
    script?: string
    title?: string
    category?: string
    duration?: number
    shopee_link?: string
    lazada_link?: string
    shopee_original_link?: string
    lazada_original_link?: string
    shopee_converted_at?: string
    lazada_converted_at?: string
    lazada_member_id?: string
    public_url?: string
    original_url?: string
    thumbnail_url?: string
    created_at?: string
    updated_at?: string
    is_original_only?: number
    has_public_video?: number
    has_original_video?: number
}

type GalleryIndexUpsertRow = {
    namespaceId: string
    videoId: string
    ownerEmail: string
    isOwnerLinked: number
    script: string
    title: string
    category: string
    duration: number
    shopeeLink: string
    lazadaLink: string
    shopeeOriginalLink: string
    lazadaOriginalLink: string
    shopeeConvertedAt: string
    lazadaConvertedAt: string
    lazadaMemberId: string
    hasLink: number
    publicUrl: string
    originalUrl: string
    thumbnailUrl: string
    hasThumbnail: number
    hasPublicVideo: number
    hasOriginalVideo: number
    hasMetadata: number
    isOriginalOnly: number
    createdAt: string
    updatedAt: string
}

type GalleryScanEntry = {
    namespaceId: string
    videoId: string
    hasMetadata: boolean
    hasPublicVideo: boolean
    hasOriginalVideo: boolean
    hasThumbnail: boolean
    metaUploadedAt?: string
    publicUploadedAt?: string
    originalUploadedAt?: string
}

type BuildRowKnownState = {
    hasMetadata?: boolean
    hasPublicVideo?: boolean
    hasOriginalVideo?: boolean
    hasThumbnail?: boolean
    metaUploadedAt?: string
    publicUploadedAt?: string
    originalUploadedAt?: string
}

export type GalleryIndexPageResult = {
    videos: GalleryIndexVideo[]
    total: number
    withLinkTotal: number
    withoutLinkTotal: number
}

export type GalleryIndexSummary = {
    total: number
    ownerLinkedTotal: number
    ownerLinkedWithLink: number
    ownerLinkedWithoutLink: number
    missingThumbnailTotal: number
    missingOwnerLinkedThumbnailTotal: number
}

export type GalleryIndexRebuildResult = GalleryIndexSummary & {
    scannedVideos: number
    upserted: number
    deleted: number
}

export type GalleryThumbnailBackfillItem = {
    namespace_id: string
    video_id: string
    thumbnail_url: string
}

let ensureGalleryIndexTablePromise: Promise<void> | null = null

const SHOPEE_LINK_KEYS = ['shopeeLink', 'shopee_link', 'shopeeUrl', 'shopee_url', 'shopee', 'link'] as const
const SHOPEE_LINK_RE = /https?:\/\/(?:[^"\s<>]+\.)*shopee\.(?:co\.th|co\.id|com\.my|ph|sg|vn)\S*/i
const LAZADA_LINK_KEYS = ['lazadaLink', 'lazada_link', 'lazadaUrl', 'lazada_url', 'lazada'] as const
const LAZADA_LINK_RE = /https?:\/\/(?:[^"\s<>]+\.)*(?:lazada\.(?:co\.th|co\.id|com\.my|com\.ph|sg|vn)|lzd\.co)\S*/i
const UPSERT_GALLERY_INDEX_SQL = `INSERT INTO gallery_index (
    namespace_id,
    video_id,
    owner_email,
    is_owner_linked,
    script,
    title,
    category,
    duration,
    shopee_link,
    lazada_link,
    shopee_original_link,
    lazada_original_link,
    shopee_converted_at,
    lazada_converted_at,
    lazada_member_id,
    has_link,
    public_url,
    original_url,
    thumbnail_url,
    has_thumbnail,
    has_public_video,
    has_original_video,
    has_metadata,
    is_original_only,
    created_at,
    updated_at,
    last_synced_at
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(namespace_id, video_id) DO UPDATE SET
    owner_email = excluded.owner_email,
    is_owner_linked = excluded.is_owner_linked,
    script = excluded.script,
    title = excluded.title,
    category = excluded.category,
    duration = excluded.duration,
    shopee_link = excluded.shopee_link,
    lazada_link = excluded.lazada_link,
    shopee_original_link = excluded.shopee_original_link,
    lazada_original_link = excluded.lazada_original_link,
    shopee_converted_at = excluded.shopee_converted_at,
    lazada_converted_at = excluded.lazada_converted_at,
    lazada_member_id = excluded.lazada_member_id,
    has_link = excluded.has_link,
    public_url = excluded.public_url,
    original_url = excluded.original_url,
    thumbnail_url = excluded.thumbnail_url,
    has_thumbnail = excluded.has_thumbnail,
    has_public_video = excluded.has_public_video,
    has_original_video = excluded.has_original_video,
    has_metadata = excluded.has_metadata,
    is_original_only = excluded.is_original_only,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    last_synced_at = datetime('now')`

function normalizeText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function parseFiniteNumber(value: unknown, fallback = 0): number {
    const next = Number(value)
    return Number.isFinite(next) ? next : fallback
}

function buildScopedVideoAssetUrl(r2BaseUrl: string, namespaceId: string, fileName: string): string {
    const base = String(r2BaseUrl || '').replace(/\/+$/, '')
    const ns = String(namespaceId || '').trim()
    if (!base || !ns) return ''
    return ns === 'default'
        ? `${base}/videos/${fileName}`
        : `${base}/${ns}/videos/${fileName}`
}

export function getVideoPublicUrlForNamespace(r2BaseUrl: string, namespaceId: string, videoId: string): string {
    return buildScopedVideoAssetUrl(r2BaseUrl, namespaceId, `${videoId}.mp4`)
}

export function getVideoOriginalUrlForNamespace(r2BaseUrl: string, namespaceId: string, videoId: string): string {
    return buildScopedVideoAssetUrl(r2BaseUrl, namespaceId, `${videoId}_original.mp4`)
}

export function getVideoThumbnailUrlForNamespace(r2BaseUrl: string, namespaceId: string, videoId: string): string {
    return buildScopedVideoAssetUrl(r2BaseUrl, namespaceId, `${videoId}_thumb.webp`)
}

export function getVideoOriginalThumbnailUrlForNamespace(r2BaseUrl: string, namespaceId: string, videoId: string): string {
    return buildScopedVideoAssetUrl(r2BaseUrl, namespaceId, `${videoId}_original_thumb.webp`)
}

function pickFirstShopeeUrl(value: unknown): string | null {
    if (typeof value === 'string') {
        const match = value.match(SHOPEE_LINK_RE)
        return match ? match[0].trim() : null
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const hit = pickFirstShopeeUrl(item)
            if (hit) return hit
        }
    }
    return null
}

function pickFirstLazadaUrl(value: unknown): string | null {
    if (typeof value === 'string') {
        const match = value.match(LAZADA_LINK_RE)
        return match ? match[0].trim() : null
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const hit = pickFirstLazadaUrl(item)
            if (hit) return hit
        }
    }
    return null
}

function normalizeMetaShopeeLink(meta: Record<string, unknown>): string {
    for (const key of SHOPEE_LINK_KEYS) {
        const value = meta[key]
        const found = pickFirstShopeeUrl(value)
        if (found) return found
    }
    return ''
}

function normalizeMetaLazadaLink(meta: Record<string, unknown>): string {
    for (const key of LAZADA_LINK_KEYS) {
        const value = meta[key]
        const found = pickFirstLazadaUrl(value)
        if (found) return found
    }
    return ''
}

function normalizeTimestamp(...candidates: unknown[]): string {
    for (const candidate of candidates) {
        const raw = String(candidate || '').trim()
        if (!raw) continue
        const ms = new Date(raw).getTime()
        if (Number.isFinite(ms)) return new Date(ms).toISOString()
        return raw
    }
    return new Date().toISOString()
}

function mapGalleryIndexRowToVideo(row: GalleryIndexDbRow): GalleryIndexVideo | null {
    const id = normalizeText(row.video_id)
    const namespaceId = normalizeText(row.namespace_id)
    if (!id || !namespaceId) return null

    return {
        id,
        namespace_id: namespaceId,
        owner_email: normalizeText(row.owner_email),
        script: normalizeText(row.script),
        duration: parseFiniteNumber(row.duration, 0),
        originalUrl: normalizeText(row.original_url),
        createdAt: normalizeTimestamp(row.created_at),
        updatedAt: normalizeTimestamp(row.updated_at, row.created_at),
        publicUrl: normalizeText(row.public_url),
        thumbnailUrl: normalizeText(row.thumbnail_url) || undefined,
        shopeeLink: normalizeText(row.shopee_link) || undefined,
        lazadaLink: normalizeText(row.lazada_link) || undefined,
        shopeeOriginalLink: normalizeText(row.shopee_original_link) || undefined,
        lazadaOriginalLink: normalizeText(row.lazada_original_link) || undefined,
        shopeeConvertedAt: normalizeText(row.shopee_converted_at) || undefined,
        lazadaConvertedAt: normalizeText(row.lazada_converted_at) || undefined,
        lazadaMemberId: normalizeText(row.lazada_member_id) || undefined,
        category: normalizeText(row.category) || undefined,
        title: normalizeText(row.title) || undefined,
        original_only: Number(row.is_original_only || 0) === 1 || undefined,
    }
}

function hasPlayableGalleryAssetRow(row: GalleryIndexDbRow): boolean {
    return Number(row.has_public_video || 0) === 1 || Number(row.has_original_video || 0) === 1
}

export async function ensureGalleryIndexTable(db: D1Database): Promise<void> {
    if (ensureGalleryIndexTablePromise) {
        await ensureGalleryIndexTablePromise
        return
    }

    ensureGalleryIndexTablePromise = (async () => {
        await db.prepare(
            `CREATE TABLE IF NOT EXISTS gallery_index (
                namespace_id TEXT NOT NULL,
                video_id TEXT NOT NULL,
                owner_email TEXT NOT NULL DEFAULT '',
                is_owner_linked INTEGER NOT NULL DEFAULT 0,
                script TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                duration REAL NOT NULL DEFAULT 0,
                shopee_link TEXT NOT NULL DEFAULT '',
                lazada_link TEXT NOT NULL DEFAULT '',
                shopee_original_link TEXT NOT NULL DEFAULT '',
                lazada_original_link TEXT NOT NULL DEFAULT '',
                shopee_converted_at TEXT NOT NULL DEFAULT '',
                lazada_converted_at TEXT NOT NULL DEFAULT '',
                lazada_member_id TEXT NOT NULL DEFAULT '',
                has_link INTEGER NOT NULL DEFAULT 0,
                public_url TEXT NOT NULL DEFAULT '',
                original_url TEXT NOT NULL DEFAULT '',
                thumbnail_url TEXT NOT NULL DEFAULT '',
                has_thumbnail INTEGER NOT NULL DEFAULT 0,
                has_public_video INTEGER NOT NULL DEFAULT 0,
                has_original_video INTEGER NOT NULL DEFAULT 0,
                has_metadata INTEGER NOT NULL DEFAULT 0,
                is_original_only INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (namespace_id, video_id)
            )`
        ).run()

        await db.prepare(
            'ALTER TABLE gallery_index ADD COLUMN lazada_link TEXT NOT NULL DEFAULT \'\''
        ).run().catch(() => { })
        await db.prepare(
            'ALTER TABLE gallery_index ADD COLUMN shopee_original_link TEXT NOT NULL DEFAULT \'\''
        ).run().catch(() => { })
        await db.prepare(
            'ALTER TABLE gallery_index ADD COLUMN lazada_original_link TEXT NOT NULL DEFAULT \'\''
        ).run().catch(() => { })
        await db.prepare(
            'ALTER TABLE gallery_index ADD COLUMN shopee_converted_at TEXT NOT NULL DEFAULT \'\''
        ).run().catch(() => { })
        await db.prepare(
            'ALTER TABLE gallery_index ADD COLUMN lazada_converted_at TEXT NOT NULL DEFAULT \'\''
        ).run().catch(() => { })
        await db.prepare(
            'ALTER TABLE gallery_index ADD COLUMN lazada_member_id TEXT NOT NULL DEFAULT \'\''
        ).run().catch(() => { })

        await db.prepare(
            'CREATE INDEX IF NOT EXISTS idx_gallery_index_owner_link_updated ON gallery_index(is_owner_linked, has_link, updated_at DESC, created_at DESC)'
        ).run()
        await db.prepare(
            'CREATE INDEX IF NOT EXISTS idx_gallery_index_owner_thumb_updated ON gallery_index(is_owner_linked, has_thumbnail, updated_at DESC, created_at DESC)'
        ).run()
        await db.prepare(
            'CREATE INDEX IF NOT EXISTS idx_gallery_index_namespace_updated ON gallery_index(namespace_id, updated_at DESC, created_at DESC)'
        ).run()
    })()

    try {
        await ensureGalleryIndexTablePromise
    } catch (error) {
        ensureGalleryIndexTablePromise = null
        throw error
    }
}

async function resolveOwnerEmailForNamespace(db: D1Database, namespaceId: string, cache?: Map<string, string>): Promise<string> {
    const normalizedNamespaceId = String(namespaceId || '').trim()
    if (!normalizedNamespaceId) return ''
    if (cache?.has(normalizedNamespaceId)) return String(cache.get(normalizedNamespaceId) || '')

    const fromMapping = await db.prepare(
        'SELECT email FROM email_namespaces WHERE namespace_id = ? ORDER BY email ASC LIMIT 1'
    ).bind(normalizedNamespaceId).first() as { email?: string } | null
    const mappedEmail = normalizeText(fromMapping?.email).toLowerCase()
    if (mappedEmail) {
        cache?.set(normalizedNamespaceId, mappedEmail)
        return mappedEmail
    }

    const fromAllowed = await db.prepare(
        `SELECT u.email
         FROM users u
         INNER JOIN allowed_emails ae ON ae.email = u.email
         WHERE u.namespace_id = ?
           AND TRIM(COALESCE(u.email, '')) <> ''
         ORDER BY datetime(u.created_at) ASC, u.rowid ASC
         LIMIT 1`
    ).bind(normalizedNamespaceId).first() as { email?: string } | null
    const allowedEmail = normalizeText(fromAllowed?.email).toLowerCase()
    if (allowedEmail) {
        cache?.set(normalizedNamespaceId, allowedEmail)
        return allowedEmail
    }

    const fallback = await db.prepare(
        `SELECT email
         FROM users
         WHERE namespace_id = ?
           AND TRIM(COALESCE(email, '')) <> ''
         ORDER BY datetime(created_at) ASC, rowid ASC
         LIMIT 1`
    ).bind(normalizedNamespaceId).first() as { email?: string } | null
    const fallbackEmail = normalizeText(fallback?.email).toLowerCase()
    if (fallbackEmail) {
        cache?.set(normalizedNamespaceId, fallbackEmail)
        return fallbackEmail
    }

    cache?.set(normalizedNamespaceId, '')
    return ''
}

function parseGalleryScanKey(key: string): { namespaceId: string; videoId: string; kind: 'meta' | 'public' | 'original' | 'thumb' | 'original-thumb' } | null {
    const raw = String(key || '').trim()
    if (!raw) return null

    let namespaceId = ''
    let rest = ''

    const scopedMatch = raw.match(/^([^/]+)\/videos\/(.+)$/)
    if (scopedMatch) {
        namespaceId = normalizeText(scopedMatch[1])
        rest = String(scopedMatch[2] || '')
    } else {
        const defaultMatch = raw.match(/^videos\/(.+)$/)
        if (!defaultMatch) return null
        namespaceId = 'default'
        rest = String(defaultMatch[1] || '')
    }

    if (!namespaceId || !rest) return null

    if (rest.endsWith('_original_thumb.webp')) {
        return {
            namespaceId,
            videoId: rest.slice(0, -'_original_thumb.webp'.length),
            kind: 'original-thumb',
        }
    }
    if (rest.endsWith('_original.mp4')) {
        return {
            namespaceId,
            videoId: rest.slice(0, -'_original.mp4'.length),
            kind: 'original',
        }
    }
    if (rest.endsWith('_thumb.webp')) {
        return {
            namespaceId,
            videoId: rest.slice(0, -'_thumb.webp'.length),
            kind: 'thumb',
        }
    }
    if (rest.endsWith('.json')) {
        return {
            namespaceId,
            videoId: rest.slice(0, -'.json'.length),
            kind: 'meta',
        }
    }
    if (rest.endsWith('.mp4')) {
        return {
            namespaceId,
            videoId: rest.slice(0, -'.mp4'.length),
            kind: 'public',
        }
    }
    return null
}

async function scanAllGalleryVideos(bucket: R2Bucket): Promise<GalleryScanEntry[]> {
    const byVideo = new Map<string, GalleryScanEntry>()
    let cursor: string | undefined = undefined

    do {
        const page = await bucket.list(cursor ? { prefix: '', cursor } : { prefix: '' })
        for (const obj of page.objects || []) {
            const parsed = parseGalleryScanKey(String(obj.key || ''))
            if (!parsed?.videoId) continue
            const dedupeKey = `${parsed.namespaceId}:${parsed.videoId}`
            const existing = byVideo.get(dedupeKey) || {
                namespaceId: parsed.namespaceId,
                videoId: parsed.videoId,
                hasMetadata: false,
                hasPublicVideo: false,
                hasOriginalVideo: false,
                hasThumbnail: false,
            }

            if (parsed.kind === 'original-thumb') {
                byVideo.set(dedupeKey, existing)
                continue
            }

            const uploadedAt = obj.uploaded.toISOString()
            if (parsed.kind === 'meta') {
                existing.hasMetadata = true
                existing.metaUploadedAt = uploadedAt
            } else if (parsed.kind === 'public') {
                existing.hasPublicVideo = true
                existing.publicUploadedAt = uploadedAt
            } else if (parsed.kind === 'original') {
                existing.hasOriginalVideo = true
                existing.originalUploadedAt = uploadedAt
            } else if (parsed.kind === 'thumb') {
                existing.hasThumbnail = true
            }

            byVideo.set(dedupeKey, existing)
        }
        cursor = page.truncated ? page.cursor : undefined
    } while (cursor)

    return Array.from(byVideo.values())
}

async function buildGalleryIndexUpsertRow(params: {
    env: Env
    namespaceId: string
    videoId: string
    ownerEmailCache?: Map<string, string>
    knownState?: BuildRowKnownState
}): Promise<GalleryIndexUpsertRow | null> {
    const namespaceId = normalizeText(params.namespaceId)
    const videoId = normalizeText(params.videoId)
    if (!namespaceId || !videoId) return null

    const bucket = new BotBucket(params.env.BUCKET, namespaceId) as unknown as R2Bucket
    const knownState = params.knownState || {}
    const metaObjPromise = knownState.hasMetadata === false
        ? Promise.resolve(null)
        : bucket.get(`videos/${videoId}.json`).catch(() => null)
    const originalHeadPromise = knownState.hasOriginalVideo === false
        ? Promise.resolve(null)
        : bucket.head(`videos/${videoId}_original.mp4`).catch(() => null)
    const publicHeadPromise = knownState.hasPublicVideo === false
        ? Promise.resolve(null)
        : bucket.head(`videos/${videoId}.mp4`).catch(() => null)
    const thumbHeadPromise = knownState.hasThumbnail === false
        ? Promise.resolve(null)
        : bucket.head(`videos/${videoId}_thumb.webp`).catch(() => null)

    const [metaObj, originalObj, publicObj, thumbObj] = await Promise.all([
        metaObjPromise,
        originalHeadPromise,
        publicHeadPromise,
        thumbHeadPromise,
    ])

    const hasMetadata = !!metaObj
    const hasOriginalVideo = !!originalObj || !!knownState.hasOriginalVideo
    const hasPublicVideo = !!publicObj || !!knownState.hasPublicVideo
    const hasThumbnail = !!thumbObj || !!knownState.hasThumbnail
    if (!hasOriginalVideo && !hasPublicVideo) return null

    let meta: Record<string, unknown> = {}
    if (metaObj) {
        try {
            meta = await metaObj.json() as Record<string, unknown>
        } catch {
            meta = {}
        }
    }

    const ownerEmail = await resolveOwnerEmailForNamespace(params.env.DB, namespaceId, params.ownerEmailCache)
    const derivedOriginalUrl = hasOriginalVideo
        ? getVideoOriginalUrlForNamespace(params.env.R2_PUBLIC_URL, namespaceId, videoId)
        : ''
    const derivedPublicUrl = hasPublicVideo
        ? getVideoPublicUrlForNamespace(params.env.R2_PUBLIC_URL, namespaceId, videoId)
        : ''
    const derivedThumbnailUrl = hasThumbnail
        ? getVideoThumbnailUrlForNamespace(params.env.R2_PUBLIC_URL, namespaceId, videoId)
        : ''

    const originalUrl = hasOriginalVideo
        ? (normalizeText(meta.originalUrl) || derivedOriginalUrl || derivedPublicUrl)
        : ''
    const publicUrl = hasPublicVideo
        ? (normalizeText(meta.publicUrl) || derivedPublicUrl)
        : ''
    const thumbnailUrl = normalizeText(meta.thumbnailUrl) || derivedThumbnailUrl
    const shopeeLink = normalizeMetaShopeeLink(meta)
    const lazadaLink = normalizeMetaLazadaLink(meta)
    const shopeeOriginalLink = pickFirstShopeeUrl(meta.shopeeOriginalLink || meta.shopee_original_link || '') || ''
    const lazadaOriginalLink = pickFirstLazadaUrl(meta.lazadaOriginalLink || meta.lazada_original_link || '') || ''
    const shopeeConvertedAt = normalizeText(meta.shopeeConvertedAt || meta.shopee_converted_at || '')
    const lazadaConvertedAt = normalizeText(meta.lazadaConvertedAt || meta.lazada_converted_at || '')
    const lazadaMemberId = normalizeText(meta.lazadaMemberId || meta.lazada_member_id || '')
    const createdAt = normalizeTimestamp(
        meta.createdAt,
        knownState.metaUploadedAt,
        metaObj?.uploaded?.toISOString?.(),
        knownState.publicUploadedAt,
        publicObj?.uploaded?.toISOString?.(),
        knownState.originalUploadedAt,
        originalObj?.uploaded?.toISOString?.(),
    )
    const updatedAt = normalizeTimestamp(
        meta.updatedAt,
        meta.createdAt,
        knownState.metaUploadedAt,
        metaObj?.uploaded?.toISOString?.(),
        knownState.publicUploadedAt,
        publicObj?.uploaded?.toISOString?.(),
        knownState.originalUploadedAt,
        originalObj?.uploaded?.toISOString?.(),
    )

    return {
        namespaceId,
        videoId,
        ownerEmail,
        isOwnerLinked: ownerEmail ? 1 : 0,
        script: normalizeText(meta.script),
        title: normalizeText(meta.title),
        category: normalizeText(meta.category),
        duration: Math.max(0, parseFiniteNumber(meta.duration, 0)),
        shopeeLink,
        lazadaLink,
        shopeeOriginalLink,
        lazadaOriginalLink,
        shopeeConvertedAt,
        lazadaConvertedAt,
        lazadaMemberId,
        hasLink: shopeeLink || lazadaLink ? 1 : 0,
        publicUrl,
        originalUrl: originalUrl || publicUrl,
        thumbnailUrl,
        hasThumbnail: thumbnailUrl ? 1 : 0,
        hasPublicVideo: hasPublicVideo ? 1 : 0,
        hasOriginalVideo: hasOriginalVideo ? 1 : 0,
        hasMetadata: hasMetadata ? 1 : 0,
        isOriginalOnly: hasMetadata ? 0 : (hasOriginalVideo && !hasPublicVideo ? 1 : 0),
        createdAt,
        updatedAt,
    }
}

async function upsertGalleryIndexRows(db: D1Database, rows: GalleryIndexUpsertRow[]): Promise<void> {
    if (rows.length === 0) return
    await ensureGalleryIndexTable(db)
    await db.batch(rows.map((row) => db.prepare(UPSERT_GALLERY_INDEX_SQL).bind(
        row.namespaceId,
        row.videoId,
        row.ownerEmail,
        row.isOwnerLinked,
        row.script,
        row.title,
        row.category,
        row.duration,
        row.shopeeLink,
        row.lazadaLink,
        row.shopeeOriginalLink,
        row.lazadaOriginalLink,
        row.shopeeConvertedAt,
        row.lazadaConvertedAt,
        row.lazadaMemberId,
        row.hasLink,
        row.publicUrl,
        row.originalUrl,
        row.thumbnailUrl,
        row.hasThumbnail,
        row.hasPublicVideo,
        row.hasOriginalVideo,
        row.hasMetadata,
        row.isOriginalOnly,
        row.createdAt,
        row.updatedAt,
    )))
}

async function deleteGalleryIndexRows(db: D1Database, keys: Array<{ namespaceId: string; videoId: string }>): Promise<void> {
    if (keys.length === 0) return
    await ensureGalleryIndexTable(db)
    await db.batch(keys.map((key) => db.prepare(
        'DELETE FROM gallery_index WHERE namespace_id = ? AND video_id = ?'
    ).bind(key.namespaceId, key.videoId)))
}

export async function syncGalleryIndexEntry(env: Env, namespaceId: string, videoId: string): Promise<GalleryIndexVideo | null> {
    await ensureGalleryIndexTable(env.DB)
    const row = await buildGalleryIndexUpsertRow({ env, namespaceId, videoId })
    if (!row) {
        await deleteGalleryIndexRows(env.DB, [{ namespaceId: normalizeText(namespaceId), videoId: normalizeText(videoId) }])
        return null
    }
    await upsertGalleryIndexRows(env.DB, [row])
    return mapGalleryIndexRowToVideo({
        namespace_id: row.namespaceId,
        video_id: row.videoId,
        owner_email: row.ownerEmail,
        script: row.script,
        title: row.title,
        category: row.category,
        duration: row.duration,
        shopee_link: row.shopeeLink,
        lazada_link: row.lazadaLink,
        shopee_original_link: row.shopeeOriginalLink,
        lazada_original_link: row.lazadaOriginalLink,
        shopee_converted_at: row.shopeeConvertedAt,
        lazada_converted_at: row.lazadaConvertedAt,
        lazada_member_id: row.lazadaMemberId,
        public_url: row.publicUrl,
        original_url: row.originalUrl,
        thumbnail_url: row.thumbnailUrl,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        is_original_only: row.isOriginalOnly,
    })
}

export async function deleteGalleryIndexEntry(db: D1Database, namespaceId: string, videoId: string): Promise<void> {
    await deleteGalleryIndexRows(db, [{ namespaceId: normalizeText(namespaceId), videoId: normalizeText(videoId) }])
}

function buildGalleryWhereClause(options: {
    onlyOwnerLinked?: boolean
    linkFilter?: GalleryIndexLinkFilter
    hasThumbnail?: boolean
    playableOnly?: boolean
    requirePublicVideo?: boolean
}) {
    const clauses: string[] = []
    const binds: Array<string | number> = []

    if (options.onlyOwnerLinked) clauses.push('is_owner_linked = 1')
    if (options.linkFilter === 'with-link') {
        clauses.push('has_link = 1')
    } else if (options.linkFilter === 'no-link') {
        clauses.push('has_link = 0')
    }
    if (options.hasThumbnail === true) clauses.push('has_thumbnail = 1')
    if (options.hasThumbnail === false) clauses.push('has_thumbnail = 0')
    if (options.requirePublicVideo) clauses.push('has_public_video = 1')
    if (options.playableOnly) clauses.push('(has_original_video = 1 OR has_public_video = 1)')

    return {
        whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
        binds,
    }
}

async function queryGalleryIndexCount(db: D1Database, options: {
    onlyOwnerLinked?: boolean
    linkFilter?: GalleryIndexLinkFilter
    hasThumbnail?: boolean
    playableOnly?: boolean
    requirePublicVideo?: boolean
}): Promise<number> {
    await ensureGalleryIndexTable(db)
    const { whereSql, binds } = buildGalleryWhereClause(options)
    const row = await db.prepare(
        `SELECT COUNT(*) AS total
         FROM gallery_index
         ${whereSql}`
    ).bind(...binds).first() as { total?: number } | null
    return Number(row?.total || 0)
}

export async function listGalleryIndexVideos(db: D1Database, options: {
    onlyOwnerLinked?: boolean
    linkFilter?: GalleryIndexLinkFilter
    playableOnly?: boolean
    requirePublicVideo?: boolean
} = {}): Promise<GalleryIndexVideo[]> {
    await ensureGalleryIndexTable(db)
    const { whereSql, binds } = buildGalleryWhereClause(options)
    const result = await db.prepare(
        `SELECT
            namespace_id,
            video_id,
            owner_email,
            script,
            title,
            category,
            duration,
            shopee_link,
            lazada_link,
            shopee_original_link,
            lazada_original_link,
            shopee_converted_at,
            lazada_converted_at,
            lazada_member_id,
            public_url,
            original_url,
            thumbnail_url,
            has_public_video,
            has_original_video,
            created_at,
            updated_at,
            is_original_only
         FROM gallery_index
         ${whereSql}
         ORDER BY COALESCE(updated_at, created_at) DESC, namespace_id ASC, video_id ASC`
    ).bind(...binds).all() as { results?: GalleryIndexDbRow[] }

    const videos: GalleryIndexVideo[] = []
    for (const row of result.results || []) {
        if (options.requirePublicVideo && Number(row.has_public_video || 0) !== 1) continue
        if (!hasPlayableGalleryAssetRow(row)) continue
        const video = mapGalleryIndexRowToVideo(row)
        if (video) videos.push(video)
    }
    return videos
}

export async function getGalleryIndexPage(db: D1Database, options: {
    offset: number
    limit: number
    onlyOwnerLinked?: boolean
    linkFilter?: GalleryIndexLinkFilter
    playableOnly?: boolean
    requirePublicVideo?: boolean
}): Promise<GalleryIndexPageResult> {
    await ensureGalleryIndexTable(db)
    const offset = Math.max(0, Number(options.offset || 0))
    const limit = Math.max(1, Number(options.limit || 24))
    const { whereSql, binds } = buildGalleryWhereClause(options)

    const [rowsRes, total, withLinkTotal, withoutLinkTotal] = await Promise.all([
        db.prepare(
            `SELECT
                namespace_id,
                video_id,
                owner_email,
                script,
                title,
                category,
                duration,
                shopee_link,
                lazada_link,
                shopee_original_link,
                lazada_original_link,
                shopee_converted_at,
                lazada_converted_at,
                lazada_member_id,
                public_url,
                original_url,
                thumbnail_url,
                has_public_video,
                has_original_video,
                created_at,
                updated_at,
                is_original_only
             FROM gallery_index
             ${whereSql}
             ORDER BY COALESCE(updated_at, created_at) DESC, namespace_id ASC, video_id ASC
             LIMIT ? OFFSET ?`
        ).bind(...binds, limit, offset).all() as Promise<{ results?: GalleryIndexDbRow[] }>,
        queryGalleryIndexCount(db, { onlyOwnerLinked: options.onlyOwnerLinked, linkFilter: 'all', playableOnly: options.playableOnly, requirePublicVideo: options.requirePublicVideo }),
        queryGalleryIndexCount(db, { onlyOwnerLinked: options.onlyOwnerLinked, linkFilter: 'with-link', playableOnly: options.playableOnly, requirePublicVideo: options.requirePublicVideo }),
        queryGalleryIndexCount(db, { onlyOwnerLinked: options.onlyOwnerLinked, linkFilter: 'no-link', playableOnly: options.playableOnly, requirePublicVideo: options.requirePublicVideo }),
    ])

    const videos: GalleryIndexVideo[] = []
    for (const row of rowsRes.results || []) {
        if (options.requirePublicVideo && Number(row.has_public_video || 0) !== 1) continue
        if (!hasPlayableGalleryAssetRow(row)) continue
        const video = mapGalleryIndexRowToVideo(row)
        if (video) videos.push(video)
    }

    return {
        videos,
        total,
        withLinkTotal,
        withoutLinkTotal,
    }
}

export async function getGalleryIndexSummary(db: D1Database): Promise<GalleryIndexSummary> {
    await ensureGalleryIndexTable(db)
    const [total, ownerLinkedTotal, ownerLinkedWithLink, ownerLinkedWithoutLink, missingThumbnailTotal, missingOwnerLinkedThumbnailTotal] = await Promise.all([
        queryGalleryIndexCount(db, {}),
        queryGalleryIndexCount(db, { onlyOwnerLinked: true, linkFilter: 'all' }),
        queryGalleryIndexCount(db, { onlyOwnerLinked: true, linkFilter: 'with-link' }),
        queryGalleryIndexCount(db, { onlyOwnerLinked: true, linkFilter: 'no-link' }),
        queryGalleryIndexCount(db, { hasThumbnail: false }),
        queryGalleryIndexCount(db, { onlyOwnerLinked: true, hasThumbnail: false }),
    ])

    return {
        total,
        ownerLinkedTotal,
        ownerLinkedWithLink,
        ownerLinkedWithoutLink,
        missingThumbnailTotal,
        missingOwnerLinkedThumbnailTotal,
    }
}

export async function rebuildGalleryIndexFromR2(env: Env): Promise<GalleryIndexRebuildResult> {
    await ensureGalleryIndexTable(env.DB)

    const scanEntries = await scanAllGalleryVideos(env.BUCKET)
    const ownerEmailCache = new Map<string, string>()
    const nextRows: GalleryIndexUpsertRow[] = []

    for (let i = 0; i < scanEntries.length; i += 25) {
        const slice = scanEntries.slice(i, i + 25)
        const built = await Promise.all(slice.map((entry) => buildGalleryIndexUpsertRow({
            env,
            namespaceId: entry.namespaceId,
            videoId: entry.videoId,
            ownerEmailCache,
            knownState: entry,
        })))
        nextRows.push(...built.filter((row): row is GalleryIndexUpsertRow => !!row))
    }

    for (let i = 0; i < nextRows.length; i += 100) {
        await upsertGalleryIndexRows(env.DB, nextRows.slice(i, i + 100))
    }

    const seenKeys = new Set(nextRows.map((row) => `${row.namespaceId}:${row.videoId}`))
    const existingRows = await env.DB.prepare(
        'SELECT namespace_id, video_id FROM gallery_index'
    ).all() as { results?: Array<{ namespace_id?: string; video_id?: string }> }

    const staleKeys: Array<{ namespaceId: string; videoId: string }> = []
    for (const row of existingRows.results || []) {
        const namespaceId = normalizeText(row.namespace_id)
        const videoId = normalizeText(row.video_id)
        if (!namespaceId || !videoId) continue
        const key = `${namespaceId}:${videoId}`
        if (!seenKeys.has(key)) {
            staleKeys.push({ namespaceId, videoId })
        }
    }

    for (let i = 0; i < staleKeys.length; i += 100) {
        await deleteGalleryIndexRows(env.DB, staleKeys.slice(i, i + 100))
    }

    const summary = await getGalleryIndexSummary(env.DB)
    return {
        scannedVideos: scanEntries.length,
        upserted: nextRows.length,
        deleted: staleKeys.length,
        ...summary,
    }
}

export async function listGalleryIndexVideosMissingThumbnails(db: D1Database, limit: number): Promise<GalleryThumbnailBackfillItem[]> {
    await ensureGalleryIndexTable(db)
    const safeLimit = Math.min(Math.max(1, Number(limit || 1)), 100)
    const result = await db.prepare(
        `SELECT namespace_id, video_id, thumbnail_url
         FROM gallery_index
         WHERE has_thumbnail = 0
           AND (has_original_video = 1 OR has_public_video = 1)
         ORDER BY COALESCE(updated_at, created_at) DESC, namespace_id ASC, video_id ASC
         LIMIT ?`
    ).bind(safeLimit).all() as { results?: Array<{ namespace_id?: string; video_id?: string; thumbnail_url?: string }> }

    return (result.results || [])
        .map((row) => ({
            namespace_id: normalizeText(row.namespace_id),
            video_id: normalizeText(row.video_id),
            thumbnail_url: normalizeText(row.thumbnail_url),
        }))
        .filter((row) => row.namespace_id && row.video_id)
}
