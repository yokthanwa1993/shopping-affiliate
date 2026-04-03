import { useEffect, useState } from 'react'
import { Thumb } from './Thumb'
import { useViewerHistory } from '../hooks/useViewerHistory'
import {
  InboxOwnershipIcon,
  isInboxVideoOwnedByCurrentNamespace,
  parseImportedNamespaceIdFromSourceLabel,
} from '../inboxUtils'
import type { InboxVideo } from '../sharedTypes'

const VERTICAL_VIEWER_FRAME_STYLE = {
  width: '100%',
  maxWidth: 'calc((56svh * 9) / 16)',
  aspectRatio: '9 / 16',
} as const

export function InboxCard({
  video,
  onStart,
  onDelete,
  starting,
  deleting,
  onExpandedChange,
  viewMode,
  currentNamespaceId,
  resolvePlaybackUrl,
  resolveThumbnailUrl,
}: {
  video: InboxVideo
  onStart: (id: string, namespaceId?: string) => void
  onDelete: (id: string, namespaceId?: string) => void
  starting: boolean
  deleting: boolean
  onExpandedChange?: (expanded: boolean) => void
  viewMode?: 'default' | 'processed'
  currentNamespaceId?: string
  resolvePlaybackUrl: (video: InboxVideo) => string
  resolveThumbnailUrl: (video: InboxVideo) => string
}) {
  const [expanded, setExpanded] = useState(false)
  const canDelete = video.canDelete !== false
  const canStartProcessing = video.canStartProcessing !== false
  const ready = video.readyToProcess === true || video.status === 'ready' || (video.hasShopeeLink === true && video.hasLazadaLink === true)
  const missingLinks = [
    video.hasShopeeLink ? null : 'Shopee',
    video.hasLazadaLink ? null : 'Lazada',
  ].filter(Boolean).join(' / ')
  const sourceLabel = String(video.sourceLabel || (video.sourceType === 'xhs_url' ? 'Xiaohongshu link' : 'Telegram video')).trim()
  const isProcessedView = viewMode === 'processed'
  const sourceBadge = video.sourceType === 'xhs_url'
    ? { label: 'XHS', cls: 'bg-rose-500/95 text-white' }
    : video.sourceType === 'line_video'
      ? { label: 'LINE', cls: 'bg-emerald-500/95 text-white' }
      : { label: 'ต้นฉบับ', cls: 'bg-slate-900/85 text-white' }
  const playbackUrl = String(resolvePlaybackUrl(video) || video.originalUrl || video.videoUrl || video.previewUrl || '').trim()
  const thumbnailUrl = String(resolveThumbnailUrl(video) || video.thumbnailUrl || '').trim()
  const fallbackThumbnailUrl = String(video.fallbackThumbnailUrl || '').trim()
  const playbackPosterUrl = thumbnailUrl
  const createdAtLabel = new Date(video.createdAt).toLocaleString('th-TH', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const isOwnNamespaceVideo = isInboxVideoOwnedByCurrentNamespace(video, currentNamespaceId)
  const importedFromNamespaceId = String(
    video.importedFromNamespaceId
    || parseImportedNamespaceIdFromSourceLabel(video.sourceLabel)
    || ''
  ).trim()
  const isImportedFromOtherNamespace = !!importedFromNamespaceId && isOwnNamespaceVideo
  const showsOwnNamespaceBadge = isOwnNamespaceVideo && !isImportedFromOtherNamespace
  const ownershipBadge = showsOwnNamespaceBadge
    ? { cls: 'bg-blue-500/95 text-white', title: 'ของฉัน' }
    : { cls: 'bg-violet-500/95 text-white', title: 'Namespace อื่น' }
  const actionLabel = !ready
    ? 'ลิงก์ยังไม่ครบ'
    : canStartProcessing
      ? 'ส่งเข้า Processing'
      : 'เก็บในคลังต้นฉบับ'

  useEffect(() => {
    onExpandedChange?.(expanded)
    return () => onExpandedChange?.(false)
  }, [expanded, onExpandedChange])
  useViewerHistory(expanded, setExpanded)

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="relative aspect-[9/16] rounded-2xl overflow-hidden bg-gray-100 shadow-sm active:scale-95 transition-transform duration-200 text-left"
      >
        {thumbnailUrl || playbackUrl ? (
          <Thumb url={thumbnailUrl} fallback={playbackUrl} secondaryUrl={fallbackThumbnailUrl} />
        ) : (
          <div className={`w-full h-full flex flex-col items-center justify-center ${video.sourceType === 'xhs_url' ? 'bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300' : 'bg-gradient-to-br from-slate-700 to-slate-900'}`}>
            <div className="rounded-full bg-white/18 px-3 py-2 text-[10px] font-extrabold uppercase tracking-[0.22em] text-white">
              {video.sourceType === 'xhs_url' ? 'XHS' : 'ต้นฉบับ'}
            </div>
            <p className="mt-3 px-4 text-center text-xs font-semibold text-white/90 line-clamp-3">
              {video.sourceType === 'xhs_url' ? 'Xiaohongshu Link' : 'Telegram Video'}
            </p>
          </div>
        )}

        <div className="absolute left-2 top-2 flex flex-col items-start gap-1.5">
          {isProcessedView ? (
            <span title={ownershipBadge.title} className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold shadow-lg backdrop-blur-sm ${ownershipBadge.cls}`}>
              <InboxOwnershipIcon own={showsOwnNamespaceBadge} />
            </span>
          ) : (
            <>
              <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold shadow-lg backdrop-blur-sm ${sourceBadge.cls}`}>
                {sourceBadge.label}
              </span>
              <span title={ownershipBadge.title} className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold shadow-lg backdrop-blur-sm ${ownershipBadge.cls}`}>
                <InboxOwnershipIcon own={showsOwnNamespaceBadge} />
              </span>
            </>
          )}
        </div>

        <div className="absolute right-2 top-2 flex items-center gap-1">
          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold shadow-lg backdrop-blur-sm ${video.hasShopeeLink ? 'bg-emerald-500/95 text-white' : 'bg-black/55 text-white'}`}>
            S
          </span>
          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold shadow-lg backdrop-blur-sm ${video.hasLazadaLink ? 'bg-sky-500/95 text-white' : 'bg-black/55 text-white'}`}>
            L
          </span>
        </div>

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pb-3 pt-8 text-white">
          <p className="truncate text-[11px] font-extrabold">{video.id}</p>
          <p className="mt-0.5 truncate text-[10px] text-white/75">{createdAtLabel}</p>
        </div>
      </button>

      {expanded && (
        <div className="fixed inset-0 z-50 bg-[#fafafa] text-gray-900">
          <div className="mx-auto flex h-full w-full max-w-md flex-col bg-[#fafafa]">
            <div
              aria-hidden="true"
              className="sticky top-0 z-10 bg-[#fafafa]"
              style={{ height: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}
            />
            <div data-allow-touch-scroll="true" className="flex-1 overflow-y-auto app-scroll">
              <div
                className="space-y-4 px-4"
                style={{
                  paddingTop: '8px',
                  paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
                }}
              >
                <div
                  className="mx-auto overflow-hidden rounded-[28px] border border-gray-200 bg-white shadow-sm"
                  style={VERTICAL_VIEWER_FRAME_STYLE}
                >
                  {playbackUrl ? (
                    <video
                      src={playbackUrl}
                      className="block h-full w-full bg-white object-contain"
                      controls
                      autoPlay
                      playsInline
                      preload="metadata"
                      poster={playbackPosterUrl || undefined}
                    />
                  ) : (
                    <div className={`flex min-h-[320px] w-full flex-col items-center justify-center ${video.sourceType === 'xhs_url' ? 'bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300' : 'bg-gradient-to-br from-slate-700 to-slate-900'}`}>
                      <div className="rounded-full bg-white/18 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.22em] text-white">
                        {video.sourceType === 'xhs_url' ? 'XHS' : 'ต้นฉบับ'}
                      </div>
                      <p className="mt-3 px-6 text-center text-sm font-semibold text-white/90 break-all line-clamp-4">
                        {sourceLabel}
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${sourceBadge.cls.replace('/95', '').replace('/85', '')}`}>
                      {sourceBadge.label}
                    </span>
                    <span title={ownershipBadge.title} className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold ${showsOwnNamespaceBadge ? 'bg-blue-500 text-white' : 'bg-violet-500 text-white'}`}>
                      <InboxOwnershipIcon own={showsOwnNamespaceBadge} />
                    </span>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${video.hasShopeeLink ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                      Shopee
                    </span>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${video.hasLazadaLink ? 'bg-sky-500 text-white' : 'bg-gray-100 text-gray-500'}`}>
                      Lazada
                    </span>
                  </div>
                  <div className={`rounded-xl px-3 py-3 ${ready ? 'bg-blue-50 text-blue-900' : 'bg-amber-50 text-amber-900'}`}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-60">คลังต้นฉบับ</p>
                    <p className="mt-1 text-sm font-semibold">
                      {!ready
                        ? `คลิปต้นฉบับถูกเก็บในระบบแล้ว เหลือลิงก์ ${missingLinks || 'Shopee / Lazada'}`
                        : canStartProcessing
                          ? 'คลิปต้นฉบับถูกเก็บในระบบแล้ว และพร้อมส่งเข้า Processing ได้ทันที'
                          : 'คลิปต้นฉบับถูกเก็บในระบบแล้ว รายการนี้ใช้ดูย้อนหลังในคลังต้นฉบับได้เลย'}
                    </p>
                  </div>
                  <div className="rounded-xl bg-gray-50 px-3 py-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">Source</p>
                    <p className="mt-1 text-sm font-semibold text-gray-900 break-all">{sourceLabel}</p>
                    {!!String(video.namespace_id || '').trim() && (
                      <p className="mt-2 text-[11px] font-medium text-gray-500 break-all">Namespace: {video.namespace_id}</p>
                    )}
                    {isImportedFromOtherNamespace && (
                      <p className="mt-1 text-[11px] font-medium text-violet-600 break-all">นำเข้าจาก: {importedFromNamespaceId}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 rounded-xl bg-gray-50 px-3 py-2.5">
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">Video ID</p>
                      <p className="truncate text-sm font-semibold text-gray-900">{video.id}</p>
                    </div>
                    <div className="rounded-xl bg-gray-50 px-3 py-2.5 text-xs font-medium text-gray-500">
                      {createdAtLabel}
                    </div>
                  </div>
                  {(video.shopeeLink || video.lazadaLink) && (
                    <div className="space-y-2 text-[11px] text-gray-600">
                      {video.shopeeLink && (
                        <div className="rounded-xl bg-gray-50 px-3 py-2.5">
                          <p className="font-bold uppercase tracking-[0.18em] text-[10px] text-gray-400">Shopee</p>
                          <p className="mt-1 truncate">{video.shopeeLink}</p>
                        </div>
                      )}
                      {video.lazadaLink && (
                        <div className="rounded-xl bg-gray-50 px-3 py-2.5">
                          <p className="font-bold uppercase tracking-[0.18em] text-[10px] text-gray-400">Lazada</p>
                          <p className="mt-1 truncate">{video.lazadaLink}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => onDelete(video.id, video.namespace_id)}
                    disabled={deleting || starting || !canDelete}
                    className="flex-1 rounded-2xl border border-gray-200 bg-white py-3 text-sm font-bold text-gray-700 shadow-sm active:scale-95 transition-transform disabled:opacity-40"
                  >
                    {canDelete ? (deleting ? 'กำลังลบ...' : 'ลบ') : 'เก็บถาวร'}
                  </button>
                  <button
                    onClick={() => onStart(video.id, video.namespace_id)}
                    disabled={!ready || starting || deleting || !canStartProcessing}
                    className={`flex-[1.35] rounded-2xl py-3 text-sm font-bold transition-transform ${ready && !starting && !deleting && canStartProcessing ? 'bg-blue-500 text-white active:scale-95 shadow-sm' : 'bg-gray-200 text-gray-400'}`}
                  >
                    {starting ? 'กำลังส่งเข้า Processing...' : actionLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
