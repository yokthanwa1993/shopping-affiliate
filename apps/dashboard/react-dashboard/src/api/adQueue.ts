import { workerFetchJson } from '@/api/client'
import { isRecord, safeNumber, safeString } from '@/lib/data'

// Read-only contract for GET /api/dashboard/ad-queue/list — same endpoint as
// the Svelte AdQueuePanel. This React page lists the queue only; run-next /
// cancel actions are intentionally NOT ported in this parity pass (no writes).

export type AdQueueStatus = 'queued' | 'processing' | 'done' | 'failed' | 'cancelled' | string

export interface AdQueueItem {
  id: number
  createdAt: string
  pageId: string
  videoId: string
  caption: string
  shopeeUrl: string
  campaignId: string
  newCampaignName: string
  status: AdQueueStatus
  attemptedAt: string
  completedAt: string
  errorMessage: string
  resultAdId: string
  resultAdsetId: string
}

export interface AdQueueResult {
  items: AdQueueItem[]
  counts: Record<string, number>
  lastRunAt: string
  nextRunAt: string
  intervalMinutes: number
}

function normalize(raw: unknown): AdQueueItem | null {
  if (!isRecord(raw)) return null
  return {
    id: safeNumber(raw.id),
    createdAt: safeString(raw.created_at ?? raw.createdAt),
    pageId: safeString(raw.page_id ?? raw.pageId),
    videoId: safeString(raw.video_id ?? raw.videoId),
    caption: safeString(raw.caption),
    shopeeUrl: safeString(raw.shopee_url ?? raw.shopeeUrl),
    campaignId: safeString(raw.campaign_id ?? raw.campaignId),
    newCampaignName: safeString(raw.new_campaign_name ?? raw.newCampaignName),
    status: safeString(raw.status) || 'queued',
    attemptedAt: safeString(raw.attempted_at ?? raw.attemptedAt),
    completedAt: safeString(raw.completed_at ?? raw.completedAt),
    errorMessage: safeString(raw.error_message ?? raw.errorMessage),
    resultAdId: safeString(raw.result_ad_id ?? raw.resultAdId),
    resultAdsetId: safeString(raw.result_adset_id ?? raw.resultAdsetId),
  }
}

export async function fetchAdQueue(signal?: AbortSignal): Promise<AdQueueResult> {
  const data = await workerFetchJson<Record<string, unknown>>(
    '/api/dashboard/ad-queue/list?limit=100',
    { signal, timeoutMs: 15_000 },
  )
  if (!data.ok) throw new Error('worker คืน ok=false')
  const items = Array.isArray(data.items)
    ? data.items.map(normalize).filter((i): i is AdQueueItem => i !== null)
    : []
  return {
    items,
    counts: isRecord(data.counts) ? (data.counts as Record<string, number>) : {},
    lastRunAt: safeString(data.last_run_at),
    nextRunAt: safeString(data.next_run_at),
    intervalMinutes: safeNumber(data.interval_minutes) || 20,
  }
}
