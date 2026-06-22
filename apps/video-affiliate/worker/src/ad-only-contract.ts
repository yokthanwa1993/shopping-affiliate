// Create Ads contract — pure, network-free helpers for POST /api/dashboard/create-ad-only.
//
// The endpoint name is kept for compatibility, but the main Create Ads flow is signal-to-dark-ad:
// an old high-performing Page post/video is only the source signal. The worker resolves the matching
// internal system video/content, creates a PAID ad/dark story, repairs the paid ad CTA, and comments on
// that ad story. It must fail closed when the internal system video/content cannot be resolved; it must
// never silently boost/reuse the old Page post/video as the ad surface and must never publish a new
// visible Page post in this lane.
// It is deliberately separate from:
//   - the Page Post flow  (POST /api/pages/:id/force-post → post_history, cron — UNTOUCHED)
//   - the legacy hybrid   (POST /api/dashboard/create-ad → mixed post+ad — UNTOUCHED)
// and has its own audit trail (dashboard_ad_history). This module holds input validation, the
// bridge-capability gate, queue shaping, and audit-row shaping so all of it is unit-testable without
// a live Graph / bridge.

export interface AdOnlyInputBody {
    page_id?: string
    // Source signal ids from the old high-performing Page surface. These are kept for proof/dedup only;
    // they are NOT the ad surface. The ad surface must come from system_video_id or an already-resolved
    // internal video_url.
    story_id?: string
    post_id?: string
    fb_video_id?: string
    video_id?: string
    system_video_id?: string
    source_video_id?: string
    // Optional already-resolved internal system video URL. The dashboard normally sends system_video_id
    // and the worker resolves this itself; internal callers/tests may pass video_url directly.
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
    // Operator-set scheduling/budget for the Create Ads run. `mode` selects the lifecycle:
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
    /** Already-resolved internal video URL, when supplied by a trusted/internal caller. */
    videoUrl: string
    /** True when at least one old Page surface id was supplied as the high-performing signal. */
    hasAdSource: boolean
    /** True when the request carries a system video id or resolved video URL that can publish a new post. */
    hasSystemVideoSource: boolean
}

const str = (v: unknown): string => String(v ?? '').trim()

// Validate Create Ads input and fail CLOSED. Rules:
//   1. page_id is required.
//   2. The publishable source is system_video_id/source_video_id or an already-resolved video_url.
//   3. story_id / post_id / fb_video_id are source-signal/audit ids only. They never authorize reuse
//      of the old Page surface as the ad surface.
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
    const hasSystemVideoSource = !!(systemVideoId || videoUrl)

    const base = { pageId, sourceStoryId, sourcePostId, fbVideoId, systemVideoId, videoUrl, hasAdSource, hasSystemVideoSource }

    if (!pageId) {
        return { ok: false, error: 'page_id_required', detail: 'page_id is required for Create Ads', ...base }
    }
    if (!hasSystemVideoSource) {
        return {
            ok: false,
            error: 'system_video_source_required',
            detail: 'system_video_id or resolved internal video_url is required; old story/post/Facebook video ids are signal/audit only and will not be reused as the ad surface',
            ...base,
        }
    }
    return { ok: true, ...base }
}

// Operator scheduling/budget for a Create Ads run. 'paused' creates a non-spending review ad (no
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
// CREATE ADS QUEUE / SCHEDULER — pure, network-free helpers.
//
// Restores the "old queue cadence" UX (สร้างทุก X นาที) on the Create Ads lane: a queued row is
// replayed through POST /api/dashboard/create-ad-only, which resolves the system video, creates an
// ads-only dark story, repairs the paid ad CTA, and comments on that ad story. The scheduler picks at most
// ONE queued row per interval. This block holds the interval math and the queue-row → create-ad-only
// request-body mapping so all of it is unit-testable without D1/cron.
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
// mode, budget and run-hours, and forwards the old source-signal ids plus system_video_id. Empty
// budget/run-hours are omitted so the endpoint applies its safe defaults.
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

// =====================================================================
// CREATE ADS AUTO-PICK — pure, network-free helpers for the "create an ad EVERY interval even when
// the manual queue is empty" cadence. When dashboard_ad_only_queue has no queued row, the scheduler
// auto-selects ONE eligible cached page-video signal and replays it through the SAME create-ad-only
// contract. These helpers hold candidate eligibility, dedup-against-history math, ranking and body
// shaping so the whole auto-pick decision is unit-testable without D1/cron/the bridge.
// =====================================================================

// Minimum lifetime views a cached page video must have to be auto-picked. Matches the operator rule
// "only promote clips with real reach". A candidate below this is skipped.
export const AD_ONLY_AUTO_MIN_VIEWS = 100_000

// A cached page video reduced to the fields the auto-picker needs (a projection of
// facebook_page_video_cache). videoId/postId are old Page source-signal ids only. systemVideoId is
// the internal content that will be published as the NEW Page post. shopeeLink/views gate eligibility;
// createdTime breaks ties.
export interface AdOnlyAutoCandidate {
    pageId: string
    videoId: string
    postId?: string
    shopeeLink?: string
    views?: number | string
    createdTime?: string
    /** Internal system video id that will be resolved to the NEW post's video_url. Required to create. */
    systemVideoId?: string
    /** Optional human label forwarded as ad_name (defaults to the system/video id). */
    adName?: string
}

// One dashboard_ad_history row's id columns, used to dedup an auto-pick against already-promoted
// clips. All fields optional/string the way D1 returns them.
export interface AdOnlyHistoryIdRow {
    source_story_id?: string
    source_post_id?: string
    fb_video_id?: string
    system_video_id?: string
    effective_object_story_id?: string
    /** Attempt timestamp (ISO/SQLite datetime). Used to scope auto-pick dedup to the current Bangkok
     * day; absent on the all-time manual flow, which ignores it. */
    created_at?: string
    /** Lifecycle status. Auto-pick dedup ignores failed/error/unsupported rows because no ad was created. */
    status?: string
}

// The tail after the last underscore of a PAGEID_POSTID id (e.g. "111_222" → "222"). An id with no
// underscore returns itself; empty-safe.
export function adOnlyIdTail(id: unknown): string {
    const s = str(id)
    if (!s) return ''
    const i = s.lastIndexOf('_')
    return i >= 0 ? s.slice(i + 1) : s
}

// Build the set of ids already represented in dashboard_ad_history. Each row contributes its
// source_story_id, source_post_id, fb_video_id, system_video_id and effective_object_story_id —
// each added BOTH raw and as its underscore tail — so a candidate's video id, post id or post-id
// tail can be matched regardless of which id column recorded the original promotion. Empty values
// are skipped, so an all-empty history row never poisons the set.
export function buildAdOnlyUsedIdSet(rows: ReadonlyArray<AdOnlyHistoryIdRow> | null | undefined): Set<string> {
    const used = new Set<string>()
    const add = (v: unknown) => {
        const s = str(v)
        if (!s) return
        used.add(s)
        const tail = adOnlyIdTail(s)
        if (tail) used.add(tail)
    }
    for (const r of rows || []) {
        if (!r) continue
        add(r.source_story_id)
        add(r.source_post_id)
        add(r.fb_video_id)
        add(r.system_video_id)
        add(r.effective_object_story_id)
    }
    return used
}

// Bangkok (UTC+7) calendar-date key "YYYY-MM-DD" for an ISO string / epoch-ms / Date. Empty or
// unparseable input returns ''. The auto scheduler keys daily no-repeat off this so a clip promoted on
// a PREVIOUS Bangkok day no longer blocks it today, and the duplicate set resets at the Bangkok day
// boundary. Pure (Intl only, no Date.now()).
export function bangkokDateKey(value: string | number | Date | null | undefined): string {
    let d: Date
    if (value instanceof Date) {
        d = value
    } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return ''
        d = new Date(value)
    } else {
        const s = str(value)
        if (!s) return ''
        const ms = Date.parse(s)
        if (!Number.isFinite(ms)) return ''
        d = new Date(ms)
    }
    if (Number.isNaN(d.getTime())) return ''
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d)
}

// Keep only the history rows whose created_at falls on the SAME Bangkok day as nowMs. Rows from a
// previous Bangkok day are dropped (so they no longer block today's pick). A row with NO parseable
// created_at is KEPT (fail safe: dedup against an undated row rather than risk a same-day repeat). Pure
// — the caller passes nowMs.
export function filterAdOnlyHistoryRowsForBangkokDate(
    rows: ReadonlyArray<AdOnlyHistoryIdRow> | null | undefined,
    nowMs: number,
): AdOnlyHistoryIdRow[] {
    const todayKey = bangkokDateKey(nowMs)
    return (rows || []).filter((r) => {
        if (!r) return false
        // Failed/unsupported attempts never created a usable ad, so they must not consume the
        // same-day no-repeat slot. Retry pacing is handled separately by the fatal-error cooldown.
        const status = str(r.status).toLowerCase()
        if (status === 'failed' || status === 'error' || status === 'unsupported') return false
        const created = str(r.created_at)
        if (!created) return true
        const key = bangkokDateKey(created)
        if (!key) return true
        return key === todayKey
    })
}

// Used-id set scoped to the CURRENT Bangkok day: only history rows created today (Asia/Bangkok)
// contribute, so a clip promoted on a previous Bangkok day is eligible again today and the no-repeat
// window resets at the day boundary. The all-time buildAdOnlyUsedIdSet is unchanged for the manual
// create-ad-only flow. Pure — the caller passes nowMs.
export function buildAdOnlyUsedIdSetForBangkokDate(
    rows: ReadonlyArray<AdOnlyHistoryIdRow> | null | undefined,
    nowMs: number,
): Set<string> {
    return buildAdOnlyUsedIdSet(filterAdOnlyHistoryRowsForBangkokDate(rows, nowMs))
}

// True when this candidate has already been promoted — its video id, post id, or post-id tail is in
// the used set built from dashboard_ad_history. Fail safe: when in doubt about a match the candidate
// is treated as fresh ONLY if none of its ids appear.
export function isAdOnlyCandidateUsed(candidate: AdOnlyAutoCandidate | null | undefined, used: Set<string>): boolean {
    const c = candidate
    if (!c) return false
    const keys = [str(c.videoId), str(c.postId), adOnlyIdTail(c.postId)]
    return keys.some((k) => k.length > 0 && used.has(k))
}

const toViews = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
    return Number.isFinite(n) ? n : 0
}

// Eligibility for auto-pick: must carry an old source signal, a Shopee link, and clear the
// minimum-views bar. The create-ad-only endpoint still fails closed if that source cannot be resolved
// to publishable internal system content.
export function isAdOnlyCandidateEligible(
    candidate: AdOnlyAutoCandidate | null | undefined,
    minViews: number = AD_ONLY_AUTO_MIN_VIEWS,
): boolean {
    const c = candidate
    if (!c) return false
    if (!str(c.videoId) && !str(c.postId)) return false
    if (!str(c.shopeeLink)) return false
    return toViews(c.views) >= minViews
}

// Deterministic candidate ordering: highest views first, then newest created_time, then a stable id
// order so a tie never depends on input order. Shared by the ranked-list and single-pick selectors.
function compareAdOnlyAutoCandidates(a: AdOnlyAutoCandidate, b: AdOnlyAutoCandidate): number {
    const dv = toViews(b.views) - toViews(a.views)
    if (dv !== 0) return dv
    const dc = str(b.createdTime).localeCompare(str(a.createdTime))
    if (dc !== 0) return dc
    return str(a.videoId).localeCompare(str(b.videoId))
}

// Rank ALL eligible+fresh auto-pick candidates (highest views first) instead of just one. The scheduler
// uses this so a single failing page/candidate can't waste the cadence slot: it walks the ranked list
// and tries the next candidate when one fails. `used` excludes already-promoted clips (per
// dashboard_ad_history). Returns [] when nothing qualifies. Pure — input order never affects the result.
export function rankAdOnlyAutoCandidates(
    candidates: ReadonlyArray<AdOnlyAutoCandidate> | null | undefined,
    used: Set<string>,
    minViews: number = AD_ONLY_AUTO_MIN_VIEWS,
): AdOnlyAutoCandidate[] {
    const eligible = (candidates || []).filter(
        (c) => isAdOnlyCandidateEligible(c, minViews) && !isAdOnlyCandidateUsed(c, used),
    )
    eligible.sort(compareAdOnlyAutoCandidates)
    return eligible
}

// Deterministic, well-distributed seeded PRNG (mulberry32). Returns a function yielding floats in
// [0, 1). Used to make the auto-pick shuffle reproducible in tests (inject a fixed seed) while the
// scheduler seeds it from the wall clock per tick for real randomness. A zero/NaN seed is coerced to 1
// so the generator never degenerates.
export function makeSeededRng(seed: number): () => number {
    let a = (Number.isFinite(seed) ? seed : 0) >>> 0
    if (a === 0) a = 1
    return () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// Fisher–Yates shuffle returning a NEW array (never mutates the input). rng defaults to Math.random;
// pass a seeded rng for deterministic tests.
export function shuffleWithRng<T>(items: ReadonlyArray<T>, rng: () => number = Math.random): T[] {
    const arr = items.slice()
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        const tmp = arr[i]
        arr[i] = arr[j]
        arr[j] = tmp
    }
    return arr
}

// RANDOMIZED auto-pick ranking for the scheduler. Applies the SAME eligibility + same-day dedup gates
// as rankAdOnlyAutoCandidates, but instead of sorting by highest views it SHUFFLES the eligible+fresh
// pool, so the cadence does not always promote the highest-view clip — it draws randomly across the
// eligible cached pool. Pass a seeded rng for deterministic tests; the scheduler seeds from the wall
// clock. Returns [] when nothing qualifies. Order of the input never biases the result.
export function rankAdOnlyAutoCandidatesRandom(
    candidates: ReadonlyArray<AdOnlyAutoCandidate> | null | undefined,
    used: Set<string>,
    rng: () => number = Math.random,
    minViews: number = AD_ONLY_AUTO_MIN_VIEWS,
): AdOnlyAutoCandidate[] {
    const eligible = (candidates || []).filter(
        (c) => isAdOnlyCandidateEligible(c, minViews) && !isAdOnlyCandidateUsed(c, used),
    )
    return shuffleWithRng(eligible, rng)
}

// Pick the SINGLE best auto-pick candidate: eligible (shopee link + views ≥ minViews) AND not already
// in dashboard_ad_history. Ties broken by highest views, then newest created_time, then a stable id
// order so selection is deterministic. Returns null when nothing qualifies (queue stays idle that
// interval rather than promoting a low-quality / duplicate clip).
export function selectAdOnlyAutoCandidate(
    candidates: ReadonlyArray<AdOnlyAutoCandidate> | null | undefined,
    used: Set<string>,
    minViews: number = AD_ONLY_AUTO_MIN_VIEWS,
): AdOnlyAutoCandidate | null {
    const ranked = rankAdOnlyAutoCandidates(candidates, used, minViews)
    return ranked.length ? ranked[0] : null
}

// =====================================================================
// AD-ONLY AUTO-PICK FAILURE COOLDOWN — a page whose recent ad-only create failed with a permission/
// config error will keep failing until an operator fixes it, so the auto scheduler must stop spending
// cadence slots on it. These helpers classify a fatal error and build the temporary per-page skip set
// from recent dashboard_ad_history failures. The skip is TIME-BOUNDED (never a permanent ban): once the
// cooldown elapses the page is retried, so a later config fix re-enables it automatically.
// =====================================================================

// Error substrings that mark a create failure as fatal/config — retrying the same page immediately is
// pointless until an operator intervenes. Matched case-insensitively against error_message AND the
// truncated bridge result. Covers the live permission/config failures plus the worker's own fail-closed
// codes. Kept narrow on purpose: a transient/unknown error does NOT cool a page down (it stays retryable).
export const AD_ONLY_FATAL_ERROR_SUBSTRINGS: string[] = [
    'Application does not have permission',
    'Object with ID',
    'missing permissions',
    'config_missing_template_or_ad_account',
    'bridge_not_configured',
    'fb_video_id_unresolved',
    'system_video_source_required',
    'system_video_unresolved',
    'system_video_url_unresolved',
]

// True when a failure message/result matches a fatal/config substring (case-insensitive). Empty-safe.
export function isAdOnlyFatalError(message: unknown): boolean {
    const s = str(message).toLowerCase()
    if (!s) return false
    return AD_ONLY_FATAL_ERROR_SUBSTRINGS.some((sub) => s.includes(sub.toLowerCase()))
}

// How long a page stays on cooldown after a fatal create failure. Bounded so the ban is temporary — a
// config fix re-enables the page on the next tick after this window. 6h ≈ 18 cadence slots at 20-min.
export const AD_ONLY_PAGE_COOLDOWN_MS = 6 * 60 * 60 * 1000

// How many ranked candidates the scheduler attempts in ONE tick before giving up. Bounds the work per
// cron tick while still letting it fall through past a few bad pages/candidates to a good one.
export const AD_ONLY_AUTO_MAX_ATTEMPTS = 4

// One recent dashboard_ad_history failure row, reduced to the fields the cooldown needs. All optional/
// string the way D1 returns them. created_at is the attempt timestamp (ISO/SQLite datetime).
export interface AdOnlyFailureRow {
    page_id?: string
    status?: string
    error_message?: string
    truncated_result_json?: string
    created_at?: string
    // Legacy pre-fix attempts published a visible Page post before failing later in creative/CTA.
    // Those rows must not keep the page on cooldown after the ads-only/dark-story flow is restored.
    published_to_page?: boolean | number | string | null
}

// Build the set of page ids to TEMPORARILY skip this tick. A page is cooled down when it has a failed
// history row whose error matches a fatal/config substring AND the failure is newer than nowMs -
// cooldownMs. Non-failed rows, non-fatal errors and failures older than the window never add a page. A
// row with no parseable timestamp is treated as recent (fail safe: skip a known-bad page rather than
// immediately retry it). Pure + deterministic — the caller passes nowMs.
export function buildAdOnlySkippedPageSet(
    rows: ReadonlyArray<AdOnlyFailureRow> | null | undefined,
    nowMs: number,
    cooldownMs: number = AD_ONLY_PAGE_COOLDOWN_MS,
): Set<string> {
    const skipped = new Set<string>()
    for (const r of rows || []) {
        if (!r) continue
        const pageId = str(r.page_id)
        if (!pageId) continue
        // Only failures cool a page down; a 'created'/'pending' row never does.
        const status = str(r.status).toLowerCase()
        if (status && status !== 'failed' && status !== 'error' && status !== 'unsupported') continue
        const legacyVisiblePublish = r.published_to_page === true || r.published_to_page === 1 || str(r.published_to_page).toLowerCase() === 'true'
        if (legacyVisiblePublish) continue
        if (!isAdOnlyFatalError(`${str(r.error_message)} ${str(r.truncated_result_json)}`)) continue
        const ts = Date.parse(str(r.created_at))
        if (Number.isFinite(ts) && nowMs - ts > cooldownMs) continue
        skipped.add(pageId)
    }
    return skipped
}

// Map an auto-picked candidate to the EXACT POST /api/dashboard/create-ad-only request body. The auto
// scheduler always creates a LIVE, SPENDING ad, so it defaults to mode 'active' with the Bangkok
// date-named daily campaign, the 10,000 THB/day CBO budget and a 24h run window — the same contract
// requirement already implemented for the force-post CBO campaign. It forwards source-signal ids and
// system_video_id; the endpoint re-validates, resolves the system video URL, creates an ads-only
// dark story, repairs the paid ad CTA, comments on that ad story, and writes the dashboard_ad_history audit.
export function buildAdOnlyAutoPickBody(input: {
    candidate: AdOnlyAutoCandidate
    dailyCampaignName: string
    dailyBudgetThb?: number
    runHours?: number
}): Record<string, unknown> {
    const c = input.candidate
    const budget = Number.isFinite(Number(input.dailyBudgetThb)) && Number(input.dailyBudgetThb) > 0
        ? Math.round(Number(input.dailyBudgetThb))
        : DEFAULT_DAILY_BUDGET_THB
    const hours = Number.isFinite(Number(input.runHours)) && Number(input.runHours) > 0
        ? Math.round(Number(input.runHours))
        : DEFAULT_RUN_HOURS
    const body: Record<string, unknown> = {
        page_id: str(c.pageId),
        fb_video_id: str(c.videoId),
        post_id: str(c.postId),
        system_video_id: str(c.systemVideoId),
        shopee_url: str(c.shopeeLink),
        ad_name: str(c.adName) || str(c.systemVideoId) || str(c.videoId),
        mode: 'active' as AdOnlyMode,
        daily_campaign_name: str(input.dailyCampaignName),
        daily_budget_thb: budget,
        run_hours: hours,
    }
    return body
}

// Build the Shopee shortlink REQUEST url (page shortlink template / short.wwoom flow) for an
// AD-ONLY re-mint. Mirrors the create-ad-only initial mint, but lets the caller inject sub2/sub3
// derived from the bridge-returned story_id (sub2 = post id tail, sub3 = page id) instead of the
// page-settings defaults (which can be blank before the ad's story exists). sub4/sub5 are emptied —
// outbound tracking keeps internal ids out of the link. Templates without a {sub_id2}/{sub_id3}
// placeholder simply carry no sub2/sub3 (same behaviour as the initial mint). Pure: no network.
export function buildAdOnlyShortlinkRequestUrl(input: {
    template: string
    shopeeLink: string
    sub1: string
    sub2: string
    sub3: string
}): string {
    const enc = (v: string): string => encodeURIComponent(str(v))
    return str(input.template)
        .replace('{url}', encodeURIComponent(str(input.shopeeLink)))
        .replace('{sub_id}', enc(input.sub1))
        .replace('{sub_id2}', enc(input.sub2))
        .replace('{sub_id3}', enc(input.sub3))
        .replace('{sub_id4}', '')
        .replace('{sub_id5}', '')
}

// =====================================================================
// PAID AD CTA REPAIR — pure helpers for the active ad-only finalization step that fixes the PAID ad
// creative's CTA in Ads Manager. The paid ad is created BEFORE the final post-specific shortlink is
// minted, so its creative carries a placeholder link (sub2/sub3 unset). After the worker mints the
// final shortlink it calls the bridge POST /repair-ad-cta to re-point the ad at a NEW creative whose
// CTA is the SAME finalLink the visible CTA + Page comment use. These keep that request-body build +
// response-mapping unit-testable without the bridge/network.
// =====================================================================

// Build the POST /repair-ad-cta request body. `finalLink` is the single post-specific Shopee link
// shared by the visible CTA, the Page comment AND this paid-ad CTA. Omits empty optional fields so
// the bridge applies its own backfill (it reads the old creative for video/image/message).
export function buildPaidAdCtaRepairBody(input: {
    pageId: string
    adId: string
    finalLink: string
    creativeId?: string
    videoId?: string
    caption?: string
    adAccount?: string
    templateAdset?: string
    sourceStoryId?: string
    adName?: string
    thumbnailUrl?: string
}): Record<string, unknown> {
    const body: Record<string, unknown> = {
        page_id: str(input.pageId),
        ad_id: str(input.adId),
        final_cta_link: str(input.finalLink),
    }
    const creativeId = str(input.creativeId); if (creativeId) body.creative_id = creativeId
    const videoId = str(input.videoId); if (videoId) body.video_id = videoId
    const caption = str(input.caption); if (caption) body.caption = caption
    const adAccount = str(input.adAccount); if (adAccount) body.ad_account = adAccount
    const templateAdset = str(input.templateAdset); if (templateAdset) body.template_adset = templateAdset
    const sourceStoryId = str(input.sourceStoryId); if (sourceStoryId) body.source_story_id = sourceStoryId
    const adName = str(input.adName); if (adName) body.ad_name = adName
    const thumbnailUrl = str(input.thumbnailUrl); if (thumbnailUrl) body.thumbnail_url = thumbnailUrl
    return body
}

// The audit fields merged onto bridgeResult after a /repair-ad-cta call.
export interface PaidAdCtaRepairSummary {
    paid_cta_update_status: 'success' | 'failed'
    paid_ad_cta_link?: string
    paid_ad_cta_final?: boolean
    paid_new_creative_id?: string
    paid_old_creative_id?: string
    paid_cta_update_error?: string
}

// Map a /repair-ad-cta bridge response into the bridgeResult audit fields. NEVER claims success
// unless the bridge returned ok AND a read-back-confirmed paid_ad_cta_final. Pure.
export function summarizePaidAdCtaRepair(
    data: Record<string, unknown> | null | undefined,
    httpOk: boolean,
): PaidAdCtaRepairSummary {
    const d = data || {}
    const newCreativeId = str(d.new_creative_id)
    const oldCreativeId = str(d.old_creative_id)
    if (httpOk && d.ok === true && d.paid_ad_cta_final === true) {
        const summary: PaidAdCtaRepairSummary = {
            paid_cta_update_status: 'success',
            paid_ad_cta_link: str(d.paid_ad_cta_link) || str(d.final_cta_link),
            paid_ad_cta_final: true,
        }
        if (newCreativeId) summary.paid_new_creative_id = newCreativeId
        if (oldCreativeId) summary.paid_old_creative_id = oldCreativeId
        return summary
    }
    const errBase = str(d.step) ? `${str(d.step)}:${str(d.error)}` : (str(d.error) || 'repair_ad_cta_failed')
    const summary: PaidAdCtaRepairSummary = {
        paid_cta_update_status: 'failed',
        paid_ad_cta_final: d.paid_ad_cta_final === true,
        paid_cta_update_error: errBase.slice(0, 200),
    }
    if (newCreativeId) summary.paid_new_creative_id = newCreativeId
    if (oldCreativeId) summary.paid_old_creative_id = oldCreativeId
    return summary
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
