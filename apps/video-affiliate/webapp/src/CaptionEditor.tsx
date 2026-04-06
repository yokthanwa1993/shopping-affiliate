import { useEffect, useMemo, useState } from 'react'

const MAX_CAPTION_CHARS = 1200

export default function CaptionEditor() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const initialCaption = String(params.get('caption') || '').slice(0, MAX_CAPTION_CHARS)

  const [caption, setCaption] = useState(initialCaption)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    document.title = 'EDIT CAPTION'
    if (window.liff) {
      window.liff.init({ liffId: '2009652996-DJtEhoDn' }).catch(() => {})
    }
  }, [])

  const remaining = MAX_CAPTION_CHARS - caption.length

  const handleSave = async () => {
    const value = String(caption || '').trim()
    if (!value) {
      setError('กรอกแคปชั่นก่อน')
      return
    }

    setSaving(true)
    setError('')
    try {
      if (!window.liff?.isInClient()) {
        throw new Error('open_in_line_required')
      }
      await window.liff.sendMessages([{ type: 'text', text: value.slice(0, MAX_CAPTION_CHARS) }])
      setTimeout(() => window.liff.closeWindow(), 300)
    } catch (e) {
      setSaving(false)
      setError(e instanceof Error && e.message === 'open_in_line_required'
        ? 'กรุณาเปิดผ่าน LINE'
        : (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="h-[100dvh] bg-[#fafafa] max-w-md mx-auto flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 px-4 pt-3 pb-3 flex flex-col gap-3 overflow-hidden">
        <div className="rounded-3xl bg-white shadow-sm border border-gray-100 p-4 flex-1 min-h-0 flex flex-col">
          <label className="block text-xs font-bold tracking-[0.18em] text-violet-500 uppercase mb-3">
            Caption
          </label>
          <textarea
            value={caption}
            onChange={(e) => {
              setCaption(e.target.value.slice(0, MAX_CAPTION_CHARS))
              if (error) setError('')
            }}
            placeholder="พิมพ์แคปชั่นมาได้เลย"
            className="w-full flex-1 min-h-[160px] rounded-2xl border border-violet-100 bg-violet-50/60 px-4 py-3 text-[15px] leading-6 text-gray-900 outline-none focus:border-violet-400 focus:bg-white resize-none"
          />
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-gray-400">รองรับสูงสุด {MAX_CAPTION_CHARS} ตัวอักษร</p>
            <p className={`text-xs font-bold ${remaining < 120 ? 'text-rose-500' : 'text-violet-500'}`}>
              {caption.length}/{MAX_CAPTION_CHARS}
            </p>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-600">
            {error}
          </div>
        ) : null}
      </div>

      <div className="px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-2 bg-white border-t border-gray-100 sticky bottom-0">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-2xl bg-violet-600 text-white font-bold py-3.5 active:scale-[0.99] disabled:opacity-60"
        >
          {saving ? 'กำลังส่ง...' : 'บันทึก'}
        </button>
      </div>
    </div>
  )
}
