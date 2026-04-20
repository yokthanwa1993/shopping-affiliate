import {
  Activity,
  BarChart3,
  ChevronRight,
  Clock,
  ExternalLink,
  Facebook,
  LayoutDashboard,
  Layers,
  Megaphone,
  MessageCircle,
  PlaySquare,
  Search,
  Settings2,
  Users,
  Wallet,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'

type DashboardTab = 'dashboard' | 'gallery' | 'page-posts' | 'create' | 'running' | 'queue' | 'history' | 'settings'

const DASHBOARD_TABS: DashboardTab[] = ['dashboard', 'gallery', 'page-posts', 'create', 'running', 'queue', 'history', 'settings']

type AdQueueItem = {
  id: number
  created_at: string
  page_id: string
  video_id: string
  caption: string
  shopee_url: string
  story_id: string
  campaign_id: string
  new_campaign_name: string
  status: 'queued' | 'processing' | 'done' | 'failed' | 'cancelled'
  attempted_at: string
  completed_at: string
  error_message: string
  result_story_id: string
  result_ad_id: string
  result_adset_id: string
}

type AdQueueListResponse = {
  ok?: boolean
  items?: AdQueueItem[]
  counts?: Record<string, number>
  last_run_at?: string
  next_run_at?: string
  interval_minutes?: number
}

type VideoCandidate = {
  id: string
  title: string
  duration: string
  thumbnail: string
  shopeeLink: string
  status: 'ready' | 'queued' | 'creating'
}

type HistoryItem = {
  storyId: string
  postUrl: string
  publishedAt: string
  pageName: string
}

type GalleryLinkedItem = {
  storyId: string
  pageName: string
  createdAt: string
  postedAt: string
  postUrl: string
  facebookThumb: string
  views: number
  videoId: string
  videoTitle: string
  videoUrl: string
  videoThumb: string
  adsetId: string
  shopeeLink?: string
  postId?: string
}

type GallerySyncState = {
  nextAfter: string
  lastAttemptAt: string
  lastSyncedAt: string
  lastFullScanAt: string
  fullyScanned: boolean
  lastBatchCount: number
  lastError: string
}

type DashboardSettings = {
  subId: string
  subId2: string
  subId3: string
  subId4: string
  subId5: string
  shortlinkUrl: string
  commentTemplate: string
  defaultPage: string
  adAccount: string
  templateAdset: string
  campaignPrefix: string
  adsPerRound: string
  autoCreateTime: string
  facebookSyncToken: string
  facebookSyncTokenUpdatedAt: string
}

const summaryCards = [
  { label: 'Views delivered', value: '19.5M', meta: '+42%', icon: BarChart3 },
  { label: 'Budget spent', value: '฿123,674', meta: '+13%', icon: Wallet },
  { label: 'Remaining budget', value: '฿56,339', meta: '-52%', icon: Activity },
  { label: 'Active creators', value: '146', meta: '+37%', icon: Users },
]

const campaignRows = [
  { name: 'The Investor Lookout', status: 'Draft', platform: 'Facebook', payRate: '$0.00 / 1k', creators: '—', submissions: '—', paid: '$0,000', budget: '$0,000' },
  { name: 'Mintify Bytes', status: 'Live', platform: 'Instagram · YouTube', payRate: '$4.50 / 1k', creators: '28', submissions: '64', paid: '$6,480', budget: '$12,000' },
  { name: 'Bionic Marketing', status: 'Paused', platform: 'Instagram · TikTok', payRate: '$6.00 / 1k', creators: '19', submissions: '41', paid: '$9,180', budget: '$15,000' },
]

const recentUploads = [
  'https://images.unsplash.com/photo-1529042410759-befb1204b468?auto=format&fit=crop&w=400&q=80',
  'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=400&q=80',
  'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=400&q=80',
  'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=400&q=80',
]

const videoCandidates: VideoCandidate[] = [
  {
    id: '6b784d9a',
    title: 'กล่องเก็บของติดรถ ใช้ง่ายมาก',
    duration: '0:18',
    thumbnail: 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?auto=format&fit=crop&w=700&q=80',
    shopeeLink: 'https://s.shopee.co.th/xxx',
    status: 'ready',
  },
  {
    id: '0a84442b',
    title: 'ชั้นวางของในครัว ประหยัดพื้นที่',
    duration: '0:25',
    thumbnail: 'https://images.unsplash.com/photo-1519710164239-da123dc03ef4?auto=format&fit=crop&w=700&q=80',
    shopeeLink: 'https://s.shopee.co.th/yyy',
    status: 'queued',
  },
  {
    id: 'aa33bf7b',
    title: 'พัดลมจิ๋ว แรงเกินคาด',
    duration: '0:14',
    thumbnail: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=700&q=80',
    shopeeLink: 'https://s.shopee.co.th/zzz',
    status: 'creating',
  },
]

const historyItems: HistoryItem[] = [
  {
    storyId: '1008898512617594_1251721693799193',
    postUrl: 'https://facebook.com/1008898512617594/posts/1251721693799193',
    publishedAt: '14 เม.ย. 2026 22:05',
    pageName: 'เฉียบ',
  },
  {
    storyId: '1008898512617594_1251668993804463',
    postUrl: 'https://facebook.com/1008898512617594/posts/1251668993804463',
    publishedAt: '14 เม.ย. 2026 20:05',
    pageName: 'เฉียบ',
  },
]

const statusClass = {
  ready: 'bg-emerald-50 text-emerald-700',
  queued: 'bg-amber-50 text-amber-700',
  creating: 'bg-sky-50 text-sky-700',
} as const

const CHIEB_PAGE_ID = '1008898512617594'
const CHIEB_PAGE_NAME = 'เฉียบ'
const CHIEB_NAMESPACE_ID = '1774858894802785816'
const GALLERY_MIN_VIEWS = 100000
const GALLERY_READ_LIMIT = 300
const SYSTEM_GALLERY_BATCH_SIZE = 30

type SystemGalleryView = 'ready' | 'used'

type SystemGalleryVideo = {
  id: string
  script?: string
  manualCaption?: string
  caption?: string
  duration?: number
  thumbnailUrl?: string
  publicUrl?: string
  originalUrl?: string
  createdAt?: string
  postedAt?: string
  shopeeLink?: string
  lazadaLink?: string
  title?: string
  [key: string]: unknown
}

type SystemGalleryResponse = {
  ok?: boolean
  videos?: SystemGalleryVideo[]
  total?: number
  ready_total?: number
  used_total?: number
  has_more?: boolean
  view?: SystemGalleryView
}
const DEFAULT_SETTINGS: DashboardSettings = {
  subId: 'yok',
  subId2: '',
  subId3: '',
  subId4: '',
  subId5: '',
  shortlinkUrl: 'https://short.wwoom.com/?account=CHEARB&url={url}&sub1={sub_id}',
  commentTemplate: '🔥 สนใจสั่งซื้อหรือดูราคา 👉 {shopee_link}',
  defaultPage: '1008898512617594',
  adAccount: 'act_1030797047648459',
  templateAdset: '120244070706570263',
  campaignPrefix: 'ADS_PUBLISH_',
  adsPerRound: '10',
  autoCreateTime: '00:00',
  facebookSyncToken: '',
  facebookSyncTokenUpdatedAt: '',
}

function formatThaiDate(value: string) {
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

// Robustly parse a timestamp string and format in Thai locale.
// SQLite `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" (UTC, NO Z) — JS Date()
// would treat it as LOCAL time, causing a 7-hour drift in Bangkok. Append 'Z' to
// force UTC interpretation. ISO strings (with Z or +offset) parse correctly as-is.
function formatThaiDateTime(value: string): string {
  if (!value) return ''
  const trimmed = String(value).trim()
  if (!trimmed) return ''
  const hasTimezone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed)
  const parseable = hasTimezone ? trimmed : trimmed.replace(' ', 'T') + 'Z'
  const d = new Date(parseable)
  if (isNaN(d.getTime())) return trimmed
  return d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
}

function buildFacebookUrl(permalinkUrl: string) {
  if (!permalinkUrl) return '#'
  if (permalinkUrl.startsWith('http://') || permalinkUrl.startsWith('https://')) return permalinkUrl
  return `https://www.facebook.com${permalinkUrl}`
}

function formatCompactViews(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return value.toLocaleString()
}

function isDashboardTab(value: string | null): value is DashboardTab {
  return value !== null && DASHBOARD_TABS.includes(value as DashboardTab)
}

function getTabPath(tab: DashboardTab) {
  return tab === 'dashboard' ? '/' : `/${tab}`
}

function formatVideoDuration(seconds: number | undefined) {
  const s = Number(seconds || 0)
  if (!Number.isFinite(s) || s <= 0) return ''
  const total = Math.floor(s)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

function pickVideoTitle(video: SystemGalleryVideo): string {
  const manual = String(video.manualCaption || '').trim()
  if (manual) return manual
  const caption = String(video.caption || '').trim()
  if (caption) return caption
  const script = String(video.script || '').trim()
  if (script) return script.length > 120 ? `${script.slice(0, 120)}…` : script
  const title = String(video.title || '').trim()
  if (title) return title
  return video.id || ''
}

function hasAffiliateLink(video: SystemGalleryVideo): boolean {
  return !!String(video.shopeeLink || '').trim() || !!String(video.lazadaLink || '').trim()
}

// Asset variants:
//   - public / thumb         = ประมวลผลแล้ว (after AI processing — what dashboard/app shows)
//   - original / original-thumb = คลังต้นฉบับ (raw uploaded source)
// We want the PROCESSED version, so use 'public' (video) + 'thumb' (poster).
// Proxy via /worker-api to stay on dashboard.oomnn.com.
function buildVideoThumbnailUrl(videoId: string, namespaceId: string): string {
  if (!videoId || !namespaceId) return ''
  return `/worker-api/api/gallery/${encodeURIComponent(videoId)}/asset/thumb?namespace_id=${encodeURIComponent(namespaceId)}`
}

function buildVideoPlaybackUrl(videoId: string, namespaceId: string): string {
  if (!videoId || !namespaceId) return ''
  return `/worker-api/api/gallery/${encodeURIComponent(videoId)}/asset/public?namespace_id=${encodeURIComponent(namespaceId)}`
}

function getInitialTab(): DashboardTab {
  const pathTab = window.location.pathname.replace(/^\/+|\/+$/g, '')
  if (isDashboardTab(pathTab)) return pathTab
  const params = new URLSearchParams(window.location.search)
  const tab = params.get('tab')
  return isDashboardTab(tab) ? tab : 'dashboard'
}

export default function App() {
  const [tab, setTab] = useState<DashboardTab>(() => getInitialTab())
  const [selectedVideos, setSelectedVideos] = useState<string[]>(['6b784d9a'])
  const [createAdPopup, setCreateAdPopup] = useState<{ videoId: string; caption: string; storyId: string; shopeeLink: string } | null>(null)
  const [adQueueItems, setAdQueueItems] = useState<AdQueueItem[]>([])
  const [adQueueCounts, setAdQueueCounts] = useState<Record<string, number>>({})
  const [adQueueLastRun, setAdQueueLastRun] = useState<string>('')
  const [adQueueNextRun, setAdQueueNextRun] = useState<string>('')
  const [adQueueLoading, setAdQueueLoading] = useState(false)
  const [adQueueIntervalMinutes, setAdQueueIntervalMinutes] = useState(20)
  const [createAdShopeeLink, setCreateAdShopeeLink] = useState('')
  const [createAdCampaigns, setCreateAdCampaigns] = useState<Array<{ id: string; name: string; status: string; adsetCount: number }>>([])
  const [createAdLoading, setCreateAdLoading] = useState(false)
  const [createAdCreating, setCreateAdCreating] = useState(false)
  const [createAdStep, setCreateAdStep] = useState('')
  const [createAdResultBanner, setCreateAdResultBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [createAdProgress, setCreateAdProgress] = useState(0)
  const [createAdSelectedCampaign, setCreateAdSelectedCampaign] = useState('')
  const [createAdNewCampaignName, setCreateAdNewCampaignName] = useState('')

  const [galleryLinkedItems, setGalleryLinkedItems] = useState<GalleryLinkedItem[]>([])
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [galleryError, setGalleryError] = useState<string | null>(null)
  const [gallerySyncing, setGallerySyncing] = useState(false)
  const [gallerySyncState, setGallerySyncState] = useState<GallerySyncState | null>(null)
  const [galleryBootstrapped, setGalleryBootstrapped] = useState(false)

  // System gallery (new /gallery tab — เหมือน mobile app)
  const [systemGalleryView, setSystemGalleryView] = useState<SystemGalleryView>('ready')
  const [systemGalleryReadyItems, setSystemGalleryReadyItems] = useState<SystemGalleryVideo[]>([])
  const [systemGalleryUsedItems, setSystemGalleryUsedItems] = useState<SystemGalleryVideo[]>([])
  const [systemGalleryReadyTotal, setSystemGalleryReadyTotal] = useState(0)
  const [systemGalleryUsedTotal, setSystemGalleryUsedTotal] = useState(0)
  const [systemGalleryHasMore, setSystemGalleryHasMore] = useState(true)
  const [systemGalleryLoading, setSystemGalleryLoading] = useState(false)
  const [systemGalleryError, setSystemGalleryError] = useState<string | null>(null)
  const [systemGallerySearch, setSystemGallerySearch] = useState('')
  const [videoPreview, setVideoPreview] = useState<SystemGalleryVideo | null>(null)
  const [settings, setSettings] = useState<DashboardSettings>(DEFAULT_SETTINGS)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)

  const selectedItems = useMemo(
    () => videoCandidates.filter((item) => selectedVideos.includes(item.id)),
    [selectedVideos],
  )

  type LiveCampaign = {
    id: string; name: string; status: string; dailyBudget: string
    adsetCount: number; activeAdsetCount: number
    reach: string; impressions: string; spend: string; costPerResult: string
    adsets: Array<{ id: string; name: string; status: string }>
  }
  const [liveCampaigns, setLiveCampaigns] = useState<LiveCampaign[]>([])
  const [campaignsLoading, setCampaignsLoading] = useState(false)

  async function openCreateAdPopup(videoId: string, caption: string, storyId = '', shopeeLink = '') {
    setCreateAdPopup({ videoId, caption, storyId, shopeeLink })
    setCreateAdShopeeLink(shopeeLink)
    setCreateAdSelectedCampaign('')
    setCreateAdNewCampaignName('')
    setCreateAdLoading(true)
    try {
      const resp = await fetch(`/worker-api/api/dashboard/campaigns?ad_account=${encodeURIComponent(settings.adAccount || 'act_1030797047648459')}`)
      if (resp.ok) {
        const data = await resp.json() as { campaigns?: Array<{ id: string; name: string; status: string; adsetCount: number }> }
        setCreateAdCampaigns(data.campaigns || [])
      }
    } catch {}
    finally { setCreateAdLoading(false) }
  }

  async function submitCreateAdImmediate() {
    if (!createAdPopup) return
    setCreateAdResultBanner(null)
    setCreateAdCreating(true)
    setCreateAdStep('⚡ กำลังสร้างแอดทันที...')
    setCreateAdProgress(10)

    // Progress simulation while waiting for FB API (upload + thumbnail wait + adset copy)
    const steps = [
      { delay: 3000, step: '📤 กำลังอัปโหลดวิดีโอไปยัง Ad Account...', progress: 25 },
      { delay: 8000, step: '🖼️ รอ Facebook สร้าง thumbnail...', progress: 45 },
      { delay: 18000, step: '⚙️ กำลังคัดลอก adset จาก template...', progress: 65 },
      { delay: 30000, step: '🌐 กำลังเผยแพร่ไปหน้าเพจ...', progress: 80 },
      { delay: 45000, step: '💬 กำลังคอมเมนต์ลิงก์...', progress: 90 },
    ]
    const timers = steps.map(({ delay, step, progress }) =>
      setTimeout(() => { setCreateAdStep(step); setCreateAdProgress(progress) }, delay)
    )

    let finalStatus: 'success' | 'error' = 'error'
    let finalMessage = ''

    try {
      // IMMEDIATE — call create-ad directly, bypass queue entirely.
      // Runs full pipeline synchronously (60-120s typical). User waits for real result.
      const resp = await fetch('/worker-api/api/dashboard/create-ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: CHIEB_PAGE_ID,
          video_id: createAdPopup.videoId,
          caption: createAdPopup.caption,
          story_id: createAdPopup.storyId || '',
          shopee_url: createAdShopeeLink || '',
          campaign_id: createAdSelectedCampaign || undefined,
          new_campaign_name: createAdNewCampaignName || undefined,
        }),
      })
      timers.forEach(clearTimeout)
      const rawText = await resp.text()
      let data: {
        ok?: boolean
        error?: string
        step?: string
        fb_error_code?: number
        fb_error_subcode?: number
        fb_trace_id?: string
        story_id?: string
        ad_id?: string
        adset_id?: string
        commentPosted?: boolean
      } = {}
      try { data = rawText ? JSON.parse(rawText) : {} } catch { data = { error: `invalid_json_response: ${rawText.substring(0, 200)}` } }

      if (resp.ok && data.ok) {
        finalStatus = 'success'
        finalMessage = `✅ สำเร็จ!\n\nstory_id: ${data.story_id || '-'}\nad_id: ${data.ad_id || '-'}\nadset_id: ${data.adset_id || '-'}\nคอมเมนต์: ${data.commentPosted ? 'โพสต์แล้ว' : 'ข้าม'}`
        setCreateAdProgress(100)
        setCreateAdStep(`✅ สำเร็จ! story=${data.story_id || '-'} ${data.commentPosted ? '(คอมเมนต์แล้ว)' : ''}`)
        setCreateAdResultBanner({ type: 'success', text: `✅ story=${data.story_id || '-'} ${data.commentPosted ? '· คอมเมนต์แล้ว' : ''}` })
      } else {
        finalStatus = 'error'
        const stepLabel = data.step ? `[${data.step}] ` : ''
        const fbCode = data.fb_error_code ? ` (FB code=${data.fb_error_code}${data.fb_error_subcode ? `/subcode=${data.fb_error_subcode}` : ''})` : ''
        const traceId = data.fb_trace_id ? `\ntrace_id: ${data.fb_trace_id}` : ''
        const shortSummary = `${stepLabel}${data.error || `HTTP ${resp.status}`}${fbCode}`
        finalMessage = `❌ สร้างแอดไม่สำเร็จ — HTTP ${resp.status}\n\n${shortSummary}${traceId}\n\n(Invalid parameter บ่อยครั้งเป็น transient — ลองกดซ้ำอีกครั้ง)`
        setCreateAdStep(`❌ ${shortSummary}`)
        setCreateAdProgress(0)
        setCreateAdResultBanner({ type: 'error', text: `❌ ${shortSummary}${traceId ? `\ntrace=${data.fb_trace_id}` : ''}` })
      }
    } catch (e) {
      timers.forEach(clearTimeout)
      const msg = e instanceof Error ? e.message : String(e)
      finalStatus = 'error'
      finalMessage = `❌ Exception: ${msg}`
      setCreateAdStep(`❌ ${msg}`)
      setCreateAdProgress(0)
      setCreateAdResultBanner({ type: 'error', text: `❌ Exception — ${msg}` })
    } finally {
      timers.forEach(clearTimeout)
      setCreateAdCreating(false)
      // Always show alert with final result — user sees unambiguous outcome even if
      // popup timing was tight or they looked away during the 60-120s wait.
      if (finalMessage) {
        alert(finalMessage)
      }
      if (finalStatus === 'success') {
        setCreateAdPopup(null)
        setCreateAdResultBanner(null)
      }
      // On error: leave popup open AND banner visible so user can see message + retry
    }
  }

  async function submitCreateAd() {
    if (!createAdPopup) return
    setCreateAdResultBanner(null)
    setCreateAdCreating(true)
    setCreateAdStep('📥 กำลังเพิ่มเข้าคิว...')
    setCreateAdProgress(40)

    try {
      // ENQUEUE — don't run create-ad now, let cron pick it up every 20 minutes.
      const resp = await fetch('/worker-api/api/dashboard/ad-queue/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: CHIEB_PAGE_ID,
          video_id: createAdPopup.videoId,
          caption: createAdPopup.caption,
          story_id: createAdPopup.storyId || '',
          shopee_url: createAdShopeeLink || '',
          campaign_id: createAdSelectedCampaign || undefined,
          new_campaign_name: createAdNewCampaignName || undefined,
        }),
      })
      const rawText = await resp.text()
      let data: { ok?: boolean; error?: string; queue_id?: number; queued_count?: number; next_run_at?: string } = {}
      try { data = rawText ? JSON.parse(rawText) : {} } catch { data = { error: `invalid_json: ${rawText.substring(0, 200)}` } }

      if (resp.ok && data.ok) {
        setCreateAdProgress(100)
        const nextRun = data.next_run_at ? new Date(data.next_run_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '~20 นาที'
        const successText = `✅ เพิ่มเข้าคิวแล้ว #${data.queue_id} · ${data.queued_count || 0} งานในคิว · รันถัดไป ${nextRun}`
        setCreateAdStep(successText)
        setCreateAdResultBanner({ type: 'success', text: successText })
        await new Promise(r => setTimeout(r, 1800))
        setCreateAdPopup(null)
        setCreateAdResultBanner(null)
        // Refresh queue page if user is on it
        void loadAdQueue()
      } else {
        const errText = `❌ HTTP ${resp.status} — ${data.error || 'เพิ่มเข้าคิวไม่สำเร็จ'}`
        setCreateAdStep(errText)
        setCreateAdResultBanner({ type: 'error', text: errText })
        setCreateAdProgress(0)
        alert(errText)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setCreateAdStep(`❌ ${msg}`)
      setCreateAdResultBanner({ type: 'error', text: `❌ Exception — ${msg}` })
      setCreateAdProgress(0)
      alert(`❌ Exception: ${msg}`)
    } finally {
      setCreateAdCreating(false)
    }
  }

  async function loadAdQueue() {
    setAdQueueLoading(true)
    try {
      const resp = await fetch('/worker-api/api/dashboard/ad-queue/list?limit=100')
      const data = await resp.json() as AdQueueListResponse
      if (data.ok) {
        setAdQueueItems(data.items || [])
        setAdQueueCounts(data.counts || {})
        setAdQueueLastRun(data.last_run_at || '')
        setAdQueueNextRun(data.next_run_at || '')
        if (data.interval_minutes) setAdQueueIntervalMinutes(data.interval_minutes)
      }
    } catch {
      // keep previous state
    } finally {
      setAdQueueLoading(false)
    }
  }

  async function cancelQueueItem(id: number) {
    if (!window.confirm(`ยกเลิกงานคิว #${id}?`)) return
    try {
      const resp = await fetch(`/worker-api/api/dashboard/ad-queue/${id}`, { method: 'DELETE' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      await loadAdQueue()
    } catch (e) {
      alert(`ยกเลิกไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function runQueueNow() {
    if (!window.confirm('รันงานคิวถัดไปเดี๋ยวนี้?\n\n(ระบบจะหยิบงาน queued ตัวเก่าสุดมาทำทันที ไม่ต้องรอ cron 20 นาที)\n\n⚠ ใช้เวลา ~30-60 วินาที เพราะต้องรอ Facebook สร้าง thumbnail + adset')) return
    setAdQueueLoading(true)
    try {
      const resp = await fetch('/worker-api/api/dashboard/ad-queue/run-next', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
      })
      // Read as text first so we can show raw content on JSON parse failure (debug aid)
      const rawText = await resp.text()
      let data: { ok?: boolean; queue_id?: number; skipped?: boolean; reason?: string; error?: string } = {}
      try {
        data = rawText ? JSON.parse(rawText) : {}
      } catch (parseErr) {
        const preview = rawText.length > 300 ? rawText.substring(0, 300) + '...' : rawText
        alert(`รันไม่สำเร็จ: response ไม่ใช่ JSON (status ${resp.status})\n\nResponse:\n${preview}`)
        await loadAdQueue()
        return
      }
      if (data.skipped) {
        alert(`คิวว่างเปล่า (${data.reason || 'no_items'})`)
      } else if (data.ok) {
        alert(`รันคิว #${data.queue_id} สำเร็จ`)
      } else {
        alert(`รันคิว #${data.queue_id || '?'} ล้มเหลว: ${data.error || `HTTP ${resp.status}`}`)
      }
      await loadAdQueue()
    } catch (e) {
      alert(`รันไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAdQueueLoading(false)
    }
  }

  async function loadCampaigns() {
    setCampaignsLoading(true)
    try {
      const resp = await fetch(`/worker-api/api/dashboard/campaigns?ad_account=${encodeURIComponent(settings.adAccount || 'act_1030797047648459')}`)
      if (resp.ok) {
        const data = await resp.json() as { campaigns?: LiveCampaign[] }
        setLiveCampaigns(data.campaigns || [])
      }
    } catch {}
    finally { setCampaignsLoading(false) }
  }

  useEffect(() => {
    if (tab === 'running') void loadCampaigns()
  }, [tab])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.delete('tab')
    const search = params.toString()
    const next = `${getTabPath(tab)}${search ? `?${search}` : ''}`
    window.history.replaceState({}, '', next)
  }, [tab])

  useEffect(() => {
    const handlePopState = () => {
      setTab(getInitialTab())
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    void loadDashboardSettings()
  }, [])

  async function loadDashboardSettings() {
    setSettingsLoading(true)
    setSettingsMessage(null)
    try {
      const response = await fetch('/worker-api/api/dashboard/settings')
      if (!response.ok) throw new Error(`โหลด settings ไม่สำเร็จ (${response.status})`)
      const p = await response.json() as Record<string, string>
      setSettings((current) => ({
        ...current,
        subId: String(p.sub_id || current.subId || ''),
        subId2: String(p.sub_id2 || current.subId2 || ''),
        subId3: String(p.sub_id3 || current.subId3 || ''),
        subId4: String(p.sub_id4 || current.subId4 || ''),
        subId5: String(p.sub_id5 || current.subId5 || ''),
        shortlinkUrl: String(p.shortlink_url || current.shortlinkUrl || ''),
        commentTemplate: String(p.comment_template || current.commentTemplate || ''),
        defaultPage: String(p.default_page || current.defaultPage || ''),
        adAccount: String(p.ad_account || current.adAccount || ''),
        templateAdset: String(p.template_adset || current.templateAdset || ''),
        campaignPrefix: String(p.campaign_prefix || current.campaignPrefix || ''),
        adsPerRound: String(p.ads_per_round || current.adsPerRound || ''),
        autoCreateTime: String(p.auto_create_time || current.autoCreateTime || ''),
        facebookSyncToken: String(p.facebook_sync_token || p.facebookSyncToken || ''),
        facebookSyncTokenUpdatedAt: String(p.facebookSyncTokenUpdatedAt || ''),
      }))
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'โหลด settings ไม่สำเร็จ')
    } finally {
      setSettingsLoading(false)
    }
  }

  async function saveDashboardSettings() {
    setSettingsSaving(true)
    setSettingsMessage(null)
    try {
      const response = await fetch('/worker-api/api/dashboard/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sub_id: settings.subId,
          sub_id2: settings.subId2,
          sub_id3: settings.subId3,
          sub_id4: settings.subId4,
          sub_id5: settings.subId5,
          shortlink_url: settings.shortlinkUrl,
          comment_template: settings.commentTemplate,
          default_page: settings.defaultPage,
          ad_account: settings.adAccount,
          template_adset: settings.templateAdset,
          campaign_prefix: settings.campaignPrefix,
          ads_per_round: settings.adsPerRound,
          auto_create_time: settings.autoCreateTime,
          facebook_sync_token: settings.facebookSyncToken,
        }),
      })
      if (!response.ok) throw new Error(`บันทึก settings ไม่สำเร็จ (${response.status})`)
      setSettingsMessage('✅ บันทึกแล้ว')
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'บันทึก settings ไม่สำเร็จ')
    } finally {
      setSettingsSaving(false)
    }
  }

  async function loadGalleryFromWorker(showSpinner = true) {
    if (showSpinner) setGalleryLoading(true)
    setGalleryError(null)
    try {
      const search = new URLSearchParams({
        page_id: CHIEB_PAGE_ID,
        page_name: CHIEB_PAGE_NAME,
        min_views: String(GALLERY_MIN_VIEWS),
        limit: String(GALLERY_READ_LIMIT),
      })
      const response = await fetch(`/worker-api/api/dashboard/facebook-page-videos?${search.toString()}`)
      if (!response.ok) {
        throw new Error(`โหลดโพสต์ไม่สำเร็จ (${response.status})`)
      }
      const payload = await response.json() as {
        items?: GalleryLinkedItem[]
        sync?: Partial<GallerySyncState>
      }
      const items = Array.isArray(payload.items) ? payload.items : []
      setGalleryLinkedItems(items.map((item) => ({
        ...item,
        postedAt: item.createdAt ? formatThaiDate(item.createdAt) : item.postedAt,
        postUrl: buildFacebookUrl(item.postUrl),
      })))
      setGallerySyncState({
        nextAfter: String(payload.sync?.nextAfter || ''),
        lastAttemptAt: String(payload.sync?.lastAttemptAt || ''),
        lastSyncedAt: String(payload.sync?.lastSyncedAt || ''),
        lastFullScanAt: String(payload.sync?.lastFullScanAt || ''),
        fullyScanned: !!payload.sync?.fullyScanned,
        lastBatchCount: Number(payload.sync?.lastBatchCount || 0),
        lastError: String(payload.sync?.lastError || ''),
      })
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : 'โหลดโพสต์ไม่สำเร็จ')
    } finally {
      if (showSpinner) setGalleryLoading(false)
    }
  }

  async function syncNextGalleryBatch() {
    if (gallerySyncing) return
    setGallerySyncing(true)
    setGalleryError(null)
    try {
      const syncResponse = await fetch(`/worker-api/api/dashboard/facebook-page-videos/auto-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: CHIEB_PAGE_ID,
          page_name: CHIEB_PAGE_NAME,
          force: true,
        }),
      })
      const syncPayload = await syncResponse.json().catch(() => ({})) as { ok?: boolean; reason?: string; totalOverThreshold?: number }
      if (!syncResponse.ok || syncPayload.ok === false) {
        // Still reload cached data even if sync failed
        await loadGalleryFromWorker(false)
        if (syncPayload.reason?.includes('facebook_graph_http')) {
          // Facebook API error — data may still be partially cached, don't show error
          return
        }
        throw new Error(syncPayload.reason || `sync ไม่สำเร็จ (${syncResponse.status})`)
      }
      await loadGalleryFromWorker(false)
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : 'โหลดโพสต์ไม่สำเร็จ')
    } finally {
      setGallerySyncing(false)
      setGalleryLoading(false)
    }
  }

  async function refreshAllGalleryViews() {
    if (gallerySyncing) return
    setGallerySyncing(true)
    setGalleryError(null)
    try {
      const resp = await fetch(`/worker-api/api/dashboard/facebook-page-videos/refresh-all-views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: CHIEB_PAGE_ID }),
      })
      const data = await resp.json().catch(() => ({})) as {
        ok?: boolean
        total?: number
        refreshed?: number
        raised?: number
        errors?: number
        total_over_100k?: number
        error?: string
      }
      if (!resp.ok || data.ok === false) {
        throw new Error(data.error || `refresh ไม่สำเร็จ (${resp.status})`)
      }
      await loadGalleryFromWorker(false)
      setGalleryError(
        `รีเฟรชเสร็จ: เช็ค ${data.total ?? 0} คลิป, ` +
        `อัปเดตยอดวิว ${data.raised ?? 0} คลิป, ` +
        `คลิปที่มียอด ≥ 1 แสน: ${data.total_over_100k ?? 0}` +
        (data.errors ? ` (errors: ${data.errors})` : '')
      )
    } catch (error) {
      setGalleryError(error instanceof Error ? error.message : 'รีเฟรชไม่สำเร็จ')
    } finally {
      setGallerySyncing(false)
      setGalleryLoading(false)
    }
  }

  useEffect(() => {
    void loadGalleryFromWorker(true)
  }, [])

  // Auto-load queue when user opens the queue tab + auto-refresh every 30s while there
  useEffect(() => {
    if (tab !== 'queue') return
    void loadAdQueue()
    const id = setInterval(() => void loadAdQueue(), 30000)
    return () => clearInterval(id)
  }, [tab])

  // Auto-sync: keep syncing until fully scanned
  useEffect(() => {
    if (tab !== 'page-posts' || galleryLoading || gallerySyncing) return
    if (!galleryBootstrapped) {
      setGalleryBootstrapped(true)
      void syncNextGalleryBatch()
      return
    }
    // Continue syncing if not fully scanned yet
    if (gallerySyncState && !gallerySyncState.fullyScanned && gallerySyncState.nextAfter) {
      const timer = setTimeout(() => void syncNextGalleryBatch(), 3000)
      return () => clearTimeout(timer)
    }
  }, [tab, galleryLoading, gallerySyncing, galleryBootstrapped, gallerySyncState?.fullyScanned, gallerySyncState?.nextAfter])

  // ==================== SYSTEM GALLERY (new /gallery tab) ====================
  async function loadSystemGalleryPage(view: SystemGalleryView, options: { reset?: boolean; search?: string } = {}) {
    const reset = !!options.reset
    const searchQuery = options.search ?? systemGallerySearch
    const currentList = view === 'ready' ? systemGalleryReadyItems : systemGalleryUsedItems
    const offset = reset ? 0 : currentList.length

    setSystemGalleryLoading(true)
    setSystemGalleryError(null)
    try {
      const params = new URLSearchParams({
        namespace_id: CHIEB_NAMESPACE_ID,
        view,
        offset: String(offset),
        limit: String(SYSTEM_GALLERY_BATCH_SIZE),
      })
      if (searchQuery.trim()) params.set('q', searchQuery.trim())

      const response = await fetch(`/worker-api/api/dashboard/gallery?${params.toString()}`)
      if (!response.ok) throw new Error(`โหลดวิดีโอไม่สำเร็จ (${response.status})`)
      const payload = await response.json() as SystemGalleryResponse
      const incoming = Array.isArray(payload.videos) ? payload.videos : []

      if (view === 'ready') {
        setSystemGalleryReadyItems(reset ? incoming : [...systemGalleryReadyItems, ...incoming])
      } else {
        setSystemGalleryUsedItems(reset ? incoming : [...systemGalleryUsedItems, ...incoming])
      }
      setSystemGalleryReadyTotal(Number(payload.ready_total || 0))
      setSystemGalleryUsedTotal(Number(payload.used_total || 0))
      setSystemGalleryHasMore(!!payload.has_more)
    } catch (error) {
      setSystemGalleryError(error instanceof Error ? error.message : 'โหลดวิดีโอไม่สำเร็จ')
    } finally {
      setSystemGalleryLoading(false)
    }
  }

  useEffect(() => {
    if (tab !== 'gallery') return
    // Reset and load whenever switching tab or view
    void loadSystemGalleryPage(systemGalleryView, { reset: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, systemGalleryView])

  // Debounce search
  useEffect(() => {
    if (tab !== 'gallery') return
    const timer = setTimeout(() => {
      void loadSystemGalleryPage(systemGalleryView, { reset: true, search: systemGallerySearch })
    }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemGallerySearch])

  return (
    <div className="h-screen overflow-hidden bg-[#f6f8fb] text-slate-900">
      {/* Video Preview Popup */}
      {videoPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setVideoPreview(null)}
        >
          <div
            className="relative flex w-full max-w-4xl flex-col gap-4 md:flex-row md:items-stretch"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="close"
              onClick={() => setVideoPreview(null)}
              className="absolute -top-12 right-0 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white text-xl font-light backdrop-blur hover:bg-white/30"
            >
              ×
            </button>

            {/* Video — 9:16 on mobile (full-width), fixed width on desktop */}
            <div className="mx-auto w-full max-w-sm shrink-0 overflow-hidden rounded-2xl bg-black md:mx-0 md:w-[360px]">
              <div className="aspect-[9/16] w-full">
                <video
                  key={String(videoPreview.id)}
                  src={buildVideoPlaybackUrl(String(videoPreview.id), CHIEB_NAMESPACE_ID)}
                  poster={buildVideoThumbnailUrl(String(videoPreview.id), CHIEB_NAMESPACE_ID) || undefined}
                  className="h-full w-full object-cover"
                  controls
                  autoPlay
                  playsInline
                  preload="metadata"
                />
              </div>
            </div>

            {/* Details — stacks below on mobile, sits on right (flex-1) on desktop */}
            <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-2xl bg-white/10 p-4 text-white backdrop-blur md:max-w-md">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">คำบรรยาย</p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-white">
                  {pickVideoTitle(videoPreview)}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-xl bg-black/30 p-3 text-xs">
                <div>
                  <p className="text-white/50">Video ID</p>
                  <p className="mt-0.5 font-mono text-white">{String(videoPreview.id)}</p>
                </div>
                {videoPreview.duration ? (
                  <div>
                    <p className="text-white/50">ความยาว</p>
                    <p className="mt-0.5 text-white">{formatVideoDuration(videoPreview.duration)}</p>
                  </div>
                ) : null}
                {videoPreview.createdAt ? (
                  <div className="col-span-2">
                    <p className="text-white/50">สร้างเมื่อ</p>
                    <p className="mt-0.5 text-white">{formatThaiDate(String(videoPreview.createdAt))}</p>
                  </div>
                ) : null}
                {videoPreview.postedAt ? (
                  <div className="col-span-2">
                    <p className="text-white/50">โพสต์เมื่อ</p>
                    <p className="mt-0.5 text-white">{formatThaiDate(String(videoPreview.postedAt))}</p>
                  </div>
                ) : null}
              </div>

              <div className="mt-auto flex flex-wrap gap-2 pt-1">
                {String(videoPreview.shopeeLink || '').trim() && (
                  <a
                    href={String(videoPreview.shopeeLink)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-orange-500 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-600"
                  >
                    <ExternalLink size={12} /> Shopee
                  </a>
                )}
                {String(videoPreview.lazadaLink || '').trim() && (
                  <a
                    href={String(videoPreview.lazadaLink)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-pink-500 px-3 py-2 text-xs font-semibold text-white hover:bg-pink-600"
                  >
                    <ExternalLink size={12} /> Lazada
                  </a>
                )}
                <a
                  href={buildVideoPlaybackUrl(String(videoPreview.id), CHIEB_NAMESPACE_ID)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg bg-white/20 px-3 py-2 text-xs font-semibold text-white hover:bg-white/30"
                >
                  เปิดวิดีโอเต็ม
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Ad Popup */}
      {createAdPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => { if (!createAdCreating) { setCreateAdPopup(null); setCreateAdResultBanner(null) } }}>
          <div className="mx-4 w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-slate-900">สร้างแอด LikePage</h2>
            <p className="mt-1 text-sm text-slate-500">Video ID: {createAdPopup.videoId}</p>
            <p className="mt-1 truncate text-xs text-slate-400">{createAdPopup.caption}</p>

            <div className="mt-3">
              <p className="text-sm font-semibold text-slate-700">Shopee Link</p>
              <input
                type="text"
                value={createAdShopeeLink}
                onChange={(e) => setCreateAdShopeeLink(e.target.value)}
                placeholder="ใส่ลิ้ง Shopee สินค้า"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none"
              />
              {!createAdShopeeLink && <p className="mt-1 text-xs text-red-500">⚠️ ต้องมี Shopee link ถึงสร้างแอดได้</p>}
            </div>

            <div className="mt-4 space-y-3">
              <p className="text-sm font-semibold text-slate-700">เลือกแคมเปญ</p>
              {createAdLoading ? (
                <div className="h-12 rounded-xl bg-slate-100 animate-pulse" />
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {createAdCampaigns.map((camp) => (
                    <button
                      key={camp.id}
                      onClick={() => { setCreateAdSelectedCampaign(camp.id); setCreateAdNewCampaignName('') }}
                      className={`w-full rounded-xl border p-3 text-left transition ${createAdSelectedCampaign === camp.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-slate-900">{camp.name} ({camp.adsetCount} adsets)</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${camp.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{camp.status}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-400">{camp.id}</p>
                    </button>
                  ))}
                </div>
              )}

              <div className="relative">
                <div className="absolute inset-x-0 top-1/2 border-t border-slate-200" />
                <p className="relative mx-auto w-fit bg-white px-3 text-xs text-slate-400">หรือ</p>
              </div>

              <div>
                <p className="text-sm font-semibold text-slate-700">สร้างแคมเปญใหม่</p>
                <input
                  type="text"
                  placeholder="ชื่อแคมเปญใหม่ เช่น ADS_PUBLISH_11"
                  value={createAdNewCampaignName}
                  onChange={(e) => { setCreateAdNewCampaignName(e.target.value); setCreateAdSelectedCampaign('') }}
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Persistent result banner — shown AFTER request finishes, stays until user
                 retries or cancels. Critical so user doesn't miss success/error message. */}
            {!createAdCreating && createAdResultBanner && (
              <div className={`mt-6 rounded-xl p-4 text-sm font-semibold ${
                createAdResultBanner.type === 'success'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                <p className="whitespace-pre-wrap break-words">{createAdResultBanner.text}</p>
              </div>
            )}

            {createAdCreating ? (
              <div className="mt-6 space-y-3">
                <div className="rounded-xl bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-900">{createAdStep}</p>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-[#1877f2] transition-all duration-700"
                      style={{ width: `${createAdProgress}%` }}
                    />
                  </div>
                  <p className="mt-2 text-right text-xs text-slate-400">{createAdProgress}%</p>
                </div>
              </div>
            ) : (
              <div className="mt-6 space-y-2">
                <div className="flex gap-3">
                  <button
                    onClick={() => { setCreateAdPopup(null); setCreateAdResultBanner(null) }}
                    className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-700"
                  >
                    ยกเลิก
                  </button>
                  <button
                    onClick={() => void submitCreateAd()}
                    disabled={!createAdSelectedCampaign && !createAdNewCampaignName}
                    className="flex-1 rounded-xl bg-[#1877f2] py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    เพิ่มเข้าคิว
                  </button>
                </div>
                <button
                  onClick={() => void submitCreateAdImmediate()}
                  disabled={!createAdSelectedCampaign && !createAdNewCampaignName}
                  title="รันเลยโดยไม่รอคิว 20 นาที (ใช้เวลา ~60-120 วินาที)"
                  className="w-full rounded-xl bg-orange-500 hover:bg-orange-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50 transition-colors"
                >
                  ⚡ โพสต์เลย (ข้ามคิว)
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex h-full min-h-0 flex-col lg:flex-row">
        <aside className="w-full shrink-0 border-b border-slate-200 bg-white lg:h-screen lg:w-72 lg:border-b-0 lg:border-r">
          <div className="flex h-full flex-col overflow-hidden p-3">
            <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1877f2] text-white">
                  <Megaphone size={18} />
                </div>
                <div>
                  <p className="text-sm font-semibold">Ads Manager</p>
                  <p className="text-xs text-slate-500">LIKE_PAGE dashboard</p>
                </div>
              </div>
              <button className="rounded-xl border border-slate-200 bg-white p-2 text-slate-500">
                <Search size={16} />
              </button>
            </div>

            <nav className="mt-4 space-y-1.5">
              {([
                { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
                { id: 'gallery', label: 'แกลลี่', icon: Layers },
                { id: 'page-posts', label: 'โพสต์เพจ', icon: Facebook },
                { id: 'running', label: 'Campaigns', icon: Megaphone },
                { id: 'create', label: 'Create Ads', icon: Users },
                { id: 'queue', label: 'คิวสร้างแอด', icon: Clock },
                { id: 'history', label: 'History', icon: MessageCircle },
              ] as const).map(({ id, label, icon: Icon }) => {
                const active = tab === id
                return (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={`flex w-full items-center justify-between rounded-2xl px-3 py-2.5 text-left transition ${
                      active ? 'bg-slate-900 text-white' : 'bg-transparent text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Icon size={17} className={active ? 'text-white' : 'text-slate-400'} />
                      <span className="text-sm font-medium">{label}</span>
                    </span>
                    <ChevronRight size={15} className={active ? 'text-white/70' : 'text-slate-300'} />
                  </button>
                )
              })}
            </nav>

            <div className="mt-auto hidden space-y-1.5 lg:block">
              <button
                onClick={() => setTab('settings')}
                className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm transition ${
                  tab === 'settings' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Settings2 size={15} className={tab === 'settings' ? 'text-white' : 'text-slate-400'} />
                <span>Settings</span>
              </button>
            </div>
          </div>
        </aside>

        <div className="min-w-0 min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#f6f8fb]">
            <header className="sticky top-0 z-30 shrink-0 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-slate-100 p-2 text-slate-600">
                  <BarChart3 size={16} />
                </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">
                        {tab === 'dashboard' && 'Campaigns'}
                        {tab === 'gallery' && 'แกลลี่วิดีโอในระบบ'}
                        {tab === 'page-posts' && 'โพสต์เพจเฉียบ'}
                        {tab === 'create' && 'Create Ads'}
                        {tab === 'running' && 'Campaigns'}
                        {tab === 'queue' && 'คิวสร้างแอด'}
                        {tab === 'history' && 'History'}
                      {tab === 'settings' && 'Settings'}
                    </p>
                    {tab === 'gallery' && (
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                        {systemGalleryView === 'ready' ? systemGalleryReadyTotal : systemGalleryUsedTotal} videos
                      </span>
                    )}
                    {tab === 'page-posts' && (
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                        {galleryLinkedItems.length} videos
                      </span>
                    )}
                    </div>
                    <p className="text-xs text-slate-500">
                      {tab === 'page-posts' && gallerySyncState?.lastSyncedAt
                        ? `sync ล่าสุด ${formatThaiDate(gallerySyncState.lastSyncedAt)}`
                        : tab === 'gallery'
                          ? 'คลิปที่ import เข้าระบบแล้ว'
                          : 'Ads manager workspace'}
                    </p>
                  </div>
                </div>
              <div className="flex items-center gap-2">
                <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600">
                  Electron Token
                </button>
                <button className="rounded-xl bg-[#1877f2] px-3 py-2 text-sm font-semibold text-white">
                  Open Ads Manager
                </button>
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6">
              {tab === 'dashboard' && (
                <div className="space-y-4">
                  <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {summaryCards.map(({ label, value, meta, icon: Icon }) => (
                      <div key={label} className="rounded-3xl border border-slate-200 bg-white p-4">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-medium text-slate-500">{label}</p>
                          <Icon size={16} className="text-slate-400" />
                        </div>
                        <div className="mt-4 flex items-end justify-between gap-3">
                          <p className="text-3xl font-semibold tracking-tight">{value}</p>
                          <span className={`text-sm font-semibold ${meta.startsWith('-') ? 'text-red-500' : 'text-emerald-600'}`}>{meta}</span>
                        </div>
                      </div>
                    ))}
                  </section>

                  <section className="grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
                    <Card title="Monthly views" subtitle="Last month">
                      <div className="rounded-3xl border border-slate-200 bg-gradient-to-b from-emerald-50/80 via-white to-white p-4">
                        <div className="relative h-72 overflow-hidden rounded-2xl">
                          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,transparent_24%,rgba(148,163,184,0.14)_24%,rgba(148,163,184,0.14)_25%,transparent_25%,transparent_49%,rgba(148,163,184,0.14)_49%,rgba(148,163,184,0.14)_50%,transparent_50%,transparent_74%,rgba(148,163,184,0.14)_74%,rgba(148,163,184,0.14)_75%,transparent_75%)]" />
                          <svg viewBox="0 0 100 50" className="absolute inset-0 h-full w-full">
                            <defs>
                              <linearGradient id="viewsFill" x1="0" x2="0" y1="0" y2="1">
                                <stop offset="0%" stopColor="rgba(16,185,129,0.20)" />
                                <stop offset="100%" stopColor="rgba(16,185,129,0.02)" />
                              </linearGradient>
                            </defs>
                            <path d="M0 42 C8 38, 10 45, 18 36 S30 20, 38 32 S46 16, 54 12 S62 34, 70 24 S78 28, 86 14 S94 18, 100 10" fill="none" stroke="#16a34a" strokeWidth="1.8" />
                            <path d="M0 50 L0 42 C8 38, 10 45, 18 36 S30 20, 38 32 S46 16, 54 12 S62 34, 70 24 S78 28, 86 14 S94 18, 100 10 L100 50 Z" fill="url(#viewsFill)" />
                          </svg>
                          <div className="absolute bottom-2 right-3 text-xs text-slate-400">Apr 30</div>
                          <div className="absolute left-2 top-2 text-xs text-slate-400">300k</div>
                          <div className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">150k</div>
                          <div className="absolute bottom-2 left-2 text-xs text-slate-400">0</div>
                        </div>
                      </div>
                    </Card>

                    <Card title="Recent uploads" subtitle="ล่าสุดจากระบบ">
                      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                        {recentUploads.map((image, index) => (
                          <div key={image} className="overflow-hidden rounded-3xl border border-slate-200 bg-white">
                            <img src={image} alt={`Recent ${index + 1}`} className="h-36 w-full object-cover" />
                            <div className="border-t border-slate-100 px-3 py-2">
                              <p className="truncate text-xs font-semibold text-slate-900">{[5800, 133000, 35000, 89200][index].toLocaleString()} views</p>
                              <p className="mt-1 text-[11px] text-slate-400">{[2, 4, 7, 9][index]}d ago</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </Card>
                  </section>

                  <Card title="Campaigns" subtitle="รายการจำลองให้ใกล้ template ต้นฉบับ">
                    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex flex-1 items-center gap-2">
                        <input className="field-input max-w-md" placeholder="Search campaigns..." />
                        <button className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600">Filter</button>
                        <button className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600">Sort</button>
                      </div>
                      <button className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white">+ New campaign</button>
                    </div>
                    <div className="overflow-hidden rounded-3xl border border-slate-200">
                      <div className="overflow-auto">
                        <table className="min-w-full divide-y divide-slate-200 text-sm">
                          <thead className="bg-slate-50 text-left text-slate-400">
                            <tr>
                              {['Campaign name', 'Status', 'Platforms', 'Pay rate', 'Creators', 'Submissions', 'Paid', 'Budget'].map((head) => (
                                <th key={head} className="px-4 py-3 font-medium">{head}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 bg-white">
                            {campaignRows.map((row) => (
                              <tr key={row.name}>
                                <td className="px-4 py-3 font-medium text-slate-900">{row.name}</td>
                                <td className="px-4 py-3">
                                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                                    row.status === 'Live' ? 'bg-emerald-50 text-emerald-700' : row.status === 'Paused' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'
                                  }`}>
                                    {row.status}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-slate-500">{row.platform}</td>
                                <td className="px-4 py-3 font-medium text-emerald-600">{row.payRate}</td>
                                <td className="px-4 py-3 text-slate-500">{row.creators}</td>
                                <td className="px-4 py-3 text-slate-500">{row.submissions}</td>
                                <td className="px-4 py-3 text-slate-700">{row.paid}</td>
                                <td className="px-4 py-3 text-slate-700">{row.budget}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </Card>
                </div>
              )}

              {tab === 'create' && (
                <div className="grid gap-4 xl:grid-cols-[1.05fr,0.95fr]">
                  <Card
                    title="วิดีโอจาก Gallery"
                    subtitle="mock layout สำหรับหน้าเลือกสร้างแอด"
                    action={<button className="rounded-xl bg-[#1877f2] px-4 py-2 text-sm font-semibold text-white">สร้าง {selectedVideos.length} แอด</button>}
                  >
                    <div className="space-y-3">
                      {videoCandidates.map((video) => {
                        const checked = selectedVideos.includes(video.id)
                        return (
                          <button
                            key={video.id}
                            onClick={() =>
                              setSelectedVideos((current) =>
                                checked ? current.filter((id) => id !== video.id) : [...current, video.id],
                              )
                            }
                            className={`grid w-full grid-cols-[96px,1fr] gap-4 rounded-3xl border p-3 text-left transition ${
                              checked ? 'border-[#1877f2] bg-blue-50/60' : 'border-slate-200 bg-white'
                            }`}
                          >
                            <img src={video.thumbnail} alt={video.title} className="h-28 w-full rounded-2xl object-cover" />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-semibold text-slate-900">{video.title}</p>
                                  <p className="mt-1 text-xs text-slate-400">ID {video.id} • {video.duration}</p>
                                </div>
                                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${statusClass[video.status]}`}>
                                  {video.status === 'ready' ? 'พร้อมสร้าง' : video.status === 'queued' ? 'รอคิว' : 'กำลังสร้าง'}
                                </span>
                              </div>
                              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                                {video.shopeeLink}
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </Card>

                  <Card title="Progress" subtitle="เตรียมไว้สำหรับขั้นตอน create-ad จริง">
                    <div className="space-y-3">
                      {selectedItems.length === 0 ? (
                        <EmptyState title="ยังไม่ได้เลือกวิดีโอ" description="เลือกวิดีโออย่างน้อย 1 ตัวก่อนสร้างแอด" />
                      ) : (
                        selectedItems.map((item, index) => (
                          <div key={item.id} className="rounded-3xl border border-slate-200 bg-white p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                                <p className="text-xs text-slate-400">ลำดับ {index + 1}</p>
                              </div>
                              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">waiting</span>
                            </div>
                            <div className="mt-4 space-y-2">
                              {['uploading', 'thumbnails', 'creative', 'story_id', 'activate'].map((step) => (
                                <div key={step} className="flex items-center gap-3 text-sm text-slate-500">
                                  <div className="h-2 w-2 rounded-full bg-slate-300" />
                                  <span>{step}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </Card>
                </div>
              )}

              {tab === 'gallery' && (
                <div className="space-y-4">
                  <div className="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2 rounded-full bg-slate-100 p-1">
                      <button
                        onClick={() => setSystemGalleryView('ready')}
                        className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${systemGalleryView === 'ready' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                      >
                        ยังไม่โพสต์ ({systemGalleryReadyTotal})
                      </button>
                      <button
                        onClick={() => setSystemGalleryView('used')}
                        className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${systemGalleryView === 'used' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                      >
                        โพสต์แล้ว ({systemGalleryUsedTotal})
                      </button>
                    </div>
                    <div className="relative flex-1 sm:max-w-sm">
                      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        value={systemGallerySearch}
                        onChange={(e) => setSystemGallerySearch(e.target.value)}
                        placeholder="ค้นหา video id หรือชื่อคลิป"
                        className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-slate-400"
                      />
                    </div>
                  </div>
                  {systemGalleryError ? (
                    <EmptyState title="โหลดวิดีโอไม่สำเร็จ" description={systemGalleryError} />
                  ) : null}
                  {(() => {
                    const items = systemGalleryView === 'ready' ? systemGalleryReadyItems : systemGalleryUsedItems
                    if (systemGalleryLoading && items.length === 0) {
                      return <EmptyState title="กำลังโหลดวิดีโอ" description="ดึงคลิปจากฐานข้อมูลระบบ" />
                    }
                    if (items.length === 0 && !systemGalleryError) {
                      return (
                        <EmptyState
                          title={systemGalleryView === 'ready' ? 'ยังไม่มีคลิปที่รอโพสต์' : 'ยังไม่มีคลิปที่โพสต์แล้ว'}
                          description={systemGalleryView === 'ready'
                            ? 'กด import วิดีโอเข้าระบบจาก mobile app เพื่อเริ่ม'
                            : 'เมื่อ cron โพสต์คลิปใดแล้ว จะย้ายมาแท็บนี้อัตโนมัติ'}
                        />
                      )
                    }
                    return (
                      <>
                        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                          {items.map((video) => {
                            const vid = String(video.id || '')
                            const title = pickVideoTitle(video)
                            const durationText = formatVideoDuration(video.duration)
                            const thumb = buildVideoThumbnailUrl(vid, CHIEB_NAMESPACE_ID)
                            const linked = hasAffiliateLink(video)
                            return (
                              <article key={vid} className="group overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_4px_16px_rgba(15,23,42,0.04)] transition hover:shadow-[0_8px_30px_rgba(15,23,42,0.08)]">
                                <button
                                  type="button"
                                  onClick={() => setVideoPreview(video)}
                                  className="relative block aspect-[9/16] w-full overflow-hidden bg-slate-100 text-left active:scale-[0.98] transition-transform"
                                >
                                  {thumb ? (
                                    <img src={thumb} alt={vid} loading="lazy" className="h-full w-full object-cover" />
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
                                      <PlaySquare size={28} />
                                    </div>
                                  )}
                                  <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                                    <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-white/90 text-slate-900 shadow-lg backdrop-blur">
                                      <PlaySquare size={22} />
                                    </span>
                                  </div>
                                  {linked && (
                                    <span className="absolute left-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#1877f2] text-white shadow-sm">
                                      <ExternalLink size={13} />
                                    </span>
                                  )}
                                  {durationText && (
                                    <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-2 py-0.5 text-[11px] font-semibold text-white">
                                      {durationText}
                                    </span>
                                  )}
                                </button>
                                <div className="space-y-2 p-3">
                                  <p className="line-clamp-2 text-sm font-medium text-slate-900">{title || vid}</p>
                                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                                    <span className="truncate font-mono">{vid}</span>
                                    {systemGalleryView === 'used' && video.postedAt
                                      ? <span>{formatThaiDate(String(video.postedAt))}</span>
                                      : null}
                                  </div>
                                </div>
                              </article>
                            )
                          })}
                        </div>
                        {systemGalleryHasMore && (
                          <div className="flex justify-center pt-2">
                            <button
                              onClick={() => void loadSystemGalleryPage(systemGalleryView, { reset: false })}
                              disabled={systemGalleryLoading}
                              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {systemGalleryLoading ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}
                            </button>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              )}

              {tab === 'page-posts' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-slate-500">
                      {gallerySyncState?.fullyScanned
                        ? 'ดึงครบถึงโพสต์เก่าสุดที่ระบบบันทึกไว้แล้ว'
                        : gallerySyncState?.nextAfter
                          ? 'มีโพสต์เก่ารอโหลดเพิ่ม'
                          : 'พร้อมดึงโพสต์ชุดแรกจาก Facebook'}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => void refreshAllGalleryViews()}
                        disabled={gallerySyncing}
                        title="ยิง Facebook API ทุกคลิปในแคชแล้วอัปเดตยอดวิวล่าสุด (ใช้ตอนยอดวิวค้าง/ไม่ตรง)"
                        className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 hover:bg-orange-600 transition-colors"
                      >
                        {gallerySyncing ? 'กำลังรีเฟรช…' : '🔄 รีเฟรชยอดวิวทั้งหมด'}
                      </button>
                      <button
                        onClick={() => void syncNextGalleryBatch()}
                        disabled={gallerySyncing}
                        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {gallerySyncing ? 'กำลังโหลด…' : galleryLinkedItems.length > 0 ? 'โหลดโพสต์เพิ่ม' : 'ดึงโพสต์จาก Facebook'}
                      </button>
                    </div>
                  </div>
                  {galleryLoading ? (
                    <EmptyState title="กำลังโหลดโพสต์จากฐานข้อมูล" description="อ่านโพสต์ที่เคย sync ไว้ใน worker ก่อน แล้วค่อยโหลดเพิ่มเฉพาะของใหม่" />
                  ) : galleryError ? (
                    <EmptyState title="โหลดโพสต์ไม่สำเร็จ" description={galleryError} />
                  ) : galleryLinkedItems.length === 0 ? (
                    <EmptyState title="ยังไม่มีโพสต์ในคลัง" description="กดดึงโพสต์จาก Facebook เพื่อเริ่มเก็บลงฐานข้อมูลของ worker" />
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-6">
                      {galleryLinkedItems.map((item) => (
                        <article key={item.storyId} className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
                          <a
                            href={item.postUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="relative block aspect-[3/5] overflow-hidden bg-slate-100"
                          >
                            <img src={item.facebookThumb} alt={item.storyId} className="h-full w-full object-cover" />
                            <div className="absolute inset-x-0 top-0 flex items-start justify-between p-3">
                              <span className="rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">
                                {CHIEB_PAGE_NAME}
                              </span>
                              <span className="rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">
                                {formatCompactViews(item.views)} views
                              </span>
                            </div>
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 text-white">
                              <p className="line-clamp-2 text-sm font-semibold leading-5">
                                {item.videoTitle}
                              </p>
                              <div className="mt-2 flex items-center gap-2 text-xs text-white/80">
                                <PlaySquare size={13} />
                                <span>{item.postedAt}</span>
                              </div>
                            </div>
                          </a>
                          <div className="space-y-3 p-3">
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Post ID</p>
                              <p className="mt-1 truncate text-sm font-medium text-slate-900">{item.storyId}</p>
                            </div>
                            <div className="grid grid-cols-1 gap-2">
                              <button
                                onClick={() => openCreateAdPopup(item.videoId, item.videoTitle || '', item.storyId || '', item.shopeeLink || '')}
                                className="rounded-xl bg-[#1877f2] px-3 py-2 text-sm font-semibold text-white active:scale-95 transition-transform"
                              >
                                สร้างแอด
                              </button>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === 'running' && (
                <Card title="Campaigns" subtitle="Real-time จาก Facebook Ads Manager">
                  {campaignsLoading ? (
                    <div className="space-y-3">
                      {[1,2].map(i => <div key={i} className="h-32 rounded-3xl bg-slate-100 animate-pulse" />)}
                    </div>
                  ) : liveCampaigns.length === 0 ? (
                    <EmptyState title="ไม่มีแคมเปญ" description="ยังไม่มีแคมเปญใน ad account นี้" />
                  ) : (
                  <div className="space-y-3">
                    {liveCampaigns.map((camp) => (
                      <div key={camp.id} className="rounded-3xl border border-slate-200 bg-white p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div>
                                <p className="text-base font-semibold text-slate-950">{camp.name}</p>
                                <p className="text-[11px] text-slate-400">ID: {camp.id}</p>
                              </div>
                              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${camp.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700' : camp.status === 'PAUSED' ? 'bg-amber-50 text-amber-700' : 'bg-slate-50 text-slate-500'}`}>
                                {camp.status}
                              </span>
                            </div>
                            <p className="mt-2 text-sm text-slate-500">{camp.activeAdsetCount} active adsets / {camp.adsetCount} total • Budget: ฿{(Number(camp.dailyBudget || 0) / 100).toLocaleString()}/day</p>
                          </div>

                          <div className="grid grid-cols-3 gap-2">
                            <MetricChip label="Reach" value={Number(camp.reach).toLocaleString()} />
                            <MetricChip label="Impressions" value={Number(camp.impressions).toLocaleString()} />
                            <MetricChip label="Spend" value={`฿${Number(camp.spend).toLocaleString()}`} />
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          <button onClick={() => void loadCampaigns()} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">รีเฟรช</button>
                          <a href={`https://www.facebook.com/adsmanager/manage/campaigns?act=${settings.adAccount?.replace('act_','')}&campaign_ids=${camp.id}`} target="_blank" rel="noopener" className="rounded-xl bg-[#1877f2] px-4 py-2 text-sm font-semibold text-white">เปิดใน Ads Manager</a>
                        </div>
                      </div>
                    ))}
                  </div>
                  )}
                </Card>
              )}

              {tab === 'queue' && (
                <Card
                  title="คิวสร้างแอด"
                  subtitle={`ระบบจะหยิบงาน "queued" ตัวเก่าสุดมารันทุก ${adQueueIntervalMinutes} นาที — รวมการสร้างแอดและโพสต์ไปเพจในขั้นตอนเดียว`}
                  action={
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void loadAdQueue()}
                        disabled={adQueueLoading}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
                      >
                        {adQueueLoading ? 'กำลังโหลด...' : '↻ รีเฟรช'}
                      </button>
                      <button
                        onClick={() => void runQueueNow()}
                        disabled={adQueueLoading || !(adQueueCounts.queued && adQueueCounts.queued > 0)}
                        className="rounded-xl bg-orange-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 hover:bg-orange-600"
                      >
                        ⚡ รันตอนนี้เลย (ข้าม cron)
                      </button>
                    </div>
                  }
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    {[
                      { key: 'queued', label: 'รอคิว', color: 'bg-blue-50 text-blue-700' },
                      { key: 'processing', label: 'กำลังรัน', color: 'bg-amber-50 text-amber-700' },
                      { key: 'done', label: 'สำเร็จ', color: 'bg-emerald-50 text-emerald-700' },
                      { key: 'failed', label: 'ล้มเหลว', color: 'bg-red-50 text-red-700' },
                      { key: 'cancelled', label: 'ยกเลิก', color: 'bg-slate-100 text-slate-500' },
                    ].map(({ key, label, color }) => (
                      <div key={key} className={`rounded-2xl ${color} px-3 py-3 text-center`}>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-75">{label}</p>
                        <p className="mt-1 text-xl font-bold">{adQueueCounts[key] || 0}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    <p>
                      <span className="font-semibold">รันล่าสุด:</span>{' '}
                      {adQueueLastRun ? formatThaiDateTime(adQueueLastRun) : 'ยังไม่เคยรัน'}
                    </p>
                    <p className="mt-1">
                      <span className="font-semibold">รันถัดไป (โดยประมาณ):</span>{' '}
                      {adQueueNextRun ? formatThaiDateTime(adQueueNextRun) : '-'}
                    </p>
                  </div>
                  <div className="mt-5 space-y-2">
                    {adQueueItems.length === 0 ? (
                      <EmptyState title="ยังไม่มีงานในคิว" description='กดสร้างแอดในแท็บ "โพสต์เพจ" จะถูกเพิ่มเข้าคิวที่นี่' />
                    ) : (
                      adQueueItems.map((item) => {
                        const statusColor =
                          item.status === 'done' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                          item.status === 'failed' ? 'bg-red-50 text-red-700 border-red-200' :
                          item.status === 'processing' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                          item.status === 'cancelled' ? 'bg-slate-100 text-slate-500 border-slate-200' :
                          'bg-blue-50 text-blue-700 border-blue-200'
                        return (
                          <div key={item.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusColor}`}>
                                    {item.status}
                                  </span>
                                  <span className="text-xs text-slate-400">#{item.id}</span>
                                  <span className="text-xs text-slate-500">{formatThaiDateTime(item.created_at)}</span>
                                </div>
                                <p className="mt-1.5 truncate text-sm font-medium text-slate-900">
                                  {item.caption || `Video ${item.video_id}`}
                                </p>
                                <p className="mt-0.5 truncate text-[11px] text-slate-400">
                                  video_id: {item.video_id} • campaign: {item.campaign_id || item.new_campaign_name || '-'}
                                </p>
                                {item.shopee_url && (
                                  <p className="mt-0.5 truncate text-[11px] text-slate-400">shopee: {item.shopee_url}</p>
                                )}
                                {item.error_message && (
                                  <p className="mt-1 text-xs text-red-600">⚠ {item.error_message}</p>
                                )}
                                {item.result_story_id && (
                                  <a
                                    href={`https://www.facebook.com/${item.result_story_id.replace('_', '/posts/')}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-[#1877f2]"
                                  >
                                    <ExternalLink size={12} /> ดูโพสต์
                                  </a>
                                )}
                              </div>
                              {item.status === 'queued' && (
                                <button
                                  onClick={() => void cancelQueueItem(item.id)}
                                  className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                                >
                                  ยกเลิก
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </Card>
              )}

              {tab === 'history' && (
                <Card title="ประวัติการเผยแพร่" subtitle="แสดงโพสต์ที่ promote แล้ว">
                  <div className="space-y-3">
                    {historyItems.map((item) => (
                      <div key={item.storyId} className="rounded-3xl border border-slate-200 bg-white p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-base font-semibold text-slate-950">{item.pageName}</p>
                            <p className="mt-1 text-sm text-slate-500">{item.storyId}</p>
                          </div>
                          <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                            {item.publishedAt}
                          </div>
                        </div>
                        <a href={item.postUrl} target="_blank" rel="noreferrer" className="mt-3 flex items-center gap-2 break-all text-sm font-medium text-[#1877f2]">
                          <ExternalLink size={15} />
                          <span>{item.postUrl}</span>
                        </a>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {tab === 'settings' && (
                <div className="grid gap-4 xl:grid-cols-[0.95fr,1.05fr]">
                  <Card title="Shortlink / Comment" subtitle="ค่าหลักที่ระบบสร้างแอดจะใช้">
                    <div className="grid gap-4">
                      <Field label="Sub ID 1" help="utm_content ตัวที่ 1">
                        <input value={settings.subId} onChange={(e) => setSettings((c) => ({ ...c, subId: e.target.value }))} className="field-input" placeholder="เช่น yok" />
                      </Field>
                      <Field label="Sub ID 2" help="utm_content ตัวที่ 2">
                        <input value={settings.subId2} onChange={(e) => setSettings((c) => ({ ...c, subId2: e.target.value }))} className="field-input" />
                      </Field>
                      <Field label="Sub ID 3" help="utm_content ตัวที่ 3">
                        <input value={settings.subId3} onChange={(e) => setSettings((c) => ({ ...c, subId3: e.target.value }))} className="field-input" />
                      </Field>
                      <Field label="Sub ID 4" help="utm_content ตัวที่ 4">
                        <input value={settings.subId4} onChange={(e) => setSettings((c) => ({ ...c, subId4: e.target.value }))} className="field-input" />
                      </Field>
                      <Field label="Sub ID 5" help="utm_content ตัวที่ 5">
                        <input value={settings.subId5} onChange={(e) => setSettings((c) => ({ ...c, subId5: e.target.value }))} className="field-input" />
                      </Field>
                      <Field label="Shortlink URL" help="รูปแบบ https://short.wwoom.com/?account=CHEARB&url={url}&sub1={sub_id}">
                        <textarea
                          value={settings.shortlinkUrl}
                          onChange={(event) => setSettings((current) => ({ ...current, shortlinkUrl: event.target.value }))}
                          rows={3}
                          className="field-input resize-none"
                        />
                      </Field>
                      <Field label="เทมเพลตตอบคอมเมนต์" help="ใช้ {shopee_link} เป็น placeholder">
                        <textarea
                          value={settings.commentTemplate}
                          onChange={(event) => setSettings((current) => ({ ...current, commentTemplate: event.target.value }))}
                          rows={3}
                          className="field-input resize-none"
                        />
                      </Field>
                      <Field label="Facebook Sync Token" help="ใช้ token นี้สำหรับ sync โพสต์เข้า D1 เท่านั้น ไม่ผ่าน Electron">
                        <textarea
                          value={settings.facebookSyncToken}
                          onChange={(event) => setSettings((current) => ({ ...current, facebookSyncToken: event.target.value }))}
                          rows={6}
                          className="field-input resize-none font-mono text-xs"
                          placeholder="วาง Facebook access token"
                        />
                        <div className="mt-2 text-xs text-slate-400">
                          {settingsLoading
                            ? 'กำลังโหลด token...'
                            : settings.facebookSyncTokenUpdatedAt
                              ? `อัปเดตล่าสุด ${formatThaiDate(settings.facebookSyncTokenUpdatedAt)}`
                              : 'ยังไม่ได้บันทึก token'}
                        </div>
                      </Field>
                    </div>
                  </Card>

                  <Card title="Facebook / Scheduling" subtitle="ค่า default จากสเปกปัจจุบัน">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Default Page">
                        <input
                          value={settings.defaultPage}
                          onChange={(event) => setSettings((current) => ({ ...current, defaultPage: event.target.value }))}
                          className="field-input"
                        />
                      </Field>
                      <Field label="Ad Account">
                        <input
                          value={settings.adAccount}
                          onChange={(event) => setSettings((current) => ({ ...current, adAccount: event.target.value }))}
                          className="field-input"
                        />
                      </Field>
                      <Field label="Template Adset">
                        <input
                          value={settings.templateAdset}
                          onChange={(event) => setSettings((current) => ({ ...current, templateAdset: event.target.value }))}
                          className="field-input"
                        />
                      </Field>
                      <Field label="Campaign Prefix">
                        <input
                          value={settings.campaignPrefix}
                          onChange={(event) => setSettings((current) => ({ ...current, campaignPrefix: event.target.value }))}
                          className="field-input"
                        />
                      </Field>
                      <Field label="จำนวนแอดต่อรอบ">
                        <input
                          value={settings.adsPerRound}
                          onChange={(event) => setSettings((current) => ({ ...current, adsPerRound: event.target.value }))}
                          className="field-input"
                        />
                      </Field>
                      <Field label="เวลาสร้างแอดอัตโนมัติ">
                        <input
                          value={settings.autoCreateTime}
                          onChange={(event) => setSettings((current) => ({ ...current, autoCreateTime: event.target.value }))}
                          className="field-input"
                        />
                      </Field>
                    </div>
                    {settingsMessage ? <p className="mt-4 text-sm text-slate-500">{settingsMessage}</p> : null}
                    <button
                      onClick={() => void saveDashboardSettings()}
                      disabled={settingsSaving}
                      className="mt-5 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {settingsSaving ? 'กำลังบันทึก...' : 'บันทึกตั้งค่า'}
                    </button>
                  </Card>
                </div>
              )}
            </main>
          </div>
        </div>
      </div>
    </div>
  )
}

function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold tracking-tight text-slate-950">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        {action}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  )
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-24 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-center">
      <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-950">{value}</p>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center">
      <p className="text-base font-semibold text-slate-950">{title}</p>
      <p className="mt-2 text-sm text-slate-500">{description}</p>
    </div>
  )
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-900">{label}</span>
      {help ? <span className="mt-1 block text-xs text-slate-400">{help}</span> : null}
      <div className="mt-2">{children}</div>
    </label>
  )
}
