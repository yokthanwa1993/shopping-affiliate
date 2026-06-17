import { workerFetchJson } from '@/api/client'
import { collect, isRecord, pick } from '@/lib/data'

// Read-only contract for GET /api/processing — same endpoint as the Svelte
// ProcessingPanel. Buckets items into active/failed/completed by status text.

export type ProcessingBucket = 'active' | 'failed' | 'completed'

export interface ProcessingItem {
  id: string
  title: string
  status: string
  phase: string
  error: string
  createdAt: string
  updatedAt: string
  bucket: ProcessingBucket
}

export interface ProcessingResult {
  items: Record<ProcessingBucket, ProcessingItem[]>
  counts: Record<ProcessingBucket, number>
}

function inferBucket(status: string, fb: ProcessingBucket): ProcessingBucket {
  const t = status.toLowerCase()
  if (/(fail|error|timeout|cancel|reject|invalid)/.test(t)) return 'failed'
  if (/(complete|done|success|processed|finished|สำเร็จ)/.test(t)) return 'completed'
  if (/(queue|active|running|process|pending|started|กำลัง|รอ)/.test(t)) return 'active'
  return fb
}

function normalize(raw: unknown, fb: ProcessingBucket, index: number): ProcessingItem | null {
  if (!isRecord(raw)) return null
  const id = pick(raw, ['id', 'video_id', 'videoId', 'system_id', 'source_id', 'key'])
  const status = pick(raw, ['status', 'state', 'phase', 'result', 'current_status'], fb)
  return {
    id,
    status,
    bucket: inferBucket(status, fb),
    title: pick(raw, ['title', 'caption', 'manualCaption', 'script', 'name', 'url'], id ? `วิดีโอ ${id}` : `รายการ ${index + 1}`),
    phase: pick(raw, ['step', 'current_step', 'stage', 'phase', 'message']),
    error: pick(raw, ['error', 'error_message', 'last_error', 'reason']),
    createdAt: pick(raw, ['created_at', 'createdAt', 'queued_at', 'started_at']),
    updatedAt: pick(raw, ['updated_at', 'updatedAt', 'attempted_at', 'completed_at', 'finished_at']),
  }
}

export async function fetchProcessing(signal?: AbortSignal): Promise<ProcessingResult> {
  const data = await workerFetchJson<unknown>(
    '/api/processing?summary=0&limit=24&history_limit=24',
    { signal, timeoutMs: 15_000 },
  )
  const active = collect(data, ['active', 'processing', 'running', 'queue', 'queued', 'in_progress'])
  const failed = collect(data, ['failed', 'failures', 'errors'])
  const completed = collect(data, ['completed', 'done', 'history', 'processed'])
  const generic = collect(data, ['items', 'videos', 'rows', 'records'])

  const next: Record<ProcessingBucket, ProcessingItem[]> = { active: [], failed: [], completed: [] }
  const push = (raw: unknown, fb: ProcessingBucket, idx: number) => {
    const item = normalize(raw, fb, idx)
    if (item) next[item.bucket].push(item)
  }
  active.forEach((v, i) => push(v, 'active', i))
  failed.forEach((v, i) => push(v, 'failed', i))
  completed.forEach((v, i) => push(v, 'completed', i))
  generic.forEach((v, i) => push(v, 'active', i))

  // De-dupe within each bucket (same key/title can repeat across source arrays).
  for (const b of ['active', 'failed', 'completed'] as ProcessingBucket[]) {
    const seen = new Set<string>()
    next[b] = next[b].filter((item) => {
      const key = item.id || `${item.title}-${item.status}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const rawCounts = isRecord(data) && isRecord(data.counts) ? data.counts : {}
  const counts: Record<ProcessingBucket, number> = {
    active: typeof rawCounts.active === 'number' ? rawCounts.active : next.active.length,
    failed: typeof rawCounts.failed === 'number' ? rawCounts.failed : next.failed.length,
    completed: typeof rawCounts.completed === 'number' ? rawCounts.completed : next.completed.length,
  }
  return { items: next, counts }
}
