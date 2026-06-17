import { workerFetchJson } from '@/api/client'
import { isRecord, safeNumber, safeString } from '@/lib/data'

// Read-only contract for GET /api/post-history?date=...&limit=200 — same
// endpoint as the Svelte HistoryPanel. Lists posts the system published to the
// page on the selected Bangkok date, with post + comment status.

export interface HistoryRow {
  id: number
  videoId: string
  pageId: string
  fbPostId: string
  fbReelUrl: string
  postedAt: string
  status: string
  errorMessage: string
  commentStatus: string
  commentError: string
  shopeeLink: string
  postProfileName: string
  commentProfileName: string
  triggerSource: string
}

function normalize(raw: unknown): HistoryRow | null {
  if (!isRecord(raw)) return null
  const id = safeNumber(raw.id)
  const videoId = safeString(raw.video_id ?? raw.videoId)
  if (!id && !videoId) return null
  return {
    id,
    videoId,
    pageId: safeString(raw.page_id ?? raw.pageId),
    fbPostId: safeString(raw.fb_post_id ?? raw.fbPostId),
    fbReelUrl: safeString(raw.fb_reel_url ?? raw.fbReelUrl),
    postedAt: safeString(raw.posted_at ?? raw.postedAt),
    status: safeString(raw.status),
    errorMessage: safeString(raw.error_message ?? raw.errorMessage),
    commentStatus: safeString(raw.comment_status ?? raw.commentStatus),
    commentError: safeString(raw.comment_error ?? raw.commentError),
    shopeeLink: safeString(raw.shopee_link ?? raw.shopeeLink),
    postProfileName: safeString(raw.post_profile_name ?? raw.postProfileName),
    commentProfileName: safeString(raw.comment_profile_name ?? raw.commentProfileName),
    triggerSource: safeString(raw.trigger_source ?? raw.triggerSource),
  }
}

export async function fetchHistory(date: string, signal?: AbortSignal): Promise<HistoryRow[]> {
  const data = await workerFetchJson<{ history?: unknown[] }>(
    `/api/post-history?date=${encodeURIComponent(date)}&limit=200`,
    { signal, timeoutMs: 30_000 },
  )
  const list = Array.isArray(data.history) ? data.history : []
  return list.map(normalize).filter((r): r is HistoryRow => r !== null)
}

export function buildFbPostUrl(row: HistoryRow): string {
  if (row.fbReelUrl) {
    if (/^https?:\/\//i.test(row.fbReelUrl)) return row.fbReelUrl
    return `https://www.facebook.com${row.fbReelUrl.startsWith('/') ? '' : '/'}${row.fbReelUrl}`
  }
  if (row.pageId && row.fbPostId) return `https://www.facebook.com/${row.pageId}/posts/${row.fbPostId}`
  if (row.fbPostId) return `https://www.facebook.com/${row.fbPostId}`
  return ''
}
