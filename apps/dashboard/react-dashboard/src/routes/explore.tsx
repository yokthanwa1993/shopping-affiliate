import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  addWatchedPage,
  fetchExternalPosts,
  fetchWatchedPages,
  removeWatchedPage,
  setWatchedPageEnabled,
  syncWatchedPages,
  type ExternalPost,
  type WatchedPage,
} from '@/api/explore'
import { formatCompactViews, formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

// Explore = a WATCHED EXTERNAL PAGES feature. The operator adds Facebook pages
// they do NOT own (by URL or ID); a worker cron + manual sync continuously
// fetches those pages' posts/clips and view metrics into our own cache. This
// view is read-only — it never posts, comments, or creates ads, and it does NOT
// use the operator's owned posting Pages. See worker
// /api/dashboard/explore/* and dashboard_external_* tables.
const DEFAULT_BATCH = 60
const ALL_PAGES = '__all__'

type SortOrder = 'newest' | 'oldest' | 'views'

interface PostsBatch {
  items: ExternalPost[]
  total: number
}

function postKey(item: ExternalPost): string {
  return `${item.page_id || ''}:${item.post_id || item.video_id || ''}`
}

// Thumbnail preview for an external post card. Tries the cached Facebook
// thumbnail; on error (expired fbcdn URL) it falls back to a play-icon
// placeholder — never an invented URL. Reels are vertical (9:16).
function PostThumb({ item }: { item: ExternalPost }) {
  const src = (item.thumbnail || '').trim()
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
      src={src}
      alt={item.title || item.post_id || 'post'}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}

function PostCard({ item }: { item: ExternalPost }) {
  const title = (item.title || item.caption || item.post_id || '—').trim() || '—'
  const pageName = (item.page_name || item.page_id || '').trim()
  const fbUrl = (item.post_url || '').trim() || null
  const srcUrl = (item.source_url || '').trim() || null

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition hover:border-primary/40 hover:shadow-md">
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-muted">
        <PostThumb item={item} />
        {pageName ? (
          <span className="absolute left-2 top-2 max-w-[70%] truncate rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {pageName}
          </span>
        ) : null}
        {item.is_video ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
            {formatCompactViews(item.views)} วิว
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 text-sm font-medium" title={title}>
          {title}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="whitespace-nowrap">{formatThaiDateTime(item.created_time) || '—'}</span>
          {item.is_video ? <Badge variant="secondary" className="text-[10px]">วิดีโอ</Badge> : null}
        </div>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1 text-xs">
          {fbUrl ? (
            <a
              href={fbUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="เปิดโพสต์บน Facebook"
              className="rounded bg-blue-50 px-2 py-1 font-semibold text-blue-700 hover:bg-blue-100"
            >
              Facebook ↗
            </a>
          ) : null}
          {srcUrl ? (
            <a
              href={srcUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="เปิดไฟล์วิดีโอ"
              className="rounded bg-muted px-2 py-1 font-semibold text-foreground hover:bg-accent"
            >
              เปิดวิดีโอ ↗
            </a>
          ) : null}
        </div>
      </div>
    </article>
  )
}

// One watched external page row: status + enable toggle + sync + remove.
function WatchedPageRow({
  page,
  busy,
  onSync,
  onToggle,
  onRemove,
}: {
  page: WatchedPage
  busy: boolean
  onSync: () => void
  onToggle: () => void
  onRemove: () => void
}) {
  const name = (page.page_name || '').trim() || page.page_id
  const url = (page.page_url || '').trim()
  const error = (page.last_error || '').trim()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium" title={name}>
            {name}
          </span>
          <Badge variant={page.enabled ? 'success' : 'outline'} className="text-[10px]">
            {page.enabled ? 'ติดตามอยู่' : 'พัก'}
          </Badge>
          <Badge variant="outline" className="text-[10px] tabular-nums">
            {formatCompactViews(page.posts_count ?? 0)} โพสต์
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="truncate hover:underline">
              {url}
            </a>
          ) : (
            <span>ID: {page.page_id}</span>
          )}
          {page.last_synced_at ? <span>sync: {formatThaiDateTime(page.last_synced_at)}</span> : null}
          {error ? (
            <span className="font-semibold text-destructive" title={error}>
              ⚠ {error}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onSync}>
          {busy ? 'กำลังซิงก์…' : 'ซิงก์'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onToggle}>
          {page.enabled ? 'พัก' : 'เปิด'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onRemove}
          className="text-destructive hover:text-destructive"
        >
          ลบ
        </Button>
      </div>
    </div>
  )
}

export function ExplorePage() {
  const queryClient = useQueryClient()
  const [urlInput, setUrlInput] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  const [scope, setScope] = useState<string>(ALL_PAGES)
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [sort, setSort] = useState<SortOrder>('newest')
  const [minViewsInput, setMinViewsInput] = useState('0')
  const [minViews, setMinViews] = useState(0)

  const watchedQuery = useQuery({
    queryKey: ['explore-watched-pages'],
    queryFn: ({ signal }) => fetchWatchedPages(signal),
    staleTime: 30_000,
  })
  const pages: WatchedPage[] = watchedQuery.data?.pages ?? []

  const addMutation = useMutation({
    mutationFn: (value: string) => addWatchedPage(value),
    onSuccess: () => {
      setUrlInput('')
      setAddError(null)
      void queryClient.invalidateQueries({ queryKey: ['explore-watched-pages'] })
    },
    onError: (e) => setAddError(e instanceof Error ? e.message : 'เพิ่มเพจไม่สำเร็จ'),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ pageKey, enabled }: { pageKey: string; enabled: boolean }) =>
      setWatchedPageEnabled(pageKey, enabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['explore-watched-pages'] }),
  })

  const removeMutation = useMutation({
    mutationFn: (pageKey: string) => removeWatchedPage(pageKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['explore-watched-pages'] })
      void queryClient.invalidateQueries({ queryKey: ['explore-posts'] })
    },
  })

  const syncMutation = useMutation({
    mutationFn: (params: { pageId?: string; all?: boolean }) => syncWatchedPages(params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['explore-watched-pages'] })
      void queryClient.invalidateQueries({ queryKey: ['explore-posts'] })
    },
  })

  const scopePageId = scope === ALL_PAGES ? undefined : scope

  const postsQuery = useInfiniteQuery<PostsBatch>({
    queryKey: ['explore-posts', scopePageId ?? ALL_PAGES, keyword, minViews, sort],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const offset = (pageParam as number) * DEFAULT_BATCH
      const resp = await fetchExternalPosts(
        { pageId: scopePageId, search: keyword, minViews, sort, limit: DEFAULT_BATCH, offset },
        signal,
      )
      return { items: resp.items ?? [], total: resp.total ?? 0 }
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.items.length, 0)
      return loaded < (lastPage.total ?? 0) ? allPages.length : undefined
    },
  })

  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: ExternalPost[] = []
    for (const batch of postsQuery.data?.pages ?? []) {
      for (const item of batch.items) {
        const key = postKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
    }
    return out
  }, [postsQuery.data])

  const total = postsQuery.data?.pages.at(-1)?.total ?? 0
  const remaining = Math.max(total - items.length, 0)

  function commitFilters() {
    setKeyword(keywordInput.trim())
    setMinViews(Math.max(0, Number(minViewsInput) || 0))
  }

  function onFilterKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitFilters()
    }
  }

  function submitAdd() {
    const value = urlInput.trim()
    if (!value) return
    addMutation.mutate(value)
  }

  const syncingPageId =
    syncMutation.isPending && !syncMutation.variables?.all ? syncMutation.variables?.pageId : undefined

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Explore · เพจภายนอก</h1>
        <p className="text-sm text-muted-foreground">
          เพิ่มลิงก์/ไอดีเพจ Facebook ที่ <strong>ไม่ใช่เพจของเรา</strong> เพื่อติดตาม — ระบบจะดึงโพสต์/คลิป
          และยอดวิวเข้ามาเก็บไว้อัตโนมัติ (อ่านอย่างเดียว ไม่โพสต์/คอมเมนต์/ยิงแอด)
        </p>
      </div>

      {/* Add + manage watched external pages */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <span className="text-sm font-medium">เพจที่ติดตาม ({pages.length})</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={syncMutation.isPending || pages.length === 0}
            onClick={() => syncMutation.mutate({ all: true })}
          >
            {syncMutation.isPending && syncMutation.variables?.all ? 'กำลังซิงก์ทั้งหมด…' : 'ซิงก์ทั้งหมด'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[260px] flex-1 space-y-1">
              <Label htmlFor="explore-add">เพิ่มเพจ (URL หรือ ID)</Label>
              <Input
                id="explore-add"
                placeholder="เช่น https://www.facebook.com/SomePage หรือ 123456789012345"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitAdd()
                  }
                }}
              />
            </div>
            <Button type="button" disabled={addMutation.isPending || !urlInput.trim()} onClick={submitAdd}>
              {addMutation.isPending ? 'กำลังเพิ่ม…' : 'เพิ่มเพจ'}
            </Button>
          </div>
          {addError ? <p className="text-sm text-destructive">{addError}</p> : null}

          {watchedQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : pages.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              ยังไม่มีเพจที่ติดตาม — เพิ่มลิงก์เพจด้านบนเพื่อเริ่มดึงโพสต์
            </p>
          ) : (
            <div className="space-y-2">
              {pages.map((page) => (
                <WatchedPageRow
                  key={page.page_id}
                  page={page}
                  busy={
                    (syncingPageId === page.page_id) ||
                    (toggleMutation.isPending && toggleMutation.variables?.pageKey === page.page_id) ||
                    (removeMutation.isPending && removeMutation.variables === page.page_id)
                  }
                  onSync={() => syncMutation.mutate({ pageId: page.page_id })}
                  onToggle={() => toggleMutation.mutate({ pageKey: page.page_id, enabled: !page.enabled })}
                  onRemove={() => {
                    if (window.confirm(`ลบเพจ "${page.page_name || page.page_id}" และโพสต์ที่แคชไว้?`)) {
                      removeMutation.mutate(page.page_id)
                    }
                  }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Search + filters for the cached external posts */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="space-y-1">
            <Label htmlFor="explore-q">ค้นหาโพสต์ที่ดึงมา</Label>
            <Input
              id="explore-q"
              type="search"
              placeholder="พิมพ์คำค้น เช่น แคปชั่น ชื่อเพจ หรือ post id…"
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={onFilterKeyDown}
              onBlur={commitFilters}
            />
          </div>

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
                key={p.page_id}
                type="button"
                onClick={() => setScope(p.page_id)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                  scope === p.page_id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-foreground hover:border-primary/40'
                }`}
              >
                {p.page_name || p.page_id}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="explore-min-views">Min views</Label>
              <Input
                id="explore-min-views"
                inputMode="numeric"
                className="w-28"
                value={minViewsInput}
                onChange={(e) => setMinViewsInput(e.target.value)}
                onBlur={commitFilters}
                onKeyDown={onFilterKeyDown}
              />
            </div>
            <div className="space-y-1">
              <Label>เรียงลำดับ</Label>
              <div className="flex gap-1.5">
                {(['newest', 'oldest', 'views'] as const).map((order) => (
                  <button
                    key={order}
                    type="button"
                    onClick={() => setSort(order)}
                    className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                      sort === order
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-background text-foreground hover:border-primary/40'
                    }`}
                  >
                    {order === 'newest' ? 'ใหม่สุด' : order === 'oldest' ? 'เก่าสุด' : 'วิวสูงสุด'}
                  </button>
                ))}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void postsQuery.refetch()}
              disabled={postsQuery.isFetching}
            >
              {postsQuery.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {postsQuery.isError ? (
        <Card>
          <CardContent className="space-y-2 p-6">
            <p className="text-sm font-medium text-destructive">โหลดข้อมูลไม่สำเร็จ</p>
            <p className="text-sm text-muted-foreground">
              {postsQuery.error instanceof Error ? postsQuery.error.message : 'unknown error'}
            </p>
            <p className="text-xs text-muted-foreground">หมายเหตุ: ต้องเข้าสู่ระบบแดชบอร์ดก่อนจึงจะดึงข้อมูลได้</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-col items-start gap-2 space-y-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                แสดง {items.length}
                {total > items.length ? ` จาก ${formatCompactViews(total)}` : ''} โพสต์
              </span>
              <Badge variant="outline">
                {scope === ALL_PAGES ? `ทุกเพจ (${pages.length})` : pages.find((p) => p.page_id === scope)?.page_name || scope}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {postsQuery.isLoading ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="aspect-[9/16] animate-pulse rounded-xl bg-muted" />
                ))}
              </div>
            ) : items.length === 0 && !postsQuery.isFetching ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {pages.length === 0
                  ? 'เพิ่มเพจภายนอกด้านบน แล้วกดซิงก์เพื่อดึงโพสต์'
                  : 'ยังไม่มีโพสต์ที่ตรงกับเงื่อนไข — ลองกดซิงก์หรือปรับคำค้น/Min views'}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
                {items.map((item) => (
                  <PostCard key={postKey(item)} item={item} />
                ))}
              </div>
            )}

            {postsQuery.hasNextPage ? (
              <div className="flex justify-center pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void postsQuery.fetchNextPage()}
                  disabled={postsQuery.isFetchingNextPage}
                >
                  {postsQuery.isFetchingNextPage
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
