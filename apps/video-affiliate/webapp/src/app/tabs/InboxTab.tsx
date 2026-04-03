import type { RefObject } from 'react'
import { InboxCard } from '../components/InboxCard'
import { dedupeSystemInboxVideos, getInboxVideoIdentityKey } from '../inboxUtils'
import type { InboxVideo } from '../sharedTypes'

export function InboxTab({
  isSystemAdmin,
  systemInboxLoading,
  systemInboxVideos,
  systemInboxLoadingMore,
  systemInboxHasMore,
  inboxLoading,
  inboxVideos,
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
  systemInboxLoadingMore: boolean
  systemInboxHasMore: boolean
  inboxLoading: boolean
  inboxVideos: InboxVideo[]
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
  if (isSystemAdmin) {
    const filtered = dedupeSystemInboxVideos(systemInboxVideos, namespaceId)
      .filter((video) => !!String(video.thumbnailUrl || '').trim())

    return (
      <div className="px-4">
        {systemInboxLoading ? (
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="aspect-[9/16] rounded-2xl bg-gray-100 animate-pulse" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[50vh]">
            <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
              <span className="text-4xl grayscale opacity-50">📥</span>
            </div>
            <p className="text-gray-900 font-bold text-lg">ยังไม่มีวิดีโอต้นฉบับ</p>
            <p className="text-gray-400 text-sm mt-1 text-center">ส่งวิดีโอหรือลิงก์ XHS มาทาง LINE แล้วจะแสดงที่นี่</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {filtered.map((video) => (
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
          </>
        )}
      </div>
    )
  }

  return (
    <div className="px-4">
      {inboxLoading ? (
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="aspect-[9/16] rounded-2xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : inboxVideos.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[50vh]">
          <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
            <span className="text-4xl grayscale opacity-50">📥</span>
          </div>
          <p className="text-gray-900 font-bold text-lg">ยังไม่มีวิดีโอต้นฉบับ</p>
          <p className="text-gray-400 text-sm mt-1 text-center">ส่งวิดีโอหรือ XHS link มาทาง Telegram แล้วระบบจะเก็บไว้ที่นี่ถาวร แยกจากหน้า Processing</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {inboxVideos.map((video) => (
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
        </>
      )}
    </div>
  )
}
