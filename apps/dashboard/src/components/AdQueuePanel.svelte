<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { fetchJson, formatThaiDateTime } from '../lib/api'

  type AdQueueItem = {
    id: number
    created_at: string
    page_id: string
    video_id: string
    caption: string
    shopee_url: string
    story_id: string
    campaign_id: string
    new_campaign_name: string
    status: 'queued' | 'processing' | 'done' | 'failed' | 'cancelled'
    attempted_at: string
    completed_at: string
    error_message: string
    result_story_id: string
    result_ad_id: string
    result_adset_id: string
  }

  type ListResponse = {
    ok?: boolean
    items?: AdQueueItem[]
    counts?: Record<string, number>
    last_run_at?: string
    next_run_at?: string
    interval_minutes?: number
  }

  let items = $state<AdQueueItem[]>([])
  let counts = $state<Record<string, number>>({})
  let lastRunAt = $state('')
  let nextRunAt = $state('')
  let intervalMinutes = $state(20)
  let loading = $state(true)
  let error = $state('')
  let updatedAt = $state('')
  let pollHandle: ReturnType<typeof setInterval> | null = null

  async function load() {
    loading = true
    error = ''
    try {
      const data = await fetchJson<ListResponse>('/api/dashboard/ad-queue/list?limit=100', { timeoutMs: 15000 })
      if (data.ok) {
        items = Array.isArray(data.items) ? data.items : []
        counts = data.counts || {}
        lastRunAt = String(data.last_run_at || '')
        nextRunAt = String(data.next_run_at || '')
        if (data.interval_minutes) intervalMinutes = data.interval_minutes
        updatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
      } else {
        throw new Error('worker คืน ok=false')
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function runNext() {
    if (!confirm('รันงานคิวถัดไปเดี๋ยวนี้?\n\n(ระบบจะหยิบงาน queued ตัวเก่าสุดมาทำทันที)\n\n⚠ ใช้เวลา ~30-60 วินาที')) return
    loading = true
    error = ''
    try {
      const data = await fetchJson<{ ok?: boolean; queue_id?: number; skipped?: boolean; reason?: string; error?: string }>(
        '/api/dashboard/ad-queue/run-next',
        { method: 'POST', body: JSON.stringify({}), timeoutMs: 180000 },
      )
      if (data.skipped) alert(`คิวว่างเปล่า (${data.reason || 'no_items'})`)
      else if (data.ok) alert(`รันคิว #${data.queue_id} สำเร็จ`)
      else alert(`รันคิว #${data.queue_id || '?'} ล้มเหลว: ${data.error || ''}`)
      await load()
    } catch (e) {
      alert(`รันไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      loading = false
    }
  }

  async function cancelItem(id: number) {
    if (!confirm(`ยกเลิกงานคิว #${id}?`)) return
    try {
      await fetchJson(`/api/dashboard/ad-queue/${id}`, { method: 'DELETE', timeoutMs: 15000 })
      await load()
    } catch (e) {
      alert(`ยกเลิกไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const buckets: Array<{ key: string; label: string; classes: string }> = [
    { key: 'queued', label: 'รอคิว', classes: 'bg-blue-50 text-blue-700' },
    { key: 'processing', label: 'กำลังรัน', classes: 'bg-amber-50 text-amber-700' },
    { key: 'done', label: 'สำเร็จ', classes: 'bg-emerald-50 text-emerald-700' },
    { key: 'failed', label: 'ล้มเหลว', classes: 'bg-red-50 text-red-700' },
    { key: 'cancelled', label: 'ยกเลิก', classes: 'bg-slate-100 text-slate-500' },
  ]

  function rowColor(status: string): string {
    if (status === 'done') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    if (status === 'failed') return 'bg-red-50 text-red-700 border-red-200'
    if (status === 'processing') return 'bg-amber-50 text-amber-700 border-amber-200'
    if (status === 'cancelled') return 'bg-slate-100 text-slate-500 border-slate-200'
    return 'bg-blue-50 text-blue-700 border-blue-200'
  }

  function buildPostUrl(storyId: string): string {
    if (!storyId) return ''
    return `https://www.facebook.com/${storyId.replace('_', '/posts/')}`
  }

  onMount(() => {
    void load()
    pollHandle = setInterval(() => void load(), 30000)
  })
  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle)
  })
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">คิวสร้างแอด</p>
      <p class="mt-0.5 text-xs text-slate-600">
        ระบบจะหยิบงาน queued ตัวเก่าสุดมารันทุก {intervalMinutes} นาที — สร้างแอด + โพสต์หน้าเพจในขั้นตอนเดียว
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={() => void load()}
        disabled={loading}
        class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loading ? 'กำลังโหลด…' : 'รีเฟรช'}
      </button>
      <button
        type="button"
        onclick={() => void runNext()}
        disabled={loading || !((counts.queued || 0) > 0)}
        class="rounded-xl bg-orange-500 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
      >
        ⚡ รันตอนนี้เลย
      </button>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
    {#each buckets as b}
      <div class="rounded-2xl {b.classes} px-3 py-3 text-center">
        <p class="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-75">{b.label}</p>
        <p class="mt-1 text-xl font-bold">{counts[b.key] || 0}</p>
      </div>
    {/each}
  </div>

  <div class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
    <p>
      <span class="font-semibold">รันล่าสุด:</span>
      {lastRunAt ? formatThaiDateTime(lastRunAt) : 'ยังไม่เคยรัน'}
    </p>
    <p class="mt-1">
      <span class="font-semibold">รันถัดไป (โดยประมาณ):</span>
      {nextRunAt ? formatThaiDateTime(nextRunAt) : '-'}
    </p>
  </div>

  {#if error}
    <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      โหลดคิวไม่สำเร็จ: {error}
    </div>
  {/if}

  <div class="space-y-2">
    {#if loading && items.length === 0}
      <div class="rounded-3xl border border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500">
        กำลังโหลด…
      </div>
    {:else if items.length === 0}
      <div class="rounded-3xl border border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500">
        ยังไม่มีงานในคิว — กดสร้างแอดในแท็บโพสต์เพจ จะถูกเพิ่มเข้าคิวที่นี่
      </div>
    {:else}
      {#each items as item (item.id)}
        <article class="rounded-2xl border border-slate-200 bg-white p-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase {rowColor(item.status)}">
                  {item.status}
                </span>
                <span class="text-xs text-slate-400">#{item.id}</span>
                <span class="text-xs text-slate-500">{formatThaiDateTime(item.created_at)}</span>
              </div>
              <p class="mt-1.5 truncate text-sm font-medium text-slate-900">
                {item.caption || `Video ${item.video_id}`}
              </p>
              <p class="mt-0.5 truncate text-[11px] text-slate-400">
                video_id: {item.video_id} · campaign: {item.campaign_id || item.new_campaign_name || '-'}
              </p>
              {#if item.shopee_url}
                <p class="mt-0.5 truncate text-[11px] text-slate-400">shopee: {item.shopee_url}</p>
              {/if}
              {#if item.error_message}
                <p class="mt-1 text-xs text-red-600">⚠ {item.error_message}</p>
              {/if}
              {#if item.result_story_id}
                <a
                  href={buildPostUrl(item.result_story_id)}
                  target="_blank"
                  rel="noreferrer"
                  class="mt-1 inline-flex items-center gap-1 text-xs font-medium text-[#1877f2]"
                >
                  ดูโพสต์
                </a>
              {/if}
            </div>
            {#if item.status === 'queued'}
              <button
                type="button"
                onclick={() => void cancelItem(item.id)}
                class="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
              >
                ยกเลิก
              </button>
            {/if}
          </div>
        </article>
      {/each}
    {/if}
  </div>

  <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
    <span>คิวสร้างแอด · /api/dashboard/ad-queue/list</span>
    {#if updatedAt}<span>อัปเดต {updatedAt}</span>{/if}
  </div>
</div>
