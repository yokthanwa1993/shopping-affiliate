import { useDeferredValue, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react'


const WORKER_URL = String(import.meta.env.VITE_WORKER_URL || 'https://video-affiliate-worker.onlyy-gor.workers.dev')
  .trim()
  .replace(/\/+$/, '')

const COMMENT_TEMPLATE_SHOPEE_PLACEHOLDER = '{{shopee_link}}'
const COMMENT_TEMPLATE_LAZADA_PLACEHOLDER = '{{lazada_link}}'
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
  void botScope
  return false
}

const CACHE_VERSION = 'v6'
const globalCacheKey = (kind: 'gallery' | 'used' | 'history') => `${kind}_cache:${CACHE_VERSION}`
const nsCacheKey = (kind: 'gallery' | 'used' | 'history', namespaceId: string) => `${kind}_cache:${CACHE_VERSION}:${namespaceId}`
const systemGalleryCacheKey = (botScope = getBotScopeFromLocation()) => scopedStorageKey(`gallery_system_cache:${CACHE_VERSION}`, botScope)
const GALLERY_BATCH_SIZE = 24
const LOGS_REVEAL_BATCH_SIZE = 1
const LOGS_REVEAL_INTERVAL_MS = 45
const FORCE_SYSTEM_WIDE_GALLERY = false

const readGalleryCacheForScope = (botScope = getBotScopeFromLocation(), namespaceId = '', systemWide = false) => {
  if (FORCE_SYSTEM_WIDE_GALLERY || systemWide || hasStoredAffiliateShortlinkConfig(botScope)) {
    return []
  }

  const scopedNamespace = String(namespaceId || getStoredNamespace(botScope) || '').trim()
  if (scopedNamespace) {
    return dedupeGalleryVideos(readCache<Video[]>(nsCacheKey('gallery', scopedNamespace), []))
  }

  return dedupeGalleryVideos(readCache<Video[]>(globalCacheKey('gallery'), []))
}

const apiFetch = async (url: string, options: RequestInit = {}) => {
  const headers = { ...options.headers, 'x-auth-token': getToken() }
  return fetch(url, { ...options, headers, cache: 'no-store' })
};

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
  keepInPostedTab?: boolean
}

interface InboxVideo {
  id: string
  videoUrl?: string
  previewUrl?: string
  createdAt: string
  updatedAt?: string
  status: string
  sourceType?: string
  sourceLabel?: string
  shopeeLink?: string
  lazadaLink?: string
  hasShopeeLink?: boolean
  hasLazadaLink?: boolean
  readyToProcess?: boolean
  processingStatus?: 'idle' | 'queued' | 'processing'
  processingActive?: boolean
  archiveState?: 'original' | 'processed'
  canStartProcessing?: boolean
  canDelete?: boolean
}

interface GalleryPageResponse {
  videos?: Video[]
  total?: number
  overall_total?: number
  offset?: number
  limit?: number
  has_more?: boolean
  shopee_total?: number
  lazada_total?: number
  with_link_total?: number
  without_link_total?: number
}

interface SystemGalleryStats {
  total: number
  withLink: number
  withoutLink: number
  shopeeTotal: number
  lazadaTotal: number
}

function normalizeGallerySearchQuery(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function matchesGallerySearch(video: Partial<Video> & Record<string, unknown>, query: string): boolean {
  const needle = normalizeGallerySearchQuery(query)
  if (!needle) return true

  const haystacks = [
    video.id,
    video.namespace_id,
    video.owner_email,
    video.title,
    video.script,
    video.category,
    video.shopeeLink,
    video.lazadaLink,
  ]

  return haystacks.some((value) => normalizeGallerySearchQuery(String(value || '')).includes(needle))
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
  shortlink_utm_source?: string | null
  shortlink_status?: string | null
  shortlink_error?: string | null
  shortlink_expected_utm_id?: string | null
  shortlink_utm_match?: number | null
  error_message?: string | null
}

interface DashboardAdminStat {
  telegram_id: string
  email: string
  links: number
}

interface DashboardData {
  date: string
  totals: {
    posts_all: number
    posts_on_date: number
    links_all: number
    links_on_date: number
  }
  admins: DashboardAdminStat[]
}

interface FacebookPage {
  id: string
  name: string
  image_url: string
  access_token?: string
  post_interval_minutes: number
  post_hours?: string  // slot: "2:22,9:49" or interval: "every:30"
  is_active: number
  last_post_at?: string
  updated_at?: string
}

type GalleryFilter = 'missing-link' | 'unused' | 'used' | 'all-original'
type GeminiKeySource = 'workspace' | 'none'
type SettingsSection = 'menu' | 'account' | 'pages' | 'team' | 'gemini' | 'shortlink' | 'voice' | 'comment'

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

const getVideoAffiliateConversionState = (
  video: Partial<Video> & Record<string, unknown>,
  expectedUtmId = '',
  expectedLazadaMemberId = '',
) => {
  const hasPlayable = !!resolvePlayableVideoUrl(video)
  const shopeeSourceLink = getVideoSourceShopeeLink(video)
  const shopeeCurrentLink = getVideoShopeeLink(video)
  const hasShopeeSource = !!shopeeSourceLink
  const hasManagedShopeeConversion = !!String(
    video.shopeeConvertedAt || video.shopee_converted_at || video.shopeeOriginalLink || video.shopee_original_link || ''
  ).trim()
  const shopeeReady = !!shopeeCurrentLink && isLikelyConvertedShopeeLink(shopeeCurrentLink, expectedUtmId)

  const lazadaSourceLink = getVideoSourceLazadaLink(video)
  const lazadaCurrentLink = getVideoLazadaLink(video)
  const hasLazadaSource = !!lazadaSourceLink
  const hasManagedLazadaConversion = !!String(
    video.lazadaConvertedAt || video.lazada_converted_at || video.lazadaOriginalLink || video.lazada_original_link || ''
  ).trim()
  const lazadaMemberId = normalizeLazadaMemberIdClient(String(video.lazadaMemberId || video.lazada_member_id || ''))
  const lazadaReady = !!lazadaCurrentLink && !!lazadaMemberId && isLikelyConvertedLazadaLink(lazadaCurrentLink) && (!expectedLazadaMemberId || lazadaMemberId === expectedLazadaMemberId)

  const missingShopeeSource = hasPlayable && !hasShopeeSource
  const galleryReady = hasPlayable && hasShopeeSource && hasManagedShopeeConversion && shopeeReady && hasLazadaSource && hasManagedLazadaConversion && lazadaReady
  const missingLazadaSource = hasPlayable && !hasLazadaSource

  return {
    hasPlayable,
    hasShopeeSource,
    hasManagedShopeeConversion,
    shopeeReady,
    hasLazadaSource,
    hasManagedLazadaConversion,
    lazadaMemberId,
    lazadaReady,
    missingShopeeSource,
    missingLazadaSource,
    awaitingConversion: hasPlayable && (missingShopeeSource || !galleryReady),
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
  const ts = new Date(String(video.updatedAt || video.createdAt || '')).getTime()
  return Number.isFinite(ts) ? ts : 0
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

const resolvePlayableVideoUrl = (video: Partial<Video> & Record<string, unknown>) => {
  const publicUrl = String(video.publicUrl || '').trim()
  const originalUrl = String(video.originalUrl || '').trim()
  return publicUrl || originalUrl || ''
}

const resolveFallbackVideoUrl = (video: Partial<Video> & Record<string, unknown>, currentUrl?: string) => {
  const publicUrl = String(video.publicUrl || '').trim()
  const originalUrl = String(video.originalUrl || '').trim()
  const current = String(currentUrl || '').trim()
  if (current && current === publicUrl && originalUrl && originalUrl !== publicUrl) return originalUrl
  if (current && current === originalUrl && publicUrl && publicUrl !== originalUrl) return publicUrl
  return ''
}

const getVideoIdentityKey = (video: Partial<Video> & Record<string, unknown>) => {
  const id = String(video.id || '').trim()
  const namespaceId = String(video.namespace_id || '').trim()
  return namespaceId ? `${namespaceId}:${id}` : id
}

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

// Icons
const DashboardIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M4 20V10M10 20V4M16 20v-7M22 20v-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const DashboardIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 10a1 1 0 011-1h1.5a1 1 0 011 1v10H4a1 1 0 01-1-1v-9zM9 4a1 1 0 011-1h1.5a1 1 0 011 1v16H9V4zM15 13a1 1 0 011-1h1.5a1 1 0 011 1v7H15v-7zM21 16a1 1 0 011-1h.5a1 1 0 011 1v4h-1.5a1 1 0 01-1-1v-3z" />
  </svg>
)
const InboxIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M4 5.5h16v10.5a2 2 0 01-2 2H6a2 2 0 01-2-2V5.5z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 14h4l2 3h4l2-3h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 8v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9.5 10.5L12 13l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const InboxIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v9.5a2.5 2.5 0 01-2.5 2.5h-2.36a1 1 0 00-.8.4L13.5 19a1 1 0 01-1.6 0l-1.84-2.45a1 1 0 00-.8-.4H6.5A2.5 2.5 0 014 13.5V5zm8 2.75a.75.75 0 00-.75.75v2.69l-.72-.72a.75.75 0 10-1.06 1.06l2 2a.75.75 0 001.06 0l2-2a.75.75 0 10-1.06-1.06l-.72.72V8.5a.75.75 0 00-.75-.75z" />
  </svg>
)
const VideoIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const VideoIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 6a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 14l5.293 2.646A1 1 0 0021 15.75V8.25a1 1 0 00-1.707-.896L14 10v4z" />
  </svg>
)
const ProcessIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
  </svg>
)
const ProcessIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M4.755 10.059a7.5 7.5 0 0112.548-3.364l1.903 1.903h-3.183a.75.75 0 100 1.5h4.992a.75.75 0 00.75-.75V4.356a.75.75 0 00-1.5 0v3.18l-1.9-1.9A9 9 0 003.306 9.67a.75.75 0 101.45.388zm15.408 3.352a.75.75 0 00-.919.53 7.5 7.5 0 01-12.548 3.364l-1.902-1.903h3.183a.75.75 0 000-1.5H2.984a.75.75 0 00-.75.75v4.992a.75.75 0 001.5 0v-3.18l1.9 1.9a9 9 0 0015.059-4.035.75.75 0 00-.53-.918z" clipRule="evenodd" />
  </svg>
)

const ListIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const ListIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M3 5.25a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H3.75A.75.75 0 013 5.25zm0 4.5A.75.75 0 013.75 9h16.5a.75.75 0 010 1.5H3.75A.75.75 0 013 9.75zm0 4.5a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75zm0 4.5a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
  </svg>
)
const SettingsIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const SettingsIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 00-.986.57c-.166.115-.334.126-.45.083L6.3 5.508a1.875 1.875 0 00-2.282.819l-.922 1.597a1.875 1.875 0 00.432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 000 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 00-.432 2.385l.922 1.597a1.875 1.875 0 002.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 002.28-.819l.923-1.597a1.875 1.875 0 00-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 000-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 00-2.282-.818l-1.02.382c-.114.043-.282.031-.449-.083a7.49 7.49 0 00-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 00-1.85-1.567h-1.843zM12 15.75a3.75 3.75 0 100-7.5 3.75 3.75 0 000 7.5z" clipRule="evenodd" />
  </svg>
)
const BackIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
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

function inferThumbnailUrl(url: string | undefined, fallback: string): string {
  const direct = String(url || '').trim()
  if (direct) return direct
  const source = String(fallback || '').trim()
  if (!source) return ''
  return source.replace(/(?:_original)?\.mp4(?:#.*)?$/i, '_thumb.webp')
}

// Grid thumbnails stay image-only. If a thumb is missing, show a lightweight placeholder.
function Thumb({ url, fallback }: { id: string; url?: string; fallback: string }) {
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

// Video card component
function VideoCard({
  video,
  currentNamespaceId,
  showWorkspaceBadge = false,
  formatDuration,
  onDelete,
  onUpdate,
  onExpandedChange,
  keepInPostedOnLinkSave = false
}: {
  video: Video
  currentNamespaceId?: string
  showWorkspaceBadge?: boolean
  formatDuration: (s: number) => string
  onDelete: (id: string, namespaceId?: string) => void
  onUpdate: (id: string, namespaceId: string | undefined, fields: Partial<Video>) => void
  onExpandedChange?: (expanded: boolean) => void
  keepInPostedOnLinkSave?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [deleting, setDeleting] = useState(false)
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
  }, [video.id, video.publicUrl, video.originalUrl])

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

  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
        <div className="relative w-[85%] max-w-sm">
          {/* Close button */}
          <button
            onClick={() => setExpanded(false)}
            className="mx-auto mb-3 w-11 h-11 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/* Editable Title */}
          <div className="mb-2">
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
                  className="flex-1 bg-white/10 text-white text-sm px-3 py-2 rounded-xl outline-none border border-white/20 focus:border-blue-400"
                  placeholder="ใส่แคปชั่น..."
                />
                <button
                  onClick={() => handleSaveTitle(localTitle)}
                  disabled={savingTitle}
                  className="shrink-0 bg-blue-500 text-white text-xs font-bold px-3 py-2 rounded-xl active:scale-95 transition-all disabled:opacity-50"
                >
                  {savingTitle ? '...' : 'OK'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setEditingTitle(true)}
                className="w-full text-left flex items-center gap-2 group"
              >
                <p className={`flex-1 text-sm ${localTitle ? 'text-white' : 'text-white/40'} line-clamp-2`}>
                  {localTitle || 'แตะเพื่อเพิ่มแคปชั่น...'}
                </p>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="shrink-0 opacity-40 group-active:opacity-80">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
          <div className="aspect-[3/4] rounded-2xl overflow-hidden">
            <video
              src={playbackUrl}
              className="w-full h-full object-cover"
              controls
              autoPlay
              playsInline
              onError={() => {
                const fallbackUrl = resolveFallbackVideoUrl(video as Video & Record<string, unknown>, playbackUrl)
                if (fallbackUrl && fallbackUrl !== playbackUrl) {
                  setPlaybackUrl(fallbackUrl)
                }
              }}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <div className="min-w-0 flex-1 rounded-xl bg-white/10 px-3 py-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">Video ID</p>
              <p className="truncate text-sm font-semibold text-white">{video.id}</p>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(video.id)}
              className="shrink-0 rounded-xl bg-white/15 p-3 active:scale-95 transition-transform"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {/* Category chips */}
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {fetchedCats.map(cat => (
              <button
                key={cat}
                onClick={() => toggleCategory(cat)}
                className={`px-2.5 py-1 rounded-full text-xs font-bold transition-all active:scale-95 ${localCats.includes(cat) ? 'bg-blue-500 text-white' : 'bg-white/30 text-white'}`}
              >
                #{cat}
              </button>
            ))}
          </div>
          {/* Shopee Link */}
          <p className="mt-3 mb-1 px-1 text-[11px] font-bold uppercase tracking-[0.18em] text-white/45">Shopee Link</p>
          {savingShopee ? (
            <div className="flex items-center justify-center gap-2 mt-3 bg-white/10 rounded-xl px-3 py-2.5">
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span className="text-white/60 text-sm">กำลังบันทึก...</span>
            </div>
          ) : localShopee ? (
            <div className="flex items-center gap-2 mt-3 bg-white/10 rounded-xl px-3 py-2.5">
              <span className="text-white text-sm truncate flex-1">{localShopee}</span>
              {/* แก้ไข */}
              <button
                onClick={() => { setShopeeInput(''); setLocalShopee('') }}
                className="shrink-0 bg-white/20 rounded-lg p-2 active:scale-90 transition-transform"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {/* เปิดลิงก์ */}
              <a
                href={localShopee}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 bg-white/20 rounded-lg p-2 active:scale-90 transition-transform"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M15 3h6v6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
              {/* คัดลอก */}
              <button
                onClick={() => navigator.clipboard.writeText(localShopee)}
                className="shrink-0 bg-white/20 rounded-lg p-2 active:scale-90 transition-transform"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {/* ลบลิ้ง Shopee */}
              <button
                onClick={handleDeleteShopeeLink}
                disabled={deletingShopeeLink}
                className="shrink-0 bg-white/20 rounded-lg p-2 active:scale-90 transition-transform disabled:opacity-60"
              >
                {deletingShopeeLink ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <path d="M3 6h18" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4h4v2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M10 11v6M14 11v6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-3">
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
                className="flex-1 bg-white/10 text-white text-sm px-3 py-2.5 rounded-xl outline-none min-h-[40px] break-all"
                style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
                inputMode="none"
              >
                {shopeeInput && <span className="text-white">{shopeeInput}</span>}
              </div>
              <button
                onClick={handleSaveShopee}
                disabled={!shopeeInput.trim()}
                className="shrink-0 bg-black text-white text-sm font-bold px-4 py-2.5 rounded-xl active:scale-95 transition-all disabled:opacity-50"
              >
                บันทึก
              </button>
            </div>
          )}
          <p className="mt-3 mb-1 px-1 text-[11px] font-bold uppercase tracking-[0.18em] text-white/45">Lazada Link</p>
          {savingLazada ? (
            <div className="flex items-center justify-center gap-2 mt-3 bg-white/10 rounded-xl px-3 py-2.5">
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span className="text-white/60 text-sm">กำลังบันทึก...</span>
            </div>
          ) : localLazada ? (
            <div className="flex items-center gap-2 mt-3 bg-white/10 rounded-xl px-3 py-2.5">
              <span className="text-white text-sm truncate flex-1">{localLazada}</span>
              <button
                onClick={() => { setLazadaInput(''); setLocalLazada('') }}
                className="shrink-0 bg-white/20 rounded-lg p-2 active:scale-90 transition-transform"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <a
                href={localLazada}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 bg-white/20 rounded-lg p-2 active:scale-90 transition-transform"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M15 3h6v6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
              <button
                onClick={() => navigator.clipboard.writeText(localLazada)}
                className="shrink-0 bg-white/20 rounded-lg p-2 active:scale-90 transition-transform"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onClick={handleDeleteLazadaLink}
                disabled={deletingLazadaLink}
                className="shrink-0 bg-white/20 rounded-lg p-2 active:scale-90 transition-transform disabled:opacity-60"
              >
                {deletingLazadaLink ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <path d="M3 6h18" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4h4v2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M10 11v6M14 11v6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-3">
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
                className="flex-1 bg-white/10 text-white text-sm px-3 py-2.5 rounded-xl outline-none min-h-[40px] break-all"
                style={{ WebkitUserSelect: 'text', userSelect: 'text' }}
                inputMode="none"
              >
                {lazadaInput && <span className="text-white">{lazadaInput}</span>}
              </div>
              <button
                onClick={handleSaveLazada}
                disabled={!lazadaInput.trim()}
                className="shrink-0 bg-black text-white text-sm font-bold px-4 py-2.5 rounded-xl active:scale-95 transition-all disabled:opacity-50"
              >
                บันทึก
              </button>
            </div>
          )}
          {/* Delete button */}
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="w-full mt-2 py-3 rounded-xl bg-red-500 text-white text-sm font-bold flex items-center justify-center gap-2 active:scale-95 transition-all"
          >
            {deleting ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
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
    )
  }

  return (
    <div
      className="relative aspect-[9/16] rounded-2xl overflow-hidden cursor-pointer bg-gray-100 shadow-sm active:scale-95 transition-transform duration-200"
      onClick={() => setExpanded(true)}
    >
      <Thumb id={video.id} url={video.thumbnailUrl} fallback={resolvePlayableVideoUrl(video as Video & Record<string, unknown>)} />
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
    </div>
  )
}

function GlobalOriginalVideoCard({ video, onExpandedChange }: { video: GlobalOriginalVideo; onExpandedChange?: (expanded: boolean) => void }) {
  const [expanded, setExpanded] = useState(false)
  const ownerLabel = String(video.owner_email || '').trim() || `namespace: ${video.namespace_id}`
  const createdAt = new Date(video.created_at)
  const createdLabel = Number.isNaN(createdAt.getTime())
    ? '-'
    : createdAt.toLocaleString('th-TH', { hour12: false })

  useEffect(() => {
    onExpandedChange?.(expanded)
    return () => onExpandedChange?.(false)
  }, [expanded, onExpandedChange])

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="relative aspect-[9/16] rounded-2xl overflow-hidden bg-gray-100 shadow-sm active:scale-95 transition-transform duration-200 text-left"
      >
        <video
          src={`${video.original_url}#t=0.1`}
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
            <button
              onClick={() => setExpanded(false)}
              className="mx-auto mb-3 w-11 h-11 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <div className="aspect-[9/16] rounded-2xl overflow-hidden bg-black">
              <video
                src={video.original_url}
                className="w-full h-full object-cover"
                controls
                autoPlay
                playsInline
              />
            </div>

            <div className="mt-3 rounded-xl bg-white/12 text-white px-3 py-2.5 space-y-1.5">
              <p className="text-sm font-semibold truncate">{ownerLabel}</p>
              <p className="text-xs text-white/80 truncate">{video.namespace_id}</p>
              <p className="text-xs text-white/80 truncate">{createdLabel}</p>
            </div>

            <a
              href={video.original_url}
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
  // Parse post_hours: supports "2:31,9:47" (new) and "2,9" (legacy) formats
  const parsePostHours = (raw: string): Record<number, number> => {
    const result: Record<number, number> = {}
    if (!raw) return result
    if (/^every:\d+$/i.test(raw.trim())) return result
    for (const part of raw.split(',')) {
      if (part.includes(':')) {
        const [h, m] = part.split(':').map(Number)
        if (h >= 1 && h <= 24) result[h] = m
      } else {
        const h = Number(part)
        if (h >= 1 && h <= 24) result[h] = Math.floor(Math.random() * 59) + 1
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
  const [accessToken, setAccessToken] = useState(page.access_token || '')
  const [saving, setSaving] = useState(false)
  const [forcingPost, setForcingPost] = useState(false)
  const [editingToken, setEditingToken] = useState<'access' | null>(null)
  const [editingTokenValue, setEditingTokenValue] = useState('')

  // Hours 1-24 for display
  const hourOptions = Array.from({ length: 24 }, (_, i) => i + 1)

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
      newMap[hour] = Math.floor(Math.random() * 59) + 1
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
      {/* Back button */}
      <div className="flex items-center mb-4">
        <button onClick={onBack} className="p-1 text-gray-400">
          <BackIcon />
        </button>
      </div>
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
      <div className="pb-2 flex gap-3">
        <button
          onClick={onBack}
          className="py-4 px-5 rounded-2xl font-bold text-base border border-gray-200 text-gray-600 active:scale-95 transition-all"
        >
          <BackIcon />
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className={`flex-1 py-4 rounded-2xl font-bold text-base transition-all ${saving ? 'bg-gray-400 text-white' : 'bg-blue-600 text-white active:scale-95'
            }`}
        >
          {saving ? 'กำลังบันทึก...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function InboxCard({
  video,
  onStart,
  onDelete,
  starting,
  deleting,
  onExpandedChange,
}: {
  video: InboxVideo
  onStart: (id: string) => void
  onDelete: (id: string) => void
  starting: boolean
  deleting: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const processingStatus = String(video.processingStatus || 'idle').trim().toLowerCase()
  const processingActive = video.processingActive === true || processingStatus === 'queued' || processingStatus === 'processing'
  const archiveState = String(video.archiveState || 'original').trim().toLowerCase()
  const processedArchive = archiveState === 'processed'
  const canStartProcessing = video.canStartProcessing !== false && !processedArchive
  const canDelete = video.canDelete !== false
  const ready = video.readyToProcess === true || video.status === 'ready'
  const missingLinks = [
    video.hasShopeeLink ? null : 'Shopee',
    video.hasLazadaLink ? null : 'Lazada',
  ].filter(Boolean).join(' / ')
  const sourceLabel = String(video.sourceLabel || (video.sourceType === 'xhs_url' ? 'Xiaohongshu link' : 'Telegram video')).trim()
  const previewUrl = String(video.previewUrl || (video.sourceType === 'telegram_video' ? video.videoUrl || '' : '')).trim()
  const createdAtLabel = new Date(video.createdAt).toLocaleString('th-TH', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const statusBadge = processingStatus === 'processing'
    ? { label: 'กำลังทำ', cls: 'bg-violet-500/95 text-white' }
    : processingStatus === 'queued'
      ? { label: 'อยู่ในคิว', cls: 'bg-sky-500/95 text-white' }
      : processedArchive
        ? { label: 'ทำเสร็จแล้ว', cls: 'bg-emerald-500/95 text-white' }
      : ready
        ? { label: 'พร้อมทำ', cls: 'bg-blue-500/95 text-white' }
        : { label: 'รอลิงก์', cls: 'bg-amber-400/95 text-slate-950' }
  const detailStatusBadge = processingStatus === 'processing'
    ? { label: 'กำลังประมวลผล', cls: 'bg-violet-500 text-white' }
    : processingStatus === 'queued'
      ? { label: 'รอคิวประมวลผล', cls: 'bg-sky-500 text-white' }
      : processedArchive
        ? { label: 'ประมวลผลเสร็จแล้ว', cls: 'bg-emerald-500 text-white' }
      : ready
        ? { label: 'พร้อมประมวลผล', cls: 'bg-blue-500 text-white' }
        : { label: `รอลิงก์ ${missingLinks || ''}`.trim(), cls: 'bg-amber-400 text-slate-950' }
  const actionLabel = processingStatus === 'processing'
    ? 'อยู่ใน Processing'
    : processingStatus === 'queued'
      ? 'อยู่ในคิว Processing'
      : processedArchive
        ? 'อยู่ใน Gallery แล้ว'
      : ready
        ? 'ส่งเข้า Processing'
        : 'รอลิงก์ให้ครบก่อน'

  useEffect(() => {
    onExpandedChange?.(expanded)
    return () => onExpandedChange?.(false)
  }, [expanded, onExpandedChange])

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="relative aspect-[9/16] rounded-2xl overflow-hidden bg-gray-100 shadow-sm active:scale-95 transition-transform duration-200 text-left"
      >
        {previewUrl ? (
          <Thumb id={video.id} fallback={previewUrl} />
        ) : (
          <div className={`w-full h-full flex flex-col items-center justify-center ${video.sourceType === 'xhs_url' ? 'bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300' : 'bg-gradient-to-br from-slate-700 to-slate-900'}`}>
            <div className="rounded-full bg-white/18 px-3 py-2 text-[10px] font-extrabold uppercase tracking-[0.22em] text-white">
              {video.sourceType === 'xhs_url' ? 'XHS' : 'ต้นฉบับ'}
            </div>
            <p className="mt-3 px-4 text-center text-xs font-semibold text-white/90 line-clamp-3">
              {video.sourceType === 'xhs_url' ? 'Xiaohongshu Link' : 'Telegram Video'}
            </p>
          </div>
        )}

        <div className="absolute left-2 top-2">
          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold shadow-lg backdrop-blur-sm ${statusBadge.cls}`}>
            {statusBadge.label}
          </span>
        </div>

        <div className="absolute right-2 top-2 flex items-center gap-1">
          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold shadow-lg backdrop-blur-sm ${video.hasShopeeLink ? 'bg-emerald-500/95 text-white' : 'bg-black/55 text-white'}`}>
            S
          </span>
          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold shadow-lg backdrop-blur-sm ${video.hasLazadaLink ? 'bg-sky-500/95 text-white' : 'bg-black/55 text-white'}`}>
            L
          </span>
        </div>

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pb-3 pt-8 text-white">
          <p className="truncate text-[11px] font-extrabold">{video.id}</p>
          <p className="mt-0.5 truncate text-[10px] text-white/75">{createdAtLabel}</p>
        </div>
      </button>

      {expanded && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
          <div className="relative w-[88%] max-w-sm">
            <button
              onClick={() => setExpanded(false)}
              className="mx-auto mb-3 w-11 h-11 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <div className="aspect-[9/16] rounded-2xl overflow-hidden bg-black">
              {previewUrl ? (
                <video
                  src={previewUrl}
                  className="w-full h-full object-cover"
                  controls
                  autoPlay
                  playsInline
                />
              ) : (
                <div className={`w-full h-full flex flex-col items-center justify-center ${video.sourceType === 'xhs_url' ? 'bg-gradient-to-br from-rose-500 via-orange-400 to-amber-300' : 'bg-gradient-to-br from-slate-700 to-slate-900'}`}>
                  <div className="rounded-full bg-white/18 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.22em] text-white">
                    {video.sourceType === 'xhs_url' ? 'XHS' : 'ต้นฉบับ'}
                  </div>
                  <p className="mt-3 px-6 text-center text-sm font-semibold text-white/90 break-all line-clamp-4">
                    {sourceLabel}
                  </p>
                </div>
              )}
            </div>

            <div className="mt-3 rounded-xl bg-white/12 text-white px-3 py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${detailStatusBadge.cls}`}>
                  {detailStatusBadge.label}
                </span>
                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${video.hasShopeeLink ? 'bg-emerald-500 text-white' : 'bg-white/15 text-white/70'}`}>
                  Shopee
                </span>
                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${video.hasLazadaLink ? 'bg-sky-500 text-white' : 'bg-white/15 text-white/70'}`}>
                  Lazada
                </span>
              </div>
              <p className="text-sm font-semibold truncate">ID: {video.id}</p>
              <p className="text-xs text-white/75">{createdAtLabel}</p>
              <p className="text-xs text-white/85 break-all line-clamp-3">{sourceLabel}</p>
              {(video.shopeeLink || video.lazadaLink) && (
                <div className="space-y-1 pt-1 text-[11px] text-white/70">
                  {video.shopeeLink && <p className="truncate">Shopee: {video.shopeeLink}</p>}
                  {video.lazadaLink && <p className="truncate">Lazada: {video.lazadaLink}</p>}
                </div>
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => onDelete(video.id)}
                disabled={deleting || starting || !canDelete}
                className="flex-1 rounded-xl border border-white/20 bg-white/10 py-3 text-sm font-bold text-white active:scale-95 transition-transform disabled:opacity-40"
              >
                {canDelete ? (deleting ? 'กำลังลบ...' : 'ลบ') : 'เก็บถาวร'}
              </button>
              <button
                onClick={() => onStart(video.id)}
                disabled={!ready || starting || deleting || processingActive || !canStartProcessing}
                className={`flex-[1.35] rounded-xl py-3 text-sm font-bold transition-transform ${ready && !starting && !deleting && !processingActive && canStartProcessing ? 'bg-blue-500 text-white active:scale-95' : 'bg-white/15 text-white/45'}`}
              >
                {starting ? 'กำลังส่งเข้า Processing...' : actionLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function ProcessingCard({
  video,
  onCancel,
  onReprocess,
  retrying,
}: {
  video: any,
  onCancel: (id: string, isQueued: boolean) => void,
  onReprocess: (id: string) => void,
  retrying: boolean,
}) {
  const displayProgress = video.status === 'queued' ? 0 : Math.max(5, Math.min(100, Math.floor(((video.step || 0) / 5) * 100)));

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(video.createdAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [video.createdAt]);
  const fmtElapsed = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm relative flex flex-col gap-3">
      {/* Top Row: ID + Cancel form */}
      <div className="flex justify-between items-start">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${video.status === 'failed' ? 'bg-red-50 text-red-500' : video.status === 'queued' ? 'bg-amber-50 text-amber-500' : 'bg-blue-50 text-blue-500'}`}>
            {video.status === 'failed' ? '❌' : video.status === 'queued' ? '⏳' : (
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent animate-spin rounded-full" />
            )}
          </div>
          <div className="flex flex-col">
            <p className="font-extrabold text-gray-900 text-sm">ID: {video.id}</p>
            <p className="text-[10px] text-gray-400 font-medium">เริ่มเมื่อ {new Date(video.createdAt).toLocaleTimeString('th-TH')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {video.status === 'failed' && (
            <button
              onClick={() => onReprocess(video.id)}
              disabled={retrying}
              title="ประมวลผลใหม่"
              className="p-2 rounded-full bg-blue-50 text-blue-500 hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {retrying ? (
                <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent animate-spin rounded-full" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2v6h-6" />
                  <path d="M3 11a9 9 0 0 1 15-6.7L21 8" />
                  <path d="M3 22v-6h6" />
                  <path d="M21 13a9 9 0 0 1-15 6.7L3 16" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={() => onCancel(video.id, video.status === 'queued')}
            title={video.status === 'failed' ? 'ลบประวัติ' : 'ยกเลิก'}
            className={`p-2 rounded-full transition-colors ${video.status === 'failed' ? 'bg-red-50 text-red-500 hover:bg-red-100' : 'bg-gray-50 text-gray-400 hover:bg-red-50 hover:text-red-500'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {/* Middle Row: Status Text + Link + % */}
      <div className="flex justify-between items-end mt-1">
        <div className="flex flex-col gap-1.5 flex-1 pr-4 min-w-0">
          <div className="flex items-center gap-1.5">
            {video.status === 'failed' ? (
              <span className="text-xs bg-red-50 text-red-600 px-2 py-0.5 rounded-md font-bold shrink-0 truncate">{video.error || 'ล้มเหลว'}</span>
            ) : video.status === 'queued' ? (
              <span className="text-xs bg-amber-50 text-amber-600 px-2 py-0.5 rounded-md font-bold shrink-0">กำลังรอคิว...</span>
            ) : (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-md font-bold shrink-0 truncate break-all line-clamp-1">{video.stepName || 'กำลังประมวลผล...'}</span>
                <span className="text-xs font-mono font-bold text-gray-400 shrink-0">{fmtElapsed}</span>
              </div>
            )}
          </div>
          <p className="text-[10px] text-gray-500 flex items-center gap-1.5 truncate">
            <span className="w-4 h-4 rounded-full bg-gray-50 flex items-center justify-center shrink-0"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
            <span className="truncate">{video.shopeeLink || 'ไม่มีลิงก์ Shopee'}</span>
          </p>
        </div>

        {video.status !== 'failed' && (
          <div className="text-right shrink-0">
            <span className="text-lg font-black text-blue-600">{video.status === 'queued' ? '0' : displayProgress}%</span>
          </div>
        )}
      </div>

      {/* Bottom Row: Progress Bar */}
      {video.status !== 'failed' && (
        <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden relative">
          <div
            className={`h-2.5 rounded-full transition-all duration-300 ease-linear ${video.status === 'queued' ? 'bg-amber-400' : 'bg-gradient-to-r from-blue-500 to-indigo-500'}`}
            style={{ width: `${Math.max(2, displayProgress)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const tg = (window as any).Telegram?.WebApp
  const tgUser = tg?.initDataUnsafe?.user
  const botScope = getBotScopeFromLocation()
  const prefersTelegramAutoAuth = Boolean(tgUser && botScope)

  const handleSubmit = async () => {
    if (!email.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${WORKER_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          tg_id: tgUser?.id,
          bot_id: botScope || undefined,
        })
      })
      const data = await res.json() as any
      if (!res.ok) {
        setError(data.error || 'เข้าสู่ระบบไม่สำเร็จ')
        return
      }
      onLogin(data.session_token)
    } catch {
      setError('ไม่สามารถเชื่อมต่อได้')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="flex flex-col bg-white font-['Sukhumvit_Set','Kanit',sans-serif]"
      style={{ height: '100dvh' }}
    >
      {/* Hero — flex-1 ย่อลงเมื่อคีย์บอร์ดขึ้น */}
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-8 gap-4">
        {/* Logo */}
        <div className="relative">
          <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-[28px] flex items-center justify-center shadow-2xl shadow-blue-300/50">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 10l4.553-2.069A1 1 0 0121 8.87V15.13a1 1 0 01-1.447.9L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
          </div>
          {/* Glow */}
          <div className="absolute inset-0 rounded-[28px] bg-gradient-to-br from-blue-400 to-indigo-500 blur-xl opacity-30 -z-10 scale-110" />
        </div>

        {/* Title */}
        <div className="text-center">
          <h1 className="text-3xl font-black text-gray-900 tracking-tight">เฉียบ AI</h1>
          <p className="text-sm text-gray-400 mt-1.5 font-medium">ระบบสร้างคอนเทนต์ด้วย AI</p>
        </div>

        {/* Telegram greeting chip */}
        {tgUser && (
          <div className="flex items-center gap-2.5 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 px-4 py-2 rounded-full">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white text-xs font-black shadow-sm">
              {tgUser.first_name.charAt(0).toUpperCase()}
            </div>
            <span className="text-sm text-blue-600 font-semibold">สวัสดี {tgUser.first_name}</span>
            <span className="text-base">👋</span>
          </div>
        )}
      </div>

      {/* Bottom — input + button อยู่เหนือคีย์บอร์ดเสมอ */}
      <div className="px-6 pb-8 space-y-3">
        {prefersTelegramAutoAuth ? (
          <>
            <div className="rounded-3xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 px-5 py-5 text-center">
              <p className="text-sm font-semibold text-gray-800">Workspace นี้เข้าใช้งานผ่าน Telegram อัตโนมัติ</p>
              <p className="mt-2 text-sm text-gray-500">ถ้ายังไม่เข้า ให้กลับไปที่แชตแล้วกดปุ่มเปิด Workspace ใหม่อีกครั้ง</p>
            </div>

            <button
              onClick={() => window.location.reload()}
              className="w-full py-4 rounded-2xl font-bold text-base text-white active:scale-[0.97] transition-all relative overflow-hidden"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', boxShadow: '0 8px 24px rgba(99,102,241,0.35)' }}
            >
              ลองเชื่อมต่อใหม่
            </button>
          </>
        ) : (
          <>
            <div className="relative">
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError('') }}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                placeholder="your@email.com"
                autoComplete="email"
                inputMode="email"
                className="w-full bg-gray-50 border-2 border-gray-100 focus:border-blue-500 focus:bg-white rounded-2xl px-5 py-4 text-base outline-none transition-all text-center font-medium placeholder:text-gray-300"
              />
              {email.trim() && (
                <button
                  onClick={() => { setEmail(''); setError('') }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              )}
            </div>

            {error && (
              <div className="flex items-center justify-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
                <p className="text-sm text-red-500 font-medium">{error}</p>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={!email.trim() || loading}
              className="w-full py-4 rounded-2xl font-bold text-base text-white active:scale-[0.97] transition-all disabled:opacity-40 relative overflow-hidden"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', boxShadow: '0 8px 24px rgba(99,102,241,0.35)' }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" /></svg>
                  กำลังเข้าสู่ระบบ...
                </span>
              ) : 'เข้าสู่ระบบ'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

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

function App() {
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

  const applySessionToken = (value: string) => {
    const session = normalizeSessionToken(value)
    if (!session) return
    localStorage.setItem(scopedStorageKey('auth_token', botScope), session)
    setTokenState(session)
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
    setIsOwner(false)
    setTeamMembers([])
    setVoicePrompt('')
    setVoicePromptDraft('')
    setVoicePromptSource('default')
    setVoicePromptUpdatedAt('')
    setVoicePromptMessage('')
    setVoicePromptLoading(false)
    setVoicePromptSaving(false)
    setVoicePromptMaxChars(12000)
    setCommentTemplate(DEFAULT_COMMENT_TEMPLATE)
    setCommentTemplateDraft(DEFAULT_COMMENT_TEMPLATE)
    setCommentTemplateSource('default')
    setCommentTemplateUpdatedAt('')
    setCommentTemplateMessage('')
    setCommentTemplateLoading(false)
    setCommentTemplateSaving(false)
    setCommentTemplateMaxChars(4000)
    setGeminiApiKeyDraft('')
    setGeminiApiKeyMasked('')
    setGeminiApiKeySource('none')
    setGeminiApiKeyUpdatedAt('')
    setGeminiApiKeyMessage('')
    setGeminiApiKeyLoading(false)
    setGeminiApiKeySaving(false)
    setGeminiApiKeyMaxChars(512)
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
    setSystemGalleryStats({ total: 0, withLink: 0, withoutLink: 0, shopeeTotal: 0, lazadaTotal: 0 })
    setSystemGalleryHasMore(false)
    setGalleryLoadingMore(false)
    setGalleryVisibleCount(GALLERY_BATCH_SIZE)
    setGlobalOriginalVideos([])
    setGlobalOriginalLoading(false)
    setPostHistory([])
    setLoading(true)
    setGalleryLoading(true)
  }

  const handleLogin = (t: string) => {
    applySessionToken(t)
    setAuthBootstrapping(false)
    loadTeam()
    loadAll()
  };

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

  const [isOwner, setIsOwner] = useState(false)
  const [meEmail, setMeEmail] = useState('')
  const [teamMembers, setTeamMembers] = useState<{ email: string; created_at: string }[]>([])
  const [newMemberEmail, setNewMemberEmail] = useState('')
  const [voicePrompt, setVoicePrompt] = useState('')
  const [voicePromptDraft, setVoicePromptDraft] = useState('')
  const [voicePromptSource, setVoicePromptSource] = useState<'default' | 'custom'>('default')
  const [voicePromptUpdatedAt, setVoicePromptUpdatedAt] = useState('')
  const [voicePromptMessage, setVoicePromptMessage] = useState('')
  const [voicePromptLoading, setVoicePromptLoading] = useState(false)
  const [voicePromptSaving, setVoicePromptSaving] = useState(false)
  const [voicePromptMaxChars, setVoicePromptMaxChars] = useState(12000)
  const [commentTemplate, setCommentTemplate] = useState(DEFAULT_COMMENT_TEMPLATE)
  const [commentTemplateDraft, setCommentTemplateDraft] = useState(DEFAULT_COMMENT_TEMPLATE)
  const [commentTemplateSource, setCommentTemplateSource] = useState<'default' | 'custom'>('default')
  const [commentTemplateUpdatedAt, setCommentTemplateUpdatedAt] = useState('')
  const [commentTemplateMessage, setCommentTemplateMessage] = useState('')
  const [commentTemplateLoading, setCommentTemplateLoading] = useState(false)
  const [commentTemplateSaving, setCommentTemplateSaving] = useState(false)
  const [commentTemplateMaxChars, setCommentTemplateMaxChars] = useState(4000)
  const [geminiApiKeyDraft, setGeminiApiKeyDraft] = useState('')
  const [geminiApiKeyMasked, setGeminiApiKeyMasked] = useState('')
  const [geminiApiKeySource, setGeminiApiKeySource] = useState<GeminiKeySource>('none')
  const [geminiApiKeyUpdatedAt, setGeminiApiKeyUpdatedAt] = useState('')
  const [geminiApiKeyMessage, setGeminiApiKeyMessage] = useState('')
  const [geminiApiKeyLoading, setGeminiApiKeyLoading] = useState(false)
  const [geminiApiKeySaving, setGeminiApiKeySaving] = useState(false)
  const [geminiApiKeyMaxChars, setGeminiApiKeyMaxChars] = useState(512)
  const [shortlinkAccountDraft, setShortlinkAccountDraft] = useState(() => getStoredShortlinkAccount(botScope))
  const [shortlinkAccountCurrent, setShortlinkAccountCurrent] = useState(() => getStoredShortlinkAccount(botScope))
  const [shortlinkBaseUrlCurrent, setShortlinkBaseUrlCurrent] = useState(() => getStoredShortlinkBaseUrl(botScope))
  const [lazadaShortlinkBaseUrlCurrent, setLazadaShortlinkBaseUrlCurrent] = useState(() => getStoredLazadaShortlinkBaseUrl(botScope))
  const [shortlinkExpectedUtmIdDraft, setShortlinkExpectedUtmIdDraft] = useState(() => getStoredShortlinkExpectedUtmId(botScope))
  const [shortlinkExpectedUtmIdCurrent, setShortlinkExpectedUtmIdCurrent] = useState(() => getStoredShortlinkExpectedUtmId(botScope))
  const [lazadaExpectedMemberIdDraft, setLazadaExpectedMemberIdDraft] = useState(() => getStoredLazadaExpectedMemberId(botScope))
  const [lazadaExpectedMemberIdCurrent, setLazadaExpectedMemberIdCurrent] = useState(() => getStoredLazadaExpectedMemberId(botScope))
  const [shortlinkEnabled, setShortlinkEnabled] = useState(() => hasStoredAffiliateShortlinkConfig(botScope))
  const [shortlinkUpdatedAt, setShortlinkUpdatedAt] = useState('')
  const [shortlinkMessage, setShortlinkMessage] = useState('')
  const [shortlinkLoading, setShortlinkLoading] = useState(false)
  const [shortlinkSaving, setShortlinkSaving] = useState(false)
  const [shortlinkAccountMaxChars, setShortlinkAccountMaxChars] = useState(64)
  const [shortlinkExpectedUtmIdMaxChars, setShortlinkExpectedUtmIdMaxChars] = useState(32)
  const [lazadaExpectedMemberIdMaxChars, setLazadaExpectedMemberIdMaxChars] = useState(32)
  const [logoutLoading, setLogoutLoading] = useState(false)
  const getInitialSettingsSection = (): SettingsSection => {
    const pathTab = window.location.pathname.replace('/', '')
    const params = new URLSearchParams(window.location.search)
    const tabParam = params.get('tab')
    if (pathTab === 'pages' || tabParam === 'pages') return 'pages'
    return 'menu'
  }
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(getInitialSettingsSection)
  const [namespaceId, setNamespaceId] = useState<string>(() => getStoredNamespace(botScope))
  const [postHistory, setPostHistory] = useState<PostHistory[]>(() => {
    const ns = getStoredNamespace()
    if (ns) return readCache<PostHistory[]>(nsCacheKey('history', ns), [])
    return []
  })
  const [deletingLogId, setDeletingLogId] = useState<number | null>(null)
  const [retryingLogId, setRetryingLogId] = useState<number | null>(null)
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null)
  const [videos, setVideos] = useState<Video[]>(() => {
    return readGalleryCacheForScope(botScope, getStoredNamespace(botScope), hasStoredAffiliateShortlinkConfig(botScope))
  })
  const [usedVideos, setUsedVideos] = useState<Video[]>(() => {
    const ns = getStoredNamespace()
    if (ns) return readCache<Video[]>(nsCacheKey('used', ns), [])
    return readCache<Video[]>(globalCacheKey('used'), [])
  })
  const [globalOriginalVideos, setGlobalOriginalVideos] = useState<GlobalOriginalVideo[]>([])
  const [globalOriginalLoading, setGlobalOriginalLoading] = useState(false)
  const [processingVideos, setProcessingVideos] = useState<Video[]>([])
  const [pendingShortlinkVideos, setPendingShortlinkVideos] = useState<Video[]>([])
  const [retryingProcessingId, setRetryingProcessingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => {
    if (FORCE_SYSTEM_WIDE_GALLERY || hasStoredAffiliateShortlinkConfig(botScope)) {
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
    return readGalleryCacheForScope(botScope, getStoredNamespace(botScope), hasStoredAffiliateShortlinkConfig(botScope)).length === 0
  })
  const [systemGalleryStats, setSystemGalleryStats] = useState<SystemGalleryStats>({ total: 0, withLink: 0, withoutLink: 0, shopeeTotal: 0, lazadaTotal: 0 })
  const [, setSystemGalleryOverallTotal] = useState(0)
  const [systemGalleryHasMore, setSystemGalleryHasMore] = useState(false)
  const [galleryLoadingMore, setGalleryLoadingMore] = useState(false)
  // Get today's date in YYYY-MM-DD format for Thailand timezone
  const getTodayString = () => {
    const now = new Date()
    const thaiTime = new Date(now.getTime() + 7 * 60 * 60 * 1000)
    return thaiTime.toISOString().split('T')[0]
  }


  const [categoryFilter, setCategoryFilter] = useState<GalleryFilter>('unused')
  const [gallerySearchInput, setGallerySearchInput] = useState(getInitialGallerySearchInput)
  const [dashboardDateFilter, setDashboardDateFilter] = useState<string>(getTodayString())
  const [dashboardLoading, setDashboardLoading] = useState(false)
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null)
  const [logDateFilter, setLogDateFilter] = useState<string>(getTodayString())
  const [logNowMs, setLogNowMs] = useState(() => Date.now())
  const [visibleLogCount, setVisibleLogCount] = useState(0)
  // Read initial tab from URL path or query param
  type TabName = 'dashboard' | 'inbox' | 'processing' | 'gallery' | 'logs' | 'settings'
  const getInitialTab = (): TabName => {
    const validTabs: TabName[] = ['dashboard', 'inbox', 'processing', 'gallery', 'logs', 'settings']
    const pathTab = window.location.pathname.replace('/', '')
    if (pathTab === 'pages') return 'settings'
    if (validTabs.includes(pathTab as TabName)) return pathTab as TabName
    const params = new URLSearchParams(window.location.search)
    const tabParam = params.get('tab')
    if (tabParam === 'pages') return 'settings'
    if (tabParam && validTabs.includes(tabParam as TabName)) return tabParam as TabName
    return 'dashboard'
  }

  const [tab, _setTab] = useState<TabName>(getInitialTab())
  const syncAppUrl = (
    nextTab: TabName,
    nextSearchInput: string,
    historyMode: 'push' | 'replace' = 'replace',
  ) => {
    const url = new URL(window.location.href)
    url.pathname = `/${nextTab}`
    if (nextTab === 'gallery') {
      const trimmedSearch = String(nextSearchInput || '').trim()
      if (trimmedSearch) url.searchParams.set('q', trimmedSearch)
      else url.searchParams.delete('q')
    } else {
      url.searchParams.delete('q')
    }
    const nextUrl = url.toString()
    if (nextUrl !== window.location.href) {
      if (historyMode === 'push') {
        window.history.pushState(null, '', nextUrl)
      } else {
        window.history.replaceState(null, '', nextUrl)
      }
    }
  }
  const setTab = (t: TabName) => {
    _setTab(t)
    syncAppUrl(t, gallerySearchInput, 'push')
  }
  const [pages, setPages] = useState<FacebookPage[]>([])
  const [inboxVideos, setInboxVideos] = useState<InboxVideo[]>([])
  const [selectedPage, setSelectedPage] = useState<FacebookPage | null>(null)
  const [showAddPagePopup, setShowAddPagePopup] = useState(false)
  const [inboxLoading, setInboxLoading] = useState(false)
  const [pagesLoading, setPagesLoading] = useState(false)
  const [deletePageId, setDeletePageId] = useState<string | null>(null)
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null)
  const [startingInboxId, setStartingInboxId] = useState<string | null>(null)
  const [deletingInboxId, setDeletingInboxId] = useState<string | null>(null)
  const [videoViewerOpen, setVideoViewerOpen] = useState(false)
  const [galleryVisibleCount, setGalleryVisibleCount] = useState(GALLERY_BATCH_SIZE)
  const loadAllInFlightRef = useRef(false)
  const loadAllPendingRef = useRef(false)
  const processingFetchInFlightRef = useRef(false)
  const inboxFetchInFlightRef = useRef(false)
  const usedFetchInFlightRef = useRef(false)
  const globalOriginalFetchInFlightRef = useRef(false)
  const loadPagesRequestRef = useRef(0)
  const loadTeamRequestRef = useRef(0)
  const lastUsedFetchAtRef = useRef(0)
  const lastGlobalOriginalFetchAtRef = useRef(0)
  const systemWideGalleryMode = FORCE_SYSTEM_WIDE_GALLERY
  const systemWideGalleryModeRef = useRef(systemWideGalleryMode)
  const mainScrollRef = useRef<HTMLDivElement | null>(null)
  const galleryLoadMoreRef = useRef<HTMLDivElement | null>(null)
  const systemGalleryRequestRef = useRef(0)
  const systemGalleryLoadedCountRef = useRef(videos.length)
  const deferredGallerySearchInput = useDeferredValue(gallerySearchInput)
  const gallerySearchQuery = useMemo(
    () => normalizeGallerySearchQuery(deferredGallerySearchInput),
    [deferredGallerySearchInput]
  )

  useEffect(() => {
    systemWideGalleryModeRef.current = systemWideGalleryMode
  }, [systemWideGalleryMode])
  useEffect(() => {
    systemGalleryLoadedCountRef.current = videos.length
  }, [videos.length])
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
    syncAppUrl(tab, gallerySearchInput)
  }, [tab, gallerySearchInput])

  const tg = window.Telegram?.WebApp
  const hydrateNamespaceCaches = (ns: string) => {
    const scopedNamespace = String(ns || '').trim()
    if (!scopedNamespace) return
    const cachedVideos = readGalleryCacheForScope(
      botScope,
      scopedNamespace,
      !!String(shortlinkAccountCurrent || shortlinkBaseUrlCurrent || lazadaShortlinkBaseUrlCurrent || getStoredShortlinkAccount(botScope) || getStoredShortlinkBaseUrl(botScope) || getStoredLazadaShortlinkBaseUrl(botScope) || '').trim()
    )
    const cachedUsedVideos = readCache<Video[]>(nsCacheKey('used', scopedNamespace), [])
    const cachedHistory = readCache<PostHistory[]>(nsCacheKey('history', scopedNamespace), [])
    setVideos(cachedVideos)
    setUsedVideos(cachedUsedVideos)
    setPostHistory(cachedHistory)
    setGalleryLoading(cachedVideos.length === 0)
    if (cachedVideos.length > 0 || cachedUsedVideos.length > 0 || cachedHistory.length > 0) {
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
      try { localStorage.removeItem(systemGalleryCacheKey(botScope)) } catch { }
      return
    }
    if (!namespaceId) return
    writeCache(nsCacheKey('gallery', namespaceId), videos)
  }, [botScope, namespaceId, systemWideGalleryMode, videos])

  useEffect(() => {
    if (!namespaceId) return
    writeCache(nsCacheKey('used', namespaceId), usedVideos)
  }, [namespaceId, usedVideos])

  useEffect(() => {
    if (!namespaceId) return
    writeCache(nsCacheKey('history', namespaceId), postHistory)
  }, [namespaceId, postHistory])

  useEffect(() => {
    if (tg) {
      tg.ready()
      tg.expand()
      try {
        tg.requestFullscreen()
        tg.disableVerticalSwipes()
        tg.setHeaderColor('#ffffff')
        tg.setBackgroundColor('#ffffff')
        tg.setBottomBarColor('#ffffff')
      } catch (e) {
        console.log('Setup error:', e)
      }
    }
  }, [tg])

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
    const storedShortlinkAccount = getStoredShortlinkAccount(botScope)
    const storedShortlinkBaseUrl = getStoredShortlinkBaseUrl(botScope)
    const storedLazadaShortlinkBaseUrl = getStoredLazadaShortlinkBaseUrl(botScope)
    const cachedVideos = readGalleryCacheForScope(botScope, storedNamespace, !!String(storedShortlinkAccount || storedShortlinkBaseUrl || storedLazadaShortlinkBaseUrl || '').trim())
    setNamespaceId(storedNamespace)
    setVideos(cachedVideos)
    setGalleryLoading(cachedVideos.length === 0)
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
    setInboxVideos([])
    setInboxLoading(true)
    setProcessingVideos([])
    setPendingShortlinkVideos([])
    setMeEmail('')
    setIsOwner(false)
    setTeamMembers([])
    setNewMemberEmail('')
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
      const tgId = tg?.initDataUnsafe?.user?.id
      const session = getToken(botScope)
      if (session) {
        try {
          const reboundSession = await bindTelegramSession(session, tgId, botScope)
          const meResp = await fetch(`${WORKER_URL}/api/me`, { headers: { 'x-auth-token': reboundSession } })
          if (meResp.ok) {
            const me = await meResp.json().catch(() => ({})) as any
            const ns = String(me?.namespace_id || '').trim()
            if (ns) {
              setNamespaceId(ns)
              hydrateNamespaceCaches(ns)
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
                if (ns) {
                  setNamespaceId(ns)
                  hydrateNamespaceCaches(ns)
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
    loadTeam()
    if (tab === 'settings' && settingsSection === 'pages') loadPages()
  }, [token, authBootstrapping, tab, systemWideGalleryMode])

  // Reload pages when opening Pages inside Settings
  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab === 'settings' && settingsSection === 'pages') loadPages()
  }, [tab, settingsSection, token, authBootstrapping])

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab === 'inbox') void loadInboxSnapshot()
  }, [tab, token, authBootstrapping])

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab !== 'inbox' && tab !== 'processing') return

    const refresh = () => {
      void loadInboxSnapshot()
      void loadProcessingSnapshot()
    }

    refresh()
    const timer = window.setInterval(refresh, 15000)
    return () => window.clearInterval(timer)
  }, [tab, token, authBootstrapping])

  useEffect(() => {
    if (tab !== 'settings' && settingsSection !== 'menu') {
      setSettingsSection('menu')
    }
  }, [tab, settingsSection])

  useEffect(() => {
    if (!isOwner && (settingsSection === 'team' || settingsSection === 'gemini' || settingsSection === 'shortlink' || settingsSection === 'voice' || settingsSection === 'comment')) {
      setSettingsSection('menu')
    }
  }, [isOwner, settingsSection])

  useEffect(() => {
    if (authBootstrapping || !token) return
    void loadShortlinkSettings()
    if (!isOwner) return
    void loadVoicePrompt()
    void loadCommentTemplate()
    void loadGeminiApiKey()
  }, [token, authBootstrapping, isOwner])

  useEffect(() => {
    const cachedVideos = readGalleryCacheForScope(botScope, namespaceId, systemWideGalleryMode)
    setVideos(cachedVideos)
    setGalleryLoading(cachedVideos.length === 0)
    if (!systemWideGalleryMode) {
      setSystemGalleryStats({ total: 0, withLink: 0, withoutLink: 0, shopeeTotal: 0, lazadaTotal: 0 })
      setSystemGalleryHasMore(false)
      setGalleryLoadingMore(false)
    }
  }, [botScope, namespaceId, systemWideGalleryMode])

  useEffect(() => {
    if (tab !== 'gallery' || isOwner && categoryFilter === 'all-original') return
    setGalleryVisibleCount(GALLERY_BATCH_SIZE)
  }, [tab, botScope, namespaceId, categoryFilter, systemWideGalleryMode, isOwner, gallerySearchQuery])

  useEffect(() => {
    if (authBootstrapping || !token || tab !== 'dashboard') return
    void loadDashboard(dashboardDateFilter)
    const timer = setInterval(() => {
      void loadDashboard(dashboardDateFilter, { silent: true })
    }, 30000)
    return () => clearInterval(timer)
  }, [tab, token, authBootstrapping, dashboardDateFilter])

  useEffect(() => {
    if (!isOwner && categoryFilter === 'all-original') {
      setCategoryFilter('unused')
    }
  }, [isOwner, categoryFilter])

  async function recoverSessionOrLogout() {
    clearSession()
    return false
  }

  async function loadProcessingSnapshot() {
    if (processingFetchInFlightRef.current) return
    const session = getToken()
    if (!session) return

    processingFetchInFlightRef.current = true
    try {
      const [processingResp, queueResp] = await Promise.all([
        apiFetch(`${WORKER_URL}/api/processing`),
        apiFetch(`${WORKER_URL}/api/queue`)
      ])

      if (processingResp.status === 401 || queueResp.status === 401) {
        await recoverSessionOrLogout()
        return
      }

      const procData = processingResp.ok ? await processingResp.json() : { videos: [], pending_shortlink_videos: [] }
      const queueData = queueResp.ok ? await queueResp.json() : { queue: [] }
      setProcessingVideos([...(procData.videos || []), ...(queueData.queue || [])])
      setPendingShortlinkVideos(dedupeGalleryVideos(Array.isArray(procData.pending_shortlink_videos) ? procData.pending_shortlink_videos : []))
    } catch {
      // Keep previous processing snapshot on transient errors.
    } finally {
      processingFetchInFlightRef.current = false
    }
  }

  async function loadInboxSnapshot() {
    if (inboxFetchInFlightRef.current) return
    const session = getToken()
    if (!session) return

    const shouldShowLoading = inboxVideos.length === 0
    if (shouldShowLoading) setInboxLoading(true)

    inboxFetchInFlightRef.current = true
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/inbox`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.ok) {
        const data = await resp.json() as { videos?: InboxVideo[] }
        setInboxVideos(Array.isArray(data.videos) ? data.videos : [])
      }
    } catch {
      // Keep previous inbox snapshot on transient errors.
    } finally {
      inboxFetchInFlightRef.current = false
      if (shouldShowLoading) setInboxLoading(false)
    }
  }

  async function loadUsedVideos(options: { force?: boolean } = {}) {
    const session = getToken()
    if (!session) return

    const now = Date.now()
    if (!options.force && usedFetchInFlightRef.current) return
    if (!options.force && now - lastUsedFetchAtRef.current < 30000) return

    usedFetchInFlightRef.current = true
    try {
      const usedResp = await apiFetch(`${WORKER_URL}/api/gallery/used`)
      if (usedResp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (usedResp.ok) {
        const data = await usedResp.json()
        setUsedVideos(data.videos || [])
        lastUsedFetchAtRef.current = Date.now()
      }
    } catch {
      // Keep previous used videos on transient errors.
    } finally {
      usedFetchInFlightRef.current = false
    }
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

  async function loadSystemGalleryPage(options: { reset?: boolean } = {}) {
    const session = getToken()
    if (!session) return

    const reset = !!options.reset
    const requestId = reset ? ++systemGalleryRequestRef.current : systemGalleryRequestRef.current
    if (reset) {
      setGalleryLoading(true)
      setGalleryLoadingMore(false)
      setSystemGalleryHasMore(false)
    } else {
      if (galleryLoadingMore || !systemGalleryHasMore) return
      setGalleryLoadingMore(true)
    }

    try {
      const offset = reset ? 0 : systemGalleryLoadedCountRef.current
      const params = new URLSearchParams()
      params.set('offset', String(offset))
      params.set('limit', String(GALLERY_BATCH_SIZE))
      params.set('link_filter', 'all')
      if (gallerySearchQuery) params.set('q', gallerySearchQuery)

      const resp = await apiFetch(`${WORKER_URL}/api/gallery?${params.toString()}`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (!resp.ok) return

      const data = await resp.json() as GalleryPageResponse
      if (requestId !== systemGalleryRequestRef.current) return

      const nextVideos = Array.isArray(data.videos) ? data.videos : []
      const hasMore = !!data.has_more && nextVideos.length > 0
      setVideos((prev) => reset ? dedupeGalleryVideos(nextVideos) : dedupeGalleryVideos([...prev, ...nextVideos]))
      setSystemGalleryStats({
        total: Number(data.total || 0),
        shopeeTotal: Number(data.shopee_total || 0),
        lazadaTotal: Number(data.lazada_total || 0),
        withLink: Number(data.with_link_total || 0),
        withoutLink: Number(data.without_link_total || 0),
      })
      setSystemGalleryOverallTotal(Number(data.overall_total || data.total || 0))
      setSystemGalleryHasMore(hasMore)
    } catch {
      // Keep current gallery snapshot on transient errors.
    } finally {
      if (requestId === systemGalleryRequestRef.current) {
        setGalleryLoading(false)
        setGalleryLoadingMore(false)
      }
    }
  }

  async function loadAll(options: { skipGallery?: boolean } = {}) {
    if (loadAllInFlightRef.current) {
      loadAllPendingRef.current = true
      return
    }
    loadAllInFlightRef.current = true

    const session = getToken()
    if (!session) {
      setLoading(false)
      loadAllInFlightRef.current = false
      return
    }
    try {
      let unauthorized = false
      const onUnauthorized = async () => {
        if (unauthorized) return
        unauthorized = true
        await recoverSessionOrLogout()
      }

      const historyTask = (async () => {
        const historyResp = await apiFetch(`${WORKER_URL}/api/post-history?_ts=${Date.now()}`)
        if (historyResp.status === 401) {
          await onUnauthorized()
          return
        }
        if (historyResp.ok) {
          const data = await historyResp.json()
          setPostHistory(data.history || [])
        }
      })()

      const tasks: Promise<void>[] = [historyTask]
      if (!options.skipGallery) {
        const galleryTask = (async () => {
          const params = new URLSearchParams()
          params.set('offset', '0')
          params.set('limit', '5000')
          const galleryEndpoint = `${WORKER_URL}/api/gallery?${params.toString()}`
          const galleryResp = await apiFetch(galleryEndpoint)
          if (galleryResp.status === 401) {
            await onUnauthorized()
            return
          }
          if (galleryResp.ok) {
            const data = await galleryResp.json() as { videos?: Video[] }
            setVideos(dedupeGalleryVideos(Array.isArray(data.videos) ? data.videos : []))
          }
          if (!unauthorized) setGalleryLoading(false)
        })()
        tasks.push(galleryTask)
      }

      await Promise.allSettled(tasks)
      if (!unauthorized) setLoading(false)
    } finally {
      loadAllInFlightRef.current = false
      void loadInboxSnapshot()
      void loadProcessingSnapshot()
      if (!systemWideGalleryModeRef.current) {
        void loadUsedVideos()
      }
      if (loadAllPendingRef.current) {
        loadAllPendingRef.current = false
        void loadAll(options)
      }
    }
  }

  async function refreshPostHistorySnapshot() {
    const historyResp = await apiFetch(`${WORKER_URL}/api/post-history?_ts=${Date.now()}`)
    if (historyResp.status === 401) {
      await recoverSessionOrLogout()
      return
    }
    if (historyResp.ok) {
      const data = await historyResp.json()
      setPostHistory(data.history || [])
    }
  }

  useEffect(() => {
    if (authBootstrapping || !token) return
    if (tab !== 'gallery') return

    if (categoryFilter === 'all-original') {
      if (isOwner) void loadGlobalOriginalVideos({ force: true })
      return
    }

    if (systemWideGalleryMode) {
      void loadSystemGalleryPage({ reset: true })
      return
    }

    void loadUsedVideos({ force: categoryFilter === 'used' })
    if (isOwner) void loadGlobalOriginalVideos()
  }, [tab, categoryFilter, token, authBootstrapping, isOwner, systemWideGalleryMode, gallerySearchQuery])

  useEffect(() => {
    if (authBootstrapping || !token) return
    void loadAll({ skipGallery: systemWideGalleryMode })
  }, [systemWideGalleryMode, token, authBootstrapping])



  async function loadDashboard(dateValue = dashboardDateFilter, options: { silent?: boolean } = {}) {
    const session = getToken()
    if (!session) return
    if (!options.silent) setDashboardLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/dashboard?date=${encodeURIComponent(dateValue)}`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.ok) {
        const data = await resp.json() as DashboardData
        setDashboardData(data)
      }
    } catch (e) {
      console.error('Failed to load dashboard:', e)
    } finally {
      if (!options.silent) setDashboardLoading(false)
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
      const meResp = await apiFetch(`${WORKER_URL}/api/me`)
      if (meResp.status === 401 || meResp.status === 404) {
        if (requestId === loadTeamRequestRef.current) {
          setTeamMembers([])
        }
        await recoverSessionOrLogout()
        return
      }
      if (meResp.ok) {
        const me = await meResp.json() as any
        if (requestId === loadTeamRequestRef.current) {
          setIsOwner(!!me.is_owner)
          if (me.email) setMeEmail(me.email)
          const ns = String(me.namespace_id || '').trim()
          if (ns && ns !== namespaceId) {
            setNamespaceId(ns)
          }
        }
      }
      const teamResp = await apiFetch(`${WORKER_URL}/api/team`)
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
    if (!session || !isOwner) return
    setVoicePromptMessage('')
    setVoicePromptLoading(true)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/voice-prompt`)
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setVoicePromptMessage('บัญชีนี้ไม่มีสิทธิ์แก้ prompt พากย์เสียง')
        return
      }
      if (!resp.ok) {
        setVoicePromptMessage('โหลด prompt ไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        prompt?: string
        source?: 'default' | 'custom'
        updated_at?: string
        max_chars?: number
      }
      const prompt = String(data.prompt || '')
      setVoicePrompt(prompt)
      setVoicePromptDraft(prompt)
      setVoicePromptSource(data.source === 'custom' ? 'custom' : 'default')
      setVoicePromptUpdatedAt(String(data.updated_at || ''))
      setVoicePromptMessage('')
      if (typeof data.max_chars === 'number' && data.max_chars > 0) setVoicePromptMaxChars(data.max_chars)
    } catch {
      setVoicePromptMessage('โหลด prompt ไม่สำเร็จ')
    } finally {
      setVoicePromptLoading(false)
    }
  }

  async function loadCommentTemplate() {
    const session = getToken()
    if (!session || !isOwner) return
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
    if (!session || !isOwner) return
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

  async function saveVoicePrompt(nextPrompt: string) {
    const session = getToken()
    if (!session || !isOwner) return
    setVoicePromptSaving(true)
    setVoicePromptMessage('')
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/settings/voice-prompt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: nextPrompt }),
      })
      if (resp.status === 401) {
        await recoverSessionOrLogout()
        return
      }
      if (resp.status === 403) {
        setVoicePromptMessage('บัญชีนี้ไม่มีสิทธิ์แก้ prompt พากย์เสียง')
        return
      }
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        setVoicePromptMessage(data.error || 'บันทึก prompt ไม่สำเร็จ')
        return
      }
      const data = await resp.json() as {
        prompt?: string
        source?: 'default' | 'custom'
        updated_at?: string
        max_chars?: number
      }
      const prompt = String(data.prompt || '')
      setVoicePrompt(prompt)
      setVoicePromptDraft(prompt)
      setVoicePromptSource(data.source === 'custom' ? 'custom' : 'default')
      setVoicePromptUpdatedAt(String(data.updated_at || new Date().toISOString()))
      if (typeof data.max_chars === 'number' && data.max_chars > 0) setVoicePromptMaxChars(data.max_chars)
      setVoicePromptMessage('บันทึก prompt แล้ว (งานถัดไปจะใช้ทันที)')
    } catch {
      setVoicePromptMessage('บันทึก prompt ไม่สำเร็จ')
    } finally {
      setVoicePromptSaving(false)
    }
  }

  async function loadGeminiApiKey() {
    const session = getToken()
    if (!session || !isOwner) return
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
        source?: GeminiKeySource
        updated_at?: string
        max_chars?: number
      }
      setGeminiApiKeyMasked(String(data.masked_key || ''))
      setGeminiApiKeySource(data.source === 'workspace' ? 'workspace' : 'none')
      setGeminiApiKeyUpdatedAt(String(data.updated_at || ''))
      if (typeof data.max_chars === 'number' && data.max_chars > 0) setGeminiApiKeyMaxChars(data.max_chars)
      setGeminiApiKeyDraft('')
      setGeminiApiKeyMessage('')
    } catch {
      setGeminiApiKeyMessage('โหลด Gemini API key ไม่สำเร็จ')
    } finally {
      setGeminiApiKeyLoading(false)
    }
  }

  async function saveGeminiApiKey(nextApiKey: string) {
    const session = getToken()
    if (!session || !isOwner) return
    const trimmed = String(nextApiKey || '').trim()
    setGeminiApiKeySaving(true)
    setGeminiApiKeyMessage('')
    try {
      const isClear = !trimmed
      const resp = await apiFetch(`${WORKER_URL}/api/settings/gemini-key`, isClear ? {
        method: 'DELETE',
      } : {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: trimmed }),
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
        source?: GeminiKeySource
        updated_at?: string
        max_chars?: number
      }
      setGeminiApiKeyMasked(String(data.masked_key || ''))
      setGeminiApiKeySource(data.source === 'workspace' ? 'workspace' : 'none')
      setGeminiApiKeyUpdatedAt(String(data.updated_at || ''))
      if (typeof data.max_chars === 'number' && data.max_chars > 0) setGeminiApiKeyMaxChars(data.max_chars)
      setGeminiApiKeyDraft('')
      setGeminiApiKeyMessage(isClear ? 'ล้าง Gemini API key ระดับ workspace แล้ว' : 'บันทึก Gemini API key แล้ว')
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
      if (!resp.ok) return
      await loadProcessingSnapshot()
    } catch {
    } finally {
      setRetryingProcessingId(null)
    }
  }

  const handleStartInboxVideo = async (id: string) => {
    setStartingInboxId(id)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/inbox/${encodeURIComponent(id)}/process`, {
        method: 'POST',
      })
      const data = await resp.json().catch(() => ({})) as { error?: string; job?: { status?: string } }
      if (!resp.ok) {
        throw new Error(String(data.error || 'ส่งเข้า Processing ไม่สำเร็จ'))
      }
      await Promise.all([loadInboxSnapshot(), loadProcessingSnapshot()])
      alert(data.job?.status === 'queued' ? 'ส่งเข้า Processing แล้ว และคลิปยังอยู่ในคลังต้นฉบับ' : 'เริ่มประมวลผลแล้ว โดยเก็บคลิปไว้ในคลังต้นฉบับ')
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setStartingInboxId(null)
    }
  }

  const handleDeleteInboxVideo = async (id: string) => {
    const ok = window.confirm('ยืนยันลบวิดีโอนี้ออกจากคลังต้นฉบับ?')
    if (!ok) return
    setDeletingInboxId(id)
    try {
      const resp = await apiFetch(`${WORKER_URL}/api/inbox/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string }
        throw new Error(String(data.error || 'ลบจาก Inbox ไม่สำเร็จ'))
      }
      setInboxVideos((prev) => prev.filter((video) => video.id !== id))
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
    const nextCandidate = (previousVideo || previousPendingVideo)
      ? { ...(previousVideo || previousPendingVideo), ...fields } as Video
      : null
    const nextCandidateExpectedUtmId = String((nextCandidate as unknown as Record<string, unknown> | null)?.shortlink_expected_utm_id || shortlinkExpectedUtmIdCurrent || '').trim()
    const nextCandidateExpectedLazadaMemberId = String((nextCandidate as unknown as Record<string, unknown> | null)?.lazada_expected_member_id || lazadaExpectedMemberIdCurrent || '').trim()

    setVideos((prev) => {
      const hasExistingVideo = prev.some((video) =>
        matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
      )

      if (!hasExistingVideo && nextCandidate && !isVideoAwaitingAffiliateConversion(
        nextCandidate as unknown as Record<string, unknown>,
        nextCandidateExpectedUtmId,
        nextCandidateExpectedLazadaMemberId,
      )) {
        return dedupeGalleryVideos([nextCandidate, ...prev])
      }

      return prev.flatMap((video) => {
        if (!matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)) {
          return [video]
        }

        const nextVideo = { ...video, ...fields }
        return [nextVideo]
      })
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
        ) ? [nextVideo] : []
      })

      if (!nextCandidate) return updated
      const alreadyTracked = updated.some((video) =>
        matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
      )
      if (alreadyTracked) return updated

      return isVideoAwaitingAffiliateConversion(
        nextCandidate as unknown as Record<string, unknown>,
        nextCandidateExpectedUtmId,
        nextCandidateExpectedLazadaMemberId,
      ) ? dedupeGalleryVideos([nextCandidate, ...updated]) : updated
    })

    setUsedVideos((prev) => prev.map((video) =>
      matchesVideoIdentity(video as unknown as Record<string, unknown>, id, targetNamespaceId)
        ? { ...video, ...fields }
        : video
    ))

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

  const pendingShortlinkIdentitySet = useMemo(() => {
    return new Set(pendingShortlinkVideos.map((video) => getVideoIdentityKey(video as Video & Record<string, unknown>)))
  }, [pendingShortlinkVideos])

  const usedVideoIdSet = useMemo(() => {
    return new Set(usedVideos.map((video) => getVideoIdentityKey(video as Video & Record<string, unknown>)))
  }, [usedVideos])
  const isKeepInPostedTab = (video: Video) => !!video.keepInPostedTab
  const {
    galleryUnusedVideos,
    galleryUsedVideos,
    galleryAvailableVideos,
  } = useMemo(() => {
    const getGallerySortTs = (video: Video) => {
      const ts = new Date(String(video.updatedAt || video.createdAt || '')).getTime()
      return Number.isFinite(ts) ? ts : 0
    }
    const sortNewestFirst = (rows: Video[]) => rows.sort((a, b) => getGallerySortTs(b) - getGallerySortTs(a))
    const sourceVideos = dedupeGalleryVideos(videos).filter((video) =>
      !pendingShortlinkIdentitySet.has(getVideoIdentityKey(video as Video & Record<string, unknown>))
    )
    const unusedVideos = sortNewestFirst(
      sourceVideos.filter((video) =>
        !usedVideoIdSet.has(getVideoIdentityKey(video as Video & Record<string, unknown>)) &&
        !isKeepInPostedTab(video)
      )
    )
    const galleryPinnedPostedVideos = sortNewestFirst(
      sourceVideos.filter((video) =>
        !usedVideoIdSet.has(getVideoIdentityKey(video as Video & Record<string, unknown>)) &&
        isKeepInPostedTab(video)
      )
    )
    const galleryUsedMergedVideos: Video[] = [
      ...usedVideos,
      ...galleryPinnedPostedVideos,
    ]
    const dedupedUsedVideos = sortNewestFirst(
      galleryUsedMergedVideos.filter((video, index, arr) => arr.findIndex((v) =>
        getVideoIdentityKey(v as Video & Record<string, unknown>) === getVideoIdentityKey(video as Video & Record<string, unknown>)
      ) === index)
    )
    const baseVideos = systemWideGalleryMode
      ? sourceVideos
      : (categoryFilter === 'used' || categoryFilter === 'missing-link')
        ? dedupedUsedVideos
        : unusedVideos
    const availableVideos = gallerySearchQuery
      ? baseVideos.filter((video) => matchesGallerySearch(video as Video & Record<string, unknown>, gallerySearchQuery))
      : baseVideos

    return {
      galleryUnusedVideos: unusedVideos,
      galleryUsedVideos: dedupedUsedVideos,
      galleryBaseVideos: baseVideos,
      galleryAvailableVideos: availableVideos,
    }
  }, [videos, usedVideos, usedVideoIdSet, pendingShortlinkIdentitySet, systemWideGalleryMode, categoryFilter, gallerySearchQuery])
  const showGalleryFilterBar = tab === 'gallery' && (
    !systemWideGalleryMode && (
      galleryLoading ||
      (galleryUnusedVideos.length > 0 || galleryUsedVideos.length > 0)
    )
  )
  const galleryHeaderOffset = tab === 'gallery'
    ? (showGalleryFilterBar ? 184 : 124)
    : 104
  const isAllOriginalMode = categoryFilter === 'all-original' && isOwner
  const galleryViewTotal = systemWideGalleryMode
    ? Number(systemGalleryStats.total || 0)
    : galleryAvailableVideos.length
  const galleryVisibleVideos = useMemo(() => {
    if (systemWideGalleryMode) return galleryAvailableVideos
    return galleryAvailableVideos.slice(0, galleryVisibleCount)
  }, [systemWideGalleryMode, galleryAvailableVideos, galleryVisibleCount])
  const galleryHasMore = systemWideGalleryMode
    ? systemGalleryHasMore
    : galleryVisibleVideos.length < galleryAvailableVideos.length
  const galleryCurrentTotal = galleryViewTotal
  const appViewportStyle = {
    height: 'var(--tg-viewport-stable-height, 100dvh)',
    minHeight: 'var(--tg-viewport-stable-height, 100dvh)',
  } as const
  const headerTopPaddingStyle = {
    paddingTop: 'calc(env(safe-area-inset-top, 0px) + 52px)',
  } as const
  const mainContentPaddingStyle = {
    paddingTop: `calc(env(safe-area-inset-top, 0px) + ${galleryHeaderOffset}px)`,
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 6rem)',
  } as const

  useEffect(() => {
    if (tab !== 'gallery' || isAllOriginalMode || galleryLoading || !galleryHasMore) return

    const root = mainScrollRef.current
    const target = galleryLoadMoreRef.current
    if (!root || !target) return

    const observer = new IntersectionObserver((entries) => {
      const first = entries[0]
      if (!first?.isIntersecting) return
      if (systemWideGalleryMode) {
        void loadSystemGalleryPage()
        return
      }
      setGalleryVisibleCount((prev) => Math.min(prev + GALLERY_BATCH_SIZE, galleryAvailableVideos.length))
    }, {
      root,
      rootMargin: '360px 0px',
      threshold: 0.01,
    })

    observer.observe(target)
    return () => observer.disconnect()
  }, [tab, isAllOriginalMode, galleryLoading, galleryHasMore, galleryAvailableVideos.length, systemWideGalleryMode, videos.length, galleryLoadingMore])

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

        if (systemWideGalleryMode) {
          void loadSystemGalleryPage()
          return
        }

        setGalleryVisibleCount((prev) => Math.min(prev + GALLERY_BATCH_SIZE, galleryAvailableVideos.length))
      })
    }

    maybeLoadMore()
    root.addEventListener('scroll', maybeLoadMore, { passive: true })
    return () => {
      root.removeEventListener('scroll', maybeLoadMore)
      if (rafId) window.cancelAnimationFrame(rafId)
    }
  }, [tab, isAllOriginalMode, galleryLoading, galleryHasMore, galleryAvailableVideos.length, systemWideGalleryMode, galleryLoadingMore])

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
            onBack={() => setSelectedPage(null)}
            onSave={handleSavePage}
          />
        </div>
      </div>
    )
  }

  // ========== AUTH GATE ==========
  if (authBootstrapping && !token) {
    return (
      <div
        style={{ height: 'var(--tg-viewport-stable-height, 100dvh)', minHeight: 'var(--tg-viewport-stable-height, 100dvh)' }}
        className="bg-white flex items-center justify-center font-['Sukhumvit_Set','Kanit',sans-serif] overflow-hidden"
      >
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <div className="w-7 h-7 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium">กำลังตรวจสอบการเข้าสู่ระบบ...</p>
        </div>
      </div>
    )
  }

  if (!token) {
    return (
      <LoginScreen onLogin={handleLogin} />
    )
  }

  return (
    <div style={appViewportStyle} className="bg-white flex flex-col font-['Sukhumvit_Set','Kanit',sans-serif] overflow-hidden">
      {/* Add Page Popup */}
      {showAddPagePopup && (
        <AddPagePopup
          onClose={() => setShowAddPagePopup(false)}
          onSuccess={loadPages}
        />
      )}

      {!videoViewerOpen && (
        <div style={headerTopPaddingStyle} className="fixed top-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-b border-gray-100 z-50 px-5">
          {tab === 'gallery' && !isAllOriginalMode ? (
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
          ) : (
            <h1 className="text-2xl font-extrabold text-gray-900 text-center pb-3">
              {tab === 'dashboard' ? 'Dashboard' : tab === 'inbox' ? 'คลังต้นฉบับ' : tab === 'processing' ? 'Processing' : tab === 'logs' ? 'Activity Logs' : 'Settings'}
            </h1>
          )}
          {tab === 'gallery' && showGalleryFilterBar && (
            <div className="flex bg-gray-100 p-1 mt-1 mb-2 rounded-xl gap-1">
              <button
                onClick={() => setCategoryFilter('unused')}
                className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${categoryFilter === 'unused' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                ยังไม่ได้ใช้ ({galleryUnusedVideos.length})
              </button>
              <button
                onClick={() => setCategoryFilter('used')}
                className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${categoryFilter === 'used' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                โพสต์แล้ว ({galleryUsedVideos.length})
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      <div ref={mainScrollRef} style={mainContentPaddingStyle} className="flex-1 [&::-webkit-scrollbar]:hidden overflow-y-auto app-scroll">

        {tab === 'dashboard' && (
          <div className="px-4 space-y-4">
            <div className="bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <input
                    type="date"
                    value={dashboardDateFilter}
                    onChange={(e) => setDashboardDateFilter(e.target.value)}
                    className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                  />
                  <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 flex items-center gap-3 active:scale-95 transition-all">
                    <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <p className="text-[11px] text-gray-400 font-medium">เลือกวันที่รายงาน</p>
                      <p className="text-sm font-bold text-gray-900">{dashboardDateFilter}</p>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setDashboardDateFilter(getTodayString())}
                  className="shrink-0 bg-blue-500 text-white px-4 py-3 rounded-2xl text-sm font-bold active:scale-95 transition-all shadow-sm shadow-blue-200"
                >
                  วันนี้
                </button>
              </div>
            </div>

            {dashboardLoading && !dashboardData ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-24 rounded-2xl bg-gray-100 animate-pulse" />
                ))}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                    <p className="text-xs text-gray-400 font-semibold">โพสต์ทั้งหมด</p>
                    <p className="mt-2 text-2xl font-extrabold text-gray-900">{dashboardData?.totals.posts_all || 0}</p>
                  </div>
                  <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                    <p className="text-xs text-gray-400 font-semibold">โพสต์วันนี้</p>
                    <p className="mt-2 text-2xl font-extrabold text-blue-600">{dashboardData?.totals.posts_on_date || 0}</p>
                  </div>
                  <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                    <p className="text-xs text-gray-400 font-semibold">ลิงก์ทั้งหมด</p>
                    <p className="mt-2 text-2xl font-extrabold text-gray-900">{dashboardData?.totals.links_all || 0}</p>
                  </div>
                  <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                    <p className="text-xs text-gray-400 font-semibold">ลิงก์วันนี้</p>
                    <p className="mt-2 text-2xl font-extrabold text-emerald-600">{dashboardData?.totals.links_on_date || 0}</p>
                  </div>
                </div>

                <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                  <p className="text-sm font-bold text-gray-900 mb-3">แอดมินส่งลิงก์ต่อวัน</p>
                  {dashboardData?.admins?.length ? (
                    <div className="space-y-2">
                      {dashboardData.admins.map((admin) => (
                        <div key={`${admin.telegram_id}:${admin.email}`} className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900 truncate">{admin.email}</p>
                            <p className="text-[11px] text-gray-400 truncate">TG: {admin.telegram_id}</p>
                          </div>
                          <span className="text-xs font-bold text-white bg-black px-2.5 py-1 rounded-full">{admin.links} ลิงก์</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400">ยังไม่มีข้อมูลลิงก์ในวันที่เลือก</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'inbox' && (
          <div className="px-4">
            <div className="mb-3 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">
                  ต้นฉบับ {inboxVideos.length}
                </span>
                <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-bold text-violet-700">
                  อยู่ใน Processing {inboxVideos.filter((video) => video.processingActive).length}
                </span>
              </div>
              <p className="mt-3 text-xs leading-5 text-gray-500">
                เก็บวิดีโอที่ผู้ใช้ส่งมาไว้ตลอด แยกจากหน้า Processing แม้จะส่งเข้าไปประมวลผลแล้วก็ยังอยู่ที่นี่
              </p>
            </div>

            {inboxLoading ? (
              <div className="grid grid-cols-3 gap-3">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="aspect-[9/16] rounded-2xl bg-gray-100 animate-pulse" />
                ))}
              </div>
            ) : inboxVideos.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[50vh]">
                <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                  <span className="text-4xl grayscale opacity-50">📥</span>
                </div>
                <p className="text-gray-900 font-bold text-lg">ยังไม่มีวิดีโอต้นฉบับ</p>
                <p className="text-gray-400 text-sm mt-1 text-center">ส่งวิดีโอหรือ XHS link มาทาง Telegram แล้วระบบจะเก็บไว้ที่นี่ถาวร แยกจากหน้า Processing</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {inboxVideos.map((video) => (
                  <InboxCard
                    key={video.id}
                    video={video}
                    onStart={handleStartInboxVideo}
                    onDelete={handleDeleteInboxVideo}
                    starting={startingInboxId === video.id}
                    deleting={deletingInboxId === video.id}
                    onExpandedChange={setVideoViewerOpen}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'processing' && (
          <div className="px-4">
            <div className="mb-3 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
              <div className="rounded-2xl bg-gray-100 p-1">
                <div className="rounded-[18px] bg-white px-3 py-3 text-sm font-bold text-blue-600 shadow-sm">
                  กำลังประมวลผล ({processingVideos.length})
                </div>
              </div>
            </div>

            {loading ? (
              <div className="space-y-3">
                {[1, 2].map(i => (
                  <div key={i} className="bg-gray-100 rounded-2xl p-4 h-28 animate-pulse" />
                ))}
              </div>
            ) : (
              processingVideos.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[50vh]">
                  <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                    <span className="text-4xl grayscale opacity-50">⚙️</span>
                  </div>
                  <p className="text-gray-900 font-bold text-lg">No Processing Videos</p>
                  <p className="text-gray-400 text-sm mt-1">Videos currently being dubbed will appear here</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {processingVideos.map((video: any) => (
                    <ProcessingCard
                      key={video.id}
                      video={video}
                      onCancel={handleCancelJob}
                      onReprocess={handleReprocessJob}
                      retrying={retryingProcessingId === video.id}
                    />
                  ))}
                </div>
              )
            )}
          </div>
        )}

        {tab === 'gallery' && (
          <div className="px-4">
            {!isAllOriginalMode && gallerySearchQuery && (
              <div className="mb-3 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
                    ผลลัพธ์ {galleryCurrentTotal.toLocaleString('th-TH')}
                  </span>
                </div>
              </div>
            )}

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
            ) : galleryLoading ? (
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
                    : systemWideGalleryMode
                    ? 'ยังไม่มีคลิปใน Gallery'
                    : categoryFilter === 'used'
                      ? 'ยังไม่มีคลิปที่โพสต์แล้ว'
                      : 'ยังไม่มีคลิปในรายการ'}
                </p>
                <p className="text-gray-400 text-sm mt-1">
                  {gallerySearchQuery
                    ? 'ลองค้นหาด้วย video id หรือคำจากชื่อคลิปใหม่อีกครั้ง'
                    : systemWideGalleryMode
                    ? 'คลิปทุก workspace จะแสดงรวมกันที่นี่'
                    : categoryFilter === 'used'
                      ? 'คลิปที่โพสต์สำเร็จจะแสดงที่นี่'
                      : 'จะแสดงเฉพาะคลิปที่มี Shopee และ Lazada link ครบพร้อมโพสต์'}
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
                      showWorkspaceBadge={systemWideGalleryMode}
                      formatDuration={formatDuration}
                      keepInPostedOnLinkSave={!systemWideGalleryMode && categoryFilter === 'used'}
                      onDelete={(id, targetNamespaceId) => {
                        setVideos(videos.filter(v => !matchesVideoIdentity(v as unknown as Record<string, unknown>, id, targetNamespaceId)));
                        setUsedVideos(usedVideos.filter(v => !matchesVideoIdentity(v as unknown as Record<string, unknown>, id, targetNamespaceId)));
                      }}
                      onUpdate={updateGalleryVideoState}
                      onExpandedChange={setVideoViewerOpen}
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
                                  await refreshPostHistorySnapshot()
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
                                  await refreshPostHistorySnapshot()
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
            <div className="flex items-center gap-3 px-1">
              <button
                onClick={() => setSettingsSection('menu')}
                className="w-9 h-9 rounded-xl border border-gray-200 bg-white flex items-center justify-center active:scale-95"
                aria-label="ย้อนกลับ"
              >
                <BackIcon />
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-lg font-bold text-gray-900">Pages</p>
                <p className="text-xs text-gray-400">
                  {pagesLoading ? 'กำลังโหลดเพจ...' : `${pages.length} เพจใน workspace นี้`}
                </p>
              </div>
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
                      onClick={() => !isDeleting && setSelectedPage(page)}
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
              <>
                {meEmail && (
                  <div className="flex items-center justify-between gap-3 p-4 bg-white rounded-2xl border border-gray-200">
                    <div className="flex items-center min-w-0">
                      <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white text-xl font-bold shadow-lg flex-shrink-0">
                        {meEmail.charAt(0).toUpperCase()}
                      </div>
                      <div className="ml-4 min-w-0">
                        <p className="font-semibold text-gray-900 text-sm truncate">{meEmail}</p>
                        <p className={`font-medium text-xs px-2 py-0.5 rounded-md inline-block mt-1 ${isOwner ? 'text-blue-500 bg-blue-50' : 'text-gray-500 bg-gray-100'}`}>
                          {isOwner ? 'Owner' : 'Member'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={handleLogout}
                      disabled={logoutLoading}
                      className="px-4 py-2 rounded-xl border border-red-200 bg-red-50 text-red-600 text-sm font-semibold active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {logoutLoading ? 'กำลังออก...' : 'Logout'}
                    </button>
                  </div>
                )}
                <SettingsMenuItem
                  icon="📄"
                  title="Pages"
                  subtitle="เพิ่มเพจและตั้งค่า Auto Post"
                  onClick={() => setSettingsSection('pages')}
                />
                {isOwner && (
                  <SettingsMenuItem
                    icon="👥"
                    title="Team"
                    subtitle={`${teamMembers.length} สมาชิก`}
                    onClick={() => setSettingsSection('team')}
                  />
                )}
                {isOwner && (
                  <SettingsMenuItem
                    icon="🔑"
                    title="Gemini API Key"
                    subtitle={
                      geminiApiKeySource === 'workspace'
                        ? 'แหล่งที่ใช้งาน: Owner นี้เท่านั้น'
                          : 'ยังไม่ตั้งค่า'
                    }
                    onClick={() => setSettingsSection('gemini')}
                  />
                )}
                {isOwner && (
                  <SettingsMenuItem
                    icon="🎙️"
                    title="Voice Prompt"
                    subtitle={voicePromptSource === 'custom' ? 'กำลังใช้ prompt แบบกำหนดเอง' : 'กำลังใช้ prompt ค่าเริ่มต้น'}
                    onClick={() => setSettingsSection('voice')}
                  />
                )}
                {isOwner && (
                  <SettingsMenuItem
                    icon="💬"
                    title="Comment Template"
                    subtitle={commentTemplateSource === 'custom' ? 'กำลังใช้เทมเพลตคอมเมนต์ที่กำหนดเอง' : 'กำลังใช้เทมเพลตคอมเมนต์ค่าเริ่มต้น'}
                    onClick={() => setSettingsSection('comment')}
                  />
                )}
                <p className="text-gray-300 text-xs font-medium text-center pt-2">Version 2.0.1 (Build 240)</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={() => setSettingsSection('menu')}
                    className="w-9 h-9 rounded-xl border border-gray-200 bg-white flex items-center justify-center active:scale-95"
                    aria-label="ย้อนกลับ"
                  >
                    <BackIcon />
                  </button>
                  <p className="text-lg font-bold text-gray-900">
                    {settingsSection === 'account'
                      ? 'Account'
                      : settingsSection === 'team'
                        ? 'Team'
                        : settingsSection === 'gemini'
                          ? 'Gemini API Key'
                          : settingsSection === 'comment'
                            ? 'Comment Template'
                            : 'Voice Prompt'}
                  </p>
                </div>

                {settingsSection === 'account' && (
                  <div className="space-y-3">
                    {meEmail ? (
                      <div className="flex items-center p-4 bg-gray-50 rounded-3xl border border-gray-100">
                        <div className="w-14 h-14 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white text-xl font-bold shadow-lg flex-shrink-0">
                          {meEmail.charAt(0).toUpperCase()}
                        </div>
                        <div className="ml-4 min-w-0">
                          <p className="font-semibold text-gray-900 text-sm truncate">{meEmail}</p>
                          <p className={`font-medium text-xs px-2 py-0.5 rounded-md inline-block mt-1 ${isOwner ? 'text-blue-500 bg-blue-50' : 'text-gray-500 bg-gray-100'}`}>
                            {isOwner ? 'Owner' : 'Member'}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="bg-white border border-gray-100 rounded-2xl p-4 text-sm text-gray-500">
                        ไม่พบบัญชีผู้ใช้
                      </div>
                    )}
                    <button
                      onClick={handleLogout}
                      disabled={logoutLoading}
                      className="w-full h-12 rounded-2xl bg-red-500 text-white font-bold active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {logoutLoading ? 'กำลังออกจากระบบ...' : 'Logout'}
                    </button>
                  </div>
                )}

                {settingsSection === 'team' && isOwner && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      {teamMembers.length === 0 && (
                        <p className="text-sm text-gray-400 text-center py-2">ยังไม่มีสมาชิกในทีม</p>
                      )}
                      {teamMembers.map((m) => (
                        <div key={m.email} className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-900">{m.email}</span>
                          <button
                            onClick={async () => {
                              await apiFetch(`${WORKER_URL}/api/team/${encodeURIComponent(m.email)}`, { method: 'DELETE' })
                              setTeamMembers(prev => prev.filter(x => x.email !== m.email))
                            }}
                            className="w-8 h-8 rounded-lg bg-red-50 text-red-500 flex items-center justify-center active:scale-90 transition-transform"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        </div>
                      ))}
                      <div className="flex gap-2 pt-1">
                        <input
                          type="email"
                          value={newMemberEmail}
                          onChange={(e) => setNewMemberEmail(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && newMemberEmail.trim().includes('@')) {
                              e.currentTarget.blur()
                            }
                          }}
                          placeholder="อีเมลสมาชิกใหม่"
                          className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                        />
                        <button
                          onClick={async () => {
                            if (!newMemberEmail.trim() || !newMemberEmail.includes('@')) return
                            await apiFetch(`${WORKER_URL}/api/team`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ email: newMemberEmail.trim() })
                            })
                            await loadTeam()
                            setNewMemberEmail('')
                          }}
                          disabled={!newMemberEmail.trim() || !newMemberEmail.includes('@')}
                          className="bg-gray-900 text-white px-4 rounded-xl text-sm font-bold active:scale-95 transition-all disabled:opacity-30"
                        >
                          เพิ่ม
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {settingsSection === 'gemini' && isOwner && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        ตั้งค่า Gemini key แยกตาม owner/workspace ของใครของมัน ถ้าไม่ตั้งค่า ระบบจะไม่ประมวลผลคลิป และจะไม่ fallback ไปใช้ key กลาง
                      </p>
                      {geminiApiKeyLoading ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลด Gemini API key...</p>
                      ) : (
                        <>
                          <input
                            type="password"
                            value={geminiApiKeyDraft}
                            onChange={(e) => {
                              setGeminiApiKeyDraft(e.target.value)
                              if (geminiApiKeyMessage) setGeminiApiKeyMessage('')
                            }}
                            placeholder={geminiApiKeyMasked
                              ? `${geminiApiKeyMasked} (กรอกใหม่เพื่อแทนค่าเดิม)`
                              : 'AIza...'}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                          />
                          <p className="text-[11px] text-gray-500 break-all">
                            คีย์ปัจจุบัน: {geminiApiKeyMasked || '-'}
                          </p>
                          <div className="flex items-center justify-between text-[11px] text-gray-400">
                            <span>
                              แหล่งที่ใช้งาน: {geminiApiKeySource === 'workspace' ? 'Owner นี้เท่านั้น' : 'ยังไม่ตั้งค่า'}
                            </span>
                            <span>{geminiApiKeyDraft.length}/{geminiApiKeyMaxChars}</span>
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
                                if (geminiApiKeySaving || geminiApiKeyDraft.length > geminiApiKeyMaxChars) return
                                void saveGeminiApiKey(geminiApiKeyDraft)
                              }}
                              disabled={geminiApiKeySaving || geminiApiKeyDraft.length > geminiApiKeyMaxChars || !geminiApiKeyDraft.trim()}
                              className="flex-1 bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all disabled:opacity-40"
                            >
                              {geminiApiKeySaving ? 'กำลังบันทึก...' : 'บันทึก Gemini API key'}
                            </button>
                            <button
                              onClick={() => {
                                if (geminiApiKeySaving) return
                                void saveGeminiApiKey('')
                              }}
                              disabled={geminiApiKeySaving || (geminiApiKeySource === 'none' && !geminiApiKeyMasked)}
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
                        ใส่แค่ 3 ค่าให้ workspace นี้: account, Shopee UTM และ Lazada member_id
                      </p>
                      {shortlinkLoading ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลด Shortlink URL...</p>
                      ) : (
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
                          <div className="space-y-1">
                            <p className="text-[11px] font-semibold text-gray-600">Shopee expected UTM ID</p>
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
                            <p className="text-[11px] font-semibold text-gray-600">Lazada expected member_id</p>
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
                            <p>Account ปัจจุบัน: <span className="font-semibold text-gray-700">{shortlinkAccountCurrent || '-'}</span></p>
                            <p>Shopee UTM ปัจจุบัน: <span className="font-semibold text-gray-700">{shortlinkExpectedUtmIdCurrent || '-'}</span></p>
                            <p>Lazada member_id ปัจจุบัน: <span className="font-semibold text-gray-700">{lazadaExpectedMemberIdCurrent || '-'}</span></p>
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

                {settingsSection === 'comment' && isOwner && (
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

                {settingsSection === 'voice' && isOwner && (
                  <div className="space-y-3">
                    <div className="bg-white border border-gray-100 rounded-2xl p-4 space-y-3">
                      <p className="text-xs text-gray-500 leading-relaxed">
                        แก้ prompt ที่ใช้สร้างบทพากย์ได้ทันที งานถัดไปจะใช้ค่าล่าสุดโดยไม่ต้อง rebuild container
                      </p>
                      {voicePromptLoading ? (
                        <p className="text-sm text-gray-400 py-3">กำลังโหลด prompt...</p>
                      ) : (
                        <>
                          <textarea
                            value={voicePromptDraft}
                            onChange={(e) => {
                              setVoicePromptDraft(e.target.value)
                              if (voicePromptMessage) setVoicePromptMessage('')
                            }}
                            rows={10}
                            placeholder="ใส่ prompt พากย์เสียงที่ต้องการ"
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-400"
                          />
                          <div className="flex items-center justify-between text-[11px] text-gray-400">
                            <span>{voicePromptSource === 'custom' ? 'กำลังใช้ prompt แบบกำหนดเอง' : 'กำลังใช้ prompt ค่าเริ่มต้น'}</span>
                            <span>{voicePromptDraft.length}/{voicePromptMaxChars}</span>
                          </div>
                          {voicePromptUpdatedAt && (
                            <p className="text-[11px] text-gray-400">อัปเดตล่าสุด: {new Date(voicePromptUpdatedAt).toLocaleString()}</p>
                          )}
                          {voicePromptMessage && (
                            <p className={`text-xs ${voicePromptMessage.includes('ไม่สำเร็จ') || voicePromptMessage.includes('ไม่มีสิทธิ์') ? 'text-red-500' : 'text-green-600'}`}>
                              {voicePromptMessage}
                            </p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                if (voicePromptSaving || voicePromptDraft.length > voicePromptMaxChars) return
                                void saveVoicePrompt(voicePromptDraft)
                              }}
                              disabled={voicePromptSaving || voicePromptDraft.length > voicePromptMaxChars || voicePromptDraft === voicePrompt}
                              className="flex-1 bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all disabled:opacity-40"
                            >
                              {voicePromptSaving ? 'กำลังบันทึก...' : 'บันทึก Prompt'}
                            </button>
                            <button
                              onClick={() => {
                                if (voicePromptSaving) return
                                void saveVoicePrompt('')
                              }}
                              disabled={voicePromptSaving}
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
              </>
            )}
          </div>
        )}
      </div>

      {!videoViewerOpen && (
        <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-t border-gray-100 safe-bottom z-40">
          <div className="flex pt-2 pb-1">
            <NavItem
              icon={<DashboardIcon />}
              iconActive={<DashboardIconFilled />}
              label="Dashboard"
              active={tab === 'dashboard'}
              onClick={() => setTab('dashboard')}
            />
            <NavItem
              icon={<InboxIcon />}
              iconActive={<InboxIconFilled />}
              label="ต้นฉบับ"
              active={tab === 'inbox'}
              onClick={() => setTab('inbox')}
            />
            <NavItem
              icon={<ProcessIcon />}
              iconActive={<ProcessIconFilled />}
              label="Processing"
              active={tab === 'processing'}
              onClick={() => setTab('processing')}
            />
            <NavItem
              icon={<VideoIcon />}
              iconActive={<VideoIconFilled />}
              label="Gallery"
              active={tab === 'gallery'}
              onClick={() => setTab('gallery')}
            />
            <NavItem
              icon={<ListIcon />}
              iconActive={<ListIconFilled />}
              label="Logs"
              active={tab === 'logs'}
              onClick={() => setTab('logs')}
            />
            <NavItem
              icon={<SettingsIcon />}
              iconActive={<SettingsIconFilled />}
              label="Settings"
              active={tab === 'settings'}
              onClick={() => setTab('settings')}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function NavItem({ icon, iconActive, label, active, onClick }: {
  icon: React.ReactNode;
  iconActive: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2 flex flex-col items-center relative group`}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div className={`text-2xl mb-1 transition-all duration-300 ${active ? 'text-blue-600 scale-110' : 'text-gray-400 group-active:scale-95'}`}>
        {active ? iconActive : icon}
      </div>
      <span className={`text-[10px] font-bold tracking-wide transition-colors ${active ? 'text-blue-600' : 'text-gray-400'}`}>
        {label}
      </span>
      {/* Active Line */}
      {active && (
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-blue-600 rounded-b-lg shadow-blue-400 shadow-[0_0_10px_rgba(37,99,235,0.5)]"></div>
      )}
    </button>
  )
}

export default App
