import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Film, Play, RefreshCw } from 'lucide-react'
import {
  fetchVideoMediaLibrary,
  uploadVideoToMediaLibrary,
  type VideoMediaLibraryItem,
} from '@/api/videoMediaLibrary'
import { WORKER_API_BASE } from '@/api/client'
import { formatThaiDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 gap-1 px-2 text-[11px]"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => {},
        )
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'คัดลอกแล้ว' : label}
    </Button>
  )
}

// Meta's Asset Library can already play a freshly uploaded advideo while the raw
// Graph status still says "processing". The dashboard should mirror the operator
// view: if Meta returned an advideo id and our source file is playable with no
// error, show it as a usable media-library asset instead of a processing row.
function isDisplayReadyItem(item: VideoMediaLibraryItem) {
  return Boolean(item.advideoId && item.fileUrl && !item.error)
}

function mediaThumbSrc(item: VideoMediaLibraryItem): string {
  return `${WORKER_API_BASE}/api/gallery/${encodeURIComponent(item.systemVideoId)}/asset/thumb?namespace_id=${encodeURIComponent(item.namespaceId)}`
}

function MediaThumb({ item }: { item: VideoMediaLibraryItem }) {
  const [failed, setFailed] = useState(false)
  const src = mediaThumbSrc(item)
  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
        <Film className="h-8 w-8" />
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={item.systemVideoId}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}

function MediaPreviewModal({ item, onClose }: { item: VideoMediaLibraryItem; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.systemVideoId}
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
          ×
        </button>
        <div className="flex items-center justify-center bg-black sm:w-1/2">
          <video
            src={item.fileUrl}
            poster={mediaThumbSrc(item)}
            controls
            playsInline
            autoPlay
            className="max-h-[50vh] w-full object-contain sm:max-h-[90vh]"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:w-1/2">
          <div>
            <h2 className="text-base font-semibold leading-snug">{item.systemVideoId}</h2>
            <p className="mt-1 text-xs text-muted-foreground">พร้อมแสดงผลใน Meta Asset Library</p>
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 font-medium text-foreground/70">Meta video id</span>
              <span className="break-all font-mono">{item.advideoId}</span>
              <CopyButton value={item.advideoId} label="คัดลอก" />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 font-medium text-foreground/70">Ad account</span>
              <span className="break-all">{item.adAccount || '—'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 font-medium text-foreground/70">สร้างเมื่อ</span>
              <span>{formatThaiDateTime(item.uploadedAt || item.updatedAt || item.createdAt) || '—'}</span>
            </div>
          </div>
          <div className="mt-auto flex flex-col gap-2 pt-2">
            <a
              href={item.fileUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-muted px-3 py-2 text-center text-sm font-semibold text-foreground transition hover:bg-accent"
            >
              เปิดวิดีโอในแท็บใหม่
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

function MediaCard({ item, onOpen }: { item: VideoMediaLibraryItem; onOpen: () => void }) {
  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-sm transition hover:shadow-md">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`ดูวิดีโอ ${item.systemVideoId}`}
        className="relative block aspect-[9/16] w-full overflow-hidden bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MediaThumb item={item} />
        <span className="absolute left-2 top-2 rounded bg-emerald-600/90 px-2 py-0.5 text-[11px] font-semibold text-white">
          พร้อมแสดงผล
        </span>
        <span className="absolute bottom-2 right-2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/65 text-white">
          <Play className="ml-0.5 h-4 w-4" fill="currentColor" />
        </span>
      </button>
      <div className="space-y-2 p-3">
        <p className="line-clamp-2 text-sm font-medium">{item.systemVideoId}</p>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate font-mono">{item.advideoId}</span>
          <span className="shrink-0">{formatThaiDateTime(item.uploadedAt || item.updatedAt || item.createdAt)}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1 text-xs">
          <span className="rounded bg-emerald-50 px-2 py-1 font-semibold text-emerald-700">Meta พร้อมใช้</span>
          <a
            href={item.fileUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded bg-muted px-2 py-1 font-semibold text-foreground hover:bg-accent"
          >
            เปิดวิดีโอ
          </a>
          <CopyButton value={item.advideoId} label="Meta id" />
        </div>
      </div>
    </article>
  )
}

export function MediaLibraryPage() {
  const qc = useQueryClient()
  const [systemVideoId, setSystemVideoId] = useState('')
  const [pageId, setPageId] = useState('')
  const [adAccount, setAdAccount] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<VideoMediaLibraryItem | null>(null)

  const query = useQuery({
    queryKey: ['video-media-library'],
    queryFn: ({ signal }) => fetchVideoMediaLibrary(signal, { limit: 200 }),
  })
  const items = query.data?.items ?? []
  const readyItems = useMemo(() => items.filter(isDisplayReadyItem), [items])
  const hiddenCount = Math.max(0, items.length - readyItems.length)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return readyItems
    return readyItems.filter((item) =>
      item.systemVideoId.toLowerCase().includes(q)
      || item.advideoId.toLowerCase().includes(q)
      || item.adAccount.toLowerCase().includes(q),
    )
  }, [readyItems, search])

  const uploadMutation = useMutation({
    mutationFn: () =>
      uploadVideoToMediaLibrary({
        systemVideoId,
        pageId: pageId || undefined,
        adAccount: adAccount || undefined,
      }),
    onSuccess: () => {
      setSystemVideoId('')
      void qc.invalidateQueries({ queryKey: ['video-media-library'] })
    },
  })
  const uploadResultItem = uploadMutation.data?.item ?? null

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">คลังสื่อ</h1>
        <p className="text-sm text-muted-foreground">
          วิดีโอที่เข้า Meta Asset Library แล้วและเปิดเล่นได้จริง พร้อมนำไปใช้สร้างแอด
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
          <Film className="h-4 w-4" />
          พร้อมแสดงผล {readyItems.length} วิดีโอ
          {hiddenCount ? <span className="font-normal text-muted-foreground">· ซ่อนรายการที่ยังใช้ไม่ได้ {hiddenCount}</span> : null}
        </div>
        <div className="flex items-center gap-2 sm:max-w-md sm:flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหา video id หรือ Meta video id"
          />
          <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={`mr-1 h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />
            รีเฟรช
          </Button>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
          <label className="space-y-1 text-sm">
            <span className="block font-medium text-foreground">System video id</span>
            <Input value={systemVideoId} onChange={(e) => setSystemVideoId(e.target.value)} placeholder="เช่น ea0de816" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block font-medium text-foreground">Page id (ไม่บังคับ)</span>
            <Input value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="ใช้ default_page" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block font-medium text-foreground">Ad account (ไม่บังคับ)</span>
            <Input value={adAccount} onChange={(e) => setAdAccount(e.target.value)} placeholder="ใช้ค่าของเพจ" />
          </label>
          <Button
            type="button"
            onClick={() => uploadMutation.mutate()}
            disabled={!systemVideoId.trim() || uploadMutation.isPending}
          >
            {uploadMutation.isPending ? 'กำลังเพิ่ม…' : 'Add Media'}
          </Button>
        </div>
        {uploadMutation.isError ? (
          <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
            {(uploadMutation.error as Error)?.message || 'เพิ่มวิดีโอไม่สำเร็จ'}
          </p>
        ) : null}
        {uploadMutation.isSuccess && uploadResultItem ? (
          <p className={`mt-2 rounded-lg border px-2.5 py-1.5 text-xs ${isDisplayReadyItem(uploadResultItem) ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
            {isDisplayReadyItem(uploadResultItem)
              ? `เพิ่มเข้าคลังแล้ว — Meta video id ${uploadResultItem.advideoId}`
              : 'ส่งเข้า Meta แล้ว รอรายการพร้อมแสดงผล'}
          </p>
        ) : null}
      </div>

      {query.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          โหลดคลังสื่อไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
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
          ยังไม่มีวิดีโอที่พร้อมแสดงผลในคลังสื่อ
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((item) => (
            <MediaCard
              key={`${item.adAccount}:${item.systemVideoId}:${item.advideoId}`}
              item={item}
              onOpen={() => setSelected(item)}
            />
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground">แสดง {filtered.length} วิดีโอพร้อมแสดงผล</div>
      {selected ? <MediaPreviewModal item={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
