// Pure, network-free helpers for the READ-ONLY Page Reels comment/link registry
// audit endpoint (GET /api/dashboard/page-comment-link-registry).
//
// Extracted into its own module so URL extraction, affiliate-link classification,
// tracking-param parsing (utm_content / sub1..sub5), product-URL canonicalisation,
// and per-item status logic can be unit-tested WITHOUT pulling in the Worker
// runtime, Graph calls, or any network access. The route in index.ts wires these
// helpers to the cache rows, post_history mapping, live Graph comment reads, and
// bounded redirect expansion — but every decision that can be made from strings
// alone lives here and is covered by test/comment-link-registry.test.ts.

import { extractShopeeAffiliateIdFromLink, normalizeShortlinkExpectedUtmId } from './shopee-affiliate-id.js'

export const REGISTRY_MAX_LIMIT = 100
export const REGISTRY_DEFAULT_LIMIT = 25

export type ParsedTrackingSubIds = {
    utm_content: string
    sub1: string
    sub2: string
    sub3: string
    sub4: string
    sub5: string
}

const EMPTY_SUB_IDS: ParsedTrackingSubIds = {
    utm_content: '', sub1: '', sub2: '', sub3: '', sub4: '', sub5: '',
}

// Hosts that mark a link as an affiliate / short link worth expanding & auditing.
const SHORTLINK_HOST_PATTERN = /(^|\.)(s\.shopee\.[a-z.]+|shp\.ee|customlink\.[a-z0-9.-]+|invol\.co|invl\.io|bit\.ly|cutt\.ly|t\.co|ulvis\.net)$/i
const SHOPEE_HOST_PATTERN = /(^|\.)(shopee\.[a-z.]+|s\.shopee\.[a-z.]+|shp\.ee)$/i
const SHOPEE_SHORT_HOST_PATTERN = /(^|\.)(s\.shopee\.[a-z.]+|shp\.ee)$/i
const CUSTOMLINK_HOST_PATTERN = /(^|\.)customlink\.[a-z0-9.-]+$/i

// Query params stripped when canonicalising a product URL. Covers UTM, affiliate
// sub-ids, AppsFlyer, Shopee mobile/redirect junk (__mobile__, gads_t_sig,
// mmp_pid), and common click-id junk while leaving real product params
// (shopid/itemid live in the path, not the query) untouched.
const TRACKING_PARAM_PATTERN = /^(utm_.*|sub\d+|af_.*|is_retargeting|pid|c|fbclid|gclid|gclsrc|gad_source|gads_t_sig|wbraid|gbraid|msclkid|ttclid|smtt|xptdk|__mobile__|mmp_pid|deep_and_deferred.*|deep_link_value|ref|referrer|share_id|publish_id|uls_trackid|exlaunch.*)$/i

// Shopee encodes the product's shop + item ids in the URL path:
//   ".../<slug>-i.<shop>.<item>", ".../product/<shop>/<item>",
//   ".../<shopname>/<shop>/<item>", or as shopid/itemid query params. When we can
// recover those ids we can drop the ENTIRE query string (Shopee re-derives the
// product from the path) — the only reliable way to shed the long, volatile tail
// of tracking junk regardless of param name.
const SHOPEE_I_SUFFIX_PATTERN = /-i\.(\d+)\.(\d+)$/

function parseShopeeProductIds(u: URL): { shopId: string; itemId: string; pathHasIds: boolean } | null {
    // 1. ".../<slug>-i.<shop>.<item>"
    const iMatch = u.pathname.match(SHOPEE_I_SUFFIX_PATTERN)
    if (iMatch) return { shopId: iMatch[1], itemId: iMatch[2], pathHasIds: true }
    // 2. trailing numeric path segments ("/product/<shop>/<item>", "/<shop>/<item>")
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length >= 2) {
        const shopId = segs[segs.length - 2]
        const itemId = segs[segs.length - 1]
        if (/^\d+$/.test(shopId) && /^\d+$/.test(itemId)) {
            return { shopId, itemId, pathHasIds: true }
        }
    }
    // 3. shopid/itemid query params (path is generic, e.g. a redirect landing page)
    const qShop = String(u.searchParams.get('shopid') || u.searchParams.get('shop_id') || '').trim()
    const qItem = String(u.searchParams.get('itemid') || u.searchParams.get('item_id') || '').trim()
    if (/^\d+$/.test(qShop) && /^\d+$/.test(qItem)) {
        return { shopId: qShop, itemId: qItem, pathHasIds: false }
    }
    return null
}

function safeUrl(url: string): URL | null {
    const value = String(url || '').trim()
    if (!value) return null
    try {
        return new URL(value)
    } catch {
        return null
    }
}

// Trailing punctuation that almost always belongs to surrounding prose, not the
// URL itself (captions like "พิกัด: https://s.shopee.co.th/abc)" ).
function stripTrailingPunctuation(url: string): string {
    let value = String(url || '').trim()
    while (value && /[.,;:!?)\]}'"”»…]$/.test(value)) value = value.slice(0, -1)
    return value
}

// Extract unique http(s) URLs from free text (captions, comment messages).
export function extractUrlsFromText(text: string): string[] {
    const raw = String(text || '')
    if (!raw) return []
    const matches = raw.match(/https?:\/\/[^\s<>"'`)\]]+/gi) || []
    const out: string[] = []
    const seen = new Set<string>()
    for (const match of matches) {
        const cleaned = stripTrailingPunctuation(match)
        if (!cleaned || !safeUrl(cleaned)) continue
        const key = cleaned.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(cleaned)
    }
    return out
}

export function isShopeeLink(url: string): boolean {
    const u = safeUrl(url)
    return !!u && SHOPEE_HOST_PATTERN.test(u.hostname)
}

export function isCustomlinkLink(url: string): boolean {
    const u = safeUrl(url)
    return !!u && CUSTOMLINK_HOST_PATTERN.test(u.hostname)
}

// True for any host we are willing to follow redirects on for this audit.
export function isShortlinkCandidate(url: string): boolean {
    const u = safeUrl(url)
    if (!u) return false
    return SHORTLINK_HOST_PATTERN.test(u.hostname) || SHOPEE_HOST_PATTERN.test(u.hostname)
}

// Pick the single affiliate/short link to treat as the "old_shortlink" for an
// item. Preference: customlink wrapper → shopee short link → any shopee link →
// any other short link → '' (nothing affiliate-looking found).
export function pickPrimaryAffiliateUrl(urls: Array<string | null | undefined>): string {
    const list = (urls || []).map((u) => String(u || '').trim()).filter(Boolean)
    const byHost = (pattern: RegExp) => list.find((u) => {
        const parsed = safeUrl(u)
        return !!parsed && pattern.test(parsed.hostname)
    })
    return (
        list.find(isCustomlinkLink) ||
        byHost(SHOPEE_SHORT_HOST_PATTERN) ||
        list.find(isShopeeLink) ||
        list.find(isShortlinkCandidate) ||
        ''
    )
}

// Parse affiliate sub-ids from a URL. Two encodings are supported:
//   1. Explicit query params:  ...&sub1=<campaign>&sub2=<post_id>&sub3=<page_id>
//      (the customlink wrapper format, future id=15130770000 pattern).
//   2. Shopee redirect form:   ...&utm_content=<sub1>-<sub2>-<sub3>-<sub4>-<sub5>
//      where a trailing "--" leaves sub4/sub5 empty.
// Explicit sub params win when present; otherwise utm_content is split on "-".
export function parseTrackingSubIds(url: string): ParsedTrackingSubIds {
    const u = safeUrl(url)
    if (!u) return { ...EMPTY_SUB_IDS }
    const params = u.searchParams
    const utmContent = String(params.get('utm_content') || '').trim()
    const direct = {
        sub1: String(params.get('sub1') || '').trim(),
        sub2: String(params.get('sub2') || '').trim(),
        sub3: String(params.get('sub3') || '').trim(),
        sub4: String(params.get('sub4') || '').trim(),
        sub5: String(params.get('sub5') || '').trim(),
    }
    if (direct.sub1 || direct.sub2 || direct.sub3 || direct.sub4 || direct.sub5) {
        return { utm_content: utmContent, ...direct }
    }
    if (utmContent) {
        const parts = utmContent.split('-')
        return {
            utm_content: utmContent,
            sub1: String(parts[0] || '').trim(),
            sub2: String(parts[1] || '').trim(),
            sub3: String(parts[2] || '').trim(),
            sub4: String(parts[3] || '').trim(),
            sub5: String(parts[4] || '').trim(),
        }
    }
    return { utm_content: '', ...direct }
}

// Parse the affiliate/customlink ACCOUNT id from an affiliate URL — distinct
// from the sub1..sub5 campaign tracking ids above. Two sources are recognised:
//   1. customlink wrapper:  customlink.<tld>/?id=<affiliateId>
//   2. Shopee redirect/expanded form:  utm_source=an_<id> | mmp_pid=an_<id>
// Both go through the shared, fail-closed `normalizeShortlinkExpectedUtmId`
// (strips an_, keeps a digits-only id, caps length) so a raw token / opaque
// value can never be mistaken for — or stored as — an affiliate id. The Shopee
// markers reuse the existing `extractShopeeAffiliateIdFromLink` helper.
// `utm_campaign` is intentionally NOT read: the shared extractor only treats
// utm_source / mmp_pid as affiliate id sources, so adding it here would be an
// unverified, unsafe parse. Returns '' when no affiliate id can be recovered.
export function parseAffiliateId(url: string): string {
    const u = safeUrl(url)
    if (!u) return ''
    if (CUSTOMLINK_HOST_PATTERN.test(u.hostname)) {
        const idParam = normalizeShortlinkExpectedUtmId(u.searchParams.get('id'))
        if (idParam) return idParam
    }
    return extractShopeeAffiliateIdFromLink(url)
}

// Resolve the affiliate id the rewrite SHOULD mint with. Defaults to the CHEARB
// customlink account id; an operator override is honoured ONLY when it normalises
// to a valid numeric id (an_ stripped, digits-only, length-capped). Anything
// invalid/non-numeric fails closed to the default so a raw token can never be
// stored or sent as the target affiliate id.
export function resolveTargetAffiliateId(rawOverride?: string | null | undefined): string {
    const override = normalizeShortlinkExpectedUtmId(rawOverride)
    return override || CUSTOMLINK_DEFAULT_ID
}

// Status carried by a verified link. The route handlers layer on two more states
// that are NOT decidable from strings alone: 'pending' (dry-run, link not written
// yet) and 'error' (the shortlink could not be minted at all).
export type AffiliateVerifyStatus = 'verified' | 'mismatch' | 'missing'

export type VerifyAffiliateIdResult = {
    new_affiliate_id: string
    affiliate_id_match: boolean
    affiliate_verify_status: AffiliateVerifyStatus
}

// Verify the affiliate id carried by the NEW (expanded) shortlink against the
// target id. Comparison is strict numeric-string equality only:
//   new_affiliate_id === target_affiliate_id. No affiliate id on the link →
// 'missing'; an exact match → 'verified'; present but unequal (or no target to
// compare against) → 'mismatch' (never a false 'verified').
export function verifyAffiliateId(
    expandedUrl: string,
    targetAffiliateId: string,
): VerifyAffiliateIdResult {
    const newId = parseAffiliateId(expandedUrl)
    const target = normalizeShortlinkExpectedUtmId(targetAffiliateId)
    if (!newId) {
        return { new_affiliate_id: '', affiliate_id_match: false, affiliate_verify_status: 'missing' }
    }
    const match = !!target && newId === target
    return {
        new_affiliate_id: newId,
        affiliate_id_match: match,
        affiliate_verify_status: match ? 'verified' : 'mismatch',
    }
}

// Strip tracking params (UTM, sub-ids, click-ids, Shopee mobile/redirect junk)
// from a final/expanded URL to get a stable canonical product URL. For Shopee
// links whose shop/item ids can be parsed we drop the WHOLE query+hash (Shopee
// re-derives the product from the path), producing a clean
// ".../product/<shop>/<item>" or ".../<slug>-i.<shop>.<item>" URL. For everything
// else we keep real params and strip only known tracking keys. Falls back to the
// trimmed input if it does not parse as a URL.
export function canonicalizeProductUrl(finalUrl: string): string {
    const u = safeUrl(finalUrl)
    if (!u) return String(finalUrl || '').trim()

    if (SHOPEE_HOST_PATTERN.test(u.hostname)) {
        const ids = parseShopeeProductIds(u)
        if (ids) {
            // Path already carries the ids → keep the canonical path verbatim;
            // otherwise rebuild the stable "/product/<shop>/<item>" form.
            const path = ids.pathHasIds ? u.pathname : `/product/${ids.shopId}/${ids.itemId}`
            return `${u.protocol}//${u.host}${path}`
        }
    }

    const keep: Array<[string, string]> = []
    for (const [key, value] of u.searchParams.entries()) {
        if (TRACKING_PARAM_PATTERN.test(key)) continue
        keep.push([key, value])
    }
    u.search = ''
    for (const [key, value] of keep) u.searchParams.append(key, value)
    u.hash = ''
    return u.toString()
}

export type RegistryStatus =
    | 'ok'
    | 'missing_token'
    | 'cooldown'
    | 'graph_blocked'
    | 'comment_fetch_failed'
    | 'missing_comment'
    | 'non_page_comment'
    | 'multiple_comments'
    | 'missing_link'
    | 'expand_failed'

export type RegistryStatusInput = {
    // How the live Graph comment read went for this item's target.
    commentFetch: 'ok' | 'failed' | 'missing_token' | 'cooldown' | 'graph_blocked'
    // Count of top-level comments authored by the page itself.
    pageCommentCount: number
    // Count of top-level comments authored by anyone other than the page.
    otherCommentCount: number
    // Whether any affiliate/short link was found (caption, comment, or stored).
    hasLink: boolean
    // Outcome of bounded redirect expansion for the chosen link.
    expandState: 'ok' | 'failed' | 'not_attempted'
}

// Single-status verdict for an item, evaluated by priority:
//   token/fetch blockers → comment presence → link presence → expand outcome.
export function computeRegistryItemStatus(input: RegistryStatusInput): RegistryStatus {
    if (input.commentFetch === 'missing_token') return 'missing_token'
    if (input.commentFetch === 'cooldown') return 'cooldown'
    if (input.commentFetch === 'graph_blocked') return 'graph_blocked'
    if (input.commentFetch === 'failed') return 'comment_fetch_failed'

    if (input.pageCommentCount === 0) {
        if (input.otherCommentCount > 0) return 'non_page_comment'
        return 'missing_comment'
    }
    if (input.pageCommentCount > 1) return 'multiple_comments'

    if (!input.hasLink) return 'missing_link'
    if (input.expandState === 'failed') return 'expand_failed'
    return 'ok'
}

// Clamp a requested limit into [1, REGISTRY_MAX_LIMIT] with REGISTRY_DEFAULT_LIMIT
// for missing/invalid input.
export function normalizeRegistryLimit(raw: unknown): number {
    const value = Number(raw)
    if (!Number.isFinite(value)) return REGISTRY_DEFAULT_LIMIT
    return Math.min(REGISTRY_MAX_LIMIT, Math.max(1, Math.floor(value)))
}

export function normalizeRegistryOffset(raw: unknown): number {
    const value = Number(raw)
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.floor(value))
}

// ---------------------------------------------------------------------------
// SAFE FULL WORKFLOW — pure helpers for rewriting the Shopee shortlink inside
// Page/Reel comments (POST preview / jobs / run / verify). Every decision that
// can be made from strings alone lives here so it can be unit-tested without the
// Worker runtime, Graph, or the customlink service. The route handlers in
// index.ts own the network I/O (Graph reads/writes, customlink call, redirect
// expansion, D1) and call into these helpers.
// ---------------------------------------------------------------------------

// customlink.wwoom.com short-link service. id is the CHEARB affiliate account id.
export const CUSTOMLINK_HOST = 'customlink.wwoom.com'
export const CUSTOMLINK_DEFAULT_ID = '15130770000'

// Workflow safety defaults (requirement: small batch, dry-run + stop-on-error on
// by default so an accidental run can never sweep the whole page).
export const JOB_DEFAULT_BATCH_SIZE = 5
export const JOB_MAX_BATCH_SIZE = 50
export const JOB_DEFAULT_DRY_RUN = true
export const JOB_DEFAULT_STOP_ON_FIRST_ERROR = true

// Per-item planned write action.
export type RewriteAction = 'edit' | 'create_new' | 'skip'

// Item lifecycle status across preview → plan → run → verify.
export type JobItemStatus =
    | 'planned'        // plan computed, nothing written
    | 'skipped'        // nothing to rewrite (no link / no product url)
    | 'would_edit'     // dry-run: would edit the page-owned comment
    | 'would_create'   // dry-run: would create a new page comment
    | 'done'           // write succeeded and verified
    | 'verify_pending' // write happened; post-write verify intentionally deferred
    | 'failed'         // write or shortlink build failed
    | 'verify_failed'  // write happened but post-write verify did not confirm

// Job lifecycle status.
export type JobStatus = 'created' | 'planned' | 'running' | 'done' | 'partial' | 'failed'

export type JobStatusRollupInput = {
    effectiveWriteMode: boolean   // true only when writes were actually possible (write requested + token)
    previousStatus: string        // the job's status before this run
    remainingPlanned: number      // item rows still in 'planned' after this run
    doneCount: number             // total items in a terminal done state
    failedCount: number           // total items in a terminal failed/verify_failed state
    stoppedReason: string         // non-empty when a real run aborted early
}

// Roll up the job-level status after a run batch. Crucially, an effective
// dry-run performs no writes and leaves item rows 'planned', so it must NOT
// persist status='running' (which would make the job look in-progress/stuck).
// When work remains and no writes happened, the prior status is preserved.
export function resolvePageCommentLinkJobStatus(input: JobStatusRollupInput): JobStatus {
    const { effectiveWriteMode, previousStatus, remainingPlanned, doneCount, failedCount, stoppedReason } = input
    if (remainingPlanned === 0) {
        return failedCount > 0 ? (doneCount > 0 ? 'partial' : 'failed') : 'done'
    }
    // Items remain. A dry run wrote nothing — keep the job where it was rather
    // than advancing it to 'running'. An effective dry-run must NEVER return
    // 'running': if the prior status was 'running' (e.g. left over from an earlier
    // real run), demote it to 'planned' so the job can never look in-progress/stuck
    // purely from a dry-run. Genuinely terminal/partial priors are preserved.
    if (!effectiveWriteMode) {
        const prior = previousStatus as JobStatus
        if (prior === 'running') return 'planned'
        return prior === 'created' || prior === 'planned'
            || prior === 'done' || prior === 'partial' || prior === 'failed'
            ? prior
            : 'planned'
    }
    if (stoppedReason) return 'partial'
    return 'running'
}

export function clampBatchSize(raw: unknown): number {
    const value = Number(raw)
    if (!Number.isFinite(value)) return JOB_DEFAULT_BATCH_SIZE
    return Math.min(JOB_MAX_BATCH_SIZE, Math.max(1, Math.floor(value)))
}

export function resolveRunCommentBatchLimit(input: { writeMode: boolean; batchSize: number; requestedLimit?: unknown }): number {
    const requested = Number(input.requestedLimit)
    const requestedLimit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : input.batchSize
    const base = Math.min(input.batchSize, Math.max(1, requestedLimit))
    return input.writeMode ? Math.min(1, base) : base
}

// Parse a boolean-ish flag (query/body) with an explicit default. Used for
// dry_run / stop_on_first_error so an unset value falls back to the SAFE default.
export function normalizeJobBool(raw: unknown, fallback: boolean): boolean {
    if (raw === undefined || raw === null || raw === '') return fallback
    if (typeof raw === 'boolean') return raw
    const value = String(raw).trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(value)) return true
    if (['0', 'false', 'no', 'off'].includes(value)) return false
    return fallback
}

// The bare story/post id Graph wants for sub2: when given a `pageid_storyid`
// composite, keep only the trailing story id; otherwise return the id as-is.
function storyTail(id: string | null | undefined): string {
    const value = String(id || '').trim()
    if (!value) return ''
    return value.includes('_') ? (value.split('_').pop() || '') : value
}

export type TargetSubBuildInput = {
    requestedSub1: string
    pageId: string
    canonicalPostId?: string | null
    fbVideoId?: string | null
    reelId?: string | null
    logId?: string | number | null
}

export type TargetSubIds = {
    sub1: string
    sub2: string
    sub3: string
    sub4: string
    sub2_source: 'canonical_post_id' | 'none'
    reason: string
}

// Build the affiliate sub-ids for the NEW shortlink:
//   sub1 = operator-requested campaign,
//   sub2 = canonical post_id tail when resolved,
//   sub3 = page_id,
//   sub4 = stable internal log_id/post_history id when available.
// Never throws; missing Page story pieces are reported via sub2_source + reason.
export function resolveEffectiveTargetSub4(input: {
    targetSub4?: unknown
    target_sub4?: unknown
    logId?: unknown
    log_id?: unknown
    historyId?: unknown
    history_id?: unknown
    postHistoryId?: unknown
    post_history_id?: unknown
}): string {
    for (const value of [
        input.targetSub4,
        input.target_sub4,
        input.logId,
        input.log_id,
        input.historyId,
        input.history_id,
        input.postHistoryId,
        input.post_history_id,
    ]) {
        const text = String(value ?? '').trim()
        if (text) return text
    }
    return ''
}

// ---------------------------------------------------------------------------
// Durable per-page-story ledger id.
//
// `target_sub4` (the rewrite's log_id) MUST never be empty for a real rewrite:
// an empty slot 4 mints `utm_content = <sub1>-<sub2>-<sub3>--`, which is the
// 2026-05-16 production defect. The id source is, in order of preference:
//   1. an existing durable id on the item (post_history.id / persisted target_sub4)
//   2. a stable id from the page_post_link_ledger table, allocated per
//      (page_id, canonical page-story object id) for cache/manual/imported posts
//      that have no post_history row.
// The ledger row itself is created/looked up via an injected store so this logic
// stays network-free and unit-testable; the Worker backs the store with D1.
// ---------------------------------------------------------------------------

// Identity + durable metadata for a ledger row. Identity is
// (pageId, commentTargetId); the remaining fields are stored snapshot metadata
// so the ledger is a self-contained audit trail even without a post_history row.
export type PagePostLedgerKey = {
    pageId: string
    // Canonical page-story object id (`<page_id>_<post_id>`), or the reel object
    // id only when no page-story object exists. This is the stable allocation key.
    commentTargetId: string
    fbVideoId?: string
    reelId?: string
    postId?: string
    commentId?: string
    postedAt?: string
    source?: string
    oldShortlink?: string
    oldUtmContent?: string
    oldAffiliateId?: string
}

// Allocates/returns a stable positive integer id for a ledger key, creating the
// row on first use. Backed by D1 in the Worker; an in-memory map in tests.
export type PagePostLedgerStore = {
    resolveId(key: PagePostLedgerKey): Promise<number>
}

// Resolve the durable rewrite log id (target_sub4) from an existing durable id
// first, then a freshly-allocated ledger id. Returns '' only when neither is
// available. Pure — the ledger id is resolved by the caller.
export function resolveRewriteLogId(input: { existing?: unknown; ledgerId?: unknown }): string {
    const existing = String(input.existing ?? '').trim()
    if (existing) return existing
    const ledger = String(input.ledgerId ?? '').trim()
    return ledger
}

// Resolve the durable rewrite log id for a registry-shaped raw item, allocating a
// ledger id ONLY when the item carries no durable id (post_history.id / persisted
// target_sub4) AND a stable page-story target exists to key on. Prefers the
// existing durable id so post_history-backed items never touch the ledger.
export async function ensureRewriteLogId(
    raw: Record<string, unknown>,
    ctx: { pageId: string; commentTargetId: string; store?: PagePostLedgerStore | null; metadata?: Partial<PagePostLedgerKey> },
): Promise<string> {
    const existing = resolveEffectiveTargetSub4(raw)
    if (existing) return existing
    const store = ctx.store
    const commentTargetId = String(ctx.commentTargetId || '').trim()
    if (!store || !commentTargetId) return ''
    const id = await store.resolveId({
        pageId: String(ctx.pageId || '').trim(),
        commentTargetId,
        ...(ctx.metadata || {}),
    })
    return Number.isFinite(id) && id > 0 ? String(id) : ''
}

// Real-run guard: a write/mint MUST be refused when target_sub4 is empty and a
// comment target / comment id is known (i.e. this is a real rewrite target).
// Returns 'missing_target_sub4' to refuse, '' to proceed. This fires regardless
// of whether a log_id is present — an empty target_sub4 can never be minted.
export function resolveRealRewriteRefusal(input: {
    targetSub4?: unknown
    commentTargetId?: unknown
    oldCommentId?: unknown
    commentId?: unknown
}): string {
    const targetSub4 = String(input.targetSub4 ?? '').trim()
    if (targetSub4) return ''
    const known = String(input.commentTargetId ?? '').trim()
        || String(input.oldCommentId ?? '').trim()
        || String(input.commentId ?? '').trim()
    return known ? 'missing_target_sub4' : ''
}

export function buildTargetSubIds(input: TargetSubBuildInput): TargetSubIds {
    const sub1 = String(input.requestedSub1 || '').trim()
    const sub3 = String(input.pageId || '').trim()
    const sub4 = resolveEffectiveTargetSub4({ logId: input.logId })

    const canonical = storyTail(input.canonicalPostId)

    let sub2 = ''
    let sub2_source: TargetSubIds['sub2_source'] = 'none'
    if (canonical) {
        sub2 = canonical
        sub2_source = 'canonical_post_id'
    }

    const reasons: string[] = []
    if (!sub1) reasons.push('missing_sub1')
    if (!sub3) reasons.push('missing_page_id')
    if (sub2_source === 'none') reasons.push('missing_sub2', 'missing_page_story_object_id')

    return { sub1, sub2, sub3, sub4, sub2_source, reason: reasons.join(',') }
}

function targetStoryTail(id: unknown): string {
    const value = String(id ?? '').trim()
    if (!value) return ''
    return value.includes('_') ? (value.split('_').pop() || '') : value
}

function isFullPageStoryObjectId(id: unknown): boolean {
    return /^\d+_\d+$/.test(String(id ?? '').trim())
}

export function resolvePageStoryRewriteBlockReason(input: {
    commentTargetId?: unknown
    pageStoryObjectId?: unknown
    postId?: unknown
    canonicalPostId?: unknown
    reelId?: unknown
    fbVideoId?: unknown
    targetSub2?: unknown
    targetSub3?: unknown
}): string {
    const target = String(input.commentTargetId ?? input.pageStoryObjectId ?? '').trim()
    if (!isFullPageStoryObjectId(target)) return 'missing_page_story_object_id'

    const explicitPostTail = targetStoryTail(input.postId) || targetStoryTail(input.canonicalPostId)
    const targetTail = targetStoryTail(target)
    const reelTail = targetStoryTail(input.reelId) || targetStoryTail(input.fbVideoId)
    if (!explicitPostTail && reelTail && targetTail === reelTail) return 'missing_page_story_object_id'

    const postTail = explicitPostTail || targetTail
    const targetSub2 = String(input.targetSub2 ?? '').trim()
    if (!postTail || !targetSub2 || targetSub2 !== postTail) return 'missing_page_story_object_id'

    const targetSub3 = String(input.targetSub3 ?? '').trim()
    const targetPage = target.split('_')[0] || ''
    if (!targetSub3 || targetSub3 !== targetPage) return 'missing_page_story_object_id'

    return ''
}

export type CustomlinkRequestInput = {
    productUrl: string
    sub1: string
    sub2: string
    sub3: string
    sub4?: string
    id?: string
    account?: string
}

// Build the customlink.wwoom.com GET URL that mints the new shortlink. The
// service returns JSON `{ shortLink }`; the caller fetches this URL (a side
// effect that creates a shortlink) only in real run mode.
export function buildCustomlinkRequestUrl(input: CustomlinkRequestInput): string {
    const u = new URL(`https://${CUSTOMLINK_HOST}/`)
    u.searchParams.set('id', String(input.id || CUSTOMLINK_DEFAULT_ID).trim() || CUSTOMLINK_DEFAULT_ID)
    if (input.account) u.searchParams.set('account', String(input.account).trim())
    // Defensive: canonicalize again here so url= can never carry stale Shopee
    // tracking params even if an un-canonicalized productUrl reaches this builder.
    u.searchParams.set('url', canonicalizeProductUrl(String(input.productUrl || '').trim()))
    u.searchParams.set('sub1', String(input.sub1 || '').trim())
    u.searchParams.set('sub2', String(input.sub2 || '').trim())
    u.searchParams.set('sub3', String(input.sub3 || '').trim())
    const sub4 = String(input.sub4 || '').trim()
    if (sub4) u.searchParams.set('sub4', sub4)
    return u.toString()
}

// The utm_content Shopee should carry after the rewrite:
//   legacy/no log id: `<sub1>-<sub2>-<sub3>--`
//   new comments:    `<sub1>-<sub2>-<sub3>-<sub4>-`
// In both cases sub5 is intentionally empty.
export function buildExpectedUtmContent(subs: { sub1: string; sub2: string; sub3: string; sub4?: string }): string {
    const sub1 = String(subs.sub1 || '').trim()
    const sub2 = String(subs.sub2 || '').trim()
    const sub3 = String(subs.sub3 || '').trim()
    const sub4 = String(subs.sub4 || '').trim()
    return sub4 ? `${sub1}-${sub2}-${sub3}-${sub4}-` : `${sub1}-${sub2}-${sub3}--`
}

export type VerifyShortlinkResult = {
    ok: boolean
    utm_content: string
    sub1: string
    sub2: string
    sub3: string
    sub4: string
    expected_utm_content: string
    reason: string
}

// Parse the expanded NEW shortlink and confirm utm_content carries the expected
// sub1/sub2/sub3. Used both right after a write and by the verify endpoint.
export function verifyRewrittenShortlink(
    expandedUrl: string,
    expected: { sub1: string; sub2: string; sub3: string; sub4?: string },
): VerifyShortlinkResult {
    const parsed = parseTrackingSubIds(expandedUrl)
    const expectedUtm = buildExpectedUtmContent(expected)
    const want = {
        sub1: String(expected.sub1 || '').trim(),
        sub2: String(expected.sub2 || '').trim(),
        sub3: String(expected.sub3 || '').trim(),
        sub4: String(expected.sub4 || '').trim(),
    }
    const mismatches: string[] = []
    if (parsed.sub1 !== want.sub1) mismatches.push('sub1')
    if (parsed.sub2 !== want.sub2) mismatches.push('sub2')
    if (parsed.sub3 !== want.sub3) mismatches.push('sub3')
    if (want.sub4 && parsed.sub4 !== want.sub4) mismatches.push('sub4')
    const hasAny = !!(parsed.sub1 || parsed.sub2 || parsed.sub3 || parsed.utm_content)
    const ok = hasAny && mismatches.length === 0
    let reason = ''
    if (!hasAny) reason = 'no_tracking_params'
    else if (mismatches.length) reason = `mismatch_${mismatches.join('_')}`
    return {
        ok,
        utm_content: parsed.utm_content,
        sub1: parsed.sub1,
        sub2: parsed.sub2,
        sub3: parsed.sub3,
        sub4: parsed.sub4,
        expected_utm_content: expectedUtm,
        reason,
    }
}

export type MessageRewriteResult = {
    message: string
    replaced: 'exact' | 'detected' | 'appended' | 'noop'
}

// Swap the old affiliate shortlink for the new one inside a comment message while
// preserving everything else (caption text, emoji, hashtags). Preference:
//   1. exact replace of the known old URL,
//   2. replace the first affiliate/short URL we can detect in the message,
//   3. append the new URL when no link is present,
//   4. no-op when newUrl is empty (never destroy the message).
export function replaceShortlinkInMessage(
    message: string,
    oldUrl: string,
    newUrl: string,
): MessageRewriteResult {
    const text = String(message || '')
    const next = String(newUrl || '').trim()
    const old = String(oldUrl || '').trim()
    if (!next) return { message: text, replaced: 'noop' }

    if (old && text.includes(old)) {
        return { message: text.split(old).join(next), replaced: 'exact' }
    }

    const detected = extractUrlsFromText(text).find((u) => isShortlinkCandidate(u) || isShopeeLink(u) || isCustomlinkLink(u))
    if (detected && text.includes(detected)) {
        return { message: text.split(detected).join(next), replaced: 'detected' }
    }

    const base = text.trim()
    return { message: base ? `${base}\n${next}` : next, replaced: 'appended' }
}

export type WriteActionInput = {
    pageId: string
    commentFromId?: string | null
    oldCommentId?: string | null
    hasRewriteableLink: boolean
    allowCreateNew?: boolean
}

// Decide how to land the new link. Default is edit-only: edit only a page-OWNED
// existing comment. Creating a fresh page comment is behind an explicit override.
// Comments are NEVER deleted by this workflow.
export function computeWriteAction(input: WriteActionInput): RewriteAction {
    if (!input.hasRewriteableLink) return 'skip'
    const pageId = String(input.pageId || '').trim()
    const fromId = String(input.commentFromId || '').trim()
    const commentId = String(input.oldCommentId || '').trim()
    if (commentId && pageId && fromId && fromId === pageId) return 'edit'
    if (input.allowCreateNew === true) return 'create_new'
    return 'skip'
}

export function resolveCreateNewBlockedReason(input: {
    pageId: string
    commentFromId?: string | null
    oldCommentId?: string | null
    allowCreateNew?: boolean
}): string {
    if (input.allowCreateNew === true) return ''
    const pageId = String(input.pageId || '').trim()
    const fromId = String(input.commentFromId || '').trim()
    const commentId = String(input.oldCommentId || '').trim()
    if (!commentId) return 'missing_existing_comment_id'
    if (pageId && fromId && fromId !== pageId) return 'non_page_comment'
    return 'create_new_not_allowed'
}

export type GraphStopSignal = {
    stop: boolean
    reason: string
}

// Detect Graph errors that must halt the whole run (not just skip one item):
// code 368 (temporarily blocked for policy), rate-limit (4 / 17 / 32 / 613),
// and spam/blocked wording. Pure: takes the parsed Graph `error` object.
export function detectGraphStopSignal(error: unknown): GraphStopSignal {
    if (!error || typeof error !== 'object') return { stop: false, reason: '' }
    const err = error as Record<string, unknown>
    const code = Number(err.code)
    const subcode = Number(err.error_subcode)
    const message = String(err.message || '').toLowerCase()

    if (code === 368) return { stop: true, reason: 'policy_block_368' }
    if ([4, 17, 32, 613].includes(code)) return { stop: true, reason: `rate_limit_${code}` }
    if (subcode === 1390008) return { stop: true, reason: 'rate_limit_subcode' }
    if (/\bspam\b/.test(message)) return { stop: true, reason: 'spam' }
    if (/blocked|temporarily restricted|too many|rate limit/.test(message)) {
        return { stop: true, reason: 'blocked' }
    }
    return { stop: false, reason: '' }
}


export const GRAPH_COMMENT_DEFAULT_MIN_SPACING_SECONDS = 60
export const GRAPH_COMMENT_BLOCK_SECONDS = 2 * 60 * 60
export const GRAPH_COMMENT_FEATURE_REGISTRY = 'page_comment_link_registry'
export const GRAPH_COMMENT_FEATURE_REWRITE = 'page_comment_link_rewrite'
export const GRAPH_COMMENT_FEATURE_BACKFILL = 'facebook_page_video_backfill'

export type GraphCommentGuardRow = {
    lastCommentOperationAt?: string | null
    blockUntil?: string | null
    blockReason?: string | null
}

export type GraphCommentGuardDecision = {
    allowed: boolean
    status: 'ok' | 'cooldown' | 'graph_blocked'
    reason: string
    block_until: string
}

export function resolveGraphCommentMinSpacingSeconds(raw: unknown): number {
    if (raw === undefined || raw === null || raw === '') return GRAPH_COMMENT_DEFAULT_MIN_SPACING_SECONDS
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return GRAPH_COMMENT_DEFAULT_MIN_SPACING_SECONDS
    return Math.min(3600, Math.max(0, Math.floor(value)))
}

export function computeGraphCommentBlockUntil(input: { nowMs?: number; minBlockSeconds?: number }): string {
    const now = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now()
    const seconds = Math.max(GRAPH_COMMENT_BLOCK_SECONDS, Math.floor(Number(input.minBlockSeconds || 0)))
    return new Date(now + seconds * 1000).toISOString()
}

export function computeGraphCommentGuardDecision(row: GraphCommentGuardRow | null | undefined, nowMs = Date.now(), minSpacingSeconds = GRAPH_COMMENT_DEFAULT_MIN_SPACING_SECONDS): GraphCommentGuardDecision {
    const blockUntil = String(row?.blockUntil || '').trim()
    if (blockUntil && Date.parse(blockUntil) > nowMs) {
        return { allowed: false, status: 'graph_blocked', reason: String(row?.blockReason || 'graph_blocked').trim() || 'graph_blocked', block_until: blockUntil }
    }
    const lastAt = String(row?.lastCommentOperationAt || '').trim()
    const lastMs = lastAt ? Date.parse(lastAt) : NaN
    const spacingMs = Math.max(0, Math.floor(minSpacingSeconds)) * 1000
    if (Number.isFinite(lastMs) && spacingMs > 0 && nowMs - lastMs < spacingMs) {
        return { allowed: false, status: 'cooldown', reason: 'min_spacing', block_until: new Date(lastMs + spacingMs).toISOString() }
    }
    return { allowed: true, status: 'ok', reason: '', block_until: '' }
}

export const GRAPH_COMMENT_GUARD_TABLE_SQL = `CREATE TABLE IF NOT EXISTS graph_comment_op_guard (
    page_id TEXT NOT NULL,
    feature TEXT NOT NULL,
    last_comment_operation_at TEXT NOT NULL DEFAULT '',
    block_until TEXT NOT NULL DEFAULT '',
    block_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (page_id, feature)
)`

// ---------------------------------------------------------------------------
// D1 schema for the workflow. registry = durable per-item audit snapshot;
// jobs = one rewrite batch; job_items = per-comment history (keeps old_message /
// old_shortlink for rollback). Mirrored in schema.sql + migrations/0020.
// ---------------------------------------------------------------------------

export const PAGE_COMMENT_LINK_REGISTRY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS page_comment_link_registry (
    page_id TEXT NOT NULL,
    fb_video_id TEXT NOT NULL,
    reel_id TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL DEFAULT '',
    canonical_post_id TEXT NOT NULL DEFAULT '',
    comment_target_id TEXT NOT NULL DEFAULT '',
    comment_id TEXT NOT NULL DEFAULT '',
    comment_from_id TEXT NOT NULL DEFAULT '',
    comment_from_name TEXT NOT NULL DEFAULT '',
    old_message TEXT NOT NULL DEFAULT '',
    old_shortlink TEXT NOT NULL DEFAULT '',
    old_expanded_url TEXT NOT NULL DEFAULT '',
    old_utm_content TEXT NOT NULL DEFAULT '',
    old_sub1 TEXT NOT NULL DEFAULT '',
    old_sub2 TEXT NOT NULL DEFAULT '',
    old_sub3 TEXT NOT NULL DEFAULT '',
    old_sub4 TEXT NOT NULL DEFAULT '',
    old_sub5 TEXT NOT NULL DEFAULT '',
    product_url TEXT NOT NULL DEFAULT '',
    old_affiliate_id TEXT NOT NULL DEFAULT '',
    target_affiliate_id TEXT NOT NULL DEFAULT '',
    new_affiliate_id TEXT NOT NULL DEFAULT '',
    affiliate_verify_status TEXT NOT NULL DEFAULT '',
    affiliate_id_match INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '',
    last_audited_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (page_id, fb_video_id)
)`

export const PAGE_COMMENT_LINK_JOBS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS page_comment_link_jobs (
    job_id TEXT NOT NULL PRIMARY KEY,
    page_id TEXT NOT NULL,
    namespace_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'created',
    dry_run INTEGER NOT NULL DEFAULT 1,
    batch_size INTEGER NOT NULL DEFAULT 5,
    stop_on_first_error INTEGER NOT NULL DEFAULT 1,
    requested_sub1 TEXT NOT NULL DEFAULT '',
    customlink_id TEXT NOT NULL DEFAULT '',
    total_items INTEGER NOT NULL DEFAULT 0,
    planned_items INTEGER NOT NULL DEFAULT 0,
    skipped_items INTEGER NOT NULL DEFAULT 0,
    done_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

export const PAGE_COMMENT_LINK_JOB_ITEMS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS page_comment_link_job_items (
    job_id TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    page_id TEXT NOT NULL,
    log_id TEXT NOT NULL DEFAULT '',
    fb_video_id TEXT NOT NULL DEFAULT '',
    reel_id TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL DEFAULT '',
    canonical_post_id TEXT NOT NULL DEFAULT '',
    comment_target_id TEXT NOT NULL DEFAULT '',
    old_comment_id TEXT NOT NULL DEFAULT '',
    new_comment_id TEXT NOT NULL DEFAULT '',
    comment_from_id TEXT NOT NULL DEFAULT '',
    comment_from_name TEXT NOT NULL DEFAULT '',
    old_message TEXT NOT NULL DEFAULT '',
    new_message TEXT NOT NULL DEFAULT '',
    old_shortlink TEXT NOT NULL DEFAULT '',
    old_expanded_url TEXT NOT NULL DEFAULT '',
    old_utm_content TEXT NOT NULL DEFAULT '',
    old_sub1 TEXT NOT NULL DEFAULT '',
    old_sub2 TEXT NOT NULL DEFAULT '',
    old_sub3 TEXT NOT NULL DEFAULT '',
    old_sub4 TEXT NOT NULL DEFAULT '',
    old_sub5 TEXT NOT NULL DEFAULT '',
    product_url TEXT NOT NULL DEFAULT '',
    target_sub1 TEXT NOT NULL DEFAULT '',
    target_sub2 TEXT NOT NULL DEFAULT '',
    target_sub3 TEXT NOT NULL DEFAULT '',
    target_sub4 TEXT NOT NULL DEFAULT '',
    new_shortlink TEXT NOT NULL DEFAULT '',
    new_expanded_url TEXT NOT NULL DEFAULT '',
    new_utm_content TEXT NOT NULL DEFAULT '',
    old_affiliate_id TEXT NOT NULL DEFAULT '',
    target_affiliate_id TEXT NOT NULL DEFAULT '',
    new_affiliate_id TEXT NOT NULL DEFAULT '',
    affiliate_verify_status TEXT NOT NULL DEFAULT '',
    affiliate_id_match INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    reason TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_audited_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (job_id, item_index)
)`

// Durable per-page-story ledger. Unlike page_comment_link_registry (PK
// page_id, fb_video_id), this table mints a stable AUTOINCREMENT numeric `id`
// keyed by (page_id, comment_target_id) so EVERY rewrite target — including
// cache/manual/imported posts with no post_history.id — gets a non-empty
// target_sub4/log_id. Mirrored in schema.sql + migrations/0023.
export const PAGE_POST_LINK_LEDGER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS page_post_link_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    comment_target_id TEXT NOT NULL DEFAULT '',
    page_story_object_id TEXT NOT NULL DEFAULT '',
    fb_video_id TEXT NOT NULL DEFAULT '',
    reel_id TEXT NOT NULL DEFAULT '',
    post_id TEXT NOT NULL DEFAULT '',
    comment_id TEXT NOT NULL DEFAULT '',
    posted_at TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    old_shortlink TEXT NOT NULL DEFAULT '',
    new_shortlink TEXT NOT NULL DEFAULT '',
    old_utm_content TEXT NOT NULL DEFAULT '',
    new_utm_content TEXT NOT NULL DEFAULT '',
    old_affiliate_id TEXT NOT NULL DEFAULT '',
    new_affiliate_id TEXT NOT NULL DEFAULT '',
    target_sub1 TEXT NOT NULL DEFAULT '',
    target_sub2 TEXT NOT NULL DEFAULT '',
    target_sub3 TEXT NOT NULL DEFAULT '',
    target_sub4 TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    last_audited_at TEXT NOT NULL DEFAULT '',
    last_rewrite_at TEXT NOT NULL DEFAULT '',
    last_verified_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

export const PAGE_POST_LINK_LEDGER_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_page_post_link_ledger_key
ON page_post_link_ledger(page_id, comment_target_id)`

export const PAGE_COMMENT_LINK_REGISTRY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_page_comment_link_registry_page
ON page_comment_link_registry(page_id, status, updated_at DESC)`

export const PAGE_COMMENT_LINK_JOBS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_page_comment_link_jobs_page
ON page_comment_link_jobs(page_id, created_at DESC)`
