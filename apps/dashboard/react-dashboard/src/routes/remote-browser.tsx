import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, RotateCw, X, Loader2, Globe } from 'lucide-react'
import {
  ACCOUNTS_BRIDGE_BASE,
  getRemoteBrowserStatus,
  remoteBrowserScreenshotUrl,
  sendRemoteBrowserInput,
  stopRemoteBrowser,
  type RemoteBrowserAction,
  type RemoteBrowserInputPayload,
  type RemoteBrowserSession,
} from '@/api/accountsBridge'

// Cloud Browser viewer. Streams JPEG frames of ONE page running on the Mac's persistent profile and
// relays click/type/scroll/navigate input back to it — so an operator drives a logged-in Facebook
// profile from any machine WITHOUT remoting the desktop. Nothing secret crosses the wire: the frame
// is a rasterized image and status carries only id/url/title/status/viewport.

const SCREENSHOT_INTERVAL_MS = 850
const STATUS_INTERVAL_MS = 2500

// Translate a pointer event over the displayed <img> to the screenshot's NATURAL pixel coordinates
// (the image's natural size equals the remote viewport), so a click lands where the operator aimed.
function toViewportCoords(img: HTMLImageElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0 || !img.naturalWidth || !img.naturalHeight) return null
  const relX = (clientX - rect.left) / rect.width
  const relY = (clientY - rect.top) / rect.height
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null
  return { x: Math.round(relX * img.naturalWidth), y: Math.round(relY * img.naturalHeight) }
}

export function RemoteBrowserPage() {
  const params = useParams({ strict: false }) as { sessionId?: string }
  const sessionId = params.sessionId ?? ''

  const [nonce, setNonce] = useState(0)
  const [session, setSession] = useState<RemoteBrowserSession | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [typeText, setTypeText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const urlEditing = useRef(false)
  const wheelAt = useRef(0)

  const send = useCallback(
    async (action: RemoteBrowserAction, payload: RemoteBrowserInputPayload = {}) => {
      if (!sessionId || closed) return
      try {
        await sendRemoteBrowserInput(sessionId, action, payload)
        // Nudge the frame poll so the result shows up promptly.
        setNonce((n) => n + 1)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [sessionId, closed],
  )

  // Poll the screenshot frame on a fixed cadence by bumping the cache-bust nonce.
  useEffect(() => {
    if (!sessionId || closed) return
    const t = setInterval(() => setNonce((n) => n + 1), SCREENSHOT_INTERVAL_MS)
    return () => clearInterval(t)
  }, [sessionId, closed])

  // Poll status (url/title) less often so the address bar reflects navigation done inside the page.
  useEffect(() => {
    if (!sessionId || closed) return
    let cancelled = false
    const controller = new AbortController()
    const tick = async () => {
      try {
        const s = await getRemoteBrowserStatus(sessionId, controller.signal)
        if (cancelled) return
        setSession(s)
        setError(null)
        if (!urlEditing.current && s.url) setUrlInput(s.url)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    void tick()
    const t = setInterval(tick, STATUS_INTERVAL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(t)
    }
  }, [sessionId, closed])

  const onImageClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current
      if (!img) return
      const coords = toViewportCoords(img, e.clientX, e.clientY)
      if (coords) void send('click', coords)
    },
    [send],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLImageElement>) => {
      // Throttle wheel relays so a single scroll gesture does not flood the bridge.
      const now = Date.now()
      if (now - wheelAt.current < 120) return
      wheelAt.current = now
      void send('scroll', { deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) })
    },
    [send],
  )

  const onNavigate = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      urlEditing.current = false
      const raw = urlInput.trim()
      if (!raw) return
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
      void send('navigate', { url })
    },
    [urlInput, send],
  )

  const onStop = useCallback(async () => {
    if (!sessionId) return
    setBusy(true)
    try {
      await stopRemoteBrowser(sessionId)
    } catch {
      // closing best-effort — show closed state regardless
    } finally {
      setBusy(false)
      setClosed(true)
    }
  }, [sessionId])

  // Close the session when the tab is closed/navigated away, so the Mac flushes + uploads the profile.
  useEffect(() => {
    const handler = () => {
      if (!sessionId || closed) return
      // Same-origin keepalive POST so the Mac closes the page + uploads the profile when the tab dies.
      const stopUrl = `${ACCOUNTS_BRIDGE_BASE}/remote-browser/${encodeURIComponent(sessionId)}/stop`
      try {
        navigator.sendBeacon?.(stopUrl)
      } catch {
        /* best effort */
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [sessionId, closed])

  if (closed) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <Globe className="h-10 w-10 text-muted-foreground" />
        <p className="text-lg font-medium">Cloud Browser ปิดแล้ว · session closed</p>
        <p className="text-sm text-muted-foreground">บันทึก session กลับไปยัง Mac เรียบร้อย · profile saved</p>
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-2 rounded-md bg-[#ee4d2d] px-4 py-2 text-sm font-medium text-white hover:bg-[#d8431f]"
        >
          ปิดแท็บ · Close tab
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden rounded-lg border border-[#1f2937] bg-[#0b0f17] text-gray-100">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-[#1f2937] bg-[#111827] px-3 py-2">
        <button
          type="button"
          title="ย้อนกลับ · Back"
          onClick={() => void send('back')}
          className="rounded p-1.5 text-gray-300 hover:bg-[#1f2937] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="ถัดไป · Forward"
          onClick={() => void send('forward')}
          className="rounded p-1.5 text-gray-300 hover:bg-[#1f2937] hover:text-white"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="โหลดใหม่ · Reload"
          onClick={() => void send('reload')}
          className="rounded p-1.5 text-gray-300 hover:bg-[#1f2937] hover:text-white"
        >
          <RotateCw className="h-4 w-4" />
        </button>
        <form onSubmit={onNavigate} className="flex flex-1 items-center">
          <input
            value={urlInput}
            onFocus={() => (urlEditing.current = true)}
            onBlur={() => (urlEditing.current = false)}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://www.facebook.com/"
            spellCheck={false}
            className="w-full rounded-md border border-[#374151] bg-[#0b0f17] px-3 py-1.5 text-sm text-gray-100 outline-none focus:border-[#ee4d2d]"
          />
        </form>
        <button
          type="button"
          title="หยุด & บันทึก session · Stop"
          onClick={() => void onStop()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          Stop
        </button>
      </div>

      {/* Status row */}
      <div className="flex items-center gap-3 border-b border-[#1f2937] bg-[#0d1320] px-3 py-1 text-xs text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${session?.status === 'running' ? 'bg-emerald-500' : 'bg-gray-500'}`}
          />
          {session?.status ?? 'connecting…'}
        </span>
        <span className="truncate">{session?.title || '—'}</span>
        <span className="ml-auto font-mono">UID: {session?.account_uid ?? '—'}</span>
        {error ? <span className="text-red-400">{error}</span> : null}
      </div>

      {/* Viewport */}
      <div className="relative flex-1 overflow-auto bg-black">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <img
          ref={imgRef}
          src={sessionId ? remoteBrowserScreenshotUrl(sessionId, nonce) : undefined}
          alt="Cloud Browser viewport"
          onClick={onImageClick}
          onWheel={onWheel}
          draggable={false}
          className="mx-auto block max-w-full cursor-crosshair select-none"
        />
        {!session ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-gray-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> กำลังเปิดเบราว์เซอร์บน Mac…
          </div>
        ) : null}
      </div>

      {/* Type bar — relays keystrokes to the focused field in the remote page */}
      <div className="flex items-center gap-2 border-t border-[#1f2937] bg-[#111827] px-3 py-2">
        <span className="text-xs text-gray-400">พิมพ์ลงช่องที่โฟกัส:</span>
        <input
          value={typeText}
          onChange={(e) => setTypeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (typeText) void send('type', { text: typeText })
              void send('key', { key: 'Enter' })
              setTypeText('')
            }
          }}
          placeholder="พิมพ์ข้อความแล้ว Enter เพื่อส่งเข้าไปในหน้าเว็บ"
          className="flex-1 rounded-md border border-[#374151] bg-[#0b0f17] px-3 py-1.5 text-sm text-gray-100 outline-none focus:border-[#ee4d2d]"
        />
        <button
          type="button"
          onClick={() => {
            if (typeText) {
              void send('type', { text: typeText })
              setTypeText('')
            }
          }}
          className="rounded-md border border-[#374151] px-3 py-1.5 text-sm text-gray-200 hover:bg-[#1f2937]"
        >
          ส่งข้อความ
        </button>
        <button
          type="button"
          onClick={() => void send('key', { key: 'Enter' })}
          className="rounded-md border border-[#374151] px-3 py-1.5 text-sm text-gray-200 hover:bg-[#1f2937]"
        >
          Enter
        </button>
      </div>
    </div>
  )
}
