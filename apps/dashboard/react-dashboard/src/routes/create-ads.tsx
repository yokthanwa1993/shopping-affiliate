import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchGallery, galleryThumbSrc, type GalleryVideo } from '@/api/gallery'
import { fetchPageVideos, type PageVideoItem } from '@/api/pagePosts'
import { DEFAULT_PAGE_ID, DEFAULT_PAGE_NAME } from '@/api/client'
import { formatCompactViews, formatThaiDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'

// Create Ads — full parity port of the Svelte CreateAdsPanel. Like the Svelte
// panel, this page is read-only: it lists ready gallery clips and high-view page
// posts, then lets the operator copy a System Video ID to drive ad creation in
// the downstream tool. No ad-creation request is issued from here (the Svelte
// panel never POSTed either — the actual enqueue happens from the Page Posts /
// Gallery actions and the external Electron / Feed Ad extension). Reuses the
// same read-only GET endpoints and Zod-typed clients as the rest of the app.

type Candidate = {
  source: 'gallery' | 'page-post'
  refId: string
  title: string
  thumb: string
  linkUrl: string
  postedAt: string
  views: number
}

function galleryToCandidate(video: GalleryVideo): Candidate | null {
  if (!video.id) return null
  return {
    source: 'gallery',
    refId: video.id,
    title: video.title || video.id,
    thumb: galleryThumbSrc(video),
    linkUrl: video.publicUrl,
    postedAt: video.postedAt || video.createdAt,
    views: 0,
  }
}

function pagePostToCandidate(item: PageVideoItem): Candidate | null {
  const sys = (item.systemVideoId ?? '').trim()
  const fb = (item.videoId ?? '').trim()
  const refId = sys || (fb ? `FB:${fb}` : '')
  if (!refId) return null
  return {
    source: 'page-post',
    refId,
    title: (item.videoTitle ?? '').trim() || refId,
    thumb: (item.facebookThumb ?? item.videoThumb ?? '').trim(),
    linkUrl: (item.postUrl ?? item.videoUrl ?? '').trim(),
    postedAt: (item.postedAt ?? item.createdAt ?? '').trim(),
    views: typeof item.views === 'number' ? item.views : 0,
  }
}

function CandidateCard({
  item,
  copied,
  onCopy,
}: {
  item: Candidate
  copied: boolean
  onCopy: (value: string) => void
}) {
  const [thumbFailed, setThumbFailed] = useState(false)
  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-sm transition hover:shadow-md">
      <a
        href={item.linkUrl || undefined}
        target={item.linkUrl ? '_blank' : undefined}
        rel="noreferrer"
        className="relative block aspect-[9/16] w-full overflow-hidden bg-muted"
      >
        {item.thumb && !thumbFailed ? (
          <img
            src={item.thumb}
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
            </svg>
          </div>
        )}
        {item.views > 0 ? (
          <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
            {formatCompactViews(item.views)} views
          </span>
        ) : null}
        <span className="absolute left-2 top-2 rounded-full bg-background/90 px-2 py-0.5 text-[10px] font-bold text-foreground">
          {item.source === 'gallery' ? 'แกลลี่' : 'โพสต์เพจ'}
        </span>
      </a>
      <div className="space-y-2 p-3">
        <p className="line-clamp-2 text-xs font-medium">{item.title}</p>
        <div className="rounded-lg border bg-muted/40 p-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">System Video ID</p>
          <div className="mt-1 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs font-bold">{item.refId}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 shrink-0 px-2 text-[10px]"
              onClick={() => onCopy(item.refId)}
            >
              {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
            </Button>
          </div>
        </div>
        {item.postedAt ? (
          <p className="text-[10px] text-muted-foreground">{formatThaiDateTime(item.postedAt)}</p>
        ) : null}
      </div>
    </article>
  )
}

export function CreateAdsPage() {
  const [view, setView] = useState<'gallery' | 'page-post'>('gallery')
  const [copiedRef, setCopiedRef] = useState('')

  const galleryQuery = useQuery({
    queryKey: ['create-ads', 'gallery'],
    queryFn: ({ signal }) => fetchGallery('ready', signal),
  })

  const postsQuery = useQuery({
    queryKey: ['create-ads', 'page-posts'],
    queryFn: ({ signal }) =>
      fetchPageVideos({ pageId: DEFAULT_PAGE_ID, minViews: 100000, limit: 48 }, signal),
  })

  const galleryCandidates = useMemo(
    () => (galleryQuery.data?.videos ?? []).map(galleryToCandidate).filter((c): c is Candidate => c !== null),
    [galleryQuery.data],
  )
  const postCandidates = useMemo(
    () => (postsQuery.data?.items ?? []).map(pagePostToCandidate).filter((c): c is Candidate => c !== null),
    [postsQuery.data],
  )

  const active = view === 'gallery' ? galleryCandidates : postCandidates
  const loading = view === 'gallery' ? galleryQuery.isLoading : postsQuery.isLoading
  const error = view === 'gallery' ? galleryQuery.error : postsQuery.error
  const refetching = galleryQuery.isFetching || postsQuery.isFetching

  function copy(value: string) {
    if (!value) return
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopiedRef(value)
        setTimeout(() => setCopiedRef((cur) => (cur === value ? '' : cur)), 1600)
      })
      .catch(() => undefined)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">สร้างแอด</h1>
        <p className="text-sm text-muted-foreground">
          เลือกคลิปจากแกลลี่ที่ยังไม่โพสต์ หรือโพสต์เพจที่มียอดวิวสูง แล้วคัดลอกรหัส System Video ID
          เพื่อนำไปสั่งสร้างแอด — ปลายทางเพจ {DEFAULT_PAGE_NAME}
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          <Button
            type="button"
            size="sm"
            variant={view === 'gallery' ? 'default' : 'ghost'}
            onClick={() => setView('gallery')}
          >
            แกลลี่พร้อมโพสต์ ({galleryCandidates.length})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={view === 'page-post' ? 'default' : 'ghost'}
            onClick={() => setView('page-post')}
          >
            โพสต์เพจยอดวิวสูง ({postCandidates.length})
          </Button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void galleryQuery.refetch()
            void postsQuery.refetch()
          }}
          disabled={refetching}
        >
          {refetching ? 'กำลังโหลด…' : 'รีเฟรช'}
        </Button>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          โหลดข้อมูลไม่สำเร็จ: {error instanceof Error ? error.message : 'unknown error'}
          <div className="mt-1 text-xs text-muted-foreground">
            หมายเหตุ: ต้องเข้าสู่ระบบแดชบอร์ดก่อนจึงจะดึงข้อมูลได้
          </div>
        </div>
      ) : null}

      {loading && active.length === 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="aspect-[9/16] animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : active.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {view === 'gallery'
            ? 'ยังไม่มีคลิปในแกลลี่ที่พร้อมโพสต์ — ลองโหลดเพิ่มจากหน้าแกลลี่'
            : 'ยังไม่มีโพสต์เพจที่มียอดวิวสูง — ลอง sync จากหน้าโพสต์เพจ'}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {active.map((item) => (
            <CandidateCard
              key={item.refId}
              item={item}
              copied={copiedRef === item.refId}
              onCopy={copy}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        คัดลอกรหัสจากบัตรแล้วใช้ในเครื่องมือสร้างแอด หรือกดสร้างแอดจากแท็บโพสต์เพจ/แกลลี่เพื่อเข้าคิวอัตโนมัติ
      </p>
    </div>
  )
}
