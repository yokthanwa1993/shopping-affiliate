<script lang="ts">
  import { onMount } from 'svelte'
  import { fetchJson, formatThaiDateTime } from '../lib/api'

  type View = 'unprocessed' | 'processed'

  type Item = {
    id: string
    title: string
    status: string
    source: string
    createdAt: string
    updatedAt: string
    processedAt: string
  }

  let view = $state<View>('unprocessed')
  let loading = $state(false)
  let errorMessage = $state('')
  let items = $state<Record<View, Item[]>>({ unprocessed: [], processed: [] })
  let updatedAt = $state('')

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }
  function safeString(v: unknown): string {
    if (typeof v === 'string') return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return ''
  }
  function pick(record: Record<string, unknown>, keys: string[], fb = ''): string {
    for (const k of keys) {
      const v = safeString(record[k])
      if (v) return v
    }
    return fb
  }
  function normalize(raw: unknown, fbStatus: string, index: number): Item | null {
    if (!isRecord(raw)) return null
    const id = pick(raw, ['id', 'video_id', 'videoId', 'source_id', 'key'])
    return {
      id,
      title: pick(raw, ['title', 'caption', 'manualCaption', 'script', 'name', 'url'], id ? `วิดีโอ ${id}` : `รายการ ${index + 1}`),
      status: pick(raw, ['status', 'state', 'processing_status'], fbStatus),
      source: pick(raw, ['source', 'source_url', 'original_url', 'url']),
      createdAt: pick(raw, ['created_at', 'createdAt', 'uploaded_at']),
      updatedAt: pick(raw, ['updated_at', 'updatedAt']),
      processedAt: pick(raw, ['processed_at', 'processedAt', 'completed_at']),
    }
  }
  function collect(payload: unknown, keys: string[]): unknown[] {
    const out: unknown[] = []
    if (!isRecord(payload)) return out
    for (const k of keys) {
      const c = (payload as Record<string, unknown>)[k]
      if (Array.isArray(c)) out.push(...c)
    }
    return out
  }

  async function load(target: View = view) {
    loading = true
    errorMessage = ''
    try {
      const data = await fetchJson<Record<string, unknown>>(`/api/inbox?view=${encodeURIComponent(target)}&limit=48`, { timeoutMs: 15000 })
      const list = collect(data, ['items', 'videos', 'rows', 'records', 'inbox'])
        .map((raw, i) => normalize(raw, target, i))
        .filter((v): v is Item => v !== null)
      items = { ...items, [target]: list }
      updatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  onMount(() => load(view))

  function switchView(v: View) {
    if (view === v) return
    view = v
    load(v)
  }

  const tabs: Array<{ key: View; label: string }> = [
    { key: 'unprocessed', label: 'ยังไม่ประมวลผล' },
    { key: 'processed', label: 'ประมวลผลแล้ว' },
  ]
</script>

<div class="space-y-4">
  <div class="rounded-3xl border border-slate-200 bg-slate-50 p-3">
    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">โพสต์เพจ / แหล่งคลิป</p>
        <p class="mt-0.5 text-xs text-slate-600">
          กำลังดู: <span class="font-semibold text-slate-900">{view === 'unprocessed' ? 'คลิปต้นฉบับที่ยังไม่ได้ประมวลผล' : 'คลิปที่ประมวลผลเสร็จแล้ว'}</span>
        </p>
      </div>
    </div>
  </div>

  <div class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex items-center gap-2 rounded-full bg-slate-100 p-1">
      {#each tabs as tabItem}
        <button
          type="button"
          onclick={() => switchView(tabItem.key)}
          class="rounded-full px-4 py-1.5 text-sm font-semibold transition {view === tabItem.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}"
        >
          {tabItem.label}
          <span class="ml-1 text-xs opacity-70">({items[tabItem.key].length})</span>
        </button>
      {/each}
    </div>
    <div class="flex items-center gap-3 text-xs text-slate-500">
      {#if updatedAt}<span>อัปเดต {updatedAt}</span>{/if}
      <button
        type="button"
        onclick={() => load(view)}
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
    {#if loading && items[view].length === 0}
      <div class="px-6 py-10 text-center text-sm text-slate-500">กำลังโหลด...</div>
    {:else if items[view].length === 0}
      <div class="px-6 py-10 text-center text-sm text-slate-500">ไม่พบรายการในกลุ่มนี้</div>
    {:else}
      <ul class="divide-y divide-slate-100">
        {#each items[view] as item (item.id || item.title)}
          <li class="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <div class="truncate text-sm font-medium text-slate-900">{item.title}</div>
              <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                {#if item.id}<span class="font-mono">{item.id}</span>{/if}
                {#if item.source}<a href={item.source} target="_blank" rel="noreferrer" class="underline-offset-2 hover:underline">source</a>{/if}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-3 text-xs text-slate-500">
              <span class="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700">{item.status}</span>
              <span>{formatThaiDateTime(item.processedAt || item.updatedAt || item.createdAt)}</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
