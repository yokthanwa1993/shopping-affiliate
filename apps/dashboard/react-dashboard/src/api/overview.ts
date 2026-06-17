import { workerFetchJson, CHIEB_NAMESPACE_ID } from '@/api/client'
import { isRecord, safeNumber } from '@/lib/data'

// Read-only summary counts mirroring the Svelte OverviewCards
// (apps/dashboard/src/components/OverviewCards.svelte): gallery "ready" count,
// processing active/failed, and inbox "unprocessed" — each from the same worker
// endpoints and the same defensive shapes the cards used. Every fetch degrades
// independently (a failed card shows "—" / down) so the landing page never
// throws, matching the Svelte Promise.allSettled behavior.

export type ApiStatus = 'ok' | 'partial' | 'down'

export interface OverviewSummary {
  galleryReady: number | null
  processingActive: number | null
  failedJobs: number | null
  inboxUnprocessed: number | null
  apiStatus: ApiStatus
}

function arrayLen(payload: unknown, keys: string[]): number {
  if (Array.isArray(payload)) return payload.length
  if (!isRecord(payload)) return 0
  for (const k of keys) {
    const v = payload[k]
    if (Array.isArray(v)) return v.length
  }
  return 0
}

export async function fetchOverviewSummary(signal?: AbortSignal): Promise<OverviewSummary> {
  let ok = 0
  let total = 0
  const summary: OverviewSummary = {
    galleryReady: null,
    processingActive: null,
    failedJobs: null,
    inboxUnprocessed: null,
    apiStatus: 'down',
  }

  // Take the same fast path the Gallery page uses (include_counts=0): the worker
  // skips the heavy deduped-count tally that was timing the Overview out (~12s,
  // transferSize 0) and tripping the API-status footer into "partial". That path
  // omits exact totals (counts_included:false), so fall back to presence from the
  // returned page — a non-blocking signal of whether ready clips exist.
  const gallery = workerFetchJson<unknown>(
    `/api/dashboard/gallery?namespace_id=${CHIEB_NAMESPACE_ID}&view=ready&limit=1&include_counts=0`,
    { signal, timeoutMs: 12_000 },
  )
    .then((p) => {
      total++
      ok++
      const record = isRecord(p) ? p : {}
      summary.galleryReady = safeNumber(
        record.ready_total ?? record.total ?? arrayLen(p, ['videos', 'items', 'data']),
      )
    })
    .catch(() => {
      total++
    })

  const processing = workerFetchJson<unknown>(
    '/api/processing?summary=1&limit=1&history_limit=1',
    { signal, timeoutMs: 12_000 },
  )
    .then((p) => {
      total++
      ok++
      const counts = isRecord(p) && isRecord(p.counts) ? p.counts : {}
      summary.processingActive = safeNumber(
        counts.active ?? counts.processing ?? arrayLen(p, ['active']),
      )
      summary.failedJobs = safeNumber(counts.failed ?? arrayLen(p, ['failed']))
    })
    .catch(() => {
      total++
    })

  const inbox = workerFetchJson<unknown>('/api/inbox?view=unprocessed&limit=1', {
    signal,
    timeoutMs: 12_000,
  })
    .then((p) => {
      total++
      ok++
      const record = isRecord(p) ? p : {}
      const counts = isRecord(record.counts) ? record.counts : {}
      summary.inboxUnprocessed = safeNumber(
        record.total ?? counts.unprocessed ?? arrayLen(p, ['items']),
      )
    })
    .catch(() => {
      total++
    })

  await Promise.allSettled([gallery, processing, inbox])
  summary.apiStatus = ok === total ? 'ok' : ok === 0 ? 'down' : 'partial'
  return summary
}
