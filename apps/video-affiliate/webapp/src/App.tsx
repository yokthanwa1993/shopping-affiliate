import { useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react'
import { API_BASE_URL } from './apiBaseUrl'
import { getAppTabPath, getInviteNamespaceFromSearch, getMergedSearchParams, type AppTabRoute } from './app/appRoutes'
import { useViewerHistory } from './app/hooks/useViewerHistory'
import { Thumb } from './app/components/Thumb'
import { getInboxVideoIdentityKey } from './app/inboxUtils'
import type { DashboardData, InboxVideo } from './app/sharedTypes'
import { DashboardTab } from './app/tabs/DashboardTab'
import { InboxTab } from './app/tabs/InboxTab'
import { ProcessingTab } from './app/tabs/ProcessingTab'
import { BottomNav } from './app/components/BottomNav'
import { getMainLiffInitOptionsForHost, getMainLiffUrlForHost, isAppHost, waitForLiffSdk } from './liffConfig'


const WORKER_URL = API_BASE_URL

const GALLERY_HEADER_TOP_GAP = 8
const VERTICAL_VIEWER_FRAME_STYLE = {
  width: '100%',
  maxWidth: 'calc((56svh * 9) / 16)',
  aspectRatio: '9 / 16',
} as const

const COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER = '{{shopee_link}}'
const COMMENT_TEMPLATE_LAZADA_PLACEHOLDER = '{{lazada_link}}'
const DEFAULT_GEMINI_KEY_SLOTS = 5
const createEmptyGeminiKeySlots = (count = DEFAULT_GEMINI_KEY_SLOTS) => Array.from({ length: Math.max(0, count) }, () => '')
const DEFAULT_COMMENT_TEMPLATE = `📌 พิกัดอยู่ตรงนี้เลย กดเข้าไปดูเองได้ 👇
🧡 Shopee : {{shopee_link}}
💙 Lazada : {{lazada_link}}

✨ ของจริงงานดีนะ ลองเข้าไปส่องก่อน 👀🛍️
🛡️ เพจเราเป็น Partner Shopee & Lazada ปลอดภัย ✅💯`

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

const normalizeSessionToken = (value?: string | null) => {
  const token = String(value || '').trim()
  return token.startsWith('sess_') ? token : ''
}

const getToken = (botScope = getBotScopeFromLocation()) =>
  normalizeSessionToken(localStorage.getItem(scopedStorageKey('auth_token', botScope)));

const readCache = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const writeCache = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { }
}

const getStoredNamespace = (botScope = getBotScopeFromLocation()) => {
  try { return String(localStorage.getItem(scopedStorageKey('auth_namespace', botScope)) || '').trim() } catch { return '' }
}

const getStoredShortlinkBaseUrl = (botScope = getBotScopeFromLocation()) => {
  try { return String(localStorage.getItem(scopedStorageKey('shortlink_base_url', botScope)) || '').trim() } catch { return '' }
}

const getStoredShortlinkAccount = (botScope = getBotScopeFromLocation()) => {
  try { return String(localStorage.getItem(scopedStorageKey('shortlink_account', botScope)) || '').trim() } catch { return '' }
}

const getStoredLazadaShortlinkBaseUrl = (botScope = getBotScopeFromLocation()) => {
  try { return String(localStorage.getItem(scopedStorageKey('lazada_shortlink_base_url', botScope)) || '').trim() } catch { return '' }
}

const getStoredShortlinkExpectedUtmId = (botScope = getBotScopeFromLocation()) => {
  try { return String(localStorage.getItem(scopedStorageKey('shortlink_expected_utm_id', botScope)) || '').trim() } catch { return '' }
}

const getStoredLazadaExpectedMemberId = (botScope = getBotScopeFromLocation()) => {
  try { return String(localStorage.getItem(scopedStorageKey('lazada_expected_member_id', botScope)) || '').trim() } catch { return '' }
}

const hasStoredAffiliateShortlinkConfig = (botScope = getBotScopeFromLocation()) => {
  const account = getStoredShortlinkAccount(botScope)
  const shopeeBase = getStoredShortlinkBaseUrl(botScope)
  const lazadaBase = getStoredLazadaShortlinkBaseUrl(botScope)
  const utmId = getStoredShortlinkExpectedUtmId(botScope)
  const memberId = getStoredLazadaExpectedMemberId(botScope)
  return !!(account || shopeeBase || lazadaBase || utmId || memberId)
}

const CACHE_VERSION = 'v12'
const globalCacheKey = (kind: 'gallery' | 'used' | 'history') => `${kind}_cache:${CACHE_VERSION}`
const nsCacheKey = (kind: 'gallery' | 'used' | 'history', namespaceId: string) => `${kind}_cache:${CACHE_VERSION}:${namespaceId}`
const systemGalleryCacheKey = (botScope = getBotScopeFromLocation()) => scopedStorageKey(`gallery_system_cache:${CACHE_VERSION}`, botScope)
const systemUsedGalleryCacheKey = (botScope = getBotScopeFromLocation()) => scopedStorageKey(`gallery_system_used_cache:${CACHE_VERSION}`, botScope)
const nsInboxCacheKey = (namespaceId: string) => `inbox_cache:${CACHE_VERSION}:${namespaceId}`
const dashboardCacheKey = (namespaceId: string, date: string) => `dashboard_cache:${CACHE_VERSION}:${namespaceId}:${date}`
const systemInboxCacheKey = (botScope = getBotScopeFromLocation()) => scopedStorageKey(`inbox_system_cache:${CACHE_VERSION}`, botScope)
const processingCacheKey = (namespaceId: string) => `processing_cache:${CACHE_VERSION}:${namespaceId}`
const GALLERY_BATCH_SIZE = 24
const LOGS_REVEAL_BATCH_SIZE = 1
const LOGS_REVEAL_INTERVAL_MS = 45
const FORCE_SYSTEM_WIDE_GALLERY = false

const readGalleryCacheForScope = (botScope = getBotScopeFromLocation(), namespaceId = '', systemWide = false) => {
  if (FORCE_SYSTEM_WIDE_GALLERY || systemWide) {
    return dedupeGalleryVideos(readCache<Video[]>(systemGalleryCacheKey(botScope), []))
  }

  const scopedNamespace = String(namespaceId || getStoredNamespace(botScope) || '').trim()
  if (scopedNamespace) {
    return dedupeGalleryVideos(readCache<Video[]>(nsCacheKey('gallery', scopedNamespace), []))
  }

  return dedupeGalleryVideos(readCache<Video[]>(globalCacheKey('gallery'), []))
}

const readUsedGalleryCacheForScope = (botScope = getBotScopeFromLocation(), namespaceId = '', systemWide = false) => {
  if (FORCE_SYSTEM_WIDE_GALLERY || systemWide) {
    return dedupeGalleryVideos(readCache<Video[]>(systemUsedGalleryCacheKey(botScope), []))
  }

  const scopedNamespace = String(namespaceId || getStoredNamespace(botScope) || '').trim()
  if (scopedNamespace) {
    return dedupeGalleryVideos(readCache<Video[]>(nsCacheKey('used', scopedNamespace), []))
  }

  return dedupeGalleryVideos(readCache<Video[]>(globalCacheKey('used'), []))
}

const apiFetch = async (url: string, options: RequestInit = {}) => {
  const headers = { ...options.headers, 'x-auth-token': getToken() }
  const method = String(options.method || 'GET').toUpperCase()
  return fetch(url, {
    ...options,
    headers,
    credentials: 'include',
    cache: method === 'GET' || method === 'HEAD' ? options.cache : 'no-store',
  })
}

const copyPlainText = async (value: string): Promise<boolean> => {
  const text = String(value || '').trim()
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fallback below for webviews that block Clipboard API.
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
  } catch {
    return false
  }
}

const PAGE_IMAGE_PLACEHOLDER = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
    <rect width="120" height="120" rx="24" fill="#f1f5f9"/>
    <circle cx="60" cy="44" r="18" fill="#cbd5e1"/>
    <path d="M24 96c7-15 21-23 36-23s29 8 36 23" fill="#cbd5e1"/>
  </svg>`
)}`;

const getGraphPageImageUrl = (pageId: string, size: 'small' | 'large' = 'large') =>
  `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=${size}`;

const onPageImageError = (
  event: SyntheticEvent<HTMLImageElement>,
  pageId: string,
  size: 'small' | 'large' = 'large'
) => {
  const img = event.currentTarget
  const stage = Number(img.dataset.fallbackStage || '0')

  if (stage === 0) {
    img.dataset.fallbackStage = '1'
    img.src = getGraphPageImageUrl(pageId, size)
    return
  }

  img.dataset.fallbackStage = '2'
  img.onerror = null
  img.src = PAGE_IMAGE_PLACEHOLDER
}

interface Video {
  id: string
  namespace_id?: string
  owner_email?: string
  script: string
  duration: number
  originalUrl: string
  createdAt: string
  updatedAt?: string
  publicUrl: string
  thumbnailUrl?: string
  shopeeLink?: string
  lazadaLink?: string
  shopeeOriginalLink?: string
  lazadaOriginalLink?: string
  shortlink_required?: boolean
  shortlink_status?: string
  shortlink_expected_utm_id?: string
  lazada_expected_member_id?: string
  has_shopee_source?: boolean
  has_lazada_source?: boolean
  shopee_ready?: boolean
  lazada_ready?: boolean
  gallery_ready?: boolean
  pending_bucket?: 'has-lazada' | 'missing-lazada'
  lazadaMemberId?: string
  category?: string
  title?: string
  postedAt?: string
  keepInPostedTab?: boolean
  original_only?: boolean
}

type GalleryAssetVariant = 'public' | 'original' | 'thumb' | 'original-thumb'

interface GalleryPageResponse {
  videos?: Video[]
  total?: number
  overall_total?: number
  ready_total?: number
  used_total?: number
  inventory_total?: number
  library_total?: number
  offset?: number
  limit?: number
  has_more?: boolean
  shopee_total?: number
  lazada_total?: number
  with_link_total?: number
  without_link_total?: number
}

interface InboxPageResponse {
  videos?: InboxVideo[]
  total?: number
  offset?: number
  limit?: number
  has_more?: boolean
}

interface SystemGalleryStats {
  total: number
  withLink: number
  withoutLink: number
  shopeeTotal: number
  lazadaTotal: number
}

interface GallerySummaryStats {
  libraryTotal: number
  inventoryTotal: number
  readyTotal: number
}

function AccountIdentityRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  const text = String(value || '').trim()
  if (!text) return null

  return (
    <button
      type="button"
      onClick={onCopy}
      className="flex w-full items-center gap-3 rounded-[22px] border border-slate-200 bg-slate-50/90 px-3.5 py-3 text-left shadow-sm transition-transform active:scale-[0.99]"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">{label}</p>
        <p className="mt-1 truncate font-mono text-[13px] font-semibold text-slate-700">{text}</p>
      </div>
      <span className={`flex h-10 min-w-[84px] items-center justify-center rounded-2xl border px-3 text-[12px] font-bold shadow-sm ${copied ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-blue-200 bg-white text-blue-600'}`}>
        {copied ? 'คัดลอกแล้ว' : 'Copy'}
      </span>
    </button>
  )
}

function SettingsAccountCard({
  displayName,
  email,
  pictureUrl,
  roleLabel,
  roleClassName,
  namespaceId,
  lineUserId,
  copiedIdentityField,
  onCopyNamespace,
  onCopyLine,
}: {
  displayName: string
  email: string
  pictureUrl: string
  roleLabel: string
  roleClassName: string
  namespaceId: string
  lineUserId: string
  copiedIdentityField: string | null
  onCopyNamespace: () => void
  onCopyLine: () => void
}) {
  const primaryText = String(displayName || lineUserId || email || '').trim()
  if (!primaryText) return null

  return (
    <div className="rounded-[30px] border border-gray-200 bg-white p-4 shadow-sm">
      <div className="relative overflow-hidden rounded-[26px] border border-slate-100 bg-gradient-to-br from-white via-slate-50 to-blue-50/80 px-4 py-5">
        <div className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-blue-100/70 blur-2xl" />
        <div className="absolute -left-8 bottom-0 h-20 w-20 rounded-full bg-sky-50 blur-2xl" />
        <div className="relative flex flex-col items-center text-center">
          {pictureUrl ? (
            <img src={pictureUrl} className="h-20 w-20 rounded-full border-4 border-white object-cover shadow-sm" />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-blue-100 text-2xl font-bold text-blue-600 shadow-sm">
              {primaryText.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="mt-4 space-y-2">
            <p className="break-words text-[27px] font-black leading-tight tracking-tight text-gray-900">{primaryText}</p>
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${roleClassName}`}>
              {roleLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <AccountIdentityRow
          label="Namespace ID"
          value={namespaceId}
          copied={copiedIdentityField === 'namespace'}
          onCopy={onCopyNamespace}
        />
        <AccountIdentityRow
          label="LINE UID"
          value={lineUserId}
          copied={copiedIdentityField === 'line'}
          onCopy={onCopyLine}
        />
      </div>
    </div>
  )
}

function SettingsLogoutButton({
  onLogout,
  logoutLoading,
}: {
  onLogout: () => void
  logoutLoading: boolean
}) {
  return (
    <button
      onClick={onLogout}
      disabled={logoutLoading}
      className="flex h-12 w-full items-center justify-center rounded-2xl border border-red-200 bg-red-50 text-sm font-bold text-red-600 shadow-sm active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {logoutLoading ? 'กำลังออกจากระบบ...' : 'Logout'}
    </button>
  )
}

interface ProcessingSummaryStats {
  libraryTotal: number
  inventoryTotal: number
  readyTotal: number
  pendingTotal: number
  pendingHasLazadaTotal: number
  pendingMissingLazadaTotal: number
}

function normalizeGallerySearchQuery(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function buildFacebookLogUrl(item: Pick<PostHistory, 'fb_reel_url' | 'fb_post_id'>): string {
  const reelUrlRaw = String(item.fb_reel_url || '').trim()
  if (reelUrlRaw) {
    if (/^https?:\/\//i.test(reelUrlRaw)) return reelUrlRaw
    if (reelUrlRaw.startsWith('/')) return `https://www.facebook.com${reelUrlRaw}`
    if (reelUrlRaw.startsWith('www.')) return `https://${reelUrlRaw}`
    return `https://www.facebook.com/${reelUrlRaw.replace(/^\/+/, '')}`
  }
  if (item.fb_post_id) return `https://www.facebook.com/watch/?v=${item.fb_post_id}`
  return ''
}

function buildFacebookPageProfileUrl(pageId: string): string {
  const normalizedPageId = String(pageId || '').trim()
  if (!normalizedPageId) return ''
  return `https://www.facebook.com/profile.php?id=${encodeURIComponent(normalizedPageId)}`
}

interface GlobalOriginalVideo {
  id: string
  video_id: string
  namespace_id: string
  owner_email?: string
  original_url: string
  source_key?: string
  created_at: string
  size?: number
}

interface PostHistory {
  id: number
  page_id: string
  video_id: string
  fb_post_id?: string
  fb_reel_url?: string
  posted_at: string
  status: string
  trigger_source?: string | null
  page_name: string
  page_image: string
  post_token_hint?: string | null
  post_profile_id?: string | null
  post_profile_name?: string | null
  comment_status?: string
  comment_token_hint?: string | null
  comment_profile_id?: string | null
  comment_profile_name?: string | null
  comment_error?: string | null
  comment_fb_id?: string | null
  comment_delay_seconds?: number | null
  comment_due_at?: string | null
  shopee_link?: string | null
  lazada_link?: string | null
  lazada_member_id?: string | null
  lazada_expected_member_id?: string | null
  lazada_member_match?: number | null
  shortlink_utm_source?: string | null
  shortlink_status?: string | null
  shortlink_error?: string | null
  shortlink_expected_utm_id?: string | null
  shortlink_utm_match?: number | null
  error_message?: string | null
}

interface TeamMember {
  email: string
  created_at: string
  display_name?: string
  picture_url?: string
  line_user_id?: string
  status?: string
}

type SystemMemberRole = 'admin' | 'member' | 'team'

interface MonitorSummary {
  active_pages: number
  active_namespaces: number
  posting_rows: number
  pending_comments: number
  failed_posts_24h: number
  failed_comments_24h: number
  latest_cron_success_at?: string
}

interface MonitorCronRuntime {
  run_id?: string
  status?: string
  started_at?: string
  finished_at?: string
  heartbeat_at?: string
  current_page_id?: string
  current_page_name?: string
  current_namespace_id?: string
  pages_total?: number
  pages_visited?: number
  pages_posted?: number
  pages_failed?: number
  last_error?: string
}

interface MonitorCronPage {
  namespace_id?: string
  page_id?: string
  page_name?: string
  post_hours?: string
  last_cron_touched?: string
}

interface MonitorPostIssue {
  id?: number
  bot_id?: string
  page_id?: string
  video_id?: string
  status?: string
  error_message?: string
  posted_at?: string
}

interface MonitorCommentIssue {
  id?: number
  bot_id?: string
  page_id?: string
  video_id?: string
  comment_status?: string
  comment_error?: string
  posted_at?: string
}

interface MonitorResponse {
  summary?: MonitorSummary
  cron_runtime?: MonitorCronRuntime | null
  stale_cron_pages?: MonitorCronPage[]
  post_issues?: MonitorPostIssue[]
  comment_issues?: MonitorCommentIssue[]
}

interface SystemMember {
  line_user_id: string
  display_name?: string
  picture_url?: string
  email?: string
  namespace_id?: string
  status?: string
  created_at?: string
  updated_at?: string
  role?: SystemMemberRole
  team_owner_namespace_id?: string
}

interface FacebookPage {
  id: string
  name: string
  image_url: string
  access_token?: string
  post_interval_minutes: number
  post_hours?: string  // slot: "2:22,9:49" or interval: "every:30"
  is_active: number
  onecard_enabled?: number
  onecard_link_mode?: 'shopee' | 'lazada' | 'none'
  onecard_cta?: 'SHOP_NOW' | 'NO_BUTTON'
  last_post_at?: string
  updated_at?: string
}

type GalleryFilter = 'missing-lazada' | 'pending-shortlink' | 'ready' | 'used' | 'all-original'
type GeminiKeySource = 'system' | 'legacy' | 'none'
type SettingsSection = 'menu' | 'account' | 'pages' | 'team' | 'gemini' | 'shortlink' | 'post' | 'voice' | 'cover' | 'comment' | 'members' | 'monitor'
type PostingOrderOption = 'oldest_first' | 'newest_first' | 'random'
type VoiceSettingsSource = 'default' | 'legacy' | 'structured'
type VoicePersonaPreset = 'female' | 'male' | 'kathoey'
type VoiceTonePreset = 'bright' | 'playful' | 'warm' | 'confident' | 'luxury' | 'friendly' | 'funny' | 'sales'
type CoverTextFontId =
  | 'kanit-bold'
  | 'prompt-bold'
  | 'sarabun-bold'
  | 'bai-jamjuree-bold'
  | 'mitr-bold'
  | 'krub-bold'
  | 'chakra-petch-bold'
  | 'ibm-plex-sans-thai-bold'

type VoiceProfile = {
  voice_name: string
  persona: VoicePersonaPreset
  tones: VoiceTonePreset[]
  custom_style_prompt: string
}

type CoverTextStyleSettings = {
  font_id: CoverTextFontId
  text_color: string
  background_color: string
  background_opacity: number
  size_scale: number
}

type GeminiVoiceOption = {
  name: string
  descriptor: string
}

const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  voice_name: 'Puck',
  persona: 'female',
  tones: ['bright', 'friendly'],
  custom_style_prompt: '',
}
const DEFAULT_VOICE_PREVIEW_TEXT = 'สวัสดีค่ะ วันนี้มีของดีมาแนะนำ ลองฟังน้ำเสียงนี้ก่อนว่าเข้ากับสไตล์ช่องของคุณไหม'
const DEFAULT_COVER_TEXT_STYLE: CoverTextStyleSettings = {
  font_id: 'kanit-bold',
  text_color: '#FFFFFF',
  background_color: '#E53935',
  background_opacity: 0.94,
  size_scale: 1,
}

const COVER_TEXT_FONT_OPTIONS: Array<{ value: CoverTextFontId; label: string; hint: string; family: string }> = [
  { value: 'kanit-bold', label: 'Kanit Bold', hint: 'หนา เด่น แบบคอนเทนต์ขายของ', family: 'Kanit' },
  { value: 'prompt-bold', label: 'Prompt Bold', hint: 'กลมทันสมัย อ่านง่าย', family: 'Prompt' },
  { value: 'sarabun-bold', label: 'Sarabun Bold', hint: 'สุภาพ คม ชัด', family: 'Sarabun' },
  { value: 'bai-jamjuree-bold', label: 'Bai Jamjuree Bold', hint: 'โมเดิร์น เท่ มีน้ำหนัก', family: 'Bai Jamjuree' },
  { value: 'mitr-bold', label: 'Mitr Bold', hint: 'อวบแน่น เด่น เหมาะกับปกขายของ', family: 'Mitr' },
  { value: 'krub-bold', label: 'Krub Bold', hint: 'มินิมอล อ่านง่าย ดูสะอาด', family: 'Krub' },
  { value: 'chakra-petch-bold', label: 'Chakra Petch Bold', hint: 'เหลี่ยมเท่ มีคาแรกเตอร์', family: 'Chakra Petch' },
  { value: 'ibm-plex-sans-thai-bold', label: 'IBM Plex Sans Thai Bold', hint: 'คม เนี้ยบ สไตล์มืออาชีพ', family: 'IBM Plex Sans Thai' },
]

const createDefaultVoiceProfile = (): VoiceProfile => ({
  ...DEFAULT_VOICE_PROFILE,
  tones: [...DEFAULT_VOICE_PROFILE.tones],
})

const createDefaultCoverTextStyle = (): CoverTextStyleSettings => ({
  ...DEFAULT_COVER_TEXT_STYLE,
})

const normalizeCoverHexColor = (value: unknown, fallback: string) => {
  const normalized = String(value || '').trim().toUpperCase()
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : fallback
}

const normalizeCoverTextFontId = (value: unknown): CoverTextFontId =>
  COVER_TEXT_FONT_OPTIONS.find((option) => option.value === value)?.value || DEFAULT_COVER_TEXT_STYLE.font_id

const getCoverTextFontFamily = (fontId: CoverTextFontId) =>
  COVER_TEXT_FONT_OPTIONS.find((option) => option.value === fontId)?.family || 'Kanit'

const normalizeCoverTextStyle = (raw: Partial<CoverTextStyleSettings> | null | undefined): CoverTextStyleSettings => ({
  font_id: normalizeCoverTextFontId(raw?.font_id),
  text_color: normalizeCoverHexColor(raw?.text_color, DEFAULT_COVER_TEXT_STYLE.text_color),
  background_color: normalizeCoverHexColor(raw?.background_color, DEFAULT_COVER_TEXT_STYLE.background_color),
  background_opacity: Number.isFinite(raw?.background_opacity)
    ? Math.max(0, Math.min(1, Math.round(Number(raw?.background_opacity) * 100) / 100))
    : DEFAULT_COVER_TEXT_STYLE.background_opacity,
  size_scale: Number.isFinite(raw?.size_scale)
    ? Math.max(0.8, Math.min(1.35, Math.round(Number(raw?.size_scale) * 100) / 100))
    : DEFAULT_COVER_TEXT_STYLE.size_scale,
})

const coverTextStylesEqual = (left: CoverTextStyleSettings, right: CoverTextStyleSettings) =>
  left.font_id === right.font_id &&
  left.text_color === right.text_color &&
  left.background_color === right.background_color &&
  left.background_opacity === right.background_opacity &&
  left.size_scale === right.size_scale

const summarizeCoverTextStyle = (style: CoverTextStyleSettings) => {
  const fontLabel = COVER_TEXT_FONT_OPTIONS.find((option) => option.value === style.font_id)?.label || style.font_id
  return `${fontLabel} • พื้นหลัง ${Math.round(style.background_opacity * 100)}% • ขนาด ${Math.round(style.size_scale * 100)}%`
}

const VOICE_PERSONA_OPTIONS: Array<{ value: VoicePersonaPreset; label: string; hint: string }> = [
  { value: 'female', label: 'ผู้หญิง', hint: 'นุ่มลื่น ชัดถ้อย' },
  { value: 'male', label: 'ผู้ชาย', hint: 'มั่นใจ กระชับ' },
  { value: 'kathoey', label: 'กระเทย', hint: 'แพรวพราว มีสีสัน' },
]

const VOICE_TONE_OPTIONS: Array<{ value: VoiceTonePreset; label: string }> = [
  { value: 'bright', label: 'สดใส' },
  { value: 'playful', label: 'ขี้เล่น' },
  { value: 'warm', label: 'อบอุ่น' },
  { value: 'confident', label: 'มั่นใจ' },
  { value: 'luxury', label: 'พรีเมียม' },
  { value: 'friendly', label: 'เป็นกันเอง' },
  { value: 'funny', label: 'ตลก' },
  { value: 'sales', label: 'ขายเก่ง' },
]

const normalizeVoiceProfile = (raw: Partial<VoiceProfile> | null | undefined): VoiceProfile => {
  const voiceName = String(raw?.voice_name || '').trim() || DEFAULT_VOICE_PROFILE.voice_name
  const persona = String(raw?.persona || '').trim()
  const tones = Array.isArray(raw?.tones) ? raw?.tones : []
  const uniqueTones = Array.from(new Set(
    tones
      .map((tone) => String(tone || '').trim())
      .filter((tone): tone is VoiceTonePreset => VOICE_TONE_OPTIONS.some((option) => option.value === tone))
  )).slice(0, 3)

  return {
    voice_name: voiceName,
    persona: VOICE_PERSONA_OPTIONS.some((option) => option.value === persona) ? persona as VoicePersonaPreset : DEFAULT_VOICE_PROFILE.persona,
    tones: uniqueTones.length > 0 ? uniqueTones : [...DEFAULT_VOICE_PROFILE.tones],
    custom_style_prompt: String(raw?.custom_style_prompt || '').trim().slice(0, 1200),
  }
}

const voiceProfilesEqual = (left: VoiceProfile, right: VoiceProfile) =>
  left.voice_name === right.voice_name &&
  left.persona === right.persona &&
  left.custom_style_prompt === right.custom_style_prompt &&
  left.tones.length === right.tones.length &&
  left.tones.every((tone, index) => tone === right.tones[index])

const getVoicePersonaMeta = (persona: VoicePersonaPreset) =>
  VOICE_PERSONA_OPTIONS.find((option) => option.value === persona) || VOICE_PERSONA_OPTIONS[0]

const getVoiceToneLabel = (tone: VoiceTonePreset) =>
  VOICE_TONE_OPTIONS.find((option) => option.value === tone)?.label || tone

const getVoiceOptionMeta = (voiceName: string, voiceOptions: GeminiVoiceOption[]) =>
  voiceOptions.find((option) => option.name === voiceName)

const summarizeVoiceSettings = (
  profile: VoiceProfile,
  source: VoiceSettingsSource,
  voiceOptions: GeminiVoiceOption[],
) => {
  if (source === 'legacy') return 'กำลังใช้ prompt เสียงแบบเก่า'
  const voiceMeta = getVoiceOptionMeta(profile.voice_name, voiceOptions)
  const persona = getVoicePersonaMeta(profile.persona)
  const toneText = profile.tones.slice(0, 2).map(getVoiceToneLabel).join(' · ')
  return [voiceMeta ? `${voiceMeta.name} ${voiceMeta.descriptor}` : profile.voice_name, persona.label, toneText].filter(Boolean).join(' • ')
}

const POSTING_ORDER_OPTIONS: Array<{ value: PostingOrderOption; title: string; subtitle: string }> = [
  { value: 'newest_first', title: 'โพสต์ใหม่สุดก่อน', subtitle: 'หยิบคลิปล่าสุดก่อน' },
  { value: 'oldest_first', title: 'โพสต์เก่าสุดก่อน', subtitle: 'ไล่จากคลิปเก่าก่อน' },
  { value: 'random', title: 'โพสต์สุ่ม', subtitle: 'สุ่มจากคลิปที่ยังไม่โพสต์' },
]

const getSettingsSectionTitle = (section: SettingsSection): string => {
  switch (section) {
    case 'account':
      return 'Account'
    case 'pages':
      return 'Pages'
    case 'team':
      return 'Team'
    case 'gemini':
      return 'Gemini API Key'
    case 'shortlink':
      return 'Shortlink'
    case 'post':
      return 'Post'
    case 'comment':
      return 'Comment Template'
    case 'voice':
      return 'เสียงพากย์'
    case 'cover':
      return 'ข้อความบนปก'
    case 'members':
      return 'สมาชิก'
    case 'monitor':
      return 'Monitor'
    default:
      return 'ตั้งค่า'
  }
}

const SHOPEE_LINK_RE = /https?:\/\/(?:[^"\s<>]+\.)*shopee\.(?:co\.th|co\.id|com\.my|ph|sg|vn)\S*/i
const LAZADA_LINK_RE = /https?:\/\/(?:[^"\s<>]+\.)*(?:lazada\.(?:co\.th|co\.id|com\.my|com\.ph|sg|vn)|lzd\.co)\S*/i

const extractShopeeLink = (value: unknown): string => {
  if (typeof value === 'string') {
    const hit = value.match(SHOPEE_LINK_RE)
    return hit ? hit[0].trim() : ''
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = extractShopeeLink(item)
      if (hit) return hit
    }
  }
  return ''
}

const extractLazadaLink = (value: unknown): string => {
  if (typeof value === 'string') {
    const hit = value.match(LAZADA_LINK_RE)
    return hit ? hit[0].trim() : ''
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = extractLazadaLink(item)
      if (hit) return hit
    }
  }
  return ''
}

const getVideoShopeeLink = (video: Record<string, unknown>): string => {
  const candidates: unknown[] = [
    video.shopeeLink,
    video.shopee_link,
    video.shopeeUrl,
    video.shopee_url,
    video.shopee,
    video.link,
  ]
  for (const candidate of candidates) {
    const hit = extractShopeeLink(candidate)
    if (hit) return hit
  }
  return ''
}

const getVideoLazadaLink = (video: Record<string, unknown>): string => {
  const candidates: unknown[] = [
    video.lazadaLink,
    video.lazada_link,
    video.lazadaUrl,
    video.lazada_url,
    video.lazada,
  ]
  for (const candidate of candidates) {
    const hit = extractLazadaLink(candidate)
    if (hit) return hit
  }
  return ''
}

const hasVideoAffiliateLink = (video: Record<string, unknown>): boolean => {
  return !!getVideoShopeeLink(video) || !!getVideoLazadaLink(video)
}

const normalizeShortlinkExpectedUtmIdClient = (rawValue: string): string => {
  const value = String(rawValue || '').trim().replace(/^an_/i, '')
  if (!value || !/^\d+$/.test(value)) return ''
  return value
}

const normalizeLazadaMemberIdClient = (rawValue: string): string => {
  const value = String(rawValue || '').trim()
  if (!value || !/^\d+$/.test(value)) return ''
  return value
}

const isLikelyConvertedShopeeLink = (link: string, expectedUtmId = ''): boolean => {
  const rawLink = extractShopeeLink(link)
  if (!rawLink) return false

  try {
    const parsed = new URL(rawLink)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()
    if (host.startsWith('s.shopee.')) return true
    if (path.startsWith('/opaanlp/')) return true
    if (path.startsWith('/universal-link/')) return true

    const expected = normalizeShortlinkExpectedUtmIdClient(expectedUtmId)
    const actual = normalizeShortlinkExpectedUtmIdClient(String(parsed.searchParams.get('utm_source') || ''))
    if (expected && actual && expected === actual) return true
  } catch {
    return false
  }

  return false
}

const extractLazadaTrackingSourceClient = (link: string): string => {
  const rawLink = extractLazadaLink(link)
  if (!rawLink) return ''

  const matchMarker = (value: string): string => {
    const decoded = (() => {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    })()

    const exact = decoded.match(/(mm_\d+_\d+_\d+!\d+)/i)
    if (exact) return String(exact[1] || '').trim()
    const fallback = decoded.match(/(mm_\d+_\d+_\d+)/i)
    return fallback ? String(fallback[1] || '').trim() : ''
  }

  const direct = matchMarker(rawLink)
  if (direct) return direct

  try {
    const parsed = new URL(rawLink)
    for (const key of ['exlaz', 'laz_trackid', 'utm_source']) {
      const hit = matchMarker(String(parsed.searchParams.get(key) || ''))
      if (hit) return hit
    }
  } catch {
    return ''
  }

  return ''
}

const extractShopeeAffiliateIdFromLinkClient = (link: string): string => {
  const rawLink = extractShopeeLink(link)
  if (!rawLink) return ''

  try {
    const parsed = new URL(rawLink)
    return normalizeShortlinkExpectedUtmIdClient(String(parsed.searchParams.get('utm_source') || ''))
  } catch {
    return ''
  }
}

const extractLazadaMemberIdFromLinkClient = (link: string): string => {
  const rawLink = extractLazadaLink(link)
  if (!rawLink) return ''

  const matchMemberId = (value: string): string => {
    const decoded = (() => {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    })()

    const exact = decoded.match(/mm_(\d+)_/i)
    if (exact) return normalizeLazadaMemberIdClient(String(exact[1] || ''))
    const direct = decoded.match(/[?&]member_id=(\d+)/i)
    if (direct) return normalizeLazadaMemberIdClient(String(direct[1] || ''))
    return ''
  }

  const direct = matchMemberId(rawLink)
  if (direct) return direct

  try {
    const parsed = new URL(rawLink)
    for (const key of ['exlaz', 'laz_trackid', 'utm_source', 'member_id', 'sub_aff_id', 'aff_trace_key']) {
      const hit = matchMemberId(String(parsed.searchParams.get(key) || ''))
      if (hit) return hit
    }
  } catch {
    return ''
  }

  return ''
}

const isLikelyConvertedLazadaLink = (link: string): boolean => {
  const rawLink = extractLazadaLink(link)
  if (!rawLink) return false

  try {
    const parsed = new URL(rawLink)
    const host = parsed.hostname.toLowerCase()
    if (host === 'lzd.co' || host.endsWith('.lzd.co')) return true
    if (host.startsWith('s.lazada.')) return true
  } catch {
    return false
  }

  return !!extractLazadaTrackingSourceClient(rawLink)
}

const getVideoSourceShopeeLink = (video: Record<string, unknown>): string => {
  const candidates: unknown[] = [
    video.shopeeOriginalLink,
    video.shopee_original_link,
    video.shopeeSourceLink,
    video.shopee_source_link,
    video.shopeeLink,
    video.shopee_link,
    video.shopeeUrl,
    video.shopee_url,
    video.shopee,
    video.link,
  ]
  for (const candidate of candidates) {
    const hit = extractShopeeLink(candidate)
    if (hit) return hit
  }
  return ''
}

const getVideoSourceLazadaLink = (video: Record<string, unknown>): string => {
  const candidates: unknown[] = [
    video.lazadaOriginalLink,
    video.lazada_original_link,
    video.lazadaSourceLink,
    video.lazada_source_link,
    video.lazadaLink,
    video.lazada_link,
    video.lazadaUrl,
    video.lazada_url,
    video.lazada,
  ]
  for (const candidate of candidates) {
    const hit = extractLazadaLink(candidate)
    if (hit) return hit
  }
  return ''
}

const getBooleanFlag = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return null
}

const isVideoShortlinkRequired = (
  video: Partial<Video> & Record<string, unknown>,
  fallback = false,
): boolean => {
  return getBooleanFlag(video.shortlink_required) ?? fallback
}

const getVideoAffiliateConversionState = (
  video: Partial<Video> & Record<string, unknown>,
  expectedUtmId = '',
  expectedLazadaMemberId = '',
  options: { requireManagedLinks?: boolean } = {},
) => {
  const hasPlayable = !!String(video.publicUrl || video.public_url || '').trim()
  const shopeeSourceLink = getVideoSourceShopeeLink(video)
  const shopeeCurrentLink = getVideoShopeeLink(video)
  const hasShopeeSource = !!shopeeSourceLink
  const hasShopeeLink = !!(shopeeCurrentLink || shopeeSourceLink)
  const hasManagedShopeeConversion = !!String(
    video.shopeeConvertedAt || video.shopee_converted_at || video.shopeeOriginalLink || video.shopee_original_link || ''
  ).trim()
  const requireManagedLinks = options.requireManagedLinks ?? isVideoShortlinkRequired(video)
  const shopeeReady = requireManagedLinks
    ? (!!shopeeCurrentLink && isLikelyConvertedShopeeLink(shopeeCurrentLink, expectedUtmId))
    : hasShopeeLink

  const lazadaSourceLink = getVideoSourceLazadaLink(video)
  const lazadaCurrentLink = getVideoLazadaLink(video)
  const hasLazadaSource = !!lazadaSourceLink
  const hasLazadaLink = !!(lazadaCurrentLink || lazadaSourceLink)
  const hasManagedLazadaConversion = !!String(
    video.lazadaConvertedAt || video.lazada_converted_at || video.lazadaOriginalLink || video.lazada_original_link || ''
  ).trim()
  const lazadaMemberId = normalizeLazadaMemberIdClient(String(video.lazadaMemberId || video.lazada_member_id || ''))
  const lazadaReady = requireManagedLinks
    ? (!!lazadaCurrentLink && !!lazadaMemberId && isLikelyConvertedLazadaLink(lazadaCurrentLink) && (!expectedLazadaMemberId || lazadaMemberId === expectedLazadaMemberId))
    : hasLazadaLink

  const missingShopeeSource = hasPlayable && !hasShopeeLink
  const galleryReady = hasPlayable
  const missingLazadaSource = hasPlayable && !hasLazadaLink

  return {
    hasPlayable,
    requireManagedLinks,
    hasShopeeSource,
    hasShopeeLink,
    hasManagedShopeeConversion,
    shopeeReady,
    hasLazadaSource,
    hasLazadaLink,
    hasManagedLazadaConversion,
    lazadaMemberId,
    lazadaReady,
    missingShopeeSource,
    missingLazadaSource,
    awaitingConversion: requireManagedLinks && hasPlayable && (missingShopeeSource || !galleryReady),
    galleryReady,
  }
}

const isVideoAwaitingAffiliateConversion = (
  video: Partial<Video> & Record<string, unknown>,
  expectedUtmId = '',
  expectedLazadaMemberId = '',
): boolean => {
  return getVideoAffiliateConversionState(video, expectedUtmId, expectedLazadaMemberId).awaitingConversion
}

const getInitialGallerySearchInput = (): string => {
  try {
    return String(new URL(window.location.href).searchParams.get('q') || '').trim()
  } catch {
    return ''
  }
}

function getGalleryVideoSortMs(video: Partial<Video> & Record<string, unknown>) {
  const updatedTs = new Date(String(video.updatedAt || '')).getTime()
  if (Number.isFinite(updatedTs) && updatedTs > 0) return updatedTs
  const createdTs = new Date(String(video.createdAt || '')).getTime()
  return Number.isFinite(createdTs) ? createdTs : 0
}

function pickPreferredGalleryVideo(
  current: Partial<Video> & Record<string, unknown>,
  next: Partial<Video> & Record<string, unknown>,
) {
  const currentLinkRank = getVideoLazadaLink(current) ? 2 : getVideoShopeeLink(current) ? 1 : 0
  const nextLinkRank = getVideoLazadaLink(next) ? 2 : getVideoShopeeLink(next) ? 1 : 0
  if (currentLinkRank !== nextLinkRank) {
    return nextLinkRank > currentLinkRank ? next : current
  }

  const currentHasThumbnail = !!String(current.thumbnailUrl || '').trim()
  const nextHasThumbnail = !!String(next.thumbnailUrl || '').trim()
  if (currentHasThumbnail !== nextHasThumbnail) {
    return nextHasThumbnail ? next : current
  }

  const currentTs = getGalleryVideoSortMs(current)
  const nextTs = getGalleryVideoSortMs(next)
  if (currentTs !== nextTs) {
    return nextTs >= currentTs ? next : current
  }

  const currentNamespaceId = String(current.namespace_id || '').trim()
  const nextNamespaceId = String(next.namespace_id || '').trim()
  return nextNamespaceId.localeCompare(currentNamespaceId) <= 0 ? next : current
}

function dedupeGalleryVideos(rows: Video[]): Video[] {
  const byId = new Map<string, Video>()
  for (const video of rows || []) {
    const key = getVideoIdentityKey(video as Video & Record<string, unknown>)
    if (!key) continue
    const prev = byId.get(key)
    if (!prev) {
      byId.set(key, video)
      continue
    }
    byId.set(key, pickPreferredGalleryVideo(prev as Video & Record<string, unknown>, video as Video & Record<string, unknown>) as Video)
  }
  return Array.from(byId.values()).sort((a, b) => getGalleryVideoSortMs(b as Video & Record<string, unknown>) - getGalleryVideoSortMs(a as Video & Record<string, unknown>))
}

const getInboxVideoSortMs = (video: Partial<InboxVideo> & Record<string, unknown>) => {
  const updatedTs = new Date(String(video.updatedAt || '')).getTime()
  if (Number.isFinite(updatedTs) && updatedTs > 0) return updatedTs
  const createdTs = new Date(String(video.createdAt || '')).getTime()
  if (Number.isFinite(createdTs) && createdTs > 0) return createdTs
  return Number.isFinite(updatedTs) ? updatedTs : 0
}

const mergeInboxVideos = (current: InboxVideo[], incoming: InboxVideo[]) => {
  const byKey = new Map<string, InboxVideo>()
  for (const video of current) {
    byKey.set(getInboxVideoIdentityKey(video.id, video.namespace_id), video)
  }
  for (const video of incoming) {
    byKey.set(getInboxVideoIdentityKey(video.id, video.namespace_id), video)
  }
  return Array.from(byKey.values()).sort((a, b) =>
    getInboxVideoSortMs(b as InboxVideo & Record<string, unknown>) - getInboxVideoSortMs(a as InboxVideo & Record<string, unknown>)
  )
}

const mergeGalleryPageVideos = (current: Video[], incoming: Video[]) =>
  dedupeGalleryVideos([...current, ...incoming])

const buildGalleryAssetProxyUrl = (
  videoId: string,
  namespaceId: string | undefined,
  variant: GalleryAssetVariant,
) => {
  const id = String(videoId || '').trim()
  const ns = String(namespaceId || '').trim()
  if (!id || !ns) return ''
  try {
    const url = new URL(`${WORKER_URL}/api/gallery/${encodeURIComponent(id)}/asset/${variant}`)
    url.searchParams.set('namespace_id', ns)
    return url.toString()
  } catch {
    return `${WORKER_URL}/api/gallery/${encodeURIComponent(id)}/asset/${variant}?namespace_id=${encodeURIComponent(ns)}`
  }
}

const resolveGalleryAssetProxyUrl = (
  video: Partial<Video> & Record<string, unknown>,
  variant: GalleryAssetVariant,
) => {
  const id = String(video.id || video.video_id || '').trim()
  const namespaceId = String(video.namespace_id || '').trim()
  return buildGalleryAssetProxyUrl(id, namespaceId, variant)
}

const resolveThumbnailDisplayUrl = (video: Partial<Video> & Record<string, unknown>) => {
  const proxied = resolveGalleryAssetProxyUrl(video, 'thumb')
  if (proxied) return proxied
  return String(video.thumbnailUrl || '').trim()
}

const resolveInboxThumbnailDisplayUrl = (video: Partial<InboxVideo> & Record<string, unknown>) => {
  const proxied = resolveGalleryAssetProxyUrl(video, 'original-thumb')
  if (proxied) return proxied
  return String(video.thumbnailUrl || '').trim()
}

const buildOriginalFramePreviewUrl = (video: Record<string, unknown>) => {
  const id = String(video.id || video.video_id || '').trim()
  const namespaceId = String(video.namespace_id || '').trim()
  if (!id || !namespaceId) return ''
  try {
    const url = new URL(`${WORKER_URL}/api/gallery/${encodeURIComponent(id)}/frame`)
    url.searchParams.set('namespace_id', namespaceId)
    url.searchParams.set('seed', `${namespaceId}:${id}:original-preview`)
    url.searchParams.set('format', 'jpg')
    url.searchParams.set('w', '540')
    url.searchParams.set('h', '960')
    return url.toString()
  } catch {
    return `${WORKER_URL}/api/gallery/${encodeURIComponent(id)}/frame?namespace_id=${encodeURIComponent(namespaceId)}&seed=${encodeURIComponent(`${namespaceId}:${id}:original-preview`)}&format=jpg&w=540&h=960`
  }
}

const resolvePlayableVideoUrl = (video: Partial<Video> & Record<string, unknown>) => {
  const proxied = resolveGalleryAssetProxyUrl(video, 'public')
  if (proxied) return proxied
  const publicUrl = String(video.publicUrl || '').trim()
  const originalUrl = String(video.originalUrl || '').trim()
  return publicUrl || originalUrl || ''
}

const resolveFallbackVideoUrl = (video: Partial<Video> & Record<string, unknown>, currentUrl?: string) => {
  const proxiedPublicUrl = resolveGalleryAssetProxyUrl(video, 'public')
  const proxiedOriginalUrl = resolveGalleryAssetProxyUrl(video, 'original')
  const publicUrl = String(video.publicUrl || '').trim()
  const originalUrl = String(video.originalUrl || '').trim()
  const current = String(currentUrl || '').trim()
  if (current && current === proxiedPublicUrl && proxiedOriginalUrl && proxiedOriginalUrl !== proxiedPublicUrl) return proxiedOriginalUrl
  if (current && current === proxiedOriginalUrl && proxiedPublicUrl && proxiedPublicUrl !== proxiedOriginalUrl) return proxiedPublicUrl
  if (current && current === publicUrl && originalUrl && originalUrl !== publicUrl) return originalUrl
  if (current && current === originalUrl && publicUrl && publicUrl !== originalUrl) return publicUrl
  return ''
}

const getVideoIdentityKey = (video: Partial<Video> & Record<string, unknown>) => {
  const id = String(video.id || '').trim()
  const namespaceId = String(video.namespace_id || '').trim()
  return namespaceId ? `${namespaceId}:${id}` : id
}

const filterDeletedGalleryVideos = (
  rows: Video[],
  deletedKeys: ReadonlySet<string>,
) => rows.filter((video) => !deletedKeys.has(getVideoIdentityKey(video as Video & Record<string, unknown>)))

const matchesVideoIdentity = (video: Partial<Video> & Record<string, unknown>, id: string, namespaceId?: string) => {
  return String(video.id || '').trim() === String(id || '').trim()
    && String(video.namespace_id || '').trim() === String(namespaceId || '').trim()
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready: () => void
        expand: () => void
        requestFullscreen: () => void
        disableVerticalSwipes: () => void
        setHeaderColor: (color: string) => void
        setBackgroundColor: (color: string) => void
        setBottomBarColor: (color: string) => void
        initDataUnsafe: {
          user?: { id: number; first_name: string; last_name?: string }
        }
      }
    }
  }
}

const CloseIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const WorkspaceCurrentIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 10.5L12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5.25 9.75V20a1 1 0 001 1h4.5v-6h2.5v6h4.5a1 1 0 001-1V9.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const WorkspaceOtherIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="4" y="4" width="7" height="7" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M13 7h3a1 1 0 011 1v3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11 17H8a1 1 0 01-1-1v-3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function VideoWorkspaceBadge({
  videoNamespaceId,
  currentNamespaceId,
  showLabel = false,
}: {
  videoNamespaceId?: string
  currentNamespaceId?: string
  showLabel?: boolean
}) {
  const currentId = String(currentNamespaceId || '').trim()
  const videoId = String(videoNamespaceId || '').trim()
  if (!currentId || !videoId) return null

  const isCurrentWorkspace = currentId === videoId
  const label = isCurrentWorkspace ? 'work id นี้' : 'work id อื่น'
  const className = isCurrentWorkspace
    ? 'bg-blue-500/95 text-white border-blue-400/70'
    : 'bg-slate-900/82 text-white border-white/15'

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold shadow-lg backdrop-blur-sm ${className}`}
      title={label}
      aria-label={label}
    >
      {isCurrentWorkspace ? <WorkspaceCurrentIcon /> : <WorkspaceOtherIcon />}
      {showLabel && <span>{label}</span>}
    </div>
  )
}

// Video card component
function VideoCard({
  video,
  currentNamespaceId,
  showWorkspaceBadge = false,
  formatDuration,
  onDelete,
  onUpdate,
  onImport,
  onExpandedChange,
  keepInPostedOnLinkSave = false,
  showRepostAction = false,
  onRepost,
}: {
  video: Video
  currentNamespaceId?: string
  showWorkspaceBadge?: boolean
  formatDuration: (s: number) => string
  onDelete: (id: string, namespaceId?: string) => void
  onUpdate: (id: string, namespaceId: string | undefined, fields: Partial<Video>) => void
  onImport?: (videoId: string, sourceNamespaceId: string) => void
  onExpandedChange?: (expanded: boolean) => void
  keepInPostedOnLinkSave?: boolean
  showRepostAction?: boolean
  onRepost?: (id: string, namespaceId?: string) => Promise<void> | void
}) {
  const [expanded, setExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [reposting, setReposting] = useState(false)
  const [shopeeInput, setShopeeInput] = useState('')
  const [savingShopee, setSavingShopee] = useState(false)
  const [deletingShopeeLink, setDeletingShopeeLink] = useState(false)
  const [localShopee, setLocalShopee] = useState(getVideoShopeeLink(video as unknown as Record<string, unknown>))
  const [lazadaInput, setLazadaInput] = useState('')
  const [savingLazada, setSavingLazada] = useState(false)
  const [deletingLazadaLink, setDeletingLazadaLink] = useState(false)
  const [localLazada, setLocalLazada] = useState(getVideoLazadaLink(video as unknown as Record<string, unknown>))
  const [localCats, setLocalCats] = useState<string[]>([])
  const [fetchedCats, setFetchedCats] = useState<string[]>([])
  const [editingTitle, setEditingTitle] = useState(false)
  const [localTitle, setLocalTitle] = useState(video.title || '')
  const [savingTitle, setSavingTitle] = useState(false)
  const [playbackUrl, setPlaybackUrl] = useState(resolvePlayableVideoUrl(video as Video & Record<string, unknown>))
  const playbackPosterUrl = resolveThumbnailDisplayUrl(video as Video & Record<string, unknown>)
  const videoNamespaceId = String(video.namespace_id || '').trim() || undefined
  const videoStorageId = videoNamespaceId ? `${videoNamespaceId}:${video.id}` : video.id
  const buildVideoApiUrl = () => {
    const url = new URL(`${WORKER_URL}/api/gallery/${encodeURIComponent(video.id)}`)
    if (videoNamespaceId) url.searchParams.set('namespace_id', videoNamespaceId)
    return url.toString()
  }

  useEffect(() => {
    setLocalShopee(getVideoShopeeLink(video as unknown as Record<string, unknown>))
  }, [video.id, video.shopeeLink])

  useEffect(() => {
    setLocalLazada(getVideoLazadaLink(video as unknown as Record<string, unknown>))
  }, [video.id, video.lazadaLink])

  useEffect(() => {
    setPlaybackUrl(resolvePlayableVideoUrl(video as Video & Record<string, unknown>))
  }, [video.id, video.namespace_id, video.publicUrl, video.originalUrl])

  useEffect(() => {
    if (expanded) {
      setLocalCats(video.category ? video.category.split(',').filter(Boolean) : [])
      apiFetch(`${WORKER_URL}/api/categories`).then(r => r.json()).then(d => setFetchedCats(d.categories || [])).catch(() => { })
    }
  }, [expanded])

  useEffect(() => {
    onExpandedChange?.(expanded)
    return () => onExpandedChange?.(false)
  }, [expanded, onExpandedChange])
  useViewerHistory(expanded, setExpanded)

  const toggleCategory = async (cat: string) => {
    const next = localCats.includes(cat) ? localCats.filter(c => c !== cat) : [...localCats, cat]
    setLocalCats(next)
    const newCat = next.join(',')
    onUpdate(video.id, videoNamespaceId, { category: newCat })
    await apiFetch(buildVideoApiUrl(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: newCat, namespace_id: videoNamespaceId })
    }).catch(() => { })
  }

  const handleSaveShopee = async () => {
    if (!shopeeInput.trim()) return
    setSavingShopee(true)
    try {
      const nowIso = new Date().toISOString()
      const resp = await apiFetch(buildVideoApiUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopeeLink: shopeeInput.trim(),
          keepInPostedTab: keepInPostedOnLinkSave || undefined,
          namespace_id: videoNamespaceId,
        })
      })
      if (resp.ok) {
        video.shopeeLink = shopeeInput.trim()
        if (keepInPostedOnLinkSave) video.keepInPostedTab = true
        video.updatedAt = nowIso
        setLocalShopee(shopeeInput.trim())
        setShopeeInput('')
        onUpdate(video.id, videoNamespaceId, {
          shopeeLink: shopeeInput.trim(),
          keepInPostedTab: keepInPostedOnLinkSave ? true : video.keepInPostedTab,
          updatedAt: nowIso
        })
      } else {
        const err = await resp.json().catch(() => ({ error: 'Unknown error' }))
        alert('บันทึกไม่สำเร็จ: ' + (err.error || resp.status))
      }
    } catch (e) {
      console.error('Save failed:', e)
      alert('บันทึกไม่สำเร็จ: ' + (e instanceof Error ? e.message : 'Network error'))
    } finally {
      setSavingShopee(false)
    }
  }

  const handleDeleteShopeeLink = async () => {
    if (!localShopee) return
    if (!confirm('ยืนยันลบลิงก์ Shopee ออกจากวิดีโอนี้?')) return
    setDeletingShopeeLink(true)
    try {
      const nowIso = new Date().toISOString()
      const resp = await apiFetch(buildVideoApiUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopeeLink: '', namespace_id: videoNamespaceId })
      })
      if (resp.ok) {
        video.shopeeLink = ''
        video.updatedAt = nowIso
        setLocalShopee('')
        setShopeeInput('')
        onUpdate(video.id, videoNamespaceId, { shopeeLink: '', updatedAt: nowIso })
      } else {
        const err = await resp.json().catch(() => ({ error: 'Unknown error' }))
        alert('ลบลิงก์ไม่สำเร็จ: ' + (err.error || resp.status))
      }
    } catch (e) {
      console.error('Delete shopee link failed:', e)
      alert('ลบลิงก์ไม่สำเร็จ: ' + (e instanceof Error ? e.message : 'Network error'))
    } finally {
      setDeletingShopeeLink(false)
    }
  }

  const handleSaveLazada = async () => {
    if (!lazadaInput.trim()) return
    setSavingLazada(true)
    try {
      const nowIso = new Date().toISOString()
      const resp = await apiFetch(buildVideoApiUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lazadaLink: lazadaInput.trim(),
          namespace_id: videoNamespaceId,
        })
      })
      const data = await resp.json().catch(() => ({ error: 'Unknown error' }))
      if (resp.ok) {
        const savedVideo = data && typeof data === 'object' && 'video' in data && data.video && typeof data.video === 'object'
          ? data.video as Record<string, unknown>
          : null
        const savedLazada = savedVideo
          ? (getVideoLazadaLink(savedVideo) || String(savedVideo.lazadaLink || savedVideo.lazada_link || '').trim())
          : lazadaInput.trim()
        const savedUpdatedAt = savedVideo
          ? String(savedVideo.updatedAt || savedVideo.updated_at || nowIso).trim() || nowIso
          : nowIso
        const savedNamespaceId = savedVideo
          ? String(savedVideo.namespace_id || videoNamespaceId || '').trim() || videoNamespaceId
          : videoNamespaceId

        if (!savedLazada) {
          throw new Error('Worker did not persist Lazada link')
        }

        video.lazadaLink = savedLazada
        video.updatedAt = savedUpdatedAt
        if (savedNamespaceId) video.namespace_id = savedNamespaceId
        setLocalLazada(savedLazada)
        setLazadaInput('')
        onUpdate(video.id, savedNamespaceId, {
          lazadaLink: savedLazada,
          updatedAt: savedUpdatedAt
        })
      } else {
        alert('บันทึกไม่สำเร็จ: ' + ((data as { error?: string }).error || resp.status))
      }
    } catch (e) {
      console.error('Save Lazada failed:', e)
      alert('บันทึกไม่สำเร็จ: ' + (e instanceof Error ? e.message : 'Network error'))
    } finally {
      setSavingLazada(false)
    }
  }

  const handleDeleteLazadaLink = async () => {
    if (!localLazada) return
    if (!confirm('ยืนยันลบลิงก์ Lazada ออกจากวิดีโอนี้?')) return
    setDeletingLazadaLink(true)
    try {
      const nowIso = new Date().toISOString()
      const resp = await apiFetch(buildVideoApiUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lazadaLink: '', namespace_id: videoNamespaceId })
      })
      const data = await resp.json().catch(() => ({ error: 'Unknown error' }))
      if (resp.ok) {
        const savedVideo = data && typeof data === 'object' && 'video' in data && data.video && typeof data.video === 'object'
          ? data.video as Record<string, unknown>
          : null
        const savedUpdatedAt = savedVideo
          ? String(savedVideo.updatedAt || savedVideo.updated_at || nowIso).trim() || nowIso
          : nowIso
        const savedNamespaceId = savedVideo
          ? String(savedVideo.namespace_id || videoNamespaceId || '').trim() || videoNamespaceId
          : videoNamespaceId
        const remainingLazada = savedVideo ? getVideoLazadaLink(savedVideo) : ''

        if (remainingLazada) {
          throw new Error('Worker still returned Lazada link after delete')
        }

        video.lazadaLink = ''
        video.updatedAt = savedUpdatedAt
        if (savedNamespaceId) video.namespace_id = savedNamespaceId
        setLocalLazada('')
        setLazadaInput('')
        onUpdate(video.id, savedNamespaceId, { lazadaLink: '', updatedAt: savedUpdatedAt })
      } else {
        alert('ลบลิงก์ไม่สำเร็จ: ' + ((data as { error?: string }).error || resp.status))
      }
    } catch (e) {
      console.error('Delete lazada link failed:', e)
      alert('ลบลิงก์ไม่สำเร็จ: ' + (e instanceof Error ? e.message : 'Network error'))
    } finally {
      setDeletingLazadaLink(false)
    }
  }

  const handleSaveTitle = async (newTitle: string) => {
    setSavingTitle(true)
    try {
      const resp = await apiFetch(buildVideoApiUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, namespace_id: videoNamespaceId })
      })
      if (resp.ok) {
        video.title = newTitle
        onUpdate(video.id, videoNamespaceId, { title: newTitle })
      }
    } catch (e) {
      console.error('Save title failed:', e)
    } finally {
      setSavingTitle(false)
      setEditingTitle(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('ยืนยันลบวีดีโอนี้?')) return
    setDeleting(true)
    try {
      const resp = await apiFetch(buildVideoApiUrl(), { method: 'DELETE' })
      if (resp.ok) {
        try { localStorage.removeItem(`t_${videoStorageId}`) } catch { }
        onDelete(video.id, videoNamespaceId)
        setExpanded(false)
      }
    } catch (e) {
      console.error('Delete failed:', e)
    } finally {
      setDeleting(false)
    }
  }

  const handleRepost = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!onRepost || reposting) return
    setReposting(true)
    try {
      await onRepost(video.id, videoNamespaceId)
    } finally {
      setReposting(false)
    }
  }

  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 bg-[#fafafa] text-gray-900">
        <div className="mx-auto flex h-full w-full max-w-md flex-col bg-[#fafafa]">
          <div
            aria-hidden="true"
            className="sticky top-0 z-10 bg-[#fafafa]"
            style={{ height: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}
          />
          <div data-allow-touch-scroll="true" className="flex-1 overflow-y-auto app-scroll">
            <div
              className="space-y-4 px-4"
              style={{
                paddingTop: '8px',
                paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
              }}
            >
              <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400">Caption</p>
                {editingTitle ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={localTitle}
                      onChange={(e) => setLocalTitle(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveTitle(localTitle)
                        if (e.key === 'Escape') { setEditingTitle(false); setLocalTitle(video.title || '') }
                      }}
                      className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-400 focus:bg-white"
                      placeholder="ใส่แคปชั่น..."
                    />
                    <button
                      onClick={() => handleSaveTitle(localTitle)}
                      disabled={savingTitle}
                      className="shrink-0 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white active:scale-95 transition-all disabled:opacity-50"
                    >
                      {savingTitle ? '...' : 'OK'}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setEditingTitle(true)}
                    className="flex w-full items-start gap-2 rounded-xl bg-gray-50 px-3 py-3 text-left active:scale-[0.99] transition-transform"
                  >
                    <p className={`flex-1 text-sm ${localTitle ? 'text-gray-900' : 'text-gray-400'} line-clamp-3`}>
                      {localTitle || 'แตะเพื่อเพิ่มแคปชั่น...'}
                    </p>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0 text-gray-400">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>

              <div
                className="mx-auto overflow-hidden rounded-[28px] border border-gray-200 bg-white shadow-sm"
                style={VERTICAL_VIEWER_FRAME_STYLE}
              >
                <video
                  src={playbackUrl}
                  className="block h-full w-full bg-white object-contain"
                  controls
                  autoPlay
                  playsInline
                  preload="metadata"
                  poster={playbackPosterUrl || undefined}
                  onError={() => {
                    const fallbackUrl = resolveFallbackVideoUrl(video as Video & Record<string, unknown>, playbackUrl)
                    if (fallbackUrl && fallbackUrl !== playbackUrl) {
                      setPlaybackUrl(fallbackUrl)
                    }
                  }}
                />
              </div>

              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 rounded-2xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">Video ID</p>
                  <p className="truncate text-sm font-semibold text-gray-900">{video.id}</p>
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(video.id)}
                  className="shrink-0 rounded-2xl border border-gray-200 bg-white p-3 text-gray-600 shadow-sm active:scale-95 transition-transform"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {fetchedCats.map(cat => (
                  <button
                    key={cat}
                    onClick={() => toggleCategory(cat)}
                    className={`rounded-full px-2.5 py-1 text-xs font-bold transition-all active:scale-95 ${localCats.includes(cat) ? 'bg-blue-500 text-white shadow-sm' : 'bg-white text-gray-700 border border-gray-200'}`}
                  >
                    #{cat}
                  </button>
                ))}
              </div>

              <div>
                <p className="mb-1 px-1 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400">Shopee Link</p>
                {savingShopee ? (
                  <div className="mt-3 flex items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white px-3 py-3 shadow-sm">
                    <div className="h-4 w-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                    <span className="text-sm text-gray-500">กำลังบันทึก...</span>
                  </div>
                ) : localShopee ? (
                  <div className="mt-3 flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
                    <span className="flex-1 truncate text-sm text-gray-900">{localShopee}</span>
                    <button
                      onClick={() => { setShopeeInput(''); setLocalShopee('') }}
                      className="shrink-0 rounded-lg bg-gray-100 p-2 text-gray-600 active:scale-90 transition-transform"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <a
                      href={localShopee}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 rounded-lg bg-gray-100 p-2 text-gray-600 active:scale-90 transition-transform"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M15 3h6v6" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                    <button
                      onClick={() => navigator.clipboard.writeText(localShopee)}
                      className="shrink-0 rounded-lg bg-gray-100 p-2 text-gray-600 active:scale-90 transition-transform"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button
                      onClick={handleDeleteShopeeLink}
                      disabled={deletingShopeeLink}
                      className="shrink-0 rounded-lg bg-red-50 p-2 text-red-500 active:scale-90 transition-transform disabled:opacity-60"
                    >
                      {deletingShopeeLink ? (
                        <div className="h-4 w-4 rounded-full border-2 border-red-500 border-t-transparent animate-spin" />
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4h4v2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M10 11v6M14 11v6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2">
                    <div
                      contentEditable
                      suppressContentEditableWarning
                      onPaste={(e) => {
                        e.preventDefault()
                        const text = e.clipboardData.getData('text/plain').trim()
                        if (text) setShopeeInput(text)
                      }}
                      onBeforeInput={(e) => e.preventDefault()}
                      onDrop={(e) => e.preventDefault()}
                      className="min-h-[44px] flex-1 break-all rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none"
                      style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
                      inputMode="none"
                    >
                      {shopeeInput && <span className="text-gray-900">{shopeeInput}</span>}
                    </div>
                    <button
                      onClick={handleSaveShopee}
                      disabled={!shopeeInput.trim()}
                      className="shrink-0 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white active:scale-95 transition-all disabled:opacity-50"
                    >
                      บันทึก
                    </button>
                  </div>
                )}
              </div>

              <div>
                <p className="mb-1 px-1 text-[11px] font-bold uppercase tracking-[0.18em] text-gray-400">Lazada Link</p>
                {savingLazada ? (
                  <div className="mt-3 flex items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white px-3 py-3 shadow-sm">
                    <div className="h-4 w-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                    <span className="text-sm text-gray-500">กำลังบันทึก...</span>
                  </div>
                ) : localLazada ? (
                  <div className="mt-3 flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm">
                    <span className="flex-1 truncate text-sm text-gray-900">{localLazada}</span>
                    <button
                      onClick={() => { setLazadaInput(''); setLocalLazada('') }}
                      className="shrink-0 rounded-lg bg-gray-100 p-2 text-gray-600 active:scale-90 transition-transform"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <a
                      href={localLazada}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 rounded-lg bg-gray-100 p-2 text-gray-600 active:scale-90 transition-transform"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M15 3h6v6" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                    <button
                      onClick={() => navigator.clipboard.writeText(localLazada)}
                      className="shrink-0 rounded-lg bg-gray-100 p-2 text-gray-600 active:scale-90 transition-transform"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button
                      onClick={handleDeleteLazadaLink}
                      disabled={deletingLazadaLink}
                      className="shrink-0 rounded-lg bg-red-50 p-2 text-red-500 active:scale-90 transition-transform disabled:opacity-60"
                    >
                      {deletingLazadaLink ? (
                        <div className="h-4 w-4 rounded-full border-2 border-red-500 border-t-transparent animate-spin" />
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4h4v2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M10 11v6M14 11v6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2">
                    <div
                      contentEditable
                      suppressContentEditableWarning
                      onPaste={(e) => {
                        e.preventDefault()
                        const text = e.clipboardData.getData('text/plain').trim()
                        if (text) setLazadaInput(text)
                      }}
                      onBeforeInput={(e) => e.preventDefault()}
                      onDrop={(e) => e.preventDefault()}
                      className="min-h-[44px] flex-1 break-all rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none"
                      style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
                      inputMode="none"
                    >
                      {lazadaInput && <span className="text-gray-900">{lazadaInput}</span>}
                    </div>
                    <button
                      onClick={handleSaveLazada}
                      disabled={!lazadaInput.trim()}
                      className="shrink-0 rounded-2xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white active:scale-95 transition-all disabled:opacity-50"
                    >
                      บันทึก
                    </button>
                  </div>
                )}
              </div>

              {onImport && showWorkspaceBadge && videoNamespaceId && videoNamespaceId !== currentNamespaceId && (
                <button
                  onClick={async () => {
                    setImporting(true)
                    try {
                      await onImport(video.id, videoNamespaceId)
                    } finally {
                      setImporting(false)
                    }
                  }}
                  disabled={importing}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-3 text-sm font-bold text-white active:scale-95 transition-all disabled:opacity-60"
                >
                  {importing ? (
                    <div className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  ) : (
                    <>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
                        <polyline points="7 10 12 15 17 10" strokeLinecap="round" strokeLinejoin="round" />
                        <line x1="12" y1="15" x2="12" y2="3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      นำเข้า Workspace ของฉัน
                    </>
                  )}
                </button>
              )}

              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-red-500 py-3 text-sm font-bold text-white active:scale-95 transition-all"
              >
                {deleting ? (
                  <div className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    ลบวีดีโอ
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative aspect-[9/16] rounded-2xl overflow-hidden cursor-pointer bg-gray-100 shadow-sm active:scale-95 transition-transform duration-200"
      onClick={() => setExpanded(true)}
    >
      <Thumb id={video.id} url={resolveThumbnailDisplayUrl(video as Video & Record<string, unknown>)} fallback={resolvePlayableVideoUrl(video as Video & Record<string, unknown>)} />
      {showWorkspaceBadge && (
        <div className="absolute top-2 left-2">
          <VideoWorkspaceBadge
            videoNamespaceId={videoNamespaceId}
            currentNamespaceId={currentNamespaceId}
          />
        </div>
      )}
      {(getVideoLazadaLink(video as unknown as Record<string, unknown>) || getVideoShopeeLink(video as unknown as Record<string, unknown>)) && (
        <div className={`absolute bottom-2 left-2 text-white w-6 h-6 rounded-full flex items-center justify-center shadow-lg border border-white/20 ${getVideoLazadaLink(video as unknown as Record<string, unknown>) ? 'bg-blue-500' : 'bg-orange-500'}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur-md text-white text-[10px] px-2 py-0.5 rounded-full font-medium">
        {formatDuration(video.duration)}
      </div>

      {showRepostAction && (
        <button
          type="button"
          onClick={handleRepost}
          disabled={reposting}
          title="โพสต์ใหม่"
          aria-label="โพสต์ใหม่"
          className="absolute left-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-amber-50 text-amber-500 shadow-md transition-transform active:scale-95 disabled:opacity-60"
        >
          {reposting ? (
            <div className="h-3.5 w-3.5 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M3 12a9 9 0 0 1 15.3-6.3L21 8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M21 12a9 9 0 0 1-15.3 6.3L3 16" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 16H3v5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      )}
    </div>
  )
}

function GlobalOriginalVideoCard({ video, onExpandedChange }: { video: GlobalOriginalVideo; onExpandedChange?: (expanded: boolean) => void }) {
  const [expanded, setExpanded] = useState(false)
  const ownerLabel = `namespace: ${String(video.namespace_id || '').trim() || '-'}`
  const createdAt = new Date(video.created_at)
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? '-'
    : createdAt.toLocaleString('th-TH', { hour12: false })
  const originalPlaybackUrl = resolveGalleryAssetProxyUrl(video as unknown as Record<string, unknown>, 'original') || video.original_url
  const originalPosterUrl = buildOriginalFramePreviewUrl(video as unknown as Record<string, unknown>)

  useEffect(() => {
    onExpandedChange?.(expanded)
    return () => onExpandedChange?.(false)
  }, [expanded, onExpandedChange])
  useViewerHistory(expanded, setExpanded)

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="relative aspect-[9/16] rounded-2xl overflow-hidden bg-gray-100 shadow-sm active:scale-95 transition-transform duration-200 text-left"
      >
        <video
          src={`${originalPlaybackUrl}#t=0.1`}
          className="w-full h-full object-cover"
          preload="metadata"
          muted
          playsInline
        />
        <div className="absolute left-2 right-2 top-2 bg-black/55 backdrop-blur-sm text-white text-[10px] px-2 py-1 rounded-lg truncate">
          {ownerLabel}
        </div>
        <div className="absolute left-2 right-2 bottom-2 bg-black/55 backdrop-blur-sm text-white text-[10px] px-2 py-1 rounded-lg truncate">
          {video.namespace_id}
        </div>
      </button>

      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="relative w-[88%] max-w-sm">
            <div className="aspect-[9/16] rounded-2xl overflow-hidden bg-black">
              <video
                src={originalPlaybackUrl}
                className="w-full h-full object-cover"
                controls
                autoPlay
                playsInline
                preload="metadata"
                poster={originalPosterUrl || undefined}
              />
            </div>

            <div className="mt-3 rounded-xl bg-white/12 text-white px-3 py-2.5 space-y-1.5">
              <p className="text-sm font-semibold truncate">{ownerLabel}</p>
              <p className="text-xs text-white/80 truncate">{video.namespace_id}</p>
              <p className="text-xs text-white/80 truncate">{createdLabel}</p>
            </div>

            <a
              href={originalPlaybackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 w-full inline-flex items-center justify-center rounded-xl bg-blue-500 text-white py-3 text-sm font-bold active:scale-95 transition-transform"
            >
              เปิดไฟล์ต้นฉบับ
            </a>
          </div>
        </div>
      )}
    </>
  )
}

// Add Page Token Popup
function AddPagePopup({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [userToken, setUserToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{
    imported: number
    updated: number
    conflicts: number
    conflictPages: Array<{ id: string; name: string; existing_bot_id: string }>
  } | null>(null)

  const handleImport = async () => {
    if (!userToken.trim()) {
      setError('กรุณาวาง Facebook User Token')
      return
    }

    setLoading(true)
    setError('')

    try {
      const resp = await apiFetch(`${WORKER_URL}/api/pages/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_token: userToken.trim(),
        })
      })

      const data = await resp.json()

      if (!resp.ok) {
        setError(data.details || data.error || 'เกิดข้อผิดพลาด')
        return
      }

      const imported = Number(data.imported || 0)
      const updated = Number(data.updated || 0)
      const conflicts = Number(data.conflicts || 0)
      const conflictPages = Array.isArray(data.conflict_pages) ? data.conflict_pages : []

      setResult({ imported, updated, conflicts, conflictPages })
      onSuccess()

      if (conflicts === 0) {
        setTimeout(() => {
          onClose()
        }, 1500)
      }
    } catch (e) {
      setError('ไม่สามารถเชื่อมต่อ Server ได้')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        className="bg-white rounded-3xl w-full max-w-md p-6 space-y-4"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-900">เพิ่ม Facebook Pages</h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600">
            <CloseIcon />
          </button>
        </div>

        {/* Instructions */}
        <p className="text-sm text-gray-500">
          วาง Facebook User Token แล้วระบบจะดึงรายการเพจผ่าน <code>me/accounts</code> และใช้ token เดียวกันสำหรับโพสต์กับคอมเมนต์
        </p>

        {/* User Token Input */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Facebook User Token</label>
          <textarea
            value={userToken}
            onChange={(e) => setUserToken(e.target.value)}
            rows={5}
            placeholder="วาง Facebook User Token ที่นี่..."
            className="w-full resize-none rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-sm font-mono text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          <p className="text-[11px] text-gray-500 mt-1">ระบบจะดึงเพจผ่าน Graph API <code>me/accounts</code></p>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 text-red-600 text-sm p-3 rounded-xl">
            {error}
          </div>
        )}

        {/* Success */}
        {result && (
          <>
            <div className="bg-green-50 text-green-600 text-sm p-3 rounded-xl">
              ✅ นำเข้าสำเร็จ! เพิ่มใหม่ {result.imported} เพจ, อัพเดท {result.updated} เพจ
            </div>
            {result.conflicts > 0 && (
              <div className="bg-amber-50 text-amber-700 text-sm p-3 rounded-xl">
                ⚠️ มี {result.conflicts} เพจที่ผูกกับ workspace อื่นอยู่แล้ว
                {result.conflictPages.length > 0 && (
                  <div className="mt-2 text-xs leading-5 space-y-1">
                    {result.conflictPages.slice(0, 5).map((page) => (
                      <div key={page.id}>• {page.name} ({page.id})</div>
                    ))}
                    {result.conflictPages.length > 5 && (
                      <div>และอีก {result.conflictPages.length - 5} เพจ</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Submit Button */}
        <button
          onClick={handleImport}
          disabled={loading || (!!result && result.conflicts === 0)}
          className={`w-full py-3 rounded-xl font-bold text-white transition-all ${loading || result ? 'bg-gray-400' : 'bg-blue-600 active:scale-95'
            }`}
        >
          {loading ? 'กำลังดึงข้อมูล...' : result && result.conflicts === 0 ? 'สำเร็จ!' : 'นำเข้า Pages'}
        </button>
      </div>
    </div>
  )
}

// Page Detail Component
function PageDetail({ page, onBack, onSave }: { page: FacebookPage; onBack: () => void; onSave: (page: FacebookPage) => void }) {
  // Parse post_hours: supports "0:31,9:47" (new), "24:13" (legacy midnight), and "2,9" (legacy hour-only) formats
  const parsePostHours = (raw: string): Record<number, number> => {
    const result: Record<number, number> = {}
    if (!raw) return result
    if (/^every:\d+$/i.test(raw.trim())) return result
    for (const part of raw.split(',')) {
      if (part.includes(':')) {
        const [h, m] = part.split(':').map(Number)
        const normalizedHour = h === 24 ? 0 : h
        if (normalizedHour >= 0 && normalizedHour <= 23 && Number.isFinite(m) && m >= 0 && m <= 59) {
          result[normalizedHour] = m
        }
      } else {
        const h = Number(part)
        const normalizedHour = h === 24 ? 0 : h
        if (normalizedHour >= 0 && normalizedHour <= 23) {
          result[normalizedHour] = Math.floor(Math.random() * 59)
        }
      }
    }
    return result
  }
  const detectScheduleMode = (raw?: string): 'slots' | 'interval' => {
    return /^every:\d+$/i.test(String(raw || '').trim()) ? 'interval' : 'slots'
  }
  const normalizeInterval = (value: number) => {
    const parsed = Number.isFinite(value) ? Math.floor(value) : 60
    return Math.max(5, Math.min(720, parsed))
  }
  const parseInterval = (raw?: string, fallback = 60) => {
    const match = String(raw || '').trim().match(/^every:(\d{1,4})$/i)
    if (!match) return normalizeInterval(fallback)
    return normalizeInterval(parseInt(match[1], 10))
  }

  const [hourMinutes, setHourMinutes] = useState<Record<number, number>>(() => parsePostHours(page.post_hours || ''))
  const selectedHours = Object.keys(hourMinutes).map(Number).sort((a, b) => a - b)
  const [scheduleMode, setScheduleMode] = useState<'slots' | 'interval'>(() => detectScheduleMode(page.post_hours))
  const [intervalMinutes, setIntervalMinutes] = useState<number>(() => parseInterval(page.post_hours, page.post_interval_minutes || 60))
  const [isActive, setIsActive] = useState(page.is_active === 1)
  const [oneCardEnabled, setOneCardEnabled] = useState(page.onecard_enabled === 1)
  const [oneCardLinkMode, setOneCardLinkMode] = useState<'shopee' | 'lazada' | 'none'>(() => {
    const value = String(page.onecard_link_mode || '').trim().toLowerCase()
    if (value === 'lazada') return 'lazada'
    if (value === 'none') return 'none'
    return 'shopee'
  })
  const [oneCardCta, setOneCardCta] = useState<'SHOP_NOW' | 'NO_BUTTON'>(() => {
    const value = String(page.onecard_cta || '').trim().toUpperCase()
    if (value === 'NO_BUTTON') return 'NO_BUTTON'
    return 'SHOP_NOW'
  })
  const [accessToken, setAccessToken] = useState(page.access_token || '')
  const [saving, setSaving] = useState(false)
  const [forcingPost, setForcingPost] = useState(false)
  const [editingToken, setEditingToken] = useState<'access' | null>(null)
  const [editingTokenValue, setEditingTokenValue] = useState('')

  // Hours 00-23 for display
  const hourOptions = Array.from({ length: 24 }, (_, i) => i)

  const renderTokenPreview = (value?: string | null) => {
    const token = String(value || '').trim()
    if (!token) return 'ไม่มีโทเค้น'
    return `${token.slice(0, 20)}...`
  }

  const toggleHour = (hour: number) => {
    const newMap = { ...hourMinutes }
    if (hour in newMap) {
      delete newMap[hour]
    } else {
      newMap[hour] = Math.floor(Math.random() * 59)
    }
    setHourMinutes(newMap)
  }

  const postHoursString = selectedHours.map(h => `${h}:${hourMinutes[h].toString().padStart(2, '0')}`).join(',')

  const handleSave = async () => {
    setSaving(true)
    try {
      const normalizedInterval = normalizeInterval(intervalMinutes)
      const schedulePostHours = scheduleMode === 'interval'
        ? `every:${normalizedInterval}`
        : postHoursString
      const nextToken = accessToken.trim()
      const accessTokenChanged = nextToken !== String(page.access_token || '').trim()
      const payload: Record<string, unknown> = {
        post_hours: schedulePostHours,
        post_interval_minutes: scheduleMode === 'interval' ? normalizedInterval : undefined,
        is_active: isActive,
        onecard_enabled: oneCardEnabled,
        onecard_link_mode: oneCardLinkMode,
        onecard_cta: oneCardCta,
      }
      if (accessTokenChanged) {
        payload.access_token = nextToken
      }

      const resp = await apiFetch(`${WORKER_URL}/api/pages/${encodeURIComponent(page.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await resp.json().catch(() => ({})) as any
      if (!resp.ok) {
        throw new Error(String(data?.details || data?.error || 'บันทึกเพจไม่สำเร็จ'))
      }

      const savedPage = data?.page || {
        ...page,
        post_hours: schedulePostHours,
        post_interval_minutes: scheduleMode === 'interval' ? normalizedInterval : page.post_interval_minutes,
        is_active: isActive ? 1 : 0,
        onecard_enabled: oneCardEnabled ? 1 : 0,
        onecard_link_mode: oneCardLinkMode,
        onecard_cta: oneCardCta,
        access_token: nextToken,
      }

      setAccessToken(savedPage.access_token || '')
      setScheduleMode(detectScheduleMode(savedPage.post_hours))
      setIntervalMinutes(parseInterval(savedPage.post_hours, savedPage.post_interval_minutes || normalizedInterval))
      onSave(savedPage)
      onBack()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleFocusPost = async () => {
    if (forcingPost) return
    const confirmed = window.confirm('โฟกัสโพสต์ตอนนี้ใช่ไหม? ระบบจะดึงคลิปจริงจาก Gallery แล้วโพสต์จริงเหมือน cron ทันที')
    if (!confirmed) return

    setForcingPost(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/pages/${encodeURIComponent(page.id)}/force-post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipComment: false }),
      })
      const data = await resp.json().catch(() => ({})) as {
        success?: boolean
        error?: string
        details?: string
        fb_reel_url?: string
        fb_post_id?: string
      }

      if (!resp.ok) {
        if (resp.status === 409 && data.error === 'page_recently_posted_or_posting') {
          throw new Error('เพจนี้เพิ่งโพสต์ หรือกำลังโพสต์อยู่แล้ว ลองใหม่อีกสักครู่')
        }
        throw new Error(String(data.details || data.error || 'โฟกัสโพสต์ไม่สำเร็จ'))
      }

      onSave({
        ...page,
        last_post_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      alert(data.fb_reel_url
        ? `โฟกัสโพสต์สำเร็จ\n${data.fb_reel_url}`
        : `โฟกัสโพสต์สำเร็จ${data.fb_post_id ? `\nPost ID: ${data.fb_post_id}` : ''}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setForcingPost(false)
    }
  }

  return (
    <div className="h-full flex flex-col px-5">
      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto min-h-0 app-scroll">

        {/* Page Logo */}
        <div className="flex flex-col items-center mb-4">
          {buildFacebookPageProfileUrl(page.id) ? (
            <a
              href={buildFacebookPageProfileUrl(page.id)}
              target="_blank"
              rel="noreferrer"
              aria-label={`เปิดหน้าเพจ ${page.name} บน Facebook`}
              title="เปิดหน้าเพจบน Facebook"
              className="rounded-full focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2"
            >
              <img
                src={page.image_url || getGraphPageImageUrl(page.id)}
                alt={page.name}
                onError={(e) => onPageImageError(e, page.id)}
                className="w-24 h-24 rounded-full object-cover shadow-sm cursor-pointer transition-transform active:scale-95"
              />
            </a>
          ) : (
            <img
              src={page.image_url || getGraphPageImageUrl(page.id)}
              alt={page.name}
              onError={(e) => onPageImageError(e, page.id)}
              className="w-24 h-24 rounded-full object-cover shadow-sm"
            />
          )}
        </div>

        {/* Auto Post toggle */}
        <div className="bg-white border border-gray-100 rounded-2xl p-4 flex items-center justify-between mb-3">
          <p className="font-bold text-gray-900">Auto Post</p>
          <button
            onClick={() => setIsActive(!isActive)}
            className={`w-12 h-7 rounded-full relative transition-colors ${isActive ? 'bg-green-500' : 'bg-gray-300'}`}
          >
            <div className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-all shadow-sm ${isActive ? 'right-1' : 'left-1'}`}></div>
          </button>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-4 mb-3 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-bold text-gray-900">Video One Card</p>
              <p className="text-xs text-gray-400 mt-0.5">เปิดแล้วเพจนี้จะโพสต์ผ่าน Video One Card ส่วนเพจอื่นยังใช้แบบเดิม</p>
            </div>
            <button
              onClick={() => setOneCardEnabled(!oneCardEnabled)}
              className={`w-12 h-7 rounded-full relative transition-colors ${oneCardEnabled ? 'bg-blue-600' : 'bg-gray-300'}`}
            >
              <div className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-all shadow-sm ${oneCardEnabled ? 'right-1' : 'left-1'}`}></div>
            </button>
          </div>

          {oneCardEnabled && (
            <>
              <div>
                <p className="text-xs font-bold text-gray-700 mb-2">ลิงก์ที่ใช้กับปุ่ม</p>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { value: 'shopee', label: 'Shopee' },
                    { value: 'lazada', label: 'Lazada' },
                    { value: 'none', label: 'ไม่ใส่ปุ่ม' },
                  ].map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setOneCardLinkMode(option.value as 'shopee' | 'lazada' | 'none')}
                      className={`py-2 rounded-lg text-sm font-medium transition-all ${oneCardLinkMode === option.value ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {oneCardLinkMode !== 'none' && (
                <div>
                  <p className="text-xs font-bold text-gray-700 mb-2">ข้อความปุ่ม</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[{ value: 'SHOP_NOW', label: 'Shop Now' }].map((option) => (
                      <button
                        key={option.value}
                        onClick={() => setOneCardCta(option.value as 'SHOP_NOW')}
                        className={`py-2 rounded-lg text-sm font-medium transition-all ${oneCardCta === option.value ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="bg-white border border-blue-100 rounded-2xl p-4 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-bold text-gray-900">โฟกัสโพสต์</p>
              <p className="text-xs text-gray-400 mt-0.5">ดึงวิดีโอจริงและโพสต์จริงทันทีเหมือนตอน cron ทำงาน</p>
            </div>
            <button
              onClick={handleFocusPost}
              disabled={forcingPost}
              className={`shrink-0 px-4 py-2.5 rounded-xl text-sm font-bold transition-all ${forcingPost ? 'bg-gray-300 text-white' : 'bg-blue-600 text-white active:scale-95'}`}
            >
              {forcingPost ? 'กำลังโพสต์...' : 'โพสต์ตอนนี้'}
            </button>
          </div>
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-4 mb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-gray-900">Page/User Token</p>
              <p className={`text-xs mt-1 font-mono break-all ${accessToken.trim() ? 'text-gray-500' : 'text-orange-600 font-bold'}`}>
                {renderTokenPreview(accessToken)}
              </p>
              <p className="text-[11px] text-gray-400 mt-2">
                วาง Facebook User Token หรือ Page Token ได้เลย ระบบจะดึง page token ผ่าน <code>me/accounts</code> ให้เองถ้าจำเป็น
              </p>
            </div>
            <button
              onClick={() => {
                setEditingToken('access')
                setEditingTokenValue(accessToken)
              }}
              className="shrink-0 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-bold text-blue-600 active:scale-95"
            >
              แก้ไข
            </button>
          </div>
        </div>

        {/* Token Edit Popup */}
        {editingToken && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-6" onClick={() => setEditingToken(null)}>
            <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-bold text-gray-900 text-base text-center">
                Access Token (โพสต์)
              </h3>
              <textarea
                ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }}
                value={editingTokenValue}
                onChange={(e) => { setEditingTokenValue(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
                placeholder={
                  'วาง Facebook User Token หรือ Page Token ที่นี่...'
                }
                rows={2}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm font-mono outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all resize-none overflow-hidden"
              />
              <p className="text-[11px] text-gray-400">
                ถ้าวาง User Token ระบบจะ resolve ให้เป็น token ของเพจนี้อัตโนมัติ
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setEditingToken(null)}
                  className="flex-1 py-3 rounded-xl font-bold text-sm border border-gray-200 text-gray-600 active:scale-95 transition-all"
                >
                  ยกเลิก
                </button>
                <button
                  onClick={() => {
                    setAccessToken(editingTokenValue)
                    setEditingToken(null)
                  }}
                  className="flex-1 py-3 rounded-xl font-bold text-sm bg-blue-600 text-white active:scale-95 transition-all"
                >
                  บันทึก
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Schedule Mode + Config */}
        <div className="bg-white border border-gray-100 rounded-2xl p-4 mb-3">
          <p className="font-bold text-gray-900 text-sm mb-1">โพสต์เวลาไหนบ้าง</p>
          <div className="flex bg-gray-100 p-1 rounded-xl mb-3">
            <button
              onClick={() => setScheduleMode('slots')}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${scheduleMode === 'slots' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
            >
              ติ๊กเวลา
            </button>
            <button
              onClick={() => setScheduleMode('interval')}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${scheduleMode === 'interval' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
            >
              ทุกๆ X นาที
            </button>
          </div>

          {scheduleMode === 'slots' ? (
            <>
              <p className="text-xs text-gray-400 mb-3">เลือกได้หลายเวลา (กดติ๊ก)</p>
              <div className="grid grid-cols-6 gap-2">
                {hourOptions.map((hour) => (
                  <button
                    key={hour}
                    onClick={() => toggleHour(hour)}
                    className={`py-2 rounded-lg text-sm font-medium transition-all ${selectedHours.includes(hour)
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 text-gray-600'
                      }`}
                  >
                    {hour.toString().padStart(2, '0')}
                  </button>
                ))}
              </div>
              {selectedHours.length > 0 ? (
                <p className="text-xs text-blue-500 mt-3">จะโพสต์เวลา: {selectedHours.map(h => `${h.toString().padStart(2, '0')}:${hourMinutes[h].toString().padStart(2, '0')} น.`).join(', ')}</p>
              ) : (
                <p className="text-xs text-gray-400 mt-3">ยังไม่เลือกเวลา</p>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-gray-400 mb-3">โพสต์วนทุกช่วงเวลา ไม่จำกัดจำนวนโพสต์ต่อวัน</p>
              <div className="grid grid-cols-4 gap-2">
                {[15, 20, 30, 45, 60, 90, 120, 180].map((m) => (
                  <button
                    key={m}
                    onClick={() => setIntervalMinutes(m)}
                    className={`py-2 rounded-lg text-sm font-medium transition-all ${intervalMinutes === m ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}
                  >
                    {m} นาที
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

      </div>{/* End scrollable content */}

      {/* Bottom buttons */}
      <div className="pb-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className={`w-full py-4 rounded-2xl font-bold text-base transition-all ${saving ? 'bg-gray-400 text-white' : 'bg-blue-600 text-white active:scale-95'
            }`}
        >
          {saving ? 'กำลังบันทึก...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// LoginScreen removed — LINE login only

function SettingsMenuItem({
  icon,
  title,
  subtitle,
  onClick,
  danger = false,
}: {
  icon: string
  title: string
  subtitle?: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 rounded-2xl border px-4 py-3 text-left active:scale-[0.99] transition-transform ${danger ? 'border-red-100 bg-red-50/70' : 'border-gray-200 bg-white'
        }`}
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg ${danger ? 'bg-red-100' : 'bg-gray-100'}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-base font-semibold ${danger ? 'text-red-600' : 'text-gray-900'}`}>{title}</p>
        {subtitle && <p className="text-xs text-gray-500 truncate">{subtitle}</p>}
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={danger ? '#dc2626' : '#9ca3af'} strokeWidth="2.5">
        <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function SettingsMenuSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between gap-3 p-4 bg-white rounded-2xl border border-gray-200 animate-pulse">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="w-12 h-12 rounded-full bg-gray-200 flex-shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="h-4 w-40 max-w-full rounded bg-gray-200" />
            <div className="h-5 w-16 rounded-md bg-gray-100" />
          </div>
        </div>
        <div className="w-20 h-10 rounded-xl bg-red-50 border border-red-100" />
      </div>
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={`settings-skeleton-${index}`}
          className="w-full flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 animate-pulse"
        >
          <div className="w-10 h-10 rounded-xl bg-gray-100 flex-shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-28 rounded bg-gray-200" />
            <div className="h-3 w-40 max-w-full rounded bg-gray-100" />
          </div>
          <div className="w-4 h-4 rounded bg-gray-100 flex-shrink-0" />
        </div>
      ))}
      <p className="text-gray-300 text-xs font-medium text-center pt-2">Version 2.0.1 (Build 240)</p>
    </>
  )
}

export type TabName = AppTabRoute

function App({
  controlledTab,
  onControlledTabChange,
  onControlledUrlChange,
}: {
  controlledTab?: TabName
  onControlledTabChange?: (tab: TabName) => void
  onControlledUrlChange?: (url: string, historyMode: 'push' | 'replace') => void
} = {}) {
  const botScope = getBotScopeFromLocation()

  const [token, setTokenState] = useState<string>(() => {
    try {
      const url = new URL(window.location.href)
      const queryToken = (url.searchParams.get('auth_token') || url.searchParams.get('token') || '').trim()
      if (queryToken) {
        const sessionFromQuery = normalizeSessionToken(queryToken)
        if (sessionFromQuery) {
          localStorage.setItem(scopedStorageKey('auth_token', botScope), sessionFromQuery)
        }
        url.searchParams.delete('token');
        url.searchParams.delete('auth_token');
        window.history.replaceState({}, document.title, url.toString());
        if (sessionFromQuery) return sessionFromQuery
      }
      return getToken(botScope)
    } catch { return getToken(botScope) }
  });
  const [authBootstrapping, setAuthBootstrapping] = useState(true)

  const bindTelegramSession = async (sessionToken: string, telegramId: string | number | undefined, botId: string) => {
    const normalizedSessionToken = normalizeSessionToken(sessionToken)
    const normalizedBotId = String(botId || '').trim()
    if (!normalizedSessionToken || !telegramId || !normalizedBotId) return normalizedSessionToken
    try {
      const resp = await fetch(`${WORKER_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': normalizedSessionToken,
        },
        body: JSON.stringify({
          tg_id: telegramId,
          bot_id: normalizedBotId,
        }),
      })
      if (!resp.ok) return normalizedSessionToken
      const data = await resp.json().catch(() => ({})) as { session_token?: string }
      const reboundToken = normalizeSessionToken(data.session_token)
      if (reboundToken && reboundToken !== normalizedSessionToken) {
        localStorage.setItem(scopedStorageKey('auth_token', botScope), reboundToken)
        setTokenState(reboundToken)
        return reboundToken
      }
    } catch { }
    return normalizedSessionToken
  }

  const clearSession = (clearCaches = false) => {
    const currentNs = namespaceId || getStoredNamespace(botScope)
    localStorage.removeItem(scopedStorageKey('auth_token', botScope))
    if (clearCaches) {
      localStorage.removeItem('gallery_cache')
      localStorage.removeItem('used_cache')
      localStorage.removeItem('history_cache')
      localStorage.removeItem(globalCacheKey('gallery'))
      localStorage.removeItem(globalCacheKey('used'))
      localStorage.removeItem(globalCacheKey('history'))
      localStorage.removeItem('categories_cache')
      if (currentNs) {
        localStorage.removeItem(nsCacheKey('gallery', currentNs))
        localStorage.removeItem(nsCacheKey('used', currentNs))
        localStorage.removeItem(nsCacheKey('history', currentNs))
      }
    }
    localStorage.removeItem(scopedStorageKey('auth_namespace', botScope))
    setTokenState('')
    setNamespaceId('')
    setMeEmail('')
    setMeDisplayName('')
    setMePictureUrl('')
    setIsOwner(false)
    setIsSystemAdmin(false)
    setIsTeamMember(false)
    setTeamMembers([])
    setSystemMembers([])
    setVoiceProfile(createDefaultVoiceProfile())
    setVoiceProfileDraft(createDefaultVoiceProfile())
    setVoiceSettingsSource('default')
    setVoiceSettingsUpdatedAt('')
    setVoiceSettingsMessage('')
    setVoiceSettingsLoading(false)
    setVoiceSettingsSaving(false)
    setVoiceOptions([])
    setLegacyVoicePromptActive(false)
    if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl)
    setVoicePreviewUrl('')
    setVoicePreviewLoading(false)
    setVoicePreviewMessage('')
    setCommentTemplate(DEFAULT_COMMENT_TEMPLATE)
    setCommentTemplateDraft(DEFAULT_COMMENT_TEMPLATE)
    setCommentTemplateSource('default')
    setCommentTemplateUpdatedAt('')
    setCommentTemplateMessage('')
    setCommentTemplateLoading(false)
    setCommentTemplateSaving(false)
    setCommentTemplateMaxChars(4000)
    setGeminiApiKeyDrafts(createEmptyGeminiKeySlots())
    setGeminiApiKeyMaskedList(createEmptyGeminiKeySlots())
    setGeminiApiKeySource('none')
    setGeminiApiKeyUpdatedAt('')
    setGeminiApiKeyMessage('')
    setGeminiApiKeyLoading(false)
    setGeminiApiKeySaving(false)
    setGeminiApiKeyMaxChars(512)
    setGeminiApiKeyMaxSlots(DEFAULT_GEMINI_KEY_SLOTS)
    setShortlinkBaseUrlCurrent('')
    setLazadaShortlinkBaseUrlCurrent('')
    setShortlinkAccountCurrent('')
    setShortlinkAccountDraft('')
    setShortlinkExpectedUtmIdCurrent('')
    setShortlinkExpectedUtmIdDraft('')
    setLazadaExpectedMemberIdCurrent('')
    setLazadaExpectedMemberIdDraft('')
    setShortlinkEnabled(false)
    setShortlinkUpdatedAt('')
    setShortlinkMessage('')
    setShortlinkLoading(false)
    setShortlinkSaving(false)
    setShortlinkAccountMaxChars(64)
    setShortlinkExpectedUtmIdMaxChars(32)
    setLazadaExpectedMemberIdMaxChars(32)
    setPages([])
    setVideos([])
    setUsedVideos([])
    setProcessingVideos([])
    setPendingShortlinkVideos([])
    setProcessingLoading(true)
    setSystemGalleryStats({ total: 0, withLink: 0, withoutLink: 0, shopeeTotal: 0, lazadaTotal: 0 })
    setGallerySummary({ libraryTotal: 0, inventoryTotal: 0, readyTotal: 0 })
    setProcessingSummary({
      libraryTotal: 0,
      inventoryTotal: 0,
      readyTotal: 0,
      pendingTotal: 0,
      pendingHasLazadaTotal: 0,
      pendingMissingLazadaTotal: 0,
    })
    setSystemGalleryHasMore(false)
    setGalleryLoadingMore(false)
    setGalleryReadyTotalCount(0)
    setGalleryUsedTotalCount(0)
    setGalleryUsedHasMore(false)
    setInboxHasMore(false)
    setInboxLoadingMore(false)
    setSystemInboxHasMore(false)
    setSystemInboxLoadingMore(false)
    setGlobalOriginalVideos([])
    setGlobalOriginalLoading(false)
    setPostHistory([])
    setLoading(true)
    setGalleryLoading(true)
  }

  // handleLogin removed — LINE login only

  const handleLogout = async () => {
    if (logoutLoading) return
    setLogoutLoading(true)
    try {
      if (token) {
        await apiFetch(`${WORKER_URL}/api/auth/logout`, { method: 'POST' }).catch(() => null)
      }
    } finally {
      clearSession(true)
      setSettingsSection('menu')
      setAuthBootstrapping(false)
      setLogoutLoading(false)
    }
  }

  const [invitingTeam, setInvitingTeam] = useState(false)
  const handleInviteTeam = async () => {
    setInvitingTeam(true)
    try {
      const liff = (window as any).liff
      if (!liff || !liff.shareTargetPicker) {
        setInvitingTeam(false)
        // Fallback: copy invite link
        const url = `https://liff.line.me/2009652996-DJtEhoDn?invite=${encodeURIComponent(namespaceId)}`
        try { await navigator.clipboard.writeText(url) } catch {}
        alert('คัดลอกลิงก์เชิญแล้ว ส่งให้เพื่อนได้เลย!\n' + url)
        return
      }

      const inviteUrl = `https://liff.line.me/2009652996-DJtEhoDn?invite=${encodeURIComponent(namespaceId)}`
      await liff.shareTargetPicker([{
        type: 'flex',
        altText: 'เชิญเข้าร่วม Affiliate AiBot',
        contents: {
          type: 'bubble',
          hero: {
            type: 'box',
            layout: 'vertical',
            paddingAll: '20px',
            backgroundColor: '#3B82F6',
            contents: [{
              type: 'text',
              text: 'Affiliate AiBot',
              color: '#FFFFFF',
              weight: 'bold',
              size: 'xl',
              align: 'center'
            }]
          },
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: 'คุณได้รับเชิญให้เข้าร่วมใช้งาน',
                size: 'sm',
                color: '#666666',
                align: 'center'
              },
              {
                type: 'text',
                text: 'ระบบสร้างคอนเทนต์ด้วย AI',
                size: 'sm',
                color: '#666666',
                align: 'center',
                margin: 'sm'
              }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [{
              type: 'button',
              action: {
                type: 'uri',
                label: 'เข้าใช้งานเลย',
                uri: inviteUrl
              },
              style: 'primary',
              color: '#06C755'
            }]
          }
        }
      }])
      // บันทึก pending invite
      await apiFetch(`${WORKER_URL}/api/team/invite`, { method: 'POST' }).catch(() => {})
      void loadTeam()
    } catch (e) {
      console.error('shareTargetPicker error:', e)
    } finally {
      setInvitingTeam(false)
    }
  }

  const [isOwner, setIsOwner] = useState(false)
  const [meEmail, setMeEmail] = useState('')
  const [meDisplayName, setMeDisplayName] = useState('')
  const [mePictureUrl, setMePictureUrl] = useState('')
  const [meLineUserId, setMeLineUserId] = useState('')
  const [copiedIdentityField, setCopiedIdentityField] = useState<'namespace' | 'line' | ''>('')
  const [isTeamMember, setIsTeamMember] = useState(false)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  // newMemberEmail removed — using LINE shareTargetPicker
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile>(() => createDefaultVoiceProfile())
  const [voiceProfileDraft, setVoiceProfileDraft] = useState<VoiceProfile>(() => createDefaultVoiceProfile())
  const [voiceSettingsSource, setVoiceSettingsSource] = useState<VoiceSettingsSource>('default')
  const [voiceSettingsUpdatedAt, setVoiceSettingsUpdatedAt] = useState('')
  const [voiceSettingsMessage, setVoiceSettingsMessage] = useState('')
  const [voiceSettingsLoading, setVoiceSettingsLoading] = useState(false)
  const [voiceSettingsSaving, setVoiceSettingsSaving] = useState(false)
  const [voiceOptions, setVoiceOptions] = useState<GeminiVoiceOption[]>([])
  const [voiceStylePromptMaxChars, setVoiceStylePromptMaxChars] = useState(1200)
  const [legacyVoicePromptActive, setLegacyVoicePromptActive] = useState(false)
  const [voicePreviewUrl, setVoicePreviewUrl] = useState('')
  const [voicePreviewLoading, setVoicePreviewLoading] = useState(false)
  const [voicePreviewMessage, setVoicePreviewMessage] = useState('')
  const [coverTextStyle, setCoverTextStyle] = useState<CoverTextStyleSettings>(() => createDefaultCoverTextStyle())
  const [coverTextStyleDraft, setCoverTextStyleDraft] = useState<CoverTextStyleSettings>(() => createDefaultCoverTextStyle())
  const [coverTextStyleUpdatedAt, setCoverTextStyleUpdatedAt] = useState('')
  const [coverTextStyleMessage, setCoverTextStyleMessage] = useState('')
  const [coverTextStyleLoading, setCoverTextStyleLoading] = useState(false)
  const [coverTextStyleSaving, setCoverTextStyleSaving] = useState(false)
  const [commentTemplate, setCommentTemplate] = useState(DEFAULT_COMMENT_TEMPLATE)
  const [commentTemplateDraft, setCommentTemplateDraft] = useState(DEFAULT_COMMENT_TEMPLATE)
  const [commentTemplateSource, setCommentTemplateSource] = useState<'default' | 'custom'>('default')
  const [commentTemplateUpdatedAt, setCommentTemplateUpdatedAt] = useState('')
  const [commentTemplateMessage, setCommentTemplateMessage] = useState('')
  const [commentTemplateLoading, setCommentTemplateLoading] = useState(false)
  const [commentTemplateSaving, setCommentTemplateSaving] = useState(false)
  const [commentTemplateMaxChars, setCommentTemplateMaxChars] = useState(4000)
  const copiedIdentityTimerRef = useRef<number | null>(null)
  const [geminiApiKeyDrafts, setGeminiApiKeyDrafts] = useState<string[]>(() => createEmptyGeminiKeySlots())
  const [geminiApiKeyMaskedList, setGeminiApiKeyMaskedList] = useState<string[]>(() => createEmptyGeminiKeySlots())
  const [geminiApiKeySource, setGeminiApiKeySource] = useState<GeminiKeySource>('none')
  const [geminiApiKeyUpdatedAt, setGeminiApiKeyUpdatedAt] = useState('')
  const [geminiApiKeyMessage, setGeminiApiKeyMessage] = useState('')
  const [geminiApiKeyLoading, setGeminiApiKeyLoading] = useState(false)
  const [geminiApiKeySaving, setGeminiApiKeySaving] = useState(false)
  const [geminiApiKeyMaxChars, setGeminiApiKeyMaxChars] = useState(512)
  const [geminiApiKeyMaxSlots, setGeminiApiKeyMaxSlots] = useState(DEFAULT_GEMINI_KEY_SLOTS)
  const [shortlinkAccountDraft, setShortlinkAccountDraft] = useState(() => getStoredShortlinkAccount(botScope))
  const [shortlinkAccountCurrent, setShortlinkAccountCurrent] = useState(() => getStoredShortlinkAccount(botScope))
  const [shortlinkBaseUrlCurrent, setShortlinkBaseUrlCurrent] = useState(() => getStoredShortlinkBaseUrl(botScope))
  const [lazadaShortlinkBaseUrlCurrent, setLazadaShortlinkBaseUrlCurrent] = useState(() => getStoredLazadaShortlinkBaseUrl(botScope))
  const [shortlinkExpectedUtmIdDraft, setShortlinkExpectedUtmIdDraft] = useState(() => getStoredShortlinkExpectedUtmId(botScope))
  const [shortlinkExpectedUtmIdCurrent, setShortlinkExpectedUtmIdCurrent] = useState(() => getStoredShortlinkExpectedUtmId(botScope))
  const [lazadaExpectedMemberIdDraft, setLazadaExpectedMemberIdDraft] = useState(() => getStoredLazadaExpectedMemberId(botScope))

  useEffect(() => {
    return () => {
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl)
    }
  }, [voicePreviewUrl])
  const [lazadaExpectedMemberIdCurrent, setLazadaExpectedMemberIdCurrent] = useState(() => getStoredLazadaExpectedMemberId(botScope))
  const [shortlinkEnabled, setShortlinkEnabled] = useState(() => hasStoredAffiliateShortlinkConfig(botScope))
  const [shortlinkUpdatedAt, setShortlinkUpdatedAt] = useState('')
  const [shortlinkMessage, setShortlinkMessage] = useState('')
  const [shortlinkLoading, setShortlinkLoading] = useState(false)
  const [shortlinkSaving, setShortlinkSaving] = useState(false)
  const [shortlinkAccountMaxChars, setShortlinkAccountMaxChars] = useState(64)
  const [shortlinkExpectedUtmIdMaxChars, setShortlinkExpectedUtmIdMaxChars] = useState(32)
  const [lazadaExpectedMemberIdMaxChars, setLazadaExpectedMemberIdMaxChars] = useState(32)
  const [postingOrderCurrent, setPostingOrderCurrent] = useState<PostingOrderOption>('oldest_first')
  const [postingOrderDraft, setPostingOrderDraft] = useState<PostingOrderOption>('oldest_first')
  const [postingOrderUpdatedAt, setPostingOrderUpdatedAt] = useState('')
  const [postingOrderMessage, setPostingOrderMessage] = useState('')
  const [postingOrderLoading, setPostingOrderLoading] = useState(false)
  const [postingOrderSaving, setPostingOrderSaving] = useState(false)
  const [logoutLoading, setLogoutLoading] = useState(false)
  const validSettingsSections: SettingsSection[] = ['menu', 'account', 'pages', 'team', 'gemini', 'shortlink', 'post', 'voice', 'cover', 'comment', 'members', 'monitor']
  const getPathSegments = (pathname = window.location.pathname) =>
    String(pathname || '')
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
  const getSettingsSectionFromLocation = (): SettingsSection => {
    const pathSegments = getPathSegments()
    const pathTab = pathSegments[0] || ''
    const pathSection = pathTab === 'settings' ? String(pathSegments[1] || '').trim() : ''
    const params = new URLSearchParams(window.location.search)
    const sectionParam = String(params.get('section') || '').trim()
    const tabParam = params.get('tab')
    if (pathSection && validSettingsSections.includes(pathSection as SettingsSection)) return pathSection as SettingsSection
    if (sectionParam && validSettingsSections.includes(sectionParam as SettingsSection)) return sectionParam as SettingsSection
    if (pathTab === 'pages' || tabParam === 'pages') return 'pages'
    return 'menu'
  }
  const getSelectedPageIdFromLocation = () => {
    const pathSegments = getPathSegments()
    if (pathSegments[0] === 'settings' && pathSegments[1] === 'pages') {
      return String(pathSegments[2] || '').trim()
    }
    return String(new URLSearchParams(window.location.search).get('page_id') || '').trim()
  }
  const getInitialSettingsSection = (): SettingsSection => getSelectedPageIdFromLocation() ? 'pages' : getSettingsSectionFromLocation()
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(getInitialSettingsSection)
  const [namespaceId, setNamespaceId] = useState<string>(() => getStoredNamespace(botScope))
  const [isSystemAdmin, setIsSystemAdmin] = useState(false)
  const [pendingApproval, setPendingApproval] = useState(false)
  const [systemMembers, setSystemMembers] = useState<SystemMember[]>([])
  const [systemMembersLoading, setSystemMembersLoading] = useState(false)
  const [monitorData, setMonitorData] = useState<MonitorResponse | null>(null)
  const [monitorLoading, setMonitorLoading] = useState(false)
  const [monitorView, setMonitorView] = useState<'overview' | 'cron' | 'stale' | 'post' | 'comment'>('overview')
  const [approvingUserId, setApprovingUserId] = useState<string | null>(null)
  const [rejectingUserId, setRejectingUserId] = useState<string | null>(null)
  const [savingMemberRoleId, setSavingMemberRoleId] = useState<string | null>(null)
  const [postHistory, setPostHistory] = useState<PostHistory[]>(() => {
    const ns = getStoredNamespace()
    if (ns) return readCache<PostHistory[]>(nsCacheKey('history', ns), [])
    return []
  })
  const [deletingLogId, setDeletingLogId] = useState<number | null>(null)
  const [retryingLogId, setRetryingLogId] = useState<number | null>(null)
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null)
  const [videos, setVideos] = useState<Video[]>(() => {
    return readGalleryCacheForScope(botScope, getStoredNamespace(botScope), false)
  })
  const [usedVideos, setUsedVideos] = useState<Video[]>(() => {
    return readUsedGalleryCacheForScope(botScope, getStoredNamespace(botScope), false)
  })
  const [globalOriginalVideos, setGlobalOriginalVideos] = useState<GlobalOriginalVideo[]>([])
  const [globalOriginalLoading, setGlobalOriginalLoading] = useState(false)
  const [processingVideos, setProcessingVideos] = useState<Video[]>(() => {
    const ns = getStoredNamespace(botScope)
    return ns ? readCache<Video[]>(processingCacheKey(ns), []) : []
  })
  const [pendingShortlinkVideos, setPendingShortlinkVideos] = useState<Video[]>([])
  const [processingLoading, setProcessingLoading] = useState(() => {
    const ns = getStoredNamespace(botScope)
    return ns ? readCache<Video[]>(processingCacheKey(ns), []).length === 0 : true
  })
  const [retryingProcessingId, setRetryingProcessingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => {
    if (FORCE_SYSTEM_WIDE_GALLERY) {
      return readCache<Video[]>(systemGalleryCacheKey(botScope), []).length === 0
    }
    const ns = getStoredNamespace(botScope)
    if (ns) {
      const hasGallery = readCache<Video[]>(nsCacheKey('gallery', ns), []).length > 0
      const hasUsed = readCache<Video[]>(nsCacheKey('used', ns), []).length > 0
      const hasHistory = readCache<PostHistory[]>(nsCacheKey('history', ns), []).length > 0
      return !(hasGallery || hasUsed || hasHistory)
    }
    return readCache<Video[]>(globalCacheKey('gallery'), []).length === 0
  })
  const [galleryLoading, setGalleryLoading] = useState(() => {
    return readGalleryCacheForScope(botScope, getStoredNamespace(botScope), false).length === 0
  })
  const [galleryBootstrapPending, setGalleryBootstrapPending] = useState(false)
  const [_systemGalleryStats, setSystemGalleryStats] = useState<SystemGalleryStats>({ total: 0, withLink: 0, withoutLink: 0, shopeeTotal: 0, lazadaTotal: 0 })
  const [, setGallerySummary] = useState<GallerySummaryStats>({ libraryTotal: 0, inventoryTotal: 0, readyTotal: 0 })
  const [, setProcessingSummary] = useState<ProcessingSummaryStats>({
    libraryTotal: 0,
    inventoryTotal: 0,
    readyTotal: 0,
    pendingTotal: 0,
    pendingHasLazadaTotal: 0,
    pendingMissingLazadaTotal: 0,
  })
  const [systemGalleryHasMore, setSystemGalleryHasMore] = useState(false)
  const [galleryLoadingMore, setGalleryLoadingMore] = useState(false)
  // Get today's date in YYYY-MM-DD format for Thailand timezone
  const getTodayString = () => {
    const now = new Date()
    const thaiTime = new Date(now.getTime() + 7 * 60 * 60 * 1000)
    return thaiTime.toISOString().split('T')[0]
  }

  useEffect(() => {
    return () => {
      if (copiedIdentityTimerRef.current !== null) {
        window.clearTimeout(copiedIdentityTimerRef.current)
      }
    }
  }, [])

  const handleCopyAccountIdentity = async (field: 'namespace' | 'line', value: string) => {
    const copied = await copyPlainText(value)
    if (!copied) return
    if (copiedIdentityTimerRef.current !== null) {
      window.clearTimeout(copiedIdentityTimerRef.current)
    }
    setCopiedIdentityField(field)
    copiedIdentityTimerRef.current = window.setTimeout(() => {
      setCopiedIdentityField('')
      copiedIdentityTimerRef.current = null
    }, 1500)
  }


  const [categoryFilter, setCategoryFilter] = useState<GalleryFilter>('ready')
  const [gallerySearchInput, setGallerySearchInput] = useState(getInitialGallerySearchInput)
  const [dashboardDateFilter, setDashboardDateFilter] = useState<string>(getTodayString())
  const [dashboardLoading, setDashboardLoading] = useState(false)
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(() => {
    const ns = getStoredNamespace(botScope)
    return ns ? readCache<DashboardData | null>(dashboardCacheKey(ns, getTodayString()), null) : null
  })
  const [logDateFilter, setLogDateFilter] = useState<string>(getTodayString())
  const [logNowMs, setLogNowMs] = useState(() => Date.now())
  const [visibleLogCount, setVisibleLogCount] = useState(0)
  const [galleryHeaderHeight, setGalleryHeaderHeight] = useState(0)
  // Read initial tab from URL path or query param
  const validTabs: TabName[] = ['dashboard', 'inbox', 'processing', 'gallery', 'logs', 'settings']
  const matchTab = (val: string): TabName | null => {
    const t = val.replace(/^\/+/, '').replace(/\?.*/, '').split('/').filter(Boolean)[0] || ''
    if (t === 'pages') return 'settings'
    if (validTabs.includes(t as TabName)) return t as TabName
    return null
  }
  const getInitialTab = (): TabName => {
    // 1. URL path
    const fromPath = matchTab(window.location.pathname)
    if (fromPath) { try { localStorage.setItem('_liff_tab', fromPath) } catch {} return fromPath }

    // 2. ?tab= param
    const params = new URLSearchParams(window.location.search)
    const fromParam = matchTab(params.get('tab') || '')
    if (fromParam) { try { localStorage.setItem('_liff_tab', fromParam) } catch {} return fromParam }

    // 3. ?liff.state= (LIFF encodes the extra path here during redirect)
    const liffState = params.get('liff.state') || ''
    if (liffState) {
      const fromLiff = matchTab(decodeURIComponent(liffState))
      if (fromLiff) { try { localStorage.setItem('_liff_tab', fromLiff) } catch {} return fromLiff }
    }

    // 4. localStorage (survives LIFF multi-redirect)
    try {
      const saved = localStorage.getItem('_liff_tab')
      if (saved && validTabs.includes(saved as TabName)) {
        localStorage.removeItem('_liff_tab')
        return saved as TabName
      }
    } catch {}

    return 'dashboard'
  }

  const getTabFromCurrentLocation = (): TabName => {
    const fromPath = matchTab(window.location.pathname)
    if (fromPath) return fromPath

    const params = new URLSearchParams(window.location.search)
    const fromParam = matchTab(params.get('tab') || '')
    if (fromParam) return fromParam

    const liffState = params.get('liff.state') || ''
    if (liffState) {
      const fromLiff = matchTab(decodeURIComponent(liffState))
      if (fromLiff) return fromLiff
    }

    return 'dashboard'
  }

  const [tab, _setTab] = useState<TabName>(controlledTab ?? getInitialTab())
  const [selectedPageHistoryId, setSelectedPageHistoryId] = useState<string>(getSelectedPageIdFromLocation)
  const buildAppUrl = (
    nextTab: TabName,
    nextSearchInput: string,
    options?: {
      settingsSection?: SettingsSection
      pageId?: string | null
    },
  ) => {
    const url = new URL(window.location.href)
    const mergedSearch = getMergedSearchParams(url.search)
    url.search = mergedSearch.toString() ? `?${mergedSearch.toString()}` : ''
    url.pathname = controlledTab ? getAppTabPath(nextTab) : `/${nextTab}`
    // Clear LIFF legacy routing params once the app owns navigation.
    url.searchParams.delete('tab')
    url.searchParams.delete('liff.state')
    if (nextTab === 'gallery') {
      const trimmedSearch = String(nextSearchInput || '').trim()
      if (trimmedSearch) url.searchParams.set('q', trimmedSearch)
      else url.searchParams.delete('q')
    } else {
      url.searchParams.delete('q')
    }
    const nextPageId = nextTab === 'settings'
      ? String((options?.pageId ?? selectedPageHistoryId) || '').trim()
      : ''
    const nextSettingsSection = nextTab === 'settings'
      ? (nextPageId ? 'pages' : (options?.settingsSection ?? settingsSection))
      : 'menu'
    if (nextTab === 'settings') {
      url.pathname = '/settings'
    }
    if (nextTab === 'settings' && nextSettingsSection !== 'menu') {
      url.searchParams.set('section', nextSettingsSection)
    } else {
      url.searchParams.delete('section')
    }
    if (nextTab === 'settings' && nextPageId) {
      url.searchParams.set('page_id', nextPageId)
    } else {
      url.searchParams.delete('page_id')
    }
    return url.toString()
  }
  const syncAppUrl = (
    nextTab: TabName,
    nextSearchInput: string,
    historyMode: 'push' | 'replace' = 'replace',
    options?: {
      settingsSection?: SettingsSection
      pageId?: string | null
    },
  ) => {
    const nextUrl = buildAppUrl(nextTab, nextSearchInput, options)
    if (nextUrl === window.location.href) return

    if (controlledTab && onControlledUrlChange) {
      onControlledUrlChange(nextUrl, historyMode)
      return
    }

    if (historyMode === 'push') {
      try { localStorage.setItem('_liff_tab', nextTab) } catch {}
      window.location.assign(nextUrl)
      return
    }

    window.history.replaceState(null, '', nextUrl)
  }
  const setTab = (t: TabName) => {
    if (t !== 'settings') {
      setSelectedPage(null)
      setSelectedPageHistoryId('')
      setSettingsSection('menu')
    }
    _setTab(t)
    if (controlledTab) {
      onControlledTabChange?.(t)
      return
    }
    syncAppUrl(t, gallerySearchInput, 'push')
  }
  const openSettingsSection = (section: SettingsSection) => {
    setSelectedPage(null)
    setSelectedPageHistoryId('')
    setSettingsSection(section)
    if (section === 'monitor') setMonitorView('overview')
    syncAppUrl('settings', gallerySearchInput, 'push', { settingsSection: section, pageId: null })
  }
  const openSelectedPage = (page: FacebookPage) => {
    setSettingsSection('pages')
    setSelectedPage(page)
    setSelectedPageHistoryId(page.id)
    syncAppUrl('settings', gallerySearchInput, 'push', { settingsSection: 'pages', pageId: page.id })
  }
  const closeSelectedPage = () => {
    setSelectedPage(null)
    setSelectedPageHistoryId('')
    syncAppUrl('settings', gallerySearchInput, 'replace', { settingsSection: 'pages', pageId: null })
  }
  const [pages, setPages] = useState<FacebookPage[]>([])
  const [inboxVideos, setInboxVideos] = useState<InboxVideo[]>(() => {
    const ns = getStoredNamespace(botScope)
    return ns ? readCache<InboxVideo[]>(nsInboxCacheKey(ns), []) : []
  })
  const [systemInboxVideos, setSystemInboxVideos] = useState<InboxVideo[]>(() => readCache<InboxVideo[]>(systemInboxCacheKey(botScope), []))
  const [systemInboxLoading, setSystemInboxLoading] = useState(false)
  const [selectedPage, setSelectedPage] = useState<FacebookPage | null>(null)
  const [showAddPagePopup, setShowAddPagePopup] = useState(false)
  const [inboxLoading, setInboxLoading] = useState(false)
  const [inboxLoadingMore, setInboxLoadingMore] = useState(false)
  const [inboxHasMore, setInboxHasMore] = useState(false)
  const [pagesLoading, setPagesLoading] = useState(false)
  const [deletePageId, setDeletePageId] = useState<string | null>(null)
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null)
  const [startingInboxId, setStartingInboxId] = useState<string | null>(null)
  const [deletingInboxId, setDeletingInboxId] = useState<string | null>(null)
  const [videoViewerOpen, setVideoViewerOpen] = useState(false)
  const processingFetchInFlightRef = useRef(false)
  const postHistoryFetchInFlightRef = useRef(false)
  const lastPostHistoryFetchKeyRef = useRef('')
  const lastPostHistoryFetchAtRef = useRef(0)
  const galleryReadyCountRef = useRef(videos.length)
  const galleryUsedCountRef = useRef(usedVideos.length)
  const dashboardRequestRef = useRef(0)
  const inboxRequestRef = useRef(0)
  const systemInboxRequestRef = useRef(0)
  const globalOriginalFetchInFlightRef = useRef(false)
  const loadPagesRequestRef = useRef(0)
  const loadTeamRequestRef = useRef(0)
  const lastGlobalOriginalFetchAtRef = useRef(0)
  // Admin now uses its own namespace gallery only. The old mixed system-wide
  // gallery/import flow is no longer part of the active product flow.
  const systemWideGalleryMode = FORCE_SYSTEM_WIDE_GALLERY
  const useSystemWideAdminGallery = false
  const mainScrollRef = useRef<HTMLDivElement | null>(null)
  const galleryHeaderRef = useRef<HTMLDivElement | null>(null)
  const galleryLoadMoreRef = useRef<HTMLDivElement | null>(null)
  const inboxLoadMoreRef = useRef<HTMLDivElement | null>(null)
  const systemGalleryRequestRef = useRef(0)
  const usedGalleryRequestRef = useRef(0)
  const systemAdminGalleryDefaultAppliedRef = useRef(false)
  const deletedGalleryKeysRef = useRef<Set<string>>(new Set())
  const deferredGallerySearchInput = useDeferredValue(gallerySearchInput)
  const gallerySearchQuery = useMemo(
    () => normalizeGallerySearchQuery(deferredGallerySearchInput),
    [deferredGallerySearchInput]
  )
  const [systemInboxLoadingMore, setSystemInboxLoadingMore] = useState(false)
  const [systemInboxHasMore, setSystemInboxHasMore] = useState(false)
  const [galleryReadyTotalCount, setGalleryReadyTotalCount] = useState(videos.length)
  const [galleryUsedTotalCount, setGalleryUsedTotalCount] = useState(usedVideos.length)
  const [galleryUsedHasMore, setGalleryUsedHasMore] = useState(false)

  const syncNavigationStateFromLocation = () => {
    const nextTab = getTabFromCurrentLocation()
    _setTab(nextTab)

    if (nextTab === 'gallery') {
      setGallerySearchInput(getInitialGallerySearchInput())
    } else {
      setGallerySearchInput('')
    }

    if (nextTab !== 'settings') {
      setSettingsSection('menu')
      setSelectedPageHistoryId('')
      setSelectedPage(null)
      return
    }

    const nextPageId = getSelectedPageIdFromLocation()
    setSettingsSection(nextPageId ? 'pages' : getSettingsSectionFromLocation())
    setSelectedPageHistoryId(nextPageId)
    if (!nextPageId) setSelectedPage(null)
  }

  useEffect(() => {
    const urlSearch = getInitialGallerySearchInput()
    if (tab === 'gallery') {
      if (urlSearch) {
        setGallerySearchInput(urlSearch)
        return
      }
    }
    setGallerySearchInput('')
  }, [botScope, namespaceId, tab])
  useEffect(() => {
    if (controlledTab) {
      const shouldSyncGallerySearch = tab === 'gallery'
      const shouldSyncSettingsSubpage = tab === 'settings' && (
        settingsSection !== 'menu'
        || !!selectedPageHistoryId
      )
      if (!shouldSyncGallerySearch && !shouldSyncSettingsSubpage) return
    }

    syncAppUrl(tab, gallerySearchInput, 'replace', {
      settingsSection,
      pageId: selectedPageHistoryId,
    })
  }, [tab, gallerySearchInput, settingsSection, selectedPageHistoryId, controlledTab])
  useEffect(() => {
    if (controlledTab) {
      _setTab(controlledTab)
    }
  }, [controlledTab])
  useEffect(() => {
    const handlePopState = () => {
      if (controlledTab) return
      syncNavigationStateFromLocation()
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [controlledTab])
  useEffect(() => {
    if (!selectedPageHistoryId) {
      setSelectedPage((prev) => (prev ? null : prev))
      return
    }
    const matchedPage = pages.find((page) => page.id === selectedPageHistoryId) || null
    if (!matchedPage) return
    setSelectedPage((prev) => (prev?.id === matchedPage.id ? prev : matchedPage))
  }, [pages, selectedPageHistoryId])

  const tg = window.Telegram?.WebApp
  const hydrateNamespaceCaches = (ns: string, systemWide = false) => {
    const scopedNamespace = String(ns || '').trim()
    if (!scopedNamespace) return
    const cachedVideos = readGalleryCacheForScope(botScope, scopedNamespace, systemWide)
    const cachedUsedVideos = readUsedGalleryCacheForScope(botScope, scopedNamespace, systemWide)
    const cachedHistory = readCache<PostHistory[]>(nsCacheKey('history', scopedNamespace), [])
    const cachedInbox = readCache<InboxVideo[]>(nsInboxCacheKey(scopedNamespace), [])
    const cachedDashboard = readCache<DashboardData | null>(dashboardCacheKey(scopedNamespace, dashboardDateFilter), null)
    setVideos(cachedVideos)
    setUsedVideos(cachedUsedVideos)
    setGalleryReadyTotalCount(cachedVideos.length)
    setGalleryUsedTotalCount(cachedUsedVideos.length)
    setPostHistory(cachedHistory)
    setInboxVideos(cachedInbox)
    setDashboardData(cachedDashboard)
    setGalleryLoading(cachedVideos.length === 0)
    setInboxLoading(cachedInbox.length === 0)
    if (cachedVideos.length > 0 || cachedUsedVideos.length > 0 || cachedHistory.length > 0 || cachedInbox.length > 0 || !!cachedDashboard) {
      setLoading(false)
    }
  }

  useEffect(() => {
    try {
      if (namespaceId) localStorage.setItem(scopedStorageKey('auth_namespace', botScope), namespaceId)
      else localStorage.removeItem(scopedStorageKey('auth_namespace', botScope))
    } catch { }
  }, [botScope, namespaceId])

  useEffect(() => {
    try {
      if (shortlinkBaseUrlCurrent) localStorage.setItem(scopedStorageKey('shortlink_base_url', botScope), shortlinkBaseUrlCurrent)
      else localStorage.removeItem(scopedStorageKey('shortlink_base_url', botScope))

      if (shortlinkAccountCurrent) localStorage.setItem(scopedStorageKey('shortlink_account', botScope), shortlinkAccountCurrent)
      else localStorage.removeItem(scopedStorageKey('shortlink_account', botScope))

      if (lazadaShortlinkBaseUrlCurrent) localStorage.setItem(scopedStorageKey('lazada_shortlink_base_url', botScope), lazadaShortlinkBaseUrlCurrent)
      else localStorage.removeItem(scopedStorageKey('lazada_shortlink_base_url', botScope))

      if (shortlinkExpectedUtmIdCurrent) localStorage.setItem(scopedStorageKey('shortlink_expected_utm_id', botScope), shortlinkExpectedUtmIdCurrent)
      else localStorage.removeItem(scopedStorageKey('shortlink_expected_utm_id', botScope))

      if (lazadaExpectedMemberIdCurrent) localStorage.setItem(scopedStorageKey('lazada_expected_member_id', botScope), lazadaExpectedMemberIdCurrent)
      else localStorage.removeItem(scopedStorageKey('lazada_expected_member_id', botScope))
    } catch { }
  }, [botScope, shortlinkAccountCurrent, shortlinkBaseUrlCurrent, lazadaShortlinkBaseUrlCurrent, shortlinkExpectedUtmIdCurrent, lazadaExpectedMemberIdCurrent])

  useEffect(() => {
    if (systemWideGalleryMode) {
      writeCache(systemGalleryCacheKey(botScope), videos)
      return
    }
    if (!namespaceId) return
    writeCache(nsCacheKey('gallery', namespaceId), videos)
  }, [botScope, namespaceId, systemWideGalleryMode, videos])

  useEffect(() => {
    if (systemWideGalleryMode) {
      writeCache(systemUsedGalleryCacheKey(botScope), usedVideos)
      return
    }
    if (!namespaceId) return
    writeCache(nsCacheKey('used', namespaceId), usedVideos)
  }, [botScope, namespaceId, systemWideGalleryMode, usedVideos])

  useEffect(() => {
    if (!namespaceId) return
    writeCache(nsCacheKey('history', namespaceId), postHistory)
  }, [namespaceId, postHistory])

  useEffect(() => {
    if (!namespaceId) return
    writeCache(nsInboxCacheKey(namespaceId), inboxVideos)
  }, [namespaceId, inboxVideos])

  useEffect(() => {
    if (!namespaceId) return
    if (!dashboardData?.date) return
    writeCache(dashboardCacheKey(namespaceId, dashboardData.date), dashboardData)
  }, [namespaceId, dashboardData])

  useEffect(() => {
    if (!namespaceId) return
    writeCache(processingCacheKey(namespaceId), processingVideos)
  }, [namespaceId, processingVideos])

  useEffect(() => {
    writeCache(systemInboxCacheKey(botScope), systemInboxVideos)
  }, [botScope, systemInboxVideos])

  useEffect(() => {
    if (tg) {
      try {
        tg.ready()
      } catch (e) {
        console.log('Telegram ready error:', e)
      }
      try {
        tg.expand()
      } catch (e) {
        console.log('Telegram expand error:', e)
      }
      try {
        tg.disableVerticalSwipes()
      } catch (e) {
        console.log('Telegram vertical swipe lock error:', e)
      }
      try {
        tg.requestFullscreen()
      } catch (e) {
        console.log('Telegram fullscreen error:', e)
      }
      try {
        tg.setHeaderColor('#ffffff')
        tg.setBackgroundColor('#ffffff')
        tg.setBottomBarColor('#ffffff')
      } catch (e) {
        console.log('Telegram theme setup error:', e)
      }
    }
  }, [tg])

  useEffect(() => {
    let lastTouchY = 0

    const getScrollContainer = (target: EventTarget | null): HTMLElement | null => {
      let current = target instanceof HTMLElement ? target : null
      while (current) {
        if (current.matches('.app-scroll, [data-allow-touch-scroll="true"]')) {
          return current
        }
        current = current.parentElement
      }
      return null
    }

    const allowsNativeHorizontalGesture = (target: EventTarget | null) => {
      let current = target instanceof HTMLElement ? target : null
      while (current) {
        if (
          current.matches('input[type="range"], [data-allow-native-drag="true"]')
          || current.closest('input[type="range"], [data-allow-native-drag="true"]')
        ) {
          return true
        }
        current = current.parentElement
      }
      return false
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        lastTouchY = e.touches[0].clientY
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      if (allowsNativeHorizontalGesture(e.target)) return

      const currentY = e.touches[0].clientY
      const deltaY = currentY - lastTouchY
      lastTouchY = currentY

      const scrollContainer = getScrollContainer(e.target)
      if (!scrollContainer) {
        e.preventDefault()
        return
      }

      const canScroll = scrollContainer.scrollHeight > scrollContainer.clientHeight + 1
      if (!canScroll) {
        e.preventDefault()
        return
      }

      const atTop = scrollContainer.scrollTop <= 0
      const atBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 1

      if ((atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
        e.preventDefault()
      }
    }

    document.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true })
    document.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true })

    return () => {
      document.removeEventListener('touchstart', handleTouchStart, true)
      document.removeEventListener('touchmove', handleTouchMove, true)
    }
  }, [])

  const filteredLogHistory = useMemo(() => {
    return postHistory.filter((item) => {
      const itemDate = new Date(item.posted_at)
      const thaiItemDate = new Date(itemDate.getTime() + 7 * 60 * 60 * 1000)
      const itemDateStr = thaiItemDate.toISOString().split('T')[0]
      return itemDateStr === logDateFilter
    })
  }, [logDateFilter, postHistory])

  useEffect(() => {
    if (tab !== 'logs') {
      setVisibleLogCount(filteredLogHistory.length)
      return
    }

    if (loading && postHistory.length === 0) {
      setVisibleLogCount(0)
      return
    }

    const total = filteredLogHistory.length
    if (total === 0) {
      setVisibleLogCount(0)
      return
    }

    const initialCount = Math.min(LOGS_REVEAL_BATCH_SIZE, total)
    setVisibleLogCount(initialCount)
    if (initialCount >= total) return

    const timer = window.setInterval(() => {
      setVisibleLogCount((current) => {
        if (current >= total) {
          window.clearInterval(timer)
          return current
        }
        const next = Math.min(current + LOGS_REVEAL_BATCH_SIZE, total)
        if (next >= total) window.clearInterval(timer)
        return next
      })
    }, LOGS_REVEAL_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [filteredLogHistory.length, loading, postHistory.length, tab])

  useEffect(() => {
    if (tab !== 'logs') return
    setLogNowMs(Date.now())
    const timer = window.setInterval(() => {
      setLogNowMs(Date.now())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [tab])

  useEffect(() => {
    setTokenState(getToken(botScope))
    const storedNamespace = getStoredNamespace(botScope)
    const cachedVideos = readGalleryCacheForScope(botScope, storedNamespace, FORCE_SYSTEM_WIDE_GALLERY)
    const cachedInbox = storedNamespace ? readCache<InboxVideo[]>(nsInboxCacheKey(storedNamespace), []) : []
    const cachedDashboard = storedNamespace ? readCache<DashboardData | null>(dashboardCacheKey(storedNamespace, getTodayString()), null) : null
    const cachedProcessing = storedNamespace ? readCache<Video[]>(processingCacheKey(storedNamespace), []) : []
    const cachedSystemInbox = readCache<InboxVideo[]>(systemInboxCacheKey(botScope), [])
    const cachedUsedVideos = readUsedGalleryCacheForScope(botScope, storedNamespace, FORCE_SYSTEM_WIDE_GALLERY)
    const storedShortlinkAccount = getStoredShortlinkAccount(botScope)
    const storedShortlinkBaseUrl = getStoredShortlinkBaseUrl(botScope)
    const storedLazadaShortlinkBaseUrl = getStoredLazadaShortlinkBaseUrl(botScope)
    setNamespaceId(storedNamespace)
    setVideos(cachedVideos)
    setUsedVideos(cachedUsedVideos)
    setInboxVideos(cachedInbox)
    setSystemInboxVideos(cachedSystemInbox)
    setDashboardData(cachedDashboard)
    setProcessingVideos(cachedProcessing)
    setProcessingLoading(cachedProcessing.length === 0)
    setGalleryLoading(cachedVideos.length === 0)
    setGalleryReadyTotalCount(cachedVideos.length)
    setGalleryUsedTotalCount(cachedUsedVideos.length)
    const storedShortlinkExpectedUtmId = getStoredShortlinkExpectedUtmId(botScope)
    const storedLazadaExpectedMemberId = getStoredLazadaExpectedMemberId(botScope)
    setShortlinkAccountCurrent(storedShortlinkAccount)
    setShortlinkAccountDraft(storedShortlinkAccount)
    setShortlinkBaseUrlCurrent(storedShortlinkBaseUrl)
    setLazadaShortlinkBaseUrlCurrent(storedLazadaShortlinkBaseUrl)
    setShortlinkExpectedUtmIdCurrent(storedShortlinkExpectedUtmId)
    setShortlinkExpectedUtmIdDraft(storedShortlinkExpectedUtmId)
    setLazadaExpectedMemberIdCurrent(storedLazadaExpectedMemberId)
    setLazadaExpectedMemberIdDraft(storedLazadaExpectedMemberId)
    setShortlinkEnabled(!!String(storedShortlinkAccount || storedShortlinkBaseUrl || storedLazadaShortlinkBaseUrl || '').trim())
    setInboxLoading(cachedInbox.length === 0)
    setProcessingVideos([])
    setPendingShortlinkVideos([])
    setGallerySummary({ libraryTotal: 0, inventoryTotal: 0, readyTotal: 0 })
    setProcessingSummary({
      libraryTotal: 0,
      inventoryTotal: 0,
      readyTotal: 0,
      pendingTotal: 0,
      pendingHasLazadaTotal: 0,
      pendingMissingLazadaTotal: 0,
    })
    setMeEmail('')
    setMeDisplayName('')
    setMePictureUrl('')
    setIsOwner(false)
    setIsSystemAdmin(false)
    setIsTeamMember(false)
    setTeamMembers([])
    setSystemMembers([])
    setCommentTemplate(DEFAULT_COMMENT_TEMPLATE)
    setCommentTemplateDraft(DEFAULT_COMMENT_TEMPLATE)
    setCommentTemplateSource('default')
    setCommentTemplateUpdatedAt('')
    setCommentTemplateMessage('')
    setCommentTemplateLoading(false)
    setCommentTemplateSaving(false)
    setCommentTemplateMaxChars(4000)
    setAuthBootstrapping(true)
  }, [botScope])

  useEffect(() => {
    let cancelled = false

    const bootstrapAuth = async () => {
      const appHost = typeof window !== 'undefined' && isAppHost(window.location.hostname)
      const mainLiffUrl = typeof window !== 'undefined' ? getMainLiffUrlForHost(window.location.hostname) : ''
      const liffInitOptions = typeof window !== 'undefined' ? getMainLiffInitOptionsForHost(window.location.hostname) : null

      // LIFF auto-login FIRST (LINE MINI App) — must run before anything else
      const liff = await waitForLiffSdk(5000)
      if (typeof window !== 'undefined' && liff && liffInitOptions) {
        try {
          await liff.init(liffInitOptions)
          if (!controlledTab) {
            syncNavigationStateFromLocation()
          }

          // Try multiple ways to get LINE userId
          let lineUserId = ''
          let displayName = ''
          let pictureUrl = ''
          let idToken = ''

          // Method 1: getProfile (requires login)
          if (liff.isLoggedIn()) {
            try {
              const profile = await liff.getProfile()
              lineUserId = profile.userId || ''
              displayName = profile.displayName || ''
              pictureUrl = profile.pictureUrl || ''
              idToken = liff.getIDToken() || ''
            } catch { }
          }

          // Method 2: getContext (works in-client without login)
          if (!lineUserId) {
            try {
              const ctx = liff.getContext()
              lineUserId = ctx?.userId || ''
            } catch { }
          }

          // Method 3: getDecodedIDToken
          if (!lineUserId) {
            try {
              const decoded = liff.getDecodedIDToken()
              lineUserId = decoded?.sub || ''
              displayName = decoded?.name || ''
              pictureUrl = decoded?.picture || ''
            } catch { }
          }

          // If still no userId and in client, try login with redirect back
          if (!lineUserId && liff.isInClient() && !liff.isLoggedIn()) {
            liff.login({ redirectUri: window.location.href })
            return
          }

          if (lineUserId) {
            const liffResp = await fetch(`${WORKER_URL}/api/line/liff-login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                line_user_id: lineUserId,
                display_name: displayName,
                picture_url: pictureUrl,
                id_token: idToken,
                invite_namespace: getInviteNamespaceFromSearch(window.location.search),
              }),
            })

            if (liffResp.ok) {
              const liffData = await liffResp.json().catch(() => ({})) as any

              // Handle pending approval status
              if (liffData?.status === 'pending') {
                setPendingApproval(true)
                if (liffData?.line_display_name) setMeDisplayName(String(liffData.line_display_name))
                if (liffData?.line_picture_url) setMePictureUrl(String(liffData.line_picture_url))
                if (!cancelled) setAuthBootstrapping(false)
                return
              }

              const liffSession = normalizeSessionToken(liffData?.session_token)
              if (liffSession) {
                localStorage.setItem(scopedStorageKey('auth_token', botScope), liffSession)
                setTokenState(liffSession)

                const ns = String(liffData?.namespace_id || '').trim()
                setIsOwner(!!liffData?.is_owner)
                setIsSystemAdmin(!!liffData?.is_system_admin)
                setIsTeamMember(!!liffData?.is_team_member)
                if (liffData?.email) setMeEmail(String(liffData.email))
                if (liffData?.line_display_name) setMeDisplayName(String(liffData.line_display_name))
                if (liffData?.line_picture_url) setMePictureUrl(String(liffData.line_picture_url))
                if (liffData?.line_user_id) setMeLineUserId(String(liffData.line_user_id))
                if (ns) {
                  setNamespaceId(ns)
                  hydrateNamespaceCaches(ns, false)
                }
                if (!cancelled) setAuthBootstrapping(false)
                return
              }
            }
          }
        } catch (e) {
          console.error('LIFF init error:', e)
        }
      }

      if (appHost && typeof window !== 'undefined' && mainLiffUrl) {
        try {
          const redirectGuardKey = scopedStorageKey('liff_bootstrap_redirecting', botScope)
          const lastRedirectAt = Number(sessionStorage.getItem(redirectGuardKey) || '0')
          if (Date.now() - lastRedirectAt > 10_000) {
            sessionStorage.setItem(redirectGuardKey, String(Date.now()))
            window.location.replace(mainLiffUrl)
            return
          }
        } catch {}
      }

      const tgId = tg?.initDataUnsafe?.user?.id
      const session = getToken(botScope)
      if (session) {
        try {
          const reboundSession = await bindTelegramSession(session, tgId, botScope)
          const meResp = await fetch(`${WORKER_URL}/api/me`, { headers: { 'x-auth-token': reboundSession } })
          if (meResp.ok) {
            const me = await meResp.json().catch(() => ({})) as any
            const ns = String(me?.namespace_id || '').trim()
            setIsOwner(!!me?.is_owner)
            setIsSystemAdmin(!!me?.is_system_admin)
            setIsTeamMember(!!me?.is_team_member)
            if (me?.email) setMeEmail(String(me.email))
            if (me?.line_display_name) setMeDisplayName(String(me.line_display_name))
            if (me?.line_picture_url) setMePictureUrl(String(me.line_picture_url))
            if (me?.line_user_id) setMeLineUserId(String(me.line_user_id))
            if (ns) {
              setNamespaceId(ns)
              hydrateNamespaceCaches(ns, false)
            }
            if (!cancelled) setAuthBootstrapping(false)
            return
          }
        } catch { }
      }

      if (tgId) {
        try {
          const autoResp = await fetch(`${WORKER_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tg_id: tgId,
              bot_id: botScope || undefined,
            }),
          })
          if (autoResp.ok) {
            const autoData = await autoResp.json().catch(() => ({})) as any
            const autoSession = normalizeSessionToken(autoData?.session_token)
            if (autoSession) {
              localStorage.setItem(scopedStorageKey('auth_token', botScope), autoSession)
              setTokenState(autoSession)

              const meResp = await fetch(`${WORKER_URL}/api/me`, { headers: { 'x-auth-token': autoSession } })
              if (meResp.ok) {
                const me = await meResp.json().catch(() => ({})) as any
                const ns = String(me?.namespace_id || '').trim()
                setIsOwner(!!me?.is_owner)
                setIsSystemAdmin(!!me?.is_system_admin)
                if (me?.email) setMeEmail(String(me.email))
                if (me?.line_display_name) setMeDisplayName(String(me.line_display_name))
                if (me?.line_picture_url) setMePictureUrl(String(me.line_picture_url))
                if (ns) {
                  setNamespaceId(ns)
                  hydrateNamespaceCaches(ns, false)
                }
                if (!cancelled) setAuthBootstrapping(false)
                return
              }
            }
          }
        } catch { }
      }

      clearSession()
      if (!cancelled) setAuthBootstrapping(false)
    }

    bootstrapAuth()
    return () => { cancelled = true }
  }, [botScope])

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab !== 'settings') return
    if (settingsSection === 'pages') {
      void loadPages()
      return
    }
    if (settingsSection === 'team' || settingsSection === 'menu') {
      void loadTeam()
      return
    }
    if (settingsSection === 'shortlink') {
      void loadShortlinkSettings()
      return
    }
    if (settingsSection === 'post' && isOwner) {
      void loadPostingOrderSettings()
      return
    }
    if (settingsSection === 'voice') {
      void loadVoicePrompt()
      return
    }
    if (settingsSection === 'cover') {
      void loadCoverTextStyle()
      return
    }
    if (settingsSection === 'comment') {
      void loadCommentTemplate()
      return
    }
    if (settingsSection === 'gemini' && isSystemAdmin) {
      void loadGeminiApiKey()
      return
    }
    if (settingsSection === 'monitor' && isSystemAdmin) {
      void loadMonitor()
      return
    }
    if (settingsSection === 'members' && isSystemAdmin) {
      void loadSystemMembers()
    }
  }, [tab, settingsSection, token, authBootstrapping, isSystemAdmin, isOwner])

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab !== 'inbox') return

    const refreshInboxView = (mode: 'reset' | 'top' = 'top') => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (isSystemAdmin) {
        if (mode === 'reset' || systemInboxVideos.length === 0) {
          void loadSystemInbox({ reset: true })
          return
        }
        void loadSystemInbox({ refreshTop: true })
        return
      }
      if (mode === 'reset' || inboxVideos.length === 0) {
        void loadInboxSnapshot({ reset: true })
        return
      }
      void loadInboxSnapshot({ refreshTop: true })
    }

    refreshInboxView('reset')
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      refreshInboxView('reset')
    }
    const timer = window.setInterval(() => refreshInboxView('top'), 12000)
    const handleFocus = () => refreshInboxView('reset')
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [tab, token, authBootstrapping, isSystemAdmin, inboxVideos.length, systemInboxVideos.length])

  useEffect(() => {
    if (authBootstrapping || !token || !isSystemAdmin) return
    if (systemInboxVideos.length > 0 || systemInboxLoading || tab === 'inbox') return

    const timer = window.setTimeout(() => {
      void loadSystemInbox({ reset: true })
    }, 250)

    return () => window.clearTimeout(timer)
  }, [tab, token, authBootstrapping, isSystemAdmin, systemInboxVideos.length, systemInboxLoading])

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab !== 'processing') return

    const refresh = () => {
      void loadProcessingSnapshot()
    }

    refresh()
    const timer = window.setInterval(refresh, 15000)
    return () => window.clearInterval(timer)
  }, [tab, token, authBootstrapping])

  useEffect(() => {
    galleryReadyCountRef.current = videos.length
  }, [videos.length])

  useEffect(() => {
    galleryUsedCountRef.current = usedVideos.length
  }, [usedVideos.length])

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab !== 'gallery') return

    const hasCachedGallery = () => (
      categoryFilter === 'used'
        ? galleryUsedCountRef.current > 0
        : galleryReadyCountRef.current > 0
    )

    const refreshGalleryView = (mode: 'reset' | 'top' = 'top') => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (categoryFilter === 'all-original') {
        if (isOwner) void loadGlobalOriginalVideos({ force: true })
        return
      }
      if (mode === 'reset' || !hasCachedGallery()) {
        void loadGallerySnapshotBundle({ reset: true })
        return
      }
      void loadGallerySnapshotBundle({ refreshTop: true })
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      refreshGalleryView(hasCachedGallery() ? 'top' : 'reset')
    }
    const timer = window.setInterval(() => refreshGalleryView('top'), 12000)
    const handleFocus = () => refreshGalleryView(hasCachedGallery() ? 'top' : 'reset')
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [tab, token, authBootstrapping, categoryFilter, isOwner])

  useEffect(() => {
    if (tab !== 'settings' && settingsSection !== 'menu') {
      setSettingsSection('menu')
    }
  }, [tab, settingsSection])

  useEffect(() => {
    if (authBootstrapping) return
    if (!isOwner && settingsSection === 'shortlink') {
      setSettingsSection('menu')
    }
    if (!isOwner && settingsSection === 'post') {
      setSettingsSection('menu')
    }
    if (!isSystemAdmin && settingsSection === 'gemini') {
      setSettingsSection('menu')
    }
    if (!isSystemAdmin && settingsSection === 'members') {
      setSettingsSection('menu')
    }
    if (!isSystemAdmin && settingsSection === 'monitor') {
      setSettingsSection('menu')
    }
  }, [authBootstrapping, isOwner, isSystemAdmin, settingsSection])

  useEffect(() => {
    const cachedVideos = readGalleryCacheForScope(botScope, namespaceId, systemWideGalleryMode)
    const cachedUsedVideos = readUsedGalleryCacheForScope(botScope, namespaceId, systemWideGalleryMode)
    setVideos(cachedVideos)
    setUsedVideos(cachedUsedVideos)
    const cachedProcessing = namespaceId
      ? readCache<Video[]>(processingCacheKey(namespaceId), [])
      : []
    setProcessingVideos(cachedProcessing)
    setProcessingLoading(cachedProcessing.length === 0)
    setGalleryReadyTotalCount(cachedVideos.length)
    setGalleryUsedTotalCount(cachedUsedVideos.length)
    setGalleryLoading(cachedVideos.length === 0)
    setSystemGalleryStats({ total: 0, withLink: 0, withoutLink: 0, shopeeTotal: 0, lazadaTotal: 0 })
    setGallerySummary({ libraryTotal: 0, inventoryTotal: 0, readyTotal: 0 })
    setSystemGalleryHasMore(false)
    setGalleryUsedHasMore(false)
    setGalleryLoadingMore(false)
    setSystemInboxHasMore(false)
    setSystemInboxLoadingMore(false)
    setInboxHasMore(false)
    setInboxLoadingMore(false)
  }, [botScope, namespaceId, systemWideGalleryMode])

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (dashboardData?.date === dashboardDateFilter) return
    void loadDashboard(dashboardDateFilter, { silent: !!dashboardData })
  }, [token, authBootstrapping, dashboardDateFilter, dashboardData?.date])

  useEffect(() => {
    if (authBootstrapping || !token || tab !== 'dashboard') return
    void loadDashboard(dashboardDateFilter)
    const timer = setInterval(() => {
      void loadDashboard(dashboardDateFilter, { silent: true })
    }, 30000)
    return () => clearInterval(timer)
  }, [tab, token, authBootstrapping, dashboardDateFilter])

  useEffect(() => {
    if (authBootstrapping || !token || tab !== 'logs') return
    void refreshPostHistorySnapshot()
  }, [tab, token, authBootstrapping, logDateFilter])

  useEffect(() => {
    if (!isOwner && categoryFilter === 'all-original') {
      setCategoryFilter('ready')
    }
  }, [isOwner, categoryFilter])

  useEffect(() => {
    if (isSystemAdmin) return
    if (categoryFilter === 'pending-shortlink') {
      setCategoryFilter('ready')
    }
  }, [isSystemAdmin, categoryFilter])

  useEffect(() => {
    if (!systemWideGalleryMode || !isSystemAdmin) {
      systemAdminGalleryDefaultAppliedRef.current = false
      return
    }
    if (systemAdminGalleryDefaultAppliedRef.current) return
    systemAdminGalleryDefaultAppliedRef.current = true
    setCategoryFilter('ready')
  }, [systemWideGalleryMode, isSystemAdmin])

  // Update LINE title bar based on current tab / settings submenu
  useEffect(() => {
    const titles: Record<string, string> = {
      dashboard: 'แดชบอร์ด',
      inbox: 'คลังต้นฉบับ',
      processing: 'ประมวลผล',
      gallery: 'Gallery',
      logs: 'ประวัติ',
      settings: 'ตั้งค่า',
    }
    const settingsTitle = settingsSection === 'shortlink'
      ? (isSystemAdmin ? 'Shortlink' : 'Affiliate ID')
      : getSettingsSectionTitle(settingsSection)
    document.title = tab === 'settings'
      ? settingsTitle
      : (titles[tab] || 'เฉียบ AI')
  }, [tab, settingsSection, isSystemAdmin])

  async function recoverSessionOrLogout() {
    clearSession()
    return false
  }

  async function loadProcessingSnapshot() {
    if (processingFetchInFlightRef.current) return
    const session = getToken()
    if (!session) return

    processingFetchInFlightRef.current = true
    const shouldShowLoading = processingVideos.length === 0
    if (shouldShowLoading) setProcessingLoading(true)
    try {
      const [processingResp, queueResp] = await Promise.all([
        apiFetch(`${WORKER_URL}/api/processing?summary=0`),
        apiFetch(`${WORKER_URL}/api/queue`)
      ])

      if (processingResp.status === 401 || queueResp.status === 401) {
        await recoverSessionOrLogout()
        return
      }

      const procData = processingResp.ok ? await processingResp.json() : { videos: [], pending_shortlink_videos: [] }
      const queueData = queueResp.ok ? await queueResp.json() : { queue: [] }
      const processingVideos = [...(procData.videos || []), ...(queueData.queue || [])]
      const pendingVideos = dedupeGalleryVideos(Array.isArray(procData.pending_shortlink_videos) ? procData.pending_shortlink_videos : [])
      setProcessingVideos(processingVideos)
      setPendingShortlinkVideos(pendingVideos)
      setProcessingSummary({
        libraryTotal: Number(procData.library_total || 0),
        inventoryTotal: Number(procData.inventory_total || 0),
        readyTotal: Number(procData.ready_total || 0),
        pendingTotal: Number(procData.pending_total || pendingVideos.length),
        pendingHasLazadaTotal: Number(procData.pending_has_lazada_total || 0),
        pendingMissingLazadaTotal: Number(procData.pending_missing_lazada_total || 0),
      })
    } catch {
      // Keep previous processing snapshot on transient errors.
    } finally {
      if (shouldShowLoading) setProcessingLoading(false)
      processingFetchInFlightRef.current = false
    }
  }

  async function loadInboxSnapshot(options: { reset?: boolean; refreshTop?: boolean } = {}) {
    const session = getToken()
    if (!session) return

    const reset = !!options.reset
    const refreshTop = !!options.refreshTop
    const requestId = reset || refreshTop ? ++inboxRequestRef.current : inboxRequestRef.current
    if (!reset && !refreshTop && (inboxLoadingMore || !inboxHasMore)) return
    if (refreshTop && inboxLoadingMore) return

    const offset = reset || refreshTop ? 0 : inboxVideos.length
    const shouldShowLoading = reset && inboxVideos.length === 0
    if (shouldShowLoading) setInboxLoading(true)
    if (!reset && !refreshTop) setInboxLoadingMore(true)

    try {
      const params = new URLSearchParams()
      params.set('offset', String(offset))
      params.set('limit', String(GALLERY_BATCH_SIZE))
      if (offset === 0) params.set('_ts', String(Date.now()))
      const resp = await apiFetch(`${WORKER_URL}/api/inbox?${params.toString()}`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (!resp.ok) return

      const data = await resp.json() as InboxPageResponse
      if (requestId !== inboxRequestRef.current) return

      const nextVideos = Array.isArray(data.videos) ? data.videos : []
      setInboxVideos((prev) => {
        const merged = reset ? nextVideos : mergeInboxVideos(prev, nextVideos)
        return merged
      })
      setInboxHasMore(!!data.has_more && nextVideos.length > 0)
    } catch {
      // Keep previous inbox snapshot on transient errors.
    } finally {
      if (requestId === inboxRequestRef.current) {
        if (shouldShowLoading) setInboxLoading(false)
        if (!reset && !refreshTop) setInboxLoadingMore(false)
      }
    }
  }

  async function loadSystemInbox(options: { reset?: boolean; refreshTop?: boolean } = {}) {
    if (!token || !isSystemAdmin) return

    const reset = !!options.reset
    const refreshTop = !!options.refreshTop
    const requestId = reset || refreshTop ? ++systemInboxRequestRef.current : systemInboxRequestRef.current
    if (!reset && !refreshTop && (systemInboxLoadingMore || !systemInboxHasMore)) return
    if (refreshTop && systemInboxLoadingMore) return

    const offset = reset || refreshTop ? 0 : systemInboxVideos.length
    const shouldShowLoading = reset && systemInboxVideos.length === 0
    if (shouldShowLoading) setSystemInboxLoading(true)
    if (!reset && !refreshTop) setSystemInboxLoadingMore(true)

    try {
      const params = new URLSearchParams()
      params.set('offset', String(offset))
      params.set('limit', String(GALLERY_BATCH_SIZE))
      if (offset === 0) {
        params.set('_ts', String(Date.now()))
      }
      const resp = await apiFetch(`${WORKER_URL}/api/inbox/system?${params.toString()}`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (!resp.ok) return

      const data = await resp.json() as InboxPageResponse
      if (requestId !== systemInboxRequestRef.current) return

      const nextVideos = Array.isArray(data.videos) ? data.videos : []
      setSystemInboxVideos((prev) => {
        const merged = reset ? nextVideos : mergeInboxVideos(prev, nextVideos)
        return merged
      })
      setSystemInboxHasMore(!!data.has_more && nextVideos.length > 0)
    } catch {
      // Keep previous inbox snapshot on transient errors.
    } finally {
      if (requestId === systemInboxRequestRef.current) {
        if (shouldShowLoading) setSystemInboxLoading(false)
        if (!reset && !refreshTop) setSystemInboxLoadingMore(false)
      }
    }
  }

  async function loadSystemMembers() {
    if (!token || !isSystemAdmin) return
    setSystemMembersLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/admin/members`)
      if (resp.ok) {
        const data = await resp.json() as { members?: SystemMember[] }
        setSystemMembers(Array.isArray(data.members) ? data.members : [])
      }
    } catch {}
    finally { setSystemMembersLoading(false) }
  }

  async function loadMonitor() {
    if (!token || !isSystemAdmin) return
    setMonitorLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/admin/monitor`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (!resp.ok) return
      const data = await resp.json() as MonitorResponse
      setMonitorData(data || null)
    } catch {
      // keep previous monitor snapshot
    } finally {
      setMonitorLoading(false)
    }
  }

  async function approveSystemMember(lineUserId: string) {
    setApprovingUserId(lineUserId)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/admin/approve-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_user_id: lineUserId }),
      })
      if (resp.ok) {
        await loadSystemMembers()
      }
    } catch {}
    finally { setApprovingUserId(null) }
  }

  async function rejectSystemMember(lineUserId: string) {
    setRejectingUserId(lineUserId)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/admin/reject-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_user_id: lineUserId }),
      })
      if (resp.ok) {
        await loadSystemMembers()
      }
    } catch {}
    finally { setRejectingUserId(null) }
  }

  async function saveSystemMemberRole(lineUserId: string, role: SystemMemberRole) {
    setSavingMemberRoleId(lineUserId)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/admin/members/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_user_id: lineUserId, role }),
      })
      if (resp.ok) {
        await loadSystemMembers()
      }
    } catch {}
    finally { setSavingMemberRoleId(null) }
  }

  async function loadGlobalOriginalVideos(options: { force?: boolean } = {}) {
    const session = getToken()
    if (!session || !isOwner) return

    const now = Date.now()
    if (!options.force && globalOriginalFetchInFlightRef.current) return
    if (!options.force && now - lastGlobalOriginalFetchAtRef.current < 45000) return

    const shouldShowLoading = options.force || globalOriginalVideos.length === 0
    if (shouldShowLoading) setGlobalOriginalLoading(true)

    globalOriginalFetchInFlightRef.current = true
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/admin/gallery/all-original`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setGlobalOriginalVideos([])
        lastGlobalOriginalFetchAtRef.current = Date.now()
        return
      }
      if (resp.ok) {
        const data = await resp.json() as { videos?: GlobalOriginalVideo[] }
        setGlobalOriginalVideos(Array.isArray(data.videos) ? data.videos : [])
        lastGlobalOriginalFetchAtRef.current = Date.now()
      }
    } catch {
      // Keep previous global originals on transient errors.
    } finally {
      globalOriginalFetchInFlightRef.current = false
      if (shouldShowLoading) setGlobalOriginalLoading(false)
    }
  }

  async function loadReadyGalleryPage(options: { reset?: boolean; refreshTop?: boolean; silent?: boolean } = {}) {
    const session = getToken()
    if (!session) return

    const reset = !!options.reset
    const refreshTop = !!options.refreshTop
    const requestId = reset || refreshTop ? ++systemGalleryRequestRef.current : systemGalleryRequestRef.current
    if (!reset && !refreshTop && (galleryLoadingMore || !systemGalleryHasMore)) return

    const offset = reset || refreshTop ? 0 : videos.length
    const shouldShowLoading = reset && !options.silent && videos.length === 0
    if (shouldShowLoading) setGalleryLoading(true)
    if (!reset && !refreshTop && !options.silent) setGalleryLoadingMore(true)

    try {
      const params = new URLSearchParams()
      params.set('offset', String(offset))
      params.set('limit', String(GALLERY_BATCH_SIZE))
      if (gallerySearchQuery) params.set('q', gallerySearchQuery)
      if (offset === 0) {
        params.set('fresh', '1')
        params.set('_ts', String(Date.now()))
      }

      const useAdminSystemRoute = useSystemWideAdminGallery && isSystemAdmin
      const requestParams = new URLSearchParams(params)
      const url = useAdminSystemRoute
        ? (() => {
            requestParams.set('view', 'ready')
            return `${WORKER_URL}/api/gallery/system?${requestParams.toString()}`
          })()
        : (() => {
            requestParams.set('link_filter', 'all')
            return `${WORKER_URL}/api/gallery?${requestParams.toString()}`
          })()

      const resp = await apiFetch(url)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403 && useAdminSystemRoute) {
        setVideos([])
        setGalleryReadyTotalCount(0)
        setSystemGalleryStats({ total: 0, withLink: 0, withoutLink: 0, shopeeTotal: 0, lazadaTotal: 0 })
        setGallerySummary({ libraryTotal: 0, inventoryTotal: 0, readyTotal: 0 })
        setSystemGalleryHasMore(false)
        return
      }
      if (!resp.ok) return

      const data = await resp.json() as GalleryPageResponse
      if (requestId !== systemGalleryRequestRef.current) return

      const nextVideos = filterDeletedGalleryVideos(
        Array.isArray(data.videos) ? data.videos : [],
        deletedGalleryKeysRef.current,
      )
      setVideos((prev) => (reset ? dedupeGalleryVideos(nextVideos) : mergeGalleryPageVideos(prev, nextVideos)))
      setGalleryReadyTotalCount(Number(data.ready_total || data.total || data.overall_total || 0))
      if (typeof data.used_total === 'number') {
        setGalleryUsedTotalCount(Number(data.used_total || 0))
      }
      setSystemGalleryStats({
        total: Number(data.total || data.overall_total || 0),
        shopeeTotal: Number(data.shopee_total || 0),
        lazadaTotal: Number(data.lazada_total || 0),
        withLink: Number(data.with_link_total || 0),
        withoutLink: Number(data.without_link_total || 0),
      })
      setGallerySummary({
        libraryTotal: Number(data.library_total || 0),
        inventoryTotal: Number(data.inventory_total || 0),
        readyTotal: Number(data.ready_total || data.total || data.overall_total || 0),
      })
      setSystemGalleryHasMore(!!data.has_more && nextVideos.length > 0)
    } catch {
      // Keep current gallery snapshot on transient errors.
    } finally {
      if (requestId === systemGalleryRequestRef.current) {
        if (shouldShowLoading) setGalleryLoading(false)
        if (!reset && !refreshTop && !options.silent) setGalleryLoadingMore(false)
      }
    }
  }

  async function loadUsedGalleryPage(options: { reset?: boolean; refreshTop?: boolean; silent?: boolean } = {}) {
    const session = getToken()
    if (!session) return

    const reset = !!options.reset
    const refreshTop = !!options.refreshTop
    const requestId = reset || refreshTop ? ++usedGalleryRequestRef.current : usedGalleryRequestRef.current
    if (!reset && !refreshTop && (galleryLoadingMore || !galleryUsedHasMore)) return

    const offset = reset || refreshTop ? 0 : usedVideos.length
    const shouldShowLoading = reset && !options.silent && usedVideos.length === 0
    if (shouldShowLoading) setGalleryLoading(true)
    if (!reset && !refreshTop && !options.silent) setGalleryLoadingMore(true)

    try {
      const params = new URLSearchParams()
      params.set('offset', String(offset))
      params.set('limit', String(GALLERY_BATCH_SIZE))
      if (gallerySearchQuery) params.set('q', gallerySearchQuery)
      if (offset === 0) {
        params.set('fresh', '1')
        params.set('_ts', String(Date.now()))
      }

      const useAdminSystemRoute = useSystemWideAdminGallery && isSystemAdmin
      const requestParams = new URLSearchParams(params)
      const url = useAdminSystemRoute
        ? (() => {
            requestParams.set('view', 'used')
            return `${WORKER_URL}/api/gallery/system?${requestParams.toString()}`
          })()
        : `${WORKER_URL}/api/gallery/used?${requestParams.toString()}`

      const resp = await apiFetch(url)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403 && useAdminSystemRoute) {
        setUsedVideos([])
        setGalleryUsedTotalCount(0)
        setGalleryUsedHasMore(false)
        return
      }
      if (!resp.ok) return

      const data = await resp.json() as GalleryPageResponse
      if (requestId !== usedGalleryRequestRef.current) return

      const nextVideos = filterDeletedGalleryVideos(
        Array.isArray(data.videos) ? data.videos : [],
        deletedGalleryKeysRef.current,
      )
      setUsedVideos((prev) => (reset ? dedupeGalleryVideos(nextVideos) : mergeGalleryPageVideos(prev, nextVideos)))
      setGalleryUsedTotalCount(Number(data.used_total || data.total || data.overall_total || 0))
      if (typeof data.ready_total === 'number') {
        setGalleryReadyTotalCount(Number(data.ready_total || 0))
      }
      setGalleryUsedHasMore(!!data.has_more && nextVideos.length > 0)
    } catch {
      // Keep current gallery snapshot on transient errors.
    } finally {
      if (requestId === usedGalleryRequestRef.current) {
        if (shouldShowLoading) setGalleryLoading(false)
        if (!reset && !refreshTop && !options.silent) setGalleryLoadingMore(false)
      }
    }
  }

  async function loadGallerySnapshotBundle(options: { reset?: boolean; refreshTop?: boolean } = {}) {
    const session = getToken()
    if (!session) return

    const reset = !!options.reset
    const refreshTop = !!options.refreshTop
    const visibleGalleryCount = categoryFilter === 'used' ? usedVideos.length : videos.length
    const shouldShowLoading = visibleGalleryCount === 0
    const shouldShowBootstrapPending = (reset || refreshTop) && shouldShowLoading
    if (shouldShowBootstrapPending) setGalleryBootstrapPending(true)
    if (reset && shouldShowLoading) setGalleryLoading(true)
    if (reset) setGalleryLoadingMore(false)

    try {
      await Promise.all([
        loadReadyGalleryPage({ reset, refreshTop, silent: categoryFilter === 'used' }),
        loadUsedGalleryPage({ reset, refreshTop, silent: categoryFilter !== 'used' }),
      ])
    } finally {
      if (reset && shouldShowLoading) setGalleryLoading(false)
      if (shouldShowBootstrapPending) setGalleryBootstrapPending(false)
    }
  }

  async function loadSystemGalleryPage(options: { reset?: boolean } = {}) {
    if (options.reset) {
      await loadGallerySnapshotBundle({ reset: true })
      return
    }

    if (categoryFilter === 'used') {
      await loadUsedGalleryPage()
      return
    }

    await loadReadyGalleryPage()
  }

  async function loadAll(options: { skipGallery?: boolean } = {}) {
    const session = getToken()
    if (!session) return
    try {
      const tasks: Promise<unknown>[] = []
      if (tab === 'logs') tasks.push(refreshPostHistorySnapshot())
      if (!options.skipGallery && tab === 'gallery') {
        if (categoryFilter === 'all-original' && isOwner) {
          tasks.push(loadGlobalOriginalVideos({ force: true }))
        } else {
          tasks.push(loadGallerySnapshotBundle({ reset: true }))
        }
      }
      if (tab === 'inbox') {
        tasks.push(isSystemAdmin ? loadSystemInbox({ reset: true }) : loadInboxSnapshot({ reset: true }))
      }
      if (tab === 'processing') tasks.push(loadProcessingSnapshot())
      await Promise.allSettled(tasks)
    } finally {
      setLoading(false)
    }
  }

  async function refreshPostHistorySnapshot(options: { force?: boolean } = {}) {
    const force = !!options.force
    const fetchKey = `${String(namespaceId || getStoredNamespace(botScope) || '').trim()}::${logDateFilter}`
    const now = Date.now()
    if (!force) {
      if (postHistoryFetchInFlightRef.current) return
      if (
        fetchKey === lastPostHistoryFetchKeyRef.current &&
        now - lastPostHistoryFetchAtRef.current < 1500
      ) {
        return
      }
    }

    postHistoryFetchInFlightRef.current = true
    const params = new URLSearchParams()
    params.set('date', logDateFilter)
    params.set('limit', '100')
    try {
      const historyResp = await apiFetch(`${WORKER_URL}/api/post-history?${params.toString()}`)
      if (historyResp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (historyResp.ok) {
        const data = await historyResp.json()
        setPostHistory(data.history || [])
        lastPostHistoryFetchKeyRef.current = fetchKey
        lastPostHistoryFetchAtRef.current = Date.now()
      }
    } finally {
      postHistoryFetchInFlightRef.current = false
    }
  }

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab !== 'gallery') return

    if (categoryFilter === 'all-original') {
      if (isOwner) void loadGlobalOriginalVideos({ force: true })
      return
    }

    // Always reset from page 1 when entering/re-entering gallery.
    // Using refreshTop with cached data can keep stale cards around after
    // clips are moved between ready/used or removed from gallery eligibility.
    void loadGallerySnapshotBundle({ reset: true })
    if (isOwner) void loadGlobalOriginalVideos()
  }, [tab, categoryFilter, token, authBootstrapping, isOwner, isSystemAdmin, systemWideGalleryMode, gallerySearchQuery])

  async function loadDashboard(dateValue = dashboardDateFilter, options: { silent?: boolean } = {}) {
    const session = getToken()
    if (!session) return
    const requestId = ++dashboardRequestRef.current
    const scopedNamespace = String(namespaceId || getStoredNamespace(botScope) || '').trim()
    if (scopedNamespace) {
      const cachedForDate = readCache<DashboardData | null>(dashboardCacheKey(scopedNamespace, dateValue), null)
      if (cachedForDate && requestId === dashboardRequestRef.current) {
        setDashboardData((prev) => (prev?.date === cachedForDate.date ? prev : cachedForDate))
      }
    }
    if (!options.silent && !dashboardData) setDashboardLoading(true)
    try {
      const cacheBust = options.silent ? '' : `&_ts=${Date.now()}`
      const resp = await apiFetch(`${WORKER_URL}/api/dashboard?date=${encodeURIComponent(dateValue)}${cacheBust}`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.ok) {
        const data = await resp.json() as DashboardData
        if (requestId === dashboardRequestRef.current) {
          setDashboardData(data)
        }
      }
    } catch (e) {
      console.error('Failed to load dashboard:', e)
    } finally {
      if (!options.silent && requestId === dashboardRequestRef.current) setDashboardLoading(false)
    }
  }

  async function loadPages() {
    const session = getToken()
    if (!session) return
    const requestId = ++loadPagesRequestRef.current
    const shouldShowSkeleton = pages.length === 0
    if (shouldShowSkeleton) setPagesLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/pages`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.ok) {
        const data = await resp.json()
        if (requestId === loadPagesRequestRef.current) {
          setPages(Array.isArray(data.pages) ? data.pages : [])
        }
      }
    } catch (e) {
      console.error('Failed to load pages:', e)
    } finally {
      if (requestId === loadPagesRequestRef.current) {
        setPagesLoading(false)
      }
    }
  }

  async function loadTeam() {
    const requestId = ++loadTeamRequestRef.current
    const session = getToken(botScope)
    if (!session) return
    try {
      const teamResp = await apiFetch(`${WORKER_URL}/api/team`)
      if (teamResp.status === 401) {
        if (requestId === loadTeamRequestRef.current) {
          setTeamMembers([])
        }
        await recoverSessionOrLogout()
        return
      }
      if (teamResp.ok) {
        const data = await teamResp.json() as any
        if (requestId === loadTeamRequestRef.current) {
          setTeamMembers(data.members || [])
        }
      } else if (requestId === loadTeamRequestRef.current) {
        setTeamMembers([])
      }
    } catch { }
  }

  async function loadVoicePrompt() {
    const session = getToken()
    if (!session) return
    setVoiceSettingsMessage('')
    setVoiceSettingsLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/voice-prompt`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setVoiceSettingsMessage('บัญชีนี้ไม่มีสิทธิ์แก้เสียงพากย์')
        return
      }
      if (!resp.ok) {
        setVoiceSettingsMessage('โหลดเสียงพากย์ไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        profile?: Partial<VoiceProfile>
        source?: VoiceSettingsSource
        updated_at?: string
        legacy_prompt_active?: boolean
        voice_options?: GeminiVoiceOption[]
        max_style_chars?: number
      }
      const nextProfile = normalizeVoiceProfile(data.profile)
      setVoiceProfile(nextProfile)
      setVoiceProfileDraft({ ...nextProfile, tones: [...nextProfile.tones] })
      setVoiceSettingsSource(data.source === 'structured' || data.source === 'legacy' ? data.source : 'default')
      setVoiceSettingsUpdatedAt(String(data.updated_at || ''))
      setLegacyVoicePromptActive(!!data.legacy_prompt_active || data.source === 'legacy')
      setVoiceOptions(Array.isArray(data.voice_options) ? data.voice_options : [])
      if (typeof data.max_style_chars === 'number' && data.max_style_chars > 0) setVoiceStylePromptMaxChars(data.max_style_chars)
      setVoiceSettingsMessage('')
    } catch {
      setVoiceSettingsMessage('โหลดเสียงพากย์ไม่สำเร็จ')
    } finally {
      setVoiceSettingsLoading(false)
    }
  }

  async function loadCoverTextStyle() {
    const session = getToken()
    if (!session) return
    setCoverTextStyleMessage('')
    setCoverTextStyleLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/cover-template`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setCoverTextStyleMessage('บัญชีนี้ไม่มีสิทธิ์แก้ข้อความบนปก')
        return
      }
      if (!resp.ok) {
        setCoverTextStyleMessage('โหลดการตั้งค่าข้อความบนปกไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        text_style?: Partial<CoverTextStyleSettings>
        updated_at?: string
        text_style_updated_at?: string
      }
      const nextStyle = normalizeCoverTextStyle(data.text_style)
      setCoverTextStyle(nextStyle)
      setCoverTextStyleDraft({ ...nextStyle })
      setCoverTextStyleUpdatedAt(String(data.text_style_updated_at || data.updated_at || ''))
      setCoverTextStyleMessage('')
    } catch {
      setCoverTextStyleMessage('โหลดการตั้งค่าข้อความบนปกไม่สำเร็จ')
    } finally {
      setCoverTextStyleLoading(false)
    }
  }

  async function saveCoverTextStyle(nextStyle: CoverTextStyleSettings) {
    const session = getToken()
    if (!session) return
    setCoverTextStyleSaving(true)
    setCoverTextStyleMessage('')
    try {
      const normalizedStyle = normalizeCoverTextStyle(nextStyle)
      const resp = await apiFetch(`${WORKER_URL}/api/settings/cover-template`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text_style: normalizedStyle }),
      })
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setCoverTextStyleMessage('บัญชีนี้ไม่มีสิทธิ์แก้ข้อความบนปก')
        return
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        setCoverTextStyleMessage(data.error || 'บันทึกการตั้งค่าข้อความบนปกไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        text_style?: Partial<CoverTextStyleSettings>
        updated_at?: string
        text_style_updated_at?: string
      }
      const savedStyle = normalizeCoverTextStyle(data.text_style)
      setCoverTextStyle(savedStyle)
      setCoverTextStyleDraft({ ...savedStyle })
      setCoverTextStyleUpdatedAt(String(data.text_style_updated_at || data.updated_at || new Date().toISOString()))
      setCoverTextStyleMessage('บันทึกการตั้งค่าข้อความบนปกแล้ว')
    } catch {
      setCoverTextStyleMessage('บันทึกการตั้งค่าข้อความบนปกไม่สำเร็จ')
    } finally {
      setCoverTextStyleSaving(false)
    }
  }

  async function loadCommentTemplate() {
    const session = getToken()
    if (!session) return
    setCommentTemplateMessage('')
    setCommentTemplateLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/comment-template`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setCommentTemplateMessage('บัญชีนี้ไม่มีสิทธิ์แก้เทมเพลตคอมเมนต์')
        return
      }
      if (!resp.ok) {
        setCommentTemplateMessage('โหลดเทมเพลตคอมเมนต์ไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        template?: string
        source?: 'default' | 'custom'
        updated_at?: string
        max_chars?: number
      }
      const template = String(data.template || DEFAULT_COMMENT_TEMPLATE)
      setCommentTemplate(template)
      setCommentTemplateDraft(template)
      setCommentTemplateSource(data.source === 'custom' ? 'custom' : 'default')
      setCommentTemplateUpdatedAt(String(data.updated_at || ''))
      setCommentTemplateMessage('')
      if (typeof data.max_chars === 'number' && data.max_chars > 0) setCommentTemplateMaxChars(data.max_chars)
    } catch {
      setCommentTemplateMessage('โหลดเทมเพลตคอมเมนต์ไม่สำเร็จ')
    } finally {
      setCommentTemplateLoading(false)
    }
  }

  async function saveCommentTemplate(nextTemplate: string) {
    const session = getToken()
    if (!session) return
    setCommentTemplateSaving(true)
    setCommentTemplateMessage('')
    try {
      const trimmed = String(nextTemplate || '').trim()
      const isReset = !trimmed
      const resp = await apiFetch(`${WORKER_URL}/api/settings/comment-template`, isReset ? {
        method: 'DELETE',
      } : {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: nextTemplate }),
      })
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setCommentTemplateMessage('บัญชีนี้ไม่มีสิทธิ์แก้เทมเพลตคอมเมนต์')
        return
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        setCommentTemplateMessage(data.error || 'บันทึกเทมเพลตคอมเมนต์ไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        template?: string
        source?: 'default' | 'custom'
        updated_at?: string
        max_chars?: number
      }
      const template = String(data.template || DEFAULT_COMMENT_TEMPLATE)
      setCommentTemplate(template)
      setCommentTemplateDraft(template)
      setCommentTemplateSource(data.source === 'custom' ? 'custom' : 'default')
      setCommentTemplateUpdatedAt(String(data.updated_at || ''))
      if (typeof data.max_chars === 'number' && data.max_chars > 0) setCommentTemplateMaxChars(data.max_chars)
      setCommentTemplateMessage(isReset ? 'รีเซ็ตเทมเพลตคอมเมนต์เป็นค่าเริ่มต้นแล้ว' : 'บันทึกเทมเพลตคอมเมนต์แล้ว')
    } catch {
      setCommentTemplateMessage('บันทึกเทมเพลตคอมเมนต์ไม่สำเร็จ')
    } finally {
      setCommentTemplateSaving(false)
    }
  }

  async function saveVoicePrompt(nextProfile?: VoiceProfile | null, options: { reset?: boolean } = {}) {
    const session = getToken()
    if (!session) return
    setVoiceSettingsSaving(true)
    setVoiceSettingsMessage('')
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/voice-prompt`, options.reset ? {
        method: 'DELETE',
      } : {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: nextProfile }),
      })
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setVoiceSettingsMessage('บัญชีนี้ไม่มีสิทธิ์แก้เสียงพากย์')
        return
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        setVoiceSettingsMessage(data.error || 'บันทึกเสียงพากย์ไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        profile?: Partial<VoiceProfile>
        source?: VoiceSettingsSource
        updated_at?: string
        legacy_prompt_active?: boolean
        voice_options?: GeminiVoiceOption[]
        max_style_chars?: number
      }
      const savedProfile = normalizeVoiceProfile(data.profile)
      setVoiceProfile(savedProfile)
      setVoiceProfileDraft({ ...savedProfile, tones: [...savedProfile.tones] })
      setVoiceSettingsSource(data.source === 'structured' || data.source === 'legacy' ? data.source : 'default')
      setVoiceSettingsUpdatedAt(String(data.updated_at || new Date().toISOString()))
      setLegacyVoicePromptActive(!!data.legacy_prompt_active || data.source === 'legacy')
      setVoiceOptions(Array.isArray(data.voice_options) ? data.voice_options : [])
      if (typeof data.max_style_chars === 'number' && data.max_style_chars > 0) setVoiceStylePromptMaxChars(data.max_style_chars)
      setVoiceSettingsMessage(options.reset ? 'รีเซ็ตเสียงพากย์เป็นค่าเริ่มต้นแล้ว' : 'บันทึกเสียงพากย์แล้ว (งานถัดไปจะใช้ทันที)')
    } catch {
      setVoiceSettingsMessage('บันทึกเสียงพากย์ไม่สำเร็จ')
    } finally {
      setVoiceSettingsSaving(false)
    }
  }

  async function previewVoiceProfile(profile: VoiceProfile) {
    const session = getToken()
    if (!session) return
    setVoicePreviewLoading(true)
    setVoicePreviewMessage('')
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/voice-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, text: DEFAULT_VOICE_PREVIEW_TEXT }),
      })
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        setVoicePreviewMessage(data.error || 'สร้างเสียงตัวอย่างไม่สำเร็จ')
        return
      }
      const blob = await resp.blob()
      const nextUrl = URL.createObjectURL(blob)
      if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl)
      setVoicePreviewUrl(nextUrl)
      setVoicePreviewMessage('สร้างเสียงตัวอย่างแล้ว')
      setTimeout(() => {
        const audio = document.getElementById('voice-preview-audio') as HTMLAudioElement | null
        void audio?.play().catch(() => {})
      }, 50)
    } catch {
      setVoicePreviewMessage('สร้างเสียงตัวอย่างไม่สำเร็จ')
    } finally {
      setVoicePreviewLoading(false)
    }
  }

  async function loadGeminiApiKey() {
    const session = getToken()
    if (!session) return
    setGeminiApiKeyMessage('')
    setGeminiApiKeyLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/gemini-key`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setGeminiApiKeyMessage('บัญชีนี้ไม่มีสิทธิ์แก้ Gemini API key')
        return
      }
      if (!resp.ok) {
        setGeminiApiKeyMessage('โหลด Gemini API key ไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        masked_key?: string
        masked_keys?: string[]
        source?: GeminiKeySource
        updated_at?: string
        max_chars?: number
        max_slots?: number
      }
      const maxSlots = typeof data.max_slots === 'number' && data.max_slots > 0
        ? Math.max(1, Math.min(5, data.max_slots))
        : DEFAULT_GEMINI_KEY_SLOTS
      const maskedKeys = Array.isArray(data.masked_keys)
        ? data.masked_keys.map((value) => String(value || ''))
        : [String(data.masked_key || '')]
      setGeminiApiKeyMaskedList([...maskedKeys.slice(0, maxSlots), ...createEmptyGeminiKeySlots(Math.max(0, maxSlots - maskedKeys.length))])
      setGeminiApiKeySource(data.source === 'system' || data.source === 'legacy' ? data.source : 'none')
      setGeminiApiKeyUpdatedAt(String(data.updated_at || ''))
      if (typeof data.max_chars === 'number' && data.max_chars > 0) setGeminiApiKeyMaxChars(data.max_chars)
      setGeminiApiKeyMaxSlots(maxSlots)
      setGeminiApiKeyDrafts(createEmptyGeminiKeySlots(maxSlots))
      setGeminiApiKeyMessage('')
    } catch {
      setGeminiApiKeyMessage('โหลด Gemini API key ไม่สำเร็จ')
    } finally {
      setGeminiApiKeyLoading(false)
    }
  }

  async function saveGeminiApiKeys(nextApiKeys: string[]) {
    const session = getToken()
    if (!session) return
    const trimmedKeys = nextApiKeys
      .map((value) => String(value || '').trim())
      .slice(0, geminiApiKeyMaxSlots)
    setGeminiApiKeySaving(true)
    setGeminiApiKeyMessage('')
    try {
      const isClear = trimmedKeys.every((value) => !value)
      const resp = await apiFetch(`${WORKER_URL}/api/settings/gemini-key`, isClear ? {
        method: 'DELETE',
      } : {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_keys: trimmedKeys, preserve_existing: true }),
      })

      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setGeminiApiKeyMessage('บัญชีนี้ไม่มีสิทธิ์แก้ Gemini API key')
        return
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        setGeminiApiKeyMessage(data.error || 'บันทึก Gemini API key ไม่สำเร็จ')
        return
      }

      const data = await resp.json() as {
        masked_key?: string
        masked_keys?: string[]
        source?: GeminiKeySource
        updated_at?: string
        max_chars?: number
        max_slots?: number
      }
      const maxSlots = typeof data.max_slots === 'number' && data.max_slots > 0
        ? Math.max(1, Math.min(5, data.max_slots))
        : DEFAULT_GEMINI_KEY_SLOTS
      const maskedKeys = Array.isArray(data.masked_keys)
        ? data.masked_keys.map((value) => String(value || ''))
        : [String(data.masked_key || '')]
      setGeminiApiKeyMaskedList([...maskedKeys.slice(0, maxSlots), ...createEmptyGeminiKeySlots(Math.max(0, maxSlots - maskedKeys.length))])
      setGeminiApiKeySource(data.source === 'system' || data.source === 'legacy' ? data.source : 'none')
      setGeminiApiKeyUpdatedAt(String(data.updated_at || ''))
      if (typeof data.max_chars === 'number' && data.max_chars > 0) setGeminiApiKeyMaxChars(data.max_chars)
      setGeminiApiKeyMaxSlots(maxSlots)
      setGeminiApiKeyDrafts(createEmptyGeminiKeySlots(maxSlots))
      setGeminiApiKeyMessage(isClear ? 'ล้าง Gemini API key กลางของระบบแล้ว' : 'บันทึก Gemini API key กลางของระบบแล้ว')
    } catch {
      setGeminiApiKeyMessage('บันทึก Gemini API key ไม่สำเร็จ')
    } finally {
      setGeminiApiKeySaving(false)
    }
  }

  async function loadShortlinkSettings() {
    const session = getToken()
    if (!session) return
    setShortlinkMessage('')
    setShortlinkLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/shopee-shortlink`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setShortlinkMessage('บัญชีนี้ไม่มีสิทธิ์แก้ Shortlink URL')
        return
      }
      if (!resp.ok) {
        setShortlinkMessage('โหลด Shortlink URL ไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        account?: string
        base_url?: string
        lazada_base_url?: string
        enabled?: boolean
        lazada_enabled?: boolean
        required?: boolean
        expected_utm_id?: string
        lazada_expected_member_id?: string
        updated_at?: string
        max_account_chars?: number
        max_chars?: number
        max_expected_utm_chars?: number
        max_lazada_member_id_chars?: number
      }
      const account = String(data.account || '')
      const baseUrl = String(data.base_url || '')
      const lazadaBaseUrl = String(data.lazada_base_url || '')
      const expectedUtmId = String(data.expected_utm_id || '')
      const lazadaExpectedMemberId = String(data.lazada_expected_member_id || '')
      setShortlinkAccountCurrent(account)
      setShortlinkAccountDraft(account)
      setShortlinkBaseUrlCurrent(baseUrl)
      setLazadaShortlinkBaseUrlCurrent(lazadaBaseUrl)
      setShortlinkExpectedUtmIdCurrent(expectedUtmId)
      setShortlinkExpectedUtmIdDraft(expectedUtmId)
      setLazadaExpectedMemberIdCurrent(lazadaExpectedMemberId)
      setLazadaExpectedMemberIdDraft(lazadaExpectedMemberId)
      setShortlinkEnabled((!!data.enabled && !!baseUrl) || (!!data.lazada_enabled && !!lazadaBaseUrl))
      setShortlinkUpdatedAt(String(data.updated_at || ''))
      if (typeof data.max_account_chars === 'number' && data.max_account_chars > 0) setShortlinkAccountMaxChars(data.max_account_chars)
      if (typeof data.max_expected_utm_chars === 'number' && data.max_expected_utm_chars > 0) setShortlinkExpectedUtmIdMaxChars(data.max_expected_utm_chars)
      if (typeof data.max_lazada_member_id_chars === 'number' && data.max_lazada_member_id_chars > 0) setLazadaExpectedMemberIdMaxChars(data.max_lazada_member_id_chars)
      setShortlinkMessage('')
    } catch {
      setShortlinkMessage('โหลด Shortlink URL ไม่สำเร็จ')
    } finally {
      setShortlinkLoading(false)
    }
  }

  async function saveShortlinkSettings(nextAccount: string) {
    const session = getToken()
    if (!session || !isOwner) return
    const trimmedAccount = String(nextAccount || '').trim().toUpperCase()
    const expectedTrimmed = String(shortlinkExpectedUtmIdDraft || '').trim()
    const lazadaExpectedMemberIdTrimmed = String(lazadaExpectedMemberIdDraft || '').trim()
    setShortlinkSaving(true)
    setShortlinkMessage('')
    try {
      const isClear = !trimmedAccount && !expectedTrimmed && !lazadaExpectedMemberIdTrimmed
      const resp = await apiFetch(`${WORKER_URL}/api/settings/shopee-shortlink`, isClear ? {
        method: 'DELETE',
      } : {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: trimmedAccount, expected_utm_id: expectedTrimmed, lazada_expected_member_id: lazadaExpectedMemberIdTrimmed }),
      })

      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setShortlinkMessage('บัญชีนี้ไม่มีสิทธิ์แก้ Shortlink URL')
        return
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        setShortlinkMessage(data.error || 'บันทึก Shortlink URL ไม่สำเร็จ')
        return
      }

      const data = await resp.json() as {
        account?: string
        base_url?: string
        lazada_base_url?: string
        enabled?: boolean
        lazada_enabled?: boolean
        required?: boolean
        expected_utm_id?: string
        lazada_expected_member_id?: string
        updated_at?: string
        max_account_chars?: number
        max_chars?: number
        max_expected_utm_chars?: number
        max_lazada_member_id_chars?: number
      }
      const account = String(data.account || '')
      const baseUrl = String(data.base_url || '')
      const lazadaBaseUrl = String(data.lazada_base_url || '')
      const expectedUtmId = String(data.expected_utm_id || '')
      const lazadaExpectedMemberId = String(data.lazada_expected_member_id || '')
      setShortlinkAccountCurrent(account)
      setShortlinkAccountDraft(account)
      setShortlinkBaseUrlCurrent(baseUrl)
      setLazadaShortlinkBaseUrlCurrent(lazadaBaseUrl)
      setShortlinkExpectedUtmIdCurrent(expectedUtmId)
      setShortlinkExpectedUtmIdDraft(expectedUtmId)
      setLazadaExpectedMemberIdCurrent(lazadaExpectedMemberId)
      setLazadaExpectedMemberIdDraft(lazadaExpectedMemberId)
      setShortlinkEnabled((!!data.enabled && !!baseUrl) || (!!data.lazada_enabled && !!lazadaBaseUrl))
      setShortlinkUpdatedAt(String(data.updated_at || ''))
      if (typeof data.max_account_chars === 'number' && data.max_account_chars > 0) setShortlinkAccountMaxChars(data.max_account_chars)
      if (typeof data.max_expected_utm_chars === 'number' && data.max_expected_utm_chars > 0) setShortlinkExpectedUtmIdMaxChars(data.max_expected_utm_chars)
      if (typeof data.max_lazada_member_id_chars === 'number' && data.max_lazada_member_id_chars > 0) setLazadaExpectedMemberIdMaxChars(data.max_lazada_member_id_chars)
      setShortlinkMessage(isClear ? 'ล้างค่า Shortlink แล้ว' : 'บันทึกค่า Shortlink แล้ว')
      setVideos([])
      setUsedVideos([])
      setGalleryLoading(true)
      void loadAll()
      void loadProcessingSnapshot()
    } catch {
      setShortlinkMessage('บันทึกค่า Shortlink ไม่สำเร็จ')
    } finally {
      setShortlinkSaving(false)
    }
  }

  async function loadPostingOrderSettings() {
    const session = getToken()
    if (!session) return
    setPostingOrderLoading(true)
    setPostingOrderMessage('')
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/posting-order`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setPostingOrderMessage('บัญชีนี้ไม่มีสิทธิ์แก้ลำดับการโพสต์')
        return
      }
      if (!resp.ok) {
        setPostingOrderMessage('โหลดการตั้งค่า Post ไม่สำเร็จ')
        return
      }
      const data = await resp.json().catch(() => ({})) as { posting_order?: PostingOrderOption; updated_at?: string }
      const nextOrder = String(data.posting_order || 'oldest_first').trim() as PostingOrderOption
      setPostingOrderCurrent(nextOrder)
      setPostingOrderDraft(nextOrder)
      setPostingOrderUpdatedAt(String(data.updated_at || ''))
    } catch {
      setPostingOrderMessage('โหลดการตั้งค่า Post ไม่สำเร็จ')
    } finally {
      setPostingOrderLoading(false)
    }
  }

  async function savePostingOrderSettings(nextOrder: PostingOrderOption) {
    const session = getToken()
    if (!session || !isOwner) return
    setPostingOrderSaving(true)
    setPostingOrderMessage('')
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/posting-order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posting_order: nextOrder }),
      })
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setPostingOrderMessage('บัญชีนี้ไม่มีสิทธิ์แก้ลำดับการโพสต์')
        return
      }
      const data = await resp.json().catch(() => ({})) as { posting_order?: PostingOrderOption; updated_at?: string; error?: string }
      if (!resp.ok) {
        setPostingOrderMessage(String(data.error || 'บันทึกการตั้งค่า Post ไม่สำเร็จ'))
        return
      }
      const savedOrder = String(data.posting_order || nextOrder).trim() as PostingOrderOption
      setPostingOrderCurrent(savedOrder)
      setPostingOrderDraft(savedOrder)
      setPostingOrderUpdatedAt(String(data.updated_at || ''))
      setPostingOrderMessage('บันทึกการตั้งค่า Post แล้ว')
    } catch {
      setPostingOrderMessage('บันทึกการตั้งค่า Post ไม่สำเร็จ')
    } finally {
      setPostingOrderSaving(false)
    }
  }

  function formatDuration(seconds: number) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const normalizeCommentStatus = (status?: string | null) => {
    const value = String(status || '').trim().toLowerCase()
    return ['success', 'failed', 'pending', 'skipped', 'not_attempted', 'not_configured'].includes(value)
      ? value
      : 'not_configured'
  }

  const formatCountdownClock = (seconds: number) => {
    const total = Math.max(0, Math.ceil(seconds))
    const minutes = Math.floor(total / 60)
    const remainingSeconds = total % 60
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`
  }

  type LogStatusTone = 'success' | 'pending' | 'failed' | 'idle'

  const getSimpleStatusMeta = (tone: LogStatusTone, kind: 'post' | 'comment', status?: string | null) => {
    if (tone === 'success') {
      return { label: 'ผ่าน', cls: 'bg-green-100 text-green-700', loading: false }
    }
    if (tone === 'pending') {
      return {
        label: kind === 'post' ? 'กำลังโพสต์' : 'กำลังคอมเมนต์',
        cls: 'bg-slate-100 text-slate-600',
        loading: true,
      }
    }
    if (tone === 'idle') {
      const normalizedStatus = normalizeCommentStatus(status)
      return {
        label: kind === 'comment'
          ? (normalizedStatus === 'not_attempted' ? 'รอคอมเมนต์' : 'รอ')
          : 'รอ',
        cls: 'bg-slate-100 text-slate-500',
        loading: false,
      }
    }
    return { label: 'ไม่ผ่าน', cls: 'bg-red-100 text-red-700', loading: false }
  }

  const getPostLogTone = (item: Pick<PostHistory, 'status' | 'fb_post_id' | 'fb_reel_url'>): LogStatusTone => {
    const status = item.status
    const value = String(status || '').trim().toLowerCase()
    if (String(item.fb_post_id || '').trim() || String(item.fb_reel_url || '').trim()) return 'success'
    if (value === 'success') return 'success'
    if (value === 'posting') return 'pending'
    return 'failed'
  }

  const getCommentLogTone = (status?: string | null): LogStatusTone => {
    const value = normalizeCommentStatus(status)
    if (value === 'success') return 'success'
    if (value === 'pending') return 'pending'
    if (value === 'skipped' || value === 'not_attempted' || value === 'not_configured') return 'idle'
    return 'failed'
  }

  const getCommentCountdownSeconds = (
    item: Pick<PostHistory, 'comment_status' | 'comment_due_at' | 'fb_post_id' | 'fb_reel_url'>,
    nowMs: number
  ) => {
    if (normalizeCommentStatus(item.comment_status) !== 'not_attempted') return null
    if (!String(item.fb_post_id || '').trim() && !String(item.fb_reel_url || '').trim()) return null
    const dueAtRaw = String(item.comment_due_at || '').trim()
    if (!dueAtRaw) return null
    const dueAtMs = Date.parse(dueAtRaw)
    if (!Number.isFinite(dueAtMs)) return null
    const remainingSeconds = Math.ceil((dueAtMs - nowMs) / 1000)
    return remainingSeconds > 0 ? remainingSeconds : null
  }

  const hasPageTokenIssue = (page: FacebookPage) => {
    const latest = postHistory.find((item) => item.page_id === page.id)
    if (!latest) return false
    // Only show orange when the latest post actually failed
    return latest.status === 'failed'
  }

  const handleSavePage = (updatedPage: FacebookPage) => {
    setPages((prev) => prev.map((p) => p.id === updatedPage.id ? updatedPage : p))
  }

  const handleDeletePage = async (pageId: string) => {
    setDeletingPageId(pageId)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/pages/${encodeURIComponent(pageId)}`, { method: 'DELETE' })
      if (resp.ok) {
        setPages((prev) => prev.filter((p) => p.id !== pageId))
      }
    } catch (e) {
      console.error('Delete failed:', e)
    } finally {
      setDeletingPageId(null)
      setDeletePageId(null)
    }
  }

  const handleCancelJob = async (id: string, isQueued: boolean) => {
    try {
      const endpoint = isQueued ? 'queue' : 'processing'
      await apiFetch(`${WORKER_URL}/api/${endpoint}/${id}`, { method: 'DELETE' })
      setProcessingVideos(prev => prev.filter(v => v.id !== id))
    } catch { }
  }

  const handleReprocessJob = async (id: string) => {
    setRetryingProcessingId(id)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/processing/${encodeURIComponent(id)}/reprocess`, {
        method: 'POST',
      })
      const data = await resp.json().catch(() => ({})) as { error?: string }
      if (!resp.ok) {
        throw new Error(String(data.error || 'ประมวลผลใหม่ไม่สำเร็จ'))
      }
      await loadProcessingSnapshot()
    } catch (error) {
      alert(error instanceof Error ? error.message : 'ประมวลผลใหม่ไม่สำเร็จ')
    } finally {
      setRetryingProcessingId(null)
    }
  }

  const handleStartInboxVideo = async (id: string, videoNamespaceId?: string) => {
    const inboxIdentityKey = getInboxVideoIdentityKey(id, videoNamespaceId)
    setStartingInboxId(inboxIdentityKey)
    try {
      const nsParam = videoNamespaceId && videoNamespaceId !== namespaceId ? `?namespace_id=${encodeURIComponent(videoNamespaceId)}` : ''
      const resp = await apiFetch(`${WORKER_URL}/api/inbox/${encodeURIComponent(id)}/process${nsParam}`, {
        method: 'POST',
      })
      const data = await resp.json().catch(() => ({})) as { error?: string; message?: string; details?: string[]; job?: { status?: string } }
      if (!resp.ok) {
        if (data.error === 'shortlink_failed') {
          throw new Error(`${data.message || 'ย่อลิ้งไม่ผ่าน'}\n${(data.details || []).join('\n')}`)
        }
        throw new Error(String(data.error || 'ส่งเข้า Processing ไม่สำเร็จ'))
      }
      await Promise.all([
        isSystemAdmin ? loadSystemInbox({ reset: true }) : loadInboxSnapshot({ reset: true }),
        loadProcessingSnapshot(),
      ])
      const status = String(data.job?.status || '').trim().toLowerCase()
      if (status === 'processed') {
        alert('คลิปนี้อยู่ใน Gallery แล้ว โดยคลิปต้นฉบับยังอยู่ในคลังต้นฉบับตามเดิม')
      } else if (status === 'queued') {
        alert('ส่งเข้า Processing แล้ว คลิปต้นฉบับยังอยู่ในคลังต้นฉบับตามเดิม')
      } else {
        alert('เริ่มประมวลผลแล้ว คลิปต้นฉบับยังอยู่ในคลังต้นฉบับตามเดิม')
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setStartingInboxId(null)
    }
  }

  const handleDeleteInboxVideo = async (id: string, namespaceId?: string) => {
    const ok = window.confirm('ยืนยันลบวิดีโอนี้ออกจากคลังต้นฉบับ?')
    if (!ok) return
    const inboxIdentityKey = getInboxVideoIdentityKey(id, namespaceId)
    setDeletingInboxId(inboxIdentityKey)
    try {
      const url = new URL(`${WORKER_URL}/api/inbox/${encodeURIComponent(id)}`)
      if (namespaceId) url.searchParams.set('namespace_id', namespaceId)
      const resp = await apiFetch(url.toString(), {
        method: 'DELETE',
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        throw new Error(String(data.error || 'ลบจาก Inbox ไม่สำเร็จ'))
      }
      setInboxVideos((prev) => prev.filter((video) => {
        const sameId = String(video.id || '').trim() === String(id || '').trim()
        const sameNamespace = !namespaceId || String(video.namespace_id || '').trim() === String(namespaceId || '').trim()
        return !(sameId && sameNamespace)
      }))
      setSystemInboxVideos((prev) => prev.filter((video) => {
        const sameId = String(video.id || '').trim() === String(id || '').trim()
        const sameNamespace = !namespaceId || String(video.namespace_id || '').trim() === String(namespaceId || '').trim()
        return !(sameId && sameNamespace)
      }))
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingInboxId(null)
    }
  }

  const updateGalleryVideoState = (id: string, targetNamespaceId: string | undefined, fields: Partial<Video>) => {
    const previousVideo = videos.find((video) =>
      matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
    )
    const previousPendingVideo = pendingShortlinkVideos.find((video) =>
      matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
    )
    const previousUsedVideo = usedVideos.find((video) =>
      matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
    )
    const previousAnyVideo = previousVideo || previousPendingVideo || previousUsedVideo
    const nextCandidate = previousAnyVideo
      ? { ...previousAnyVideo, ...fields } as Video
      : null
    const nextCandidateExpectedUtmId = String((nextCandidate as unknown as Record<string, unknown> | null)?.shortlink_expected_utm_id || shortlinkExpectedUtmIdCurrent || '').trim()
    const nextCandidateExpectedLazadaMemberId = String((nextCandidate as unknown as Record<string, unknown> | null)?.lazada_expected_member_id || lazadaExpectedMemberIdCurrent || '').trim()
  const nextIsPosted = !!String((nextCandidate as unknown as Record<string, unknown> | null)?.postedAt || '').trim()
  const nextIsAwaitingConversion = nextCandidate
      ? isVideoAwaitingAffiliateConversion(
        nextCandidate as unknown as Record<string, unknown>,
        nextCandidateExpectedUtmId,
        nextCandidateExpectedLazadaMemberId,
      )
      : false
    const previousWasReady = !!previousVideo
    const previousWasUsed = !!previousUsedVideo
    const nextWillBeReady = !!nextCandidate && !nextIsPosted && !nextIsAwaitingConversion
    const nextWillBeUsed = !!nextCandidate && nextIsPosted

    setVideos((prev) => {
      const hasExistingVideo = prev.some((video) =>
        matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
      )
      const nextReadyVideos = prev.flatMap((video) => {
        if (!matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)) {
          return [video]
        }

        if (nextIsPosted || nextIsAwaitingConversion) return []
        return [{ ...video, ...fields }]
      })

      if (!hasExistingVideo && nextCandidate && !nextIsPosted && !nextIsAwaitingConversion) {
        return dedupeGalleryVideos([nextCandidate, ...nextReadyVideos])
      }

      return dedupeGalleryVideos(nextReadyVideos)
    })

    setPendingShortlinkVideos((prev) => {
      const updated = prev.flatMap((video) => {
        if (!matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)) {
          return [video]
        }

        const nextVideo = { ...video, ...fields }
        const nextVideoExpectedUtmId = String((nextVideo as unknown as Record<string, unknown>).shortlink_expected_utm_id || shortlinkExpectedUtmIdCurrent || '').trim()
        const nextVideoExpectedLazadaMemberId = String((nextVideo as unknown as Record<string, unknown>).lazada_expected_member_id || lazadaExpectedMemberIdCurrent || '').trim()
        return isVideoAwaitingAffiliateConversion(
          nextVideo as unknown as Record<string, unknown>,
          nextVideoExpectedUtmId,
          nextVideoExpectedLazadaMemberId,
        ) && !nextIsPosted ? [nextVideo] : []
      })

      if (!nextCandidate) return updated
      const alreadyTracked = updated.some((video) =>
        matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
      )
      if (alreadyTracked) return updated

      return nextIsAwaitingConversion && !nextIsPosted ? dedupeGalleryVideos([nextCandidate, ...updated]) : updated
    })

    setUsedVideos((prev) => {
      const hasExistingUsedVideo = prev.some((video) =>
        matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
      )
      const nextUsedVideos = prev.flatMap((video) => {
        if (!matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)) {
          return [video]
        }

        if (!nextIsPosted) return []
        return [{ ...video, ...fields }]
      })

      if (!hasExistingUsedVideo && nextCandidate && nextIsPosted) {
        return dedupeGalleryVideos([nextCandidate, ...nextUsedVideos])
      }

      return dedupeGalleryVideos(nextUsedVideos)
    })

    if (previousWasReady !== nextWillBeReady) {
      setGalleryReadyTotalCount((prev) => Math.max(0, prev + (nextWillBeReady ? 1 : -1)))
    }
    if (previousWasUsed !== nextWillBeUsed) {
      setGalleryUsedTotalCount((prev) => Math.max(0, prev + (nextWillBeUsed ? 1 : -1)))
    }

    if (!systemWideGalleryMode || !previousVideo) return

    const previousHasLink = hasVideoAffiliateLink(previousVideo as unknown as Record<string, unknown>)
    const nextHasLink = hasVideoAffiliateLink({ ...previousVideo, ...fields } as unknown as Record<string, unknown>)
    if (previousHasLink !== nextHasLink) {
      setSystemGalleryStats((prev) => ({
        ...prev,
        withLink: Math.max(0, prev.withLink + (nextHasLink ? 1 : -1)),
        withoutLink: Math.max(0, prev.withoutLink + (nextHasLink ? -1 : 1)),
      }))
    }

  }

  async function handleImportVideo(videoId: string, sourceNamespaceId: string) {
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/gallery/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: videoId, source_namespace_id: sourceNamespaceId }),
      })
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        alert(`นำเข้าไม่สำเร็จ: ${(err as { error?: string }).error || 'Unknown error'}`)
        return
      }
      alert('นำเข้าสำเร็จ!')
      void loadSystemGalleryPage({ reset: true })
    } catch {
      alert('นำเข้าไม่สำเร็จ')
    }
  }

  async function handleRepostGalleryVideo(id: string, targetNamespaceId?: string) {
    const namespaceForVideo = String(targetNamespaceId || namespaceId || '').trim() || undefined
    const url = new URL(`${WORKER_URL}/api/gallery/${encodeURIComponent(id)}`)
    if (namespaceForVideo) url.searchParams.set('namespace_id', namespaceForVideo)
    const resp = await apiFetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace_id: namespaceForVideo,
        resetPostedState: true,
      }),
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({})) as { error?: string }
      throw new Error(String(data.error || 'ย้ายกลับไปยังไม่โพสต์ไม่สำเร็จ'))
    }
    updateGalleryVideoState(id, namespaceForVideo, {
      postedAt: '',
      keepInPostedTab: false,
      updatedAt: new Date().toISOString(),
    })
  }

  const { galleryAvailableVideos, galleryShortlinkRequired } = useMemo(() => {
    const readyVideos = dedupeGalleryVideos(
      filterDeletedGalleryVideos(videos, deletedGalleryKeysRef.current).filter((video) =>
        getBooleanFlag((video as Video & Record<string, unknown>).original_only) !== true
      )
    )
    const postedVideos = dedupeGalleryVideos(
      filterDeletedGalleryVideos(usedVideos, deletedGalleryKeysRef.current)
    )
    const galleryShortlinkRequired = readyVideos.some((video) =>
      isVideoShortlinkRequired(video as Video & Record<string, unknown>, isSystemAdmin)
    )
    const availableVideos = categoryFilter === 'used' ? postedVideos : readyVideos

    return {
      galleryAvailableVideos: availableVideos,
      galleryShortlinkRequired,
    }
  }, [videos, usedVideos, categoryFilter, isSystemAdmin])
  const showGalleryFilterBar = tab === 'gallery' && (
    galleryLoading ||
    galleryReadyTotalCount > 0 ||
    galleryUsedTotalCount > 0
  )
  const isAllOriginalMode = categoryFilter === 'all-original' && isOwner
  const shouldShowGalleryHeader = !videoViewerOpen && tab === 'gallery' && (showGalleryFilterBar || !isAllOriginalMode)
  const galleryHeaderOffset = shouldShowGalleryHeader ? galleryHeaderHeight : 0
  const galleryVisibleVideos = galleryAvailableVideos
  const galleryHasMore = categoryFilter === 'used' ? galleryUsedHasMore : systemGalleryHasMore
  const galleryCurrentTotal = categoryFilter === 'used' ? galleryUsedTotalCount : galleryReadyTotalCount
  const appViewportStyle = {
    height: 'var(--tg-viewport-stable-height, 100dvh)',
    minHeight: 'var(--tg-viewport-stable-height, 100dvh)',
  } as const
  const headerTopPaddingStyle = {
    paddingTop: `calc(env(safe-area-inset-top, 0px) + ${GALLERY_HEADER_TOP_GAP}px)`,
  } as const
  const mainContentPaddingStyle = {
    paddingTop: shouldShowGalleryHeader
      ? `${galleryHeaderOffset}px`
      : 'env(safe-area-inset-top, 0px)',
    paddingBottom: videoViewerOpen
      ? '0px'
      : 'calc(env(safe-area-inset-bottom, 0px) + 72px)',
  } as const

  useEffect(() => {
    if (!shouldShowGalleryHeader) {
      setGalleryHeaderHeight(0)
      return
    }

    const header = galleryHeaderRef.current
    if (!header) return

    const updateHeight = () => {
      const nextHeight = Math.ceil(header.getBoundingClientRect().height)
      setGalleryHeaderHeight((prev) => (prev === nextHeight ? prev : nextHeight))
    }

    updateHeight()
    const rafId = window.requestAnimationFrame(updateHeight)
    window.addEventListener('resize', updateHeight)

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        window.cancelAnimationFrame(rafId)
        window.removeEventListener('resize', updateHeight)
      }
    }

    const observer = new ResizeObserver(() => updateHeight())
    observer.observe(header)

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updateHeight)
    }
  }, [shouldShowGalleryHeader])

  useEffect(() => {
    if (tab !== 'gallery' || isAllOriginalMode || galleryLoading || !galleryHasMore) return

    const root = mainScrollRef.current
    const target = galleryLoadMoreRef.current
    if (!root || !target) return

    const observer = new IntersectionObserver((entries) => {
      const first = entries[0]
      if (!first?.isIntersecting) return
      void loadSystemGalleryPage()
    }, {
      root,
      rootMargin: '360px 0px',
      threshold: 0.01,
    })

    observer.observe(target)
    return () => observer.disconnect()
  }, [tab, isAllOriginalMode, galleryLoading, galleryHasMore, galleryLoadingMore, categoryFilter, videos.length, usedVideos.length])

  useEffect(() => {
    if (tab !== 'gallery' || isAllOriginalMode || galleryLoading || !galleryHasMore) return

    const root = mainScrollRef.current
    if (!root) return

    let rafId = 0
    const maybeLoadMore = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        if (galleryLoadingMore) return

        const distanceToBottom = root.scrollHeight - root.scrollTop - root.clientHeight
        if (distanceToBottom > 480) return

        void loadSystemGalleryPage()
      })
    }

    maybeLoadMore()
    root.addEventListener('scroll', maybeLoadMore, { passive: true })
    return () => {
      root.removeEventListener('scroll', maybeLoadMore)
      if (rafId) window.cancelAnimationFrame(rafId)
    }
  }, [tab, isAllOriginalMode, galleryLoading, galleryHasMore, galleryLoadingMore, categoryFilter, videos.length, usedVideos.length])

  useEffect(() => {
    if (tab !== 'inbox' || inboxLoading || !inboxHasMore || isSystemAdmin) return

    const root = mainScrollRef.current
    const target = inboxLoadMoreRef.current
    if (!root || !target) return

    const observer = new IntersectionObserver((entries) => {
      const first = entries[0]
      if (!first?.isIntersecting) return
      void loadInboxSnapshot()
    }, {
      root,
      rootMargin: '320px 0px',
      threshold: 0.01,
    })

    observer.observe(target)
    return () => observer.disconnect()
  }, [tab, inboxLoading, inboxHasMore, inboxLoadingMore, isSystemAdmin, inboxVideos.length])

  useEffect(() => {
    if (tab !== 'inbox' || inboxLoading || !inboxHasMore || isSystemAdmin) return

    const root = mainScrollRef.current
    if (!root) return

    let rafId = 0
    const maybeLoadMore = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        if (inboxLoadingMore) return
        const distanceToBottom = root.scrollHeight - root.scrollTop - root.clientHeight
        if (distanceToBottom > 420) return
        void loadInboxSnapshot()
      })
    }

    maybeLoadMore()
    root.addEventListener('scroll', maybeLoadMore, { passive: true })
    return () => {
      root.removeEventListener('scroll', maybeLoadMore)
      if (rafId) window.cancelAnimationFrame(rafId)
    }
  }, [tab, inboxLoading, inboxHasMore, inboxLoadingMore, isSystemAdmin, inboxVideos.length])

  useEffect(() => {
    if (tab !== 'inbox' || systemInboxLoading || !systemInboxHasMore || !isSystemAdmin) return

    const root = mainScrollRef.current
    const target = inboxLoadMoreRef.current
    if (!root || !target) return

    const observer = new IntersectionObserver((entries) => {
      const first = entries[0]
      if (!first?.isIntersecting) return
      void loadSystemInbox()
    }, {
      root,
      rootMargin: '320px 0px',
      threshold: 0.01,
    })

    observer.observe(target)
    return () => observer.disconnect()
  }, [tab, systemInboxLoading, systemInboxHasMore, systemInboxLoadingMore, isSystemAdmin, systemInboxVideos.length])

  useEffect(() => {
    if (tab !== 'inbox' || inboxLoading || inboxLoadingMore || !inboxHasMore || isSystemAdmin) return

    const root = mainScrollRef.current
    if (!root) return
    if (root.scrollHeight > root.clientHeight + 120) return

    const timer = window.setTimeout(() => {
      void loadInboxSnapshot()
    }, 120)
    return () => window.clearTimeout(timer)
  }, [tab, inboxLoading, inboxLoadingMore, inboxHasMore, isSystemAdmin, inboxVideos.length])

  useEffect(() => {
    if (tab !== 'inbox' || systemInboxLoading || !systemInboxHasMore || !isSystemAdmin) return

    const root = mainScrollRef.current
    if (!root) return

    let rafId = 0
    const maybeLoadMore = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        if (systemInboxLoadingMore) return
        const distanceToBottom = root.scrollHeight - root.scrollTop - root.clientHeight
        if (distanceToBottom > 420) return
        void loadSystemInbox()
      })
    }

    maybeLoadMore()
    root.addEventListener('scroll', maybeLoadMore, { passive: true })
    return () => {
      root.removeEventListener('scroll', maybeLoadMore)
      if (rafId) window.cancelAnimationFrame(rafId)
    }
  }, [tab, systemInboxLoading, systemInboxHasMore, systemInboxLoadingMore, isSystemAdmin, systemInboxVideos.length])

  useEffect(() => {
    if (tab !== 'inbox' || systemInboxLoading || systemInboxLoadingMore || !systemInboxHasMore || !isSystemAdmin) return

    const root = mainScrollRef.current
    if (!root) return
    if (root.scrollHeight > root.clientHeight + 120) return

    const timer = window.setTimeout(() => {
      void loadSystemInbox()
    }, 120)
    return () => window.clearTimeout(timer)
  }, [tab, systemInboxLoading, systemInboxLoadingMore, systemInboxHasMore, isSystemAdmin, systemInboxVideos.length])

  // If viewing a specific page detail
  if (selectedPage) {
    return (
      <div
        style={{ height: 'var(--tg-viewport-stable-height, 100dvh)', minHeight: 'var(--tg-viewport-stable-height, 100dvh)' }}
        className="bg-white flex flex-col font-['Sukhumvit_Set','Kanit',sans-serif] overflow-hidden fixed inset-0"
      >
        <div style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 52px)' }} className="flex-1 pb-6 flex flex-col overflow-hidden">
          <PageDetail
            page={selectedPage}
            onBack={closeSelectedPage}
            onSave={handleSavePage}
          />
        </div>
      </div>
    )
  }

  // ========== PENDING APPROVAL GATE ==========
  if (pendingApproval) {
    return (
      <div style={{ height: '100dvh' }} className="flex flex-col items-center justify-center bg-white gap-4 px-8 font-['Sukhumvit_Set','Kanit',sans-serif]">
        <div className="w-20 h-20 bg-amber-50 rounded-full flex items-center justify-center text-4xl">&#x23F3;</div>
        <h1 className="text-xl font-bold text-gray-900">รอการอนุมัติ</h1>
        <p className="text-sm text-gray-500 text-center">บัญชีของคุณกำลังรอการอนุมัติจากแอดมิน<br/>กรุณารอสักครู่</p>
        <button onClick={() => window.location.reload()} className="mt-4 px-6 py-3 rounded-2xl bg-gray-100 text-sm font-bold text-gray-700 active:scale-95 transition-transform">ลองใหม่</button>
      </div>
    )
  }

  // ========== AUTH GATE ==========
  if (authBootstrapping && !token) {
    return (
      <div
        style={appViewportStyle}
        className="fixed inset-0 bg-white flex items-center justify-center font-['Sukhumvit_Set','Kanit',sans-serif] overflow-hidden"
      >
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <div className="w-7 h-7 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium">กำลังตรวจสอบการเข้าสู่ระบบ...</p>
        </div>
      </div>
    )
  }

  if (!token) {
    if (typeof window !== 'undefined' && isAppHost(window.location.hostname)) {
      return (
        <div
          style={appViewportStyle}
          className="fixed inset-0 bg-white flex items-center justify-center font-['Sukhumvit_Set','Kanit',sans-serif] overflow-hidden"
        >
          <div className="flex flex-col items-center gap-3 text-gray-500 px-8 text-center">
            <div className="w-7 h-7 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium">กำลังเชื่อมต่อ LINE...</p>
          </div>
        </div>
      )
    }

    return (
      <div style={appViewportStyle} className="fixed inset-0 flex flex-col bg-white font-['Sukhumvit_Set','Kanit',sans-serif] overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center px-8 gap-6">
          {/* Logo */}
          <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-[28px] flex items-center justify-center shadow-2xl shadow-blue-300/50">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 10l4.553-2.069A1 1 0 0121 8.87V15.13a1 1 0 01-1.447.9L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          </div>
          <div className="text-center">
            <h1 className="text-3xl font-black text-gray-900">เฉียบ AI</h1>
            <p className="text-sm text-gray-400 mt-1.5">ระบบสร้างคอนเทนต์ด้วย AI</p>
          </div>
        </div>
        <div className="px-6 pb-8">
          <a
            href="https://liff.line.me/2009652996-DJtEhoDn"
            className="w-full py-4 rounded-2xl font-bold text-base text-white flex items-center justify-center gap-2"
            style={{ background: '#06C755' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/></svg>
            เข้าสู่ระบบด้วย LINE
          </a>
        </div>
      </div>
    )
  }

  return (
    <div style={appViewportStyle} className="fixed inset-0 bg-white flex flex-col font-['Sukhumvit_Set','Kanit',sans-serif] overflow-hidden">
      {/* Add Page Popup */}
      {showAddPagePopup && (
        <AddPagePopup
          onClose={() => setShowAddPagePopup(false)}
          onSuccess={loadPages}
        />
      )}

      {shouldShowGalleryHeader && (
        <div
          ref={galleryHeaderRef}
          style={headerTopPaddingStyle}
          className="fixed top-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-b border-gray-100 z-50 px-5"
        >
          {tab === 'gallery' && !isAllOriginalMode && (
            <div className="pb-3">
              <div className="relative">
                <input
                  type="text"
                  value={gallerySearchInput}
                  onChange={(e) => setGallerySearchInput(e.target.value)}
                  placeholder="ค้นหา video id หรือชื่อคลิป"
                  className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 pr-11 text-sm font-medium text-gray-900 outline-none transition-all placeholder:text-gray-400 focus:border-blue-400 focus:bg-white"
                />
                {gallerySearchInput.trim() ? (
                  <button
                    onClick={() => setGallerySearchInput('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-gray-200 p-1.5 active:scale-95"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                ) : (
                  <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <path d="M21 21l-4.35-4.35" />
                    </svg>
                  </div>
                )}
              </div>
            </div>
          )}
          {tab === 'gallery' && showGalleryFilterBar && (
            <div className="flex bg-gray-100 p-1 mt-1 mb-2 rounded-xl gap-1">
              <button
                onClick={() => setCategoryFilter('ready')}
                className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${categoryFilter !== 'used' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                ยังไม่โพสต์ ({galleryReadyTotalCount})
              </button>
              <button
                onClick={() => setCategoryFilter('used')}
                className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${categoryFilter === 'used' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                โพสต์แล้ว ({galleryUsedTotalCount})
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      <div ref={mainScrollRef} style={mainContentPaddingStyle} className="flex-1 [&::-webkit-scrollbar]:hidden overflow-y-auto app-scroll">

        {tab === 'dashboard' && (
          <DashboardTab
            dashboardDateFilter={dashboardDateFilter}
            onDashboardDateChange={setDashboardDateFilter}
            onSelectToday={() => setDashboardDateFilter(getTodayString())}
            dashboardLoading={dashboardLoading}
            dashboardData={dashboardData}
          />
        )}

        {tab === 'inbox' && (
          <InboxTab
            isSystemAdmin={isSystemAdmin}
            systemInboxLoading={systemInboxLoading}
            systemInboxVideos={systemInboxVideos}
            systemInboxLoadingMore={systemInboxLoadingMore}
            systemInboxHasMore={systemInboxHasMore}
            inboxLoading={inboxLoading}
            inboxVideos={inboxVideos}
            inboxLoadingMore={inboxLoadingMore}
            inboxHasMore={inboxHasMore}
            loadMoreRef={inboxLoadMoreRef}
            namespaceId={namespaceId}
            startingInboxId={startingInboxId}
            deletingInboxId={deletingInboxId}
            onStartInboxVideo={handleStartInboxVideo}
            onDeleteInboxVideo={handleDeleteInboxVideo}
            onExpandedChange={setVideoViewerOpen}
            resolvePlaybackUrl={(video) => String(
              resolveGalleryAssetProxyUrl(video as unknown as Record<string, unknown>, 'original')
              || video.originalUrl
              || video.videoUrl
              || video.previewUrl
              || ''
            ).trim()}
            resolveThumbnailUrl={(video) => String(
              resolveInboxThumbnailDisplayUrl(video as unknown as Record<string, unknown>)
              || video.thumbnailUrl
              || ''
            ).trim()}
          />
        )}

        {tab === 'processing' && (
          <ProcessingTab
            loading={processingLoading}
            processingVideos={processingVideos}
            onCancel={handleCancelJob}
            onReprocess={handleReprocessJob}
            retryingProcessingId={retryingProcessingId}
          />
        )}

        {tab === 'gallery' && (
          <div className="px-4">
            {isAllOriginalMode ? (
              globalOriginalLoading && globalOriginalVideos.length === 0 ? (
                <div className="grid grid-cols-3 gap-3">
                  {[1, 2, 3, 4, 5, 6].map((i) => (
                    <div key={i} className="aspect-[9/16] rounded-2xl bg-gray-100 animate-pulse" />
                  ))}
                </div>
              ) : globalOriginalVideos.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[50vh]">
                  <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                    <span className="text-4xl grayscale opacity-50">🗂️</span>
                  </div>
                  <p className="text-gray-900 font-bold text-lg">ยังไม่มีวิดีโอต้นฉบับ</p>
                  <p className="text-gray-400 text-sm mt-1">จะแสดง _original.mp4 ของทุกยูสในระบบ</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {globalOriginalVideos.map((video) => (
                    <GlobalOriginalVideoCard key={video.id} video={video} onExpandedChange={setVideoViewerOpen} />
                  ))}
                </div>
              )
            ) : (galleryLoading || (galleryBootstrapPending && galleryCurrentTotal === 0)) ? (
              <div className="grid grid-cols-3 gap-3">
                {[1, 2, 3, 4, 5, 6].map(i => (
                  <div key={i} className="aspect-[9/16] rounded-2xl bg-gray-100 animate-pulse" />
                ))}
              </div>
            ) : galleryCurrentTotal === 0 ? (
              <div className="flex flex-col items-center justify-center h-[50vh]">
                <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                  <span className="text-4xl grayscale opacity-50">🎬</span>
                </div>
                <p className="text-gray-900 font-bold text-lg">
                  {gallerySearchQuery
                    ? 'ไม่พบคลิปที่ค้นหา'
                    : useSystemWideAdminGallery && !showGalleryFilterBar
                    ? 'ยังไม่มีคลิปใน Gallery'
                    : categoryFilter === 'used'
                      ? 'ยังไม่มีคลิปที่โพสต์แล้ว'
                      : 'ยังไม่มีคลิปรอโพสต์'}
                </p>
                <p className="text-gray-400 text-sm mt-1">
                  {gallerySearchQuery
                    ? 'ลองค้นหาด้วย video id หรือคำจากชื่อคลิปใหม่อีกครั้ง'
                    : useSystemWideAdminGallery && !showGalleryFilterBar
                    ? 'คลิปทุก workspace จะแสดงรวมกันที่นี่'
                    : categoryFilter === 'used'
                      ? 'คลิปที่โพสต์สำเร็จจะแสดงที่นี่'
                      : galleryShortlinkRequired
                        ? 'คลิปที่ย่อลิ้งครบแล้วและพร้อมโพสต์จะแสดงที่นี่'
                        : 'คลิปที่ประมวลผลเสร็จและลิงก์ครบแล้วจะพร้อมโพสต์ทันที'}
                </p>
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-3 gap-3">
                  {galleryVisibleVideos.map((video) => (
                    <VideoCard
                      key={getVideoIdentityKey(video as unknown as Record<string, unknown>)}
                      video={video}
                      currentNamespaceId={namespaceId}
                      showWorkspaceBadge={useSystemWideAdminGallery}
                      formatDuration={formatDuration}
                      keepInPostedOnLinkSave={!systemWideGalleryMode && categoryFilter === 'used'}
                      onDelete={(id, targetNamespaceId) => {
                        const deletedKey = targetNamespaceId ? `${targetNamespaceId}:${id}` : id
                        deletedGalleryKeysRef.current.add(deletedKey)
                        setVideos(videos.filter(v => getVideoIdentityKey(v as unknown as Record<string, unknown>) !== deletedKey));
                        setUsedVideos(usedVideos.filter(v => getVideoIdentityKey(v as unknown as Record<string, unknown>) !== deletedKey));
                      }}
                      onUpdate={updateGalleryVideoState}
                      onImport={useSystemWideAdminGallery ? handleImportVideo : undefined}
                      onExpandedChange={setVideoViewerOpen}
                      showRepostAction={categoryFilter === 'used'}
                      onRepost={handleRepostGalleryVideo}
                    />
                  ))}
                </div>

                {galleryHasMore && (
                  <div ref={galleryLoadMoreRef} className={galleryLoadingMore ? 'py-5' : 'h-1'}>
                    {galleryLoadingMore && (
                      <div className="flex items-center justify-center">
                        <div className="w-8 h-8 border-[3px] border-blue-200 border-t-blue-500 rounded-full animate-spin" />
                      </div>
                    )}
                  </div>
                )}

                {!galleryHasMore && galleryCurrentTotal > GALLERY_BATCH_SIZE && (
                  <p className="py-4 text-center text-xs font-medium text-gray-400">
                    แสดงแล้ว {galleryVisibleVideos.length}/{galleryCurrentTotal} คลิป
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'logs' && (
          <div className="px-4">
            {/* Date Filter - Pretty */}
            <div className="mb-4">
              <div className="flex items-center gap-2">
                {/* Date Picker Button */}
                <div className="flex-1 relative">
                  <input
                    type="date"
                    value={logDateFilter}
                    onChange={(e) => setLogDateFilter(e.target.value)}
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                  />
                  <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 flex items-center gap-3 active:scale-95 transition-all shadow-sm">
                    <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <p className="text-[11px] text-gray-400 font-medium">เลือกวันที่</p>
                      <p className="text-sm font-bold text-gray-900">
                        {(() => {
                          const [y, m, d] = logDateFilter.split('-')
                          const thaiMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
                          return `${parseInt(d)} ${thaiMonths[parseInt(m) - 1]} ${parseInt(y) + 543}`
                        })()}
                      </p>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </div>

                {/* Today Button */}
                <button
                  onClick={() => setLogDateFilter(getTodayString())}
                  className="shrink-0 bg-blue-500 text-white px-4 py-3 rounded-2xl text-sm font-bold active:scale-95 transition-all shadow-sm shadow-blue-200"
                >
                  วันนี้
                </button>
              </div>
            </div>

            {(() => {
              if (loading && postHistory.length === 0) {
                return (
                  <div className="space-y-2.5">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-20 rounded-2xl bg-gray-100 animate-pulse" />
                    ))}
                  </div>
                )
              }

              if (filteredLogHistory.length === 0) return (
                <div className="flex flex-col items-center justify-center h-[40vh]">
                  <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                    <span className="text-4xl grayscale opacity-50">📋</span>
                  </div>
                  <p className="text-gray-900 font-bold text-lg">ไม่มีข้อมูลวันนี้</p>
                  <p className="text-gray-400 text-sm mt-1">ลองเลือกวันอื่นดู</p>
                </div>
              )

              const displayedLogs = filteredLogHistory.slice(0, tab === 'logs' ? visibleLogCount : filteredLogHistory.length)
              const revealPlaceholders = Math.min(3, Math.max(filteredLogHistory.length - displayedLogs.length, 0))

              return (
                <div className="space-y-2.5">
                  {displayedLogs.map((item) => {
                    const postedDate = new Date(item.posted_at)
                    const thaiDate = new Date(postedDate.getTime() + 7 * 60 * 60 * 1000)
                    const timeStr = `${thaiDate.getUTCHours().toString().padStart(2, '0')}:${thaiDate.getUTCMinutes().toString().padStart(2, '0')}`
                    const fbLink = buildFacebookLogUrl(item)
                    const postMeta = getSimpleStatusMeta(getPostLogTone(item), 'post', item.status)
                    const commentCountdownSeconds = getCommentCountdownSeconds(item, logNowMs)
                    const baseCommentMeta = getSimpleStatusMeta(getCommentLogTone(item.comment_status), 'comment', item.comment_status)
                    const commentMeta = commentCountdownSeconds !== null
                      ? {
                          ...baseCommentMeta,
                          label: `รอคอมเมนต์ ${formatCountdownClock(commentCountdownSeconds)}`,
                          cls: 'bg-amber-50 text-amber-700',
                          loading: false,
                        }
                      : baseCommentMeta
                    const commentBadgeText = commentCountdownSeconds !== null
                      ? `COMMENT ${formatCountdownClock(commentCountdownSeconds)}`
                      : 'COMMENT'
                    const isExpanded = expandedLogId === item.id
                    const triggerSource = String(item.trigger_source || '').trim().toLowerCase()
                    const triggerSourceLabel = triggerSource === 'force_post'
                      ? 'FORCE_POST'
                      : triggerSource === 'retry_post'
                        ? 'REPOST'
                      : triggerSource === 'cron'
                        ? 'CRON'
                        : triggerSource === 'queue'
                          ? 'QUEUE'
                          : '-'
                    const triggerSourceCls = triggerSource === 'force_post'
                      ? 'bg-orange-50 text-orange-700'
                      : triggerSource === 'retry_post'
                        ? 'bg-amber-50 text-amber-700'
                      : triggerSource === 'cron'
                        ? 'bg-sky-50 text-sky-700'
                        : triggerSource === 'queue'
                          ? 'bg-violet-50 text-violet-700'
                          : 'bg-gray-100 text-gray-500'
                    const showCommentError = item.comment_error && item.comment_error.trim().length > 0
                    const showPostError = item.error_message && item.error_message.trim().length > 0
                    const canRetryPost = item.status !== 'posting' && deletingLogId !== item.id && retryingLogId !== item.id
                    const actualShopeeAffiliateId = String(item.shortlink_utm_source || '').trim().replace(/^an_/i, '')
                    const actualLazadaAffiliateId = String(item.lazada_member_id || '').trim()
                    const expectedShopeeAffiliateId = String(item.shortlink_expected_utm_id || '').trim()
                    const expectedLazadaAffiliateId = String(item.lazada_expected_member_id || '').trim()
                    const shopeeAffiliateIdFromUrl = extractShopeeAffiliateIdFromLinkClient(String(item.shopee_link || '')) || actualShopeeAffiliateId
                    const lazadaMemberIdFromUrl = extractLazadaMemberIdFromLinkClient(String(item.lazada_link || '')) || actualLazadaAffiliateId
                    const shouldShowAdminAffiliateCheck = isSystemAdmin
                    const shouldShowMemberAffiliateIds = !isSystemAdmin && !!(item.shopee_link || item.lazada_link || shopeeAffiliateIdFromUrl || lazadaMemberIdFromUrl)
                    const showAffiliateCheck = Boolean(
                      shouldShowAdminAffiliateCheck && (
                      item.shortlink_status ||
                      item.shortlink_error ||
                      expectedShopeeAffiliateId ||
                      actualShopeeAffiliateId ||
                      expectedLazadaAffiliateId ||
                      actualLazadaAffiliateId
                      )
                    )
                    const affiliateStatusLabel = item.shortlink_status === 'verified'
                      ? 'ผ่าน'
                      : item.shortlink_status === 'failed'
                        ? 'ไม่ผ่าน'
                        : item.shortlink_status === 'skipped'
                          ? 'ข้าม'
                          : '-'
                    const affiliateStatusClass = item.shortlink_status === 'verified'
                      ? 'bg-emerald-50 text-emerald-700'
                      : item.shortlink_status === 'failed'
                        ? 'bg-red-50 text-red-700'
                        : 'bg-gray-100 text-gray-600'
                    const shopeeMatchLabel = item.shortlink_utm_match === 1 ? 'ตรง' : item.shortlink_utm_match === 0 ? 'ไม่ตรง' : '-'
                    const lazadaMatchLabel = item.lazada_member_match === 1 ? 'ตรง' : item.lazada_member_match === 0 ? 'ไม่ตรง' : '-'

                    return (
                      <div key={item.id} className="rounded-2xl border border-gray-100 bg-white shadow-sm">
                        <div
                          className="flex items-center gap-3 p-3 cursor-pointer"
                          onClick={() => setExpandedLogId(isExpanded ? null : item.id)}
                          role="button"
                          aria-expanded={isExpanded}
                        >
                          {/* Page avatar */}
                          <img
                            src={item.page_image || getGraphPageImageUrl(item.page_id, 'small')}
                            alt={item.page_name}
                            onError={(e) => onPageImageError(e, item.page_id, 'small')}
                            className="w-10 h-10 rounded-full object-cover shrink-0 ring-2 ring-gray-100"
                          />
                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-gray-900 truncate">{item.page_name}</p>
                            <p className="text-xs text-gray-400 mt-0.5">{timeStr} น.</p>
                          </div>
                          {/* Status + Link */}
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="flex items-center justify-end gap-1">
                              <span className={`inline-flex items-center whitespace-nowrap text-[10px] font-bold px-2 py-1 rounded-lg ${triggerSourceCls}`}>
                                {triggerSourceLabel}
                              </span>
                              <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-bold px-2 py-1 rounded-lg ${postMeta.cls}`}>
                                {postMeta.loading && (
                                  <span className="w-2.5 h-2.5 border-[1.5px] border-current/30 border-t-current rounded-full animate-spin" />
                                )}
                                POST
                              </span>
                              <span className={`inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-bold px-2 py-1 rounded-lg ${commentMeta.cls}`}>
                                {commentMeta.loading && (
                                  <span className="w-2.5 h-2.5 border-[1.5px] border-current/30 border-t-current rounded-full animate-spin" />
                                )}
                                {commentCountdownSeconds !== null && !commentMeta.loading && (
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="8" />
                                    <path d="M12 8v4l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                )}
                                {commentBadgeText}
                              </span>
                            </div>
                            {fbLink && (
                              <a
                                href={fbLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center active:scale-90 transition-transform"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
                                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" strokeLinecap="round" strokeLinejoin="round" />
                                  <path d="M15 3h6v6" strokeLinecap="round" strokeLinejoin="round" />
                                  <path d="M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              </a>
                            )}
                            <button
                              disabled={!canRetryPost}
                              onClick={async (e) => {
                                e.stopPropagation()
                                if (!canRetryPost) return
                                setRetryingLogId(item.id)
                                try {
                                  const resp = await apiFetch(`${WORKER_URL}/api/post-history/${item.id}/retry-post`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({}),
                                  })
                                  const data = await resp.json().catch(() => ({}))
                                  if (!resp.ok) {
                                    throw new Error(String(data?.details || data?.error || resp.status))
                                  }
                                  await refreshPostHistorySnapshot({ force: true })
                                  alert(data?.fb_reel_url
                                    ? `โพสต์อีกครั้งสำเร็จ\n${data.fb_reel_url}`
                                    : 'โพสต์อีกครั้งสำเร็จ')
                                } catch (err) {
                                  alert(err instanceof Error ? err.message : String(err))
                                } finally {
                                  setRetryingLogId(null)
                                }
                              }}
                              className={`w-8 h-8 rounded-lg flex items-center justify-center active:scale-90 transition-transform ${
                                canRetryPost ? 'bg-amber-50' : 'bg-gray-100 opacity-60'
                              }`}
                              title="โพสต์อีกครั้ง"
                              aria-label="โพสต์อีกครั้ง"
                            >
                              {retryingLogId === item.id ? (
                                <div className="w-3.5 h-3.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={canRetryPost ? '#f59e0b' : '#94a3b8'} strokeWidth="2">
                                  <path d="M3 12a9 9 0 0 1 15.3-6.3L21 8" strokeLinecap="round" strokeLinejoin="round" />
                                  <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
                                  <path d="M21 12a9 9 0 0 1-15.3 6.3L3 16" strokeLinecap="round" strokeLinejoin="round" />
                                  <path d="M8 16H3v5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </button>
                            <button
                              disabled={deletingLogId === item.id || retryingLogId === item.id}
                              onClick={async (e) => {
                                e.stopPropagation()
                                setDeletingLogId(item.id)
                                try {
                                  await apiFetch(`${WORKER_URL}/api/post-history/${item.id}`, { method: 'DELETE' })
                                  await refreshPostHistorySnapshot({ force: true })
                                } finally {
                                  setDeletingLogId(null)
                                }
                              }}
                              className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center active:scale-90 transition-transform"
                            >
                              {deletingLogId === item.id ? (
                                <div className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                                  <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="px-3 pb-3 pt-2 border-t border-gray-100 text-xs text-gray-500 space-y-2">
                            <p><span className="font-semibold text-gray-700">Source:</span> {triggerSourceLabel}</p>
                            <p><span className="font-semibold text-gray-700">โพสต์:</span> {postMeta.label}</p>
                            <p><span className="font-semibold text-gray-700">คอมเม้นต์:</span> {commentMeta.label}</p>
                            <p className="break-all"><span className="font-semibold text-gray-700">ลิงก์ที่คอมเมนต์:</span> {item.shopee_link || '-'}</p>
                            {item.lazada_link && <p className="break-all"><span className="font-semibold text-gray-700">ลิงก์ Lazada ที่คอมเมนต์:</span> {item.lazada_link}</p>}
                            <div className="rounded-xl bg-blue-50/80 p-2.5 text-[11px] text-blue-900">
                              <p><span className="font-semibold">Gallery Video ID:</span> {item.video_id || '-'}</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {item.video_id && (
                                  <>
                                    <button
                                      onClick={() => navigator.clipboard.writeText(String(item.video_id || ''))}
                                      className="rounded-lg bg-white px-2.5 py-1 font-semibold text-blue-700 active:scale-95"
                                    >
                                      Copy ID
                                    </button>
                                    <button
                                      onClick={() => {
                                        setCategoryFilter('used')
                                        setGallerySearchInput(String(item.video_id || ''))
                                        setExpandedLogId(null)
                                        setTab('gallery')
                                      }}
                                      className="rounded-lg bg-blue-600 px-2.5 py-1 font-semibold text-white active:scale-95"
                                    >
                                      ค้นหาใน Gallery
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            <p><span className="font-semibold text-gray-700">Post Token:</span> {item.post_token_hint || '-'}</p>
                            <p><span className="font-semibold text-gray-700">Comment Token:</span> {item.comment_token_hint || '-'}</p>
                            {showAffiliateCheck && (
                              <div className="rounded-xl bg-gray-50 px-3 py-2.5 space-y-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="font-semibold text-gray-700">Affiliate Check</p>
                                  <span className={`inline-flex items-center rounded-lg px-2 py-1 text-[10px] font-bold ${affiliateStatusClass}`}>
                                    {affiliateStatusLabel}
                                  </span>
                                </div>
                                <p><span className="font-semibold text-gray-700">Shopee ID:</span> expected {expectedShopeeAffiliateId || '-'} / actual {actualShopeeAffiliateId || '-'} / {shopeeMatchLabel}</p>
                                <p><span className="font-semibold text-gray-700">Lazada ID:</span> expected {expectedLazadaAffiliateId || '-'} / actual {actualLazadaAffiliateId || '-'} / {lazadaMatchLabel}</p>
                                {item.shortlink_error && <p className="text-red-500 break-all"><span className="font-semibold text-red-600">Affiliate error:</span> {item.shortlink_error}</p>}
                              </div>
                            )}
                            {shouldShowMemberAffiliateIds && (
                              <div className="rounded-xl bg-gray-50 px-3 py-2.5 space-y-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="font-semibold text-gray-700">Affiliate ID จาก URL</p>
                                </div>
                                <p><span className="font-semibold text-gray-700">Shopee ID:</span> {shopeeAffiliateIdFromUrl || '-'}</p>
                                <p><span className="font-semibold text-gray-700">Lazada ID:</span> {lazadaMemberIdFromUrl || '-'}</p>
                              </div>
                            )}
                            {item.comment_fb_id && <p><span className="font-semibold text-gray-700">Comment ID:</span> {item.comment_fb_id}</p>}
                            {showCommentError && <p className="text-red-500"><span className="font-semibold text-red-600">คอมเม้นต์ผิดพลาด:</span> {item.comment_error}</p>}
                            {showPostError && <p className="text-red-500"><span className="font-semibold text-red-600">โพสต์ผิดพลาด:</span> {item.error_message}</p>}
                            {item.fb_post_id && <p><span className="font-semibold text-gray-700">Facebook Post ID:</span> {item.fb_post_id}</p>}
                            {item.fb_reel_url && <p className="break-all"><span className="font-semibold text-gray-700">Facebook Reel URL:</span> {buildFacebookLogUrl(item)}</p>}
                            <p><span className="font-semibold text-gray-700">Post History ID:</span> {item.id}</p>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {revealPlaceholders > 0 && Array.from({ length: revealPlaceholders }, (_, index) => (
                    <div key={`log-reveal-placeholder-${index}`} className="h-20 rounded-2xl border border-gray-100 bg-gray-50 animate-pulse" />
                  ))}
                </div>
              )
            })()}
          </div>
        )}

        {tab === 'settings' && settingsSection === 'pages' && (
          <div className="px-4 space-y-3" onClick={() => deletePageId && setDeletePageId(null)}>
            <div className="flex justify-end px-1">
              <button
                onClick={() => setShowAddPagePopup(true)}
                className="shrink-0 rounded-xl bg-blue-600 px-3.5 py-2 text-sm font-bold text-white active:scale-95"
              >
                เพิ่มเพจ
              </button>
            </div>

            {pagesLoading ? (
              <div className="grid grid-cols-3 gap-4">
                {[1, 2, 3, 4, 5, 6].map(i => (
                  <div key={i} className="aspect-square rounded-2xl bg-gray-100 animate-pulse" />
                ))}
              </div>
            ) : pages.length === 0 ? (
              <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-5 text-center">
                <p className="text-sm font-semibold text-gray-700">ยังไม่พบเพจใน workspace นี้</p>
                <p className="text-xs text-gray-500 mt-1">
                  กด "เพิ่มเพจ" แล้ววาง Facebook User Token เพื่อดึงรายการเพจผ่าน <code>me/accounts</code>
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-4">
                {pages.map((page) => {
                  let longPressTimer: ReturnType<typeof setTimeout> | null = null
                  const isDeleting = deletePageId === page.id
                  const isAutoPostOn = page.is_active === 1
                  const hasTokenIssue = hasPageTokenIssue(page)
                  const scheduleRaw = String(page.post_hours || '').trim()
                  const intervalMatch = scheduleRaw.match(/^every:(\d{1,4})$/i)
                  const intervalMinutes = Math.max(5, Math.min(720, parseInt(intervalMatch?.[1] || '', 10) || page.post_interval_minutes || 60))
                  const slotCount = scheduleRaw
                    ? scheduleRaw.split(',').map(s => s.trim()).filter(Boolean).length
                    : 0
                  const hasSchedule = !!intervalMatch || slotCount > 0
                  const postsPerDay = intervalMatch
                    ? Math.max(1, Math.floor((24 * 60) / intervalMinutes))
                    : slotCount
                  const postsPerDayLabel = hasSchedule ? `${postsPerDay} เวลา/วัน` : 'ยังไม่ตั้งเวลา'
                  const scheduleModeHint = intervalMatch ? `ทุก ${intervalMinutes} นาที` : ''
                  const borderClass = hasTokenIssue
                    ? 'border-orange-400 shadow-[0_0_0_2px_rgba(251,146,60,0.35),0_0_16px_rgba(249,115,22,0.55)]'
                    : isAutoPostOn
                      ? 'border-green-400 shadow-[0_0_0_2px_rgba(74,222,128,0.4),0_0_16px_rgba(34,197,94,0.6)]'
                      : 'border-red-400 shadow-[0_0_0_2px_rgba(248,113,113,0.35),0_0_12px_rgba(239,68,68,0.42)]'
                  const dotClass = hasTokenIssue ? 'bg-orange-500' : (isAutoPostOn ? 'bg-green-500' : 'bg-gray-300')

                  const onTouchStart = () => {
                    longPressTimer = setTimeout(() => {
                      setDeletePageId(page.id)
                      longPressTimer = null
                    }, 500)
                  }
                  const onTouchEnd = () => {
                    if (longPressTimer) {
                      clearTimeout(longPressTimer)
                      longPressTimer = null
                    }
                  }

                  return (
                    <button
                      key={page.id}
                      onClick={() => !isDeleting && openSelectedPage(page)}
                      onTouchStart={onTouchStart}
                      onTouchEnd={onTouchEnd}
                      onTouchMove={onTouchEnd}
                      onContextMenu={(e) => { e.preventDefault(); setDeletePageId(page.id) }}
                      className="flex flex-col items-center group"
                    >
                      <div className="relative w-full">
                        <div className="absolute z-20 top-2 left-2 px-2.5 py-1 rounded-full text-[10px] font-bold bg-black/85 text-white shadow-md">
                          {postsPerDayLabel}
                        </div>
                        <img
                          src={page.image_url || getGraphPageImageUrl(page.id)}
                          alt={page.name}
                          onError={(e) => onPageImageError(e, page.id)}
                          className={`relative z-10 w-full aspect-square rounded-2xl object-cover transition-all border-2 ${borderClass} ${isDeleting ? 'scale-95 brightness-90' : 'group-active:scale-95'}`}
                        />
                        <div
                          role="button"
                          aria-label={`ลบเพจ ${page.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (deletingPageId === page.id) return
                            const ok = window.confirm(`ยืนยันลบเพจ "${page.name}" ออกจาก workspace นี้?`)
                            if (!ok) return
                            void handleDeletePage(page.id)
                          }}
                          className="absolute z-30 top-2 right-2 w-7 h-7 rounded-full bg-red-500/95 text-white flex items-center justify-center shadow-md active:scale-90"
                        >
                          {deletingPageId === page.id ? (
                            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                        {/* Status Badge */}
                        <div className={`absolute z-20 -bottom-1 -right-1 w-5 h-5 rounded-full border-2 border-white ${dotClass}`}></div>

                        {/* Delete button - bottom center pill */}
                        {isDeleting && (
                          <div
                            className="absolute z-30 bottom-2 left-1/2 -translate-x-1/2 bg-red-500 rounded-full px-3 py-1 flex items-center gap-1 shadow-lg"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeletePage(page.id)
                            }}
                          >
                            {deletingPageId === page.id ? (
                              <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                                  <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                <span className="text-white text-[11px] font-bold">ลบ</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      <p className="mt-2 text-xs font-medium text-gray-700 text-center line-clamp-1">{page.name}</p>
                      {scheduleModeHint && (
                        <p className="text-[10px] text-gray-400">{scheduleModeHint}</p>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'settings' && settingsSection !== 'pages' && (
          <div className="px-5 space-y-4">
            {settingsSection === 'menu' ? (
              authBootstrapping ? (
                <SettingsMenuSkeleton />
              ) : (
                <>
                  {(meDisplayName || meLineUserId || meEmail) && (
                    <SettingsAccountCard
                      displayName={meDisplayName}
                      email={meEmail}
                      pictureUrl={mePictureUrl}
                      roleLabel={isSystemAdmin ? 'Admin' : isTeamMember && !isOwner ? 'Team' : 'Member'}
                      roleClassName={isSystemAdmin ? 'bg-purple-50 text-purple-600' : (isTeamMember && !isOwner) ? 'bg-gray-100 text-gray-600' : 'bg-blue-50 text-blue-600'}
                      namespaceId={namespaceId}
                      lineUserId={meLineUserId}
                      copiedIdentityField={copiedIdentityField}
                      onCopyNamespace={() => void handleCopyAccountIdentity('namespace', namespaceId)}
                      onCopyLine={() => void handleCopyAccountIdentity('line', meLineUserId)}
                    />
                  )}
                  <SettingsMenuItem
                    icon="📄"
                    title="Pages"
                    subtitle="เพิ่มเพจและตั้งค่า Auto Post"
                    onClick={() => openSettingsSection('pages')}
                  />
                  <SettingsMenuItem
                    icon="👥"
                    title="Team"
                    subtitle={`${teamMembers.length} สมาชิก`}
                    onClick={() => openSettingsSection('team')}
                  />
                  {isOwner && (
                    <SettingsMenuItem
                      icon="🔗"
                      title={isSystemAdmin ? 'Shortlink' : 'Affiliate ID'}
                      subtitle={isSystemAdmin
                        ? (
                          shortlinkAccountCurrent
                            ? `Account ${shortlinkAccountCurrent} • UTM ${shortlinkExpectedUtmIdCurrent || '-'} • member_id ${lazadaExpectedMemberIdCurrent || '-'}`
                            : 'ตั้งค่า account, Shopee UTM และ Lazada member_id'
                        )
                        : (
                          shortlinkExpectedUtmIdCurrent || lazadaExpectedMemberIdCurrent
                            ? `Shopee ID ${shortlinkExpectedUtmIdCurrent || '-'} • Lazada ID ${lazadaExpectedMemberIdCurrent || '-'}`
                            : 'ตั้งค่า Shopee ID และ Lazada ID'
                        )}
                      onClick={() => openSettingsSection('shortlink')}
                    />
                  )}
                  {isOwner && (
                    <SettingsMenuItem
                      icon="🕒"
                      title="Post"
                      subtitle={POSTING_ORDER_OPTIONS.find((option) => option.value === postingOrderCurrent)?.title || 'โพสต์เก่าสุดก่อน'}
                      onClick={() => openSettingsSection('post')}
                    />
                  )}
                  {isSystemAdmin && (
                    <SettingsMenuItem
                      icon="🔑"
                      title="Gemini API Key"
                      subtitle={
                        geminiApiKeySource === 'system' || geminiApiKeySource === 'legacy'
                          ? `ใช้ร่วมทุก namespace • ${geminiApiKeyMaskedList.filter(Boolean).length}/${geminiApiKeyMaxSlots} key`
                          : 'ตั้งค่า Gemini key กลางของระบบ'
                      }
                      onClick={() => openSettingsSection('gemini')}
                    />
                  )}
                  <SettingsMenuItem
                    icon="🎙️"
                    title="เสียงพากย์"
                    subtitle={summarizeVoiceSettings(voiceProfile, voiceSettingsSource, voiceOptions)}
                    onClick={() => openSettingsSection('voice')}
                  />
                  {isOwner && (
                    <SettingsMenuItem
                      icon="🖍️"
                      title="ข้อความบนปก"
                      subtitle={summarizeCoverTextStyle(coverTextStyle)}
                      onClick={() => openSettingsSection('cover')}
                    />
                  )}
                  <SettingsMenuItem
                    icon="💬"
                    title="Comment Template"
                    subtitle={commentTemplateSource === 'custom' ? 'กำลังใช้เทมเพลตคอมเมนต์ที่กำหนดเอง' : 'กำลังใช้เทมเพลตคอมเมนต์ค่าเริ่มต้น'}
                    onClick={() => openSettingsSection('comment')}
                  />
                  {isSystemAdmin && (
                    <SettingsMenuItem
                      icon="📊"
                      title="Monitor"
                      subtitle={
                        monitorData?.summary
                          ? `Cron ${monitorData.summary.active_pages} เพจ • คอมเมนต์ค้าง ${monitorData.summary.pending_comments} • โพสต์ค้าง ${monitorData.summary.posting_rows}`
                          : 'ดูสถานะ cron, โพสต์ค้าง, คอมเมนต์ค้าง และงานล่าสุด'
                      }
                      onClick={() => openSettingsSection('monitor')}
                    />
                  )}
                  {isSystemAdmin && (
                    <SettingsMenuItem
                      icon="&#x2705;"
                      title="สมาชิก"
                      subtitle={
                        systemMembers.length > 0
                          ? `${systemMembers.length} คนในระบบ • รออนุมัติ ${systemMembers.filter((member) => String(member.status || '').trim() === 'pending').length} คน`
                          : 'ดูสมาชิกทั้งหมดของระบบและจัดการ role'
                      }
                      onClick={() => openSettingsSection('members')}
                    />
                  )}
                  <p className="text-gray-300 text-xs font-medium text-center pt-2">Version 2.0.1 (Build 240)</p>
                  <SettingsLogoutButton
                    onLogout={handleLogout}
                    logoutLoading={logoutLoading}
                  />
                </>
              )
            ) : (
              <>
                {settingsSection === 'account' && (
                  <div className="space-y-3">
                    {(meDisplayName || meLineUserId || meEmail) ? (
                      <SettingsAccountCard
                        displayName={meDisplayName}
                        email={meEmail}
                        pictureUrl={mePictureUrl}
                        roleLabel={isSystemAdmin ? 'Admin' : isTeamMember && !isOwner ? 'Team' : 'Member'}
                        roleClassName={isSystemAdmin ? 'bg-purple-50 text-purple-600' : (isTeamMember && !isOwner) ? 'bg-gray-100 text-gray-600' : 'bg-blue-50 text-blue-600'}
                        namespaceId={namespaceId}
                        lineUserId={meLineUserId}
                        copiedIdentityField={copiedIdentityField}
                        onCopyNamespace={() => void handleCopyAccountIdentity('namespace', namespaceId)}
                        onCopyLine={() => void handleCopyAccountIdentity('line', meLineUserId)}
                      />
                    ) : (
                      <div className="bg-white border border-gray-100 rounded-2xl p-4 text-sm text-gray-500">
                        ไม่พบบัญชีผู้ใช้
                      </div>
                    )}
                    <SettingsLogoutButton
                      onLogout={handleLogout}
                      logoutLoading={logoutLoading}
                    />
                  </div>
                )}

                {settingsSection === 'team' && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      {teamMembers.length === 0 && (
                        <p className="text-sm text-gray-400 text-center py-2">ยังไม่มีสมาชิกในทีม</p>
                      )}
                      {teamMembers.map((m) => (
                        <div key={m.email} className="flex items-center gap-3">
                          {m.status === 'pending' ? (
                            <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center text-xl">⏳</div>
                          ) : m.picture_url ? (
                            <img src={m.picture_url} className="w-10 h-10 rounded-full object-cover" />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 font-bold text-sm">
                              {(m.display_name || m.line_user_id || '?').charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-gray-900 truncate">
                              {m.status === 'pending' ? 'คำเชิญ' : (m.display_name || m.line_user_id || 'LINE User')}
                            </p>
                            <p className="text-xs text-gray-400 truncate">
                              {m.status === 'pending' ? (
                                <span className="text-amber-500 font-semibold">รอตอบรับ · {new Date(m.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}</span>
                              ) : (
                                m.line_user_id ? `LINE UID: ${m.line_user_id}` : `namespace member`
                              )}
                            </p>
                          </div>
                          <button
                            onClick={async () => {
                              await apiFetch(`${WORKER_URL}/api/team/${encodeURIComponent(m.email)}`, { method: 'DELETE' })
                              setTeamMembers(prev => prev.filter(x => x.email !== m.email))
                            }}
                            className="px-3 py-1.5 rounded-xl bg-red-50 text-red-500 text-xs font-bold active:scale-90 transition-transform"
                          >
                            ลบ
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={handleInviteTeam}
                        disabled={invitingTeam}
                        className="w-full py-3 rounded-2xl font-bold text-base text-white flex items-center justify-center gap-2 active:scale-[0.97] transition-all disabled:opacity-60"
                        style={{ background: '#06C755' }}
                      >
                        {invitingTeam ? (
                          <>
                            <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" /></svg>
                            กำลังเปิด...
                          </>
                        ) : (
                          <>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63h2.386c.349 0 .63.285.63.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.627-.63.349 0 .631.285.631.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/></svg>
                            เชิญเพื่อนผ่าน LINE
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {settingsSection === 'gemini' && isSystemAdmin && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        ตั้งค่า Gemini key กลางของระบบได้สูงสุด 5 key และทุก namespace จะใช้ชุดนี้ร่วมกัน ถ้า key แรกมีปัญหา ระบบจะขยับไปใช้อีก key ทันที
                      </p>
                      <p className="text-[11px] text-gray-400 leading-relaxed">
                        กรอกเฉพาะช่องที่อยากเปลี่ยนได้ ช่องที่เว้นว่างจะใช้ค่าเดิมต่อ
                      </p>
                      {geminiApiKeyLoading ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลด Gemini API key...</p>
                      ) : (
                        <>
                          <div className="space-y-2">
                            {Array.from({ length: geminiApiKeyMaxSlots }, (_, index) => {
                              const masked = geminiApiKeyMaskedList[index] || ''
                              const value = geminiApiKeyDrafts[index] || ''
                              return (
                                <div key={`gemini-slot-${index}`} className="space-y-1">
                                  <div className="flex items-center justify-between">
                                    <p className="text-[11px] font-bold text-gray-500">Key {index + 1}</p>
                                    <p className="text-[11px] text-gray-400">{value.length}/{geminiApiKeyMaxChars}</p>
                                  </div>
                                  <input
                                    type="password"
                                    value={value}
                                    onChange={(e) => {
                                      const next = [...geminiApiKeyDrafts]
                                      next[index] = e.target.value
                                      setGeminiApiKeyDrafts(next)
                                      if (geminiApiKeyMessage) setGeminiApiKeyMessage('')
                                    }}
                                    placeholder={masked ? `${masked} (กรอกใหม่เพื่อแทนค่าเดิม)` : 'AIza...'}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                                  />
                                  {masked && (
                                    <p className="text-[11px] text-gray-400 break-all">คีย์ปัจจุบัน: {masked}</p>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-gray-400">
                            <span>
                              แหล่งที่ใช้งาน: {geminiApiKeySource === 'system' ? 'กลางของระบบ' : geminiApiKeySource === 'legacy' ? 'กำลังใช้คีย์เก่าของ admin' : 'ยังไม่ตั้งค่า'}
                            </span>
                            <span>ใช้งานอยู่ {geminiApiKeyMaskedList.filter(Boolean).length}/{geminiApiKeyMaxSlots}</span>
                          </div>
                          {geminiApiKeyUpdatedAt && (
                            <p className="text-[11px] text-gray-400">อัปเดตล่าสุด: {new Date(geminiApiKeyUpdatedAt).toLocaleString()}</p>
                          )}
                          {geminiApiKeyMessage && (
                            <p className={`text-xs ${geminiApiKeyMessage.includes('ไม่สำเร็จ') || geminiApiKeyMessage.includes('ไม่มีสิทธิ์') ? 'text-red-500' : 'text-green-600'}`}>
                              {geminiApiKeyMessage}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                if (geminiApiKeySaving || geminiApiKeyDrafts.some((value) => value.length > geminiApiKeyMaxChars)) return
                                void saveGeminiApiKeys(geminiApiKeyDrafts)
                              }}
                              disabled={geminiApiKeySaving || geminiApiKeyDrafts.some((value) => value.length > geminiApiKeyMaxChars) || geminiApiKeyDrafts.every((value) => !String(value || '').trim())}
                              className="flex-1 bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all disabled:opacity-40"
                            >
                              {geminiApiKeySaving ? 'กำลังบันทึก...' : 'บันทึก Gemini API key'}
                            </button>
                            <button
                              onClick={() => {
                                if (geminiApiKeySaving) return
                                void saveGeminiApiKeys([])
                              }}
                              disabled={geminiApiKeySaving || (geminiApiKeySource === 'none' && geminiApiKeyMaskedList.every((value) => !value))}
                              className="px-4 py-2.5 rounded-xl text-sm font-bold border border-gray-200 text-gray-700 bg-gray-50 active:scale-95 transition-all disabled:opacity-40"
                            >
                              ล้างค่า
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {settingsSection === 'shortlink' && isOwner && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {isSystemAdmin
                          ? 'ใส่ค่า affiliate ของ workspace นี้เพื่อให้ระบบเช็กก่อนโพสต์ทุกครั้ง ส่วน account ใช้เฉพาะ workspace ที่ต้องย่อลิงก์'
                          : 'ใส่ Shopee ID กับ Lazada ID ของ workspace นี้ เพื่อให้ระบบเช็กก่อนโพสต์ทุกครั้ง โดย member จะไม่มีการย่อลิงก์'}
                      </p>
                      {shortlinkLoading ? (
                        <p className="text-sm text-gray-400 py-3">{isSystemAdmin ? 'กำลังโหลด Shortlink...' : 'กำลังโหลด Affiliate ID...'}</p>
                      ) : (
                        <>
                          {isSystemAdmin && (
                            <>
                              <div className="space-y-1">
                                <p className="text-[11px] font-semibold text-gray-600">Shortlink account</p>
                                <p className="text-[11px] text-gray-400">เช่น `CHEARB` หรือ `SIAMNEWS`</p>
                              </div>
                              <input
                                type="text"
                                value={shortlinkAccountDraft}
                                onChange={(e) => {
                                  setShortlinkAccountDraft(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))
                                  if (shortlinkMessage) setShortlinkMessage('')
                                }}
                                placeholder="CHEARB"
                                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                              />
                            </>
                          )}
                          <div className="space-y-1">
                            <p className="text-[11px] font-semibold text-gray-600">{isSystemAdmin ? 'Shopee expected UTM ID' : 'Shopee ID'}</p>
                            <p className="text-[11px] text-gray-400">ใส่เฉพาะตัวเลข เช่น `15130770000`</p>
                          </div>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={shortlinkExpectedUtmIdDraft}
                            onChange={(e) => {
                              setShortlinkExpectedUtmIdDraft(e.target.value.replace(/[^\d]/g, ''))
                              if (shortlinkMessage) setShortlinkMessage('')
                            }}
                            placeholder="15130770000"
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                          />
                          <div className="space-y-1">
                            <p className="text-[11px] font-semibold text-gray-600">{isSystemAdmin ? 'Lazada expected member_id' : 'Lazada ID'}</p>
                            <p className="text-[11px] text-gray-400">ใส่ member_id ของ Lazada เช่น `199431090`</p>
                          </div>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={lazadaExpectedMemberIdDraft}
                            onChange={(e) => {
                              setLazadaExpectedMemberIdDraft(e.target.value.replace(/[^\d]/g, ''))
                              if (shortlinkMessage) setShortlinkMessage('')
                            }}
                            placeholder="199431090"
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                          />
                          <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-[11px] text-gray-500 space-y-1">
                            {isSystemAdmin && (
                              <p>Account ปัจจุบัน: <span className="font-semibold text-gray-700">{shortlinkAccountCurrent || '-'}</span></p>
                            )}
                            <p>{isSystemAdmin ? 'Shopee UTM ปัจจุบัน' : 'Shopee ID ปัจจุบัน'}: <span className="font-semibold text-gray-700">{shortlinkExpectedUtmIdCurrent || '-'}</span></p>
                            <p>{isSystemAdmin ? 'Lazada member_id ปัจจุบัน' : 'Lazada ID ปัจจุบัน'}: <span className="font-semibold text-gray-700">{lazadaExpectedMemberIdCurrent || '-'}</span></p>
                          </div>
                          {shortlinkUpdatedAt && (
                            <p className="text-[11px] text-gray-400">อัปเดตล่าสุด: {new Date(shortlinkUpdatedAt).toLocaleString()}</p>
                          )}
                          {shortlinkMessage && (
                            <p className={`text-xs ${shortlinkMessage.includes('ไม่สำเร็จ') || shortlinkMessage.includes('ไม่มีสิทธิ์') ? 'text-red-500' : 'text-green-600'}`}>
                              {shortlinkMessage}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                if (
                                  shortlinkSaving ||
                                  shortlinkAccountDraft.length > shortlinkAccountMaxChars ||
                                  shortlinkExpectedUtmIdDraft.length > shortlinkExpectedUtmIdMaxChars ||
                                  lazadaExpectedMemberIdDraft.length > lazadaExpectedMemberIdMaxChars
                                ) return
                                void saveShortlinkSettings(shortlinkAccountDraft)
                              }}
                              disabled={
                                shortlinkSaving ||
                                shortlinkAccountDraft.length > shortlinkAccountMaxChars ||
                                shortlinkExpectedUtmIdDraft.length > shortlinkExpectedUtmIdMaxChars ||
                                lazadaExpectedMemberIdDraft.length > lazadaExpectedMemberIdMaxChars ||
                                (!shortlinkAccountDraft.trim() && !shortlinkExpectedUtmIdDraft.trim() && !lazadaExpectedMemberIdDraft.trim())
                              }
                              className="flex-1 bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all disabled:opacity-40"
                            >
                              {shortlinkSaving ? 'กำลังบันทึก...' : 'บันทึกค่า'}
                            </button>
                            <button
                              onClick={() => {
                                if (shortlinkSaving) return
                                void saveShortlinkSettings('')
                              }}
                              disabled={shortlinkSaving || (!shortlinkEnabled && !shortlinkExpectedUtmIdCurrent && !lazadaExpectedMemberIdCurrent && !shortlinkAccountCurrent)}
                              className="px-4 py-2.5 rounded-xl text-sm font-bold border border-gray-200 text-gray-700 bg-gray-50 active:scale-95 transition-all disabled:opacity-40"
                            >
                              ล้างค่า
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {settingsSection === 'post' && isOwner && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        ตั้งลำดับการหยิบคลิปจาก Gallery ตอน cron และตอนกดโพสต์ทันที
                      </p>
                      {postingOrderLoading ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลดการตั้งค่า Post...</p>
                      ) : (
                        <>
                          <div className="space-y-2">
                            {POSTING_ORDER_OPTIONS.map((option) => {
                              const active = postingOrderDraft === option.value
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() => {
                                    setPostingOrderDraft(option.value)
                                    if (postingOrderMessage) setPostingOrderMessage('')
                                  }}
                                  className={`w-full rounded-2xl border px-4 py-3 text-left transition-all active:scale-[0.99] ${
                                    active ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-gray-50'
                                  }`}
                                >
                                  <div className="flex items-start gap-3">
                                    <div className={`mt-0.5 h-4 w-4 rounded-full border ${active ? 'border-blue-500 bg-blue-500 shadow-[inset_0_0_0_3px_white]' : 'border-gray-300 bg-white'}`} />
                                    <div className="min-w-0">
                                      <p className={`text-sm font-bold ${active ? 'text-blue-700' : 'text-gray-900'}`}>{option.title}</p>
                                      <p className="mt-0.5 text-xs text-gray-500">{option.subtitle}</p>
                                    </div>
                                  </div>
                                </button>
                              )
                            })}
                          </div>
                          {postingOrderUpdatedAt && (
                            <p className="text-[11px] text-gray-400">อัปเดตล่าสุด: {new Date(postingOrderUpdatedAt).toLocaleString()}</p>
                          )}
                          {postingOrderMessage && (
                            <p className={`text-xs ${postingOrderMessage.includes('ไม่สำเร็จ') || postingOrderMessage.includes('ไม่มีสิทธิ์') ? 'text-red-500' : 'text-green-600'}`}>
                              {postingOrderMessage}
                            </p>
                          )}
                          <button
                            onClick={() => {
                              if (postingOrderSaving || postingOrderDraft === postingOrderCurrent) return
                              void savePostingOrderSettings(postingOrderDraft)
                            }}
                            disabled={postingOrderSaving || postingOrderDraft === postingOrderCurrent}
                            className="w-full rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-bold text-white active:scale-95 transition-all disabled:opacity-40"
                          >
                            {postingOrderSaving ? 'กำลังบันทึก...' : 'บันทึกค่า'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {settingsSection === 'comment' && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        ตั้งค่าข้อความคอมเมนต์ที่ระบบใช้ตอนโพสต์ลิงก์อัตโนมัติ เทมเพลตนี้จะมีผลกับงานถัดไปทันที
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-700">{COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER} จำเป็น</span>
                        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-700">{COMMENT_TEMPLATE_LAZADA_PLACEHOLDER} ถ้ามีลิงก์</span>
                      </div>
                      {commentTemplateLoading ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลดเทมเพลตคอมเมนต์...</p>
                      ) : (
                        <>
                          <textarea
                            value={commentTemplateDraft}
                            onChange={(e) => {
                              setCommentTemplateDraft(e.target.value)
                              if (commentTemplateMessage) setCommentTemplateMessage('')
                            }}
                            rows={9}
                            placeholder={DEFAULT_COMMENT_TEMPLATE}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                          />
                          <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-[11px] text-gray-500 space-y-1">
                            <p>ต้องมี <span className="font-semibold text-gray-700">{COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER}</span> อย่างน้อย 1 จุด</p>
                            <p>ถ้าไม่ต้องการ Lazada ในบางโพสต์ ปล่อย <span className="font-semibold text-gray-700">{COMMENT_TEMPLATE_LAZADA_PLACEHOLDER}</span> ไว้ได้ ระบบจะใส่เฉพาะตอนมีลิงก์</p>
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-gray-400">
                            <span>{commentTemplateSource === 'custom' ? 'กำลังใช้เทมเพลตคอมเมนต์ที่กำหนดเอง' : 'กำลังใช้เทมเพลตคอมเมนต์ค่าเริ่มต้น'}</span>
                            <span>{commentTemplateDraft.length}/{commentTemplateMaxChars}</span>
                          </div>
                          {commentTemplateUpdatedAt && (
                            <p className="text-[11px] text-gray-400">อัปเดตล่าสุด: {new Date(commentTemplateUpdatedAt).toLocaleString()}</p>
                          )}
                          {commentTemplateMessage && (
                            <p className={`text-xs ${commentTemplateMessage.includes('ไม่สำเร็จ') || commentTemplateMessage.includes('ไม่มีสิทธิ์') || commentTemplateMessage.includes('ต้องมี') ? 'text-red-500' : 'text-green-600'}`}>
                              {commentTemplateMessage}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                if (commentTemplateSaving || commentTemplateDraft.length > commentTemplateMaxChars) return
                                void saveCommentTemplate(commentTemplateDraft)
                              }}
                              disabled={
                                commentTemplateSaving ||
                                commentTemplateDraft.length > commentTemplateMaxChars ||
                                !commentTemplateDraft.trim() ||
                                commentTemplateDraft === commentTemplate
                              }
                              className="flex-1 bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all disabled:opacity-40"
                            >
                              {commentTemplateSaving ? 'กำลังบันทึก...' : 'บันทึกเทมเพลต'}
                            </button>
                            <button
                              onClick={() => {
                                if (commentTemplateSaving) return
                                void saveCommentTemplate('')
                              }}
                              disabled={commentTemplateSaving || commentTemplateSource === 'default'}
                              className="px-4 py-2.5 rounded-xl text-sm font-bold border border-gray-200 text-gray-700 bg-gray-50 active:scale-95 transition-all disabled:opacity-40"
                            >
                              รีเซ็ตค่าเริ่มต้น
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {settingsSection === 'voice' && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        ตั้งค่าเสียงของ workspace นี้ได้เลย งานถัดไปจะใช้ทันที โดยเลือก `voice_name` ของ Gemini จริง พร้อม preset น้ำเสียงของระบบ และใส่ prompt เพิ่มเติมได้เองว่าต้องการให้พากย์สไตล์ไหน
                      </p>
                      {voiceSettingsLoading ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลดเสียงพากย์...</p>
                      ) : (
                        <>
                          {legacyVoicePromptActive && (
                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[12px] text-amber-700">
                              workspace นี้ยังใช้ `voice prompt` แบบเก่าอยู่ กดบันทึกครั้งเดียวเพื่อย้ายมาใช้ preset ใหม่
                            </div>
                          )}

                          <div className="space-y-1">
                            <p className="text-[11px] font-semibold text-gray-600">Gemini voice</p>
                            <select
                              value={voiceProfileDraft.voice_name}
                              onChange={(e) => {
                                setVoiceProfileDraft((prev) => ({ ...prev, voice_name: e.target.value }))
                                if (voiceSettingsMessage) setVoiceSettingsMessage('')
                              }}
                              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                            >
                              {(voiceOptions.length > 0 ? voiceOptions : [{ name: 'Puck', descriptor: 'Upbeat' }]).map((option) => (
                                <option key={option.name} value={option.name}>
                                  {option.name} • {option.descriptor}
                                </option>
                              ))}
                            </select>
                            <p className="text-[11px] text-gray-400">
                              เสียงจริงจาก Gemini: {getVoiceOptionMeta(voiceProfileDraft.voice_name, voiceOptions)?.descriptor || 'Upbeat'}
                            </p>
                          </div>

                          <div className="space-y-2">
                            <p className="text-[11px] font-semibold text-gray-600">เพศเสียง</p>
                            <div className="grid grid-cols-3 gap-2">
                              {VOICE_PERSONA_OPTIONS.map((option) => {
                                const active = voiceProfileDraft.persona === option.value
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                      setVoiceProfileDraft((prev) => ({ ...prev, persona: option.value }))
                                      if (voiceSettingsMessage) setVoiceSettingsMessage('')
                                    }}
                                    className={`rounded-xl border px-3 py-2.5 text-left transition-all ${active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700'}`}
                                  >
                                    <p className="text-sm font-semibold">{option.label}</p>
                                    <p className="text-[11px] text-gray-400">{option.hint}</p>
                                  </button>
                                )
                              })}
                            </div>
                            <p className="text-[11px] text-gray-400">ตัวเลือกนี้เป็น preset ของระบบเพื่อกำกับคาแรกเตอร์ ไม่ใช่ field gender ตรงของ Google</p>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <p className="text-[11px] font-semibold text-gray-600">โทนเสียง</p>
                              <p className="text-[11px] text-gray-400">เลือกได้สูงสุด 3</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {VOICE_TONE_OPTIONS.map((option) => {
                                const active = voiceProfileDraft.tones.includes(option.value)
                                const limitReached = !active && voiceProfileDraft.tones.length >= 3
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => {
                                      setVoiceProfileDraft((prev) => {
                                        const exists = prev.tones.includes(option.value)
                                        if (exists) {
                                          if (prev.tones.length === 1) return prev
                                          return { ...prev, tones: prev.tones.filter((tone) => tone !== option.value) }
                                        }
                                        if (prev.tones.length >= 3) return prev
                                        return { ...prev, tones: [...prev.tones, option.value] }
                                      })
                                      if (voiceSettingsMessage) setVoiceSettingsMessage('')
                                    }}
                                    disabled={limitReached}
                                    className={`rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-all ${active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-600'} ${limitReached ? 'opacity-40' : ''}`}
                                  >
                                    {active ? '✓ ' : ''}{option.label}
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <p className="text-[11px] font-semibold text-gray-600">Prompt เพิ่มเติมสำหรับการพากย์</p>
                              <p className={`text-[11px] ${voiceProfileDraft.custom_style_prompt.length > voiceStylePromptMaxChars ? 'text-red-500' : 'text-gray-400'}`}>
                                {voiceProfileDraft.custom_style_prompt.length}/{voiceStylePromptMaxChars}
                              </p>
                            </div>
                            <textarea
                              value={voiceProfileDraft.custom_style_prompt}
                              onChange={(e) => {
                                const nextValue = e.target.value.slice(0, voiceStylePromptMaxChars)
                                setVoiceProfileDraft((prev) => ({ ...prev, custom_style_prompt: nextValue }))
                                if (voiceSettingsMessage) setVoiceSettingsMessage('')
                              }}
                              rows={4}
                              placeholder="เช่น พากย์แบบพรีเมียม สุภาพ แต่มีแรงขายเนียน ๆ หรือ พากย์แบบเพื่อนแนะนำของดี น้ำเสียงสดใส ไม่อ่านแข็ง"
                              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-3 text-sm outline-none focus:border-blue-400 resize-none"
                            />
                            <p className="text-[11px] text-gray-400">
                              ใส่สไตล์เฉพาะที่อยากให้ AI ใช้ตอนเขียนบทและตอนอ่านพากย์ เช่น ความขาย, ความขี้เล่น, ความพรีเมียม, ความเป็นกันเอง หรือคำต้องห้าม
                            </p>
                          </div>

                          <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-[11px] text-gray-500 space-y-1">
                            <p>ใช้ค่าแยกตาม workspace นี้</p>
                            <p>Google Gemini TTS ใช้ `voice_name` จริง ส่วนเพศเสียง/โทนเสียงและ prompt เพิ่มเติม จะถูกเอาไปกำกับทั้งการเขียนบทและน้ำเสียงตอนพากย์</p>
                          </div>

                          {voiceSettingsUpdatedAt && (
                            <p className="text-[11px] text-gray-400">อัปเดตล่าสุด: {new Date(voiceSettingsUpdatedAt).toLocaleString()}</p>
                          )}
                          {voicePreviewUrl && (
                            <audio
                              id="voice-preview-audio"
                              controls
                              src={voicePreviewUrl}
                              className="w-full"
                            />
                          )}
                          {voicePreviewMessage && (
                            <p className={`text-xs ${voicePreviewMessage.includes('ไม่สำเร็จ') ? 'text-red-500' : 'text-blue-600'}`}>
                              {voicePreviewMessage}
                            </p>
                          )}
                          {voiceSettingsMessage && (
                            <p className={`text-xs ${voiceSettingsMessage.includes('ไม่สำเร็จ') || voiceSettingsMessage.includes('ไม่มีสิทธิ์') ? 'text-red-500' : 'text-green-600'}`}>
                              {voiceSettingsMessage}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                if (voicePreviewLoading) return
                                void previewVoiceProfile(voiceProfileDraft)
                              }}
                              disabled={voicePreviewLoading}
                              className="px-4 py-2.5 rounded-xl text-sm font-bold border border-gray-200 text-gray-700 bg-white active:scale-95 transition-all disabled:opacity-40"
                            >
                              {voicePreviewLoading ? 'กำลังสร้างตัวอย่าง...' : 'ฟังตัวอย่าง'}
                            </button>
                            <button
                              onClick={() => {
                                if (voiceSettingsSaving) return
                                void saveVoicePrompt(voiceProfileDraft)
                              }}
                              disabled={voiceSettingsSaving || (!legacyVoicePromptActive && voiceProfilesEqual(voiceProfileDraft, voiceProfile))}
                              className="flex-1 bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all disabled:opacity-40"
                            >
                              {voiceSettingsSaving ? 'กำลังบันทึก...' : 'บันทึกเสียงพากย์'}
                            </button>
                            <button
                              onClick={() => {
                                if (voiceSettingsSaving) return
                                void saveVoicePrompt(null, { reset: true })
                              }}
                              disabled={voiceSettingsSaving}
                              className="px-4 py-2.5 rounded-xl text-sm font-bold border border-gray-200 text-gray-700 bg-gray-50 active:scale-95 transition-all disabled:opacity-40"
                            >
                              รีเซ็ตค่าเริ่มต้น
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {settingsSection === 'cover' && isOwner && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        ตั้งค่าสไตล์ข้อความบนปกของ workspace นี้ได้เลย เวลาผู้ใช้พิมพ์คำบนปก ระบบจะใช้ฟอนต์ สีตัวหนังสือ สีพื้นหลัง และความโปร่งใสจากค่านี้ทันที โดยกล่องพื้นหลังจะพอดีกับความยาวข้อความอัตโนมัติ
                      </p>
                      {coverTextStyleLoading ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลดการตั้งค่าข้อความบนปก...</p>
                      ) : (
                        <>
                          <div className="space-y-2">
                            <p className="text-[11px] font-semibold text-gray-600">ฟอนต์</p>
                            <div className="space-y-2">
                              <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
                                <select
                                  value={coverTextStyleDraft.font_id}
                                  onChange={(e) => {
                                    setCoverTextStyleDraft((prev) => ({ ...prev, font_id: normalizeCoverTextFontId(e.target.value) }))
                                    if (coverTextStyleMessage) setCoverTextStyleMessage('')
                                  }}
                                  className="w-full bg-transparent text-sm font-semibold text-gray-800 outline-none"
                                  style={{ fontFamily: `${getCoverTextFontFamily(coverTextStyleDraft.font_id)}, Kanit, sans-serif` }}
                                >
                                  {COVER_TEXT_FONT_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <p className="text-[11px] text-gray-400">
                                {COVER_TEXT_FONT_OPTIONS.find((option) => option.value === coverTextStyleDraft.font_id)?.hint || ''}
                              </p>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <label className="space-y-1">
                              <span className="text-[11px] font-semibold text-gray-600">สีตัวหนังสือ</span>
                              <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
                                <input
                                  type="color"
                                  value={coverTextStyleDraft.text_color}
                                  onChange={(e) => {
                                    setCoverTextStyleDraft((prev) => ({ ...prev, text_color: normalizeCoverHexColor(e.target.value, prev.text_color) }))
                                    if (coverTextStyleMessage) setCoverTextStyleMessage('')
                                  }}
                                  className="h-8 w-10 rounded border-0 bg-transparent p-0"
                                />
                                <span className="text-sm font-semibold text-gray-700">{coverTextStyleDraft.text_color}</span>
                              </div>
                            </label>
                            <label className="space-y-1">
                              <span className="text-[11px] font-semibold text-gray-600">พื้นหลังข้อความ</span>
                              <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
                                <input
                                  type="color"
                                  value={coverTextStyleDraft.background_color}
                                  onChange={(e) => {
                                    setCoverTextStyleDraft((prev) => ({ ...prev, background_color: normalizeCoverHexColor(e.target.value, prev.background_color) }))
                                    if (coverTextStyleMessage) setCoverTextStyleMessage('')
                                  }}
                                  className="h-8 w-10 rounded border-0 bg-transparent p-0"
                                />
                                <span className="text-sm font-semibold text-gray-700">{coverTextStyleDraft.background_color}</span>
                              </div>
                            </label>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <p className="text-[11px] font-semibold text-gray-600">ความโปร่งใสพื้นหลัง</p>
                              <p className="text-[11px] text-gray-400">{Math.round(coverTextStyleDraft.background_opacity * 100)}%</p>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={100}
                              step={1}
                              value={Math.round(coverTextStyleDraft.background_opacity * 100)}
                              onChange={(e) => {
                                const next = Math.max(0, Math.min(100, Number(e.target.value || 0)))
                                setCoverTextStyleDraft((prev) => ({ ...prev, background_opacity: Math.round((next / 100) * 100) / 100 }))
                                if (coverTextStyleMessage) setCoverTextStyleMessage('')
                              }}
                              data-allow-native-drag="true"
                              className="w-full accent-blue-600 touch-pan-x"
                            />
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <p className="text-[11px] font-semibold text-gray-600">ขนาดข้อความพื้นฐาน</p>
                              <p className="text-[11px] text-gray-400">{Math.round(coverTextStyleDraft.size_scale * 100)}%</p>
                            </div>
                            <input
                              type="range"
                              min={80}
                              max={135}
                              step={1}
                              value={Math.round(coverTextStyleDraft.size_scale * 100)}
                              onChange={(e) => {
                                const next = Math.max(80, Math.min(135, Number(e.target.value || 100)))
                                setCoverTextStyleDraft((prev) => ({ ...prev, size_scale: Math.round((next / 100) * 100) / 100 }))
                                if (coverTextStyleMessage) setCoverTextStyleMessage('')
                              }}
                              data-allow-native-drag="true"
                              className="w-full accent-blue-600 touch-pan-x"
                            />
                            <p className="text-[11px] text-gray-400">ระบบจะย่อหรือขยายต่อให้อัตโนมัติตามความยาวข้อความ เพื่อให้ข้อความยาวยังอ่านได้</p>
                          </div>

                          <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 space-y-2">
                            <p className="text-[11px] font-semibold text-gray-600">ตัวอย่างสไตล์</p>
                            <div className="rounded-2xl bg-slate-900/90 px-4 py-6 flex items-center justify-center">
                              <span
                                className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-center font-bold"
                                style={{
                                  fontFamily: `'${getCoverTextFontFamily(coverTextStyleDraft.font_id)}', 'Kanit', sans-serif`,
                                  color: coverTextStyleDraft.text_color,
                                  backgroundColor: `${coverTextStyleDraft.background_color}${Math.round(coverTextStyleDraft.background_opacity * 255).toString(16).padStart(2, '0')}`,
                                  fontSize: `${Math.round(26 * coverTextStyleDraft.size_scale)}px`,
                                }}
                              >
                                ข้อความบนปกตัวอย่าง
                              </span>
                            </div>
                            <p className="text-[11px] text-gray-400">พื้นหลังของข้อความจริงจะพอดีกับความกว้างข้อความอัตโนมัติ</p>
                          </div>

                          {coverTextStyleUpdatedAt && (
                            <p className="text-[11px] text-gray-400">อัปเดตล่าสุด: {new Date(coverTextStyleUpdatedAt).toLocaleString()}</p>
                          )}
                          {coverTextStyleMessage && (
                            <p className={`text-xs ${coverTextStyleMessage.includes('ไม่สำเร็จ') || coverTextStyleMessage.includes('ไม่มีสิทธิ์') ? 'text-red-500' : 'text-green-600'}`}>
                              {coverTextStyleMessage}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                if (coverTextStyleSaving) return
                                void saveCoverTextStyle(coverTextStyleDraft)
                              }}
                              disabled={coverTextStyleSaving || coverTextStylesEqual(coverTextStyleDraft, coverTextStyle)}
                              className="flex-1 bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all disabled:opacity-40"
                            >
                              {coverTextStyleSaving ? 'กำลังบันทึก...' : 'บันทึกข้อความบนปก'}
                            </button>
                            <button
                              onClick={() => {
                                if (coverTextStyleSaving) return
                                const next = createDefaultCoverTextStyle()
                                setCoverTextStyleDraft(next)
                                void saveCoverTextStyle(next)
                              }}
                              disabled={coverTextStyleSaving}
                              className="px-4 py-2.5 rounded-xl text-sm font-bold border border-gray-200 text-gray-700 bg-gray-50 active:scale-95 transition-all disabled:opacity-40"
                            >
                              รีเซ็ตค่าเริ่มต้น
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {settingsSection === 'members' && isSystemAdmin && (
                  <div className="-mx-4 space-y-3">
                    <div className="px-4">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        ดูสมาชิกทั้งหมดของระบบ เปลี่ยน role และอนุมัติสมาชิกใหม่ได้ในหน้านี้เลย
                      </p>
                    </div>
                      {systemMembersLoading ? (
                        <p className="px-4 text-sm text-gray-400 py-3">กำลังโหลดรายชื่อ...</p>
                      ) : systemMembers.length === 0 ? (
                        <div className="px-4 text-center py-8">
                          <div className="w-14 h-14 bg-green-50 rounded-full flex items-center justify-center text-2xl mx-auto mb-3">&#x2705;</div>
                          <p className="text-sm text-gray-500">ยังไม่มีสมาชิกในระบบ</p>
                        </div>
                      ) : (
                        <div className="bg-white">
                          {systemMembers.map((member, index) => {
                            const role = (member.role || 'member') as SystemMemberRole
                            const status = String(member.status || '').trim() || 'approved'
                            const isPending = status === 'pending'
                            const isCurrentUser = String(member.line_user_id || '').trim() === String(meLineUserId || '').trim()
                            const isBusy = approvingUserId === member.line_user_id || rejectingUserId === member.line_user_id || savingMemberRoleId === member.line_user_id
                            const roleOptions: Array<{ value: SystemMemberRole; label: string }> = [
                              { value: 'admin', label: 'Admin' },
                              { value: 'member', label: 'Member' },
                              { value: 'team', label: 'Team' },
                            ]

                            return (
                              <div
                                key={member.line_user_id}
                                className={`bg-white px-4 py-3 ${index === 0 ? '' : 'border-t border-gray-100'}`}
                              >
                                <div className="flex items-start gap-3">
                                  {member.picture_url ? (
                                    <img src={member.picture_url} className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
                                  ) : (
                                    <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-bold text-sm flex-shrink-0">
                                      {(member.display_name || member.line_user_id || '?').charAt(0).toUpperCase()}
                                    </div>
                                  )}

                                  <div className="flex-1 min-w-0 space-y-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-sm font-semibold text-gray-900 truncate">{member.display_name || 'ไม่มีชื่อ'}</p>
                                      {isCurrentUser && (
                                        <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-600">คุณ</span>
                                      )}
                                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${isPending ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}>
                                        {isPending ? 'Pending' : 'Approved'}
                                      </span>
                                    </div>

                                    <div className="space-y-1">
                                      <p className="text-[11px] text-gray-400 break-all">UID: {member.line_user_id || '-'}</p>
                                      <p className="text-[11px] text-gray-400 break-all">Namespace: {member.namespace_id || '-'}</p>
                                    </div>

                                    {(isPending || rejectingUserId === member.line_user_id) && (
                                      <div className="flex gap-2 pt-1">
                                        <button
                                          onClick={() => void approveSystemMember(String(member.line_user_id || ''))}
                                          disabled={approvingUserId === member.line_user_id || rejectingUserId === member.line_user_id}
                                          className="px-3 py-1.5 rounded-lg bg-green-500 text-white text-xs font-bold active:scale-95 transition-all disabled:opacity-50"
                                        >
                                          {approvingUserId === member.line_user_id ? '...' : 'อนุมัติ'}
                                        </button>
                                        <button
                                          onClick={() => void rejectSystemMember(String(member.line_user_id || ''))}
                                          disabled={approvingUserId === member.line_user_id || rejectingUserId === member.line_user_id}
                                          className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-bold active:scale-95 transition-all disabled:opacity-50"
                                        >
                                          {rejectingUserId === member.line_user_id ? '...' : 'ปฏิเสธ'}
                                        </button>
                                      </div>
                                    )}
                                  </div>

                                  <div className="w-[104px] rounded-2xl border border-gray-100 bg-gray-50 p-1.5 flex-shrink-0">
                                    <div className="space-y-1">
                                      {roleOptions.map((option) => {
                                        const active = role === option.value
                                        return (
                                          <button
                                            key={option.value}
                                            type="button"
                                            onClick={() => {
                                              if (isBusy || isCurrentUser || active) return
                                              void saveSystemMemberRole(String(member.line_user_id || ''), option.value)
                                            }}
                                            disabled={isBusy || isCurrentUser}
                                            className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-[11px] font-bold transition-all ${
                                              active
                                                ? option.value === 'admin'
                                                  ? 'bg-purple-500 text-white'
                                                  : option.value === 'team'
                                                    ? 'bg-gray-800 text-white'
                                                    : 'bg-blue-500 text-white'
                                                : 'bg-white text-gray-600 border border-gray-200 disabled:opacity-40'
                                            }`}
                                          >
                                            <span>{option.label}</span>
                                            <span className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${
                                              active
                                                ? 'border-white/60 bg-white/20 text-white'
                                                : 'border-gray-300 bg-white text-transparent'
                                            }`}>
                                              ✓
                                            </span>
                                          </button>
                                        )
                                      })}
                                    </div>
                                    {savingMemberRoleId === member.line_user_id && (
                                      <p className="pt-1 text-center text-[10px] font-semibold text-gray-400">กำลังบันทึก...</p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                  </div>
                )}

                {settingsSection === 'monitor' && isSystemAdmin && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-4 shadow-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-bold tracking-[0.18em] text-blue-500 uppercase">Monitor</p>
                          <p className="mt-1 text-lg font-black text-gray-900">รายการสถานะระบบ</p>
                          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
                            การ์ดสรุปและรายการปัญหาล่าสุดของ cron, post, และ comment
                          </p>
                          {monitorData?.summary?.latest_cron_success_at && (
                            <p className="mt-1 text-[11px] text-gray-400">
                              cron success ล่าสุด: {new Date(monitorData.summary.latest_cron_success_at).toLocaleString('th-TH')}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => { void loadMonitor() }}
                          disabled={monitorLoading}
                          className="px-3 py-2 rounded-xl text-xs font-bold border border-gray-200 text-gray-700 bg-gray-50 active:scale-95 transition-all disabled:opacity-40"
                        >
                          {monitorLoading ? 'กำลังโหลด...' : 'รีเฟรช'}
                        </button>
                      </div>

                      {monitorLoading && !monitorData ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลด Monitor...</p>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 gap-3">
                            {[
                              { label: 'เพจที่เปิด cron', value: String(monitorData?.summary?.active_pages || 0) },
                              { label: 'namespace ที่ใช้ cron', value: String(monitorData?.summary?.active_namespaces || 0) },
                              { label: 'โพสต์ค้าง', value: String(monitorData?.summary?.posting_rows || 0) },
                              { label: 'คอมเมนต์ค้าง', value: String(monitorData?.summary?.pending_comments || 0) },
                              { label: 'โพสต์ fail 24 ชม.', value: String(monitorData?.summary?.failed_posts_24h || 0) },
                              { label: 'คอมเมนต์ fail 24 ชม.', value: String(monitorData?.summary?.failed_comments_24h || 0) },
                            ].map((item) => (
                              <div key={item.label} className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                                <p className="text-[11px] font-medium text-gray-500">{item.label}</p>
                                <p className="mt-1 text-xl font-black text-gray-900">{item.value}</p>
                              </div>
                            ))}
                          </div>

                          {monitorView === 'overview' ? (
                            <div className="grid grid-cols-1 gap-3">
                              <button
                                type="button"
                                onClick={() => setMonitorView('cron')}
                                className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-4 text-left active:scale-[0.99] transition-all"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-bold text-gray-900">Cron Runtime</p>
                                    <p className="mt-1 text-[12px] text-gray-500">ดูสถานะรอบล่าสุดและ heartbeat</p>
                                  </div>
                                  <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                                    String(monitorData?.cron_runtime?.status || '').trim() === 'running'
                                      ? 'bg-blue-50 text-blue-600'
                                      : String(monitorData?.cron_runtime?.status || '').trim() === 'failed'
                                        ? 'bg-red-50 text-red-500'
                                        : 'bg-gray-200 text-gray-600'
                                  }`}>
                                    {String(monitorData?.cron_runtime?.status || 'idle')}
                                  </span>
                                </div>
                                <p className="mt-2 text-[12px] text-gray-600">
                                  visited {Number(monitorData?.cron_runtime?.pages_visited || 0)} / posted {Number(monitorData?.cron_runtime?.pages_posted || 0)} / failed {Number(monitorData?.cron_runtime?.pages_failed || 0)}
                                </p>
                              </button>

                              {[
                                {
                                  key: 'stale' as const,
                                  title: 'เพจ cron ที่ stale',
                                  subtitle: 'เพจที่ cron ไม่ได้แตะนานผิดปกติ',
                                  count: Array.isArray(monitorData?.stale_cron_pages) ? monitorData.stale_cron_pages.length : 0,
                                  tone: 'red',
                                },
                                {
                                  key: 'post' as const,
                                  title: 'โพสต์ที่มีปัญหาล่าสุด',
                                  subtitle: 'ดูรายการ failed หรือ posting ค้าง',
                                  count: Array.isArray(monitorData?.post_issues) ? monitorData.post_issues.length : 0,
                                  tone: 'amber',
                                },
                                {
                                  key: 'comment' as const,
                                  title: 'คอมเมนต์ที่มีปัญหาล่าสุด',
                                  subtitle: 'ดูรายการ pending, processing, failed',
                                  count: Array.isArray(monitorData?.comment_issues) ? monitorData.comment_issues.length : 0,
                                  tone: 'amber',
                                },
                              ].map((item) => (
                                <button
                                  key={item.key}
                                  type="button"
                                  onClick={() => setMonitorView(item.key)}
                                  className="rounded-2xl border border-gray-100 bg-white px-4 py-4 text-left active:scale-[0.99] transition-all"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div>
                                      <p className="text-sm font-bold text-gray-900">{item.title}</p>
                                      <p className="mt-1 text-[12px] text-gray-500">{item.subtitle}</p>
                                    </div>
                                    <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                                      item.tone === 'red' ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-600'
                                    }`}>
                                      {item.count}
                                    </span>
                                  </div>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <button
                                type="button"
                                onClick={() => setMonitorView('overview')}
                                className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-bold text-gray-700 active:scale-95 transition-all"
                              >
                                กลับไปการ์ดสรุป
                              </button>

                              {monitorView === 'cron' && (
                                <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-4 space-y-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="text-sm font-bold text-gray-900">Cron Runtime</p>
                                    <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                                      String(monitorData?.cron_runtime?.status || '').trim() === 'running'
                                        ? 'bg-blue-50 text-blue-600'
                                        : String(monitorData?.cron_runtime?.status || '').trim() === 'failed'
                                          ? 'bg-red-50 text-red-500'
                                          : 'bg-gray-200 text-gray-600'
                                    }`}>
                                      {String(monitorData?.cron_runtime?.status || 'idle')}
                                    </span>
                                  </div>
                                  <p className="text-[12px] text-gray-600">
                                    visited {Number(monitorData?.cron_runtime?.pages_visited || 0)} / posted {Number(monitorData?.cron_runtime?.pages_posted || 0)} / failed {Number(monitorData?.cron_runtime?.pages_failed || 0)}
                                  </p>
                                  {monitorData?.cron_runtime?.current_page_name && (
                                    <p className="text-[12px] text-gray-500">กำลังวิ่งที่: {monitorData.cron_runtime.current_page_name}</p>
                                  )}
                                  {monitorData?.cron_runtime?.heartbeat_at && (
                                    <p className="text-[11px] text-gray-400">heartbeat: {new Date(String(monitorData.cron_runtime.heartbeat_at)).toLocaleString('th-TH')}</p>
                                  )}
                                  {monitorData?.cron_runtime?.last_error && (
                                    <p className="text-[11px] text-red-500 break-all">last error: {String(monitorData.cron_runtime.last_error)}</p>
                                  )}
                                </div>
                              )}

                              {monitorView === 'stale' && (
                                <div className="rounded-2xl border border-red-100 bg-white px-4 py-4 space-y-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="text-sm font-bold text-gray-900">เพจ cron ที่ stale</p>
                                    <span className="rounded-full bg-red-50 px-2 py-1 text-[11px] font-bold text-red-500">
                                      {Array.isArray(monitorData?.stale_cron_pages) ? monitorData.stale_cron_pages.length : 0}
                                    </span>
                                  </div>
                                  {Array.isArray(monitorData?.stale_cron_pages) && monitorData.stale_cron_pages.length > 0 ? (
                                    <div className="space-y-2">
                                      {monitorData.stale_cron_pages.map((item, index) => (
                                        <div key={`stale-${item.page_id || index}`} className="rounded-xl border border-red-100 bg-red-50 px-3 py-3">
                                          <p className="text-sm font-bold text-gray-900">{item.page_name || item.page_id || 'Unknown page'}</p>
                                          <p className="text-[11px] text-gray-500">namespace {item.namespace_id || '-'} • schedule {item.post_hours || '-'}</p>
                                          <p className="text-[11px] text-red-500">แตะล่าสุด: {item.last_cron_touched ? new Date(String(item.last_cron_touched)).toLocaleString('th-TH') : 'ยังไม่เคยโดน cron แตะ'}</p>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-sm text-green-600">ไม่พบเพจ cron ที่ stale ในตอนนี้</p>
                                  )}
                                </div>
                              )}

                              {monitorView === 'post' && (
                                <div className="rounded-2xl border border-gray-100 bg-white px-4 py-4 space-y-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="text-sm font-bold text-gray-900">โพสต์ที่มีปัญหาล่าสุด</p>
                                    <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-600">
                                      {Array.isArray(monitorData?.post_issues) ? monitorData.post_issues.length : 0}
                                    </span>
                                  </div>
                                  {Array.isArray(monitorData?.post_issues) && monitorData.post_issues.length > 0 ? (
                                    <div className="space-y-2">
                                      {monitorData.post_issues.map((item, index) => (
                                        <div key={`post-issue-${item.id || index}`} className="rounded-xl border border-gray-100 bg-white px-3 py-3">
                                          <div className="flex items-center justify-between gap-3">
                                            <p className="text-sm font-bold text-gray-900">video {item.video_id || '-'}</p>
                                            <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${item.status === 'failed' ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-600'}`}>{item.status || '-'}</span>
                                          </div>
                                          <p className="text-[11px] text-gray-500">page {item.page_id || '-'} • namespace {item.bot_id || '-'}</p>
                                          <p className="text-[11px] text-gray-400">{item.posted_at ? new Date(String(item.posted_at)).toLocaleString('th-TH') : '-'}</p>
                                          {item.error_message && <p className="text-[11px] text-red-500 break-all">{item.error_message}</p>}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-sm text-green-600">ไม่มี post issue ค้างในตอนนี้</p>
                                  )}
                                </div>
                              )}

                              {monitorView === 'comment' && (
                                <div className="rounded-2xl border border-gray-100 bg-white px-4 py-4 space-y-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="text-sm font-bold text-gray-900">คอมเมนต์ที่มีปัญหาล่าสุด</p>
                                    <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-600">
                                      {Array.isArray(monitorData?.comment_issues) ? monitorData.comment_issues.length : 0}
                                    </span>
                                  </div>
                                  {Array.isArray(monitorData?.comment_issues) && monitorData.comment_issues.length > 0 ? (
                                    <div className="space-y-2">
                                      {monitorData.comment_issues.map((item, index) => (
                                        <div key={`comment-issue-${item.id || index}`} className="rounded-xl border border-gray-100 bg-white px-3 py-3">
                                          <div className="flex items-center justify-between gap-3">
                                            <p className="text-sm font-bold text-gray-900">video {item.video_id || '-'}</p>
                                            <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${
                                              item.comment_status === 'failed' ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-600'
                                            }`}>{item.comment_status || '-'}</span>
                                          </div>
                                          <p className="text-[11px] text-gray-500">page {item.page_id || '-'} • namespace {item.bot_id || '-'}</p>
                                          <p className="text-[11px] text-gray-400">{item.posted_at ? new Date(String(item.posted_at)).toLocaleString('th-TH') : '-'}</p>
                                          {item.comment_error && <p className="text-[11px] text-red-500 break-all">{item.comment_error}</p>}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-sm text-green-600">ไม่มี comment issue ค้างในตอนนี้</p>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {!videoViewerOpen && (
        <BottomNav tab={tab} onChangeTab={setTab} />
      )}
    </div>
  )
}

export default App
