import { workerFetchJson, WORKER_API_BASE, CHIEB_NAMESPACE_ID } from '@/api/client'
import { isRecord, pick, safeNumber } from '@/lib/data'

// Read-only contract for GET /api/dashboard/gallery — the same endpoint the
// Svelte GalleryPanel reads. The worker response is loosely typed (videos may
// arrive under `videos`/`items`/`data`, or as a bare array) so we normalize
// defensively instead of a strict Zod parse. No writes, no faked rows.

export type GalleryView = 'ready' | 'used'

export interface GalleryVideo {
  id: string
  title: string
  thumb: string
  publicUrl: string
  createdAt: string
  postedAt: string
  shopeeLink: string
  lazadaLink: string
  duration: string
  // Used to dedupe clips that share the same source clip across pages (the
  // mobile LINE gallery groups by this). Empty string when the worker omits it.
  sourceFingerprint: string
  // Comma-separated category tags, when the clip has any.
  category: string
  originalUrl: string
  script: string
}

export interface GalleryResult {
  videos: GalleryVideo[]
  // Exact totals are only present when counts were requested (the default).
  // On the fast path (`includeCounts: false`) the worker skips the COUNT(*)
  // tallies, so these come back `null` and callers must not depend on them.
  total: number | null
  // Overall deduped counts for both tabs, normalized from the worker's
  // `ready_total`/`used_total`. Both are present on every counted response
  // regardless of the active `view`, so the UI can label both buttons at once.
  // Falls back to the active-view `total` when the API omits the field; `null`
  // on the fast path.
  readyTotal: number | null
  usedTotal: number | null
  // Cheap "more pages exist" hint that works on both paths: the worker's
  // `has_more` flag when present, otherwise a full page came back.
  hasMore: boolean
  // Raw gallery_index cursor returned by the fast path. The deduped scan
  // consumes more raw rows than it returns videos, so the next page must resume
  // from this cursor rather than from the count of videos shown so far. `null`
  // on the counted path (which uses plain offset pagination).
  nextOffset: number | null
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return ''
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function pickTitle(record: Record<string, unknown>): string {
  return pick(
    record,
    ['manualCaption', 'manual_caption', 'caption', 'title', 'script', 'name', 'id'],
    'ไม่ระบุชื่อ',
  )
}

function normalize(raw: unknown): GalleryVideo | null {
  if (!isRecord(raw)) return null
  const id = pick(raw, ['id', 'video_id', 'videoId'])
  return {
    id,
    title: pickTitle(raw),
    thumb: pick(raw, ['thumbnailUrl', 'thumbnail_url', 'facebookThumb', 'videoThumb', 'thumb']),
    publicUrl: pick(raw, ['publicUrl', 'public_url', 'videoUrl', 'video_url']),
    createdAt: pick(raw, ['created_at', 'createdAt']),
    postedAt: pick(raw, ['posted_at', 'postedAt']),
    shopeeLink: pick(raw, ['shopeeLink', 'shopee_link']),
    lazadaLink: pick(raw, ['lazadaLink', 'lazada_link']),
    duration: formatDuration(safeNumber((raw as Record<string, unknown>).duration ?? (raw as Record<string, unknown>).length_seconds)),
    sourceFingerprint: pick(raw, ['sourceFingerprint', 'source_fingerprint']),
    category: pick(raw, ['category', 'categories']),
    originalUrl: pick(raw, ['originalUrl', 'original_url']),
    script: pick(raw, ['script']),
  }
}

export interface GalleryPageParams {
  offset?: number
  limit?: number
  // Defaults to true for backward compatibility (Create Ads still wants the
  // deduped counts). The Gallery page passes false to take the fast path that
  // skips the worker's count tallies for a quick first paint.
  includeCounts?: boolean
}

export const GALLERY_PAGE_SIZE = 50

export async function fetchGallery(
  view: GalleryView,
  signal?: AbortSignal,
  { offset = 0, limit = GALLERY_PAGE_SIZE, includeCounts = true }: GalleryPageParams = {},
): Promise<GalleryResult> {
  const safeLimit = Math.max(1, Math.floor(limit))
  const qs = new URLSearchParams({
    namespace_id: CHIEB_NAMESPACE_ID,
    view,
    offset: String(Math.max(0, Math.floor(offset))),
    limit: String(safeLimit),
  })
  if (!includeCounts) qs.set('include_counts', '0')
  const data = await workerFetchJson<unknown>(`/api/dashboard/gallery?${qs.toString()}`, {
    signal,
    timeoutMs: 15_000,
  })

  const list: unknown[] = Array.isArray(data)
    ? data
    : isRecord(data)
      ? (Array.isArray(data.videos)
          ? data.videos
          : Array.isArray(data.items)
            ? data.items
            : Array.isArray(data.data)
              ? data.data
              : [])
      : []

  const videos = list.map(normalize).filter((v): v is GalleryVideo => v !== null)
  const payload = isRecord(data) ? data : {}
  // `has_more` works on both paths; fall back to a full page coming back.
  const hasMore =
    typeof payload.has_more === 'boolean' ? payload.has_more : videos.length >= safeLimit
  // The worker omits counts on the fast path (signalled by `counts_included:
  // false`). Surface them as null rather than faking a value the UI would
  // mistake for an exact total.
  const countsIncluded = includeCounts && payload.counts_included !== false
  if (!countsIncluded) {
    // Raw cursor for the deduped fast path; fall back to plain offset arithmetic
    // if an older worker doesn't send it.
    const nextOffset =
      typeof payload.next_offset === 'number'
        ? payload.next_offset
        : Math.max(0, Math.floor(offset)) + videos.length
    return { videos, total: null, readyTotal: null, usedTotal: null, hasMore, nextOffset }
  }
  const totalKey = view === 'ready' ? 'ready_total' : 'used_total'
  const total = safeNumber(payload[totalKey] ?? payload.total ?? videos.length)
  // Prefer the explicit per-tab totals; if the API only sends one (or none),
  // fall back to the active-view total so the active button still shows a count.
  const readyTotal = safeNumber(payload.ready_total ?? (view === 'ready' ? total : 0))
  const usedTotal = safeNumber(payload.used_total ?? (view === 'used' ? total : 0))
  return { videos, total, readyTotal, usedTotal, hasMore, nextOffset: null }
}

// Worker thumbnail proxy — same path the Svelte panel builds. Returns null when
// there is no id (caller falls back to the raw thumb URL or a placeholder).
export function galleryThumbSrc(video: GalleryVideo): string {
  if (video.id) {
    return `${WORKER_API_BASE}/api/gallery/${encodeURIComponent(video.id)}/asset/thumb?namespace_id=${CHIEB_NAMESPACE_ID}`
  }
  return video.thumb
}
