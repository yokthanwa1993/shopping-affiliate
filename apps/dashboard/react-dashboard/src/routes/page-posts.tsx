import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchPagePosts,
  pagePostPermalink,
  pagePostThumb,
  syncPagePosts,
  PAGE_POST_CACHE_SOURCE,
  type PagePostItem,
  type PagePostSync,
  type SyncPagePostsResult,
} from '@/api/pagePosts'
import { fetchSettingsPages, FALLBACK_PAGES, type SettingsPage } from '@/api/settings'
import { formatCompactViews, formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

// Rows per fetch window. This is the read page size, NOT a cap on total posts —
// the worker keeps every published post in facebook_page_post_cache.
const DEFAULT_BATCH = 48

// Scope sentinel for "ทุกเพจ" — the worker returns every page's posts in one
// namespace-wide query, so all-pages mode needs no per-page fan-out.
const ALL_PAGES = '__all__'

// One fetched window of cached posts plus the page's sync state (single-page
// scope only — namespace-wide mode aggregates many pages so has no single state).
interface PostsBatch {
  items: PagePostItem[]
  total: number
  sync: PagePostSync | null
  dataSource: string | null
}

// Newest-first comparable timestamp; unparseable/missing sorts last.
function postTime(item: PagePostItem): number {
  const raw = (item.created_time || '').trim()
  if (!raw) return 0
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : 0
}

// Cover preview for a post card. Uses the Graph `picture` cover when present,
// otherwise a media-type-shaped placeholder (no invented URLs). Reels/videos are
// vertical, so the card is 9:16.
function PostCover({ item }: { item: PagePostItem }) {
  const src = pagePostThumb(item)
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
        </svg>
      </div>
    )
  }
  return (
    <img
      key={src}
      src={src}
      alt={item.message || item.post_id || 'post'}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}

function PostCard({ item }: { item: PagePostItem }) {
  const caption = (item.message || '').trim() || '—'
  const pageName = (item.page_name || '').trim()
  const mediaType = (item.media_type || '').trim()
  const openUrl = pagePostPermalink(item)
  // Video posts open as "เปิดวิดีโอ"; everything else as "เปิดโพสต์".
  const isVideo = /video|reel/i.test(mediaType) || !!(item.video_id || '').trim()
  const openLabel = isVideo ? 'เปิดวิดีโอ' : 'เปิดโพสต์'

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition hover:border-primary/40 hover:shadow-md">
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-muted">
        <PostCover item={item} />
        {pageName ? (
          <span className="absolute left-2 top-2 max-w-[70%] truncate rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {pageName}
          </span>
        ) : null}
        {mediaType ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
            {mediaType}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 text-sm font-medium" title={caption}>
          {caption}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="whitespace-nowrap">{formatThaiDateTime(item.created_time) || '—'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
          <span title="ไลก์/รีแอกชัน">❤ {formatCompactViews(item.reactions_count ?? 0)}</span>
          <span title="คอมเมนต์">💬 {formatCompactViews(item.comments_count ?? 0)}</span>
          <span title="แชร์">↗ {formatCompactViews(item.shares_count ?? 0)}</span>
        </div>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1 text-xs">
          {openUrl ? (
            <a
              href={openUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`${openLabel}บน Facebook`}
              className="rounded bg-primary/10 px-2 py-1 font-semibold text-primary hover:bg-primary/20"
            >
              {openLabel} ↗
            </a>
          ) : (
            <span
              className="rounded px-2 py-1 text-muted-foreground"
              title="ไม่มีลิงก์ Facebook สำหรับโพสต์นี้"
            >
              ไม่มีลิงก์
            </span>
          )}
        </div>
      </div>
    </article>
  )
}

export function PagePostsPage() {
  const queryClient = useQueryClient()
  // Default scope = ทุกเพจ; cards load automatically on mount (no submit).
  const [scope, setScope] = useState<string>(ALL_PAGES)
  // Live input string + committed numeric limit. The committed value feeds the
  // query key so typing only re-queries on blur/Enter (no refetch per keystroke).
  const [limitInput, setLimitInput] = useState(String(DEFAULT_BATCH))
  const [limit, setLimit] = useState(DEFAULT_BATCH)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  // Redacted page source list for the namespace. Falls back to the default page
  // when the endpoint fails, so all-pages mode still shows something.
  const pagesQuery = useQuery({
    queryKey: ['page-sources'],
    queryFn: ({ signal }) => fetchSettingsPages(signal),
    staleTime: 5 * 60_000,
  })
  const pages: SettingsPage[] = pagesQuery.data ?? FALLBACK_PAGES

  // Single-page scope resolves to that page (for the sync control + label).
  const activePage = useMemo<SettingsPage | null>(() => {
    if (scope === ALL_PAGES) return null
    return pages.find((p) => p.id === scope) ?? FALLBACK_PAGES.find((p) => p.id === scope) ?? null
  }, [scope, pages])

  const result = useInfiniteQuery<PostsBatch>({
    queryKey: ['page-posts', scope, limit],
    enabled: !pagesQuery.isLoading,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const batchIndex = pageParam as number
      const offset = batchIndex * limit
      // Omit pageId in all-pages mode → the worker returns the whole namespace's
      // post cache in one query (no per-page fan-out needed).
      const resp = await fetchPagePosts(
        { pageId: scope === ALL_PAGES ? undefined : scope, limit, offset },
        signal,
      )
      return {
        items: resp.items ?? [],
        total: resp.total ?? 0,
        sync: (resp.sync ?? null) as PagePostSync | null,
        dataSource: resp.data_source ?? null,
      }
    },
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.items.length) return undefined
      const loaded = allPages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < (lastPage.total ?? 0) ? allPages.length : undefined
    },
  })

  // Flatten, de-dupe by post_id, then sort newest-first so the merged stream is
  // chronological rather than grouped by offset window.
  const items = useMemo(() => {
    const pagesData = result.data?.pages ?? []
    const seen = new Set<string>()
    const out: PagePostItem[] = []
    for (const batch of pagesData) {
      for (const item of batch.items ?? []) {
        const key = (item.post_id || '').trim()
        if (key) {
          if (seen.has(key)) continue
          seen.add(key)
        }
        out.push(item)
      }
    }
    out.sort((a, b) => postTime(b) - postTime(a))
    return out
  }, [result.data])

  const lastPage = result.data?.pages.at(-1)
  const total = lastPage?.total ?? 0
  const sync = lastPage?.sync ?? null
  // Always label the read source as the cache table the rows are served from.
  const dataSource = lastPage?.dataSource || PAGE_POST_CACHE_SOURCE
  const remaining = Math.max(total - items.length, 0)

  // One click = one bounded crawl batch for the selected page. The worker stores
  // the cursor, so re-clicking resumes; this never hammers Graph.
  const syncMutation = useMutation<SyncPagePostsResult, Error, void>({
    mutationFn: async () => {
      if (!activePage) throw new Error('เลือกเพจก่อนจึงจะดึงต่อได้')
      return syncPagePosts({ pageId: activePage.id, pageName: activePage.name })
    },
    onSuccess: (res) => {
      if (res.error) {
        setSyncNote(`ดึงไม่สำเร็จ: ${res.error}`)
        return
      }
      const cached = res.total_cached ?? 0
      const done = res.fully_scanned
        ? 'ครบทั้งเพจแล้ว'
        : res.pending_more
          ? 'ยังมีต่อ — กด “ดึงต่อ” อีกครั้ง'
          : ''
      setSyncNote(`ดึงเพิ่ม ${res.rows_upserted ?? 0} โพสต์ (รวมแคช ${cached.toLocaleString()}) ${done}`.trim())
      void queryClient.invalidateQueries({ queryKey: ['page-posts'] })
    },
    onError: (err) => setSyncNote(err instanceof Error ? err.message : 'ดึงไม่สำเร็จ'),
  })

  function commitLimit() {
    setLimit(Math.min(Math.max(Number(limitInput) || DEFAULT_BATCH, 1), 250))
  }

  function onLimitKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitLimit()
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Posts</h1>
        <p className="text-sm text-muted-foreground">
          โพสต์จริงทั้งหมดจากเพจในเวิร์กสเปซ — ดึงผ่าน Facebook Graph อย่างเป็นทางการ เก็บเฉพาะปก/ลิงก์/เมตา
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          {/* Scope chips: ทุกเพจ + one chip per page source. No submit needed. */}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setScope(ALL_PAGES)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                scope === ALL_PAGES
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background text-foreground hover:border-primary/40'
              }`}
            >
              ทุกเพจ
            </button>
            {pages.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setScope(p.id)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                  scope === p.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-foreground hover:border-primary/40'
                }`}
              >
                {p.name || p.id}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="pp-limit">ต่อหน้า</Label>
              <Input
                id="pp-limit"
                inputMode="numeric"
                className="w-24"
                value={limitInput}
                onChange={(e) => setLimitInput(e.target.value)}
                onBlur={commitLimit}
                onKeyDown={onLimitKeyDown}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void result.refetch()}
              disabled={result.isFetching}
            >
              {result.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
            </Button>
            {/* Sync control: single-page scope only (sync-page targets one page). */}
            {activePage ? (
              <Button
                type="button"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                title="ดึงโพสต์ชุดถัดไปจาก Facebook Graph แล้วบันทึกตำแหน่งไว้"
              >
                {syncMutation.isPending ? 'กำลังดึง…' : 'ดึงต่อ'}
              </Button>
            ) : null}
          </div>
          {syncNote ? <p className="text-xs text-muted-foreground">{syncNote}</p> : null}
        </CardContent>
      </Card>

      {result.isError ? (
        <Card>
          <CardContent className="space-y-2 p-6">
            <p className="text-sm font-medium text-destructive">โหลดข้อมูลไม่สำเร็จ</p>
            <p className="text-sm text-muted-foreground">
              {result.error instanceof Error ? result.error.message : 'unknown error'}
            </p>
            <p className="text-xs text-muted-foreground">
              หมายเหตุ: ต้องเข้าสู่ระบบแดชบอร์ดก่อนจึงจะดึงข้อมูลได้
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-col items-start gap-2 space-y-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                แสดง {items.length}
                {total > items.length ? ` จาก ${total.toLocaleString()}` : ''} โพสต์
              </span>
              <Badge variant="outline">
                {scope === ALL_PAGES ? `ทุกเพจ (${pages.length})` : activePage?.name || scope}
              </Badge>
              <Badge variant="outline">{dataSource}</Badge>
              {sync?.fully_scanned ? <Badge variant="success">sync ครบทั้งเพจ</Badge> : null}
            </div>
            <div className="flex flex-col items-start gap-0.5 text-xs text-muted-foreground sm:items-end">
              {sync?.last_synced_at ? <span>sync ล่าสุด: {formatThaiDateTime(sync.last_synced_at)}</span> : null}
              {sync?.last_full_scan_at ? (
                <span>สแกนเต็มล่าสุด: {formatThaiDateTime(sync.last_full_scan_at)}</span>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="aspect-[9/16] animate-pulse rounded-xl bg-muted" />
                ))}
              </div>
            ) : items.length === 0 && !result.isFetching ? (
              <p className="py-8 text-center text-sm text-muted-foreground">ไม่พบรายการ</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {items.map((item) => (
                  <PostCard key={item.post_id || item.permalink_url} item={item} />
                ))}
              </div>
            )}

            {result.hasNextPage ? (
              <div className="flex justify-center pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void result.fetchNextPage()}
                  disabled={result.isFetchingNextPage}
                >
                  {result.isFetchingNextPage
                    ? 'กำลังโหลด…'
                    : remaining > 0
                      ? `โหลดเพิ่ม (${formatCompactViews(remaining)} โพสต์)`
                      : 'โหลดเพิ่ม'}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
