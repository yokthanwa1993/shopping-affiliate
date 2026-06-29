import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles, Upload } from 'lucide-react'
import { fetchAiClips, uploadAiClip, type AiClip, type AiClipView } from '@/api/aiClips'
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

function AiDetailModal({ item, onClose }: { item: AiClip; onClose: () => void }) {
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
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            ปิด
          </Button>
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
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['ai-clips', view],
    queryFn: ({ signal }) => fetchAiClips(view, signal),
  })

  const upload = useMutation({
    mutationFn: (file: File) => uploadAiClip(file),
    onSuccess: async (result) => {
      setNotice({ kind: 'ok', text: `อัปโหลดคลิป AI สำเร็จ${result.video?.id ? ` (${result.video.id})` : ''}` })
      setView('unprocessed')
      await queryClient.invalidateQueries({ queryKey: ['ai-clips'] })
    },
    onError: (error) => {
      setNotice({ kind: 'error', text: `อัปโหลดไม่สำเร็จ: ${error instanceof Error ? error.message : 'unknown error'}` })
    },
  })

  const items = query.data ?? []

  function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = '' // allow re-selecting the same file
    if (!file) return
    setNotice(null)
    upload.mutate(file)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={onPickFile}
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6 text-violet-600" /> คลิป AI
          </h1>
          <p className="text-sm text-muted-foreground">AI Clips · คลังวิดีโอ AI ที่อัปโหลดเอง แยกจากคลิปจีน/LINE</p>
        </div>
        <Button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
          className="gap-2 bg-violet-600 text-white hover:bg-violet-700"
        >
          <Upload className="h-4 w-4" />
          {upload.isPending ? 'กำลังอัปโหลด…' : 'อัปโหลดคลิป AI'}
        </Button>
      </div>

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

      {selected ? <AiDetailModal item={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
