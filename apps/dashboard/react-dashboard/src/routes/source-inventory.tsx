import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchSourceInventory, type SourceItem, type SourceView } from '@/api/sourceInventory'
import { formatThaiDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { StudioSectionTabs } from '@/components/StudioSectionTabs'

const VIEWS: Array<{ key: SourceView; label: string }> = [
  { key: 'unprocessed', label: 'ยังไม่ประมวลผล' },
  { key: 'processed', label: 'ประมวลผลแล้ว' },
]

// Mirrors apps/video-affiliate/webapp/.../Thumb.tsx:inferThumbnailUrl — derive a
// poster image from a video URL when no explicit thumbnail is supplied.
function inferThumbnailUrl(url: string, fallback: string): string {
  const direct = url.trim()
  if (direct) return direct
  const source = fallback.trim()
  if (!source) return ''
  if (/\/asset\/original(?:\?|$)/i.test(source)) {
    return source.replace(/\/asset\/original(?=\?|$)/i, '/asset/original-thumb')
  }
  if (/_original\.mp4(?:[?#].*)?$/i.test(source)) {
    return source.replace(/_original\.mp4/i, '_original_thumb.webp')
  }
  return source.replace(/\.mp4(?:[?#].*)?$/i, '_thumb.webp')
}

function sourceBadge(sourceType: string): { label: string; cls: string } {
  if (sourceType === 'xhs_url') return { label: 'XHS', cls: 'bg-rose-500/95 text-white' }
  if (sourceType === 'line_video') return { label: 'LINE', cls: 'bg-emerald-500/95 text-white' }
  return { label: 'ต้นฉบับ', cls: 'bg-slate-900/85 text-white' }
}

function resolvePlayback(item: SourceItem): string {
  return (item.originalUrl || item.videoUrl || item.previewUrl || '').trim()
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

// Thumbnail with a primary → secondary → placeholder fallback chain, mirroring
// the mobile Thumb component's onError progression.
function CardThumb({ item }: { item: SourceItem }) {
  const playback = resolvePlayback(item)
  const primarySrc = inferThumbnailUrl(item.thumbnailUrl, playback)
  const secondary = item.fallbackThumbnailUrl.trim()
  const [attempt, setAttempt] = useState<0 | 1 | 2>(0)
  const badge = sourceBadge(item.sourceType)
  const src = attempt === 0 ? primarySrc : attempt === 1 ? secondary : ''

  if (!src) {
    return (
      <div
        className={`flex h-full w-full flex-col items-center justify-center ${
          item.sourceType === 'xhs_url'
            ? 'bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300'
            : 'bg-gradient-to-br from-slate-700 to-slate-900'
        }`}
      >
        <div className="rounded-full bg-white/20 px-3 py-2 text-[10px] font-extrabold uppercase tracking-[0.22em] text-white">
          {badge.label}
        </div>
        <p className="mt-3 line-clamp-3 px-4 text-center text-xs font-semibold text-white/90">
          {item.sourceLabel || (item.sourceType === 'xhs_url' ? 'Xiaohongshu link' : 'คลิปต้นฉบับ')}
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
      onError={() => {
        if (attempt === 0 && secondary && secondary !== primarySrc) {
          setAttempt(1)
          return
        }
        setAttempt(2)
      }}
    />
  )
}

function LinkBadge({ on, label }: { on: boolean; label: string }) {
  const color = label === 'S' ? 'bg-emerald-500/95' : 'bg-sky-500/95'
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold text-white shadow-lg backdrop-blur-sm ${
        on ? color : 'bg-black/55'
      }`}
    >
      {label}
    </span>
  )
}

function SourceCard({ item, onOpen }: { item: SourceItem; onOpen: () => void }) {
  const badge = sourceBadge(item.sourceType)
  const dateLabel = compactThaiDate(item.processedAt || item.createdAt || item.updatedAt)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-muted text-left shadow-sm transition-transform duration-200 active:scale-95"
    >
      <CardThumb item={item} />

      <div className="absolute left-2 top-2 flex flex-col items-start gap-1.5">
        <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold shadow-lg backdrop-blur-sm ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      <div className="absolute right-2 top-2 flex items-center gap-1">
        <LinkBadge on={item.hasShopeeLink} label="S" />
        <LinkBadge on={item.hasLazadaLink} label="L" />
      </div>

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pb-3 pt-8 text-white">
        <p className="truncate text-[11px] font-extrabold">{item.id || item.title}</p>
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

function SourceDetailModal({ item, onClose }: { item: SourceItem; onClose: () => void }) {
  const badge = sourceBadge(item.sourceType)
  const playback = resolvePlayback(item)
  const poster = inferThumbnailUrl(item.thumbnailUrl, playback)
  const ready = item.readyToProcess || item.status === 'ready' || (item.hasShopeeLink && item.hasLazadaLink)
  const missing = [item.hasShopeeLink ? null : 'Shopee', item.hasLazadaLink ? null : 'Lazada']
    .filter(Boolean)
    .join(' / ')

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
            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${badge.cls}`}>
              {badge.label}
            </span>
            <p className="truncate text-sm font-semibold">{item.id || item.title}</p>
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
                poster={poster || undefined}
              />
            ) : (
              <div
                className={`flex h-full w-full flex-col items-center justify-center ${
                  item.sourceType === 'xhs_url'
                    ? 'bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300'
                    : 'bg-gradient-to-br from-slate-700 to-slate-900'
                }`}
              >
                <div className="rounded-full bg-white/20 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.22em] text-white">
                  {badge.label}
                </div>
                <p className="mt-3 line-clamp-4 break-all px-6 text-center text-sm font-semibold text-white/90">
                  {item.sourceLabel || 'ไม่มีพรีวิววิดีโอ'}
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${item.hasShopeeLink ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'}`}>
              Shopee
            </span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${item.hasLazadaLink ? 'bg-sky-500 text-white' : 'bg-muted text-muted-foreground'}`}>
              Lazada
            </span>
          </div>

          <div className={`rounded-xl px-3 py-3 text-sm ${ready ? 'bg-primary/10 text-foreground' : 'bg-amber-500/10 text-amber-900 dark:text-amber-200'}`}>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-60">คลังต้นฉบับ</p>
            <p className="mt-1 font-semibold">
              {ready
                ? 'คลิปต้นฉบับถูกเก็บในระบบแล้ว และพร้อมส่งเข้า Processing'
                : `คลิปต้นฉบับถูกเก็บในระบบแล้ว เหลือลิงก์ ${missing || 'Shopee / Lazada'}`}
            </p>
          </div>

          {item.sourceLabel ? <DetailRow label="Source" value={item.sourceLabel} /> : null}
          {item.id ? <DetailRow label="Video ID" value={item.id} /> : null}
          {item.namespaceId ? <DetailRow label="Namespace" value={item.namespaceId} /> : null}
          {item.ownerEmail ? <DetailRow label="Owner" value={item.ownerEmail} /> : null}
          {item.createdAt ? <DetailRow label="เพิ่มเมื่อ" value={formatThaiDateTime(item.createdAt)} /> : null}
          {item.processedAt ? <DetailRow label="ประมวลผลเมื่อ" value={formatThaiDateTime(item.processedAt)} /> : null}

          {item.shopeeLink || item.lazadaLink ? (
            <div className="space-y-2">
              {item.shopeeLink ? (
                <a
                  href={item.shopeeLink}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-xl bg-emerald-500/10 px-3 py-2.5 text-sm font-semibold text-emerald-700 hover:underline dark:text-emerald-300"
                >
                  เปิดลิงก์ Shopee ↗
                </a>
              ) : null}
              {item.lazadaLink ? (
                <a
                  href={item.lazadaLink}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-xl bg-sky-500/10 px-3 py-2.5 text-sm font-semibold text-sky-700 hover:underline dark:text-sky-300"
                >
                  เปิดลิงก์ Lazada ↗
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function SourceInventoryPage() {
  const [view, setView] = useState<SourceView>('unprocessed')
  const [selected, setSelected] = useState<SourceItem | null>(null)
  const query = useQuery({
    queryKey: ['source-inventory', view],
    queryFn: ({ signal }) => fetchSourceInventory(view, signal),
  })

  const items = query.data ?? []

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">คลังต้นฉบับ</h1>
        <p className="text-sm text-muted-foreground">คลังวิดีโอต้นฉบับ พร้อมส่งเข้า Processing</p>
      </div>

      <StudioSectionTabs />

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
          โหลดคลังต้นฉบับไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="aspect-[9/16] animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {view === 'unprocessed' ? 'ไม่มีคลิปที่รอประมวลผล' : 'ยังไม่มีคลิปที่ประมวลผลแล้ว'}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {items.map((item, i) => (
            <SourceCard key={item.id || `${item.title}-${i}`} item={item} onOpen={() => setSelected(item)} />
          ))}
        </div>
      )}

      {selected ? <SourceDetailModal item={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
