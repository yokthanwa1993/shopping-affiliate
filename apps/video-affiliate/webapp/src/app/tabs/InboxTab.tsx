import { useMemo, type RefObject } from 'react'
import { InboxCard } from '../components/InboxCard'
import { getInboxVideoIdentityKey } from '../inboxUtils'
import type { InboxVideo } from '../sharedTypes'

export function InboxTab({
  isSystemAdmin,
  systemInboxLoading,
  systemInboxVideos,
  systemInboxProcessedTotalCount,
  systemInboxUnprocessedTotalCount,
  systemInboxLoadingMore,
  systemInboxHasMore,
  inboxLoading,
  inboxVideos,
  inboxProcessedTotalCount,
  inboxUnprocessedTotalCount,
  inboxView,
  onInboxViewChange,
  inboxLoadingMore,
  inboxHasMore,
  loadMoreRef,
  namespaceId,
  startingInboxId,
  deletingInboxId,
  onStartInboxVideo,
  onDeleteInboxVideo,
  onExpandedChange,
  resolvePlaybackUrl,
  resolveThumbnailUrl,
}: {
  isSystemAdmin: boolean
  systemInboxLoading: boolean
  systemInboxVideos: InboxVideo[]
  systemInboxProcessedTotalCount: number
  systemInboxUnprocessedTotalCount: number
  systemInboxLoadingMore: boolean
  systemInboxHasMore: boolean
  inboxLoading: boolean
  inboxVideos: InboxVideo[]
  inboxProcessedTotalCount: number
  inboxUnprocessedTotalCount: number
  inboxView: 'unprocessed' | 'processed'
  onInboxViewChange: (view: 'unprocessed' | 'processed') => void
  inboxLoadingMore: boolean
  inboxHasMore: boolean
  loadMoreRef: RefObject<HTMLDivElement | null>
  namespaceId?: string
  startingInboxId: string | null
  deletingInboxId: string | null
  onStartInboxVideo: (id: string, namespaceId?: string) => void
  onDeleteInboxVideo: (id: string, namespaceId?: string) => void
  onExpandedChange?: (expanded: boolean) => void
  resolvePlaybackUrl: (video: InboxVideo) => string
  resolveThumbnailUrl: (video: InboxVideo) => string
}) {
  const filteredSystemInboxVideos = useMemo(() => systemInboxVideos.filter((video) => (
    !!String(video.thumbnailUrl || '').trim()
    || !!String(video.fallbackThumbnailUrl || '').trim()
  )), [systemInboxVideos])
  const visibleSystemInboxVideos = useMemo(() => filteredSystemInboxVideos.filter((video) => (
    inboxView === 'processed'
      ? !!String(video.processedAt || '').trim()
      : !String(video.processedAt || '').trim()
  )), [filteredSystemInboxVideos, inboxView])
  const visibleInboxVideos = useMemo(() => inboxVideos.filter((video) => (
    inboxView === 'processed'
      ? !!String(video.processedAt || '').trim()
      : !String(video.processedAt || '').trim()
  )), [inboxVideos, inboxView])

  if (isSystemAdmin) {
    const currentTotal = inboxView === 'processed' ? systemInboxProcessedTotalCount : systemInboxUnprocessedTotalCount

    return (
      <div className="px-4">
        <div className="mb-3 flex bg-gray-100 p-1 rounded-xl gap-1">
          <button
            onClick={() => onInboxViewChange('unprocessed')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${inboxView === 'unprocessed' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            ยังไม่ประมวลผล ({systemInboxUnprocessedTotalCount})
          </button>
          <button
            onClick={() => onInboxViewChange('processed')}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${inboxView === 'processed' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            ประมวลผลแล้ว ({systemInboxProcessedTotalCount})
          </button>
        </div>
        {systemInboxLoading ? (
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="aspect-[9/16] rounded-2xl bg-gray-100 animate-pulse" />)}
          </div>
        ) : visibleSystemInboxVideos.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[50vh]">
            <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
              <span className="text-4xl grayscale opacity-50">📥</span>
            </div>
            <p className="text-gray-900 font-bold text-lg">{inboxView === 'processed' ? 'ยังไม่มีคลิปที่ประมวลผลแล้ว' : 'ยังไม่มีวิดีโอต้นฉบับ'}</p>
            <p className="text-gray-400 text-sm mt-1 text-center">
              {inboxView === 'processed'
                ? 'คลิปที่ประมวลผลเสร็จแล้วจะย้ายมาแสดงที่นี่'
                : 'ส่งวิดีโอหรือลิงก์ XHS มาทาง LINE แล้วจะแสดงที่นี่'}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {visibleSystemInboxVideos.map((video) => (
                <InboxCard
                  key={`${String(video.namespace_id || '').trim()}:${video.id}`}
                  video={video}
                  onStart={onStartInboxVideo}
                  onDelete={onDeleteInboxVideo}
                  starting={startingInboxId === getInboxVideoIdentityKey(video.id, video.namespace_id)}
                  deleting={deletingInboxId === getInboxVideoIdentityKey(video.id, video.namespace_id)}
                  onExpandedChange={onExpandedChange}
                  viewMode="processed"
                  currentNamespaceId={namespaceId}
                  resolvePlaybackUrl={resolvePlaybackUrl}
                  resolveThumbnailUrl={resolveThumbnailUrl}
                />
              ))}
            </div>
            {systemInboxHasMore && (
              <div ref={loadMoreRef} className={systemInboxLoadingMore ? 'py-5' : 'h-1'}>
                {systemInboxLoadingMore && (
                  <div className="flex items-center justify-center">
                    <div className="w-8 h-8 border-[3px] border-blue-200 border-t-blue-500 rounded-full animate-spin" />
                  </div>
                )}
              </div>
            )}
            {!systemInboxHasMore && currentTotal > visibleSystemInboxVideos.length && (
              <p className="py-4 text-center text-xs font-medium text-gray-400">
                แสดงแล้ว {visibleSystemInboxVideos.length}/{currentTotal} คลิป
              </p>
            )}
          </>
        )}
      </div>
    )
  }
  const currentTotal = inboxView === 'processed' ? inboxProcessedTotalCount : inboxUnprocessedTotalCount

  return (
    <div className="px-4">
      <div className="mb-3 flex bg-gray-100 p-1 rounded-xl gap-1">
        <button
          onClick={() => onInboxViewChange('unprocessed')}
          className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${inboxView === 'unprocessed' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          ยังไม่ประมวลผล ({inboxUnprocessedTotalCount})
        </button>
        <button
          onClick={() => onInboxViewChange('processed')}
          className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${inboxView === 'processed' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          ประมวลผลแล้ว ({inboxProcessedTotalCount})
        </button>
      </div>
      {inboxLoading ? (
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="aspect-[9/16] rounded-2xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : visibleInboxVideos.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[50vh]">
          <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
            <span className="text-4xl grayscale opacity-50">📥</span>
          </div>
          <p className="text-gray-900 font-bold text-lg">{inboxView === 'processed' ? 'ยังไม่มีคลิปที่ประมวลผลแล้ว' : 'ยังไม่มีวิดีโอต้นฉบับ'}</p>
          <p className="text-gray-400 text-sm mt-1 text-center">
            {inboxView === 'processed'
              ? 'คลิปที่ประมวลผลเสร็จแล้วจะย้ายมาแสดงที่นี่'
              : 'ส่งวิดีโอหรือ XHS link มาทาง Telegram แล้วระบบจะเก็บไว้ที่นี่ถาวร แยกจากหน้า Processing'}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {visibleInboxVideos.map((video) => (
              <InboxCard
                key={video.id}
                video={video}
                onStart={onStartInboxVideo}
                onDelete={onDeleteInboxVideo}
                starting={startingInboxId === getInboxVideoIdentityKey(video.id, video.namespace_id)}
                deleting={deletingInboxId === getInboxVideoIdentityKey(video.id, video.namespace_id)}
                onExpandedChange={onExpandedChange}
                currentNamespaceId={namespaceId}
                resolvePlaybackUrl={resolvePlaybackUrl}
                resolveThumbnailUrl={resolveThumbnailUrl}
              />
            ))}
          </div>
          {inboxHasMore && (
            <div ref={loadMoreRef} className={inboxLoadingMore ? 'py-5' : 'h-1'}>
              {inboxLoadingMore && (
                <div className="flex items-center justify-center">
                  <div className="w-8 h-8 border-[3px] border-blue-200 border-t-blue-500 rounded-full animate-spin" />
                </div>
              )}
            </div>
          )}
          {!inboxHasMore && currentTotal > visibleInboxVideos.length && (
            <p className="py-4 text-center text-xs font-medium text-gray-400">
              แสดงแล้ว {visibleInboxVideos.length}/{currentTotal} คลิป
            </p>
          )}
        </>
      )}
    </div>
  )
}
