import { workerFetchJson, CHIEB_NAMESPACE_ID } from '@/api/client'
import { isRecord, safeNumber, safeString } from '@/lib/data'

// Read + manual-upload contract for the คลังสื่อ (Meta Asset Library) MVP.
//   GET  /api/dashboard/video-media-library         → list stored advideos
//   POST /api/dashboard/video-media-library/upload  → push one system video
// The worker never returns tokens; these rows only carry the advideo_id (which
// can later seed a real ad) plus upload/status bookkeeping. No writes beyond the
// explicit upload action, no faked rows.

export interface VideoMediaLibraryItem {
  namespaceId: string
  systemVideoId: string
  adAccount: string
  advideoId: string
  advideoStatus: string
  uploadStatus: string
  error: string
  fileUrl: string
  uploadedAt: string
  lastCheckedAt: string
  createdAt: string
  updatedAt: string
  // REAL Meta/Facebook media resolved from the advideo_id (empty when unresolved → System Preview).
  metaSourceUrl: string
  metaThumbnailUrl: string
  metaVideoStatus: string
  metaPermalinkUrl: string
  metaPublishStatus: string
}

export interface VideoMediaLibraryResult {
  items: VideoMediaLibraryItem[]
  namespaceId: string
  adAccount: string
  count: number
}

function normalize(raw: unknown): VideoMediaLibraryItem | null {
  if (!isRecord(raw)) return null
  const systemVideoId = safeString(raw.system_video_id ?? raw.systemVideoId)
  if (!systemVideoId) return null
  return {
    namespaceId: safeString(raw.namespace_id ?? raw.namespaceId),
    systemVideoId,
    adAccount: safeString(raw.ad_account ?? raw.adAccount),
    advideoId: safeString(raw.advideo_id ?? raw.advideoId),
    advideoStatus: safeString(raw.advideo_status ?? raw.advideoStatus),
    uploadStatus: safeString(raw.upload_status ?? raw.uploadStatus),
    error: safeString(raw.error),
    fileUrl: safeString(raw.file_url ?? raw.fileUrl),
    uploadedAt: safeString(raw.uploaded_at ?? raw.uploadedAt),
    lastCheckedAt: safeString(raw.last_checked_at ?? raw.lastCheckedAt),
    createdAt: safeString(raw.created_at ?? raw.createdAt),
    updatedAt: safeString(raw.updated_at ?? raw.updatedAt),
    metaSourceUrl: safeString(raw.meta_source_url ?? raw.metaSourceUrl ?? raw.source),
    metaThumbnailUrl: safeString(raw.meta_thumbnail_url ?? raw.metaThumbnailUrl),
    metaVideoStatus: safeString(raw.meta_video_status ?? raw.metaVideoStatus ?? raw.video_status),
    metaPermalinkUrl: safeString(raw.meta_permalink_url ?? raw.metaPermalinkUrl ?? raw.permalink_url),
    metaPublishStatus: safeString(raw.meta_publish_status ?? raw.metaPublishStatus ?? raw.publish_status),
  }
}

export async function fetchVideoMediaLibrary(
  signal?: AbortSignal,
  { adAccount = '', limit = 100 }: { adAccount?: string; limit?: number } = {},
): Promise<VideoMediaLibraryResult> {
  const qs = new URLSearchParams({
    namespace_id: CHIEB_NAMESPACE_ID,
    limit: String(Math.max(1, Math.min(200, Math.floor(limit)))),
  })
  if (adAccount.trim()) qs.set('ad_account', adAccount.trim())
  const data = await workerFetchJson<Record<string, unknown>>(
    `/api/dashboard/video-media-library?${qs.toString()}`,
    { signal, timeoutMs: 15_000 },
  )
  const items = Array.isArray(data.items)
    ? data.items.map(normalize).filter((i): i is VideoMediaLibraryItem => i !== null)
    : []
  return {
    items,
    namespaceId: safeString(data.namespace_id) || CHIEB_NAMESPACE_ID,
    adAccount: safeString(data.ad_account),
    count: safeNumber(data.count) || items.length,
  }
}

export interface UploadVideoMediaParams {
  systemVideoId: string
  pageId?: string
  adAccount?: string
}

export interface UploadVideoMediaResult {
  item: VideoMediaLibraryItem | null
  warning: string
}

export async function uploadVideoToMediaLibrary(
  params: UploadVideoMediaParams,
): Promise<UploadVideoMediaResult> {
  const body: Record<string, string> = {
    namespace_id: CHIEB_NAMESPACE_ID,
    system_video_id: params.systemVideoId.trim(),
  }
  if (params.pageId?.trim()) body.page_id = params.pageId.trim()
  if (params.adAccount?.trim()) body.ad_account = params.adAccount.trim()
  const data = await workerFetchJson<Record<string, unknown>>(
    '/api/dashboard/video-media-library/upload',
    { method: 'POST', body, timeoutMs: 60_000 },
  )
  return {
    item: normalize(data.item),
    warning: safeString(data.warning),
  }
}
