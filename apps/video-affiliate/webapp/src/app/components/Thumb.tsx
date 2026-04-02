import { useState } from 'react'

export function inferThumbnailUrl(url: string | undefined, fallback: string): string {
  const direct = String(url || '').trim()
  if (direct) return direct
  const source = String(fallback || '').trim()
  if (!source) return ''
  if (/\/asset\/original(?:\?|$)/i.test(source)) {
    return source.replace(/\/asset\/original(?=\?|$)/i, '/asset/original-thumb')
  }
  if (/_original\.mp4(?:[?#].*)?$/i.test(source)) {
    return source.replace(/_original\.mp4/i, '_original_thumb.webp')
  }
  return source.replace(/\.mp4(?:[?#].*)?$/i, '_thumb.webp')
}

export function Thumb({ url, fallback }: { id?: string; url?: string; fallback: string }) {
  const [failed, setFailed] = useState(false)
  const src = failed ? '' : inferThumbnailUrl(url, fallback)

  if (!src) {
    return (
      <div className="w-full h-full bg-gradient-to-br from-slate-200 via-slate-100 to-white flex items-center justify-center">
        <div className="rounded-full bg-white/85 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 shadow-sm">
          No Thumb
        </div>
      </div>
    )
  }

  return (
    <img
      src={src}
      className="w-full h-full object-cover"
      loading="lazy"
      decoding="async"
      alt=""
      onError={() => setFailed(true)}
    />
  )
}
