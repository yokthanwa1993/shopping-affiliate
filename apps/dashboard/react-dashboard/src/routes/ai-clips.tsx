import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  ShoppingBag,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  deleteAiClip,
  fetchAiClips,
  uploadAiClip,
  type AiClip,
  type AiClipUploadInput,
} from '@/api/aiClips'
import { formatThaiDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'

// Unified "Media" library — every clip the operator uploaded/sent into the system
// (AI/manual uploads only, NOT the legacy Chinese/LINE gallery). One flat grid, newest
// first, with a per-card status badge instead of splitting the library across
// processed/unprocessed tabs. The empty state is expected: the library starts empty and
// the operator fills it via the header upload button.

const ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v'

// Per-clip status badge. The worker currently only distinguishes processed vs
// unprocessed (presence of processedAt), but we map the broader processing/failed
// vocabulary too so the badge stays correct if the backend reports richer states later.
type ClipStatusTone = 'processed' | 'processing' | 'failed' | 'waiting'

function clipStatusMeta(status: string): { tone: ClipStatusTone; label: string } {
  const s = String(status || '').trim().toLowerCase()
  if (['processed', 'done', 'complete', 'completed', 'ready', 'success'].includes(s)) {
    return { tone: 'processed', label: 'ประมวลผลแล้ว' }
  }
  if (['processing', 'running', 'in_progress', 'in-progress', 'working', 'pending'].includes(s)) {
    return { tone: 'processing', label: 'กำลังประมวลผล' }
  }
  if (['failed', 'error', 'failure', 'errored'].includes(s)) {
    return { tone: 'failed', label: 'ล้มเหลว' }
  }
  return { tone: 'waiting', label: 'รอประมวลผล' }
}

const STATUS_OVERLAY: Record<ClipStatusTone, string> = {
  processed: 'bg-emerald-600/95 text-white',
  processing: 'bg-amber-500/95 text-white',
  failed: 'bg-red-600/95 text-white',
  waiting: 'bg-slate-800/85 text-white',
}

const STATUS_SOLID: Record<ClipStatusTone, string> = {
  processed: 'bg-emerald-100 text-emerald-700',
  processing: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
  waiting: 'bg-slate-200 text-slate-700',
}

const STATUS_ICON: Record<ClipStatusTone, typeof CheckCircle2> = {
  processed: CheckCircle2,
  processing: Loader2,
  failed: AlertTriangle,
  waiting: Clock,
}

function StatusBadge({
  status,
  variant = 'overlay',
  className = '',
  showLabel = false,
}: {
  status: string
  variant?: 'overlay' | 'solid'
  className?: string
  showLabel?: boolean
}) {
  const meta = clipStatusMeta(status)
  const Icon = STATUS_ICON[meta.tone]
  const palette = variant === 'overlay' ? STATUS_OVERLAY[meta.tone] : STATUS_SOLID[meta.tone]
  const shadow = variant === 'overlay' ? ' shadow-lg backdrop-blur-sm' : ''
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full ${showLabel ? 'gap-1 px-2 py-1 text-[10px]' : 'h-8 w-8 p-0'} font-bold${shadow} ${palette} ${className}`}
      aria-label={meta.label}
      title={meta.label}
    >
      <Icon className={`${showLabel ? 'h-3 w-3' : 'h-4 w-4'}${meta.tone === 'processing' ? ' animate-spin' : ''}`} />
      {showLabel ? meta.label : <span className="sr-only">{meta.label}</span>}
    </span>
  )
}

// Newest-first ordering key: prefer processedAt, fall back to createdAt. Tolerates the
// worker's space-separated, TZ-less timestamps (mirrors compactThaiDate's parsing).
function clipTimestamp(item: AiClip): number {
  const raw = String(item.processedAt || item.createdAt || '').trim()
  if (!raw) return 0
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)
  const parseable = hasTz ? raw : raw.replace(' ', 'T') + 'Z'
  const t = new Date(parseable).getTime()
  return Number.isNaN(t) ? 0 : t
}

type PlaybackChoice = 'original' | 'processed'

function cleanUrl(value: string): string {
  return String(value || '').trim()
}

function originalPlaybackUrl(item: AiClip): string {
  return cleanUrl(item.originalUrl)
}

function processedPlaybackUrl(item: AiClip): string {
  const original = originalPlaybackUrl(item)
  const processed = cleanUrl(item.videoUrl || item.previewUrl)
  if (!processed || processed === original) return ''
  const meta = clipStatusMeta(item.status)
  if (meta.tone !== 'processed' && !item.processedAt) return ''
  return processed
}

function sourceAvailabilityLabel(item: AiClip): string {
  const hasOriginal = Boolean(originalPlaybackUrl(item))
  const hasProcessed = Boolean(processedPlaybackUrl(item))
  if (hasOriginal && hasProcessed) return 'มีต้นฉบับและผลลัพธ์ให้ดู'
  if (hasOriginal) return 'มีต้นฉบับให้ดู'
  if (hasProcessed) return 'มีผลลัพธ์ให้ดู'
  return 'ยังไม่มีวิดีโอให้ดู'
}

// Optional links: empty is fine, but a non-empty value must look like an http(s) URL. The
// worker re-validates this server-side; this is just early, friendly feedback.
function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  return /^https?:\/\/\S+$/i.test(trimmed)
}

// Upload workspace dialog: video file (required) + optional Shopee/Lazada links
// paired with THIS specific clip. The clip title is system-generated from the AI clip id.
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
      shopeeLink: shopeeLink.trim(),
      lazadaLink: lazadaLink.trim(),
    })
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-4 sm:py-6"
      onClick={() => !isUploading && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <form
        className="my-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-card shadow-xl sm:max-h-[calc(100dvh-3rem)]"
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

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
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

          <p className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-medium text-violet-800">
            ระบบจะสร้างชื่อ/id คลิปให้อัตโนมัติหลังอัปโหลด
          </p>

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
  , document.body)
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

function CardThumb({ item, eager = false }: { item: AiClip; eager?: boolean }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const src = item.thumbnailUrl.trim()
  const fallback = (
    <div className="absolute inset-0 flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-slate-200 via-slate-100 to-slate-300">
      <div className="rounded-full bg-violet-600/85 px-3 py-2 text-[10px] font-extrabold uppercase tracking-[0.22em] text-white shadow-sm">
        AI
      </div>
      <p className="mt-3 line-clamp-3 px-4 text-center text-xs font-semibold text-slate-600">
        {item.title || item.sourceLabel || 'คลิป AI'}
      </p>
    </div>
  )
  if (!src || failed) return <div className="relative h-full w-full">{fallback}</div>
  return (
    <div className="relative h-full w-full overflow-hidden">
      {!loaded ? fallback : null}
      <img
        src={src}
        className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={eager ? 'high' : 'auto'}
        alt=""
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

function AiCard({ item, onOpen, index = 0 }: { item: AiClip; onOpen: () => void; index?: number }) {
  const dateLabel = compactThaiDate(item.processedAt || item.createdAt)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-muted text-left shadow-sm transition-transform duration-200 active:scale-95"
    >
      <CardThumb item={item} eager={index < 8} />
      <div className="absolute left-2 top-2 flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-violet-600/95 px-2 py-1 text-[10px] font-bold text-white shadow-lg backdrop-blur-sm">
          <Sparkles className="h-3 w-3" /> AI
        </span>
      </div>
      <div className="absolute right-2 top-2 flex items-center">
        <StatusBadge status={item.status} />
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
  const originalPlayback = originalPlaybackUrl(item)
  const processedPlayback = processedPlaybackUrl(item)
  const hasOriginal = Boolean(originalPlayback)
  const hasProcessed = Boolean(processedPlayback)
  const defaultPlayback: PlaybackChoice = hasProcessed ? 'processed' : 'original'
  const [playbackChoice, setPlaybackChoice] = useState<PlaybackChoice>(defaultPlayback)
  const chosenPlayback = playbackChoice === 'processed' ? processedPlayback : originalPlayback
  const playback = chosenPlayback || processedPlayback || originalPlayback
  const statusTone = clipStatusMeta(item.status).tone

  useEffect(() => {
    setPlaybackChoice(hasProcessed ? 'processed' : 'original')
  }, [item.id, hasProcessed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-4 sm:py-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="my-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-card shadow-xl sm:max-h-[calc(100dvh-3rem)]"
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

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
          <div className="space-y-3">
            <div className="mx-auto w-full max-w-[220px] overflow-hidden rounded-2xl border bg-muted sm:max-w-[240px]" style={{ aspectRatio: '9 / 16', maxHeight: 'min(46dvh, 420px)' }}>
              {playback ? (
                <video
                  key={`${item.id || item.title}-${playbackChoice}-${playback}`}
                  src={playback}
                  className="block h-full w-full object-cover"
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

            <div className="rounded-xl border bg-background p-2">
              <p className="mb-2 px-1 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">เลือกวิดีโอที่ต้องการดู</p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={playbackChoice === 'original' ? 'default' : 'outline'}
                  onClick={() => setPlaybackChoice('original')}
                  disabled={!hasOriginal}
                >
                  ต้นฉบับ
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={playbackChoice === 'processed' ? 'default' : 'outline'}
                  onClick={() => setPlaybackChoice('processed')}
                  disabled={!hasProcessed}
                >
                  ประมวลผลแล้ว
                </Button>
              </div>
              <p className="mt-2 px-1 text-xs text-muted-foreground">{sourceAvailabilityLabel(item)}</p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl bg-muted px-3 py-3 text-sm text-foreground">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-60">สถานะ</p>
              <p className="mt-1 font-semibold">
                {statusTone === 'processed'
                  ? 'คลิปนี้ประมวลผลแล้ว'
                  : statusTone === 'processing'
                    ? 'คลิปนี้กำลังประมวลผล'
                    : statusTone === 'failed'
                      ? 'คลิปนี้ประมวลผลไม่สำเร็จ'
                      : 'คลิปนี้อยู่ในคลัง รอประมวลผล'}
              </p>
            </div>
            <StatusBadge status={item.status} variant="solid" className="shrink-0" showLabel />
          </div>

          {item.error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em]">Error</p>
              <p className="mt-1 break-words font-medium">{item.error}</p>
            </div>
          ) : null}

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
  , document.body)
}

export function AiClipsPage() {
  const [selected, setSelected] = useState<AiClip | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const queryClient = useQueryClient()

  // Load processed and unprocessed as independent queries so a slow/empty unprocessed
  // request does not block the visible Media grid. Processed clips usually make up most
  // of the page, so render them as soon as they return and merge the live statuses later.
  const processedQuery = useQuery({
    queryKey: ['ai-clips', 'processed'],
    queryFn: ({ signal }) => fetchAiClips('processed', signal),
  })
  const unprocessedQuery = useQuery({
    queryKey: ['ai-clips', 'unprocessed'],
    queryFn: ({ signal }) => fetchAiClips('unprocessed', signal),
  })

  const upload = useMutation({
    mutationFn: (input: AiClipUploadInput) => uploadAiClip(input),
    onSuccess: async (result) => {
      setUploadOpen(false)
      setNotice({ kind: 'ok', text: `อัปโหลดคลิป AI สำเร็จ${result.video?.id ? ` (${result.video.id})` : ''}` })
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

  const items = useMemo(() => {
    const byId = new Map<string, AiClip>()
    for (const clip of [...(processedQuery.data ?? []), ...(unprocessedQuery.data ?? [])]) {
      const key = clip.id || `${clip.title}|${clip.createdAt}`
      if (!byId.has(key)) byId.set(key, clip)
    }
    return Array.from(byId.values()).sort((a, b) => clipTimestamp(b) - clipTimestamp(a))
  }, [processedQuery.data, unprocessedQuery.data])
  const isInitialLoading = processedQuery.isLoading && unprocessedQuery.isLoading
  const isFetching = processedQuery.isFetching || unprocessedQuery.isFetching
  const loadError = processedQuery.error || unprocessedQuery.error

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6 text-violet-600" /> Media
          </h1>
          <p className="text-sm text-muted-foreground">คลังสื่อ · คลิปที่อัปโหลด/ส่งเข้าระบบ พร้อมสถานะการประมวลผล</p>
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
        <p className="text-sm font-medium text-muted-foreground">
          {isInitialLoading ? 'กำลังโหลด…' : `ทั้งหมด ${items.length} คลิป`}
        </p>
        <Button type="button" variant="outline" onClick={() => { void processedQuery.refetch(); void unprocessedQuery.refetch() }} disabled={isFetching}>
          {isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
        </Button>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          โหลดคลัง AI ไม่สำเร็จ: {loadError instanceof Error ? loadError.message : 'unknown error'}
        </div>
      ) : null}

      {isInitialLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="aspect-[9/16] animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-violet-400" />
          <p className="mt-3 text-sm font-semibold text-foreground">ยังไม่มีคลิปในคลังสื่อนี้</p>
          <p className="mt-1 text-sm text-muted-foreground">
            กดปุ่ม “อัปโหลดคลิป AI” ด้านบนเพื่อเพิ่มวิดีโอ (MP4 / MOV / WEBM)
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
          {items.map((item, i) => (
            <AiCard key={item.id || i} item={item} index={i} onOpen={() => setSelected(item)} />
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
