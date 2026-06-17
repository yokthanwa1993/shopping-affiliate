import { workerFetchJson } from '@/api/client'
import { collect, isRecord, pick, safeString } from '@/lib/data'

// Read-only contract for GET /api/inbox?view=...&limit=48 — same endpoint as
// the Svelte SourceInventoryPanel and the mobile LINE inbox (the "คลังต้นฉบับ"
// source clip inventory). The desktop page mirrors the mobile InboxCard visual
// language, so the adapter preserves the rich inbox fields the worker already
// returns (thumbnails, playback URLs, link presence, namespace) instead of
// flattening everything to id/status/date.

export type SourceView = 'unprocessed' | 'processed'

export interface SourceItem {
  id: string
  title: string
  status: string
  source: string
  createdAt: string
  updatedAt: string
  processedAt: string
  // Rich inbox fields (mirrors mobile InboxVideo) — used by the card grid + modal.
  thumbnailUrl: string
  fallbackThumbnailUrl: string
  originalUrl: string
  videoUrl: string
  previewUrl: string
  sourceType: string
  sourceLabel: string
  namespaceId: string
  ownerEmail: string
  hasShopeeLink: boolean
  hasLazadaLink: boolean
  readyToProcess: boolean
  canStartProcessing: boolean
  shopeeLink: string
  lazadaLink: string
}

// First boolean-ish value among `keys`. Tolerates true/false, "true"/"false",
// 1/0 like the loosely-typed worker rows the mobile app already handles.
function pickBool(record: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    const v = record[k]
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase()
      if (t === 'true' || t === '1' || t === 'yes') return true
      if (t === 'false' || t === '0' || t === 'no' || t === '') continue
    }
  }
  return false
}

function normalize(raw: unknown, fbStatus: string, index: number): SourceItem | null {
  if (!isRecord(raw)) return null
  const id = pick(raw, ['id', 'video_id', 'videoId', 'source_id', 'key'])
  const originalUrl = pick(raw, ['originalUrl', 'original_url'])
  const videoUrl = pick(raw, ['videoUrl', 'video_url'])
  const previewUrl = pick(raw, ['previewUrl', 'preview_url'])
  const shopeeLink = pick(raw, ['shopeeLink', 'shopee_link', 'shopeeUrl'])
  const lazadaLink = pick(raw, ['lazadaLink', 'lazada_link', 'lazadaUrl'])
  return {
    id,
    title: pick(raw, ['title', 'caption', 'manualCaption', 'script', 'name', 'url'], id ? `วิดีโอ ${id}` : `รายการ ${index + 1}`),
    status: pick(raw, ['status', 'state', 'processing_status'], fbStatus),
    source: pick(raw, ['source', 'source_url', 'original_url', 'url']),
    createdAt: pick(raw, ['created_at', 'createdAt', 'uploaded_at']),
    updatedAt: pick(raw, ['updated_at', 'updatedAt']),
    processedAt: pick(raw, ['processed_at', 'processedAt', 'completed_at']),
    thumbnailUrl: pick(raw, ['thumbnailUrl', 'thumbnail_url', 'thumbUrl']),
    fallbackThumbnailUrl: pick(raw, ['fallbackThumbnailUrl', 'fallback_thumbnail_url']),
    originalUrl,
    videoUrl,
    previewUrl,
    sourceType: pick(raw, ['sourceType', 'source_type']),
    sourceLabel: pick(raw, ['sourceLabel', 'source_label']),
    namespaceId: pick(raw, ['namespace_id', 'namespaceId']),
    ownerEmail: pick(raw, ['owner_email', 'ownerEmail']),
    hasShopeeLink: pickBool(raw, ['hasShopeeLink', 'has_shopee_link']) || !!safeString(shopeeLink),
    hasLazadaLink: pickBool(raw, ['hasLazadaLink', 'has_lazada_link']) || !!safeString(lazadaLink),
    readyToProcess: pickBool(raw, ['readyToProcess', 'ready_to_process']),
    canStartProcessing: pickBool(raw, ['canStartProcessing', 'can_start_processing']),
    shopeeLink,
    lazadaLink,
  }
}

export async function fetchSourceInventory(
  view: SourceView,
  signal?: AbortSignal,
): Promise<SourceItem[]> {
  const data = await workerFetchJson<Record<string, unknown>>(
    `/api/inbox?view=${encodeURIComponent(view)}&limit=48`,
    { signal, timeoutMs: 15_000 },
  )
  return collect(data, ['items', 'videos', 'rows', 'records', 'inbox'])
    .map((raw, i) => normalize(raw, view, i))
    .filter((v): v is SourceItem => v !== null)
}
