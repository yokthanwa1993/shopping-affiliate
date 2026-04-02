import { useEffect, useState } from 'react'

export function ProcessingCard({
  video,
  onCancel,
  onReprocess,
  retrying,
}: {
  video: any
  onCancel: (id: string, isQueued: boolean) => void
  onReprocess: (id: string) => void
  retrying: boolean
}) {
  const displayProgress = video.status === 'queued' ? 0 : Math.max(5, Math.min(100, Math.floor(((video.step || 0) / 5) * 100)))

  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = new Date(video.createdAt).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [video.createdAt])
  const fmtElapsed = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm relative flex flex-col gap-3">
      <div className="flex justify-between items-start">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${video.status === 'failed' ? 'bg-red-50 text-red-500' : video.status === 'queued' ? 'bg-amber-50 text-amber-500' : 'bg-blue-50 text-blue-500'}`}>
            {video.status === 'failed' ? '❌' : video.status === 'queued' ? '⏳' : (
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent animate-spin rounded-full" />
            )}
          </div>
          <div className="flex flex-col">
            <p className="font-extrabold text-gray-900 text-sm">ID: {video.id}</p>
            <p className="text-[10px] text-gray-400 font-medium">เริ่มเมื่อ {new Date(video.createdAt).toLocaleTimeString('th-TH')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {video.status === 'failed' && (
            <button
              onClick={() => onReprocess(video.id)}
              disabled={retrying}
              title="ประมวลผลใหม่"
              className="p-2 rounded-full bg-blue-50 text-blue-500 hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {retrying ? (
                <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent animate-spin rounded-full" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2v6h-6" />
                  <path d="M3 11a9 9 0 0 1 15-6.7L21 8" />
                  <path d="M3 22v-6h6" />
                  <path d="M21 13a9 9 0 0 1-15 6.7L3 16" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={() => onCancel(video.id, video.status === 'queued')}
            title={video.status === 'failed' ? 'ลบประวัติ' : 'ยกเลิก'}
            className={`p-2 rounded-full transition-colors ${video.status === 'failed' ? 'bg-red-50 text-red-500 hover:bg-red-100' : 'bg-gray-50 text-gray-400 hover:bg-red-50 hover:text-red-500'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      <div className="flex justify-between items-end mt-1">
        <div className="flex flex-col gap-1.5 flex-1 pr-4 min-w-0">
          <div className="flex items-center gap-1.5">
            {video.status === 'failed' ? (
              <span className="text-xs bg-red-50 text-red-600 px-2 py-0.5 rounded-md font-bold shrink-0 truncate">{video.error || 'ล้มเหลว'}</span>
            ) : video.status === 'queued' ? (
              <span className="text-xs bg-amber-50 text-amber-600 px-2 py-0.5 rounded-md font-bold shrink-0">กำลังรอคิว...</span>
            ) : (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-md font-bold shrink-0 truncate break-all line-clamp-1">{video.stepName || 'กำลังประมวลผล...'}</span>
                <span className="text-xs font-mono font-bold text-gray-400 shrink-0">{fmtElapsed}</span>
              </div>
            )}
          </div>
          <p className="text-[10px] text-gray-500 flex items-center gap-1.5 truncate">
            <span className="w-4 h-4 rounded-full bg-gray-50 flex items-center justify-center shrink-0"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
            <span className="truncate">{video.shopeeLink || 'ไม่มีลิงก์ Shopee'}</span>
          </p>
        </div>

        {video.status !== 'failed' && (
          <div className="text-right shrink-0">
            <span className="text-lg font-black text-blue-600">{video.status === 'queued' ? '0' : displayProgress}%</span>
          </div>
        )}
      </div>

      {video.status !== 'failed' && (
        <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden relative">
          <div
            className={`h-2.5 rounded-full transition-all duration-300 ease-linear ${video.status === 'queued' ? 'bg-amber-400' : 'bg-gradient-to-r from-blue-500 to-indigo-500'}`}
            style={{ width: `${Math.max(2, displayProgress)}%` }}
          />
        </div>
      )}
    </div>
  )
}
