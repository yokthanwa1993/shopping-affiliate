import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  fetchGallery,
  galleryThumbSrc,
  GALLERY_PAGE_SIZE,
  type GalleryView,
  type GalleryVideo,
} from '@/api/gallery'
import { formatThaiDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const VIEWS: Array<{ key: GalleryView; label: string }> = [
  { key: 'ready', label: 'ยังไม่โพสต์' },
  { key: 'used', label: 'โพสต์แล้ว' },
]

function Thumb({ video }: { video: GalleryVideo }) {
  const [failed, setFailed] = useState(false)
  const src = galleryThumbSrc(video)
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
      alt={video.id}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}

function GalleryDetailModal({
  video,
  view,
  onClose,
}: {
  video: GalleryVideo
  view: GalleryView
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  // Close on Escape; lock body scroll while the overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const copyId = () => {
    if (!video.id) return
    void navigator.clipboard?.writeText(video.id).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }

  const tags = video.category
    ? video.category.split(',').map((t) => t.trim()).filter(Boolean)
    : []
  const timestamp =
    view === 'used' && video.postedAt ? video.postedAt : video.createdAt

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={video.title || video.id}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border bg-card shadow-xl sm:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="ปิด"
          className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/70"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className="flex items-center justify-center bg-black sm:w-1/2">
          {video.publicUrl ? (
            <video
              src={video.publicUrl}
              poster={galleryThumbSrc(video) || undefined}
              controls
              playsInline
              className="max-h-[50vh] w-full object-contain sm:max-h-[90vh]"
            />
          ) : (
            <div className="flex aspect-[9/16] w-full items-center justify-center text-muted-foreground">
              ไม่มีวิดีโอ
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:w-1/2">
          <h2 className="text-base font-semibold leading-snug">{video.title || video.id}</h2>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">{video.id}</span>
            {video.id ? (
              <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={copyId}>
                {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </Button>
            ) : null}
          </div>

          {timestamp ? (
            <p className="text-xs text-muted-foreground">{formatThaiDateTime(timestamp)}</p>
          ) : null}

          {tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          <div className="mt-auto flex flex-col gap-2 pt-2">
            {video.shopeeLink ? (
              <a
                href={video.shopeeLink}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-orange-50 px-3 py-2 text-center text-sm font-semibold text-orange-700 transition hover:bg-orange-100"
              >
                เปิด Shopee
              </a>
            ) : null}
            {video.lazadaLink ? (
              <a
                href={video.lazadaLink}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-pink-50 px-3 py-2 text-center text-sm font-semibold text-pink-700 transition hover:bg-pink-100"
              >
                เปิด Lazada
              </a>
            ) : null}
            {video.publicUrl ? (
              <a
                href={video.publicUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-muted px-3 py-2 text-center text-sm font-semibold text-foreground transition hover:bg-accent"
              >
                เปิดวิดีโอในแท็บใหม่
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export function GalleryPage() {
  const [view, setView] = useState<GalleryView>('ready')
  const [search, setSearch] = useState('')
  // Clicking a card opens an in-app detail modal (like the mobile LINE gallery)
  // instead of navigating away to the raw video URL.
  const [selected, setSelected] = useState<GalleryVideo | null>(null)

  const query = useInfiniteQuery({
    queryKey: ['gallery', view],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      // Fast path: skip the worker count tallies so the first page paints fast.
      // The Gallery tabs no longer show counts, so we don't need exact totals.
      fetchGallery(view, signal, { offset: pageParam, limit: GALLERY_PAGE_SIZE, includeCounts: false }),
    getNextPageParam: (lastPage) => {
      // The fast path dedupes by source fingerprint, so it consumes more raw
      // rows than it returns videos. Resume from the raw cursor it reports
      // (`nextOffset`) instead of counting videos shown, otherwise pagination
      // would skip rows. Stop when the worker says there are no more pages.
      if (!lastPage.hasMore) return undefined
      if (lastPage.nextOffset == null) return undefined
      return lastPage.nextOffset
    },
  })

  // Flatten pages and de-dupe by source fingerprint (fall back to video id),
  // mirroring the worker's per-page dedupe. Clips that share a fingerprint have
  // *different* ids, so an id-only de-dupe would let cross-page duplicates slip
  // through when the same source clip reappears in a later batch.
  const videos = useMemo(() => {
    const pages = query.data?.pages ?? []
    const seen = new Set<string>()
    const out: GalleryVideo[] = []
    for (const page of pages) {
      for (const video of page.videos ?? []) {
        const key = video.sourceFingerprint
          ? `fp::${video.sourceFingerprint}`
          : video.id
            ? `id::${video.id}`
            : ''
        if (key) {
          if (seen.has(key)) continue
          seen.add(key)
        }
        out.push(video)
      }
    }
    return out
  }, [query.data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return videos
    return videos.filter((v) => v.id.toLowerCase().includes(q) || v.title.toLowerCase().includes(q))
  }, [videos, search])

  // IntersectionObserver sentinel: auto-load the next page when scrolled near
  // the bottom. Disabled while searching (search filters loaded pages only).
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const autoLoad = search.trim() === ''
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !autoLoad) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          query.hasNextPage &&
          !query.isFetchingNextPage
        ) {
          void query.fetchNextPage()
        }
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [autoLoad, query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage])

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">แกลลี่</h1>
        <p className="text-sm text-muted-foreground">คลิปที่ import เข้าระบบแล้ว</p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          {VIEWS.map((v) => (
            <Button
              key={v.key}
              type="button"
              size="sm"
              variant={view === v.key ? 'default' : 'ghost'}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2 sm:max-w-md sm:flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหา video id หรือชื่อคลิป"
          />
          <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? '...' : 'รีเฟรช'}
          </Button>
        </div>
      </div>

      {query.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          ดึง gallery ไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
          <div className="mt-1 text-xs text-muted-foreground">
            หมายเหตุ: ต้องเข้าสู่ระบบแดชบอร์ดก่อนจึงจะดึงข้อมูลได้
          </div>
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="aspect-[9/16] animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {view === 'ready' ? 'ยังไม่มีคลิปที่รอโพสต์' : 'ยังไม่มีคลิปที่โพสต์แล้ว'}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((video) => (
            <article key={video.id || video.title} className="overflow-hidden rounded-xl border bg-card shadow-sm transition hover:shadow-md">
              <button
                type="button"
                onClick={() => setSelected(video)}
                aria-label={`ดูรายละเอียด ${video.title || video.id}`}
                className="relative block aspect-[9/16] w-full overflow-hidden bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Thumb video={video} />
                {video.duration ? (
                  <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                    {video.duration}
                  </span>
                ) : null}
              </button>
              <div className="space-y-2 p-3">
                <p className="line-clamp-2 text-sm font-medium">{video.title || video.id}</p>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span className="truncate font-mono">{video.id}</span>
                  <span>
                    {view === 'used' && video.postedAt
                      ? formatThaiDateTime(video.postedAt)
                      : formatThaiDateTime(video.createdAt)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1 text-xs">
                  {video.shopeeLink ? (
                    <a href={video.shopeeLink} target="_blank" rel="noreferrer" className="rounded bg-orange-50 px-2 py-1 font-semibold text-orange-700 hover:bg-orange-100">
                      Shopee
                    </a>
                  ) : null}
                  {video.lazadaLink ? (
                    <a href={video.lazadaLink} target="_blank" rel="noreferrer" className="rounded bg-pink-50 px-2 py-1 font-semibold text-pink-700 hover:bg-pink-100">
                      Lazada
                    </a>
                  ) : null}
                  {video.publicUrl ? (
                    <a href={video.publicUrl} target="_blank" rel="noreferrer" className="rounded bg-muted px-2 py-1 font-semibold text-foreground hover:bg-accent">
                      เปิดวิดีโอ
                    </a>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>แสดง {filtered.length} คลิป</span>
      </div>

      {/* Infinite-scroll sentinel + load-more / end-of-list status. Hidden while
          the initial skeleton or an error is showing. */}
      {!query.isLoading && !query.isError && search.trim() === '' ? (
        <div ref={sentinelRef} className="flex justify-center py-4 text-xs text-muted-foreground">
          {query.isFetchingNextPage ? (
            <span className="inline-flex items-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              กำลังโหลดเพิ่ม…
            </span>
          ) : query.hasNextPage ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void query.fetchNextPage()}>
              โหลดเพิ่ม
            </Button>
          ) : videos.length > 0 ? (
            <span>โหลดครบแล้ว</span>
          ) : null}
        </div>
      ) : null}

      {selected ? <GalleryDetailModal video={selected} view={view} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
