// Per-page detail adapter — ports the LINE Mini App PageDetail data contract
// (apps/video-affiliate/webapp/src/App.tsx) to the React dashboard so the team
// can manage a page entirely from the dashboard instead of the LINE Mini App.
//
// All requests go through the same `/worker-api` proxy the rest of the dashboard
// uses (workerFetchJson). The worker routes mirrored here:
//   - GET  /api/pages/:id                       -> core page fields
//   - PUT  /api/pages/:id                        -> save core page fields
//   - GET/PUT /api/pages/:id/shortlink-settings  -> per-page shortlink override
//   - GET/PUT /api/pages/:id/posting-order-settings -> per-page posting order
//   - GET/PUT /api/pages/:id/avatar-settings     -> per-page avatar video
//   - PUT  /api/r2-upload/<key>                  -> avatar video upload
//
// SECURITY: the worker's GET /api/pages/:id returns the raw `access_token`.
// It is NEVER surfaced to React state or the UI here — fetchPageCore drops it
// and exposes only `tokenPresent`. On save the token is written ONLY when the
// operator explicitly types a replacement; otherwise the field is omitted so an
// existing token is never clobbered or echoed back.

import { workerFetchJson, WORKER_API_BASE, CHIEB_NAMESPACE_ID } from '@/api/client'

// ---- Posting token source ------------------------------------------------
// Backend supports exactly two canonical values. Legacy aliases stored in D1
// ('post-reels-token-ads' / 'post-reels-token-cloak') all normalize to
// 'cloak_browser', so the UI shows two cards (Page/Token + CloakBrowser),
// matching the current LINE Mini App source of truth.
export type PostingTokenSource = 'stored_token' | 'cloak_browser'

export function normalizePostingTokenSource(raw?: string | null): PostingTokenSource {
  const value = String(raw || '').trim().toLowerCase()
  if (
    value === 'cloak_browser' ||
    value === 'cloakbrowser' ||
    value === 'cloak' ||
    value === 'post-reels-token-cloak' ||
    value === 'post-reels-token-ads'
  ) {
    return 'cloak_browser'
  }
  return 'stored_token'
}

// Per-page COMMENT token source — same two canonical values, but chosen independently of
// the posting source. A missing/invalid value falls back to the page's posting source so
// the dashboard mirrors the backend default (comment follows the effective posting source).
export type CommentTokenSource = 'stored_token' | 'cloak_browser'

export function normalizeCommentTokenSource(
  raw: string | null | undefined,
  fallback: PostingTokenSource,
): CommentTokenSource {
  const value = String(raw ?? '').trim().toLowerCase()
  if (
    value === 'cloak_browser' ||
    value === 'cloakbrowser' ||
    value === 'cloak' ||
    value === 'post-reels-token-cloak' ||
    value === 'post-reels-token-ads'
  ) {
    return 'cloak_browser'
  }
  if (value === 'stored_token' || value === 'stored' || value === 'token' || value === 'page' || value === 'page_token') {
    return 'stored_token'
  }
  return fallback
}

export type OneCardLinkMode = 'shopee' | 'lazada' | 'none'
export type OneCardCta = 'SHOP_NOW' | 'NO_BUTTON'
export type PostingOrderOption = 'oldest_first' | 'newest_first' | 'random'

// Core page fields surfaced in the detail screen. Mirrors the LINE FacebookPage
// type minus the raw access_token (presence only).
export interface PageCore {
  id: string
  name: string
  imageUrl: string
  postIntervalMinutes: number
  postHours: string
  isActive: boolean
  oneCardEnabled: boolean
  adsPublishEnabled: boolean
  captionLinkEnabled: boolean
  oneCardLinkMode: OneCardLinkMode
  oneCardCta: OneCardCta
  postingTokenSource: PostingTokenSource
  commentTokenSource: CommentTokenSource
  /** True when the worker has a posting access token stored. Never the value. */
  tokenPresent: boolean
  lastPostAt: string
  updatedAt: string
}

interface RawPage {
  id?: string
  name?: string
  image_url?: string
  access_token?: string
  post_interval_minutes?: number
  post_hours?: string
  is_active?: number
  onecard_enabled?: number
  ads_publish_enabled?: number
  caption_link_enabled?: number
  onecard_link_mode?: string
  onecard_cta?: string
  posting_token_source?: string
  comment_token_source?: string
  last_post_at?: string
  updated_at?: string
}

function normalizeLinkMode(raw?: string): OneCardLinkMode {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'lazada') return 'lazada'
  if (value === 'none') return 'none'
  return 'shopee'
}

function normalizeCta(raw?: string): OneCardCta {
  return String(raw || '').trim().toUpperCase() === 'NO_BUTTON' ? 'NO_BUTTON' : 'SHOP_NOW'
}

export async function fetchPageCore(pageId: string, signal?: AbortSignal): Promise<PageCore> {
  const data = await workerFetchJson<{ page?: RawPage; error?: string }>(
    `/api/pages/${encodeURIComponent(pageId)}`,
    { signal, timeoutMs: 15_000 },
  )
  const page = data.page || {}
  return {
    id: String(page.id || pageId),
    name: String(page.name || ''),
    imageUrl: String(page.image_url || ''),
    postIntervalMinutes: Number(page.post_interval_minutes) || 60,
    postHours: String(page.post_hours || ''),
    isActive: page.is_active === 1,
    oneCardEnabled: page.onecard_enabled === 1,
    adsPublishEnabled: page.ads_publish_enabled === 1,
    captionLinkEnabled: page.caption_link_enabled === 1,
    oneCardLinkMode: normalizeLinkMode(page.onecard_link_mode),
    oneCardCta: normalizeCta(page.onecard_cta),
    postingTokenSource: normalizePostingTokenSource(page.posting_token_source),
    // Comment source defaults to the posting source when unset (backend parity).
    commentTokenSource: normalizeCommentTokenSource(
      page.comment_token_source,
      normalizePostingTokenSource(page.posting_token_source),
    ),
    // Presence only — the raw token string is intentionally dropped here.
    tokenPresent: !!String(page.access_token || '').trim(),
    lastPostAt: String(page.last_post_at || ''),
    updatedAt: String(page.updated_at || ''),
  }
}

// Core page save. `newToken` is the write-only replacement typed by the
// operator; when blank the access_token field is omitted entirely.
export interface SavePageCoreInput {
  postHours: string
  postIntervalMinutes?: number
  isActive: boolean
  basePostHours: string
  basePostIntervalMinutes: number | null
  baseIsActive: number
  oneCardEnabled: boolean
  adsPublishEnabled: boolean
  captionLinkEnabled: boolean
  oneCardLinkMode: OneCardLinkMode
  oneCardCta: OneCardCta
  postingTokenSource: PostingTokenSource
  commentTokenSource: CommentTokenSource
  newToken?: string
}

export async function savePageCore(pageId: string, input: SavePageCoreInput): Promise<void> {
  const payload: Record<string, unknown> = {
    post_hours: input.postHours,
    post_interval_minutes: input.postIntervalMinutes,
    is_active: input.isActive,
    base_post_hours: input.basePostHours,
    base_post_interval_minutes: input.basePostIntervalMinutes,
    base_is_active: input.baseIsActive,
    onecard_enabled: input.oneCardEnabled,
    ads_publish_enabled: input.adsPublishEnabled,
    caption_link_enabled: input.captionLinkEnabled,
    onecard_link_mode: input.oneCardLinkMode,
    onecard_cta: input.oneCardCta,
    posting_token_source: input.postingTokenSource,
    comment_token_source: input.commentTokenSource,
  }
  const trimmed = (input.newToken ?? '').trim()
  if (trimmed) payload.access_token = trimmed

  await workerFetchJson(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'PUT',
    timeoutMs: 15_000,
    body: payload,
  })
}

// ---- Shortlink override --------------------------------------------------
export interface PageShortlinkSettingsForm {
  override_enabled: boolean
  account: string
  base_url: string
  lazada_base_url: string
  expected_utm_id: string
  lazada_expected_member_id: string
  shortlink_url_template: string
  sub_id1: string
  sub_id2: string
  sub_id3: string
  sub_id4: string
  sub_id5: string
  updated_at?: string | null
}

export interface PageShortlinkSettingsResponse {
  ok?: boolean
  global?: Partial<PageShortlinkSettingsForm>
  override?: Partial<PageShortlinkSettingsForm>
  max_account_chars?: number
  max_chars?: number
  max_expected_utm_chars?: number
  max_lazada_member_id_chars?: number
  max_template_chars?: number
  max_sub_id_chars?: number
  error?: string
}

export const createEmptyPageShortlinkSettingsForm = (): PageShortlinkSettingsForm => ({
  override_enabled: false,
  account: '',
  base_url: '',
  lazada_base_url: '',
  expected_utm_id: '',
  lazada_expected_member_id: '',
  shortlink_url_template: '',
  sub_id1: '',
  sub_id2: '',
  sub_id3: '',
  sub_id4: '',
  sub_id5: '',
  updated_at: null,
})

export const normalizePageShortlinkSettingsForm = (
  raw?: Partial<PageShortlinkSettingsForm> | null,
): PageShortlinkSettingsForm => ({
  ...createEmptyPageShortlinkSettingsForm(),
  override_enabled: raw?.override_enabled === true,
  account: String(raw?.account || ''),
  base_url: String(raw?.base_url || ''),
  lazada_base_url: String(raw?.lazada_base_url || ''),
  expected_utm_id: String(raw?.expected_utm_id || ''),
  lazada_expected_member_id: String(raw?.lazada_expected_member_id || ''),
  shortlink_url_template: String(raw?.shortlink_url_template || ''),
  sub_id1: String(raw?.sub_id1 || ''),
  sub_id2: String(raw?.sub_id2 || ''),
  sub_id3: String(raw?.sub_id3 || ''),
  sub_id4: String(raw?.sub_id4 || ''),
  sub_id5: String(raw?.sub_id5 || ''),
  updated_at: raw?.updated_at ?? null,
})

export async function fetchPageShortlinkSettings(
  pageId: string,
  signal?: AbortSignal,
): Promise<PageShortlinkSettingsResponse> {
  return workerFetchJson<PageShortlinkSettingsResponse>(
    `/api/pages/${encodeURIComponent(pageId)}/shortlink-settings`,
    { signal, timeoutMs: 15_000 },
  )
}

export async function savePageShortlinkSettings(
  pageId: string,
  form: PageShortlinkSettingsForm,
): Promise<PageShortlinkSettingsResponse> {
  return workerFetchJson<PageShortlinkSettingsResponse>(
    `/api/pages/${encodeURIComponent(pageId)}/shortlink-settings`,
    {
      method: 'PUT',
      timeoutMs: 15_000,
      body: {
        override_enabled: form.override_enabled,
        account: form.account.trim(),
        base_url: form.base_url.trim(),
        lazada_base_url: form.lazada_base_url.trim(),
        expected_utm_id: form.expected_utm_id.trim(),
        lazada_expected_member_id: form.lazada_expected_member_id.trim(),
        shortlink_url_template: form.shortlink_url_template.trim(),
        sub_id1: form.sub_id1.trim(),
        sub_id2: form.sub_id2.trim(),
        sub_id3: form.sub_id3.trim(),
        sub_id4: form.sub_id4.trim(),
        sub_id5: form.sub_id5.trim(),
      },
    },
  )
}

// ---- Posting order -------------------------------------------------------
export const POSTING_ORDER_OPTIONS: Array<{ value: PostingOrderOption; title: string; subtitle: string }> = [
  { value: 'newest_first', title: 'โพสต์ใหม่สุดก่อน', subtitle: 'หยิบคลิปล่าสุดก่อน' },
  { value: 'oldest_first', title: 'โพสต์เก่าสุดก่อน', subtitle: 'ไล่จากคลิปเก่าก่อน' },
  { value: 'random', title: 'โพสต์สุ่ม', subtitle: 'สุ่มจากคลิปที่ยังไม่โพสต์' },
]

export const normalizePostingOrderOption = (
  rawValue: unknown,
  fallback: PostingOrderOption = 'oldest_first',
): PostingOrderOption => {
  const value = String(rawValue || '').trim()
  return POSTING_ORDER_OPTIONS.some((option) => option.value === value)
    ? (value as PostingOrderOption)
    : fallback
}

export const getPostingOrderOptionMeta = (value: PostingOrderOption) =>
  POSTING_ORDER_OPTIONS.find((option) => option.value === value) || POSTING_ORDER_OPTIONS[1]

export interface PagePostingOrderSettingsResponse {
  ok?: boolean
  global?: { posting_order?: PostingOrderOption | string; source?: string; updated_at?: string | null }
  override?: {
    override_enabled?: boolean
    posting_order?: PostingOrderOption | string
    updated_at?: string | null
  }
  effective?: {
    source?: 'global' | 'page'
    posting_order?: PostingOrderOption | string
    updated_at?: string | null
    page_override_enabled?: boolean
    page_posting_order?: PostingOrderOption | string
    page_updated_at?: string | null
    global_posting_order?: PostingOrderOption | string
    global_updated_at?: string | null
  }
  error?: string
}

export async function fetchPagePostingOrderSettings(
  pageId: string,
  signal?: AbortSignal,
): Promise<PagePostingOrderSettingsResponse> {
  return workerFetchJson<PagePostingOrderSettingsResponse>(
    `/api/pages/${encodeURIComponent(pageId)}/posting-order-settings`,
    { signal, timeoutMs: 15_000 },
  )
}

export async function savePagePostingOrderSettings(
  pageId: string,
  overrideEnabled: boolean,
  postingOrder: PostingOrderOption,
): Promise<PagePostingOrderSettingsResponse> {
  return workerFetchJson<PagePostingOrderSettingsResponse>(
    `/api/pages/${encodeURIComponent(pageId)}/posting-order-settings`,
    {
      method: 'PUT',
      timeoutMs: 15_000,
      body: { override_enabled: overrideEnabled, posting_order: postingOrder },
    },
  )
}

// ---- Avatar video --------------------------------------------------------
export interface PageAvatarSettingsView {
  enabled: boolean
  has_video: boolean
  version: string
  updated_at: string
}

export interface PageAvatarSettingsResponse {
  ok?: boolean
  settings?: Partial<PageAvatarSettingsView>
  error?: string
}

export const normalizePageAvatarSettings = (
  raw?: Partial<PageAvatarSettingsView> | null,
): PageAvatarSettingsView => ({
  enabled: raw?.enabled === true,
  has_video: raw?.has_video === true,
  version: String(raw?.version || ''),
  updated_at: String(raw?.updated_at || ''),
})

export async function fetchPageAvatarSettings(
  pageId: string,
  signal?: AbortSignal,
): Promise<PageAvatarSettingsResponse> {
  return workerFetchJson<PageAvatarSettingsResponse>(
    `/api/pages/${encodeURIComponent(pageId)}/avatar-settings`,
    { signal, timeoutMs: 15_000 },
  )
}

function buildPageAvatarUploadKey(pageId: string, version: string): string {
  const safePageId = String(pageId || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  const safeVersion = String(version || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  if (!safePageId || !safeVersion) return ''
  return `page-assets/${safePageId}/avatar/${safeVersion}.mp4`
}

// Raw binary PUT to the R2 upload route — bypasses workerFetchJson because the
// body is a video File, not JSON. Still carries the namespace header so the
// worker resolves the right tenant.
async function uploadAvatarVideo(pageId: string, version: string, file: File): Promise<void> {
  const key = buildPageAvatarUploadKey(pageId, version)
  if (!key) throw new Error('สร้างที่เก็บวิดีโอ Avatar ไม่สำเร็จ')
  const resp = await fetch(`${WORKER_API_BASE}/api/r2-upload/${key}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'Content-Type': file.type || 'video/mp4',
      'x-bot-id': CHIEB_NAMESPACE_ID,
    },
    body: file,
  })
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || `อัปโหลด Avatar ไม่สำเร็จ (${resp.status})`)
  }
}

export async function savePageAvatarSettings(
  pageId: string,
  input: { enabled: boolean; version: string; removeVideo: boolean; file: File | null },
): Promise<PageAvatarSettingsView> {
  let nextVersion = input.version
  let clearVideo = input.removeVideo
  if (input.file) {
    if (!String(input.file.type || '').startsWith('video/')) {
      throw new Error('ไฟล์ Avatar ต้องเป็นวิดีโอ')
    }
    nextVersion = String(Date.now())
    await uploadAvatarVideo(pageId, nextVersion, input.file)
    clearVideo = false
  }

  const data = await workerFetchJson<PageAvatarSettingsResponse>(
    `/api/pages/${encodeURIComponent(pageId)}/avatar-settings`,
    {
      method: 'PUT',
      timeoutMs: 15_000,
      body: { enabled: input.enabled, version: nextVersion, clear_video: clearVideo },
    },
  )
  return normalizePageAvatarSettings(data.settings)
}

// ---- Force post (destructive — confirm-gated by the caller) --------------
export interface ForcePostResult {
  fbReelUrl: string
  fbPostId: string
}

export async function forcePost(pageId: string): Promise<ForcePostResult> {
  const data = await workerFetchJson<{
    success?: boolean
    error?: string
    details?: string
    fb_reel_url?: string
    fb_post_id?: string
  }>(`/api/pages/${encodeURIComponent(pageId)}/force-post`, {
    method: 'POST',
    timeoutMs: 120_000,
    body: { skipComment: false },
  })
  return { fbReelUrl: String(data.fb_reel_url || ''), fbPostId: String(data.fb_post_id || '') }
}

// ---- Schedule helpers (post_hours parsing) -------------------------------
export type ScheduleMode = 'slots' | 'interval'

export function parsePostHours(raw: string): Record<number, number> {
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

export function detectScheduleMode(raw?: string): ScheduleMode {
  return /^every:\d+$/i.test(String(raw || '').trim()) ? 'interval' : 'slots'
}

export function normalizeInterval(value: number): number {
  const parsed = Number.isFinite(value) ? Math.floor(value) : 60
  return Math.max(5, Math.min(720, parsed))
}

export function parseInterval(raw?: string, fallback = 60): number {
  const match = String(raw || '').trim().match(/^every:(\d{1,4})$/i)
  if (!match) return normalizeInterval(fallback)
  return normalizeInterval(parseInt(match[1], 10))
}
