import { ProcessingCard } from '../components/ProcessingCard'

export function ProcessingTab({
  loading,
  processingVideos,
  onCancel,
  onReprocess,
  retryingProcessingId,
}: {
  loading: boolean
  processingVideos: any[]
  onCancel: (id: string, isQueued: boolean) => void
  onReprocess: (id: string) => void
  retryingProcessingId: string | null
}) {
  return (
    <div className="px-4">
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="bg-gray-100 rounded-2xl p-4 h-28 animate-pulse" />
          ))}
        </div>
      ) : processingVideos.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[50vh]">
          <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
            <span className="text-4xl grayscale opacity-50">⚙️</span>
          </div>
          <p className="text-gray-900 font-bold text-lg">No Processing Videos</p>
          <p className="text-gray-400 text-sm mt-1">Videos currently being dubbed will appear here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {processingVideos.map((video) => (
            <ProcessingCard
              key={video.id}
              video={video}
              onCancel={onCancel}
              onReprocess={onReprocess}
              retrying={retryingProcessingId === video.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}
