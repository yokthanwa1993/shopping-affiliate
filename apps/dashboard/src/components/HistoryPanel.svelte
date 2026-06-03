<script lang="ts">
  import { onMount } from 'svelte'
  import { fetchJson, formatThaiDateTime, todayBangkokDate } from '../lib/api'

  type HistoryRow = {
    id: number
    videoId: string
    pageId: string
    fbPostId: string
    fbReelUrl: string
    postedAt: string
    status: string
    errorMessage: string
    commentStatus: string
    commentError: string
    commentFbId: string
    shopeeLink: string
    postProfileName: string
    commentProfileName: string
    shortlinkUtmSource: string
    shortlinkStatus: string
    shortlinkUtmMatch: number
    commentDelaySeconds: number
    triggerSource: string
  }

  let date = $state(todayBangkokDate())
  let rows = $state<HistoryRow[]>([])
  let loading = $state(true)
  let error = $state('')
  let updatedAt = $state('')

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
  function normalize(raw: unknown): HistoryRow | null {
    if (!isRecord(raw)) return null
    const id = safeNumber(raw.id)
    const videoId = safeString(raw.video_id ?? raw.videoId)
    if (!id && !videoId) return null
    return {
      id,
      videoId,
      pageId: safeString(raw.page_id ?? raw.pageId),
      fbPostId: safeString(raw.fb_post_id ?? raw.fbPostId),
      fbReelUrl: safeString(raw.fb_reel_url ?? raw.fbReelUrl),
      postedAt: safeString(raw.posted_at ?? raw.postedAt),
      status: safeString(raw.status),
      errorMessage: safeString(raw.error_message ?? raw.errorMessage),
      commentStatus: safeString(raw.comment_status ?? raw.commentStatus),
      commentError: safeString(raw.comment_error ?? raw.commentError),
      commentFbId: safeString(raw.comment_fb_id ?? raw.commentFbId),
      shopeeLink: safeString(raw.shopee_link ?? raw.shopeeLink),
      postProfileName: safeString(raw.post_profile_name ?? raw.postProfileName),
      commentProfileName: safeString(raw.comment_profile_name ?? raw.commentProfileName),
      shortlinkUtmSource: safeString(raw.shortlink_utm_source ?? raw.shortlinkUtmSource),
      shortlinkStatus: safeString(raw.shortlink_status ?? raw.shortlinkStatus),
      shortlinkUtmMatch: safeNumber(raw.shortlink_utm_match ?? raw.shortlinkUtmMatch),
      commentDelaySeconds: safeNumber(raw.comment_delay_seconds ?? raw.commentDelaySeconds),
      triggerSource: safeString(raw.trigger_source ?? raw.triggerSource),
    }
  }

  async function load() {
    loading = true
    error = ''
    try {
      const data = await fetchJson<{ history?: unknown[] }>(
        `/api/post-history?date=${encodeURIComponent(date)}&limit=200`,
        { timeoutMs: 30000 },
      )
      const list = Array.isArray(data.history) ? data.history : []
      rows = list.map(normalize).filter((r): r is HistoryRow => r !== null)
      updatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  function statusColor(status: string): string {
    if (status === 'success' || status === 'verified') return 'bg-emerald-50 text-emerald-700'
    if (status === 'failed' || status === 'error') return 'bg-rose-50 text-rose-700'
    if (status === 'pending' || status === 'queued') return 'bg-amber-50 text-amber-700'
    return 'bg-slate-100 text-slate-600'
  }

  function buildFbPostUrl(row: HistoryRow): string {
    if (row.fbReelUrl) {
      if (/^https?:\/\//i.test(row.fbReelUrl)) return row.fbReelUrl
      return `https://www.facebook.com${row.fbReelUrl.startsWith('/') ? '' : '/'}${row.fbReelUrl}`
    }
    if (row.pageId && row.fbPostId) {
      return `https://www.facebook.com/${row.pageId}/posts/${row.fbPostId}`
    }
    if (row.fbPostId) {
      return `https://www.facebook.com/${row.fbPostId}`
    }
    return ''
  }

  onMount(load)
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">ประวัติการเผยแพร่</p>
      <p class="mt-0.5 text-xs text-slate-600">โพสต์ที่ระบบเผยแพร่ไปเพจในวันที่เลือก · ทั้งสถานะโพสต์และคอมเมนต์</p>
    </div>
    <div class="flex items-center gap-3 text-xs text-slate-500">
      <label class="flex items-center gap-2">
        <span>วันที่</span>
        <input
          type="date"
          bind:value={date}
          class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
        />
      </label>
      <button
        type="button"
        onclick={() => void load()}
        disabled={loading}
        class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loading ? 'กำลังโหลด…' : 'รีเฟรช'}
      </button>
    </div>
  </div>

  {#if error}
    <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      โหลดประวัติไม่สำเร็จ: {error}
    </div>
  {/if}

  {#if loading && rows.length === 0}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="h-24 animate-pulse rounded-3xl bg-slate-100"></div>
      {/each}
    </div>
  {:else if rows.length === 0}
    <div class="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500">
      ยังไม่มีโพสต์ที่เผยแพร่ในวันที่เลือก
    </div>
  {:else}
    <div class="space-y-3">
      {#each rows as row (row.id || row.fbPostId)}
        {@const postUrl = buildFbPostUrl(row)}
        <article class="rounded-3xl border border-slate-200 bg-white p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded-full px-2.5 py-1 text-[11px] font-bold {statusColor(row.status)}">
                  post · {row.status || 'unknown'}
                </span>
                <span class="rounded-full px-2.5 py-1 text-[11px] font-bold {statusColor(row.commentStatus)}">
                  comment · {row.commentStatus || '—'}
                </span>
                {#if row.triggerSource}
                  <span class="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                    trigger · {row.triggerSource}
                  </span>
                {/if}
                <span class="text-[11px] text-slate-400">#{row.id}</span>
                <span class="text-[11px] text-slate-500">{formatThaiDateTime(row.postedAt)}</span>
              </div>
              <p class="text-sm font-medium text-slate-900">
                page <span class="font-mono">{row.pageId || '-'}</span>
                · video <span class="font-mono">{row.videoId || '-'}</span>
              </p>
              {#if postUrl}
                <a
                  href={postUrl}
                  target="_blank"
                  rel="noreferrer"
                  class="break-all text-xs font-medium text-[#1877f2] hover:underline"
                >
                  {postUrl}
                </a>
              {/if}
              {#if row.shopeeLink}
                <p class="truncate text-[11px] text-slate-500">
                  shopee · <a href={row.shopeeLink} target="_blank" rel="noreferrer" class="hover:underline">{row.shopeeLink}</a>
                </p>
              {/if}
              {#if row.errorMessage}
                <p class="text-xs text-rose-600">⚠ post error: {row.errorMessage}</p>
              {/if}
              {#if row.commentError}
                <p class="text-xs text-rose-600">⚠ comment error: {row.commentError}</p>
              {/if}
            </div>
            <div class="shrink-0 grid grid-cols-2 gap-1.5 text-[11px] text-slate-500">
              {#if row.shortlinkUtmSource}
                <span class="rounded bg-slate-50 px-2 py-1">utm {row.shortlinkUtmSource}</span>
              {/if}
              {#if row.shortlinkStatus}
                <span class="rounded {row.shortlinkUtmMatch ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'} px-2 py-1">
                  shortlink {row.shortlinkStatus}
                </span>
              {/if}
              {#if row.commentDelaySeconds}
                <span class="rounded bg-slate-50 px-2 py-1">delay {row.commentDelaySeconds}s</span>
              {/if}
              {#if row.postProfileName}
                <span class="rounded bg-slate-50 px-2 py-1">post {row.postProfileName}</span>
              {/if}
              {#if row.commentProfileName}
                <span class="rounded bg-slate-50 px-2 py-1">comment {row.commentProfileName}</span>
              {/if}
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
    <span>ประวัติ · /api/post-history?date={date}</span>
    {#if updatedAt}<span>อัปเดต {updatedAt}</span>{/if}
  </div>
</div>
