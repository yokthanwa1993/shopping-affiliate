import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, ShoppingBag, Sparkles, Trash2, Upload, X } from 'lucide-react'
import {
  deleteAiClip,
  fetchAiClips,
  uploadAiClip,
  type AiClip,
  type AiClipUploadInput,
  type AiClipView,
} from '@/api/aiClips'
import { formatThaiDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'

// Dedicated AI Clips workspace — operator-uploaded AI videos, 100% separate from the
// Chinese/LINE source inventory. Empty state is expected and clear: the library starts
// empty and the operator fills it via the header upload button. Unprocessed/processed
// tabs mirror the old source-inventory lifecycle.

const VIEWS: Array<{ key: AiClipView; label: string }> = [
  { key: 'unprocessed', label: 'ยังไม่ประมวลผล' },
  { key: 'processed', label: 'ประมวลผลแล้ว' },
]

const ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v'

// Optional links: empty is fine, but a non-empty value must look like an http(s) URL. The
// worker re-validates this server-side; this is just early, friendly feedback.
function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  return /^https?:\/\/\S+$/i.test(trimmed)
}

// Upload workspace dialog: video file (required) + optional title, Shopee link and Lazada
// link paired with THIS specific clip. Replaces the old bare hidden file input so links can
// be captured alongside the upload.
function UploadDialog({
  isUploading,
  onClose,
  onSubmit,
}: {
  isUploading: boolean
  onClose: () => void
  onSubmit: (input: AiClipUploadInput) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [shopeeLink, setShopeeLink] = useState('')
  const [lazadaLink, setLazadaLink] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isUploading) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, isUploading])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!file) {
      setError('กรุณาเลือกไฟล์วิดีโอ')
      return
    }
    if (!looksLikeUrl(shopeeLink)) {
      setError('ลิงก์ Shopee ต้องขึ้นต้นด้วย http:// หรือ https://')
      return
    }
    if (!looksLikeUrl(lazadaLink)) {
      setError('ลิงก์ Lazada ต้องขึ้นต้นด้วย http:// หรือ https://')
      return
    }
    setError('')
    onSubmit({
      file,
      title: title.trim(),
      shopeeLink: shopeeLink.trim(),
      lazadaLink: lazadaLink.trim(),
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => !isUploading && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <form
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2.5 py-1 text-[11px] font-bold text-white">
              <Sparkles className="h-3 w-3" /> AI
            </span>
            <p className="text-sm font-semibold">อัปโหลดคลิป AI</p>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={isUploading}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4">
          <div className="space-y-1.5">
            <label className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              ไฟล์วิดีโอ (MP4 / MOV / WEBM)
            </label>
            <input
              type="file"
              accept={ACCEPT}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setError('')
              }}
              className="block w-full rounded-xl border bg-background px-3 py-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-violet-600 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
            />
            {file ? (
              <p className="truncate text-xs text-muted-foreground">
                {file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              ชื่อคลิป (ไม่บังคับ)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="เช่น รีวิวสินค้า AI"
              className="block w-full rounded-xl border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              <ShoppingBag className="h-3.5 w-3.5 text-[#ee4d2d]" /> ลิงก์ Shopee (ไม่บังคับ)
            </label>
            <input
              type="url"
              inputMode="url"
              value={shopeeLink}
              onChange={(e) => setShopeeLink(e.target.value)}
              placeholder="https://shopee.co.th/..."
              className="block w-full rounded-xl border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              <ShoppingBag className="h-3.5 w-3.5 text-[#0f146d]" /> ลิงก์ Lazada (ไม่บังคับ)
            </label>
            <input
              type="url"
              inputMode="url"
              value={lazadaLink}
              onChange={(e) => setLazadaLink(e.target.value)}
              placeholder="https://www.lazada.co.th/..."
              className="block w-full rounded-xl border bg-background px-3 py-2 text-sm"
            />
          </div>

          {error ? (
            <p className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isUploading}>
            ยกเลิก
          </Button>
          <Button
            type="submit"
            disabled={isUploading || !file}
            className="gap-2 bg-violet-600 text-white hover:bg-violet-700"
          >
            <Upload className="h-4 w-4" />
            {isUploading ? 'กำลังอัปโหลด…' : 'อัปโหลด'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function ProductLinkRow({ label, href, accent }: { label: string; href: string; accent: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 transition-colors hover:bg-muted"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ShoppingBag className="h-4 w-4 shrink-0" style={{ color: accent }} />
        <span className="flex min-w-0 flex-col">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
          <span className="truncate text-sm font-semibold text-foreground">{href}</span>
        </span>
      </span>
      <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
    </a>
  )
}

function compactThaiDate(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed)
  const parseable = hasTz ? trimmed : trimmed.replace(' ', 'T') + 'Z'
  const d = new Date(parseable)
  if (Number.isNaN(d.getTime())) return trimmed
  return d.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function CardThumb({ item }: { item: AiClip }) {
  const [failed, setFailed] = useState(false)
  const src = item.thumbnailUrl.trim()
  if (!src || failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-violet-600 via-fuchsia-500 to-indigo-500">
        <div className="rounded-full bg-white/20 px-3 py-2 text-[10px] font-extrabold uppercase tracking-[0.22em] text-white">
          AI
        </div>
        <p className="mt-3 line-clamp-3 px-4 text-center text-xs font-semibold text-white/90">
          {item.title || item.sourceLabel || 'คลิป AI'}
        </p>
      </div>
    )
  }
  return (
    <img
      src={src}
      className="h-full w-full object-cover"
      loading="lazy"
      decoding="async"
      alt=""
      onError={() => setFailed(true)}
    />
  )
}

function AiCard({ item, onOpen }: { item: AiClip; onOpen: () => void }) {
  const dateLabel = compactThaiDate(item.processedAt || item.createdAt)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-muted text-left shadow-sm transition-transform duration-200 active:scale-95"
    >
      <CardThumb item={item} />
      <div className="absolute left-2 top-2 flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-violet-600/95 px-2 py-1 text-[10px] font-bold text-white shadow-lg backdrop-blur-sm">
          <Sparkles className="h-3 w-3" /> AI
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pb-3 pt-8 text-white">
        <p className="truncate text-[11px] font-extrabold">{item.title || item.id}</p>
        {dateLabel ? <p className="mt-0.5 truncate text-[10px] text-white/75">{dateLabel}</p> : null}
      </div>
    </button>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted px-3 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 break-all text-sm font-semibold text-foreground">{value}</p>
    </div>
  )
}

function AiDetailModal({
  item,
  onClose,
  onDelete,
  isDeleting,
}: {
  item: AiClip
  onClose: () => void
  onDelete: () => void
  isDeleting: boolean
}) {
  const playback = (item.originalUrl || item.previewUrl || '').trim()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-600 px-2.5 py-1 text-[11px] font-bold text-white">
              <Sparkles className="h-3 w-3" /> AI
            </span>
            <p className="truncate text-sm font-semibold">{item.title || item.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="destructive" onClick={onDelete} disabled={isDeleting}>
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              {isDeleting ? 'กำลังลบ…' : 'ลบวีดีโอ'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              ปิด
            </Button>
          </div>
        </div>

        <div className="space-y-4 overflow-y-auto p-4">
          <div className="mx-auto w-full max-w-[280px] overflow-hidden rounded-2xl border bg-black" style={{ aspectRatio: '9 / 16' }}>
            {playback ? (
              <video
                src={playback}
                className="block h-full w-full bg-black object-contain"
                controls
                autoPlay
                playsInline
                preload="metadata"
                poster={item.thumbnailUrl || undefined}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-violet-600 via-fuchsia-500 to-indigo-500">
                <p className="px-6 text-center text-sm font-semibold text-white/90">ไม่มีพรีวิววิดีโอ</p>
              </div>
            )}
          </div>

          <div className="rounded-xl bg-primary/10 px-3 py-3 text-sm text-foreground">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-60">คลัง AI</p>
            <p className="mt-1 font-semibold">
              {item.status === 'processed'
                ? 'คลิป AI นี้ประมวลผลแล้ว'
                : 'คลิป AI นี้อยู่ในคลัง รอประมวลผล'}
            </p>
          </div>

          {item.shopeeLink || item.lazadaLink ? (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">ลิงก์สินค้า</p>
              {item.shopeeLink ? <ProductLinkRow label="Shopee" href={item.shopeeLink} accent="#ee4d2d" /> : null}
              {item.lazadaLink ? <ProductLinkRow label="Lazada" href={item.lazadaLink} accent="#0f146d" /> : null}
            </div>
          ) : null}

          {item.id ? <DetailRow label="Video ID" value={item.id} /> : null}
          {item.createdAt ? <DetailRow label="อัปโหลดเมื่อ" value={formatThaiDateTime(item.createdAt)} /> : null}
          {item.processedAt ? <DetailRow label="ประมวลผลเมื่อ" value={formatThaiDateTime(item.processedAt)} /> : null}
        </div>
      </div>
    </div>
  )
}

export function AiClipsPage() {
  const [view, setView] = useState<AiClipView>('unprocessed')
  const [selected, setSelected] = useState<AiClip | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['ai-clips', view],
    queryFn: ({ signal }) => fetchAiClips(view, signal),
  })

  const upload = useMutation({
    mutationFn: (input: AiClipUploadInput) => uploadAiClip(input),
    onSuccess: async (result) => {
      setUploadOpen(false)
      setNotice({ kind: 'ok', text: `อัปโหลดคลิป AI สำเร็จ${result.video?.id ? ` (${result.video.id})` : ''}` })
      setView('unprocessed')
      await queryClient.invalidateQueries({ queryKey: ['ai-clips'] })
    },
    onError: (error) => {
      setNotice({ kind: 'error', text: `อัปโหลดไม่สำเร็จ: ${error instanceof Error ? error.message : 'unknown error'}` })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteAiClip(id),
    onSuccess: async (result) => {
      setSelected(null)
      setNotice({ kind: 'ok', text: `ลบคลิป AI สำเร็จ${result.id ? ` (${result.id})` : ''}` })
      await queryClient.invalidateQueries({ queryKey: ['ai-clips'] })
    },
    onError: (error) => {
      setNotice({ kind: 'error', text: `ลบไม่สำเร็จ: ${error instanceof Error ? error.message : 'unknown error'}` })
    },
  })

  const items = query.data ?? []

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6 text-violet-600" /> คลังต้นฉบับ
          </h1>
          <p className="text-sm text-muted-foreground">Source Inventory · คลังวิดีโอ AI ที่อัปโหลดเอง แยกจากคลิปจีน/LINE</p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setNotice(null)
            setUploadOpen(true)
          }}
          disabled={upload.isPending}
          className="gap-2 bg-violet-600 text-white hover:bg-violet-700"
        >
          <Upload className="h-4 w-4" />
          {upload.isPending ? 'กำลังอัปโหลด…' : 'อัปโหลดคลิป AI'}
        </Button>
      </div>

      {uploadOpen ? (
        <UploadDialog
          isUploading={upload.isPending}
          onClose={() => setUploadOpen(false)}
          onSubmit={(input) => {
            setNotice(null)
            upload.mutate(input)
          }}
        />
      ) : null}

      {notice ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            notice.kind === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
              : 'border-destructive/40 bg-destructive/5 text-destructive'
          }`}
        >
          {notice.text}
        </div>
      ) : null}

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
        <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
        </Button>
      </div>

      {query.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          โหลดคลัง AI ไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="aspect-[9/16] animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-violet-400" />
          <p className="mt-3 text-sm font-semibold text-foreground">
            {view === 'unprocessed' ? 'ยังไม่มีคลิป AI ในเนมสเปซนี้' : 'ยังไม่มีคลิป AI ที่ประมวลผลแล้ว'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            กดปุ่ม “อัปโหลดคลิป AI” ด้านบนเพื่อเพิ่มวิดีโอ (MP4 / MOV / WEBM)
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((item, i) => (
            <AiCard key={item.id || i} item={item} onOpen={() => setSelected(item)} />
          ))}
        </div>
      )}

      {selected ? (
        <AiDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          isDeleting={remove.isPending}
          onDelete={() => {
            if (!selected.id) return
            const ok = window.confirm(`ลบวีดีโอ AI นี้หรือไม่?\n${selected.title || selected.id}`)
            if (ok) remove.mutate(selected.id)
          }}
        />
      ) : null}
    </div>
  )
}
