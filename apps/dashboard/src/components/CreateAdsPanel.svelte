<script lang="ts">
  import { onMount } from 'svelte'
  import {
    fetchJson,
    formatCompactViews,
    formatThaiDateTime,
    CHIEB_NAMESPACE_ID,
    DEFAULT_PAGE,
    WORKER_API_BASE,
  } from '../lib/api'

  type Candidate = {
    source: 'gallery' | 'page-post'
    refId: string
    systemVideoId: string
    fbVideoId: string
    title: string
    thumb: string
    publicUrl: string
    postUrl: string
    createdAt: string
    postedAt: string
    views: number
    shopeeLink: string
  }

  let galleryReady = $state<Candidate[]>([])
  let pagePosts = $state<Candidate[]>([])
  let loadingGallery = $state(true)
  let loadingPosts = $state(true)
  let errorGallery = $state('')
  let errorPosts = $state('')
  let copiedRef = $state('')
  let view = $state<'gallery' | 'page-post'>('gallery')

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }
  function safeString(v: unknown): string {
    if (typeof v === 'string') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return ''
  }
  function safeNumber(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return 0
  }

  function thumbForGallery(id: string): string {
    return `${WORKER_API_BASE}/api/gallery/${encodeURIComponent(id)}/asset/thumb?namespace_id=${CHIEB_NAMESPACE_ID}`
  }

  async function loadGallery() {
    loadingGallery = true
    errorGallery = ''
    try {
      const data = await fetchJson<{ videos?: unknown[]; items?: unknown[]; data?: unknown[] }>(
        `/api/dashboard/gallery?namespace_id=${CHIEB_NAMESPACE_ID}&view=ready&limit=48`,
        { timeoutMs: 15000 },
      )
      const list: unknown[] = Array.isArray(data.videos)
        ? data.videos
        : Array.isArray(data.items)
          ? data.items
          : Array.isArray(data.data)
            ? data.data
            : []
      galleryReady = list
        .map((raw) => {
          if (!isRecord(raw)) return null
          const id = safeString(raw.id ?? raw.video_id ?? raw.videoId)
          if (!id) return null
          const c: Candidate = {
            source: 'gallery',
            refId: id,
            systemVideoId: id,
            fbVideoId: '',
            title: safeString(raw.manualCaption ?? raw.manual_caption ?? raw.caption ?? raw.title ?? raw.name ?? id),
            thumb: safeString(raw.thumbnailUrl ?? raw.thumbnail_url) || thumbForGallery(id),
            publicUrl: safeString(raw.publicUrl ?? raw.public_url ?? raw.videoUrl ?? raw.video_url),
            postUrl: '',
            createdAt: safeString(raw.created_at ?? raw.createdAt),
            postedAt: safeString(raw.posted_at ?? raw.postedAt),
            views: 0,
            shopeeLink: safeString(raw.shopeeLink ?? raw.shopee_link),
          }
          return c
        })
        .filter((v): v is Candidate => v !== null)
    } catch (e) {
      errorGallery = e instanceof Error ? e.message : String(e)
    } finally {
      loadingGallery = false
    }
  }

  async function loadPagePosts() {
    loadingPosts = true
    errorPosts = ''
    try {
      const params = new URLSearchParams({
        page_id: DEFAULT_PAGE.id,
        page_name: DEFAULT_PAGE.name,
        min_views: '100000',
        limit: '48',
      })
      const data = await fetchJson<{ items?: unknown[] }>(
        `/api/dashboard/facebook-page-videos?${params.toString()}`,
        { timeoutMs: 30000 },
      )
      const list = Array.isArray(data.items) ? data.items : []
      pagePosts = list
        .map((raw) => {
          if (!isRecord(raw)) return null
          const fb = safeString(raw.videoId ?? raw.video_id)
          const sys = safeString(raw.systemVideoId ?? raw.system_video_id)
          const ref = sys || (fb ? `FB:${fb}` : '')
          if (!ref) return null
          const c: Candidate = {
            source: 'page-post',
            refId: ref,
            systemVideoId: sys,
            fbVideoId: fb,
            title: safeString(raw.videoTitle ?? raw.video_title ?? raw.caption),
            thumb: safeString(raw.facebookThumb ?? raw.facebook_thumb),
            publicUrl: safeString(raw.videoUrl ?? raw.video_url),
            postUrl: safeString(raw.postUrl ?? raw.post_url),
            createdAt: safeString(raw.createdAt ?? raw.created_at),
            postedAt: safeString(raw.postedAt ?? raw.posted_at),
            views: safeNumber(raw.views ?? raw.view_count),
            shopeeLink: safeString(raw.shopeeLink ?? raw.shopee_link),
          }
          return c
        })
        .filter((v): v is Candidate => v !== null)
    } catch (e) {
      errorPosts = e instanceof Error ? e.message : String(e)
    } finally {
      loadingPosts = false
    }
  }

  async function copy(value: string) {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      copiedRef = value
      setTimeout(() => {
        if (copiedRef === value) copiedRef = ''
      }, 1600)
    } catch {
      // ignore
    }
  }

  function handleThumbError(event: Event) {
    const img = event.currentTarget as HTMLImageElement | null
    if (!img) return
    img.style.display = 'none'
  }

  let active = $derived(view === 'gallery' ? galleryReady : pagePosts)

  onMount(() => {
    void loadGallery()
    void loadPagePosts()
  })
</script>

<div class="space-y-4">
  <div class="rounded-3xl border border-slate-200 bg-slate-50 p-3">
    <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">วิธีการสร้างแอด</p>
    <p class="mt-1 text-sm text-slate-700">
      เลือกคลิปจาก <span class="font-semibold">แกลลี่ (ยังไม่โพสต์)</span> หรือ
      <span class="font-semibold">โพสต์เพจที่มียอดวิวสูง</span> แล้วคัดลอกรหัส
      System Video ID เพื่อนำไปสั่งงานสร้างแอด — งานจะถูกเพิ่มเข้า
      <a href="/processing" class="font-semibold text-slate-900 underline">คิวสร้างแอด</a>
      และรันตามรอบ cron
    </p>
    <p class="mt-2 text-[11px] text-slate-500">
      Ads ปลายทาง: เพจ {DEFAULT_PAGE.name} (page_id <span class="font-mono">{DEFAULT_PAGE.id}</span>)
    </p>
  </div>

  <div class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex items-center gap-2 rounded-full bg-slate-100 p-1">
      <button
        type="button"
        onclick={() => (view = 'gallery')}
        class="rounded-full px-4 py-1.5 text-sm font-semibold transition {view === 'gallery' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}"
      >
        แกลลี่พร้อมโพสต์
        <span class="ml-1 text-xs opacity-70">({galleryReady.length})</span>
      </button>
      <button
        type="button"
        onclick={() => (view = 'page-post')}
        class="rounded-full px-4 py-1.5 text-sm font-semibold transition {view === 'page-post' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}"
      >
        โพสต์เพจยอดวิวสูง
        <span class="ml-1 text-xs opacity-70">({pagePosts.length})</span>
      </button>
    </div>
    <div class="flex items-center gap-2 text-xs text-slate-500">
      <button
        type="button"
        onclick={() => {
          void loadGallery()
          void loadPagePosts()
        }}
        disabled={loadingGallery || loadingPosts}
        class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loadingGallery || loadingPosts ? 'กำลังโหลด…' : 'รีเฟรช'}
      </button>
    </div>
  </div>

  {#if view === 'gallery' && errorGallery}
    <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      โหลดแกลลี่ไม่สำเร็จ: {errorGallery}
    </div>
  {/if}
  {#if view === 'page-post' && errorPosts}
    <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      โหลดโพสต์เพจไม่สำเร็จ: {errorPosts}
    </div>
  {/if}

  {#if (view === 'gallery' ? loadingGallery : loadingPosts) && active.length === 0}
    <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {#each Array(10) as _}
        <div class="aspect-[9/16] animate-pulse rounded-3xl bg-slate-100"></div>
      {/each}
    </div>
  {:else if active.length === 0}
    <div class="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500">
      {view === 'gallery'
        ? 'ยังไม่มีคลิปในแกลลี่ที่พร้อมโพสต์ — ลองโหลดเพิ่มจากหน้าแกลลี่'
        : 'ยังไม่มีโพสต์เพจที่มียอดวิวสูง — ลอง sync จากหน้าโพสต์เพจ'}
    </div>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {#each active as item (item.refId)}
        <article class="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_4px_16px_rgba(15,23,42,0.04)]">
          <a
            href={item.postUrl || item.publicUrl || '#'}
            target={(item.postUrl || item.publicUrl) ? '_blank' : undefined}
            rel="noreferrer"
            class="relative block aspect-[9/16] w-full overflow-hidden bg-slate-100"
          >
            {#if item.thumb}
              <img
                src={item.thumb}
                alt={item.title}
                loading="lazy"
                class="h-full w-full object-cover"
                onerror={handleThumbError}
              />
            {/if}
            {#if item.views > 0}
              <span class="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                {formatCompactViews(item.views)} views
              </span>
            {/if}
            <span class="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-bold text-slate-700">
              {item.source === 'gallery' ? 'แกลลี่' : 'โพสต์เพจ'}
            </span>
          </a>
          <div class="space-y-2 p-3">
            <p class="line-clamp-2 text-xs font-medium text-slate-900">{item.title || item.refId}</p>
            <div class="rounded-2xl border border-slate-200 bg-slate-50 p-2">
              <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">System Video ID</p>
              <div class="mt-1 flex items-center gap-2">
                <p class="min-w-0 flex-1 truncate text-xs font-bold text-slate-900">{item.refId}</p>
                <button
                  type="button"
                  onclick={() => void copy(item.refId)}
                  class="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-700"
                >
                  {copiedRef === item.refId ? 'คัดลอกแล้ว' : 'คัดลอก'}
                </button>
              </div>
            </div>
            {#if item.postedAt || item.createdAt}
              <p class="text-[10px] text-slate-400">
                {formatThaiDateTime(item.postedAt || item.createdAt)}
              </p>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <div class="text-xs text-slate-500">
    Tip: กดคัดลอกรหัสจากบัตรนี้แล้วใช้ในเครื่องมือ Electron / Feed Ad Extension เพื่อสร้างแอด —
    หรือกดสร้างแอดในแท็บโพสต์เพจ/แกลลี่เพื่อ enqueue เข้าระบบ
  </div>
</div>
