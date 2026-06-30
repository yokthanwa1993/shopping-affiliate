import { z } from 'zod'
import { workerFetchJson, WORKER_API_BASE, CHIEB_NAMESPACE_ID } from '@/api/client'

// Zod schema for GET /api/dashboard/facebook-page-videos (video-affiliate
// worker). The endpoint is cache-first/read-only; the response is loosely typed
// upstream, so every field is nullish and `.passthrough()` keeps any extra
// fields the worker adds later. This is the first typed contract of the
// migration — see docs/plans/full-system-modernization.md (Phase 3).

export const assetLibrarySchema = z
  .object({
    advideoId: z.string().nullish(),
    adAccount: z.string().nullish(),
    status: z.string().nullish(),
    orders1d: z.number().nullish(),
    orders7d: z.number().nullish(),
    commission7d: z.number().nullish(),
    sourceSubId: z.string().nullish(),
    lastSyncedAt: z.string().nullish(),
  })
  .passthrough()

export const pageVideoItemSchema = z
  .object({
    storyId: z.string().nullish(),
    pageName: z.string().nullish(),
    createdAt: z.string().nullish(),
    postedAt: z.string().nullish(),
    postUrl: z.string().nullish(),
    facebookThumb: z.string().nullish(),
    views: z.number().nullish(),
    videoId: z.string().nullish(),
    systemVideoId: z.string().nullish(),
    videoTitle: z.string().nullish(),
    videoUrl: z.string().nullish(),
    videoThumb: z.string().nullish(),
    adsetId: z.string().nullish(),
    shopeeLink: z.string().nullish(),
    postId: z.string().nullish(),
    assetLibrary: assetLibrarySchema.nullish(),
  })
  .passthrough()

export const pageVideosSyncSchema = z
  .object({
    nextAfter: z.string().nullish(),
    lastAttemptAt: z.string().nullish(),
    lastSyncedAt: z.string().nullish(),
    lastFullScanAt: z.string().nullish(),
    fullyScanned: z.boolean().nullish(),
    lastBatchCount: z.number().nullish(),
    lastError: z.string().nullish(),
  })
  .passthrough()

export const pageVideosResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    page_id: z.string().nullish(),
    page_name: z.string().nullish(),
    total: z.number().nullish(),
    sort: z.string().nullish(),
    order: z.string().nullish(),
    offset: z.number().nullish(),
    from_date: z.string().nullish(),
    to_date: z.string().nullish(),
    data_source: z.string().nullish(),
    items: z.array(pageVideoItemSchema).default([]),
    sync: pageVideosSyncSchema.nullish(),
  })
  .passthrough()

export type AssetLibrary = z.infer<typeof assetLibrarySchema>
export type PageVideoItem = z.infer<typeof pageVideoItemSchema>
export type PageVideosResponse = z.infer<typeof pageVideosResponseSchema>

export interface PageVideosQuery {
  pageId: string
  minViews?: number
  limit?: number
  offset?: number
  sort?: 'newest' | 'oldest'
}

export async function fetchPageVideos(
  params: PageVideosQuery,
  signal?: AbortSignal,
): Promise<PageVideosResponse> {
  const qs = new URLSearchParams()
  qs.set('page_id', params.pageId)
  if (params.minViews != null) qs.set('min_views', String(params.minViews))
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  if (params.sort) qs.set('sort', params.sort)
  const raw = await workerFetchJson<unknown>(
    `/api/dashboard/facebook-page-videos?${qs.toString()}`,
    { signal, timeoutMs: 30_000 },
  )
  return pageVideosResponseSchema.parse(raw)
}

// Mirrors the worker's sanitizeDownloadFilename so the suggested filename matches
// what apps/dashboard/src/worker.ts would set on Content-Disposition anyway.
export function sanitizeDownloadFilename(input: string | null | undefined): string {
  const raw = String(input ?? '').trim()
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 120)
  if (!cleaned) return 'video_original.mp4'
  return /\.mp4$/i.test(cleaned) ? cleaned : `${cleaned}.mp4`
}

// Build the force-attachment download URL for a system gallery asset. The path +
// `download=1` combination is exactly what the worker's shouldForceAttachment
// matches (`/worker-api/api/gallery/<id>/asset/public` + download=1), so the
// worker streams it with Content-Disposition: attachment.
export function systemVideoDownloadUrl(item: PageVideoItem): string | null {
  const id = (item.systemVideoId ?? '').trim()
  if (!id) return null
  const qs = new URLSearchParams({
    namespace_id: CHIEB_NAMESPACE_ID,
    download: '1',
    filename: sanitizeDownloadFilename(item.videoTitle || item.videoId || id),
  })
  return `${WORKER_API_BASE}/api/gallery/${encodeURIComponent(id)}/asset/public?${qs.toString()}`
}

// Build the system gallery thumbnail URL for a page-post card. This is the same
// worker route the LINE/mobile gallery uses for previews, so it works as a real
// fallback when the Facebook thumbnail/proxy fails. Returns null when there's no
// matching system video (no invented URLs).
export function systemVideoThumbUrl(item: PageVideoItem): string | null {
  const id = (item.systemVideoId ?? '').trim()
  if (!id) return null
  const qs = new URLSearchParams({ namespace_id: CHIEB_NAMESPACE_ID })
  return `${WORKER_API_BASE}/api/gallery/${encodeURIComponent(id)}/asset/thumb?${qs.toString()}`
}

// Safe fallback when there is no system asset: only allow http(s) or same-origin
// worker-api paths (rejects javascript:/data: and other unexpected schemes).
export function externalVideoUrl(item: PageVideoItem): string | null {
  const v = (item.videoUrl ?? '').trim()
  if (!v) return null
  if (/^https?:\/\//i.test(v)) return v
  if (v.startsWith('/worker-api')) return v
  if (v.startsWith('/')) return `${WORKER_API_BASE}${v}`
  return null
}

// ---------------------------------------------------------------------------
// Clean Facebook Page Posts inventory (graph_published_posts → cache table).
//
// This is the REAL post inventory: every published post of a page captured via
// the official Graph `published_posts` edge (no scraping, no 100K-view gate, no
// total cap). It reads from the worker's `facebook_page_post_cache` table — a
// different shape from the video cache above (snake_case rows, no `views`), so
// it gets its own schema + fetcher rather than overloading fetchPageVideos.
// ---------------------------------------------------------------------------

// Storage table the read endpoint serves from. Shown in the UI as the data
// source so operators can tell the real inventory apart from the old video cache.
export const PAGE_POST_CACHE_SOURCE = 'facebook_page_post_cache'

export const pagePostItemSchema = z
  .object({
    namespace_id: z.string().nullish(),
    page_id: z.string().nullish(),
    page_name: z.string().nullish(),
    post_id: z.string().nullish(),
    video_id: z.string().nullish(),
    message: z.string().nullish(),
    permalink_url: z.string().nullish(),
    picture: z.string().nullish(),
    source_url: z.string().nullish(),
    media_type: z.string().nullish(),
    created_time: z.string().nullish(),
    reactions_count: z.number().nullish(),
    comments_count: z.number().nullish(),
    shares_count: z.number().nullish(),
    fetched_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough()

export const pagePostSyncSchema = z
  .object({
    page_id: z.string().nullish(),
    page_name: z.string().nullish(),
    next_after: z.string().nullish(),
    fully_scanned: z.boolean().nullish(),
    last_attempt_at: z.string().nullish(),
    last_synced_at: z.string().nullish(),
    last_full_scan_at: z.string().nullish(),
    last_batch_count: z.number().nullish(),
    last_error: z.string().nullish(),
    total_cached: z.number().nullish(),
  })
  .passthrough()

export const pagePostsResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    namespace_id: z.string().nullish(),
    page_id: z.string().nullish(),
    data_source: z.string().nullish(),
    total: z.number().nullish(),
    items: z.array(pagePostItemSchema).default([]),
    sync: pagePostSyncSchema.nullish(),
    sync_all: z.array(z.record(z.unknown())).nullish(),
  })
  .passthrough()

export type PagePostItem = z.infer<typeof pagePostItemSchema>
export type PagePostSync = z.infer<typeof pagePostSyncSchema>
export type PagePostsResponse = z.infer<typeof pagePostsResponseSchema>

export interface PagePostsQuery {
  // Omit pageId for namespace-wide (ทุกเพจ) mode — the worker returns every
  // page's posts in one query, so the UI doesn't fan out per page.
  pageId?: string
  namespaceId?: string
  mediaType?: string
  q?: string
  limit?: number
  offset?: number
}

export async function fetchPagePosts(
  params: PagePostsQuery,
  signal?: AbortSignal,
): Promise<PagePostsResponse> {
  const qs = new URLSearchParams()
  if (params.pageId) qs.set('page_id', params.pageId)
  if (params.namespaceId) qs.set('namespace_id', params.namespaceId)
  if (params.mediaType) qs.set('media_type', params.mediaType)
  if (params.q) qs.set('q', params.q)
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  const raw = await workerFetchJson<unknown>(
    `/api/dashboard/facebook-page-posts?${qs.toString()}`,
    { signal, timeoutMs: 30_000 },
  )
  return pagePostsResponseSchema.parse(raw)
}

export const syncPagePostsResultSchema = z
  .object({
    ok: z.boolean().optional(),
    page_id: z.string().nullish(),
    page_name: z.string().nullish(),
    resumed: z.boolean().nullish(),
    started_after: z.string().nullish(),
    batches_scanned: z.number().nullish(),
    rows_discovered: z.number().nullish(),
    rows_upserted: z.number().nullish(),
    next_after: z.string().nullish(),
    fully_scanned: z.boolean().nullish(),
    pending_more: z.boolean().nullish(),
    total_cached: z.number().nullish(),
    error: z.string().nullish(),
  })
  .passthrough()

export type SyncPagePostsResult = z.infer<typeof syncPagePostsResultSchema>

export interface SyncPagePostsParams {
  pageId: string
  pageName?: string
  namespaceId?: string
  // reset=true restarts the crawl from the newest post (ignores the stored
  // cursor). Default false → resume from where the last batch stopped.
  reset?: boolean
  limit?: number
  batches?: number
}

// Advance ONE page's crawl by a single bounded batch. The worker persists the
// cursor server-side, so one click = one safe step; the caller re-invokes (or
// the operator clicks again) to keep going until fully_scanned. Requires a
// dashboard auth session (same-origin cookie) — the worker gates this endpoint.
export async function syncPagePosts(
  params: SyncPagePostsParams,
  signal?: AbortSignal,
): Promise<SyncPagePostsResult> {
  const raw = await workerFetchJson<unknown>(
    '/api/dashboard/facebook-page-posts/sync-page',
    {
      method: 'POST',
      body: {
        page_id: params.pageId,
        page_name: params.pageName,
        namespace_id: params.namespaceId,
        reset: params.reset === true ? true : undefined,
        limit: params.limit,
        batches: params.batches,
      },
      signal,
      timeoutMs: 120_000,
    },
  )
  return syncPagePostsResultSchema.parse(raw)
}

// Safe permalink for a post card: only http(s) (rejects javascript:/data: and
// any other scheme). Returns null when there's no usable Facebook URL.
export function pagePostPermalink(item: PagePostItem): string | null {
  const v = (item.permalink_url ?? '').trim()
  return /^https?:\/\//i.test(v) ? v : null
}

// Safe cover/thumbnail for a post card: the Graph `picture` (http(s) only).
export function pagePostThumb(item: PagePostItem): string | null {
  const p = (item.picture ?? '').trim()
  return /^https?:\/\//i.test(p) ? p : null
}
