import { WORKER_API_BASE, CHIEB_NAMESPACE_ID, workerFetchJson } from '@/api/client'
import { collect, isRecord, pick, safeString } from '@/lib/data'

// Read/write contract for the DEDICATED AI Clips workspace. This is 100% separate from the
// Chinese/LINE source inventory (GET /api/inbox) — it talks to additive, namespace-scoped
// Worker routes that only ever touch the `_ai_clips/` R2 prefix:
//   GET  /api/dashboard/ai-clips?view=unprocessed|processed&limit=48
//   POST /api/dashboard/ai-clips/upload  (multipart/form-data: file, optional title)
//   DELETE /api/dashboard/ai-clips/:id
// Both inherit the same `x-bot-id` namespace + same-origin dashboard session as every other
// worker call, so AI clips land under the operator's existing namespace. No secrets are sent
// or returned.

export type AiClipView = 'unprocessed' | 'processed'

export interface AiClip {
  id: string
  title: string
  status: string
  sourceLabel: string
  originalUrl: string
  previewUrl: string
  thumbnailUrl: string
  createdAt: string
  processedAt: string
  sizeBytes: number
}

function normalize(raw: unknown, index: number): AiClip | null {
  if (!isRecord(raw)) return null
  const id = pick(raw, ['id', 'video_id', 'videoId'])
  const originalUrl = pick(raw, ['originalUrl', 'original_url', 'videoUrl', 'video_url'])
  return {
    id,
    title: pick(raw, ['title', 'originalFileName'], id ? `AI ${id}` : `คลิป ${index + 1}`),
    status: pick(raw, ['status'], 'unprocessed'),
    sourceLabel: pick(raw, ['sourceLabel', 'source_label'], 'คลิป AI'),
    originalUrl,
    previewUrl: pick(raw, ['previewUrl', 'preview_url']) || originalUrl,
    thumbnailUrl: pick(raw, ['thumbnailUrl', 'thumbnail_url']),
    createdAt: pick(raw, ['createdAt', 'created_at']),
    processedAt: pick(raw, ['processedAt', 'processed_at']),
    sizeBytes: Number(safeString(pick(raw, ['sizeBytes', 'size_bytes'])) || '0') || 0,
  }
}

export async function fetchAiClips(view: AiClipView, signal?: AbortSignal): Promise<AiClip[]> {
  const data = await workerFetchJson<Record<string, unknown>>(
    `/api/dashboard/ai-clips?view=${encodeURIComponent(view)}&limit=48`,
    { signal, timeoutMs: 15_000 },
  )
  return collect(data, ['videos', 'items', 'rows'])
    .map((raw, i) => normalize(raw, i))
    .filter((v): v is AiClip => v !== null)
}

export interface AiClipUploadResult {
  ok: boolean
  video: AiClip | null
}

// Multipart upload — raw fetch (not workerFetchJson) so the browser sets the
// multipart boundary itself. Mirrors workerFetchJson's namespace header + same-origin
// credentials so the dashboard passkey session authorizes the write.
export async function uploadAiClip(
  file: File,
  title?: string,
  signal?: AbortSignal,
): Promise<AiClipUploadResult> {
  const form = new FormData()
  form.append('file', file)
  if (title && title.trim()) form.append('title', title.trim())

  const response = await fetch(`${WORKER_API_BASE}/api/dashboard/ai-clips/upload`, {
    method: 'POST',
    body: form,
    headers: { 'x-bot-id': CHIEB_NAMESPACE_ID },
    credentials: 'same-origin',
    signal,
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error(`Response is not JSON (HTTP ${response.status})`)
    }
  }
  if (!response.ok || json.ok === false) {
    const message = typeof json.error === 'string' && json.error.trim()
      ? json.error
      : `HTTP ${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return { ok: true, video: normalize(json.video, 0) }
}


export async function deleteAiClip(id: string, signal?: AbortSignal): Promise<{ ok: boolean; id: string }> {
  const normalized = String(id || '').trim()
  if (!normalized) throw new Error('missing_ai_clip_id')
  const response = await fetch(`${WORKER_API_BASE}/api/dashboard/ai-clips/${encodeURIComponent(normalized)}`, {
    method: 'DELETE',
    headers: { 'x-bot-id': CHIEB_NAMESPACE_ID },
    credentials: 'same-origin',
    signal,
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error(`Response is not JSON (HTTP ${response.status})`)
    }
  }
  if (!response.ok || json.ok === false) {
    const message = typeof json.error === 'string' && json.error.trim()
      ? json.error
      : `HTTP ${response.status} ${response.statusText}`
    throw new Error(message)
  }
  return { ok: true, id: safeString(json.id) || normalized }
}
