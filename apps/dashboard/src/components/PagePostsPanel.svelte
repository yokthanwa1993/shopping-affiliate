<script lang="ts">
  import { onMount } from 'svelte'
  import {
    fetchJson,
    formatCompactViews,
    formatThaiDateTime,
    CHIEB_NAMESPACE_ID,
    WORKER_API_BASE,
  } from '../lib/api'

  type PageOption = {
    id: string
    name: string
    iconUrl: string
  }

  type PagePostItem = {
    storyId: string
    pageName: string
    createdAt: string
    postedAt: string
    postUrl: string
    facebookThumb: string
    views: number
    videoId: string
    systemVideoId: string
    videoTitle: string
    videoUrl: string
    videoThumb: string
    shopeeLink: string
  }

  const GALLERY_MIN_VIEWS = 100_000
  const GALLERY_READ_LIMIT = 48

  const defaultPage: PageOption = {
    id: '1008898512617594',
    name: 'เฉียบ',
    iconUrl: '/page-icons/chieb.jpg',
  }

  let pages = $state<PageOption[]>([defaultPage])
  let activePage = $state<PageOption>(defaultPage)
  let items = $state<PagePostItem[]>([])
  let loading = $state(true)
  let loadingMore = $state(false)
  let syncing = $state(false)
  let error = $state('')
  let banner = $state('')
  let updatedAt = $state('')
  let copiedRef = $state('')
  // Cache-first metadata surfaced from the worker so the operator can see how much
  // of the page is in D1 and when it was last synced — without a huge blocking fetch.
  let total = $state(0)
  let lastSyncedAt = $state('')
  let fullyScanned = $state(false)
  // Incremental local pagination: pull more cached rows in small batches (offset)
  // instead of one large min_views=0&limit=500 request that times out at 30s.
  let hasMore = $derived(items.length < total)

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }
  function safeNumber(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return 0
  }
  function safeString(v: unknown): string {
    if (typeof v === 'string') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return ''
  }

  function buildFacebookUrl(value: string): string {
    const v = safeString(value)
    if (!v) return '#'
    if (/^https?:\/\//i.test(v)) return v
    return `https://www.facebook.com${v.startsWith('/') ? v : `/${v}`}`
  }

  function normalize(raw: unknown): PagePostItem | null {
    if (!isRecord(raw)) return null
    const storyId = safeString(raw.storyId ?? raw.story_id ?? raw.id)
    const videoId = safeString(raw.videoId ?? raw.video_id)
    if (!storyId && !videoId) return null
    return {
      storyId,
      pageName: safeString(raw.pageName ?? raw.page_name),
      createdAt: safeString(raw.createdAt ?? raw.created_at),
      postedAt: safeString(raw.postedAt ?? raw.posted_at),
      postUrl: buildFacebookUrl(safeString(raw.postUrl ?? raw.post_url ?? raw.permalink_url)),
      facebookThumb: safeString(raw.facebookThumb ?? raw.facebook_thumb ?? raw.thumbnail_url),
      views: safeNumber(raw.views ?? raw.view_count),
      videoId,
      systemVideoId: safeString(raw.systemVideoId ?? raw.system_video_id),
      videoTitle: safeString(raw.videoTitle ?? raw.video_title ?? raw.caption ?? raw.title),
      videoUrl: safeString(raw.videoUrl ?? raw.video_url),
      videoThumb: safeString(raw.videoThumb ?? raw.video_thumb ?? raw.thumbnail_url),
      shopeeLink: safeString(raw.shopeeLink ?? raw.shopee_link ?? ''),
    }
  }

  type PageVideosResponse = {
    items?: unknown[]
    total?: number
    sync?: { lastSyncedAt?: string; fullyScanned?: boolean }
  }

  async function fetchPage(page: PageOption, offset: number): Promise<PagePostItem[]> {
    const params = new URLSearchParams({
      page_id: page.id,
      page_name: page.name,
      min_views: String(GALLERY_MIN_VIEWS),
      limit: String(GALLERY_READ_LIMIT),
      offset: String(offset),
    })
    const data = await fetchJson<PageVideosResponse>(
      `/api/dashboard/facebook-page-videos?${params.toString()}`,
      { timeoutMs: 30000 },
    )
    total = safeNumber(data.total)
    if (data.sync) {
      lastSyncedAt = safeString(data.sync.lastSyncedAt)
      fullyScanned = data.sync.fullyScanned === true
    }
    const list = Array.isArray(data.items) ? data.items : []
    return list.map(normalize).filter((v): v is PagePostItem => v !== null)
  }

  async function loadPosts(page: PageOption) {
    activePage = page
    loading = true
    error = ''
    try {
      items = await fetchPage(page, 0)
      updatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function loadMore() {
    if (loadingMore || loading || !hasMore) return
    loadingMore = true
    error = ''
    try {
      const next = await fetchPage(activePage, items.length)
      // De-dupe defensively in case the cache shifted between requests.
      const seen = new Set(items.map((it) => it.storyId || it.videoId))
      items = [...items, ...next.filter((it) => !seen.has(it.storyId || it.videoId))]
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loadingMore = false
    }
  }

  async function loadSources() {
    try {
      const data = await fetchJson<{ pages?: Array<Record<string, unknown>> }>(
        `/api/dashboard/facebook-page-sources?namespace_id=${CHIEB_NAMESPACE_ID}`,
        { timeoutMs: 15000 },
      )
      const remote = (Array.isArray(data.pages) ? data.pages : [])
        .map((p) => ({
          id: safeString(p.id),
          name: safeString(p.name),
          iconUrl: safeString(p.iconUrl ?? (p as Record<string, unknown>).icon_url),
        }))
        .filter((p) => p.id && p.name && p.id !== defaultPage.id)
      pages = [defaultPage, ...remote]
    } catch {
      // keep built-in fallback (เฉียบ)
    }
  }

  async function syncNextBatch() {
    if (syncing) return
    syncing = true
    banner = ''
    error = ''
    try {
      const resp = await fetchJson<{ ok?: boolean; reason?: string }>(
        '/api/dashboard/facebook-page-videos/auto-sync',
        {
          method: 'POST',
          body: JSON.stringify({
            page_id: activePage.id,
            page_name: activePage.name,
            force: true,
          }),
          timeoutMs: 60000,
        },
      )
      if (resp.ok === false) throw new Error(resp.reason || 'sync ไม่สำเร็จ')
      banner = 'ดึงโพสต์เสร็จแล้ว — กดรีเฟรชเพื่อดูผล'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      syncing = false
    }
  }

  async function refreshAllViews() {
    if (syncing) return
    syncing = true
    banner = ''
    error = ''
    try {
      const data = await fetchJson<{
        ok?: boolean
        total?: number
        raised?: number
        errors?: number
        total_over_100k?: number
        error?: string
      }>('/api/dashboard/facebook-page-videos/refresh-all-views', {
        method: 'POST',
        body: JSON.stringify({ page_id: activePage.id }),
        timeoutMs: 120000,
      })
      if (data.ok === false) throw new Error(data.error || 'refresh ไม่สำเร็จ')
      banner =
        `รีเฟรชเสร็จ: เช็ค ${data.total ?? 0} คลิป · อัปเดตยอดวิว ${data.raised ?? 0} คลิป · ` +
        `คลิป ≥ 1 แสน: ${data.total_over_100k ?? 0}` +
        (data.errors ? ` (errors: ${data.errors})` : '')
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      syncing = false
    }
  }

  async function copyRef(value: string) {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      copiedRef = value
      setTimeout(() => {
        if (copiedRef === value) copiedRef = ''
      }, 1600)
    } catch {
      // clipboard unavailable in some browsers
    }
  }

  function thumbUrl(item: PagePostItem): string {
    if (item.facebookThumb) {
      if (item.facebookThumb.startsWith('/worker-api') || /^https?:\/\//i.test(item.facebookThumb)) {
        return item.facebookThumb
      }
      return `${WORKER_API_BASE}${item.facebookThumb.startsWith('/') ? '' : '/'}${item.facebookThumb}`
    }
    if (item.systemVideoId) {
      return `${WORKER_API_BASE}/api/gallery/${encodeURIComponent(item.systemVideoId)}/asset/thumb?namespace_id=${CHIEB_NAMESPACE_ID}`
    }
    return ''
  }

  function downloadUrl(item: PagePostItem): string {
    if (!item.systemVideoId) return ''
    return `${WORKER_API_BASE}/api/gallery/${encodeURIComponent(item.systemVideoId)}/asset/public?namespace_id=${CHIEB_NAMESPACE_ID}`
  }

  function handleThumbError(event: Event) {
    const img = event.currentTarget as HTMLImageElement | null
    if (!img) return
    img.style.display = 'none'
  }

  onMount(() => {
    void loadPosts(defaultPage)
    void loadSources()
  })
</script>

<div class="space-y-4">
  <span class="sr-only" data-testid="page-posts-marker">PagePostsPanel ready</span>

  <div class="rounded-3xl border border-slate-200 bg-slate-50 p-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">โพสต์เพจ</p>
        <p class="mt-0.5 text-xs text-slate-600">
          คลิปที่โพสต์ขึ้นเพจแล้ว มียอดวิว ≥ 100K · ดึงจาก
          <span class="font-semibold text-slate-900">{activePage.name}</span>
          <span class="ml-1 font-mono text-[11px] text-slate-400">(page_id {activePage.id})</span>
        </p>
      </div>
      <div class="flex max-w-full flex-wrap gap-1.5">
        {#each pages as p (p.id)}
          {@const active = p.id === activePage.id}
          <button
            type="button"
            onclick={() => void loadPosts(p)}
            class="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition
              {active
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'}"
          >
            <span class="relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-slate-200 text-[10px] font-black text-slate-600">
              {p.name.slice(0, 1)}
              {#if p.iconUrl}
                <img
                  src={p.iconUrl}
                  alt={p.name}
                  onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  class="absolute inset-0 h-full w-full object-cover"
                />
              {/if}
            </span>
            <span>{p.name}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>

  <div class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="text-xs text-slate-500">
      {#if loading}
        กำลังโหลดโพสต์…
      {:else}
        แสดง {items.length}{#if total > items.length} จาก {formatCompactViews(total)}{/if} คลิป (≥ 100K) · {activePage.name}
        {#if lastSyncedAt}
          <span class="ml-1 text-slate-400">· sync ล่าสุด {formatThaiDateTime(lastSyncedAt)}</span>
        {/if}
        {#if fullyScanned}
          <span class="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">sync ครบทั้งเพจ</span>
        {/if}
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onclick={() => void loadPosts(activePage)}
        disabled={loading}
        class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loading ? 'กำลังโหลด…' : 'รีเฟรช'}
      </button>
      <button
        type="button"
        onclick={() => void refreshAllViews()}
        disabled={syncing}
        title="ยิง Facebook API ทุกคลิปในแคชแล้วอัปเดตยอดวิวล่าสุด"
        class="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {syncing ? 'กำลังรีเฟรช…' : 'รีเฟรชยอดวิวทั้งหมด'}
      </button>
      <button
        type="button"
        onclick={() => void syncNextBatch()}
        disabled={syncing}
        class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {syncing ? 'กำลังดึง…' : 'ดึงโพสต์จาก Facebook'}
      </button>
    </div>
  </div>

  {#if banner}
    <div class="rounded-3xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
      {banner}
    </div>
  {/if}
  {#if error}
    <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      โหลดโพสต์ไม่สำเร็จ: {error}
    </div>
  {/if}

  {#if loading && items.length === 0}
    <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {#each Array(10) as _}
        <div class="aspect-[9/16] animate-pulse rounded-3xl bg-slate-100"></div>
      {/each}
    </div>
  {:else if items.length === 0}
    <div class="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500">
      ยังไม่มีโพสต์ในคลัง — กด "ดึงโพสต์จาก Facebook" เพื่อเริ่ม sync
    </div>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {#each items as item (item.storyId || item.videoId)}
        {@const ref = item.systemVideoId || (item.videoId ? `FB:${item.videoId}` : '')}
        {@const systemDownloadUrl = downloadUrl(item)}
        <article class="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_4px_16px_rgba(15,23,42,0.04)] transition hover:shadow-[0_8px_30px_rgba(15,23,42,0.08)]">
          <a
            href={item.postUrl}
            target="_blank"
            rel="noreferrer"
            class="relative block aspect-[9/16] w-full overflow-hidden bg-slate-100"
          >
            {#if thumbUrl(item)}
              <img
                src={thumbUrl(item)}
                alt={item.videoTitle}
                loading="lazy"
                class="absolute inset-0 h-full w-full object-cover"
                onerror={handleThumbError}
              />
            {/if}
            <div class="absolute inset-x-0 top-0 flex items-start justify-between p-2">
              <span class="rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                {activePage.name}
              </span>
              <span class="rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                {formatCompactViews(item.views)} views
              </span>
            </div>
            <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2 text-white">
              <p class="line-clamp-2 text-xs font-semibold leading-4">
                {item.videoTitle || `Video ${item.videoId}`}
              </p>
              <div class="mt-1 text-[10px] text-white/80">
                {formatThaiDateTime(item.postedAt || item.createdAt)}
              </div>
            </div>
          </a>
          <div class="space-y-2 p-3">
            <div class="rounded-2xl border border-slate-200 bg-slate-50 p-2.5">
              <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">System Video ID</p>
              <div class="mt-1 flex items-center gap-2">
                <p class="min-w-0 flex-1 truncate text-xs font-bold text-slate-900">{ref || '—'}</p>
                {#if ref}
                  <button
                    type="button"
                    onclick={() => void copyRef(ref)}
                    class="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-700 shadow-sm active:scale-95"
                    title="คัดลอกรหัสสั่งงาน"
                  >
                    {copiedRef === ref ? 'คัดลอกแล้ว' : 'คัดลอก'}
                  </button>
                {/if}
              </div>
              <p class="mt-1 truncate text-[10px] text-slate-400">
                {item.systemVideoId ? `FB Video ID: ${item.videoId || '-'}` : 'ใช้รหัส FB นี้สั่งงานได้'}
              </p>
            </div>
            <a
              href="/create-ads"
              class="block rounded-xl bg-[#1877f2] px-3 py-2 text-center text-xs font-semibold text-white active:scale-95"
            >
              สร้างแอด
            </a>
            {#if systemDownloadUrl}
              <a
                href={systemDownloadUrl}
                target="_blank"
                rel="noreferrer"
                download
                class="block rounded-xl border border-slate-200 bg-white px-3 py-2 text-center text-xs font-semibold text-slate-700 hover:bg-slate-50 active:scale-95"
              >
                ดาวน์โหลดวีดีโอ
              </a>
            {:else}
              <button
                type="button"
                disabled
                class="w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-100 px-3 py-2 text-center text-xs font-semibold text-slate-400"
                title="ไม่มีวิดีโอระบบที่ match กับโพสต์นี้"
              >
                ดาวน์โหลดวีดีโอ
              </button>
            {/if}
          </div>
        </article>
      {/each}
    </div>

    {#if hasMore}
      <div class="flex justify-center pt-1">
        <button
          type="button"
          onclick={() => void loadMore()}
          disabled={loadingMore}
          class="rounded-xl border border-slate-200 bg-white px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingMore ? 'กำลังโหลด…' : `โหลดเพิ่ม (${formatCompactViews(total - items.length)} คลิป)`}
        </button>
      </div>
    {/if}
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
    <span>โพสต์เพจ · /api/dashboard/facebook-page-videos · เพจ {activePage.name}</span>
    {#if updatedAt}<span>อัปเดต {updatedAt}</span>{/if}
  </div>
</div>
