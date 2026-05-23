import { useMemo, useState } from 'react'
import { ProcessingCard } from '../components/ProcessingCard'

const getTodayString = () => new Date().toLocaleDateString('en-CA')
const getEventTime = (video: any) => String(video.completedAt || video.processedAt || video.updatedAt || video.createdAt || '').trim()

const getDateKey = (value: string) => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'unknown'
  return date.toLocaleDateString('en-CA')
}

const formatThaiDate = (dateKey: string) => {
  if (dateKey === 'unknown') return 'ไม่ทราบวัน'
  const [y, m, d] = dateKey.split('-')
  const year = Number(y)
  const month = Number(m)
  const day = Number(d)
  const thaiMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
  if (!year || !month || !day || !thaiMonths[month - 1]) return dateKey
  return `${day} ${thaiMonths[month - 1]} ${year + 543}`
}

const getStatusBucket = (statusRaw: unknown) => {
  const status = String(statusRaw || '').trim().toLowerCase()
  if (status === 'processed' || status === 'success' || status === 'done') return 'processed'
  if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') return 'failed'
  return 'active'
}

export function ProcessingTab({
  loading,
  error,
  processingVideos,
  onCancel,
  onReprocess,
  onOpenProcessedVideo,
  retryingProcessingId,
}: {
  loading: boolean
  error?: string
  processingVideos: any[]
  onCancel: (id: string, isQueued: boolean) => void
  onReprocess: (id: string) => void
  onOpenProcessedVideo?: (video: any) => void
  retryingProcessingId: string | null
}) {
  const [selectedDate, setSelectedDate] = useState<string>(getTodayString())
  const [statusTab, setStatusTab] = useState<'active' | 'failed' | 'processed'>('active')

  const grouped = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const video of processingVideos) {
      const key = getDateKey(getEventTime(video))
      const existing = map.get(key) || []
      existing.push(video)
      map.set(key, existing)
    }
    for (const [key, items] of map.entries()) {
      map.set(key, [...items].sort((a, b) => {
        const at = new Date(getEventTime(a)).getTime()
        const bt = new Date(getEventTime(b)).getTime()
        return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0)
      }))
    }
    return map
  }, [processingVideos])

  const dayVideos = grouped.get(selectedDate) || []
  const tabCounts = useMemo(() => ({
    active: dayVideos.filter((video) => getStatusBucket(video.status) === 'active').length,
    failed: dayVideos.filter((video) => getStatusBucket(video.status) === 'failed').length,
    processed: dayVideos.filter((video) => getStatusBucket(video.status) === 'processed').length,
  }), [dayVideos])
  const activeVideos = dayVideos.filter((video) => getStatusBucket(video.status) === statusTab)
  const showInitialLoading = loading && processingVideos.length === 0
  const tabs: Array<{ key: 'active' | 'failed' | 'processed'; label: string; count: number }> = [
    { key: 'active', label: 'กำลังประมวลผล', count: tabCounts.active },
    { key: 'failed', label: 'ล้มเหลว', count: tabCounts.failed },
    { key: 'processed', label: 'สำเร็จ', count: tabCounts.processed },
  ]

  return (
    <div className="px-4 pb-6">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
            />
            <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 flex items-center gap-3 active:scale-95 transition-all shadow-sm">
              <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-[11px] text-gray-400 font-medium">เลือกวันที่</p>
                <p className="text-sm font-bold text-gray-900">{formatThaiDate(selectedDate)}</p>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>

          <button
            onClick={() => setSelectedDate(getTodayString())}
            className="shrink-0 bg-blue-500 text-white px-4 py-3 rounded-2xl text-sm font-bold active:scale-95 transition-all shadow-sm shadow-blue-200"
          >
            วันนี้
          </button>
        </div>
      </div>

      <div className="flex bg-gray-100 p-1 mt-1 mb-2 rounded-xl gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setStatusTab(tab.key)}
            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${statusTab === tab.key
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
              }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {error && !showInitialLoading && processingVideos.length > 0 ? (
        <div className="mb-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
          โหลดข้อมูลงานประมวลผลไม่สำเร็จ: {error}
        </div>
      ) : null}

      {showInitialLoading ? (
        <div className="space-y-2.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-2xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : error && processingVideos.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[45vh] text-center px-6">
          <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
            <span className="text-4xl grayscale opacity-50">!</span>
          </div>
          <p className="text-gray-900 font-bold text-lg">โหลดข้อมูลไม่สำเร็จ</p>
          <p className="text-gray-400 text-sm mt-1">{error}</p>
        </div>
      ) : activeVideos.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-[45vh] text-center px-6">
          <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
            <span className="text-4xl grayscale opacity-50">🗓️</span>
          </div>
          <p className="text-gray-900 font-bold text-lg">ไม่มีงานในแท็บนี้</p>
          <p className="text-gray-400 text-sm mt-1">ลองเลือกวันอื่นหรือแท็บอื่น</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <p className="text-sm font-black text-gray-900">{formatThaiDate(selectedDate)}</p>
            <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-gray-500 shadow-sm">{activeVideos.length} งาน</span>
          </div>

          {activeVideos.map((video) => (
            <ProcessingCard
              key={`${video.status || 'job'}-${video.id}`}
              video={video}
              onCancel={onCancel}
              onReprocess={onReprocess}
              onOpenProcessedVideo={onOpenProcessedVideo}
              retrying={retryingProcessingId === video.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}
