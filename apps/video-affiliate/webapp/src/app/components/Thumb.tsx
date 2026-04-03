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

export function Thumb({
  url,
  fallback,
  secondaryUrl,
}: {
  id?: string
  url?: string
  fallback: string
  secondaryUrl?: string
}) {
  const primarySrc = inferThumbnailUrl(url, fallback)
  const normalizedSecondaryUrl = String(secondaryUrl || '').trim()
  const [attempt, setAttempt] = useState<0 | 1 | 2>(0)
  const src = attempt === 0
    ? primarySrc
    : attempt === 1
      ? normalizedSecondaryUrl
      : ''

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
      onError={() => {
        if (attempt === 0 && normalizedSecondaryUrl && normalizedSecondaryUrl !== primarySrc) {
          setAttempt(1)
          return
        }
        setAttempt(2)
      }}
    />
  )
}
