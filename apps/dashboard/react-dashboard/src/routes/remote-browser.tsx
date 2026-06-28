import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, RotateCw, X, Loader2, Globe } from 'lucide-react'
import {
  ACCOUNTS_BRIDGE_BASE,
  getRemoteBrowserStatus,
  remoteBrowserScreenshotUrl,
  remoteBrowserStreamUrl,
  sendRemoteBrowserInput,
  stopRemoteBrowser,
  type RemoteBrowserAction,
  type RemoteBrowserInputPayload,
  type RemoteBrowserSession,
  type RemoteBrowserStreamInput,
  type RemoteBrowserStreamMessage,
} from '@/api/accountsBridge'

// Cloud Browser viewer. PRIMARY path: a LIVE CDP screencast over a same-origin WebSocket
// (Page.startScreencast → JPEG frames; mouse/key → Input.dispatch*) so an operator drives a logged-in
// Facebook profile from any machine WITHOUT remoting the desktop and WITHOUT a 700ms HTTP poll. If the
// WebSocket cannot be established (proxy/transport limits) the viewer transparently FALLS BACK to the
// legacy screenshot polling, clearly labelled. Nothing secret crosses the wire: a frame is a rasterized
// image and status carries only id/url/title/status/viewport.

const SCREENSHOT_INTERVAL_MS = 850
const STATUS_INTERVAL_MS = 2500
const MAX_WS_RETRIES = 4
const MOUSE_MOVE_THROTTLE_MS = 40

type ConnState = 'connecting' | 'live' | 'reconnecting' | 'fallback'

// Map a pointer event over the displayed <img> to the remote page's CSS-pixel viewport coordinates.
// The screencast frame's device dimensions (from CDP metadata) or the session viewport give the CSS
// scale; we map the displayed position into that space so a click lands where the operator aimed.
function toRemoteCoords(
  img: HTMLImageElement,
  clientX: number,
  clientY: number,
  device: { width: number; height: number } | null,
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  const relX = (clientX - rect.left) / rect.width
  const relY = (clientY - rect.top) / rect.height
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null
  const w = device?.width || img.naturalWidth
  const h = device?.height || img.naturalHeight
  if (!w || !h) return null
  return { x: Math.round(relX * w), y: Math.round(relY * h) }
}

export function RemoteBrowserPage() {
  const params = useParams({ strict: false }) as { sessionId?: string }
  const sessionId = params.sessionId ?? ''

  const [conn, setConn] = useState<ConnState>('connecting')
  const [frameSrc, setFrameSrc] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0) // fallback-only screenshot cache-buster
  const [session, setSession] = useState<RemoteBrowserSession | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  const [busy, setBusy] = useState(false)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const urlEditing = useRef(false)
  const deviceSize = useRef<{ width: number; height: number } | null>(null)
  const mouseDown = useRef(false)
  const lastMove = useRef(0)
  const wheelAt = useRef(0)
  const retryRef = useRef(0)
  const closedRef = useRef(false)

  const live = conn === 'live'

  // Send one validated input frame up the WebSocket (live mode).
  const liveSend = useCallback((msg: RemoteBrowserStreamInput) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }, [])

  // Fallback (HTTP) input relay — used only when the WebSocket is unavailable.
  const httpSend = useCallback(
    async (action: RemoteBrowserAction, payload: RemoteBrowserInputPayload = {}) => {
      if (!sessionId || closedRef.current) return
      try {
        await sendRemoteBrowserInput(sessionId, action, payload)
        setNonce((n) => n + 1)
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [sessionId],
  )

  // ── WebSocket lifecycle (primary) ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionId || closed) return
    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (disposed || closedRef.current) return
      let ws: WebSocket
      try {
        ws = new WebSocket(remoteBrowserStreamUrl(sessionId))
      } catch {
        toFallback()
        return
      }
      wsRef.current = ws
      setConn(retryRef.current === 0 ? 'connecting' : 'reconnecting')

      ws.onopen = () => {
        if (disposed) return
        retryRef.current = 0
        setConn('live')
        setError(null)
      }
      ws.onmessage = (ev) => {
        if (disposed) return
        let msg: RemoteBrowserStreamMessage
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        } catch {
          return
        }
        if (msg.type === 'frame') {
          if (msg.metadata?.deviceWidth && msg.metadata?.deviceHeight) {
            deviceSize.current = { width: msg.metadata.deviceWidth, height: msg.metadata.deviceHeight }
          }
          setFrameSrc(`data:image/jpeg;base64,${msg.data}`)
        } else if (msg.type === 'status') {
          setSession((prev) => ({
            id: sessionId,
            account_uid: prev?.account_uid ?? '',
            url: msg.url,
            title: msg.title,
            status: msg.status,
            viewport: msg.viewport,
            started_at: prev?.started_at,
          }))
          if (msg.viewport) deviceSize.current = deviceSize.current ?? msg.viewport
          if (!urlEditing.current && msg.url) setUrlInput(msg.url)
        } else if (msg.type === 'error') {
          setError(msg.error)
        }
      }
      ws.onerror = () => {
        /* surfaced via onclose */
      }
      ws.onclose = () => {
        if (disposed || closedRef.current) return
        wsRef.current = null
        retryRef.current += 1
        if (retryRef.current > MAX_WS_RETRIES) {
          toFallback()
          return
        }
        setConn('reconnecting')
        reconnectTimer = setTimeout(connect, Math.min(2000, 300 * retryRef.current))
      }
    }

    const toFallback = () => {
      if (disposed) return
      setConn('fallback')
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const ws = wsRef.current
      wsRef.current = null
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
    }
  }, [sessionId, closed])

  // ── Fallback polling (screenshot + status) — only when the WebSocket gave up ─────────────────────
  useEffect(() => {
    if (conn !== 'fallback' || !sessionId || closed) return
    const t = setInterval(() => setNonce((n) => n + 1), SCREENSHOT_INTERVAL_MS)
    return () => clearInterval(t)
  }, [conn, sessionId, closed])

  useEffect(() => {
    if (conn !== 'fallback' || !sessionId || closed) return
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
  }, [conn, sessionId, closed])

  // ── Pointer input ────────────────────────────────────────────────────────────────────────────
  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      imgRef.current?.focus()
      const img = imgRef.current
      if (!img) return
      const c = toRemoteCoords(img, e.clientX, e.clientY, deviceSize.current)
      if (!c) return
      mouseDown.current = true
      if (live) liveSend({ type: 'mouse', event: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
    },
    [live, liveSend],
  )

  const onMouseUp = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current
      if (!img) return
      const c = toRemoteCoords(img, e.clientX, e.clientY, deviceSize.current)
      const wasDown = mouseDown.current
      mouseDown.current = false
      if (!c) return
      if (live) liveSend({ type: 'mouse', event: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 })
      else if (wasDown) void httpSend('click', c) // fallback: one HTTP click
    },
    [live, liveSend, httpSend],
  )

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (!live) return
      const now = Date.now()
      if (now - lastMove.current < MOUSE_MOVE_THROTTLE_MS) return
      lastMove.current = now
      const img = imgRef.current
      if (!img) return
      const c = toRemoteCoords(img, e.clientX, e.clientY, deviceSize.current)
      if (!c) return
      liveSend({ type: 'mouse', event: 'mouseMoved', x: c.x, y: c.y, button: mouseDown.current ? 'left' : 'none' })
    },
    [live, liveSend],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLImageElement>) => {
      const now = Date.now()
      if (now - wheelAt.current < 60) return
      wheelAt.current = now
      const dx = Math.round(e.deltaX)
      const dy = Math.round(e.deltaY)
      if (live) {
        const img = imgRef.current
        const c = img ? toRemoteCoords(img, e.clientX, e.clientY, deviceSize.current) : null
        liveSend({ type: 'mouse', event: 'mouseWheel', x: c?.x ?? 0, y: c?.y ?? 0, deltaX: dx, deltaY: dy })
      } else {
        void httpSend('scroll', { deltaX: dx, deltaY: dy })
      }
    },
    [live, liveSend, httpSend],
  )

  // ── Keyboard input (live: direct typing into the focused remote field) ───────────────────────────
  const isPrintable = (e: React.KeyboardEvent) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLImageElement>) => {
      if (!live) return
      // Don't hijack devtools/refresh shortcuts.
      if ((e.ctrlKey || e.metaKey) && ['r', 'R', 'i', 'I', 'j', 'J'].includes(e.key)) return
      e.preventDefault()
      liveSend({ type: 'key', event: 'keyDown', key: e.key, code: e.code })
      if (isPrintable(e)) liveSend({ type: 'key', event: 'char', text: e.key })
    },
    [live, liveSend],
  )

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLImageElement>) => {
      if (!live) return
      e.preventDefault()
      liveSend({ type: 'key', event: 'keyUp', key: e.key, code: e.code })
    },
    [live, liveSend],
  )

  // ── Toolbar (works in both modes) ────────────────────────────────────────────────────────────
  const command = useCallback(
    (cmd: 'back' | 'forward' | 'reload') => {
      if (live) liveSend({ type: 'command', command: cmd })
      else void httpSend(cmd)
    },
    [live, liveSend, httpSend],
  )

  const onNavigate = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      urlEditing.current = false
      const raw = urlInput.trim()
      if (!raw) return
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
      if (live) liveSend({ type: 'navigate', url })
      else void httpSend('navigate', { url })
    },
    [urlInput, live, liveSend, httpSend],
  )

  const onStop = useCallback(async () => {
    if (!sessionId) return
    setBusy(true)
    try {
      if (live) liveSend({ type: 'command', command: 'stop' })
      await stopRemoteBrowser(sessionId)
    } catch {
      // closing best-effort — show closed state regardless
    } finally {
      setBusy(false)
      setClosed(true)
    }
  }, [sessionId, live, liveSend])

  useEffect(() => {
    closedRef.current = closed
  }, [closed])

  // Close the session when the tab is closed/navigated away, so the Mac flushes + uploads the profile.
  useEffect(() => {
    const handler = () => {
      if (!sessionId || closedRef.current) return
      const stopUrl = `${ACCOUNTS_BRIDGE_BASE}/remote-browser/${encodeURIComponent(sessionId)}/stop`
      try {
        navigator.sendBeacon?.(stopUrl)
      } catch {
        /* best effort */
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [sessionId])

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

  const connLabel =
    conn === 'live'
      ? 'live'
      : conn === 'connecting'
        ? 'connecting…'
        : conn === 'reconnecting'
          ? 'reconnecting…'
          : 'fallback polling'
  const connColor =
    conn === 'live' ? 'bg-emerald-500' : conn === 'fallback' ? 'bg-amber-500' : 'bg-gray-500'

  // In live mode render the WS frame data URL; in fallback render the polled screenshot URL.
  const imgSrc = conn === 'fallback'
    ? (sessionId ? remoteBrowserScreenshotUrl(sessionId, nonce) : undefined)
    : (frameSrc ?? undefined)

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden rounded-lg border border-[#1f2937] bg-[#0b0f17] text-gray-100">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-[#1f2937] bg-[#111827] px-3 py-2">
        <button
          type="button"
          title="ย้อนกลับ · Back"
          onClick={() => command('back')}
          className="rounded p-1.5 text-gray-300 hover:bg-[#1f2937] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="ถัดไป · Forward"
          onClick={() => command('forward')}
          className="rounded p-1.5 text-gray-300 hover:bg-[#1f2937] hover:text-white"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="โหลดใหม่ · Reload"
          onClick={() => command('reload')}
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
          <span className={`h-2 w-2 rounded-full ${connColor}`} />
          {connLabel}
        </span>
        <span className="truncate">{session?.title || '—'}</span>
        <span className="ml-auto font-mono">UID: {session?.account_uid ?? '—'}</span>
        {error ? <span className="text-red-400">{error}</span> : null}
      </div>

      {/* Viewport — focusable so keystrokes flow straight into the remote page */}
      <div className="relative flex-1 overflow-auto bg-black">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        <img
          ref={imgRef}
          src={imgSrc}
          alt="Cloud Browser viewport"
          tabIndex={0}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onMouseMove={onMouseMove}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onContextMenu={(e) => e.preventDefault()}
          draggable={false}
          className="mx-auto block max-w-full cursor-crosshair select-none outline-none"
        />
        {!imgSrc ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-gray-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> กำลังเปิดเบราว์เซอร์บน Mac…
          </div>
        ) : null}
      </div>

      {/* Hint bar */}
      <div className="flex items-center gap-2 border-t border-[#1f2937] bg-[#111827] px-3 py-2 text-xs text-gray-400">
        {live ? (
          <span>คลิกที่หน้าจอเพื่อโฟกัส แล้วพิมพ์ได้ทันที · click the screen then type directly (live)</span>
        ) : conn === 'fallback' ? (
          <span className="text-amber-400">
            WebSocket ใช้ไม่ได้ — ใช้โหมดภาพนิ่ง (fallback polling): คลิก/เลื่อนได้ การพิมพ์ผ่านปุ่มลัดอาจช้า
          </span>
        ) : (
          <span>กำลังเชื่อมต่อสตรีมสด…</span>
        )}
      </div>
    </div>
  )
}
