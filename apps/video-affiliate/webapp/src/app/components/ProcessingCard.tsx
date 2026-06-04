import { useEffect, useState } from 'react'

const statusMeta = (statusRaw: unknown) => {
  const status = String(statusRaw || '').trim().toLowerCase()
  if (status === 'processed' || status === 'success' || status === 'done') {
    return { icon: '✅', label: 'สำเร็จ', badge: 'bg-emerald-50 text-emerald-700', circle: 'bg-emerald-50 text-emerald-600' }
  }
  if (status === 'failed' || status === 'error') {
    return { icon: '❌', label: 'ล้มเหลว', badge: 'bg-red-50 text-red-700', circle: 'bg-red-50 text-red-600' }
  }
  if (status === 'cancelled' || status === 'canceled') {
    return { icon: '⛔', label: 'ยกเลิกแล้ว', badge: 'bg-slate-100 text-slate-600', circle: 'bg-slate-100 text-slate-500' }
  }
  if (status === 'queued') {
    return { icon: '⏳', label: 'รอคิว', badge: 'bg-amber-50 text-amber-700', circle: 'bg-amber-50 text-amber-600' }
  }
  return { icon: '', label: 'กำลังทำ', badge: 'bg-blue-50 text-blue-700', circle: 'bg-blue-50 text-blue-600' }
}

const formatDateTime = (value: unknown) => {
  const raw = String(value || '').trim()
  if (!raw) return '-'
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) return raw
  return date.toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
}

const summarizeError = (value: unknown) => {
  const raw = String(value || '').trim()
  const lower = raw.toLowerCase()
  if (!raw) return 'ระบบประมวลผลไม่สำเร็จ แต่ยังไม่มีรายละเอียดสาเหตุ'
  if (raw.includes('API_KEY_INVALID') || lower.includes('api key not found') || lower.includes('invalid api key')) {
    return 'Gemini API Key ใช้งานไม่ได้หรือยังไม่ได้ตั้งค่า ให้ไปหน้า ตั้งค่า > AI API Keys แล้วเช็ค/เปลี่ยนคีย์'
  }
  if (raw.includes('"code": 429') || lower.includes('quota') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'Gemini ใช้งานเกินโควต้า/ถูกจำกัดชั่วคราว ให้รอสักพักหรือเปลี่ยน Gemini API Key'
  }
  if (lower.includes('shortlink_timeout') || lower.includes('shortlink timeout')) {
    return 'ย่อลิงก์ Shopee ไม่ตอบกลับทันเวลา ให้ลองประมวลผลใหม่อีกครั้ง'
  }
  if (lower.includes('shortlink_disabled')) {
    return 'namespace นี้ยังไม่ได้เปิดย่อลิงก์ตอนประมวลผล'
  }
  if (lower.includes('vertex') || lower.includes('tts')) {
    return 'สร้างเสียง TTS ไม่สำเร็จ ให้ตรวจสถานะ Vertex TTS ในหน้า AI API Keys'
  }
  if (lower.includes('container') || lower.includes('dispatch')) {
    return 'ระบบตัดต่อวิดีโอไม่พร้อมชั่วคราว ให้ลองประมวลผลใหม่'
  }
  if (lower.includes('timeout')) {
    return 'ระบบภายนอกตอบช้าเกินเวลา ให้ลองประมวลผลใหม่'
  }
  if (lower.includes('network') || lower.includes('fetch failed')) {
    return 'เชื่อมต่อบริการภายนอกไม่สำเร็จ ให้ลองใหม่อีกครั้ง'
  }
  return raw.length > 90 ? `${raw.slice(0, 90)}…` : raw
}

export function ProcessingCard({
  video,
  onCancel,
  onReprocess,
  onOpenProcessedVideo,
  retrying,
}: {
  video: any
  onCancel: (id: string, isQueued: boolean) => void
  onReprocess: (id: string) => void
  onOpenProcessedVideo?: (video: any) => void
  retrying: boolean
}) {
  const normalizedStatus = String(video.status || '').trim().toLowerCase()
  const active = normalizedStatus === 'processing' || normalizedStatus === 'queued'
  const failed = normalizedStatus === 'failed' || normalizedStatus === 'error'
  const processed = normalizedStatus === 'processed' || normalizedStatus === 'success' || normalizedStatus === 'done'
  const meta = statusMeta(normalizedStatus)
  const displayProgress = normalizedStatus === 'queued'
    ? 0
    : processed
      ? 100
      : Math.max(5, Math.min(100, Math.floor(((video.step || 0) / 5) * 100)))

  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) return
    const start = new Date(video.startedAt || video.updatedAt || video.createdAt).getTime()
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [active, video.startedAt, video.updatedAt, video.createdAt])
  const fmtElapsed = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  const eventTime = video.completedAt || video.processedAt || video.updatedAt || video.createdAt

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${meta.circle}`}>
            {normalizedStatus === 'processing' ? (
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent animate-spin rounded-full" />
            ) : (
              <span className="text-lg">{meta.icon}</span>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <p className="font-extrabold text-gray-900 text-sm truncate">ID: {video.id}</p>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-black shrink-0 ${meta.badge}`}>{meta.label}</span>
            </div>
            <p className="text-[10px] text-gray-400 font-medium">อัปเดต {formatDateTime(eventTime)}</p>
          </div>
        </div>

        {failed && (
          <button
            onClick={() => onReprocess(video.id)}
            disabled={retrying}
            title="ประมวลผลใหม่"
            className="p-2 rounded-full bg-blue-50 text-blue-500 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
        {active && (
          <button
            onClick={() => onCancel(video.id, normalizedStatus === 'queued')}
            title={normalizedStatus === 'queued' ? 'ยกเลิกคิว' : 'ยกเลิกงาน'}
            className="p-2 rounded-full bg-gray-50 text-gray-400 active:scale-95 transition-all"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      {failed ? (
        <div className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700 leading-relaxed">
          {summarizeError(video.error)}
        </div>
      ) : normalizedStatus === 'queued' ? (
        <p className="text-xs bg-amber-50 text-amber-700 px-3 py-2 rounded-xl font-bold">กำลังรอคิว</p>
      ) : processed ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs bg-emerald-50 text-emerald-700 px-3 py-2 rounded-xl font-bold">ส่งเข้าแกลลี่แล้ว</p>
          {onOpenProcessedVideo && (
            <button
              type="button"
              onClick={() => onOpenProcessedVideo(video)}
              className="w-full rounded-xl bg-emerald-500 px-3 py-2.5 text-xs font-black text-white active:scale-[0.98] transition-all shadow-sm shadow-emerald-100"
            >
              ▶ ดูวิดีโอและรายละเอียด
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-xs bg-blue-50 text-blue-700 px-3 py-2 rounded-xl font-bold truncate flex-1">{video.stepName || 'กำลังประมวลผล...'}</p>
          <span className="text-xs font-mono font-bold text-gray-400 shrink-0">{fmtElapsed}</span>
        </div>
      )}

      {(active || processed) && (
        <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
          <div
            className={`h-2 rounded-full transition-all duration-300 ease-linear ${processed ? 'bg-emerald-500' : normalizedStatus === 'queued' ? 'bg-amber-400' : 'bg-gradient-to-r from-blue-500 to-indigo-500'}`}
            style={{ width: `${Math.max(2, displayProgress)}%` }}
          />
        </div>
      )}
    </div>
  )
}
