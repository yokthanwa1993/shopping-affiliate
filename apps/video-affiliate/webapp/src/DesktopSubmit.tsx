import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMainLiffInitOptionsForHost, getMissingMainLiffMessageForHost, waitForLiffSdk } from './liffConfig'
import { API_BASE_URL } from './apiBaseUrl'

const WORKER_URL = API_BASE_URL

const getBotScopeFromLocation = () => {
  try {
    const url = new URL(window.location.href)
    return String(url.searchParams.get('bot') || '').trim()
  } catch {
    return ''
  }
}

const scopedStorageKey = (base: string, botScope?: string | null) => {
  const scope = String(botScope || '').trim()
  return scope ? `${base}:${scope}` : base
}

const COOKIE_SESSION_MARKER = 'cookie'

const normalizeSessionToken = (value?: string | null) => {
  const token = String(value || '').trim()
  return token.startsWith('sess_') ? token : ''
}

const normalizeStoredAuthState = (value?: string | null) => {
  const raw = String(value || '').trim()
  if (raw === COOKIE_SESSION_MARKER) return COOKIE_SESSION_MARKER
  return normalizeSessionToken(raw)
}

const getToken = (botScope = getBotScopeFromLocation()) =>
  normalizeStoredAuthState(localStorage.getItem(scopedStorageKey('auth_token', botScope)))

const buildFrameUrl = (frameUrlBase: string, timeSeconds: number) =>
  `${frameUrlBase}&t=${encodeURIComponent(timeSeconds.toFixed(2))}`

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim())

const makeUploadKey = (file: File) => `upload:${file.name}:${file.size}:${file.lastModified}`

type MePayload = {
  namespace_id?: string
  email?: string
  line_display_name?: string
  line_picture_url?: string
  line_user_id?: string
  is_owner?: boolean
  is_team_member?: boolean
}

type SubmitResponse = {
  ok?: boolean
  namespace_id?: string
  processing_url?: string
  gallery_url?: string
  video?: {
    id?: string
  }
  job?: {
    outcome?: string
  }
  error?: string
}

type PreparedVideo = {
  id: string
  namespace_id?: string
  sourceMode?: string
  sourceType?: string
  sourceLabel?: string
  originalUrl?: string
  thumbnailUrl?: string
  frameUrlBase?: string
}

type PrepareResponse = {
  ok?: boolean
  namespace_id?: string
  video?: PreparedVideo
  error?: string
}

function createDesktopVideoId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
}

function buildSampleFrameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0]
  const safeMax = Math.max(0, duration - 0.2)
  const anchors = [0.08, 0.18, 0.32, 0.48, 0.64, 0.78, 0.9]
  return anchors.map((ratio) => Math.min(safeMax, Math.max(0, duration * ratio)))
}

function formatSecondsLabel(value: number) {
  const total = Math.max(0, Math.round(value))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export default function DesktopSubmit() {
  const botScope = useMemo(() => getBotScopeFromLocation(), [])
  const mainLiffInitOptions = useMemo(() => getMainLiffInitOptionsForHost(), [])

  const [token, setToken] = useState(() => getToken(botScope))
  const [authLoading, setAuthLoading] = useState(true)
  const [authError, setAuthError] = useState('')
  const [pendingApproval, setPendingApproval] = useState(false)
  const [me, setMe] = useState<MePayload | null>(null)

  const [sourceMode, setSourceMode] = useState<'upload' | 'url'>('upload')
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [shopeeLink, setShopeeLink] = useState('')
  const [lazadaLink, setLazadaLink] = useState('')
  const [caption, setCaption] = useState('')

  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState('')
  const [preparedVideo, setPreparedVideo] = useState<PreparedVideo | null>(null)
  const [preparedSourceKey, setPreparedSourceKey] = useState('')
  const [videoDuration, setVideoDuration] = useState(0)
  const [selectedFrameTime, setSelectedFrameTime] = useState<number | null>(null)
  const [selectedFrameUrl, setSelectedFrameUrl] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitResult, setSubmitResult] = useState<SubmitResponse | null>(null)

  const hiddenVideoRef = useRef<HTMLVideoElement | null>(null)
  const prepareRunRef = useRef(0)
  const lastUploadedFileKeyRef = useRef('')

  const namespaceId = String(me?.namespace_id || '').trim()
  const displayName = String(me?.line_display_name || me?.email || '').trim()

  const frameTimes = useMemo(() => buildSampleFrameTimes(videoDuration), [videoDuration])
  const activePreviewUrl = selectedFrameUrl || String(preparedVideo?.thumbnailUrl || '').trim()
  const currentSourceKey = useMemo(() => {
    if (sourceMode === 'upload') {
      return videoFile ? makeUploadKey(videoFile) : ''
    }
    const trimmed = sourceUrl.trim()
    return isHttpUrl(trimmed) ? `url:${trimmed}` : ''
  }, [sourceMode, sourceUrl, videoFile])

  const resetPreparedState = useCallback(() => {
    setPreparedVideo(null)
    setPreparedSourceKey('')
    setVideoDuration(0)
    setSelectedFrameTime(null)
    setSelectedFrameUrl('')
    setPrepareError('')
    setSubmitResult(null)
  }, [])

  useEffect(() => {
    document.title = 'DESKTOP SUBMIT'
  }, [])

  useEffect(() => {
    let cancelled = false

    const hydrateFromSession = async (sessionToken?: string) => {
      const normalizedSession = normalizeSessionToken(sessionToken)
      const headers = new Headers()
      if (normalizedSession) headers.set('x-auth-token', normalizedSession)
      const resp = await fetch(`${WORKER_URL}/api/me`, {
        headers,
        cache: 'no-store',
        credentials: 'include',
      })
      if (!resp.ok) return false
      const meData = await resp.json().catch(() => ({})) as MePayload
      if (cancelled) return true
      const effectiveSession = normalizedSession || COOKIE_SESSION_MARKER
      setToken(effectiveSession)
      setMe(meData)
      setPendingApproval(false)
      if (meData.namespace_id) {
        localStorage.setItem(scopedStorageKey('auth_namespace', botScope), String(meData.namespace_id))
      }
      localStorage.setItem(scopedStorageKey('auth_token', botScope), effectiveSession)
      return true
    }

    const bootstrap = async () => {
      setAuthLoading(true)
      setAuthError('')

      const ok = await hydrateFromSession(getToken(botScope) || undefined).catch(() => false)
      if (ok) {
        if (!cancelled) setAuthLoading(false)
        return
      }
      localStorage.removeItem(scopedStorageKey('auth_token', botScope))

      const liff = await waitForLiffSdk()
      if (!liff) {
        if (!cancelled) {
          setAuthError('ไม่พบ LINE LIFF SDK')
          setAuthLoading(false)
        }
        return
      }

      try {
        if (!mainLiffInitOptions) {
          throw new Error(getMissingMainLiffMessageForHost())
        }

        await liff.init(mainLiffInitOptions)

        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href })
          return
        }

        let lineUserId = ''
        let lineDisplayName = ''
        let pictureUrl = ''
        let idToken = ''

        try {
          const profile = await liff.getProfile()
          lineUserId = profile?.userId || ''
          lineDisplayName = profile?.displayName || ''
          pictureUrl = profile?.pictureUrl || ''
        } catch {}

        try {
          idToken = liff.getIDToken?.() || ''
        } catch {}

        if (!lineUserId) {
          try {
            const ctx = liff.getContext?.()
            lineUserId = ctx?.userId || ''
          } catch {}
        }

        if (!lineUserId) throw new Error('ไม่พบ LINE UID')

        const loginResp = await fetch(`${WORKER_URL}/api/line/liff-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            line_user_id: lineUserId,
            display_name: lineDisplayName,
            picture_url: pictureUrl,
            id_token: idToken,
          }),
        })

        const loginData = await loginResp.json().catch(() => ({})) as {
          status?: string
          session_token?: string
          line_display_name?: string
          line_picture_url?: string
        }

        if (loginData?.status === 'pending') {
          if (!cancelled) {
            setPendingApproval(true)
            setMe({
              namespace_id: '',
              line_display_name: String(loginData.line_display_name || '').trim(),
              line_picture_url: String(loginData.line_picture_url || '').trim(),
              line_user_id: lineUserId,
            })
            setAuthLoading(false)
          }
          return
        }

        const ok = await hydrateFromSession(String(loginData?.session_token || '').trim()).catch(() => false)
        if (!ok) throw new Error('โหลดข้อมูลผู้ใช้ไม่สำเร็จ')
      } catch (error) {
        if (!cancelled) {
          setAuthError(error instanceof Error ? error.message : 'เข้าสู่ระบบไม่สำเร็จ')
        }
      } finally {
        if (!cancelled) setAuthLoading(false)
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [botScope, mainLiffInitOptions])

  useEffect(() => {
    if (!token || !currentSourceKey) return
    if (preparedSourceKey === currentSourceKey) return

    const runId = ++prepareRunRef.current
    const isUpload = sourceMode === 'upload'
    const timeout = window.setTimeout(async () => {
      setPreparing(true)
      setPrepareError('')
      try {
        let body: Record<string, unknown>
        if (isUpload) {
          if (!videoFile) return
          const uploadKey = makeUploadKey(videoFile)
          if (lastUploadedFileKeyRef.current !== uploadKey) {
            const videoId = createDesktopVideoId()
            const uploadResp = await fetch(`${WORKER_URL}/api/r2-upload/videos/${videoId}_original.mp4`, {
              method: 'PUT',
              headers: {
                'Content-Type': videoFile.type || 'video/mp4',
              },
              credentials: 'include',
              body: videoFile,
            })
            if (!uploadResp.ok) {
              throw new Error(`อัปโหลดวิดีโอไม่สำเร็จ (${uploadResp.status})`)
            }
            lastUploadedFileKeyRef.current = uploadKey
            body = {
              sourceMode: 'upload',
              videoId,
            }
          } else if (preparedVideo?.id) {
            body = {
              sourceMode: 'upload',
              videoId: preparedVideo.id,
            }
          } else {
            return
          }
        } else {
          const trimmedUrl = sourceUrl.trim()
          if (!isHttpUrl(trimmedUrl)) return
          body = {
            sourceMode: 'url',
            sourceUrl: trimmedUrl,
            sourceLabel: trimmedUrl,
          }
        }

        const resp = await fetch(`${WORKER_URL}/api/desktop-prepare`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify(body),
        })
        const data = await resp.json().catch(() => ({})) as PrepareResponse
        if (!resp.ok || !data?.ok || !data.video?.id) {
          throw new Error(String(data?.error || `โหลดวิดีโอไม่สำเร็จ (${resp.status})`))
        }

        if (prepareRunRef.current !== runId) return
        setPreparedVideo(data.video)
        setPreparedSourceKey(currentSourceKey)
        setSelectedFrameTime(null)
        setSelectedFrameUrl('')
      } catch (error) {
        if (prepareRunRef.current !== runId) return
        setPreparedVideo(null)
        setPreparedSourceKey('')
        setVideoDuration(0)
        setSelectedFrameTime(null)
        setSelectedFrameUrl('')
        setPrepareError(error instanceof Error ? error.message : 'โหลดวิดีโอไม่สำเร็จ')
      } finally {
        if (prepareRunRef.current === runId) {
          setPreparing(false)
        }
      }
    }, isUpload ? 0 : 700)

    return () => window.clearTimeout(timeout)
  }, [currentSourceKey, preparedSourceKey, preparedVideo?.id, sourceMode, sourceUrl, token, videoFile])

  useEffect(() => {
    setVideoDuration(0)
  }, [preparedVideo?.id])

  const handleFramePick = useCallback((timeSeconds: number) => {
    const frameUrlBase = String(preparedVideo?.frameUrlBase || '').trim()
    if (!frameUrlBase) return
    setSelectedFrameTime(timeSeconds)
    setSelectedFrameUrl(buildFrameUrl(frameUrlBase, timeSeconds))
  }, [preparedVideo?.frameUrlBase])

  const uploadSelectedCover = useCallback(async () => {
    if (!token || !preparedVideo?.id || selectedFrameTime == null) return
    const frameUrlBase = String(preparedVideo.frameUrlBase || '').trim()
    if (!frameUrlBase) return
    const frameUrl = buildFrameUrl(frameUrlBase, selectedFrameTime)
    const resp = await fetch(frameUrl, { cache: 'no-store' })
    if (!resp.ok) throw new Error(`โหลดเฟรมไม่สำเร็จ (${resp.status})`)
    const blob = await resp.blob()
    if (!blob.size) throw new Error('เฟรมที่เลือกว่างเปล่า')

    const keys = [
      `videos/${preparedVideo.id}_original_thumb.webp`,
      `_inbox_cover/${preparedVideo.id}.webp`,
    ]

    await Promise.all(keys.map(async (key) => {
      const uploadResp = await fetch(`${WORKER_URL}/api/r2-upload/${key}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/webp',
        },
        credentials: 'include',
        body: blob,
      })
      if (!uploadResp.ok) {
        throw new Error(`อัปโหลดปกไม่สำเร็จ (${uploadResp.status})`)
      }
    }))
  }, [preparedVideo?.frameUrlBase, preparedVideo?.id, selectedFrameTime, token])

  const handleSubmit = async () => {
    if (!token) {
      setSubmitError('ยังไม่ได้เข้าสู่ระบบ')
      return
    }
    if (!preparedVideo?.id) {
      setSubmitError('ยังไม่มีวิดีโอที่โหลดพร้อมเลือกปก')
      return
    }
    if (!shopeeLink.trim() || !lazadaLink.trim()) {
      setSubmitError('กรอกลิงก์ Shopee และ Lazada ให้ครบ')
      return
    }

    setSubmitting(true)
    setSubmitError('')
    setSubmitResult(null)

    try {
      if (selectedFrameTime != null) {
        await uploadSelectedCover()
      }

      const resp = await fetch(`${WORKER_URL}/api/desktop-submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          sourceMode: 'prepared',
          videoId: preparedVideo.id,
          sourceType: preparedVideo.sourceType,
          sourceLabel: preparedVideo.sourceLabel,
          shopeeLink: shopeeLink.trim(),
          lazadaLink: lazadaLink.trim(),
          manualCaption: caption.trim(),
          autoStart: true,
        }),
      })

      const data = await resp.json().catch(() => ({})) as SubmitResponse
      if (!resp.ok || !data?.ok) {
        throw new Error(String(data?.error || `ส่งงานไม่สำเร็จ (${resp.status})`))
      }

      setSubmitResult(data)
      setSourceUrl('')
      setVideoFile(null)
      setShopeeLink('')
      setLazadaLink('')
      setCaption('')
      setPreparedVideo(null)
      setPreparedSourceKey('')
      setSelectedFrameTime(null)
      setSelectedFrameUrl('')
      setVideoDuration(0)
      setPrepareError('')
      lastUploadedFileKeyRef.current = ''
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'ส่งงานไม่สำเร็จ')
    } finally {
      setSubmitting(false)
    }
  }

  const openProcessing = () => {
    const url = String(submitResult?.processing_url || '').trim()
    if (!url) return
    window.location.href = url
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
          <p className="text-sm font-medium text-slate-600">กำลังเข้าสู่ระบบผ่าน LINE</p>
        </div>
      </div>
    )
  }

  if (pendingApproval) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-3xl border border-amber-200 bg-white p-6 text-center shadow-sm">
          <p className="text-lg font-bold text-slate-900">รอการอนุมัติ</p>
          <p className="mt-2 text-sm text-slate-500">บัญชีนี้ยังรอแอดมินอนุมัติอยู่</p>
        </div>
      </div>
    )
  }

  if (authError) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-3xl border border-rose-200 bg-white p-6 text-center shadow-sm">
          <p className="text-lg font-bold text-slate-900">เข้าใช้งานไม่สำเร็จ</p>
          <p className="mt-2 text-sm text-rose-500">{authError}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#dbeafe,_#f8fafc_42%,_#f8fafc)] px-4 py-6 text-slate-900">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 lg:grid lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="rounded-[28px] border border-white/70 bg-white/90 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur">
          <div className="flex items-center gap-3">
            <img
              src={String(me?.line_picture_url || '').trim() || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 80%22%3E%3Crect width=%2280%22 height=%2280%22 rx=%2240%22 fill=%22%23e2e8f0%22/%3E%3C/svg%3E'}
              alt={displayName || 'profile'}
              className="h-14 w-14 rounded-full object-cover"
            />
            <div className="min-w-0">
              <p className="truncate text-lg font-black">{displayName || 'LINE User'}</p>
              <p className="text-xs font-medium text-blue-600">{me?.is_team_member ? 'Team' : me?.is_owner ? 'Member' : 'User'}</p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Namespace</p>
            <p className="mt-1 break-all text-sm font-semibold text-slate-900">{namespaceId || '-'}</p>
          </div>

          <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Flow</p>
            <p className="mt-1 text-sm text-slate-600">วาง XHS หรือเลือกไฟล์ แล้วระบบจะโหลดวิดีโอทันที จากนั้นเลือกเฟรมปกในหน้าเดียวก่อนส่งเข้าประมวลผล</p>
          </div>

          {preparedVideo?.id ? (
            <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-600">พร้อมเลือกปก</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">Video ID: {preparedVideo.id}</p>
            </div>
          ) : null}
        </aside>

        <main className="rounded-[32px] border border-white/70 bg-white/95 p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur lg:p-7">
          <div className="mb-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-blue-500">Desktop Submit</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">โหลดวิดีโอแล้วเลือกปกในหน้าเดียว</h1>
            <p className="mt-2 text-sm text-slate-500">วางลิงก์ XHS หรือเลือกไฟล์จากคอม ระบบจะโหลดวิดีโอให้ทันที แล้วขึ้นเฟรมให้เลือกปกก่อนส่งประมวลผล</p>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
            <section className="space-y-4">
              <div className="rounded-3xl border border-slate-200 p-4">
                <p className="text-sm font-bold text-slate-900">แหล่งวิดีโอ</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSourceMode('upload')
                      resetPreparedState()
                      lastUploadedFileKeyRef.current = ''
                      setSourceUrl('')
                    }}
                    className={`rounded-2xl px-4 py-3 text-sm font-bold transition ${sourceMode === 'upload' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}
                  >
                    อัปโหลดไฟล์
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSourceMode('url')
                      resetPreparedState()
                      lastUploadedFileKeyRef.current = ''
                      setVideoFile(null)
                    }}
                    className={`rounded-2xl px-4 py-3 text-sm font-bold transition ${sourceMode === 'url' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`}
                  >
                    วางลิงก์ XHS
                  </button>
                </div>

                {sourceMode === 'upload' ? (
                  <label className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center transition hover:border-blue-400 hover:bg-blue-50/40">
                    <input
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(event) => {
                        resetPreparedState()
                        lastUploadedFileKeyRef.current = ''
                        setVideoFile(event.target.files?.[0] || null)
                      }}
                    />
                    <span className="text-sm font-bold text-slate-700">{videoFile ? videoFile.name : 'เลือกไฟล์วิดีโอจากคอม'}</span>
                    <span className="mt-1 text-xs text-slate-400">เลือกรอบเดียวแล้วระบบจะเริ่มโหลดให้ทันที</span>
                  </label>
                ) : (
                  <div className="mt-4">
                    <input
                      value={sourceUrl}
                      onChange={(event) => {
                        resetPreparedState()
                        setSourceUrl(event.target.value)
                      }}
                      placeholder="วางลิงก์ XHS หรือ direct video URL"
                      className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-blue-400"
                    />
                    <p className="mt-2 text-xs text-slate-400">พอวางลิงก์ครบ ระบบจะโหลดวิดีโอให้อัตโนมัติ</p>
                  </div>
                )}

                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  {preparing
                    ? 'กำลังโหลดวิดีโอและสร้างเฟรมให้เลือก...'
                    : preparedVideo?.id
                      ? 'โหลดวิดีโอพร้อมแล้ว เลือกเฟรมปกด้านขวาได้เลย'
                      : 'ยังไม่มีวิดีโอที่โหลดพร้อม'}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 p-4">
                <p className="text-sm font-bold text-slate-900">ลิงก์สินค้า</p>
                <div className="mt-3 space-y-3">
                  <input
                    value={shopeeLink}
                    onChange={(event) => setShopeeLink(event.target.value)}
                    placeholder="ลิงก์ Shopee"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-orange-400"
                  />
                  <input
                    value={lazadaLink}
                    onChange={(event) => setLazadaLink(event.target.value)}
                    placeholder="ลิงก์ Lazada"
                    className="w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-bold text-slate-900">แคปชั่น</p>
                  <p className="text-xs text-slate-400">ไม่กรอก = ให้ AI คิดให้</p>
                </div>
                <textarea
                  value={caption}
                  onChange={(event) => setCaption(event.target.value.slice(0, 1200))}
                  rows={8}
                  placeholder="ใส่แคปชั่นเองได้ตรงนี้"
                  className="mt-3 w-full resize-none rounded-3xl border border-slate-200 px-4 py-4 text-sm outline-none transition focus:border-violet-400"
                />
              </div>
            </section>

            <section className="space-y-4">
              <div className="rounded-3xl border border-slate-200 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-slate-900">เลือกปกจากเฟรมวิดีโอ</p>
                    <p className="mt-1 text-xs text-slate-400">ระบบจะโหลดวิดีโอก่อน แล้วขึ้นเฟรมให้เลือกได้ทันที</p>
                  </div>
                  {videoDuration > 0 ? (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                      {formatSecondsLabel(videoDuration)}
                    </span>
                  ) : null}
                </div>

                <div className="mt-4 flex min-h-[420px] items-center justify-center rounded-[28px] border border-slate-200 bg-slate-50 p-4">
                  {activePreviewUrl ? (
                    <img
                      src={activePreviewUrl}
                      alt="selected cover"
                      className="h-full max-h-[620px] w-auto max-w-full rounded-[24px] object-contain shadow-[0_18px_50px_rgba(15,23,42,0.12)]"
                    />
                  ) : (
                    <div className="text-center">
                      <div className="mx-auto mb-3 h-12 w-12 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                      <p className="text-sm font-semibold text-slate-700">{preparing ? 'กำลังโหลดวิดีโอ...' : 'รอโหลดวิดีโอ'}</p>
                    </div>
                  )}
                </div>

                <video
                  ref={hiddenVideoRef}
                  key={preparedVideo?.id || 'empty'}
                  src={preparedVideo?.originalUrl || ''}
                  className="hidden"
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    const duration = Number(event.currentTarget.duration || 0)
                    setVideoDuration(Number.isFinite(duration) ? duration : 0)
                  }}
                />

                {preparedVideo?.frameUrlBase && frameTimes.length ? (
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                    {frameTimes.map((timeSeconds) => {
                      const frameUrl = buildFrameUrl(preparedVideo.frameUrlBase || '', timeSeconds)
                      const isSelected = selectedFrameTime != null && Math.abs(selectedFrameTime - timeSeconds) < 0.01
                      return (
                        <button
                          key={`${preparedVideo.id}-${timeSeconds.toFixed(2)}`}
                          type="button"
                          onClick={() => handleFramePick(timeSeconds)}
                          className={`overflow-hidden rounded-[24px] border text-left transition ${isSelected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-300'}`}
                        >
                          <img
                            src={frameUrl}
                            alt={`frame ${timeSeconds.toFixed(1)}s`}
                            className="aspect-[9/16] w-full object-cover"
                          />
                          <div className={`px-3 py-2 text-xs font-bold ${isSelected ? 'bg-blue-50 text-blue-700' : 'bg-white text-slate-600'}`}>
                            {formatSecondsLabel(timeSeconds)}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                ) : null}

                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  {selectedFrameTime == null
                    ? 'ยังไม่ได้เลือกเฟรมเอง ระบบจะใช้ปกอัตโนมัติถ้ากดส่งเลย'
                    : `เลือกเฟรมแล้วที่ ${formatSecondsLabel(selectedFrameTime)}`}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-bold text-slate-900">ผลลัพธ์</p>
                {submitResult ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                      <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-600">ส่งงานสำเร็จ</p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">Video ID: {String(submitResult.video?.id || '-')}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={openProcessing}
                        className="rounded-2xl bg-blue-600 px-4 py-3 text-sm font-bold text-white"
                      >
                        เปิดหน้าประมวลผล
                      </button>
                      {submitResult.gallery_url ? (
                        <a
                          href={submitResult.gallery_url}
                          className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-bold text-white"
                        >
                          เปิดแกลลี่
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-slate-500">ยังไม่มีงานที่เพิ่งส่ง</p>
                )}
              </div>
            </section>
          </div>

          {prepareError ? (
            <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-600">
              {prepareError}
            </div>
          ) : null}

          {submitError ? (
            <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-600">
              {submitError}
            </div>
          ) : null}

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              disabled={submitting || preparing || !preparedVideo?.id}
              onClick={handleSubmit}
              className={`rounded-3xl px-8 py-4 text-sm font-black text-white transition ${submitting || preparing || !preparedVideo?.id ? 'bg-slate-300' : 'bg-blue-600 hover:bg-blue-700'}`}
            >
              {submitting ? 'กำลังส่งงาน...' : 'ส่งงานและเริ่มประมวลผล'}
            </button>
          </div>
        </main>
      </div>
    </div>
  )
}

declare global {
  interface Window {
    liff: any
  }
}
