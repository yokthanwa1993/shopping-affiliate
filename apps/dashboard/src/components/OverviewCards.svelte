<script lang="ts">
  import { onMount } from 'svelte'
  import { fetchJson, CHIEB_NAMESPACE_ID } from '../lib/api'

  type ProcessingPayload = {
    counts?: Record<string, number>
    active?: unknown[]
    failed?: unknown[]
    completed?: unknown[]
  }
  type InboxPayload = {
    items?: unknown[]
    total?: number
    counts?: Record<string, number>
  }
  type GalleryPayload = {
    videos?: unknown[]
    items?: unknown[]
    data?: unknown[]
    total?: number
    ready_total?: number
  }

  type SummaryCard = {
    label: string
    value: string
    meta: string
    metaTone: 'pos' | 'neg' | 'neutral'
    icon: 'bar' | 'wallet' | 'activity' | 'users'
    href: string
  }

  let loading = $state(true)
  let apiStatus = $state<'ok' | 'partial' | 'down' | 'pending'>('pending')
  let updatedAt = $state('')
  let cards = $state<SummaryCard[]>([
    { label: 'Gallery ready',     value: '—', meta: '—', metaTone: 'neutral', icon: 'bar',      href: '/gallery' },
    { label: 'Processing active', value: '—', meta: '—', metaTone: 'neutral', icon: 'activity', href: '/processing' },
    { label: 'Failed jobs',       value: '—', meta: '—', metaTone: 'neutral', icon: 'wallet',   href: '/processing' },
    { label: 'คลังต้นฉบับ',         value: '—', meta: '—', metaTone: 'neutral', icon: 'users',    href: '/inbox' },
  ])

  function safeNumber(x: unknown, fallback = 0): number {
    if (typeof x === 'number' && Number.isFinite(x)) return x
    if (typeof x === 'string') {
      const n = Number(x)
      if (Number.isFinite(n)) return n
    }
    return fallback
  }

  async function load() {
    loading = true
    apiStatus = 'pending'
    let ok = 0
    let total = 0

    const tasks: Array<Promise<void>> = []

    tasks.push(
      fetchJson<GalleryPayload | unknown[]>(
        `/api/dashboard/gallery?namespace_id=${CHIEB_NAMESPACE_ID}&view=ready&limit=1`,
        { timeoutMs: 12000 },
      ).then((p) => {
        total++; ok++
        const payload: GalleryPayload = Array.isArray(p) ? {} : (p ?? {})
        const listLen = Array.isArray(p)
          ? p.length
          : Array.isArray(payload.videos) ? payload.videos.length
            : Array.isArray(payload.items) ? payload.items.length
              : Array.isArray(payload.data) ? payload.data.length : 0
        const value = safeNumber(payload.ready_total ?? payload.total ?? listLen)
        cards[0] = { ...cards[0], value: value.toLocaleString(), meta: 'พร้อมโพสต์', metaTone: value > 0 ? 'pos' : 'neutral' }
      }).catch(() => {
        total++
        cards[0] = { ...cards[0], value: '—', meta: 'โหลดไม่สำเร็จ', metaTone: 'neg' }
      }),
    )

    tasks.push(
      fetchJson<ProcessingPayload>('/api/processing?summary=1&limit=1&history_limit=1', { timeoutMs: 12000 })
        .then((p) => {
          total++; ok++
          const counts = p?.counts || {}
          const active = safeNumber(counts.active ?? counts.processing ?? (Array.isArray(p?.active) ? p?.active.length : 0))
          const failed = safeNumber(counts.failed ?? (Array.isArray(p?.failed) ? p?.failed.length : 0))
          cards[1] = { ...cards[1], value: active.toLocaleString(), meta: active > 0 ? 'กำลังทำงาน' : 'ว่าง', metaTone: active > 0 ? 'pos' : 'neutral' }
          cards[2] = { ...cards[2], value: failed.toLocaleString(), meta: failed > 0 ? 'ตรวจสอบ' : 'ปกติ',   metaTone: failed > 0 ? 'neg' : 'pos' }
        })
        .catch(() => {
          total++
          cards[1] = { ...cards[1], value: '—', meta: 'โหลดไม่สำเร็จ', metaTone: 'neg' }
          cards[2] = { ...cards[2], value: '—', meta: 'โหลดไม่สำเร็จ', metaTone: 'neg' }
        }),
    )

    tasks.push(
      fetchJson<InboxPayload>('/api/inbox?view=unprocessed&limit=1', { timeoutMs: 12000 })
        .then((p) => {
          total++; ok++
          const value = safeNumber(p?.total ?? p?.counts?.unprocessed ?? (Array.isArray(p?.items) ? p?.items.length : 0))
          cards[3] = { ...cards[3], value: value.toLocaleString(), meta: 'รอประมวลผล', metaTone: value > 0 ? 'pos' : 'neutral' }
        })
        .catch(() => {
          total++
          cards[3] = { ...cards[3], value: '—', meta: 'โหลดไม่สำเร็จ', metaTone: 'neg' }
        }),
    )

    await Promise.allSettled(tasks)
    apiStatus = ok === total ? 'ok' : ok === 0 ? 'down' : 'partial'
    updatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    loading = false
  }

  onMount(load)
</script>

<section class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
  {#each cards as card (card.label)}
    <a
      href={card.href}
      class="rounded-3xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-[0_8px_30px_rgba(15,23,42,0.06)]"
    >
      <div class="flex items-center justify-between">
        <p class="text-sm font-medium text-slate-500">{card.label}</p>
        <span class="text-slate-400">
          {#if card.icon === 'bar'}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
          {:else if card.icon === 'wallet'}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"/><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>
          {:else if card.icon === 'activity'}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          {/if}
        </span>
      </div>
      <div class="mt-4 flex items-end justify-between gap-3">
        <p class="text-3xl font-semibold tracking-tight text-slate-900">{card.value}</p>
        <span
          class="text-sm font-semibold {card.metaTone === 'pos' ? 'text-emerald-600' : card.metaTone === 'neg' ? 'text-red-500' : 'text-slate-400'}"
        >{card.meta}</span>
      </div>
    </a>
  {/each}
</section>

<div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-200 bg-white px-4 py-3 text-sm">
  <div class="flex items-center gap-2">
    <span
      class="inline-block h-2.5 w-2.5 rounded-full {apiStatus === 'ok' ? 'bg-emerald-500' : apiStatus === 'partial' ? 'bg-amber-500' : apiStatus === 'down' ? 'bg-rose-500' : 'bg-slate-300'}"
    ></span>
    <span class="font-medium text-slate-700">
      API status:
      {apiStatus === 'ok' ? 'ปกติ' : apiStatus === 'partial' ? 'บางจุดล่ม' : apiStatus === 'down' ? 'เข้าไม่ได้' : 'กำลังตรวจ...'}
    </span>
    <span class="text-slate-400">· /worker-api → api.pubilo.com</span>
  </div>
  <div class="flex items-center gap-3 text-xs text-slate-500">
    {#if updatedAt}<span>อัปเดต {updatedAt}</span>{/if}
    <button
      type="button"
      onclick={load}
      disabled={loading}
      class="rounded-xl border border-slate-200 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? 'กำลังโหลด...' : 'รีเฟรช'}
    </button>
  </div>
</div>
