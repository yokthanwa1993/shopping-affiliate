<script lang="ts">
  import { onMount } from 'svelte'
  import { fetchJson, formatThaiDateTime, CHIEB_NAMESPACE_ID } from '../lib/api'

  type View = 'ready' | 'used'

  type Video = {
    id: string
    title: string
    thumb: string
    publicUrl: string
    createdAt: string
    postedAt: string
    shopeeLink: string
    lazadaLink: string
    duration: string
  }

  type Payload = {
    videos?: unknown[]
    items?: unknown[]
    data?: unknown[]
    total?: number
    ready_total?: number
    used_total?: number
    has_more?: boolean
    view?: string
  }

  let view = $state<View>('ready')
  let loading = $state(true)
  let errorMessage = $state('')
  let videos = $state<Video[]>([])
  let readyTotal = $state(0)
  let usedTotal = $state(0)
  let updatedAt = $state('')
  let search = $state('')

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
  function safeNumber(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return 0
  }
  function formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return ''
    const total = Math.floor(seconds)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }
  function pickTitle(record: Record<string, unknown>): string {
    return pick(record, ['manualCaption', 'manual_caption', 'caption', 'title', 'script', 'name', 'id'], 'ไม่ระบุชื่อ')
  }
  function normalize(raw: unknown): Video | null {
    if (!isRecord(raw)) return null
    const id = pick(raw, ['id', 'video_id', 'videoId'])
    return {
      id,
      title: pickTitle(raw),
      thumb: pick(raw, ['thumbnailUrl', 'thumbnail_url', 'facebookThumb', 'videoThumb', 'thumb']),
      publicUrl: pick(raw, ['publicUrl', 'public_url', 'videoUrl', 'video_url']),
      createdAt: pick(raw, ['created_at', 'createdAt']),
      postedAt: pick(raw, ['posted_at', 'postedAt']),
      shopeeLink: pick(raw, ['shopeeLink', 'shopee_link']),
      lazadaLink: pick(raw, ['lazadaLink', 'lazada_link']),
      duration: formatDuration(safeNumber(raw.duration ?? raw.length_seconds)),
    }
  }

  async function load(target: View = view) {
    loading = true
    errorMessage = ''
    try {
      const data = await fetchJson<Payload | unknown[]>(
        `/api/dashboard/gallery?namespace_id=${CHIEB_NAMESPACE_ID}&view=${target}&offset=0&limit=48`,
        { timeoutMs: 15000 },
      )
      const list: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as Payload)?.videos) ? (data as Payload).videos as unknown[]
          : Array.isArray((data as Payload)?.items) ? (data as Payload).items as unknown[]
            : Array.isArray((data as Payload)?.data) ? (data as Payload).data as unknown[] : []
      videos = list.map(normalize).filter((v): v is Video => v !== null)
      const payload = Array.isArray(data) ? ({} as Payload) : (data as Payload)
      if (target === 'ready') {
        readyTotal = safeNumber(payload.ready_total ?? payload.total ?? videos.length)
      } else {
        usedTotal = safeNumber(payload.used_total ?? payload.total ?? videos.length)
      }
      updatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e)
      videos = []
    } finally {
      loading = false
    }
  }

  function switchView(v: View) {
    if (view === v) return
    view = v
    load(v)
  }

  let filtered = $derived(
    search.trim()
      ? videos.filter((v) => {
          const q = search.trim().toLowerCase()
          return v.id.toLowerCase().includes(q) || v.title.toLowerCase().includes(q)
        })
      : videos,
  )

  function thumbSrc(video: Video): string {
    if (video.id) {
      return `/worker-api/api/gallery/${encodeURIComponent(video.id)}/asset/thumb?namespace_id=${CHIEB_NAMESPACE_ID}`
    }
    return video.thumb
  }

  function handleThumbError(event: Event) {
    const img = event.currentTarget as HTMLImageElement | null
    if (!img) return
    img.style.display = 'none'
    const placeholder = img.nextElementSibling as HTMLElement | null
    if (placeholder && placeholder.dataset.thumbPlaceholder === 'true') {
      placeholder.style.display = 'flex'
    }
  }

  onMount(() => load('ready'))
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex items-center gap-2 rounded-full bg-slate-100 p-1">
      <button
        type="button"
        onclick={() => switchView('ready')}
        class="rounded-full px-4 py-1.5 text-sm font-semibold transition {view === 'ready' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}"
      >
        ยังไม่โพสต์ ({readyTotal})
      </button>
      <button
        type="button"
        onclick={() => switchView('used')}
        class="rounded-full px-4 py-1.5 text-sm font-semibold transition {view === 'used' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}"
      >
        โพสต์แล้ว ({usedTotal})
      </button>
    </div>
    <div class="flex flex-1 items-center gap-3 sm:max-w-md">
      <div class="relative flex-1">
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </span>
        <input
          bind:value={search}
          placeholder="ค้นหา video id หรือชื่อคลิป"
          class="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-slate-400"
        />
      </div>
      <button
        type="button"
        onclick={() => load(view)}
        disabled={loading}
        class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loading ? '...' : 'รีเฟรช'}
      </button>
    </div>
  </div>

  {#if errorMessage}
    <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      ดึง gallery ไม่สำเร็จ: {errorMessage}
      <div class="mt-1 text-xs text-rose-600/80">UI ยังใช้งานต่อได้ ลองรีเฟรชอีกครั้ง</div>
    </div>
  {/if}

  {#if loading && filtered.length === 0}
    <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {#each Array(10) as _}
        <div class="aspect-[9/16] animate-pulse rounded-3xl bg-slate-100"></div>
      {/each}
    </div>
  {:else if filtered.length === 0}
    <div class="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500">
      {view === 'ready' ? 'ยังไม่มีคลิปที่รอโพสต์' : 'ยังไม่มีคลิปที่โพสต์แล้ว'}
    </div>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {#each filtered as video (video.id)}
        <article class="group overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_4px_16px_rgba(15,23,42,0.04)] transition hover:shadow-[0_8px_30px_rgba(15,23,42,0.08)]">
          <a
            href={video.publicUrl || '#'}
            target={video.publicUrl ? '_blank' : undefined}
            rel="noreferrer"
            class="relative block aspect-[9/16] w-full overflow-hidden bg-slate-100"
          >
            {#if video.id || video.thumb}
              <img
                src={thumbSrc(video)}
                alt={video.id}
                loading="lazy"
                class="h-full w-full object-cover"
                onerror={handleThumbError}
              />
              <div
                data-thumb-placeholder="true"
                style="display:none"
                class="absolute inset-0 flex h-full w-full items-center justify-center text-xs text-slate-400"
              >
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>
              </div>
            {:else}
              <div class="flex h-full w-full items-center justify-center text-xs text-slate-400">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>
              </div>
            {/if}
            {#if video.shopeeLink || video.lazadaLink}
              <span class="absolute left-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#1877f2] text-white shadow-sm">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </span>
            {/if}
            {#if video.duration}
              <span class="absolute bottom-2 right-2 rounded-md bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white">{video.duration}</span>
            {/if}
          </a>
          <div class="space-y-2 p-3">
            <p class="line-clamp-2 text-sm font-medium text-slate-900">{video.title || video.id}</p>
            <div class="flex items-center justify-between text-[11px] text-slate-400">
              <span class="truncate font-mono">{video.id}</span>
              {#if view === 'used' && video.postedAt}
                <span>{formatThaiDateTime(video.postedAt)}</span>
              {:else if video.createdAt}
                <span>{formatThaiDateTime(video.createdAt)}</span>
              {/if}
            </div>
            <div class="flex flex-wrap gap-1.5 pt-1 text-xs">
              {#if video.shopeeLink}
                <a href={video.shopeeLink} target="_blank" rel="noreferrer" class="rounded-md bg-orange-50 px-2 py-1 font-semibold text-orange-700 hover:bg-orange-100">Shopee</a>
              {/if}
              {#if video.lazadaLink}
                <a href={video.lazadaLink} target="_blank" rel="noreferrer" class="rounded-md bg-pink-50 px-2 py-1 font-semibold text-pink-700 hover:bg-pink-100">Lazada</a>
              {/if}
              {#if video.publicUrl}
                <a href={video.publicUrl} target="_blank" rel="noreferrer" class="rounded-md bg-slate-100 px-2 py-1 font-semibold text-slate-700 hover:bg-slate-200">เปิดวิดีโอ</a>
              {/if}
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
    <span>คลิปที่ import เข้าระบบแล้ว · namespace {CHIEB_NAMESPACE_ID}</span>
    {#if updatedAt}<span>อัปเดต {updatedAt}</span>{/if}
  </div>
</div>
