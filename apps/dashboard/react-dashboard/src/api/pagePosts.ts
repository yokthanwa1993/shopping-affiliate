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
