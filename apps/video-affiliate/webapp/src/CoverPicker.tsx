import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { DEFAULT_COVER_TEMPLATE_ID, getCoverTemplateById, normalizeCoverTemplateId, type CoverTemplateDefinition, type CoverTemplateId } from './coverTemplates'
import { API_BASE_URL } from './apiBaseUrl'

const WORKER_URL = API_BASE_URL

const DEFAULT_TEXT_PLACEMENT = { x: 0.5, y: 0.82 }
const GOOGLE_FONT_STYLESHEET_ID = 'cover-picker-google-fonts'
const GOOGLE_FONT_STYLESHEET_URL = 'https://fonts.googleapis.com/css2?family=Kanit:wght@700;800;900&family=Prompt:wght@700;800;900&family=Sarabun:wght@700;800&family=Bai+Jamjuree:wght@700&family=Noto+Sans+Thai:wght@700;800;900&display=swap'

type CoverFontId = 'kanit' | 'prompt' | 'sarabun' | 'bai-jamjuree' | 'noto-sans-thai'

const COVER_FONT_OPTIONS: Array<{ id: CoverFontId; label: string; family: string }> = [
  { id: 'kanit', label: 'Kanit', family: 'Kanit' },
  { id: 'prompt', label: 'Prompt', family: 'Prompt' },
  { id: 'sarabun', label: 'Sarabun', family: 'Sarabun' },
  { id: 'bai-jamjuree', label: 'Bai Jamjuree', family: 'Bai Jamjuree' },
  { id: 'noto-sans-thai', label: 'Noto Sans Thai', family: 'Noto Sans Thai' },
]

const LINE_COVER_LIFF_ID = '2009652996-u6XRk27e'
const COOKIE_SESSION_MARKER = 'cookie'
type CoverPickerRouteState = {
  videoId: string
  namespaceId: string
  templateId: CoverTemplateId
  fontId: CoverFontId
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function normalizeCoverFontId(value?: string | null): CoverFontId {
  const matched = COVER_FONT_OPTIONS.find((item) => item.id === value)
  return matched?.id || 'kanit'
}

function getCoverFontById(id?: string | null) {
  return COVER_FONT_OPTIONS.find((item) => item.id === id) || COVER_FONT_OPTIONS[0]
}

const buildFrameUrl = (frameUrlBase: string, timeSeconds: number) =>
  `${frameUrlBase}&t=${encodeURIComponent(timeSeconds.toFixed(2))}`

function normalizeSessionToken(value?: string | null) {
  const token = String(value || '').trim()
  return token.startsWith('sess_') ? token : ''
}

function normalizeStoredAuthState(value?: string | null) {
  const raw = String(value || '').trim()
  if (raw === COOKIE_SESSION_MARKER) return COOKIE_SESSION_MARKER
  return normalizeSessionToken(raw)
}

function safeDecodeURIComponent(value?: string | null) {
  let current = String(value || '')
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(current)
      if (decoded === current) break
      current = decoded
    } catch {
      break
    }
  }
  return current
}

function readCoverPickerRouteStateFromUrl(rawUrl: string): CoverPickerRouteState {
  const fallback: CoverPickerRouteState = {
    videoId: '',
    namespaceId: '',
    templateId: DEFAULT_COVER_TEMPLATE_ID,
    fontId: 'kanit',
  }

  const mergeParams = (searchParams: URLSearchParams | null | undefined) => {
    if (!searchParams) return
    const nextVideoId = String(searchParams.get('id') || '').trim()
    const nextNamespaceId = String(searchParams.get('ns') || '').trim()
    const nextTemplateId = normalizeCoverTemplateId(searchParams.get('tpl') || fallback.templateId)
    const nextFontId = normalizeCoverFontId(searchParams.get('font') || fallback.fontId)

    if (nextVideoId) fallback.videoId = nextVideoId
    if (nextNamespaceId) fallback.namespaceId = nextNamespaceId
    fallback.templateId = nextTemplateId
    fallback.fontId = nextFontId
  }

  const tryMergeFromUrl = (value?: string | null, currentUrl?: URL | null) => {
    const normalized = safeDecodeURIComponent(value)
    if (!normalized) return

    try {
      if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
        mergeParams(new URL(normalized).searchParams)
        return
      }

      if (normalized.startsWith('?')) {
        mergeParams(new URLSearchParams(normalized.slice(1)))
        return
      }

      if (normalized.startsWith('/')) {
        mergeParams(new URL(normalized, currentUrl?.origin || window.location.origin).searchParams)
        return
      }

      if (normalized.includes('=')) {
        mergeParams(new URLSearchParams(normalized.replace(/^\?/, '')))
        return
      }

      mergeParams(new URL(normalized, currentUrl?.origin || window.location.origin).searchParams)
    } catch {
      // Ignore invalid nested LIFF state values.
    }
  }

  try {
    const currentUrl = new URL(rawUrl)
    mergeParams(currentUrl.searchParams)
    tryMergeFromUrl(currentUrl.searchParams.get('liff.state'), currentUrl)

    const hash = String(currentUrl.hash || '').replace(/^#/, '')
    if (hash.startsWith('?')) {
      mergeParams(new URLSearchParams(hash.slice(1)))
    } else if (hash) {
      tryMergeFromUrl(hash, currentUrl)
    }
  } catch {
    // Fall back to defaults.
  }

  return fallback
}

function readStoredSessionToken() {
  try {
    const direct = normalizeStoredAuthState(localStorage.getItem('auth_token'))
    if (direct) return direct

    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || ''
      if (!key.startsWith('auth_token')) continue
      const stored = normalizeStoredAuthState(localStorage.getItem(key))
      if (stored) return stored
    }
  } catch {
    // Ignore storage issues in restricted webviews.
  }
  return ''
}

function buildCanvasFont(fontFamily: string, size: number, options: { weight?: number; italic?: boolean } = {}) {
  const weight = options.weight ?? 900
  return `${options.italic ? 'italic ' : ''}${weight} ${size}px "${fontFamily}", sans-serif`
}

function getEffectiveTextPlacement(templateId: CoverTemplateId, placement: { x: number; y: number }) {
  if (templateId === 'template-1' || templateId === 'template-9') {
    return { x: 0.5, y: placement.y }
  }
  return placement
}

export default function CoverPicker() {
  const initialRouteState = readCoverPickerRouteStateFromUrl(window.location.href)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewFrameRef = useRef<HTMLDivElement>(null)
  const textOverlayRef = useRef<HTMLDivElement>(null)
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null)

  const [routeState, setRouteState] = useState<CoverPickerRouteState>(initialRouteState)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [selectedFrame, setSelectedFrame] = useState<{ time: number; url: string; blob: Blob } | null>(null)
  const [coverText, setCoverText] = useState('')
  const [textPlacement, setTextPlacement] = useState(DEFAULT_TEXT_PLACEMENT)
  const [selectedTemplateId, setSelectedTemplateId] = useState<CoverTemplateId>(initialRouteState.templateId)
  const [selectedFontId, setSelectedFontId] = useState<CoverFontId>(initialRouteState.fontId)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [draggingText, setDraggingText] = useState(false)
  const [frameLoading, setFrameLoading] = useState(false)
  const [authToken, setAuthToken] = useState(() => readStoredSessionToken())
  const [currentFrameUrl, setCurrentFrameUrl] = useState('')
  const [bootReady, setBootReady] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [useServerFrameFallback, setUseServerFrameFallback] = useState(false)
  const seekRequestRef = useRef(0)
  const selectedCoverFont = getCoverFontById(selectedFontId)
  const videoId = routeState.videoId
  const namespaceId = routeState.namespaceId

  const videoUrl = `${WORKER_URL}/api/gallery/${encodeURIComponent(videoId)}/asset/original?namespace_id=${encodeURIComponent(namespaceId)}`
  const posterUrl = `${WORKER_URL}/api/gallery/${encodeURIComponent(videoId)}/asset/original-thumb?namespace_id=${encodeURIComponent(namespaceId)}`
  const frameUrlBase = `${WORKER_URL}/api/gallery/${encodeURIComponent(videoId)}/frame?namespace_id=${encodeURIComponent(namespaceId)}`
  const previewImageUrl = selectedFrame?.url || (useServerFrameFallback ? currentFrameUrl || posterUrl : '')

  const ensureAuthToken = useCallback(async (forceRefresh = false) => {
    const verifySession = async (sessionToken?: string) => {
      const normalizedSession = normalizeSessionToken(sessionToken)
      try {
        const headers = new Headers()
        if (normalizedSession) headers.set('x-auth-token', normalizedSession)
        const resp = await fetch(`${WORKER_URL}/api/me`, {
          headers,
          credentials: 'include',
          cache: 'no-store',
        })
        if (!resp.ok) return ''
        const effectiveSession = normalizedSession || COOKIE_SESSION_MARKER
        setAuthToken(effectiveSession)
        try { localStorage.setItem('auth_token', effectiveSession) } catch {}
        return effectiveSession
      } catch {
        return ''
      }
    }

    const currentToken = !forceRefresh ? String(authToken || '').trim() : ''
    if (currentToken === COOKIE_SESSION_MARKER || normalizeSessionToken(currentToken)) {
      const verified = await verifySession(currentToken)
      if (verified) return verified
    }

    const storedToken = !forceRefresh ? String(readStoredSessionToken() || '').trim() : ''
    if (storedToken === COOKIE_SESSION_MARKER || normalizeSessionToken(storedToken)) {
      const verified = await verifySession(storedToken)
      if (verified) {
        setAuthToken(verified)
        return verified
      }
    }

    const liff = window.liff
    if (!liff) return ''

    try {
      await liff.init({ liffId: LINE_COVER_LIFF_ID })
    } catch {
      // Keep trying with whatever LIFF state exists.
    }

    try {
      if (!liff.isLoggedIn?.() && liff.isInClient?.()) {
        liff.login({ redirectUri: window.location.href })
        return ''
      }
    } catch {
      // Ignore LIFF login capability issues in old clients.
    }

    try {
      let lineUserId = ''
      let displayName = ''
      let pictureUrl = ''
      let idToken = ''

      if (liff.isLoggedIn?.()) {
        try {
          const profile = await liff.getProfile()
          lineUserId = String(profile?.userId || '').trim()
          displayName = String(profile?.displayName || '').trim()
          pictureUrl = String(profile?.pictureUrl || '').trim()
        } catch {
          // Fallback below.
        }
        try {
          idToken = String(liff.getIDToken?.() || '').trim()
        } catch {
          idToken = ''
        }
      }

      if (!lineUserId) {
        try {
          const decoded = liff.getDecodedIDToken?.()
          lineUserId = String(decoded?.sub || '').trim()
        } catch {
          lineUserId = ''
        }
      }

      if (!lineUserId) return ''

      const resp = await fetch(`${WORKER_URL}/api/line/liff-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          line_user_id: lineUserId,
          display_name: displayName,
          picture_url: pictureUrl,
          id_token: idToken,
        }),
      })
      if (!resp.ok) return ''

      const loginData = await resp.json().catch(() => ({})) as { session_token?: string }
      const verified = await verifySession(String(loginData?.session_token || '').trim())
      if (!verified) return ''
      setAuthToken(verified)
      return verified
    } catch {
      return ''
    }
  }, [authToken])

  const renderCoverBlob = useCallback(async (sourceUrl: string, widthHint?: number, heightHint?: number) => {
    const canvas = canvasRef.current
    if (!canvas) throw new Error('Canvas not ready')

    const img = new Image()
    img.src = sourceUrl
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('โหลดภาพไม่สำเร็จ'))
      if (img.complete) resolve()
    })

    const w = widthHint || img.naturalWidth || img.width
    const h = heightHint || img.naturalHeight || img.height
    canvas.width = w
    canvas.height = h

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas context missing')

    if ('fonts' in document) {
      try {
        await document.fonts.load(buildCanvasFont(selectedCoverFont.family, Math.max(28, Math.round(w * 0.07)), { italic: selectedTemplateId === 'template-1' }))
      } catch {
        // Best effort only.
      }
    }

    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)

    drawTemplateOverlay(ctx, getCoverTemplateById(selectedTemplateId), coverText.trim(), textPlacement, selectedCoverFont.family, w, h)

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('สร้างภาพไม่สำเร็จ'))
      }, 'image/png')
    })
  }, [coverText, selectedCoverFont.family, selectedTemplateId, textPlacement])

  // Extract frames when video metadata loads
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video || video.duration <= 0) return
    setDuration(video.duration)
  }, [])

  const waitForVideoFramePaint = useCallback((video: HTMLVideoElement) => {
    return new Promise<void>((resolve) => {
      const finalize = () => resolve()
      const requestFrame = (video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number
      }).requestVideoFrameCallback
      if (typeof requestFrame === 'function') {
        requestFrame.call(video, () => finalize())
        return
      }
      requestAnimationFrame(() => requestAnimationFrame(finalize))
    })
  }, [])

  const syncVideoToTime = useCallback(async (time: number) => {
    const video = videoRef.current
    if (!video) throw new Error('Video not ready')

    const targetTime = clamp(time, 0, Math.max(0, duration - 0.05))
    const requestId = ++seekRequestRef.current
    setFrameLoading(true)

    await new Promise<void>((resolve, reject) => {
      let finished = false
      let timeoutId = 0

      const cleanup = () => {
        video.removeEventListener('seeked', handleSeeked)
        video.removeEventListener('loadeddata', handleLoadedData)
        video.removeEventListener('error', handleError)
        window.clearTimeout(timeoutId)
      }

      const finish = () => {
        if (finished) return
        finished = true
        cleanup()
        resolve()
      }

      const fail = (message: string) => {
        if (finished) return
        finished = true
        cleanup()
        reject(new Error(message))
      }

      const handleSeeked = () => finish()
      const handleLoadedData = () => {
        if (Math.abs(video.currentTime - targetTime) <= 0.08) {
          finish()
        }
      }
      const handleError = () => fail('โหลดวิดีโอไม่สำเร็จ')

      if (video.readyState >= 2 && Math.abs(video.currentTime - targetTime) <= 0.08) {
        finish()
        return
      }

      video.addEventListener('seeked', handleSeeked, { once: true })
      video.addEventListener('loadeddata', handleLoadedData)
      video.addEventListener('error', handleError, { once: true })
      timeoutId = window.setTimeout(() => fail('เลื่อนเฟรมไม่สำเร็จ'), 1800)

      try {
        video.currentTime = targetTime
      } catch {
        fail('เลื่อนเฟรมไม่สำเร็จ')
      }
    })

    await waitForVideoFramePaint(video)
    if (requestId === seekRequestRef.current) {
      setCurrentTime(targetTime)
      setVideoReady(true)
      setLoading(false)
      setFrameLoading(false)
    }
    return video
  }, [duration, waitForVideoFramePaint])

  const renderCoverBlobFromCurrentVideoFrame = useCallback(async (time: number) => {
    const video = await syncVideoToTime(time)
    const canvas = canvasRef.current
    if (!canvas) throw new Error('Canvas not ready')

    const width = video.videoWidth || 1080
    const height = video.videoHeight || 1920
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas context missing')

    if ('fonts' in document) {
      try {
        await document.fonts.load(buildCanvasFont(selectedCoverFont.family, Math.max(28, Math.round(width * 0.07)), { italic: selectedTemplateId === 'template-1' }))
      } catch {
        // Best effort only.
      }
    }

    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(video, 0, 0, width, height)
    drawTemplateOverlay(ctx, getCoverTemplateById(selectedTemplateId), coverText.trim(), textPlacement, selectedCoverFont.family, width, height)

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('สร้างภาพไม่สำเร็จ'))
      }, 'image/png')
    })
  }, [coverText, selectedCoverFont.family, selectedTemplateId, syncVideoToTime, textPlacement])

  const captureFrame = useCallback(async (time: number) => {
    setError('')
    const targetTime = clamp(time, 0, Math.max(0, duration - 0.05))
    if (!useServerFrameFallback) {
      try {
        const video = await syncVideoToTime(targetTime)
        const canvas = canvasRef.current
        if (!canvas) throw new Error('Canvas not ready')

        const width = video.videoWidth || 720
        const height = video.videoHeight || 1280
        canvas.width = width
        canvas.height = height

        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas context missing')

        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(video, 0, 0, width, height)

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((nextBlob) => {
            if (nextBlob) resolve(nextBlob)
            else reject(new Error('จับภาพไม่ได้'))
          }, 'image/png')
        })

        const url = URL.createObjectURL(blob)
        setSelectedFrame((current) => {
          if (current?.url) URL.revokeObjectURL(current.url)
          return { time: targetTime, url, blob }
        })
        setCurrentTime(targetTime)
        return
      } catch {
        setUseServerFrameFallback(true)
      }
    }

    setFrameLoading(true)
    try {
      const frameUrl = buildFrameUrl(frameUrlBase, targetTime)
      const resp = await fetch(frameUrl, { cache: 'no-store' })
      if (!resp.ok) throw new Error(`โหลดเฟรมไม่สำเร็จ (${resp.status})`)
      const blob = await resp.blob()
      if (!blob.size) {
        throw new Error('จับภาพไม่ได้ — ลองเลื่อน slider แล้วกดจับภาพอีกครั้ง')
      }

      const url = URL.createObjectURL(blob)
      setSelectedFrame((current) => {
        if (current?.url) URL.revokeObjectURL(current.url)
        return { time: targetTime, url, blob }
      })
      setCurrentFrameUrl(frameUrl)
      setCurrentTime(targetTime)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดเฟรมวิดีโอไม่สำเร็จ ลองจับภาพอีกครั้ง')
    } finally {
      setFrameLoading(false)
    }
  }, [duration, frameUrlBase, syncVideoToTime, useServerFrameFallback])

  // Upload selected frame
  const handleConfirm = async () => {
    if (!selectedFrame) return
    setUploading(true)
    setError('')

    try {
      const uploadBlob = async (key: string, blob: Blob, contentType: string) => {
        const doUpload = async (sessionToken?: string) => {
          const headers = new Headers({ 'Content-Type': contentType })
          const normalizedSession = normalizeSessionToken(sessionToken)
          if (normalizedSession) headers.set('x-auth-token', normalizedSession)
          return fetch(`${WORKER_URL}/api/r2-upload/${key}`, {
          method: 'PUT',
          headers,
          credentials: 'include',
          body: blob,
        })
        }

        let sessionToken = await ensureAuthToken(false)
        if (!sessionToken) throw new Error('หมดสิทธิ์เข้าใช้งาน ลองเปิดจากแชต LINE ใหม่อีกครั้ง')

        let resp = await doUpload(sessionToken)
        if (resp.status === 401) {
          sessionToken = await ensureAuthToken(true)
          if (!sessionToken) throw new Error('เซสชันหมดอายุ ลองเปิดจากแชต LINE ใหม่อีกครั้ง')
          resp = await doUpload(sessionToken)
        }
        if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`)
        return resp
      }

      const finalBlob = useServerFrameFallback
        ? await renderCoverBlob(selectedFrame.url)
        : await renderCoverBlobFromCurrentVideoFrame(selectedFrame.time)
      const uploadKey = `videos/${videoId}_original_thumb.webp`
      await uploadBlob(uploadKey, finalBlob, 'image/png')
      setDone(true)

      // Trigger processing via LIFF. Bot will reply with the selected cover preview card.
      if (window.liff?.isInClient()) {
        try {
          // Upload a smaller preview for bot flex hero
          const previewCanvas = document.createElement('canvas')
          const previewCtx = previewCanvas.getContext('2d')!
          const img = new Image()
          const previewUrl = URL.createObjectURL(finalBlob)
          img.src = previewUrl
          await new Promise<void>((r) => { img.onload = () => r(); if (img.complete) r() })
          previewCanvas.width = 240
          previewCanvas.height = Math.round(240 * (img.height / img.width))
          previewCtx.drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height)
          const previewBlob = await new Promise<Blob>((r) => previewCanvas.toBlob((b) => r(b!), 'image/jpeg', 0.7))
          URL.revokeObjectURL(previewUrl)

          // Upload preview to R2 for LINE to access
          const previewKey = `_inbox_cover/${videoId}_preview.jpg`
          await uploadBlob(previewKey, previewBlob, 'image/jpeg')

          await window.liff.sendMessages([
            { type: 'text', text: 'เสร็จแล้ว' },
          ])
        } catch {}
        setTimeout(() => window.liff.closeWindow(), 500)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  // Slider seek
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextTime = parseFloat(e.target.value)
    setCurrentTime(nextTime)
    if (selectedFrame?.url) {
      URL.revokeObjectURL(selectedFrame.url)
    }
    setSelectedFrame(null)
    if (useServerFrameFallback) return
    void syncVideoToTime(nextTime).catch(() => {
      setUseServerFrameFallback(true)
      setCurrentFrameUrl(buildFrameUrl(frameUrlBase, nextTime))
      setFrameLoading(false)
    })
  }

  const handleSliderEnd = () => {
    if (useServerFrameFallback) {
      setCurrentFrameUrl(buildFrameUrl(frameUrlBase, currentTime))
      return
    }
    void syncVideoToTime(currentTime).catch(() => {
      setUseServerFrameFallback(true)
      setCurrentFrameUrl(buildFrameUrl(frameUrlBase, currentTime))
      setFrameLoading(false)
    })
  }

  const handleSliderCapture = () => {
    captureFrame(currentTime)
  }

  const clampTextPlacement = useCallback((nextPlacement: { x: number; y: number }) => {
    const frameRect = previewFrameRef.current?.getBoundingClientRect()
    const overlayRect = textOverlayRef.current?.getBoundingClientRect()
    const fullWidthTemplate = selectedTemplateId === 'template-1' || selectedTemplateId === 'template-9'

    if (!frameRect) {
      return getEffectiveTextPlacement(selectedTemplateId, {
        x: clamp(nextPlacement.x, 0.12, 0.88),
        y: clamp(nextPlacement.y, 0.08, 0.92),
      })
    }

    let minX = fullWidthTemplate ? 0.5 : 0.12
    let maxX = fullWidthTemplate ? 0.5 : 0.88
    let minY = 0.08
    let maxY = 0.92

    if (overlayRect) {
      if (!fullWidthTemplate) {
        const halfW = overlayRect.width / frameRect.width / 2
        minX = clamp(halfW, 0.08, 0.5)
        maxX = clamp(1 - halfW, 0.5, 0.92)
      }
      const halfH = overlayRect.height / frameRect.height / 2
      minY = clamp(halfH, 0.07, 0.5)
      maxY = clamp(1 - halfH, 0.5, 0.93)
    }

    return getEffectiveTextPlacement(selectedTemplateId, {
      x: clamp(nextPlacement.x, minX, maxX),
      y: clamp(nextPlacement.y, minY, maxY),
    })
  }, [selectedTemplateId])

  const handleOverlayPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!coverText.trim()) return
    const frameRect = previewFrameRef.current?.getBoundingClientRect()
    if (!frameRect) return

    const effectivePlacement = getEffectiveTextPlacement(selectedTemplateId, textPlacement)
    dragOffsetRef.current = {
      dx: event.clientX - (frameRect.left + frameRect.width * effectivePlacement.x),
      dy: event.clientY - (frameRect.top + frameRect.height * effectivePlacement.y),
    }
    setDraggingText(true)
    event.preventDefault()
    event.stopPropagation()
  }, [coverText, selectedTemplateId, textPlacement])

  useEffect(() => {
    document.title = 'EDIT COVER'
    let linkEl = document.getElementById(GOOGLE_FONT_STYLESHEET_ID) as HTMLLinkElement | null
    if (!linkEl) {
      linkEl = document.createElement('link')
      linkEl.id = GOOGLE_FONT_STYLESHEET_ID
      linkEl.rel = 'stylesheet'
      linkEl.href = GOOGLE_FONT_STYLESHEET_URL
      document.head.appendChild(linkEl)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        if (window.liff) {
          await window.liff.init({ liffId: LINE_COVER_LIFF_ID })
        }
      } catch {
        // Continue and read the current URL directly.
      }

      if (cancelled) return
      const nextRouteState = readCoverPickerRouteStateFromUrl(window.location.href)
      setRouteState(nextRouteState)
      setSelectedTemplateId((current) => current === initialRouteState.templateId ? nextRouteState.templateId : current)
      setSelectedFontId((current) => current === initialRouteState.fontId ? nextRouteState.fontId : current)
      setBootReady(true)
      void ensureAuthToken(false)
    })()

    return () => {
      cancelled = true
    }
  }, [ensureAuthToken, initialRouteState.fontId, initialRouteState.templateId])

  useEffect(() => {
    if (!authToken) return
    let cancelled = false
    void (async () => {
      try {
        const resp = await fetch(`${WORKER_URL}/api/settings/cover-template`, {
          credentials: 'include',
          cache: 'no-store',
        })
        if (!resp.ok) return
        const data = await resp.json().catch(() => null) as { template_id?: string } | null
        if (!cancelled && data?.template_id) {
          setSelectedTemplateId(normalizeCoverTemplateId(data.template_id))
        }
      } catch {
        // Keep default template.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authToken])

  useEffect(() => {
    if (!duration) return
    const initialTime = clamp(duration * 0.08, 0, Math.max(0, duration - 0.1))
    setCurrentTime(initialTime)
    if (useServerFrameFallback) {
      setCurrentFrameUrl(buildFrameUrl(frameUrlBase, initialTime))
      return
    }
    void syncVideoToTime(initialTime).catch(() => {
      setUseServerFrameFallback(true)
      setCurrentFrameUrl(buildFrameUrl(frameUrlBase, initialTime))
      setFrameLoading(false)
    })
  }, [duration, frameUrlBase, syncVideoToTime, useServerFrameFallback])

  useEffect(() => {
    return () => {
      if (selectedFrame?.url) URL.revokeObjectURL(selectedFrame.url)
    }
  }, [selectedFrame])

  useEffect(() => {
    if (!draggingText) return

    const handlePointerMove = (event: PointerEvent) => {
      const frameRect = previewFrameRef.current?.getBoundingClientRect()
      const dragOffset = dragOffsetRef.current
      if (!frameRect || !dragOffset) return

      const nextX = (event.clientX - frameRect.left - dragOffset.dx) / frameRect.width
      const nextY = (event.clientY - frameRect.top - dragOffset.dy) / frameRect.height
      setTextPlacement(clampTextPlacement({ x: nextX, y: nextY }))
    }

    const handlePointerEnd = () => {
      dragOffsetRef.current = null
      setDraggingText(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }
  }, [clampTextPlacement, draggingText])

  const selectedTemplate = getCoverTemplateById(selectedTemplateId)

  if (!bootReady) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-blue-500 animate-spin" />
          <p className="text-sm">กำลังเปิดหน้าเลือกปก...</p>
        </div>
      </div>
    )
  }

  if (!videoId || !namespaceId) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <p className="text-gray-500 text-sm">Missing video ID or namespace</p>
      </div>
    )
  }

  return (
    <div className="h-[100dvh] bg-[#fafafa] max-w-md mx-auto flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 px-4 py-3 flex flex-col justify-center gap-3">
        {/* Video Preview */}
        <div
          ref={previewFrameRef}
          className="w-full max-w-[280px] rounded-[28px] overflow-hidden bg-black aspect-[9/16] max-h-[58vh] mx-auto relative shadow-[0_18px_40px_rgba(15,23,42,0.18)]"
        >
          {previewImageUrl ? (
            <img
              src={previewImageUrl}
              alt="cover preview"
              className="w-full h-full object-cover"
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false)
                setError('โหลดเฟรมวิดีโอไม่สำเร็จ ลองเลื่อน slider แล้วกดจับภาพอีกครั้ง')
              }}
            />
          ) : (
            <video
              ref={videoRef}
              src={videoUrl}
              poster={posterUrl}
              playsInline
              muted
              crossOrigin="anonymous"
              preload="auto"
              className="w-full h-full object-cover"
              onLoadedMetadata={handleLoadedMetadata}
              onLoadedData={() => {
                setVideoReady(true)
                setLoading(false)
                setFrameLoading(false)
              }}
              onCanPlay={() => {
                setVideoReady(true)
                setLoading(false)
                setFrameLoading(false)
              }}
              onError={() => {
                setUseServerFrameFallback(true)
                setCurrentFrameUrl(buildFrameUrl(frameUrlBase, currentTime))
                setLoading(false)
                setFrameLoading(false)
                setError('วิดีโอบนอุปกรณ์นี้ถอดเฟรมไม่ได้ กำลังสลับไปใช้โหมดสำรอง')
              }}
            />
          )}
          {(loading || frameLoading) && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <div className="w-8 h-8 border-3 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {(previewImageUrl || videoReady) && coverText.trim() ? (
            <TemplateOverlay
              containerRef={textOverlayRef}
              dragging={draggingText}
              fontFamily={selectedCoverFont.family}
              onPointerDown={handleOverlayPointerDown}
              placement={textPlacement}
              template={selectedTemplate}
              text={coverText.trim()}
            />
          ) : null}
        </div>

        <div className="space-y-2">
          <textarea
            value={coverText}
            onChange={(e) => setCoverText(e.target.value.slice(0, 80))}
            placeholder="เพิ่มข้อความบนปก"
            rows={2}
            className="w-full resize-none rounded-3xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400"
          />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-gray-400">Font</p>
              <p className="text-[11px] text-gray-500">Google Fonts แบบหนา</p>
            </div>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {COVER_FONT_OPTIONS.map((font) => {
                const active = selectedFontId === font.id
                return (
                  <button
                    key={font.id}
                    type="button"
                    onClick={() => setSelectedFontId(font.id)}
                    className={`shrink-0 rounded-2xl border px-3 py-2 text-left transition active:scale-95 ${
                      active
                        ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm'
                        : 'border-gray-200 bg-white text-gray-700'
                    }`}
                    style={{ fontFamily: `"${font.family}", sans-serif` }}
                  >
                    <div className="text-[13px] font-black">{font.label}</div>
                    <div className="text-[10px] opacity-70">ข้อความตัวอย่าง</div>
                  </button>
                )
              })}
            </div>
          </div>
          <p className="text-[11px] text-center text-gray-500">ลากข้อความบนภาพเพื่อจัดตำแหน่งได้เลย</p>
          <div className="rounded-2xl border border-gray-200 bg-white px-3 py-2 text-[11px] text-gray-500">
            ใช้เทมเพลต: <span className="font-bold text-gray-900">{selectedTemplate.name}</span> • ฟอนต์ <span className="font-bold text-gray-900">{selectedCoverFont.label}</span>
          </div>
        </div>
      </div>

      {/* Bottom Actions */}
      <div className="flex-shrink-0 px-4 py-3 bg-white border-t border-gray-100 space-y-3">
        {duration > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={duration}
                step={0.05}
                value={currentTime}
                onChange={handleSliderChange}
                onMouseUp={handleSliderEnd}
                onTouchEnd={handleSliderEnd}
                className="flex-1 h-2 bg-gray-200 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-md"
              />
              <button
                onClick={handleSliderCapture}
                disabled={frameLoading}
                className="px-3 py-2 bg-blue-500 text-white text-xs font-bold rounded-2xl active:scale-95 shrink-0"
              >
                {frameLoading ? 'กำลังจับ...' : 'จับภาพ'}
              </button>
            </div>
            <p className="text-xs text-gray-400 text-center">
              {currentTime.toFixed(1)}s / {duration.toFixed(1)}s
            </p>
          </div>
        )}
        {error && <p className="text-xs text-red-500 text-center">{error}</p>}
        {done ? (
          <div className="py-3 text-center">
            <p className="text-green-600 font-bold">บันทึกปกเรียบร้อย</p>
          </div>
        ) : (
          <button
            onClick={handleConfirm}
            disabled={!selectedFrame || uploading}
            className={`w-full py-3 rounded-2xl text-sm font-bold transition-all active:scale-[0.98] ${
              selectedFrame && !uploading
                ? 'bg-blue-500 text-white shadow-sm'
                : 'bg-gray-200 text-gray-400'
            }`}
          >
            {uploading ? 'กำลังอัปโหลด...' : 'ยืนยันเลือกปก'}
          </button>
        )}
      </div>

      {/* Hidden Canvas */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  )
}

function wrapText(text: string, ctx: CanvasRenderingContext2D, maxWidth: number, fontSize: number, fontFamily: string) {
  const source = String(text || '').trim()
  if (!source) return []

  ctx.font = buildCanvasFont(fontFamily, fontSize, { weight: 800 })

  const words = source.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (ctx.measureText(next).width <= maxWidth) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
  }

  if (current) lines.push(current)
  return lines
}

function TemplateOverlay({
  containerRef,
  dragging,
  fontFamily,
  onPointerDown,
  placement,
  template,
  text,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  dragging: boolean
  fontFamily: string
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  placement: { x: number; y: number }
  template: CoverTemplateDefinition
  text: string
}) {
  const effectivePlacement = getEffectiveTextPlacement(template.id, placement)
  const fullWidthTemplate = template.id === 'template-1' || template.id === 'template-9'
  const wrapperStyle: CSSProperties = {
    left: `${effectivePlacement.x * 100}%`,
    top: `${effectivePlacement.y * 100}%`,
    transform: 'translate(-50%, -50%)',
    width: fullWidthTemplate ? '100%' : 'min(84%, 260px)',
    maxWidth: fullWidthTemplate ? '100%' : 'min(84%, 260px)',
  }
  const wrapperClassName = `absolute pointer-events-auto select-none touch-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`

  if (template.id === 'template-1') {
    return (
      <div className="absolute inset-0 pointer-events-none">
        <div
          ref={containerRef}
          onPointerDown={onPointerDown}
          className={wrapperClassName}
          style={wrapperStyle}
        >
          <div
            className="w-full px-5 py-3 shadow-[0_16px_34px_rgba(229,57,53,0.34)]"
          style={{ background: `linear-gradient(90deg, ${template.accent}, ${template.accentAlt})` }}
          >
            <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-center text-[21px] font-black italic leading-tight text-white [text-shadow:0_2px_8px_rgba(0,0,0,0.22)]">{text}</p>
          </div>
        </div>
      </div>
    )
  }

  if (template.id === 'template-2') {
    return (
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        <div className="rounded-[26px] border border-white/75 bg-white/78 px-4 py-3 shadow-[0_16px_42px_rgba(15,23,42,0.16)] backdrop-blur">
          <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-center text-[18px] font-black leading-tight text-slate-900">{text}</p>
        </div>
      </div>
    )
  }

  if (template.id === 'template-3') {
    return (
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-center text-[24px] font-black leading-tight text-white [text-shadow:0_4px_14px_rgba(0,0,0,0.7)]">{text}</p>
        <div className="mx-auto mt-2 h-1.5 w-20 rounded-full" style={{ background: template.accent }} />
      </div>
    )
  }

  if (template.id === 'template-4') {
    return (
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        <div className="mb-2 inline-flex rounded-full px-3 py-1 text-[10px] font-black text-white shadow" style={{ background: template.accent }}>COVER</div>
        <div className="rounded-[22px] bg-black/64 px-4 py-3">
          <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-center text-[18px] font-black leading-tight text-white">{text}</p>
        </div>
      </div>
    )
  }

  if (template.id === 'template-5') {
    return (
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        <div className="flex overflow-hidden rounded-[24px] bg-black/74 shadow-[0_14px_40px_rgba(0,0,0,0.3)]">
          <div className="w-3 shrink-0" style={{ background: `linear-gradient(180deg, ${template.accent}, ${template.accentAlt})` }} />
          <div className="flex-1 px-4 py-3">
            <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-left text-[18px] font-black leading-tight text-white">{text}</p>
          </div>
        </div>
      </div>
    )
  }

  if (template.id === 'template-6') {
    return (
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        <div className="mb-2 inline-flex rounded-full px-3 py-1 text-[10px] font-black text-white shadow" style={{ background: template.accent }}>FEATURED</div>
        <div className="rounded-[24px] bg-white px-4 py-3 shadow-[0_18px_44px_rgba(15,23,42,0.18)]">
          <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-left text-[18px] font-black leading-tight text-slate-900">{text}</p>
        </div>
      </div>
    )
  }

  if (template.id === 'template-7') {
    return (
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        <div className="rounded-[20px] px-4 py-3 shadow-[0_14px_40px_rgba(0,0,0,0.3)]" style={{ background: `linear-gradient(90deg, ${template.accent}, ${template.accentAlt})` }}>
          <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-center text-[18px] font-black leading-tight text-white">{text}</p>
        </div>
      </div>
    )
  }

  if (template.id === 'template-8') {
    return (
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        <div className="rounded-[24px] border-[2.5px] border-white bg-black/32 px-4 py-3 shadow-[0_12px_36px_rgba(0,0,0,0.28)]">
          <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-center text-[18px] font-black leading-tight text-white">{text}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 pointer-events-none">
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        className={wrapperClassName}
        style={wrapperStyle}
      >
        <div className="w-full px-5 py-4 shadow-[0_14px_40px_rgba(0,0,0,0.24)]" style={{ background: `linear-gradient(90deg, ${template.accent}, ${template.accentAlt})` }}>
          <p style={{ fontFamily: `"${fontFamily}", sans-serif` }} className="whitespace-pre-wrap break-words text-center text-[18px] font-black leading-tight text-white">{text}</p>
        </div>
      </div>
    </div>
  )
}

function drawTemplateOverlay(
  ctx: CanvasRenderingContext2D,
  template: CoverTemplateDefinition,
  text: string,
  placement: { x: number; y: number },
  fontFamily: string,
  width: number,
  height: number,
) {
  if (!text) return

  const paddingX = Math.round(width * 0.08)
  const fontSize = Math.max(28, Math.round(width * 0.07))
  const lineHeight = Math.round(fontSize * 1.2)
  const maxWidth = width - paddingX * 2 - 24
  const effectivePlacement = getEffectiveTextPlacement(template.id, placement)
  const lines = text
    .split('\n')
    .flatMap((paragraph) => wrapText(paragraph, ctx, maxWidth, fontSize, fontFamily))
    .slice(0, 4)

  if (!lines.length) return

  ctx.font = buildCanvasFont(fontFamily, fontSize, { weight: 800 })
  const widestLine = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0)
  const textBlockHeight = lines.length * lineHeight
  const fullWidthTemplate = template.id === 'template-1' || template.id === 'template-9'
  const panelW = fullWidthTemplate
    ? width
    : Math.min(width - 24, Math.max(Math.round(widestLine + 52), Math.round(width * 0.48)))
  const panelH = textBlockHeight + Math.round(fontSize * 0.95)
  const extraTop = template.id === 'template-4' || template.id === 'template-6' ? 38 : 0
  const extraBottom = template.id === 'template-3' ? 24 : 0
  const containerH = panelH + extraTop + extraBottom
  const centerX = fullWidthTemplate
    ? width / 2
    : clamp(
        Math.round(effectivePlacement.x * width),
        Math.round(panelW / 2) + 12,
        Math.round(width - panelW / 2) - 12
      )
  const containerY = clamp(
    Math.round(effectivePlacement.y * height - containerH / 2),
    12,
    Math.max(12, Math.round(height - containerH - 12))
  )
  const panelX = fullWidthTemplate ? 0 : Math.round(centerX - panelW / 2)
  const panelY = containerY + extraTop
  let startY = panelY + Math.round((panelH - textBlockHeight) / 2)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.1))

  const drawLines = (fillStyle: string, strokeStyle = 'rgba(0,0,0,0.4)', align: CanvasTextAlign = 'center', x = centerX, startYOverride?: number) => {
    ctx.textAlign = align
    ctx.fillStyle = fillStyle
    ctx.strokeStyle = strokeStyle
    lines.forEach((line, index) => {
      const y = (startYOverride ?? startY) + index * lineHeight
      ctx.strokeText(line, x, y)
      ctx.fillText(line, x, y)
    })
  }

  if (template.id === 'template-1') {
    const gradient = ctx.createLinearGradient(0, panelY, width, panelY)
    gradient.addColorStop(0, template.accent)
    gradient.addColorStop(1, template.accentAlt)
    const barY = panelY
    const barH = panelH
    ctx.fillStyle = gradient
    ctx.fillRect(0, barY, width, barH)
    ctx.font = buildCanvasFont(fontFamily, fontSize + 2, { weight: 900, italic: true })
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#FFFFFF'
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'
    ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.08))
    lines.forEach((line, index) => {
      const y = startY + index * lineHeight
      ctx.strokeText(line, centerX, y)
      ctx.fillText(line, centerX, y)
    })
    return
  }

  if (template.id === 'template-2') {
    ctx.fillStyle = 'rgba(255,255,255,0.78)'
    roundRect(ctx, panelX, panelY, panelW, panelH, 28)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 2
    roundRect(ctx, panelX, panelY, panelW, panelH, 28)
    ctx.stroke()
    drawLines('#0F172A', 'rgba(255,255,255,0.18)')
    return
  }

  if (template.id === 'template-3') {
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'
    ctx.lineWidth = Math.max(5, Math.round(fontSize * 0.12))
    drawLines('#FFFFFF', 'rgba(0,0,0,0.7)', 'center', centerX, containerY)
    ctx.fillStyle = template.accent
    roundRect(ctx, centerX - 64, containerY + textBlockHeight + 14, 128, 10, 999)
    ctx.fill()
    return
  }

  if (template.id === 'template-4') {
    ctx.fillStyle = template.accent
    roundRect(ctx, centerX - 70, containerY, 140, 34, 999)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = buildCanvasFont(fontFamily, Math.max(16, Math.round(fontSize * 0.46)), { weight: 900 })
    ctx.textAlign = 'center'
    ctx.fillText('COVER', centerX, containerY + 8)
    ctx.font = buildCanvasFont(fontFamily, fontSize, { weight: 800 })
    ctx.fillStyle = 'rgba(0,0,0,0.64)'
    roundRect(ctx, panelX, panelY, panelW, panelH, 24)
    ctx.fill()
    drawLines('#FFFFFF')
    return
  }

  if (template.id === 'template-5') {
    ctx.fillStyle = 'rgba(0,0,0,0.74)'
    roundRect(ctx, panelX, panelY, panelW, panelH, 24)
    ctx.fill()
    ctx.fillStyle = template.accent
    roundRect(ctx, panelX, panelY, 20, panelH, 24)
    ctx.fill()
    ctx.font = buildCanvasFont(fontFamily, fontSize, { weight: 800 })
    startY += 2
    drawLines('#FFFFFF', 'rgba(0,0,0,0.38)', 'left', panelX + 44)
    return
  }

  if (template.id === 'template-6') {
    ctx.fillStyle = template.accent
    roundRect(ctx, panelX, containerY, 132, 34, 999)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = buildCanvasFont(fontFamily, Math.max(15, Math.round(fontSize * 0.4)), { weight: 900 })
    ctx.textAlign = 'center'
    ctx.fillText('FEATURED', panelX + 66, containerY + 9)
    ctx.font = buildCanvasFont(fontFamily, fontSize, { weight: 800 })
    ctx.fillStyle = '#FFFFFF'
    roundRect(ctx, panelX, panelY, panelW, panelH, 26)
    ctx.fill()
    drawLines('#111827', 'rgba(255,255,255,0.1)', 'left', panelX + 22)
    return
  }

  if (template.id === 'template-7') {
    const gradient = ctx.createLinearGradient(panelX, panelY, panelX + panelW, panelY)
    gradient.addColorStop(0, template.accent)
    gradient.addColorStop(1, template.accentAlt)
    ctx.fillStyle = gradient
    roundRect(ctx, panelX, panelY, panelW, panelH, 22)
    ctx.fill()
    drawLines('#FFFFFF', 'rgba(0,0,0,0.28)')
    return
  }

  if (template.id === 'template-8') {
    ctx.fillStyle = 'rgba(0,0,0,0.32)'
    roundRect(ctx, panelX, panelY, panelW, panelH, 24)
    ctx.fill()
    ctx.strokeStyle = '#FFFFFF'
    ctx.lineWidth = 4
    roundRect(ctx, panelX, panelY, panelW, panelH, 24)
    ctx.stroke()
    drawLines('#FFFFFF', 'rgba(0,0,0,0.3)')
    return
  }

  const gradient = ctx.createLinearGradient(0, panelY, width, panelY)
  gradient.addColorStop(0, template.accent)
  gradient.addColorStop(1, template.accentAlt)
  ctx.fillStyle = gradient
  ctx.fillRect(0, panelY - 8, width, panelH + 16)
  drawLines('#FFFFFF', 'rgba(0,0,0,0.28)')
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

// Extend Window for LIFF
declare global {
  interface Window {
    liff: any
  }
}
