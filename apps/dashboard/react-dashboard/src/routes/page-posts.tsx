import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  externalVideoUrl,
  fetchPageVideos,
  systemVideoDownloadUrl,
  systemVideoThumbUrl,
  type PageVideoItem,
} from '@/api/pagePosts'
import { fetchSettingsPages, FALLBACK_PAGES, type SettingsPage } from '@/api/settings'
import { formatCompactViews, formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

// Parity defaults with the Svelte PagePostsPanel: ≥100K views, 48 rows/batch.
const DEFAULT_MIN_VIEWS = 100_000
const DEFAULT_BATCH = 48

// Scope sentinel for "ทุกเพจ" — aggregate every page source in the namespace.
const ALL_PAGES = '__all__'

interface SyncMeta {
  lastSyncedAt?: string | null
  lastFullScanAt?: string | null
  fullyScanned?: boolean | null
}

// One fetched batch (a single offset window) across the in-scope pages. For
// all-pages mode this is the merge of one offset window per page; for a single
// page it is just that page's window.
interface PostsBatch {
  items: PageVideoItem[]
  total: number
  sync: SyncMeta | null
  dataSource: string | null
  // True when at least one in-scope page returned a full window, so another
  // offset window may still hold rows.
  hasMore: boolean
}

function toSync(value: unknown): SyncMeta | null {
  return (value ?? null) as SyncMeta | null
}

// Newest-first comparable timestamp; unparseable/missing sorts last.
function postTime(item: PageVideoItem): number {
  const raw = (item.postedAt || item.createdAt || '').trim()
  if (!raw) return 0
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : 0
}

// Thumbnail preview for a page-post card. Tries real thumbnail candidates in
// order — the Worker video thumb, the Facebook thumb, then the system gallery
// thumb for systemVideoId — advancing to the next on each load error. Only when
// every candidate fails (or none exist) does it fall back to a play-icon
// placeholder (no invented URLs). Reels are vertical, so the card is 9:16.
function PostThumb({ item }: { item: PageVideoItem }) {
  // Build the ordered candidate list once per item: real fields first, then the
  // system gallery thumb as a last-resort fallback.
  const candidates = useMemo(() => {
    const list = [
      (item.videoThumb || '').trim(),
      (item.facebookThumb || '').trim(),
      systemVideoThumbUrl(item) || '',
    ]
    // De-dupe and drop empties so onError advances cleanly to a distinct URL.
    return Array.from(new Set(list.filter(Boolean)))
  }, [item])

  const [index, setIndex] = useState(0)
  const src = candidates[index]

  if (!src) {
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
      alt={item.videoTitle || item.videoId || 'video'}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setIndex((i) => i + 1)}
    />
  )
}

function PostCard({ item }: { item: PageVideoItem }) {
  const title = item.videoTitle || item.videoId || '—'
  const timestamp = item.postedAt || item.createdAt
  const assetStatus = item.assetLibrary?.status ?? null
  const pageName = (item.pageName || '').trim()
  const sysUrl = systemVideoDownloadUrl(item)
  const extUrl = sysUrl ? null : externalVideoUrl(item)

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition hover:border-primary/40 hover:shadow-md">
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-muted">
        <PostThumb item={item} />
        {pageName ? (
          <span className="absolute left-2 top-2 max-w-[70%] truncate rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {pageName}
          </span>
        ) : null}
        <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
          {formatCompactViews(item.views)} วิว
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 text-sm font-medium" title={title}>
          {title}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="whitespace-nowrap">{formatThaiDateTime(timestamp) || '—'}</span>
          {assetStatus ? (
            <Badge variant="secondary" className="text-[10px]">
              {assetStatus}
            </Badge>
          ) : null}
        </div>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1 text-xs">
          {item.shopeeLink ? (
            <a
              href={item.shopeeLink}
              target="_blank"
              rel="noreferrer"
              aria-label="เปิดลิงก์ Shopee"
              className="rounded bg-orange-50 px-2 py-1 font-semibold text-orange-700 hover:bg-orange-100"
            >
              Shopee ↗
            </a>
          ) : null}
          {sysUrl ? (
            // download=1 forces the worker's attachment streaming (shouldForceAttachment).
            <a
              href={sysUrl}
              download
              target="_blank"
              rel="noreferrer"
              aria-label="ดาวน์โหลดวิดีโอระบบ"
              className="rounded bg-primary/10 px-2 py-1 font-semibold text-primary hover:bg-primary/20"
            >
              ดาวน์โหลด ↓
            </a>
          ) : extUrl ? (
            <a
              href={extUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="เปิดวิดีโอภายนอก"
              className="rounded bg-muted px-2 py-1 font-semibold text-foreground hover:bg-accent"
            >
              เปิดวิดีโอ ↗
            </a>
          ) : (
            <span
              className="rounded px-2 py-1 text-muted-foreground"
              title="ไม่มีวิดีโอระบบที่ match กับโพสต์นี้"
            >
              ไม่มีวิดีโอ
            </span>
          )}
        </div>
      </div>
    </article>
  )
}

export function PagePostsPage() {
  // Default scope = ทุกเพจ; cards load automatically on mount (no submit).
  const [scope, setScope] = useState<string>(ALL_PAGES)
  // Live input strings + committed numeric filters. The committed values feed
  // the query key so changing them never requires a submit, but typing only
  // re-queries on blur/Enter (avoids a refetch per keystroke).
  const [minViewsInput, setMinViewsInput] = useState(String(DEFAULT_MIN_VIEWS))
  const [limitInput, setLimitInput] = useState(String(DEFAULT_BATCH))
  const [minViews, setMinViews] = useState(DEFAULT_MIN_VIEWS)
  const [limit, setLimit] = useState(DEFAULT_BATCH)

  // Redacted page source list for the namespace. Falls back to the default page
  // when the endpoint fails, so all-pages mode still shows something.
  const pagesQuery = useQuery({
    queryKey: ['page-sources'],
    queryFn: ({ signal }) => fetchSettingsPages(signal),
    staleTime: 5 * 60_000,
  })
  const pages: SettingsPage[] = pagesQuery.data ?? FALLBACK_PAGES

  // Resolve the in-scope pages. Single page = the matching source (or default).
  const targetPages = useMemo<SettingsPage[]>(() => {
    if (scope === ALL_PAGES) return pages.length ? pages : FALLBACK_PAGES
    const match = pages.find((p) => p.id === scope)
    return match ? [match] : FALLBACK_PAGES
  }, [scope, pages])

  const targetIds = targetPages.map((p) => p.id).join(',')

  const result = useInfiniteQuery<PostsBatch>({
    queryKey: ['page-videos', scope, targetIds, minViews, limit],
    // Wait for the source list to settle so all-pages mode fans out correctly;
    // on error pagesQuery.data is undefined and we fall back to the default page.
    enabled: !pagesQuery.isLoading,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const batchIndex = pageParam as number
      const offset = batchIndex * limit
      const byPage = await Promise.all(
        targetPages.map(async (p) => {
          const resp = await fetchPageVideos(
            { pageId: p.id, minViews, limit, offset, sort: 'newest' },
            signal,
          )
          // Stamp the page name so all-pages cards stay attributable.
          const items = (resp.items ?? []).map((it) => ({
            ...it,
            pageName: (it.pageName || resp.page_name || p.name || '').trim(),
          }))
          return { resp, items }
        }),
      )
      const items = byPage.flatMap((r) => r.items)
      const total = byPage.reduce((sum, r) => sum + (r.resp.total ?? 0), 0)
      const single = targetPages.length === 1 ? byPage[0] : null
      return {
        items,
        total,
        sync: toSync(single?.resp.sync),
        dataSource: single?.resp.data_source ?? null,
        hasMore: byPage.some((r) => r.items.length >= limit),
      }
    },
    getNextPageParam: (lastPage, allPages) => {
      const nextIndex = allPages.length
      if (targetPages.length > 1) {
        // All-pages mode: keep pulling offset windows while any page is full.
        return lastPage.hasMore ? nextIndex : undefined
      }
      // Single page: standard offset pagination, stop at total.
      if (!lastPage.items.length) return undefined
      const loaded = allPages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < (lastPage.total ?? 0) ? nextIndex : undefined
    },
  })

  // Flatten, de-dupe (storyId||videoId||postId), then sort newest-first so the
  // merged all-pages stream is chronological rather than grouped by page.
  const items = useMemo(() => {
    const pagesData = result.data?.pages ?? []
    const seen = new Set<string>()
    const out: PageVideoItem[] = []
    for (const batch of pagesData) {
      for (const item of batch.items ?? []) {
        const key = item.storyId || item.videoId || item.postId || ''
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
  const dataSource = lastPage?.dataSource ?? null
  const remaining = Math.max(total - items.length, 0)

  function commitFilters() {
    setMinViews(Number(minViewsInput) || 0)
    setLimit(Math.min(Math.max(Number(limitInput) || DEFAULT_BATCH, 1), 1000))
  }

  function onFilterKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitFilters()
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">โพสต์เพจ</h1>
        <p className="text-sm text-muted-foreground">
          คลิปยอดวิว ≥ {formatCompactViews(minViews)} จากเพจในเวิร์กสเปซ — แสดงจากแคชเพื่อความรวดเร็ว
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
              <Label htmlFor="pp-min-views">Min views</Label>
              <Input
                id="pp-min-views"
                inputMode="numeric"
                className="w-28"
                value={minViewsInput}
                onChange={(e) => setMinViewsInput(e.target.value)}
                onBlur={commitFilters}
                onKeyDown={onFilterKeyDown}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pp-limit">ต่อหน้า</Label>
              <Input
                id="pp-limit"
                inputMode="numeric"
                className="w-24"
                value={limitInput}
                onChange={(e) => setLimitInput(e.target.value)}
                onBlur={commitFilters}
                onKeyDown={onFilterKeyDown}
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
          </div>
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
                {total > items.length ? ` จาก ${formatCompactViews(total)}` : ''} คลิป
              </span>
              <Badge variant="outline">
                {scope === ALL_PAGES ? `ทุกเพจ (${targetPages.length})` : targetPages[0]?.name || scope}
              </Badge>
              {dataSource ? <Badge variant="outline">{dataSource}</Badge> : null}
              {sync?.fullyScanned ? <Badge variant="success">sync ครบทั้งเพจ</Badge> : null}
            </div>
            <div className="flex flex-col items-start gap-0.5 text-xs text-muted-foreground sm:items-end">
              {sync?.lastSyncedAt ? <span>sync ล่าสุด: {formatThaiDateTime(sync.lastSyncedAt)}</span> : null}
              {sync?.lastFullScanAt ? (
                <span>สแกนเต็มล่าสุด: {formatThaiDateTime(sync.lastFullScanAt)}</span>
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
                  <PostCard key={item.storyId || item.videoId || item.postId} item={item} />
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
                      ? `โหลดเพิ่ม (${formatCompactViews(remaining)} คลิป)`
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
