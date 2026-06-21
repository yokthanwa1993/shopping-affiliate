import { workerFetchJson } from '@/api/client'
import { galleryThumbSrc, type GalleryVideo } from '@/api/gallery'
import {
  systemVideoThumbUrl,
  externalVideoUrl,
  type PageVideoItem,
} from '@/api/pagePosts'

// Create Ads contract for the dashboard. The old high-view Page post/video is a
// source signal only: the worker resolves the matching internal system video,
// publishes a NEW Page post/story with that content, then creates/promotes the ad
// from the new story.
//
// The endpoint name remains POST /api/dashboard/create-ad-only for compatibility, but this main path
// no longer means "reuse an existing post without publishing." PAUSED creates a non-spending ad;
// ACTIVE starts spend. Both paths require system_video_id or a resolved internal video_url so the
// worker never silently boosts the old Page post/video directly.
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
  // Echoed old source-signal ids + resulting new story/ad ids.
  page_id?: string
  source_story_id?: string
  source_post_id?: string
  fb_video_id?: string
  system_video_id?: string
  source_signal_story_id?: string
  source_signal_post_id?: string
  source_signal_fb_video_id?: string
  source_signal_system_video_id?: string
  new_story_id?: string
  new_post_id?: string
  new_fb_video_id?: string
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

// Create Ads mutating call. This is the ONLY ad-creation request the Create Ads console makes. It
// hits POST /api/dashboard/create-ad-only — never the mixed create-ad endpoint and never the legacy
// ad-queue endpoints. The worker fails closed if it cannot resolve the internal system video/content
// and records every attempt in dashboard_ad_history.
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

// Result of POST /api/dashboard/ad-only-queue/enqueue — add the same Create Ads input to the cadence
// queue instead of creating it immediately. The scheduler later replays it through
// /api/dashboard/create-ad-only, so the same signal-to-new-post contract still holds.
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

// CREATE ADS ENQUEUE. Adds a Create Ads request to the cadence queue. Same body/contract as
// createAdOnly, so a queued row can never be one that would be rejected at run time.
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

// Read the Create Ads audit trail (GET /api/dashboard/ad-history). Used for the proof panel.
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

// A candidate that can serve as the source signal for an ad. Existing page posts provide old
// story/post/Facebook ids for proof; both page-post and gallery candidates must carry systemVideoId
// so the worker can publish a new Page post from our own content.
export interface AdSourceCandidate {
  kind: AdSourceKind
  /** Stable key for selection + the headline copyable id (System Video ID). */
  refId: string
  title: string
  thumb: string
  linkUrl: string
  shopeeUrl: string
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
    shopeeUrl: video.shopeeLink,
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
    shopeeUrl: (item.shopeeLink ?? '').trim(),
    postedAt: (item.postedAt ?? item.createdAt ?? '').trim(),
    views: typeof item.views === 'number' ? item.views : 0,
    storyId: story,
    postId: post,
    fbVideoId: fb,
    systemVideoId: sys,
  }
}
