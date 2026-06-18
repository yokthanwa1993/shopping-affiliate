import { workerFetchJson } from '@/api/client'
import { galleryThumbSrc, type GalleryVideo } from '@/api/gallery'
import {
  systemVideoThumbUrl,
  externalVideoUrl,
  type PageVideoItem,
} from '@/api/pagePosts'

// AD-ONLY contract for the dashboard. The mental model here is deliberately the
// inverse of Create Post: an ad is built FROM something that already exists — an
// existing page post/story, or an existing system/Facebook video — and creating
// an ad must never publish a new post.
//
// The dedicated ad-only flow is wired end-to-end: POST /api/dashboard/create-ad-only builds an ad
// FROM an existing post/story/video through the CloakBrowser FB bridge in PAUSED mode
// (skip_publish_to_page + skip_comment + paused) — it creates a NON-SPENDING ad, never publishes a
// new Page post, never writes post_history, and records every attempt in dashboard_ad_history. It
// does NOT call the legacy mixed create-ad / ad-queue flows. The bridge keeps its default ACTIVE
// behavior for every other caller; only this ad-only path sends the paused flag.
//
// READY=true means the submit action really creates the (paused) ad and shows the created ids +
// effective_object_story_id + click link in the proof panel. The created ad is PAUSED, so an
// operator still has to review + activate it in Ads Manager before it can spend.
export const DASHBOARD_AD_CREATE_READY = true

// Result of POST /api/dashboard/create-ad-only. The endpoint returns HTTP 200 with ok:false for
// the deliberate "not enabled yet" and validation cases (so the body is always readable), and the
// structured fields below let the proof panel show exactly what happened / what is missing.
export interface CreateAdOnlyResult {
  ok: boolean
  error?: string
  detail?: string
  reason?: string
  missing_bridge_fields?: string[]
  history_id?: number
  // Echoed source ids + (on a future real success) the created ad ids.
  page_id?: string
  source_story_id?: string
  source_post_id?: string
  fb_video_id?: string
  system_video_id?: string
  campaign_id?: string
  campaign_name?: string
  adset_id?: string
  ad_id?: string
  creative_id?: string
  effective_object_story_id?: string
  click_link?: string
  // Lifecycle status reported by the bridge — 'PAUSED' for the review path, 'ACTIVE' for the
  // scheduled/spending path. campaign_status is present only when this request CREATED the campaign
  // (omitted when an existing one is reused).
  adset_status?: string
  ad_status?: string
  campaign_status?: string
  paused?: boolean
  // Echoed operator scheduling/budget. mode mirrors the request; daily_budget (Meta minor units) /
  // start_time / end_time are returned by the bridge on the active/scheduled path.
  mode?: AdOnlyMode
  daily_budget?: number | string
  start_time?: string
  end_time?: string
}

// 'paused' = non-spending review ad (operator activates later in Ads Manager).
// 'active'  = a LIVE, SPENDING ad — the bridge applies the budget + run-hours schedule and activates.
export type AdOnlyMode = 'paused' | 'active'

export interface CreateAdOnlyInput {
  pageId: string
  storyId?: string
  postId?: string
  fbVideoId?: string
  systemVideoId?: string
  shopeeUrl?: string
  caption?: string
  adName?: string
  // Operator scheduling/budget. mode defaults to 'paused' (review). For 'active', dailyCampaignName
  // is REQUIRED (the date-named campaign that carries the per-adset budget + schedule).
  mode?: AdOnlyMode
  dailyCampaignName?: string
  dailyBudgetThb?: number
  runHours?: number
}

// AD-ONLY mutating call. This is the ONLY ad-creation request the Create Ads console makes. It
// hits POST /api/dashboard/create-ad-only — never /api/dashboard/create-ad and never the ad-queue
// legacy endpoints. The worker fails closed (no Page post, no post_history) and records the
// attempt in dashboard_ad_history.
export async function createAdOnly(input: CreateAdOnlyInput): Promise<CreateAdOnlyResult> {
  return workerFetchJson<CreateAdOnlyResult>('/api/dashboard/create-ad-only', {
    method: 'POST',
    timeoutMs: 120_000,
    body: {
      page_id: input.pageId,
      story_id: input.storyId ?? '',
      post_id: input.postId ?? '',
      fb_video_id: input.fbVideoId ?? '',
      system_video_id: input.systemVideoId ?? '',
      shopee_url: input.shopeeUrl ?? '',
      caption: input.caption ?? '',
      ad_name: input.adName ?? '',
      // Scheduling/budget. mode defaults to 'paused' (review); 'active' sends the date-named
      // campaign + whole-THB budget + run-hours so the worker creates a live, scheduled ad.
      mode: input.mode ?? 'paused',
      daily_campaign_name: input.dailyCampaignName ?? '',
      daily_budget_thb: input.dailyBudgetThb ?? 0,
      run_hours: input.runHours ?? 0,
    },
  })
}

// Result of POST /api/dashboard/ad-only-queue/enqueue — add the same ad-only input to the cadence
// queue instead of creating it immediately. The scheduler later replays it through
// /api/dashboard/create-ad-only (never the legacy create-ad), so all ad-only invariants still hold.
export interface EnqueueAdOnlyResult {
  ok: boolean
  error?: string
  detail?: string
  queue_id?: number
  mode?: AdOnlyMode
  queued_count?: number
  interval_minutes?: number
  next_run_at?: string
}

// AD-ONLY ENQUEUE. Adds an ad-only request to the cadence queue. Same body/contract as createAdOnly,
// so a queued row can never be one that would be rejected at run time. Never touches the page-publish
// or legacy ad-queue lanes.
export async function enqueueAdOnly(input: CreateAdOnlyInput): Promise<EnqueueAdOnlyResult> {
  return workerFetchJson<EnqueueAdOnlyResult>('/api/dashboard/ad-only-queue/enqueue', {
    method: 'POST',
    timeoutMs: 20_000,
    body: {
      page_id: input.pageId,
      story_id: input.storyId ?? '',
      post_id: input.postId ?? '',
      fb_video_id: input.fbVideoId ?? '',
      system_video_id: input.systemVideoId ?? '',
      shopee_url: input.shopeeUrl ?? '',
      caption: input.caption ?? '',
      ad_name: input.adName ?? '',
      mode: input.mode ?? 'paused',
      daily_campaign_name: input.dailyCampaignName ?? '',
      daily_budget_thb: input.dailyBudgetThb ?? 0,
      run_hours: input.runHours ?? 0,
    },
  })
}

// Default daily-campaign name in the legacy daily-campaign style — Bangkok calendar date as
// "DD/Mon/YYYY" (e.g. "18/Jun/2026"). Same-date ad-only runs reuse one campaign (the bridge's
// daily-campaign reuse path); the operator can override the value in the UI.
export function defaultDailyCampaignName(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('day')}/${get('month')}/${get('year')}`
}

export interface AdHistoryItem {
  id: number
  created_at: string
  completed_at: string
  status: string
  page_id: string
  source_story_id: string
  source_post_id: string
  fb_video_id: string
  system_video_id: string
  campaign_id: string
  campaign_name: string
  adset_id: string
  ad_id: string
  creative_id: string
  effective_object_story_id: string
  click_link: string
  error_message: string
  truncated_result_json: string
  // Scheduling/budget audit (additive columns; '' on rows created before the migration).
  mode?: string
  daily_budget?: string
  run_hours?: string
  start_time?: string
  end_time?: string
}

// Read the ad-only audit trail (GET /api/dashboard/ad-history). Used for the proof panel.
export async function fetchAdHistory(
  params: { pageId?: string; status?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<AdHistoryItem[]> {
  const qs = new URLSearchParams()
  if (params.pageId) qs.set('page_id', params.pageId)
  if (params.status) qs.set('status', params.status)
  qs.set('limit', String(params.limit ?? 20))
  const data = await workerFetchJson<{ ok?: boolean; items?: AdHistoryItem[] }>(
    `/api/dashboard/ad-history?${qs.toString()}`,
    { signal },
  )
  return data.items ?? []
}

export type AdSourceKind = 'gallery' | 'page-post'

// A candidate that can serve as the INPUT to an ad. For an existing page post
// the meaningful ad inputs are its story/post id and its Facebook/system video
// id; gallery clips carry only a system video id (no published story yet).
export interface AdSourceCandidate {
  kind: AdSourceKind
  /** Stable key for selection + the headline copyable id (System Video ID). */
  refId: string
  title: string
  thumb: string
  linkUrl: string
  postedAt: string
  views: number
  // Ad input ids — present where the source exposes them. Empty string when n/a.
  storyId: string
  postId: string
  fbVideoId: string
  systemVideoId: string
}

export function galleryToAdSource(video: GalleryVideo): AdSourceCandidate | null {
  if (!video.id) return null
  return {
    kind: 'gallery',
    refId: video.id,
    title: video.title || video.id,
    thumb: galleryThumbSrc(video),
    linkUrl: video.publicUrl,
    postedAt: video.postedAt || video.createdAt,
    views: 0,
    storyId: '',
    postId: '',
    fbVideoId: '',
    systemVideoId: video.id,
  }
}

export function pagePostToAdSource(item: PageVideoItem): AdSourceCandidate | null {
  const sys = (item.systemVideoId ?? '').trim()
  const fb = (item.videoId ?? '').trim()
  const story = (item.storyId ?? '').trim()
  const post = (item.postId ?? '').trim()
  // Prefer the system video id as the headline ref; fall back to FB video id,
  // then the story id so an existing-post card always has a usable key.
  const refId = sys || (fb ? `FB:${fb}` : '') || story || post
  if (!refId) return null
  return {
    kind: 'page-post',
    refId,
    title: (item.videoTitle ?? '').trim() || refId,
    thumb:
      (item.facebookThumb ?? '').trim() ||
      (item.videoThumb ?? '').trim() ||
      systemVideoThumbUrl(item) ||
      '',
    linkUrl: (item.postUrl ?? '').trim() || externalVideoUrl(item) || '',
    postedAt: (item.postedAt ?? item.createdAt ?? '').trim(),
    views: typeof item.views === 'number' ? item.views : 0,
    storyId: story,
    postId: post,
    fbVideoId: fb,
    systemVideoId: sys,
  }
}
