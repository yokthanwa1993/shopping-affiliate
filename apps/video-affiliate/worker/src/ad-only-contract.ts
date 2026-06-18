// AD-ONLY contract — pure, network-free helpers for POST /api/dashboard/create-ad-only.
//
// The ad-only endpoint builds a Meta ad FROM something that ALREADY exists (an existing page
// post/story, or an existing Facebook/system video) and must NEVER publish a new Page post.
// It is deliberately separate from:
//   - the Page Post flow  (POST /api/pages/:id/force-post → post_history, cron — UNTOUCHED)
//   - the legacy hybrid   (POST /api/dashboard/create-ad → mixed post+ad — UNTOUCHED)
// so that ad creation can never have a page-publish side effect and has its own audit trail
// (dashboard_ad_history). This module holds the input validation, the bridge-capability gate,
// and the audit-row shaping so all of it is unit-testable without a live Graph / bridge.

export interface AdOnlyInputBody {
    page_id?: string
    // Ad source — at least one of these existing-post/video ids is REQUIRED. system_video_id is
    // audit-only and is NEVER, on its own, treated as permission to publish a new Page post.
    story_id?: string
    post_id?: string
    fb_video_id?: string
    video_id?: string
    system_video_id?: string
    source_video_id?: string
    // Explicitly NOT supported in ad-only for this phase — a video_url-only flow would require
    // uploading + publishing a new post. Presence is rejected (fail closed).
    video_url?: string
    // Optional ad metadata forwarded to existing helpers when a real ad path is enabled.
    shopee_url?: string
    original_link?: string
    caption?: string
    ad_name?: string
    template_adset?: string
    placement_template?: string
    campaign_id?: string
    new_campaign_name?: string
    daily_campaign_name?: string
    comment_shortlink?: string
    // Operator-set scheduling/budget for the ad-only run. `mode` selects the lifecycle:
    //   'paused' (default) — non-spending review ad (current behavior).
    //   'active'/'scheduled' — a LIVE, SPENDING ad: the bridge applies the daily-campaign budget +
    //     run-hours schedule and activates the adset + ad.
    mode?: string
    // Daily budget expressed in WHOLE THB (e.g. 10000). Converted to Meta minor units (THB*100) for
    // the bridge's campaign_daily_budget (CAMPAIGN-level CBO). daily_budget (minor units) is accepted
    // as a raw alias.
    daily_budget_thb?: number | string
    daily_budget?: number | string
    // Run window length in hours (e.g. 24). adset_run_hours is accepted as an alias.
    run_hours?: number | string
    adset_run_hours?: number | string
}

export interface AdOnlyValidation {
    ok: boolean
    /** Stable machine error code when ok is false. */
    error?: string
    /** Human/diagnostic detail when ok is false. */
    detail?: string
    pageId: string
    sourceStoryId: string
    sourcePostId: string
    fbVideoId: string
    systemVideoId: string
    /** True when at least one real ad source (story/post/fb video) was supplied. */
    hasAdSource: boolean
}

const str = (v: unknown): string => String(v ?? '').trim()

// Validate ad-only input and fail CLOSED. Rules:
//   1. page_id is required.
//   2. video_url is rejected — ad-only never uploads/publishes a new post in this phase.
//   3. At least one of story_id / post_id / fb_video_id is required. A system_video_id alone is
//      audit metadata, NOT an existing-post/video reference, so it cannot authorize ad creation.
export function validateAdOnlyInput(body: AdOnlyInputBody | null | undefined): AdOnlyValidation {
    const b = body || {}
    const pageId = str(b.page_id)
    const sourceStoryId = str(b.story_id)
    const sourcePostId = str(b.post_id)
    // Accept either fb_video_id or the generic video_id as the existing Facebook video reference.
    const fbVideoId = str(b.fb_video_id) || str(b.video_id)
    const systemVideoId = str(b.system_video_id) || str(b.source_video_id)
    const videoUrl = str(b.video_url)
    const hasAdSource = !!(sourceStoryId || sourcePostId || fbVideoId)

    const base = { pageId, sourceStoryId, sourcePostId, fbVideoId, systemVideoId, hasAdSource }

    if (!pageId) {
        return { ok: false, error: 'page_id_required', detail: 'page_id is required for ad-only', ...base }
    }
    // Fail closed: a video_url-only request would force a brand-new upload/publish. Ad-only must
    // build from an existing post/video, so reject any video_url here.
    if (videoUrl) {
        return {
            ok: false,
            error: 'ad_only_no_new_post',
            detail: 'video_url is not allowed in ad-only — provide an existing story_id/post_id/fb_video_id instead',
            ...base,
        }
    }
    if (!hasAdSource) {
        return {
            ok: false,
            error: 'ad_source_required',
            detail: 'at least one of story_id, post_id or fb_video_id is required (system_video_id alone is audit-only and never authorizes publishing)',
            ...base,
        }
    }
    return { ok: true, ...base }
}

// Operator scheduling/budget for an ad-only run. 'paused' creates a non-spending review ad (no
// budget/schedule/activation). 'active' creates a LIVE, SPENDING ad via the bridge daily-campaign
// path (date-named campaign + per-adset daily budget + run-hours schedule + activation).
export type AdOnlyMode = 'paused' | 'active'

// Budget/run-hours bounds. THB whole-baht budget is converted to Meta minor units (THB*100). On the
// active daily path this is the CAMPAIGN-level (CBO) daily budget; default 10,000 THB/day
// (1_000_000 minor units), matching the operator's Ads Manager template.
export const DEFAULT_DAILY_BUDGET_THB = 10_000
export const MIN_DAILY_BUDGET_THB = 1
export const MAX_DAILY_BUDGET_THB = 100_000
export const DEFAULT_RUN_HOURS = 24
export const MIN_RUN_HOURS = 1
export const MAX_RUN_HOURS = 24 * 30 // 30 days

export interface AdOnlySchedule {
    ok: boolean
    /** Stable machine error code when ok is false. */
    error?: string
    detail?: string
    mode: AdOnlyMode
    /** True for the non-spending review path. */
    paused: boolean
    /** Date-named campaign for the daily-campaign reuse path (required when mode is 'active'). */
    dailyCampaignName: string
    /** Budget in whole THB (clamped, defaulted). */
    dailyBudgetThb: number
    /** Budget in Meta minor units (THB*100) — the CAMPAIGN-level (CBO) daily budget the bridge
     * expects as campaign_daily_budget on the active daily path (NOT a per-adset budget). */
    dailyBudgetMinor: number
    /** Run window length in hours (clamped, defaulted). */
    runHours: number
}

const toNum = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
    return Number.isFinite(n) ? n : NaN
}
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

// Resolve + validate the operator-set scheduling/budget. Fails CLOSED:
//   - 'active' mode REQUIRES a daily_campaign_name. The date-named daily campaign carries the
//     CAMPAIGN-level (CBO) budget and the run-hours schedule lives on its budget-free adset; without
//     a campaign name the bridge would fall back to a prefix campaign that does not match the
//     operator's template. So an active request with no campaign name is rejected rather than
//     silently creating a mis-grouped ad.
//   - Budget/run-hours are clamped to safe bounds and defaulted, never thrown on.
// 'paused' (the default) ignores campaign-name/budget/schedule entirely — it never spends.
export function resolveAdOnlySchedule(body: AdOnlyInputBody | null | undefined): AdOnlySchedule {
    const b = body || {}
    const rawMode = str(b.mode).toLowerCase()
    const mode: AdOnlyMode = rawMode === 'active' || rawMode === 'scheduled' || rawMode === 'live' ? 'active' : 'paused'
    const paused = mode !== 'active'
    const dailyCampaignName = str(b.daily_campaign_name)

    // Budget: prefer whole-THB; else treat the minor-units alias as already in minor units.
    let dailyBudgetThb = toNum(b.daily_budget_thb)
    if (!Number.isFinite(dailyBudgetThb) || dailyBudgetThb <= 0) {
        const minorAlias = toNum(b.daily_budget)
        dailyBudgetThb = Number.isFinite(minorAlias) && minorAlias > 0 ? minorAlias / 100 : DEFAULT_DAILY_BUDGET_THB
    }
    dailyBudgetThb = clamp(Math.round(dailyBudgetThb), MIN_DAILY_BUDGET_THB, MAX_DAILY_BUDGET_THB)
    const dailyBudgetMinor = dailyBudgetThb * 100

    let runHours = toNum(b.run_hours)
    if (!Number.isFinite(runHours) || runHours <= 0) runHours = toNum(b.adset_run_hours)
    if (!Number.isFinite(runHours) || runHours <= 0) runHours = DEFAULT_RUN_HOURS
    runHours = clamp(Math.round(runHours), MIN_RUN_HOURS, MAX_RUN_HOURS)

    const base = { mode, paused, dailyCampaignName, dailyBudgetThb, dailyBudgetMinor, runHours }

    if (mode === 'active' && !dailyCampaignName) {
        return {
            ok: false,
            error: 'ad_only_campaign_name_required',
            detail: 'active/scheduled ad-only requires a daily_campaign_name (the date-named campaign that carries the per-adset budget + run-hours schedule)',
            ...base,
        }
    }
    return { ok: true, ...base }
}

// Bridge-capability gate. The CloakBrowser FB bridge create-ad/promote paths route through
// buildAdFromCreative, which now supports a PAUSED ad-only path: when the worker sends
// `paused:true` (alias `status_option:'PAUSED'`), the bridge leaves the copied adset + ad PAUSED —
// NO budget/schedule POST, NO activation POST, NO ACTIVE readback — and reports adset_status/
// ad_status = 'PAUSED'. So ad-only can create a NON-SPENDING ad. The default (no flag) path is
// unchanged and stays ACTIVE; legacy /api/dashboard/create-ad never sets the flag.
//
// Set back to false to hard-disable ad-only creation (the endpoint then fails closed without
// touching the bridge). AD_ONLY_MISSING_BRIDGE_FIELDS documents what the paused path requires.
export const AD_ONLY_BRIDGE_SUPPORTS_PAUSED = true

// Exact bridge work required before ad-only ACTIVE-free creation can be enabled. Surfaced in the
// endpoint's unsupported response so the operator/Hermes sees precisely what is missing.
export const AD_ONLY_MISSING_BRIDGE_FIELDS: string[] = [
    'bridge POST /create-ad + /promote: accept a `paused` (status_option:PAUSED) flag',
    'bridge buildAdFromCreative: when paused, SKIP step 8a budget POST, 8b adset activation, 8c ad activation and 8d ACTIVE readback (the copied adset is already status_option:PAUSED and the ad is created status:PAUSED)',
    'bridge response: return adset_status:"PAUSED" + ad_status:"PAUSED" so the worker can record a non-spending ad',
]

export interface AdOnlyUnsupportedResult {
    ok: false
    error: string
    reason: string
    missing_bridge_fields: string[]
    // Echo the validated source so the dashboard proof panel can show what WOULD have been used.
    page_id: string
    source_story_id: string
    source_post_id: string
    fb_video_id: string
    system_video_id: string
}

// The structured "not yet enabled" response. Distinct, stable error code so the dashboard can
// render a precise notice instead of a generic failure, and so a future real path is a one-line
// gate flip rather than a new endpoint.
export function buildAdOnlyUnsupportedResult(v: AdOnlyValidation): AdOnlyUnsupportedResult {
    return {
        ok: false,
        error: 'ad_only_bridge_paused_unsupported',
        reason: 'The Facebook bridge force-activates new ads/adsets to ACTIVE and exposes no PAUSED path; ad-only refuses to create a live ad. No ad was created.',
        missing_bridge_fields: AD_ONLY_MISSING_BRIDGE_FIELDS,
        page_id: v.pageId,
        source_story_id: v.sourceStoryId,
        source_post_id: v.sourcePostId,
        fb_video_id: v.fbVideoId,
        system_video_id: v.systemVideoId,
    }
}

export interface AdHistoryRecord {
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
    // Operator scheduling/budget audit. mode/run_hours are worker-side intent; daily_budget (minor
    // units — the CAMPAIGN-level CBO budget) / start_time / end_time are echoed from the bridge
    // result on the active/scheduled path. The column name stays `daily_budget` for compatibility.
    mode: string
    daily_budget: string
    run_hours: string
    start_time: string
    end_time: string
}

// =====================================================================
// AD-ONLY QUEUE / SCHEDULER — pure, network-free helpers.
//
// Restores the "old queue cadence" UX (สร้างทุก X นาที) but on the AD-ONLY lane ONLY: a queued
// row is replayed through POST /api/dashboard/create-ad-only (NEVER the legacy /api/dashboard/
// create-ad), so it can never publish a Page post, never comment, never write post_history. The
// scheduler picks at most ONE queued row per interval. This block holds the interval math and the
// queue-row → create-ad-only request-body mapping so all of it is unit-testable without D1/cron.
// =====================================================================

// The endpoint the queue processor MUST target. Exported so tests can assert the processor builds a
// body for create-ad-only and never the legacy hybrid create-ad endpoint.
export const AD_ONLY_QUEUE_ENDPOINT = '/api/dashboard/create-ad-only'

// Cadence bounds for "สร้างทุก X นาที". Stored as a dashboard setting (operator-editable).
export const DEFAULT_AD_ONLY_INTERVAL_MINUTES = 20
export const MIN_AD_ONLY_INTERVAL_MINUTES = 1
export const MAX_AD_ONLY_INTERVAL_MINUTES = 1440 // 24h

// Clamp + default an operator-supplied interval. Non-numeric / non-positive → the default (never 0,
// which would make the gate fire every tick). Out-of-range values are clamped, never thrown on.
export function clampAdOnlyIntervalMinutes(v: unknown): number {
    const n = toNum(v)
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_AD_ONLY_INTERVAL_MINUTES
    return clamp(Math.round(n), MIN_AD_ONLY_INTERVAL_MINUTES, MAX_AD_ONLY_INTERVAL_MINUTES)
}

// Next-run timestamp (ms) given the last run + interval. An empty/unparseable last-run means "never
// ran" → due now (returns nowMs).
export function nextAdOnlyRunAtMs(lastRunIso: string, intervalMinutes: number, nowMs: number): number {
    const lastMs = Date.parse(String(lastRunIso || '').trim())
    const interval = clampAdOnlyIntervalMinutes(intervalMinutes)
    if (!Number.isFinite(lastMs)) return nowMs
    return lastMs + interval * 60_000
}

// The interval gate: is a queued ad-only item due to be processed now? True when the queue has never
// run, or when now >= last_run + interval. Pure — the caller passes nowMs.
export function isAdOnlyQueueDue(lastRunIso: string, intervalMinutes: number, nowMs: number): boolean {
    return nowMs >= nextAdOnlyRunAtMs(lastRunIso, intervalMinutes, nowMs)
}

// A queued ad-only row as stored in dashboard_ad_only_queue. Mirrors the create-ad-only input but is
// flat/string-typed the way D1 returns it. daily_budget_thb / run_hours are stored as text and may be
// empty ('' = use endpoint default).
export interface AdOnlyQueueRow {
    page_id?: string
    mode?: string
    daily_campaign_name?: string
    daily_budget_thb?: number | string
    run_hours?: number | string
    story_id?: string
    post_id?: string
    fb_video_id?: string
    system_video_id?: string
    shopee_url?: string
    caption?: string
    ad_name?: string
    placement_template?: string
}

// Map a queued row to the EXACT POST /api/dashboard/create-ad-only request body. This is the single
// source of truth for replaying a queued item: it preserves the operator-set campaign date/name,
// mode, budget and run-hours, and forwards the existing-post/video source ids. It deliberately emits
// NOTHING that could publish a page post (no video_url) — the create-ad-only endpoint enforces that
// too. Empty budget/run-hours are omitted so the endpoint applies its safe defaults.
export function buildAdOnlyCreateBody(row: AdOnlyQueueRow | null | undefined): Record<string, unknown> {
    const r = row || {}
    const rawMode = str(r.mode).toLowerCase()
    const mode: AdOnlyMode = rawMode === 'active' || rawMode === 'scheduled' || rawMode === 'live' ? 'active' : 'paused'
    const body: Record<string, unknown> = {
        page_id: str(r.page_id),
        story_id: str(r.story_id),
        post_id: str(r.post_id),
        fb_video_id: str(r.fb_video_id),
        system_video_id: str(r.system_video_id),
        shopee_url: str(r.shopee_url),
        caption: str(r.caption),
        ad_name: str(r.ad_name),
        mode,
        daily_campaign_name: str(r.daily_campaign_name),
    }
    const placement = str(r.placement_template)
    if (placement) body.placement_template = placement
    const budget = toNum(r.daily_budget_thb)
    if (Number.isFinite(budget) && budget > 0) body.daily_budget_thb = Math.round(budget)
    const hours = toNum(r.run_hours)
    if (Number.isFinite(hours) && hours > 0) body.run_hours = Math.round(hours)
    return body
}

const MAX_RESULT_JSON = 4000

// Truncate a raw bridge/result object to a bounded JSON string for the audit row. Never throws.
export function truncateResultJson(result: unknown, max = MAX_RESULT_JSON): string {
    let s: string
    try {
        s = JSON.stringify(result ?? null)
    } catch {
        s = String(result)
    }
    if (s.length <= max) return s
    return s.slice(0, max - 1) + '…'
}

// Shape the audit row from a validation + an optional bridge result. Pure: the DB write lives in
// the route. `status` is the lifecycle state ('unsupported' | 'failed' | 'created' | 'pending').
export function buildAdHistoryRecord(params: {
    status: string
    validation: AdOnlyValidation
    result?: Record<string, unknown> | null
    clickLink?: string
    errorMessage?: string
    /** Operator scheduling/budget intent for this attempt (from resolveAdOnlySchedule). */
    schedule?: { mode: AdOnlyMode; runHours: number } | null
}): AdHistoryRecord {
    const v = params.validation
    const r = params.result || {}
    const pick = (k: string): string => str((r as Record<string, unknown>)[k])
    const sched = params.schedule || null
    return {
        status: str(params.status) || 'pending',
        page_id: v.pageId,
        source_story_id: v.sourceStoryId,
        source_post_id: v.sourcePostId,
        fb_video_id: v.fbVideoId,
        system_video_id: v.systemVideoId,
        campaign_id: pick('campaign_id'),
        campaign_name: pick('campaign_name'),
        adset_id: pick('adset_id'),
        ad_id: pick('ad_id'),
        creative_id: pick('creative_id'),
        effective_object_story_id: pick('effective_object_story_id') || pick('ad_story_id') || pick('story_id'),
        click_link: str(params.clickLink) || pick('cta_link') || pick('shortLink'),
        error_message: str(params.errorMessage),
        truncated_result_json: params.result ? truncateResultJson(params.result) : '',
        // Mode/run-hours reflect operator intent; budget/schedule come back from the bridge result on
        // the active path (absent for the paused/review path, where they stay empty). The bridge now
        // reports the CAMPAIGN-level (CBO) budget as `campaign_budget`; fall back to the legacy
        // `daily_budget` key so older bridge responses still populate the audit column.
        mode: sched ? sched.mode : '',
        daily_budget: pick('campaign_budget') || pick('daily_budget'),
        run_hours: sched && sched.runHours ? String(sched.runHours) : '',
        start_time: pick('start_time'),
        end_time: pick('end_time'),
    }
}
