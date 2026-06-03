<script lang="ts">
  import { onMount } from 'svelte'
  import { fetchJson, formatThaiDateTime } from '../lib/api'

  type Bucket = 'active' | 'failed' | 'completed'

  type Item = {
    id: string
    title: string
    status: string
    phase: string
    error: string
    createdAt: string
    updatedAt: string
    bucket: Bucket
  }

  type Payload = {
    active?: unknown[]
    failed?: unknown[]
    completed?: unknown[]
    items?: unknown[]
    videos?: unknown[]
    counts?: Record<string, number>
    processing?: unknown[]
  }

  let bucket = $state<Bucket>('active')
  let loading = $state(true)
  let errorMessage = $state('')
  let items = $state<Record<Bucket, Item[]>>({ active: [], failed: [], completed: [] })
  let counts = $state<Record<Bucket, number>>({ active: 0, failed: 0, completed: 0 })
  let updatedAt = $state('')

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }
  function safeString(v: unknown): string {
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return ''
  }
  function pick(record: Record<string, unknown>, keys: string[], fallback = ''): string {
    for (const k of keys) {
      const v = safeString(record[k])
      if (v) return v
    }
    return fallback
  }
  function inferBucket(status: string, fb: Bucket): Bucket {
    const t = status.toLowerCase()
    if (/(fail|error|timeout|cancel|reject|invalid)/.test(t)) return 'failed'
    if (/(complete|done|success|processed|finished|สำเร็จ)/.test(t)) return 'completed'
    if (/(queue|active|running|process|pending|started|กำลัง|รอ)/.test(t)) return 'active'
    return fb
  }
  function normalize(raw: unknown, fb: Bucket, index: number): Item | null {
    if (!isRecord(raw)) return null
    const id = pick(raw, ['id', 'video_id', 'videoId', 'system_id', 'source_id', 'key'])
    const status = pick(raw, ['status', 'state', 'phase', 'result', 'current_status'], fb)
    const b = inferBucket(status, fb)
    return {
      id,
      status,
      bucket: b,
      title: pick(raw, ['title', 'caption', 'manualCaption', 'script', 'name', 'url'], id ? `วิดีโอ ${id}` : `รายการ ${index + 1}`),
      phase: pick(raw, ['step', 'current_step', 'stage', 'phase', 'message']),
      error: pick(raw, ['error', 'error_message', 'last_error', 'reason']),
      createdAt: pick(raw, ['created_at', 'createdAt', 'queued_at', 'started_at']),
      updatedAt: pick(raw, ['updated_at', 'updatedAt', 'attempted_at', 'completed_at', 'finished_at']),
    }
  }
  function collect(payload: Payload, keys: string[]): unknown[] {
    const out: unknown[] = []
    if (!isRecord(payload)) return out
    for (const k of keys) {
      const c = (payload as Record<string, unknown>)[k]
      if (Array.isArray(c)) out.push(...c)
    }
    return out
  }

  async function load() {
    loading = true
    errorMessage = ''
    try {
      const data = await fetchJson<Payload>('/api/processing?summary=0&limit=24&history_limit=24', { timeoutMs: 15000 })
      const active = collect(data, ['active', 'processing', 'running', 'queue', 'queued', 'in_progress'])
      const failed = collect(data, ['failed', 'failures', 'errors'])
      const completed = collect(data, ['completed', 'done', 'history', 'processed'])
      const generic = collect(data, ['items', 'videos', 'rows', 'records'])

      const next: Record<Bucket, Item[]> = { active: [], failed: [], completed: [] }
      const push = (raw: unknown, fb: Bucket, idx: number) => {
        const item = normalize(raw, fb, idx)
        if (!item) return
        next[item.bucket].push(item)
      }
      active.forEach((v, i) => push(v, 'active', i))
      failed.forEach((v, i) => push(v, 'failed', i))
      completed.forEach((v, i) => push(v, 'completed', i))
      generic.forEach((v, i) => push(v, 'active', i))

      const seen: Record<Bucket, Set<string>> = { active: new Set(), failed: new Set(), completed: new Set() }
      for (const b of ['active', 'failed', 'completed'] as Bucket[]) {
        next[b] = next[b].filter((item) => {
          const key = item.id || `${item.title}-${item.status}`
          if (seen[b].has(key)) return false
          seen[b].add(key)
          return true
        })
      }
      items = next

      const c = data?.counts || {}
      counts = {
        active: typeof c.active === 'number' ? c.active : next.active.length,
        failed: typeof c.failed === 'number' ? c.failed : next.failed.length,
        completed: typeof c.completed === 'number' ? c.completed : next.completed.length,
      }
      updatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  onMount(load)

  const tabs: Array<{ key: Bucket; label: string }> = [
    { key: 'active', label: 'กำลังทำงาน' },
    { key: 'failed', label: 'ล้มเหลว' },
    { key: 'completed', label: 'สำเร็จ' },
  ]
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex items-center gap-2 rounded-full bg-slate-100 p-1">
      {#each tabs as tabItem}
        <button
          type="button"
          onclick={() => (bucket = tabItem.key)}
          class="rounded-full px-4 py-1.5 text-sm font-semibold transition {bucket === tabItem.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}"
        >
          {tabItem.label}
          <span class="ml-1 text-xs opacity-70">({counts[tabItem.key]})</span>
        </button>
      {/each}
    </div>
    <div class="flex items-center gap-3 text-xs text-slate-500">
      {#if updatedAt}<span>อัปเดต {updatedAt}</span>{/if}
      <button
        type="button"
        onclick={load}
        disabled={loading}
        class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loading ? 'กำลังโหลด...' : 'รีเฟรช'}
      </button>
    </div>
  </div>

  {#if errorMessage}
    <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      ดึงข้อมูลไม่สำเร็จ: {errorMessage}
    </div>
  {/if}

  <div class="overflow-hidden rounded-3xl border border-slate-200 bg-white">
    {#if loading && items[bucket].length === 0}
      <div class="px-6 py-10 text-center text-sm text-slate-500">กำลังโหลด...</div>
    {:else if items[bucket].length === 0}
      <div class="px-6 py-10 text-center text-sm text-slate-500">ไม่พบรายการในกลุ่มนี้</div>
    {:else}
      <ul class="divide-y divide-slate-100">
        {#each items[bucket] as item (item.id || item.title)}
          <li class="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium text-slate-900">{item.title}</div>
              <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                {#if item.id}<span class="font-mono">{item.id}</span>{/if}
                {#if item.phase}<span>· {item.phase}</span>{/if}
                {#if item.error}<span class="text-rose-600">· {item.error}</span>{/if}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-3 text-xs text-slate-500">
              <span
                class="rounded-full px-2.5 py-1 text-[11px] font-bold {item.bucket === 'completed' ? 'bg-emerald-50 text-emerald-700' : item.bucket === 'failed' ? 'bg-rose-50 text-rose-700' : 'bg-sky-50 text-sky-700'}"
              >{item.status}</span>
              <span>{formatThaiDateTime(item.updatedAt || item.createdAt)}</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
