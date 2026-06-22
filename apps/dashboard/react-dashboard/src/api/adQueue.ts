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

// ---------------------------------------------------------------------------
// AD-ONLY QUEUE (separate lane from the legacy ad-queue above).
//
// GET /api/dashboard/ad-only-queue/list and its run-next/cancel/interval actions. Each queued row is
// replayed through POST /api/dashboard/create-ad-only — never the legacy create-ad — so it never
// publishes a Page post / comments / writes post_history. The cadence ("สร้างทุก X นาที") is the
// operator-set interval served alongside the list and editable via the interval endpoint.
// ---------------------------------------------------------------------------

export interface AdOnlyQueueItem {
  id: number
  createdAt: string
  pageId: string
  mode: string
  dailyCampaignName: string
  dailyBudgetThb: string
  runHours: string
  storyId: string
  postId: string
  fbVideoId: string
  systemVideoId: string
  status: AdQueueStatus
  attemptedAt: string
  completedAt: string
  errorMessage: string
  resultAdId: string
  resultAdsetId: string
  resultCampaignId: string
}

export interface AdOnlyQueueResult {
  items: AdOnlyQueueItem[]
  counts: Record<string, number>
  lastRunAt: string
  nextRunAt: string
  intervalMinutes: number
  schedulerEnabled: boolean
}

function normalizeAdOnly(raw: unknown): AdOnlyQueueItem | null {
  if (!isRecord(raw)) return null
  return {
    id: safeNumber(raw.id),
    createdAt: safeString(raw.created_at ?? raw.createdAt),
    pageId: safeString(raw.page_id ?? raw.pageId),
    mode: safeString(raw.mode) || 'paused',
    dailyCampaignName: safeString(raw.daily_campaign_name ?? raw.dailyCampaignName),
    dailyBudgetThb: safeString(raw.daily_budget_thb ?? raw.dailyBudgetThb),
    runHours: safeString(raw.run_hours ?? raw.runHours),
    storyId: safeString(raw.story_id ?? raw.storyId),
    postId: safeString(raw.post_id ?? raw.postId),
    fbVideoId: safeString(raw.fb_video_id ?? raw.fbVideoId),
    systemVideoId: safeString(raw.system_video_id ?? raw.systemVideoId),
    status: safeString(raw.status) || 'queued',
    attemptedAt: safeString(raw.attempted_at ?? raw.attemptedAt),
    completedAt: safeString(raw.completed_at ?? raw.completedAt),
    errorMessage: safeString(raw.error_message ?? raw.errorMessage),
    resultAdId: safeString(raw.result_ad_id ?? raw.resultAdId),
    resultAdsetId: safeString(raw.result_adset_id ?? raw.resultAdsetId),
    resultCampaignId: safeString(raw.result_campaign_id ?? raw.resultCampaignId),
  }
}

export async function fetchAdOnlyQueue(signal?: AbortSignal): Promise<AdOnlyQueueResult> {
  const data = await workerFetchJson<Record<string, unknown>>(
    '/api/dashboard/ad-only-queue/list?limit=100',
    { signal, timeoutMs: 15_000 },
  )
  if (!data.ok) throw new Error('worker คืน ok=false')
  const items = Array.isArray(data.items)
    ? data.items.map(normalizeAdOnly).filter((i): i is AdOnlyQueueItem => i !== null)
    : []
  return {
    items,
    counts: isRecord(data.counts) ? (data.counts as Record<string, number>) : {},
    lastRunAt: safeString(data.last_run_at),
    nextRunAt: safeString(data.next_run_at),
    intervalMinutes: safeNumber(data.interval_minutes) || 20,
    schedulerEnabled: data.scheduler_enabled !== false,
  }
}

// Process the oldest queued ad-only item immediately (bypasses the interval gate).
export async function runNextAdOnlyQueue(): Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }> {
  return workerFetchJson('/api/dashboard/ad-only-queue/run-next', { method: 'POST', timeoutMs: 120_000 })
}

// Cancel a still-queued ad-only item.
export async function cancelAdOnlyQueueItem(id: number): Promise<{ ok: boolean }> {
  return workerFetchJson(`/api/dashboard/ad-only-queue/${id}`, { method: 'DELETE', timeoutMs: 15_000 })
}

// Read/set the cadence ("สร้างทุก X นาที"). The worker clamps 1–1440.
export async function fetchAdOnlyInterval(signal?: AbortSignal): Promise<number> {
  const data = await workerFetchJson<{ ok?: boolean; interval_minutes?: number }>(
    '/api/dashboard/ad-only-queue/interval',
    { signal, timeoutMs: 15_000 },
  )
  return safeNumber(data.interval_minutes) || 20
}

export async function setAdOnlyInterval(minutes: number): Promise<number> {
  const data = await workerFetchJson<{ ok?: boolean; interval_minutes?: number }>(
    '/api/dashboard/ad-only-queue/interval',
    { method: 'PUT', timeoutMs: 15_000, body: { interval_minutes: minutes } },
  )
  return safeNumber(data.interval_minutes) || minutes
}

export async function setAdOnlySchedulerEnabled(enabled: boolean): Promise<boolean> {
  const data = await workerFetchJson<{ ok?: boolean; scheduler_enabled?: boolean }>(
    '/api/dashboard/ad-only-queue/enabled',
    { method: 'PUT', timeoutMs: 15_000, body: { scheduler_enabled: enabled } },
  )
  return data.scheduler_enabled === true
}
