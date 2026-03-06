import { useState, useEffect, useCallback, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import { type Update, check } from '@tauri-apps/plugin-updater'
import { CreateProfileModal } from './components/CreateProfileModal'
import { LogViewer } from './components/LogViewer'
import { DebugConsole } from './components/DebugConsole'
import './index.css'

// Server URL (fallback for web mode)
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev'

// Browserless defaults
const DEFAULT_BROWSERLESS_URL = 'http://localhost:3333'
const DEFAULT_BROWSERLESS_TOKEN = 'browserless_token'
const PROFILE_TAG_OPTIONS = ['post', 'comment', 'mobile'] as const

const normalizeProfileTag = (value: string) => value.trim().toLowerCase()
const normalizeProfileName = (value: string) => value.trim().toLowerCase()
const normalizeProfileTags = (tags: string[] = []) => {
  const unique = new Set<string>()
  tags.forEach((tag) => {
    const normalized = normalizeProfileTag(tag)
    if (normalized) unique.add(normalized)
  })
  return Array.from(unique)
}


// Helper to get full avatar URL
const getAvatarUrl = (avatarUrl?: string) => {
  if (!avatarUrl) return null
  if (avatarUrl.startsWith('http')) return avatarUrl
  return `${SERVER_URL}${avatarUrl}`
}

interface Profile {
  id: string
  name: string
  proxy: string
  homepage: string
  notes: string
  tags: string[]
  avatar_url?: string
  totp_secret?: string
  uid?: string
  username?: string
  password?: string
  datr?: string
  access_token?: string
  facebook_token?: string
  page_name?: string
  page_avatar_url?: string
}

// TOTP Generator
function generateTOTP(secret: string): string {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const cleanSecret = secret.replace(/\s/g, '').toUpperCase()

  // Base32 decode
  let bits = ''
  for (const char of cleanSecret) {
    const val = base32Chars.indexOf(char)
    if (val >= 0) bits += val.toString(2).padStart(5, '0')
  }
  const keyBytes = new Uint8Array(Math.floor(bits.length / 8))
  for (let i = 0; i < keyBytes.length; i++) {
    keyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  }

  // Time counter (30 second intervals)
  const time = Math.floor(Date.now() / 1000 / 30)
  const timeBytes = new Uint8Array(8)
  let t = time
  for (let i = 7; i >= 0; i--) {
    timeBytes[i] = t & 0xff
    t = Math.floor(t / 256)
  }

  // HMAC-SHA1 (simplified - using Web Crypto would be better but this works)
  const hmac = hmacSha1(keyBytes, timeBytes)

  // Dynamic truncation
  const offset = hmac[hmac.length - 1] & 0x0f
  const code = ((hmac[offset] & 0x7f) << 24 |
    (hmac[offset + 1] & 0xff) << 16 |
    (hmac[offset + 2] & 0xff) << 8 |
    (hmac[offset + 3] & 0xff)) % 1000000

  return code.toString().padStart(6, '0')
}

// Simple HMAC-SHA1 implementation
function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64
  let keyBlock = new Uint8Array(blockSize)

  if (key.length > blockSize) {
    key = sha1(key)
  }
  keyBlock.set(key)

  const iPad = new Uint8Array(blockSize)
  const oPad = new Uint8Array(blockSize)
  for (let i = 0; i < blockSize; i++) {
    iPad[i] = keyBlock[i] ^ 0x36
    oPad[i] = keyBlock[i] ^ 0x5c
  }

  const inner = new Uint8Array(blockSize + message.length)
  inner.set(iPad)
  inner.set(message, blockSize)

  const outer = new Uint8Array(blockSize + 20)
  outer.set(oPad)
  outer.set(sha1(inner), blockSize)

  return sha1(outer)
}

// SHA1 implementation
function sha1(data: Uint8Array): Uint8Array {
  const H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]
  const K = [0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xCA62C1D6]

  const ml = data.length * 8
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 4, ml, false)

  for (let i = 0; i < padded.length; i += 64) {
    const W = new Uint32Array(80)
    for (let t = 0; t < 16; t++) {
      W[t] = view.getUint32(i + t * 4, false)
    }
    for (let t = 16; t < 80; t++) {
      W[t] = rotl(W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16], 1)
    }

    let [a, b, c, d, e] = H
    for (let t = 0; t < 80; t++) {
      let f: number, k: number
      if (t < 20) { f = (b & c) | (~b & d); k = K[0] }
      else if (t < 40) { f = b ^ c ^ d; k = K[1] }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = K[2] }
      else { f = b ^ c ^ d; k = K[3] }

      const temp = (rotl(a, 5) + f + e + k + W[t]) >>> 0
      e = d; d = c; c = rotl(b, 30); b = a; a = temp
    }
    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
  }

  const result = new Uint8Array(20)
  const rv = new DataView(result.buffer)
  H.forEach((h, i) => rv.setUint32(i * 4, h, false))
  return result
}

function rotl(n: number, s: number): number {
  return ((n << s) | (n >>> (32 - s))) >>> 0
}

// Check if running in Tauri
const isTauri = () => {
  return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
}

const AUTH_SESSION_STORAGE_KEY = 'browsersaving_auth_session'

type AuthSession = {
  token: string
  email: string
}

type AppUpdateState = {
  checking: boolean
  installing: boolean
  availableVersion: string
  availableNotes: string
  lastCheckedAt: string
  message: string
  error: string
}

const normalizeAuthEmail = (raw: unknown) => String(raw || '').trim().toLowerCase()

function getStoredAuthSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const token = String(parsed?.token || '').trim()
    const email = normalizeAuthEmail(parsed?.email || '')
    if (!token || !email) return null
    return { token, email }
  } catch {
    return null
  }
}

function storeAuthSession(session: AuthSession) {
  localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify({
    token: String(session.token || '').trim(),
    email: normalizeAuthEmail(session.email),
  }))
}

function clearStoredAuthSession() {
  localStorage.removeItem(AUTH_SESSION_STORAGE_KEY)
}

function createWorkerHeaders(headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit || {})
  const session = getStoredAuthSession()
  if (session?.token) headers.set('x-auth-token', session.token)
  return headers
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text()
  if (!text) return `HTTP ${response.status}`
  try {
    const parsed = JSON.parse(text)
    const message = String(parsed?.error || parsed?.details || text).trim()
    return message || `HTTP ${response.status}`
  } catch {
    return text.substring(0, 500)
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = createWorkerHeaders(init.headers)
  const body = init.body
  if (body && !(body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${SERVER_URL}${path}`, { ...init, headers })
}

async function loginWithEmailPassword(email: string, password: string): Promise<AuthSession> {
  const normalizedEmail = normalizeAuthEmail(email)
  const res = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizedEmail, password }),
  })
  if (!res.ok) {
    throw new Error(await readApiError(res))
  }
  const data = await res.json()
  const token = String(data?.session_token || '').trim()
  if (!token) throw new Error('Missing session token')
  return { token, email: normalizeAuthEmail(data?.email || normalizedEmail) }
}

async function fetchCurrentSessionMe(): Promise<{ email: string }> {
  const res = await apiFetch('/api/me')
  if (!res.ok) throw new Error(await readApiError(res))
  const data = await res.json()
  const email = normalizeAuthEmail(data?.email || '')
  if (!email) throw new Error('Missing email')
  return { email }
}

async function logoutCurrentSession(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' })
}

// API Functions - use Tauri invoke or fallback to HTTP
async function getProfiles(): Promise<Profile[]> {
  // Always use Worker API for consistent data (includes uid)
  const res = await apiFetch('/api/profiles')
  if (!res.ok) {
    throw new Error(await readApiError(res))
  }
  return res.json()
}

async function createProfile(data: Partial<Profile>): Promise<Profile> {
  console.log('📡 createProfile called, isTauri:', isTauri())
  // Always use fetch for now (bypass Tauri invoke to debug)
  const res = await apiFetch('/api/profiles', {
    method: 'POST',
    body: JSON.stringify(data)
  })
  const result = await res.json()
  if (!res.ok) {
    throw new Error(result?.error || 'Failed to create profile')
  }
  return result
}

async function updateProfile(id: string, data: Partial<Profile>): Promise<Profile> {
  console.log('📡 updateProfile called:', { id, uid: data.uid, username: data.username })
  console.log('📡 Full data:', JSON.stringify(data, null, 2))
  // Always use fetch for now (bypass Tauri invoke to debug)
  const res = await apiFetch(`/api/profiles/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  })
  console.log('📡 Response status:', res.status, res.statusText)
  const text = await res.text()
  console.log('📡 Raw response:', text.substring(0, 500))
  try {
    const result = JSON.parse(text)
    console.log('📡 API Response:', JSON.stringify(result, null, 2))
    return result
  } catch (e) {
    console.error('📡 Failed to parse JSON:', e)
    console.error('📡 Response was:', text)
    throw new Error('Server returned invalid JSON: ' + text.substring(0, 100))
  }
}

async function deleteProfile(id: string): Promise<boolean> {
  if (isTauri()) {
    return invoke('delete_profile', { id })
  }
  const res = await apiFetch(`/api/profiles/${id}`, { method: 'DELETE' })
  return res.ok
}

async function fetchPageInfo(
  profileId: string,
  _preferRole?: 'post' | 'comment'
): Promise<{ page_name?: string; page_avatar_url?: string } | null> {
  try {
    const res = await apiFetch(`/api/profiles/${profileId}/page`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

async function launchBrowser(profile: Profile): Promise<{ success: boolean; error?: string }> {
  try {
    await invoke('launch_browser', { profile })
    return { success: true }
  } catch (e) {
    if (isTauri()) {
      return { success: false, error: String(e) }
    }
  }

  // Web mode - use custom URL scheme to trigger desktop app
  window.location.href = `browsersaving://launch/${profile.id}`
  return { success: true }
}

async function launchBrowserWithUrl(profile: Profile, url: string): Promise<{ success: boolean; error?: string }> {
  try {
    await invoke('launch_browser_with_url', { profile, url })
    return { success: true }
  } catch (e) {
    if (isTauri()) {
      return { success: false, error: String(e) }
    }
  }

  return { success: false, error: 'Requires desktop app' }
}

async function launchAndroidEmulator(profile: Profile): Promise<{ success: boolean; avd?: string; error?: string }> {
  try {
    const avd = await invoke<string>('launch_android_emulator', { profile })
    return { success: true, avd }
  } catch (e) {
    if (!isTauri()) {
      return { success: false, error: 'Requires desktop app' }
    }
    return { success: false, error: String(e) }
  }
}

async function stopBrowser(profileId: string): Promise<{ success: boolean; error?: string }> {
  try {
    await invoke('stop_browser', { profileId })
    return { success: true }
  } catch {
    if (isTauri()) {
      return { success: false, error: 'Failed to stop browser' }
    }
  }

  // Web mode - use custom URL scheme
  window.location.href = `browsersaving://stop/${profileId}`
  return { success: true }
}

interface BrowserStatus {
  running: string[]
  uploading: string[]
  android_running: string[]
  android_uploading: string[]
}

async function getBrowserStatus(): Promise<BrowserStatus> {
  try {
    return invoke('get_browser_status')
  } catch {
    if (isTauri()) {
      return { running: [], uploading: [], android_running: [], android_uploading: [] }
    }
  }

  try {
    const res = await fetch(`http://localhost:4000/api/status`)
    const data = await res.json()
    return {
      running: data.running || [],
      uploading: data.uploading || [],
      android_running: data.android_running || [],
      android_uploading: data.android_uploading || [],
    }
  } catch {
    return { running: [], uploading: [], android_running: [], android_uploading: [] }
  }
}

export type { Profile }

function App() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(() => getStoredAuthSession())
  const [authChecking, setAuthChecking] = useState(() => !!getStoredAuthSession())
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')
  const [loginEmail, setLoginEmail] = useState(() => normalizeAuthEmail(getStoredAuthSession()?.email || ''))
  const [loginPassword, setLoginPassword] = useState('')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [launchingIds, setLaunchingIds] = useState<Set<string>>(new Set())
  const [launchingAndroidIds, setLaunchingAndroidIds] = useState<Set<string>>(new Set())
  const [uploadingIds, setUploadingIds] = useState<Set<string>>(new Set())
  const [runningAndroidIds, setRunningAndroidIds] = useState<Set<string>>(new Set())
  const [uploadingAndroidIds, setUploadingAndroidIds] = useState<Set<string>>(new Set())
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null)
  const [viewingLogs, setViewingLogs] = useState<string | null>(null)
  const [serverConnected, setServerConnected] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deletingProfile, setDeletingProfile] = useState<Profile | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [credentialsProfile, setCredentialsProfile] = useState<Profile | null>(null)
  const [tokenResult, setTokenResult] = useState<{
    profileId: string
    profileName: string
    token: string
  } | null>(null)
  const [fetchingToken, setFetchingToken] = useState<Set<string>>(new Set())
  const [copiedProfileId, setCopiedProfileId] = useState<string | null>(null)
  const [credentialsTotpCode, setCredentialsTotpCode] = useState('')
  const [credentialsTotpCountdown, setCredentialsTotpCountdown] = useState(30)
  const [debugProfile, setDebugProfile] = useState<Profile | null>(null)
  const [debuggingIds, setDebuggingIds] = useState<Set<string>>(new Set())
  const [currentPage, setCurrentPage] = useState<'profiles' | 'proxy' | 'settings' | 'debug'>('profiles')
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode')
    return saved ? JSON.parse(saved) : window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const [selectedPage, setSelectedPage] = useState<string>('all')
  const [profileSearch, setProfileSearch] = useState('')
  const [uiScale, setUiScale] = useState(() => {
    const saved = localStorage.getItem('uiScale')
    return saved ? parseFloat(saved) : 1.0
  })
  const [tagPickerProfileId, setTagPickerProfileId] = useState<string | null>(null)
  const [savingTagIds, setSavingTagIds] = useState<Set<string>>(new Set())
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>({
    checking: false,
    installing: false,
    availableVersion: '',
    availableNotes: '',
    lastCheckedAt: '',
    message: 'ยังไม่เช็คอัปเดต',
    error: '',
  })

  // Browserless state
  const [browserlessUrl, setBrowserlessUrl] = useState(() => {
    return localStorage.getItem('browserlessUrl') || DEFAULT_BROWSERLESS_URL
  })
  const [browserlessToken, setBrowserlessToken] = useState(() => {
    return localStorage.getItem('browserlessToken') || DEFAULT_BROWSERLESS_TOKEN
  })
  const [browserlessConnected, setBrowserlessConnected] = useState(false)

  const getAccessToken = (profile: Profile) => (profile.access_token || '').trim()
  const hasAccessToken = (profile: Profile) => getAccessToken(profile).length > 0
  const hasAnyFacebookToken = (profile: Profile) => (
    getAccessToken(profile).length > 0 ||
    (profile.facebook_token || '').trim().length > 0
  )

  const installUpdateNow = useCallback(async (update: Update) => {
    setAppUpdateState(prev => ({
      ...prev,
      installing: true,
      error: '',
      message: `กำลังติดตั้งเวอร์ชัน ${update.version}...`,
    }))

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Progress') {
          const downloadedBytes = event.data.chunkLength || 0
          if (downloadedBytes > 0) {
            setAppUpdateState(prev => ({
              ...prev,
              message: `กำลังดาวน์โหลดอัปเดตเวอร์ชัน ${update.version}...`,
            }))
          }
        }
      }, { timeout: 180000 })
      setAppUpdateState(prev => ({
        ...prev,
        installing: false,
        message: `ติดตั้งสำเร็จเวอร์ชัน ${update.version} กำลังรีสตาร์ต...`,
      }))
      await relaunch()
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      setAppUpdateState(prev => ({
        ...prev,
        installing: false,
        error: message,
        message: `ติดตั้งอัปเดตไม่สำเร็จ: ${message}`,
      }))
      throw err
    }
  }, [])

  const checkForAppUpdate = useCallback(async (mode: 'silent' | 'ask' | 'install-only' = 'silent') => {
    if (!isTauri()) {
      setAppUpdateState(prev => ({
        ...prev,
        message: 'OTA อัปเดตทำงานเฉพาะแอป Desktop',
        availableVersion: '',
        availableNotes: '',
      }))
      return null
    }

    setAppUpdateState(prev => ({
      ...prev,
      checking: true,
      error: '',
      message: 'กำลังตรวจสอบอัปเดต...',
    }))

    try {
      const update = await check({ timeout: 30000 })
      if (!update) {
        setAppUpdateState(prev => ({
          ...prev,
          checking: false,
          availableVersion: '',
          availableNotes: '',
          lastCheckedAt: new Date().toLocaleString(),
          message: 'แอปเป็นเวอร์ชันล่าสุด',
        }))
        if (mode === 'ask') {
          alert('ระบบไม่พบอัปเดตใหม่')
        }
        return null
      }

      const updateNotes = update.body || ''
      const now = new Date().toLocaleString()
      setAppUpdateState(prev => ({
        ...prev,
        checking: false,
        availableVersion: update.version,
        availableNotes: updateNotes,
        lastCheckedAt: now,
        message: `พบอัปเดตใหม่: ${update.version}`,
      }))

      if (mode === 'install-only') {
        await installUpdateNow(update)
        return update
      }

      if (mode === 'ask') {
        const shouldInstall = window.confirm(
          `พบอัปเดตเวอร์ชัน ${update.version}\n\n${updateNotes || 'มีการอัปเดตใหม่'}\n\nต้องการติดตั้งตอนนี้?`
        )
        if (shouldInstall) {
          await installUpdateNow(update)
        }
      }

      return update
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      setAppUpdateState(prev => ({
        ...prev,
        checking: false,
        installing: false,
        availableVersion: '',
        availableNotes: '',
        message: 'ตรวจสอบอัปเดตไม่สำเร็จ',
        error: message,
      }))
      if (mode === 'ask') {
        alert(`ตรวจสอบอัปเดตไม่สำเร็จ: ${message}`)
      }
      return null
    }
  }, [installUpdateNow])

  useEffect(() => {
    let active = true
    const bootstrap = async () => {
      const existing = getStoredAuthSession()
      if (!existing?.token) {
        if (active) {
          setAuthSession(null)
          setAuthChecking(false)
        }
        return
      }

      try {
        const me = await fetchCurrentSessionMe()
        if (!active) return
        const nextSession = { token: existing.token, email: me.email }
        storeAuthSession(nextSession)
        setAuthSession(nextSession)
      } catch {
        if (!active) return
        clearStoredAuthSession()
        setAuthSession(null)
      } finally {
        if (active) setAuthChecking(false)
      }
    }

    void bootstrap()
    return () => { active = false }
  }, [])

  // Apply dark mode
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
    localStorage.setItem('darkMode', JSON.stringify(darkMode))
  }, [darkMode])

  // Apply UI scale (base is 1.1, so 100% display = 1.1 actual zoom)
  useEffect(() => {
    const actualZoom = uiScale * 1.1
    document.body.style.zoom = actualZoom.toString()
    localStorage.setItem('uiScale', uiScale.toString())
  }, [uiScale])

  // Persist Browserless settings
  useEffect(() => {
    localStorage.setItem('browserlessUrl', browserlessUrl)
  }, [browserlessUrl])

  useEffect(() => {
    localStorage.setItem('browserlessToken', browserlessToken)
  }, [browserlessToken])

  // Check Browserless connectivity
  const checkBrowserless = useCallback(async () => {
    const trimmedUrl = browserlessUrl.trim()
    if (!trimmedUrl) {
      setBrowserlessConnected(false)
      return
    }

    try {
      const res = await fetch(`${trimmedUrl}/config?token=${browserlessToken}`, { signal: AbortSignal.timeout(3000) })
      setBrowserlessConnected(res.ok)
    } catch {
      setBrowserlessConnected(false)
    }
  }, [browserlessUrl, browserlessToken])

  useEffect(() => {
    if (!tagPickerProfileId) return

    const closePicker = () => setTagPickerProfileId(null)
    window.addEventListener('click', closePicker)
    return () => window.removeEventListener('click', closePicker)
  }, [tagPickerProfileId])



  useEffect(() => {
    if (!isTauri()) return
    const timer = setTimeout(() => {
      void checkForAppUpdate('ask')
    }, 1800)
    return () => clearTimeout(timer)
  }, [checkForAppUpdate])

  const loadProfiles = useCallback(async () => {
    if (!authSession?.token) {
      setProfiles([])
      setServerConnected(false)
      return
    }
    try {
      const data = await getProfiles()
      setProfiles(data)
      setServerConnected(true)
    } catch (err) {
      const message = String(err || '')
      if (message.toLowerCase().includes('unauthorized')) {
        clearStoredAuthSession()
        setAuthSession(null)
        setAuthError('Session expired. Please login again.')
      }
      setServerConnected(false)
    }
  }, [authSession?.token])

  const handleLoginSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (authLoading) return

    const email = normalizeAuthEmail(loginEmail)
    const password = String(loginPassword || '')
    if (!email || !password) {
      setAuthError('Please enter email and password')
      return
    }

    setAuthLoading(true)
    setAuthError('')
    try {
      const session = await loginWithEmailPassword(email, password)
      storeAuthSession(session)
      setAuthSession(session)
      setLoginPassword('')
      setServerConnected(true)
    } catch (err) {
      setAuthError(String(err || 'Login failed'))
    } finally {
      setAuthLoading(false)
      setAuthChecking(false)
    }
  }, [authLoading, loginEmail, loginPassword])

  const handleLogout = useCallback(async () => {
    try {
      await logoutCurrentSession()
    } catch (err) {
      console.log('Logout request failed:', err)
    } finally {
      clearStoredAuthSession()
      setAuthSession(null)
      setProfiles([])
      setSelectedIds(new Set())
      setAuthError('')
      setCurrentPage('profiles')
    }
  }, [])

  const handleManualUpdateCheck = async () => {
    await checkForAppUpdate('ask')
  }

  const handleManualUpdateInstall = async () => {
    await checkForAppUpdate('install-only')
  }

  // Fetch page info on demand and update profile
  const fetchPageForProfile = async (profile: Profile, preferRole?: 'post' | 'comment') => {
    console.log(`🖱️ Clicked on page column for: ${profile.name}`)
    if (!hasAnyFacebookToken(profile)) {
      console.log('No token available for page fetch')
      return
    }

    try {
      console.log(`Fetching page info for ${profile.name}...`, { preferRole: preferRole || 'auto' })
      const pageInfo = await fetchPageInfo(profile.id, preferRole)
      console.log('Page info received:', pageInfo)
      if (pageInfo?.page_name) {
        console.log(`Updating profile ${profile.name} with page: ${pageInfo.page_name}`)
        // Update profile in state
        setProfiles(prevProfiles => {
          const newProfiles = prevProfiles.map(p =>
            p.id === profile.id
              ? { ...p, page_name: pageInfo.page_name, page_avatar_url: pageInfo.page_avatar_url }
              : p
          )
          console.log('Profiles updated:', newProfiles.find(p => p.id === profile.id))
          return newProfiles
        })
      }
    } catch (e) {
      console.log(`Failed to fetch page for ${profile.name}:`, e)
    }
  }

  const checkStatus = useCallback(async () => {
    try {
      const status = await getBrowserStatus()
      setRunningIds(new Set(status.running))
      setUploadingIds(new Set(status.uploading))
      setRunningAndroidIds(new Set(status.android_running || []))
      setUploadingAndroidIds(new Set(status.android_uploading || []))
    } catch {
      // Silent fail for status check
    }
  }, [])

  useEffect(() => {
    if (authChecking || !authSession?.token) {
      setProfiles([])
      return
    }

    loadProfiles()
    checkStatus()
    const interval = setInterval(checkStatus, 2000)
    return () => clearInterval(interval)
  }, [authChecking, authSession?.token, loadProfiles, checkStatus])

  const handleCreateProfile = async (data: Partial<Profile>, avatarFile?: File) => {
    console.log('🔧 handleCreateProfile START')
    console.log('🔧 data:', JSON.stringify(data, null, 2))

    const profileName = (data.name || '').trim()
    if (!profileName) return

    const isDuplicateName = profiles.some((profile) => normalizeProfileName(profile.name) === normalizeProfileName(profileName))
    if (isDuplicateName) {
      alert('โปรไฟล์ซ้ำในระบบ')
      return
    }

    try {
      const newProfile = await createProfile({ ...data, name: profileName })
      console.log('🔧 createProfile result:', newProfile)

      // Upload avatar if provided
      if (avatarFile && newProfile?.id) {
        try {
          const formData = new FormData()
          formData.append('avatar', avatarFile)
          await apiFetch(`/api/avatar/${newProfile.id}`, {
            method: 'POST',
            body: formData
          })
        } catch (err) {
          console.error('Avatar upload failed:', err)
        }
      }
      await loadProfiles()
      setShowCreateModal(false)
    } catch (err) {
      console.error('🔧 createProfile ERROR:', err)
      const message = err instanceof Error ? err.message : 'สร้างโปรไฟล์ไม่สำเร็จ'
      alert(message)
    }
  }

  const handleUpdateProfile = async (data: Partial<Profile>, avatarFile?: File) => {
    console.log('🔧 handleUpdateProfile START')
    console.log('🔧 editingProfile:', editingProfile)
    if (!editingProfile) {
      console.log('🔧 No editingProfile, returning')
      return
    }
    console.log('🔧 handleUpdateProfile received:', JSON.stringify(data, null, 2))
    console.log('🔧 totp_secret value:', data.totp_secret, typeof data.totp_secret)
    try {
      const result = await updateProfile(editingProfile.id, data)
      console.log('🔧 updateProfile result:', result)
    } catch (err) {
      console.error('🔧 updateProfile ERROR:', err)
    }
    await loadProfiles()
    setEditingProfile(null)
  }

  const handleDeleteClick = (profile: Profile) => {
    setDeletingProfile(profile)
  }

  const handleDeleteConfirm = async () => {
    if (!deletingProfile) return

    const profileId = deletingProfile.id
    setDeletingIds(prev => new Set(prev).add(profileId))
    setDeletingProfile(null)

    try {
      const success = await deleteProfile(profileId)
      if (success) {
        await loadProfiles()
      }
    } catch (e) {
      console.error('Delete failed:', e)
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev)
        next.delete(profileId)
        return next
      })
    }
  }

  useEffect(() => {
    if (!credentialsProfile?.totp_secret) {
      setCredentialsTotpCode('')
      setCredentialsTotpCountdown(30)
      return
    }

    const refresh = () => {
      const nextCode = generateTOTP(credentialsProfile.totp_secret!)
      const remainingSeconds = 30 - (Math.floor(Date.now() / 1000) % 30)
      setCredentialsTotpCode(nextCode)
      setCredentialsTotpCountdown(remainingSeconds)
    }

    refresh()
    const interval = setInterval(() => {
      refresh()
    }, 1000)

    return () => clearInterval(interval)
  }, [credentialsProfile])

  const copyCredentials = (profile: Profile) => {
    const text = `${profile.username || ''}\n${profile.password || ''}`
    navigator.clipboard.writeText(text)
  }

  const handleCopyProfileId = async (profile: Profile) => {
    try {
      await navigator.clipboard.writeText(profile.id)
      setCopiedProfileId(profile.id)
      window.setTimeout(() => {
        setCopiedProfileId((current) => (current === profile.id ? null : current))
      }, 1800)
    } catch (err) {
      console.error('Copy profile id failed:', err)
      alert('Failed to copy Profile ID')
    }
  }

  const handleAddTagToProfile = async (profile: Profile, tag: string) => {
    const normalizedTag = normalizeProfileTag(tag)
    if (!PROFILE_TAG_OPTIONS.includes(normalizedTag as typeof PROFILE_TAG_OPTIONS[number])) return

    const currentTags = normalizeProfileTags(profile.tags || [])
    if (currentTags.includes(normalizedTag)) {
      setTagPickerProfileId(null)
      return
    }

    let nextTags = [...currentTags, normalizedTag]
    setSavingTagIds(prev => new Set(prev).add(profile.id))
    try {
      const updated = await updateProfile(profile.id, { tags: nextTags })
      setProfiles(prev => prev.map(p => (
        p.id === profile.id
          ? { ...p, ...updated, tags: Array.isArray(updated.tags) ? updated.tags : nextTags }
          : p
      )))
      setTagPickerProfileId(null)
    } catch (err) {
      console.error('Failed to add profile tag:', err)
      alert('Failed to add tag: ' + err)
    } finally {
      setSavingTagIds(prev => {
        const next = new Set(prev)
        next.delete(profile.id)
        return next
      })
    }
  }

  const handleRemoveTagFromProfile = async (profile: Profile, tag: string) => {
    const normalizedTag = normalizeProfileTag(tag)
    const currentTags = normalizeProfileTags(profile.tags || [])
    const nextTags = currentTags.filter(t => t !== normalizedTag)

    setSavingTagIds(prev => new Set(prev).add(profile.id))
    try {
      const updated = await updateProfile(profile.id, { tags: nextTags })
      setProfiles(prev => prev.map(p => (
        p.id === profile.id
          ? { ...p, ...updated, tags: Array.isArray(updated.tags) ? updated.tags : nextTags }
          : p
      )))
    } catch (err) {
      console.error('Failed to remove profile tag:', err)
      alert('Failed to remove tag: ' + err)
    } finally {
      setSavingTagIds(prev => {
        const next = new Set(prev)
        next.delete(profile.id)
        return next
      })
    }
  }

  // Debug mode handlers
  const handleDebugLaunch = async (profile: Profile) => {
    setLaunchingIds(prev => new Set(prev).add(profile.id))
    try {
      if (!isTauri()) {
        alert('Debug mode requires the desktop app')
        return
      }

      // Launch browser in debug mode
      await invoke('launch_browser_debug', { profile })

      // Wait for browser to start
      await new Promise(r => setTimeout(r, 2000))

      // Connect CDP directly in app
      await invoke('connect_cdp', { profileId: profile.id })

      setDebuggingIds(prev => new Set(prev).add(profile.id))
      setDebugProfile(profile)
      setCurrentPage('debug')
      await checkStatus()
    } catch (err) {
      console.error('Debug launch failed:', err)
      alert('Failed to launch debug mode: ' + err)
    } finally {
      setLaunchingIds(prev => {
        const next = new Set(prev)
        next.delete(profile.id)
        return next
      })
    }
  }

  const handleDebugClose = async (stopBrowserToo: boolean = false) => {
    if (debugProfile && isTauri()) {
      // Disconnect CDP
      await invoke('disconnect_cdp', { profileId: debugProfile.id })

      // Stop browser if requested
      if (stopBrowserToo) {
        await stopBrowser(debugProfile.id)
        setDebuggingIds(prev => {
          const next = new Set(prev)
          next.delete(debugProfile.id)
          return next
        })
        await checkStatus()
      }
    }
    setDebugProfile(null)
  }

  const handleFetchToken = async (profile: Profile) => {
    setFetchingToken(prev => new Set(prev).add(profile.id))

    try {
      const res = await apiFetch(`/api/token/${profile.id}`)
      const data = await res.json().catch(() => ({} as any))
      const token = String(
        data?.token ||
        data?.converted_token?.access_token ||
        ''
      ).trim()

      if (!res.ok || !data?.success || !token) {
        const errorMessage = data?.error || data?.detail?.error || `HTTP ${res.status}`
        throw new Error(errorMessage)
      }

      const pageNameFromToken = String(data?.page_name || '').trim()
      const pageAvatarFromToken = String(data?.page_avatar_url || '').trim()
      if (pageNameFromToken || pageAvatarFromToken) {
        setProfiles(prev => prev.map((p) => (
          p.id === profile.id
            ? {
              ...p,
              page_name: pageNameFromToken || p.page_name,
              page_avatar_url: pageAvatarFromToken || p.page_avatar_url,
            }
            : p
        )))
      }

      // Re-fetch page details from Graph using the fresh token so avatar/page stays in sync.
      await fetchPageForProfile(
        { ...profile, access_token: token },
        'post'
      )

      // Endpoint saves token into DB already; reload list to reflect fresh state.
      await loadProfiles()
      setTokenResult({
        profileId: profile.id,
        profileName: profile.name,
        token,
      })
    } catch (err) {
      console.error('Failed to get token:', err)
      alert(`Failed to get token: ${String(err)}`)
    } finally {
      setFetchingToken(prev => {
        const next = new Set(prev)
        next.delete(profile.id)
        return next
      })
    }
  }

  const handleLaunch = async (profile: Profile) => {
    setLaunchingIds(prev => new Set(prev).add(profile.id))
    try {
      // Show spinner first
      await new Promise(r => setTimeout(r, 500))
      const result = await launchBrowser(profile)
      if (!result.success) alert(result.error || 'Failed to launch')
      await checkStatus()
    } finally {
      setLaunchingIds(prev => {
        const next = new Set(prev)
        next.delete(profile.id)
        return next
      })
    }
  }

  const handleStop = async (id: string) => {
    const result = await stopBrowser(id)
    if (!result.success) {
      alert(result.error || 'Failed to stop profile')
      return
    }
    await loadProfiles()
    await checkStatus()
  }

  const handleLaunchAndroid = async (profile: Profile) => {
    setLaunchingAndroidIds(prev => new Set(prev).add(profile.id))
    try {
      const result = await launchAndroidEmulator(profile)
      if (!result.success) {
        alert(result.error || 'Failed to open Android emulator')
      }
      await checkStatus()
    } finally {
      setLaunchingAndroidIds(prev => {
        const next = new Set(prev)
        next.delete(profile.id)
        return next
      })
    }
  }

  // Postcron extraction removed — using unified FB Lite token API only

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const toggleSelectAll = () => {
    const query = profileSearch.trim().toLowerCase()
    const visibleProfiles = profiles
      .filter(profile => selectedPage === 'all' || profile.page_name === selectedPage)
      .filter(profile => !query || profile.name.toLowerCase().includes(query))
    const visibleIds = visibleProfiles.map((profile) => profile.id)
    const isAllVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))

    if (isAllVisibleSelected) {
      const next = new Set(selectedIds)
      visibleIds.forEach((id) => next.delete(id))
      setSelectedIds(next)
      return
    }

    const next = new Set(selectedIds)
    visibleIds.forEach((id) => next.add(id))
    setSelectedIds(next)
  }

  if (authChecking) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>BrowserSaving</h1>
          <p>Checking session...</p>
        </div>
      </div>
    )
  }

  if (!authSession?.token) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={handleLoginSubmit}>
          <h1>BrowserSaving Login</h1>
          <p>ล็อกอินด้วยอีเมลและรหัสผ่านของ BrowserSaving</p>
          <label>
            Email
            <input
              type="email"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {authError ? <div className="auth-error">{authError}</div> : null}
          <button className="btn-primary auth-submit" type="submit" disabled={authLoading}>
            {authLoading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    )
  }

  const runningCount = runningIds.size
  const searchQuery = profileSearch.trim().toLowerCase()
  const filteredProfiles = profiles
    .filter(profile => selectedPage === 'all' || profile.page_name === selectedPage)
    .filter(profile => !searchQuery || profile.name.toLowerCase().includes(searchQuery))
  const allFilteredSelected = filteredProfiles.length > 0 && filteredProfiles.every((profile) => selectedIds.has(profile.id))

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-brand">
          <div className="logo">B</div>
          <span className="brand-name">BrowserSaving</span>
        </div>
        <nav className="nav">
          <a href="#" className={`nav-item ${currentPage === 'profiles' ? 'active' : ''}`} onClick={() => setCurrentPage('profiles')}>Profiles</a>
          <a href="#" className={`nav-item ${currentPage === 'debug' ? 'active' : ''}`} onClick={() => { if (debugProfile) setCurrentPage('debug') }} style={{ opacity: debugProfile ? 1 : 0.5 }}>Debug</a>
          <a href="#" className={`nav-item ${currentPage === 'proxy' ? 'active' : ''}`} onClick={() => setCurrentPage('proxy')}>Proxy</a>
          <a href="#" className={`nav-item ${currentPage === 'settings' ? 'active' : ''}`} onClick={() => setCurrentPage('settings')}>Settings</a>
        </nav>
        <div className="header-right">
          <div className="scale-control">
            <button className="scale-btn" onClick={() => setUiScale(Math.max(0.8, uiScale - 0.1))} title="Smaller">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35M8 11h6" />
              </svg>
            </button>
            <span className="scale-value">{Math.round(uiScale * 100)}%</span>
            <button className="scale-btn" onClick={() => setUiScale(Math.min(1.5, uiScale + 0.1))} title="Larger">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35M11 8v6M8 11h6" />
              </svg>
            </button>
          </div>
          <button className="theme-toggle" onClick={() => setDarkMode(!darkMode)} title={darkMode ? 'Light Mode' : 'Dark Mode'}>
            {darkMode ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <div className="auth-pill" title={authSession.email}>
            {authSession.email}
          </div>
          <button className="btn-outline btn-logout" onClick={handleLogout}>
            Logout
          </button>
          <div className={`status-pill ${serverConnected ? 'online' : 'offline'}`}>
            <span className="status-dot"></span>
            {serverConnected ? 'Connected' : 'Offline'}
          </div>
        </div>
      </header>

      {/* Debug Page */}
      {currentPage === 'debug' && debugProfile && (
        <DebugConsole
          profile={debugProfile}
          onClose={() => {
            handleDebugClose(true)
            setCurrentPage('profiles')
          }}
        />
      )}

      {/* Profiles Page */}
      {currentPage === 'profiles' && (
        <>
          {/* Toolbar */}
          <div className="toolbar">
            <h2>Profiles <span className="count">{profiles.length}</span></h2>
            <div className="toolbar-actions">
              <div className="profile-search">
                <button type="button" className="profile-search-btn" aria-label="Search profiles">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                </button>
                <input
                  type="text"
                  value={profileSearch}
                  onChange={(e) => setProfileSearch(e.target.value)}
                  placeholder="ค้นหาโปรไฟล์"
                />
                {profileSearch && (
                  <button
                    type="button"
                    className="profile-search-clear"
                    onClick={() => setProfileSearch('')}
                    aria-label="Clear search"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <button className="btn-outline" onClick={loadProfiles}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Refresh
              </button>
              <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14m-7-7h14" />
                </svg>
                Add Profile
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="stats">
            <div className="stat-item">
              <span className="stat-num">{profiles.length}</span>
              <span className="stat-label">Total</span>
            </div>
            <div className="stat-item">
              <span className="stat-num green">{runningCount}</span>
              <span className="stat-label">Running</span>
            </div>
            <div className="stat-item">
              <span className="stat-num">{profiles.length - runningCount}</span>
              <span className="stat-label">Stopped</span>
            </div>
          </div>

          {/* Table */}
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="col-num">#</th>
                  <th className="col-name">Name</th>
                  <th className="col-notes">Notes</th>
                  <th className="col-proxy">Proxy</th>
                  <th className="col-profile-tag">Tag</th>
                  <th className="col-tags">Page</th>
                  <th className="col-page-name">
                    <select
                      value={selectedPage}
                      onChange={(e) => setSelectedPage(e.target.value)}
                      className="page-filter"
                    >
                      <option value="all">All Pages</option>
                      {Array.from(new Set(profiles.map(p => p.page_name).filter(Boolean))).map(pageName => (
                        <option key={pageName} value={pageName}>{pageName}</option>
                      ))}
                    </select>
                  </th>
                  <th className="col-status">Status</th>
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProfiles.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="empty-row">
                      <div className="empty-state">
                        {profiles.length === 0 ? (
                          <>
                            <p>No profiles yet</p>
                            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
                              Create your first profile
                            </button>
                          </>
                        ) : (
                          <p>ไม่พบโปรไฟล์ที่ค้นหา</p>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredProfiles
                    .map((profile, index) => {
                      const isRunning = runningIds.has(profile.id)
                      const isLaunching = launchingIds.has(profile.id)
                      const isUploading = uploadingIds.has(profile.id)
                      const isDeleting = deletingIds.has(profile.id)
                      const isSavingTag = savingTagIds.has(profile.id)
                      const isLaunchingAndroid = launchingAndroidIds.has(profile.id)
                      const isRunningAndroid = runningAndroidIds.has(profile.id)
                      const isUploadingAndroid = uploadingAndroidIds.has(profile.id)
                      const profileTags = normalizeProfileTags(profile.tags || [])
                      const hasCredentials = !!(profile.uid || profile.username || profile.password || profile.totp_secret)
                      return (
                        <tr key={profile.id} className={isRunning ? 'row-running' : ''}>
                          <td className="col-check">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(profile.id)}
                              onChange={() => toggleSelect(profile.id)}
                            />
                          </td>
                          <td className="col-num">{index + 1}</td>
                          <td className="col-name">
                            <div className="name-cell">
                              {profile.avatar_url ? (
                                <img src={getAvatarUrl(profile.avatar_url)!} alt="" className="profile-avatar" />
                              ) : (
                                <span className="profile-icon">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" />
                                    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                                  </svg>
                                </span>
                              )}
                              <span className="profile-name">{profile.name}</span>
                            </div>
                          </td>
                          <td className="col-notes">
                            <span className="notes-text">{profile.notes || '-'}</span>
                          </td>
                          <td className="col-proxy">
                            <span className="proxy-text">{profile.proxy || '-'}</span>
                          </td>
                          <td className="col-profile-tag">
                            <div className="profile-tag-cell" onClick={(e) => e.stopPropagation()}>
                              <div className="profile-tag-list">
                                {profileTags.length === 0 ? (
                                  <span className="profile-tag-empty">-</span>
                                ) : (
                                  profileTags.map((tag) => (
                                    <button
                                      key={tag}
                                      type="button"
                                      className={`profile-tag-badge ${tag}`}
                                      onClick={() => handleRemoveTagFromProfile(profile, tag)}
                                      disabled={isSavingTag}
                                      title={`Remove ${tag} tag`}
                                    >
                                      {tag}
                                      <span className="profile-tag-remove">×</span>
                                    </button>
                                  ))
                                )}
                              </div>
                              <button
                                type="button"
                                className="profile-tag-add-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setTagPickerProfileId(current => current === profile.id ? null : profile.id)
                                }}
                                disabled={isSavingTag}
                                title={isSavingTag ? 'Syncing tags...' : 'Add tag'}
                              >
                                {isSavingTag ? (
                                  <svg className="spinner-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="9" strokeOpacity="0.28" />
                                    <path d="M21 12a9 9 0 0 0-9-9" />
                                  </svg>
                                ) : '+'}
                              </button>
                              {tagPickerProfileId === profile.id && (
                                <div className="profile-tag-picker" onClick={(e) => e.stopPropagation()}>
                                  {PROFILE_TAG_OPTIONS.map((tag) => {
                                    const hasTag = profileTags.includes(tag)
                                    return (
                                      <button
                                        key={tag}
                                        type="button"
                                        className={`profile-tag-option ${hasTag ? 'active' : ''}`}
                                        onClick={() => handleAddTagToProfile(profile, tag)}
                                        disabled={isSavingTag || hasTag}
                                      >
                                        {tag}
                                      </button>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="col-tags" onClick={() => fetchPageForProfile(profile)} style={{ cursor: hasAnyFacebookToken(profile) && !profile.page_name ? 'pointer' : 'default' }}>
                            {profile.page_avatar_url ? (
                              <img
                                src={profile.page_avatar_url}
                                alt={profile.page_name || profile.name}
                                className="page-avatar"
                                title={profile.page_name || profile.name}
                              />
                            ) : profile.page_name ? (
                              <div className="page-name">{profile.page_name}</div>
                            ) : hasAnyFacebookToken(profile) ? (
                              <div className="page-name" style={{ color: 'var(--accent)', fontSize: '11px' }}>Click to load</div>
                            ) : (
                              <div className="page-name">-</div>
                            )}
                          </td>
                          <td className="col-page-name">
                            <div className="page-name-text" title={profile.page_name || ''}>
                              {profile.page_name || '-'}
                            </div>
                          </td>
                          <td className="col-status">
                            {isLaunching ? (
                              <span className="badge launching">Launching...</span>
                            ) : isUploading ? (
                              <span className="badge uploading">Uploading...</span>
                            ) : isRunning ? (
                              <span className="badge running">Running</span>
                            ) : (
                              <span className="badge stopped">Stopped</span>
                            )}
                          </td>
                          <td className="col-actions">
                            <div className="actions">
                              {isLaunching ? (
                                <button className="action-btn launching" disabled title="Launching...">
                                  <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                </button>
                              ) : isUploading ? (
                                <button className="action-btn uploading" disabled title="Uploading...">
                                  <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                </button>
                              ) : isRunning ? (
                                <button className="action-btn stop" onClick={() => handleStop(profile.id)} title="Stop">
                                  <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" /></svg>
                                </button>
                              ) : (
                                <button className="action-btn start" onClick={() => handleLaunch(profile)} title="Start">
                                  <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                </button>
                              )}
                              {isUploadingAndroid ? (
                                <button className="action-btn android uploading" disabled title="Syncing Android profile...">
                                  <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                </button>
                              ) : isLaunchingAndroid ? (
                                <button className="action-btn android launching" disabled title="Opening Android Emulator...">
                                  <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                </button>
                              ) : (
                                <button
                                  className={`action-btn android ${isRunningAndroid ? 'active' : ''}`}
                                  onClick={() => handleLaunchAndroid(profile)}
                                  disabled={isRunningAndroid}
                                  title={isRunningAndroid ? 'Android Emulator is running' : 'Open Android Emulator'}
                                >
                                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                    <path d="M17.6 9.48 19.44 6.3a.62.62 0 0 0-.26-.85.62.62 0 0 0-.84.26L16.47 8.9A10.53 10.53 0 0 0 12 7.9c-1.58 0-3.07.34-4.47 1L5.66 5.7a.62.62 0 0 0-.84-.26.62.62 0 0 0-.26.85L6.4 9.48A8.01 8.01 0 0 0 2 16v1h20v-1a8.01 8.01 0 0 0-4.4-6.52ZM8 14.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm8 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
                                  </svg>
                                </button>
                              )}
                              <button
                                className={`action-btn copy-id ${copiedProfileId === profile.id ? 'copied' : ''}`}
                                onClick={() => handleCopyProfileId(profile)}
                                title={copiedProfileId === profile.id ? 'Copied Profile ID' : `Copy Profile ID: ${profile.id}`}
                              >
                                {copiedProfileId === profile.id ? (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                  </svg>
                                )}
                              </button>
                              {/* Credentials Button */}
                              {hasCredentials ? (
                                <button className="action-btn credentials" onClick={() => setCredentialsProfile(profile)} title="View Credentials (UID/Password/2FA)">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                  </svg>
                                </button>
                              ) : (
                                <button className="action-btn disabled" disabled title="No Credentials">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                  </svg>
                                </button>
                              )}
                              {/* Token Button */}
                              {fetchingToken.has(profile.id) ? (
                                <button className="action-btn token fetching" disabled title="Getting Token...">
                                  <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                </button>
                              ) : (
                                <button
                                  className={`action-btn token facebook-comment ${hasAccessToken(profile) ? 'has-token' : ''}`}
                                  onClick={() => handleFetchToken(profile)}
                                  title={hasAccessToken(profile) ? 'Refresh Token' : 'Get Token'}
                                >
                                  <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path fill="#1877F2" d="M22 12.07C22 6.503 17.523 2 12 2S2 6.503 2 12.07c0 5.017 3.657 9.178 8.438 9.93v-7.02H7.898v-2.91h2.54V9.845c0-2.523 1.492-3.917 3.777-3.917 1.094 0 2.238.196 2.238.196v2.476H15.19c-1.243 0-1.63.776-1.63 1.572v1.898h2.773l-.443 2.91h-2.33V22c4.78-.752 8.44-4.913 8.44-9.93z" />
                                  </svg>
                                </button>
                              )}
                              {debuggingIds.has(profile.id) ? (
                                <button className="action-btn debug active" onClick={() => { setDebugProfile(profile); setCurrentPage('debug') }} title="View Debug Logs">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1" />
                                    <path d="M12 20c-3.3 0-6-2.7-6-6v-3a6 6 0 0112 0v3c0 3.3-2.7 6-6 6z" />
                                    <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H3M6 17H3M21 5c0 2.1-1.6 3.8-3.53 4M18 13h3M18 17h3" />
                                  </svg>
                                </button>
                              ) : isRunning ? (
                                <button className="action-btn disabled" disabled title="Stop browser first to use debug mode">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3">
                                    <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1" />
                                    <path d="M12 20c-3.3 0-6-2.7-6-6v-3a6 6 0 0112 0v3c0 3.3-2.7 6-6 6z" />
                                    <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H3M6 17H3M21 5c0 2.1-1.6 3.8-3.53 4M18 13h3M18 17h3" />
                                  </svg>
                                </button>
                              ) : (
                                <button className="action-btn debug" onClick={() => handleDebugLaunch(profile)} title="Launch Debug Mode">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1" />
                                    <path d="M12 20c-3.3 0-6-2.7-6-6v-3a6 6 0 0112 0v3c0 3.3-2.7 6-6 6z" />
                                    <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H3M6 17H3M21 5c0 2.1-1.6 3.8-3.53 4M18 13h3M18 17h3" />
                                  </svg>
                                </button>
                              )}
                              <button className="action-btn" onClick={() => setEditingProfile(profile)} title="Edit">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                </svg>
                              </button>
                              {isDeleting ? (
                                <button className="action-btn deleting" disabled title="Deleting...">
                                  <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                </button>
                              ) : (
                                <button className="action-btn delete" onClick={() => handleDeleteClick(profile)} title="Delete">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <footer className="footer">
            <span className="footer-info">
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : `${profiles.length} profiles`}
            </span>
          </footer>
        </>
      )}

      {/* Settings Page */}
      {currentPage === 'settings' && (
        <div className="settings-page">
          <div className="toolbar">
            <h2>Settings</h2>
          </div>

          <div className="settings-section">
            <h3 className="settings-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              Browserless
              <span className={`browserless-status ${browserlessConnected ? 'online' : 'offline'}`}>
                <span className="status-dot"></span>
                {browserlessConnected ? 'Connected' : 'Offline'}
              </span>
            </h3>

            <div className="settings-field">
              <label>Browserless URL</label>
              <input
                type="text"
                value={browserlessUrl}
                onChange={e => setBrowserlessUrl(e.target.value)}
                placeholder="http://localhost:3333"
              />
            </div>

            <div className="settings-field">
              <label>Token</label>
              <input
                type="text"
                value={browserlessToken}
                onChange={e => setBrowserlessToken(e.target.value)}
                placeholder="browserless_token"
              />
            </div>

            <div className="settings-actions">
              <button className="btn-outline" onClick={checkBrowserless}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Test Connection
              </button>
            </div>

            <div className="settings-info">
              <p>🐳 Docker: <code>docker run -d --name browserless -p 3333:3000 -e TOKEN=browserless_token ghcr.io/browserless/chromium</code></p>
              <p>📖 Docs: <a href="https://docs.browserless.io" target="_blank" rel="noopener">docs.browserless.io</a></p>
            </div>
          </div>

          <div className="settings-section">
            <h3 className="settings-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <path d="M12 4v16M4 12h16M5 5l14 14M19 5 5 19" strokeWidth="2" />
              </svg>
              App Update
            </h3>

            <div className="settings-field">
              <label>Current update status</label>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {appUpdateState.message}
              </p>
              {appUpdateState.lastCheckedAt ? (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Last checked: {appUpdateState.lastCheckedAt}
                </p>
              ) : null}
            </div>

            {appUpdateState.availableVersion ? (
              <div className="settings-field">
                <label>Latest available</label>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {appUpdateState.availableVersion}
                </p>
                {appUpdateState.availableNotes ? (
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', marginTop: 4 }}>
                    {appUpdateState.availableNotes}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="settings-actions">
              <button
                className="btn-outline"
                onClick={handleManualUpdateCheck}
                disabled={appUpdateState.checking || appUpdateState.installing}
              >
                {appUpdateState.checking ? 'Checking...' : 'Check for Updates'}
              </button>
              {appUpdateState.availableVersion ? (
                <button
                  className="btn-primary"
                  onClick={handleManualUpdateInstall}
                  disabled={appUpdateState.checking || appUpdateState.installing}
                >
                  {appUpdateState.installing ? 'Installing...' : `Install v${appUpdateState.availableVersion}`}
                </button>
              ) : null}
            </div>

            {appUpdateState.error ? (
              <div className="settings-info">
                <p style={{ color: 'var(--red)' }}>{appUpdateState.error}</p>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {showCreateModal && (
        <CreateProfileModal
          onClose={() => setShowCreateModal(false)}
          onSave={handleCreateProfile}
          existingProfiles={profiles.map(({ id, name }) => ({ id, name }))}
        />
      )}

      {editingProfile && (
        <CreateProfileModal
          key={editingProfile.id}
          profile={editingProfile}
          onClose={() => setEditingProfile(null)}
          onSave={handleUpdateProfile}
          existingProfiles={profiles.map(({ id, name }) => ({ id, name }))}
        />
      )}

      {viewingLogs && (
        <LogViewer
          profileId={viewingLogs}
          onClose={() => setViewingLogs(null)}
        />
      )}

      {deletingProfile && (
        <div className="modal-overlay" onClick={() => setDeletingProfile(null)}>
          <div className="modal delete-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete Profile</h3>
              <button className="close-btn" onClick={() => setDeletingProfile(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <p>Are you sure you want to delete "<strong>{deletingProfile.name}</strong>"?</p>
              <p className="warning-text">This action cannot be undone.</p>
            </div>
            <div className="modal-footer">
              <button className="btn-outline" onClick={() => setDeletingProfile(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleDeleteConfirm}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {credentialsProfile && (
        <div className="modal-overlay" onClick={() => setCredentialsProfile(null)}>
          <div className="modal credentials-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Credentials</h3>
              <button className="close-btn" onClick={() => setCredentialsProfile(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="modal-body credentials-body">
              <p className="credentials-profile-name">{credentialsProfile.name}</p>

              <div className="credential-field">
                <label>UID (Facebook User ID)</label>
                <div className="credential-value-row">
                  <input type="text" value={credentialsProfile.uid || ''} readOnly />
                  <button className="copy-btn" onClick={() => { navigator.clipboard.writeText(credentialsProfile.uid || ''); }} title="Copy">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="credential-field">
                <label>Email</label>
                <div className="credential-value-row">
                  <input type="text" value={credentialsProfile.username || ''} readOnly />
                  <button className="copy-btn" onClick={() => { navigator.clipboard.writeText(credentialsProfile.username || ''); }} title="Copy">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="credential-field">
                <label>Password</label>
                <div className="credential-value-row">
                  <input type="password" value={credentialsProfile.password || ''} readOnly />
                  <button className="copy-btn" onClick={() => { navigator.clipboard.writeText(credentialsProfile.password || ''); }} title="Copy">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="credential-field">
                <label>2FA (Current Code)</label>
                <div className="credential-value-row">
                  <input type="text" value={credentialsTotpCode || ''} readOnly />
                  <button className="copy-btn" onClick={() => { navigator.clipboard.writeText(credentialsTotpCode || ''); }} title="Copy TOTP code">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>
                <p className="form-hint" style={{ marginTop: 6 }}>ใหม่ในอีก {credentialsTotpCountdown} วินาที</p>
              </div>

              <div className="credential-field">
                <label>DATR</label>
                <div className="credential-value-row">
                  <input type="text" value={credentialsProfile.datr || ''} readOnly />
                  <button className="copy-btn" onClick={() => { navigator.clipboard.writeText(credentialsProfile.datr || ''); }} title="Copy">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tokenResult && (
        <div className="modal-overlay" onClick={() => setTokenResult(null)}>
          <div className="modal token-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Access Token</h3>
              <button className="close-btn" onClick={() => setTokenResult(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="modal-body token-body">
              <p className="token-profile-name">{tokenResult.profileName}</p>

              <div className="token-field">
                <label>ACCESS TOKEN</label>
                <div className="token-value-row">
                  <textarea
                    value={tokenResult.token}
                    readOnly
                    rows={4}
                  />
                  <button
                    className="copy-btn"
                    onClick={() => {
                      navigator.clipboard.writeText(tokenResult.token)
                    }}
                    title="Copy"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="token-actions">
                <button
                  className="btn-outline"
                  onClick={() => {
                    const profile = profiles.find(p => p.id === tokenResult.profileId)
                    setTokenResult(null)
                    if (profile) void handleFetchToken(profile)
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 4v6h-6M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  Refresh Token
                </button>
              </div>
            </div>
          </div>
        </div>
      )}








    </div>
  )
}

export default App
