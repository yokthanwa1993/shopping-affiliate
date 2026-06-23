// Per-page Facebook posting token source — pure, testable routing decisions.
//
// The product exposes ONLY TWO posting modes:
//   'stored_token' = legacy manual / stored page token path (default).
//   'cloak_browser'= CloakBrowser session-cookie bridge. The single non-Electron
//                    browser system that replaced the old Electron video-onecard app.
//                    Whether it posts a normal organic Reel or the OneCard/create-ad
//                    flow is decided by the page's Video One Card / ads-publish flag —
//                    NOT by a separate source/provider.
//
// Legacy/internal DB values 'post-reels-token-cloak' and 'post-reels-token-ads' both
// normalize to the single effective 'cloak_browser' source (backwards compatible — the
// old "Ads/Token" was never a third provider, just CloakBrowser + the OneCard flag).
// Any invalid/missing value normalizes back to 'stored_token' so existing pages keep
// their current behavior.

export type PagePostingTokenSource =
    | 'stored_token'
    | 'cloak_browser'

// The concrete posting backend a page resolves to. Decoupled from the stored source
// label so callers branch on intent, not string literals.
//   'stored_token'        = manual/stored page token organic Reel.
//   'cloak_onecard_bridge'= CloakBrowser bridge OneCard/create-ad flow.
//   'cloak_organic_reel'  = CloakBrowser bridge organic Reel (/post + /page-comment).
export type PostingRoute = 'stored_token' | 'cloak_onecard_bridge' | 'cloak_organic_reel'

// Short, token-free hint stamped into history/logs. Never a token value.
export type PostingSourceHint = 'stored_token' | 'cloak_onecard_bridge' | 'cloak_organic_reel'

export function normalizePagePostingTokenSource(rawValue: unknown): PagePostingTokenSource {
    const value = String(rawValue ?? '').trim().toLowerCase()
    // Canonical + every legacy/internal alias collapses to the single CloakBrowser source.
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

// Resolve the effective posting backend. For CloakBrowser the Video One Card toggle (or
// the legacy admin `ads_publish_enabled` flag) selects the OneCard/create-ad route;
// otherwise it posts an organic Reel through the same bridge. A CloakBrowser selection is
// never silently downgraded to a stored/manual token. For stored_token the legacy
// `ads_publish_enabled` flag still promotes to the OneCard/create-ad route (backwards
// compatible).
export function resolvePostingRoute(params: {
    source: PagePostingTokenSource
    oneCardEnabled?: boolean
    adsPublishLegacyFlag?: boolean
}): PostingRoute {
    if (params.source === 'cloak_browser') {
        if (params.oneCardEnabled || params.adsPublishLegacyFlag) return 'cloak_onecard_bridge'
        return 'cloak_organic_reel'
    }
    if (params.adsPublishLegacyFlag) return 'cloak_onecard_bridge'
    return 'stored_token'
}

export function postingSourceHint(route: PostingRoute): PostingSourceHint {
    if (route === 'cloak_onecard_bridge') return 'cloak_onecard_bridge'
    if (route === 'cloak_organic_reel') return 'cloak_organic_reel'
    return 'stored_token'
}

// Power Editor / CloakBrowser is ADMIN-OWNED ONLY. The session-cookie bridge only knows the
// admin operator's own logged-in Pages, so a member/team (non-admin) namespace can never post
// or comment through it — attempting to does NOT degrade gracefully, it hard-fails
// `session_bridge_page_not_authorized`. This guard collapses ANY non-stored source down to
// 'stored_token' for non-admin namespaces, regardless of whether the value came from a stale
// legacy DB alias or a client save payload. It is the single chokepoint that keeps member
// pages (e.g. ข่าวสด) on their own manually stored Facebook Lite/Page token. Admin namespaces
// pass through unchanged, so explicit Power Editor selections keep working exactly as before.
export function restrictCloakToAdminNamespace(
    source: PagePostingTokenSource,
    isAdminNamespace: boolean,
): PagePostingTokenSource {
    if (isAdminNamespace) return source
    return 'stored_token'
}

// ---- Per-page Facebook COMMENT token source -------------------------------
// Independent, per-page selector for HOW the automatic affiliate comment is sent
// AFTER a post. Same two canonical values as the posting source, but decoupled so an
// operator can, e.g., post via CloakBrowser yet comment with a stored Page token (or
// vice-versa):
//   'stored_token' = comment via the stored/dedicated page comment token over Graph
//                    (the deferred `comment_status='pending'` backlog path).
//   'cloak_browser'= comment as the Page via the CloakBrowser bridge /page-comment route.
// Legacy DB aliases collapse the same way the posting source does. A missing/invalid
// value normalizes to the supplied `fallback` — at runtime that fallback is the page's
// effective posting source (see defaultCommentSourceForRoute) so pages that never set a
// comment source keep commenting EXACTLY as before.
export type PageCommentTokenSource = PagePostingTokenSource

export function normalizePageCommentTokenSource(
    rawValue: unknown,
    fallback: PageCommentTokenSource = 'stored_token',
): PageCommentTokenSource {
    const value = String(rawValue ?? '').trim().toLowerCase()
    if (
        value === 'cloak_browser' ||
        value === 'cloakbrowser' ||
        value === 'cloak' ||
        value === 'post-reels-token-cloak' ||
        value === 'post-reels-token-ads'
    ) {
        return 'cloak_browser'
    }
    if (
        value === 'stored_token' ||
        value === 'stored' ||
        value === 'token' ||
        value === 'page' ||
        value === 'page_token'
    ) {
        return 'stored_token'
    }
    // Missing/invalid → conservative fallback (typically the page's posting source) so
    // existing pages are unaffected.
    return fallback === 'cloak_browser' ? 'cloak_browser' : 'stored_token'
}

// Conservative default comment backend for a resolved posting route: whatever the post
// itself used. A stored-token post defaults to a stored-token comment; any CloakBrowser
// route (organic Reel or OneCard/create-ad) defaults to a CloakBrowser bridge comment.
// This reproduces the exact pre-feature behavior when a page has no explicit
// comment_token_source.
export function defaultCommentSourceForRoute(route: PostingRoute): PageCommentTokenSource {
    return route === 'stored_token' ? 'stored_token' : 'cloak_browser'
}

// ---- Stored/Facebook Lite comment → CloakBrowser bridge fallback ----------
// A page can post via the CloakBrowser/Power Editor session bridge yet comment with a
// stored Facebook Lite token (comment_token_source='stored_token'). When that stored token
// is missing or invalidated, the deferred pending-comment backlog would otherwise leave a
// "posted but no comment" row. These two pure predicates gate a narrow fallback: re-post the
// SAME affiliate comment as the Page through the bridge /page-comment route — but ONLY when
// the original post already went out through that admin-owned bridge.

// Eligibility: the original post's `post_token_hint` proves the CloakBrowser bridge already
// has authorized access to this Page. 'cloak_session_bridge' = organic Reel via /post;
// 'ads_publish' = OneCard/create-ad via the same bridge. Any other hint (e.g. a stored-token
// organic post) is NOT eligible — the bridge has no proven access to that Page, so we never
// silently route a member/manual page onto the admin-owned bridge.
export function isCloakBridgeCommentFallbackEligible(postTokenHint: unknown): boolean {
    const hint = String(postTokenHint ?? '').trim().toLowerCase()
    return hint === 'cloak_session_bridge' || hint === 'ads_publish'
}

// Classify a stored/Facebook Lite comment failure as a token auth/availability problem that
// warrants the bridge fallback: a missing token, or a Graph API auth error (OAuthException /
// code 190 / invalidated session / expired-or-malformed access token). Operates only on the
// already-sanitized, redacted error strings the worker stores — never a raw token value.
// Returns false for unrelated failures (e.g. a transient bridge/target error) so the operator's
// stored-token selection still surfaces those errors instead of masking them with a fallback.
export function isStoredCommentTokenAuthFailure(error: unknown): boolean {
    const msg = String(error ?? '').toLowerCase()
    if (!msg) return false
    return (
        msg.includes('access_token_missing') ||
        msg.includes('session has been invalidated') ||
        msg.includes('error validating access token') ||
        msg.includes('oauthexception') ||
        /(^|[^0-9])(?:code["']?\s*[:=]\s*)190(\D|$)/.test(msg) ||
        (msg.includes('access token') && (msg.includes('invalid') || msg.includes('expire') || msg.includes('malformed')))
    )
}

// ---- Facebook Lite (FB GET Token) on-demand refresh ----------------------
// The product builds a password-backed FB GET Token / Facebook Lite system: every
// stored profile keeps its uid/password/TOTP/datr in BrowserSaving, so a fresh page
// token can ALWAYS be re-minted from those credentials. There must therefore be no
// permanent "token expired" state for a Facebook Lite (stored_token) page — when the
// stored token is missing or rejected by Graph with an auth error (190 / invalidated
// session), the worker re-mints a fresh token through the BrowserSaving
// token-facebook-lite pipeline and retries ONCE before falling back / failing.
//
// These pure predicates and shapers keep the refresh routing + redaction decisions
// testable and token-free. The CloakBrowser/Power Editor comment path is intentionally
// excluded: those comments are delivered by the bridge's own logged-in session and never
// use a stored Facebook Lite token, so refreshing one would be meaningless.

// Should we attempt an FB Lite refresh for a stored-token comment? Only for the
// 'stored_token' comment source, and only when the token is missing OR the failure is an
// auth/availability problem (see isStoredCommentTokenAuthFailure). Any other failure
// (transient bridge/target error, rate limit, etc.) is surfaced unchanged — refreshing
// the token would not help and would mask the real error.
export function shouldAttemptFacebookLiteRefresh(params: {
    commentSource: PageCommentTokenSource
    tokenMissing?: boolean
    error?: unknown
}): boolean {
    if (params.commentSource !== 'stored_token') return false
    if (params.tokenMissing) return true
    return isStoredCommentTokenAuthFailure(params.error)
}

// Body the Worker POSTs to the BrowserSaving secret-authed refresh route. profile_id is
// OPTIONAL: when omitted, BrowserSaving auto-discovers the stored Account Manager profile
// that owns/admins page_id (no manual linking required). page_id / namespace_id route the
// resolved token back to the right namespace page; owner_emails scope the auto-discovery to
// the namespace's operator(s). dry_run asks BrowserSaving to report what it WOULD refresh
// without minting/pushing. Never carries a token value.
export interface FacebookLiteRefreshRequestBody {
    profile_id?: string
    page_id?: string
    page_name?: string
    namespace_id?: string
    owner_emails?: string[]
    candidate_profile_ids?: string[]
    candidate_login_ids?: string[]
    dry_run?: boolean
}

export function buildFacebookLiteRefreshRequestBody(params: {
    profileId?: string
    pageId?: string
    pageName?: string
    namespaceId?: string
    ownerEmails?: string[]
    candidateProfileIds?: string[]
    candidateLoginIds?: string[]
    dryRun?: boolean
}): FacebookLiteRefreshRequestBody {
    const body: FacebookLiteRefreshRequestBody = {}
    const profileId = String(params.profileId ?? '').trim()
    const pageId = String(params.pageId ?? '').trim()
    const namespaceId = String(params.namespaceId ?? '').trim()
    const pageName = String(params.pageName ?? '').trim()
    const ownerEmails = Array.from(new Set(
        (params.ownerEmails ?? []).map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean),
    ))
    const candidateProfileIds = Array.from(new Set(
        (params.candidateProfileIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean),
    ))
    const candidateLoginIds = Array.from(new Set(
        (params.candidateLoginIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean),
    ))
    if (profileId) body.profile_id = profileId
    if (pageId) body.page_id = pageId
    if (pageName) body.page_name = pageName
    if (namespaceId) body.namespace_id = namespaceId
    if (ownerEmails.length) body.owner_emails = ownerEmails
    if (candidateProfileIds.length) body.candidate_profile_ids = candidateProfileIds
    if (candidateLoginIds.length) body.candidate_login_ids = candidateLoginIds
    if (params.dryRun) body.dry_run = true
    return body
}

// Token-free outcome of a refresh attempt — what the Worker keeps after calling the
// BrowserSaving route. `refreshed` = a fresh token was minted; `synced` = it was pushed
// back into video-affiliate's namespace pool (so the retry can read it). `reason` is a
// short redacted hint for logs, never a token.
export interface FacebookLiteRefreshOutcome {
    ok: boolean
    refreshed: boolean
    synced: boolean
    pageId: string
    reason: string
}

// Parse the BrowserSaving refresh route's JSON response into a token-free outcome. The
// route returns only booleans/redacted hints, but parse defensively in case of partial
// payloads. Any token-like field is ignored entirely.
export function parseFacebookLiteRefreshResponse(httpOk: boolean, data: unknown): FacebookLiteRefreshOutcome {
    const payload = (data && typeof data === 'object') ? data as Record<string, unknown> : {}
    const ok = httpOk && payload.ok === true
    const refreshed = ok && payload.refreshed === true
    const synced = refreshed && (payload.synced === true || payload.video_affiliate_sync === true)
    const pageId = String(payload.page_id ?? '').trim()
    const reasonRaw = String(payload.reason ?? payload.error ?? '').trim()
    return {
        ok,
        refreshed,
        synced,
        pageId,
        reason: reasonRaw ? reasonRaw.slice(0, 120) : (ok ? 'refreshed' : 'refresh_failed'),
    }
}

// Server-side (BrowserSaving) shaper: collapse an internal refresh result down to the
// token-free response body the route returns. NEVER include a token, cookie, password or
// raw error containing one — only booleans + already-redacted short hints.
export interface FacebookLiteRefreshResponseBody {
    ok: boolean
    refreshed: boolean
    synced: boolean
    dry_run: boolean
    profile_present: boolean
    has_credentials: boolean
    page_id: string | null
    reason: string
}

export function redactFacebookLiteRefreshResult(params: {
    ok: boolean
    refreshed?: boolean
    synced?: boolean
    dryRun?: boolean
    profilePresent?: boolean
    hasCredentials?: boolean
    pageId?: string | null
    reason?: string
}): FacebookLiteRefreshResponseBody {
    const reasonRaw = String(params.reason ?? '').trim()
    const pageId = String(params.pageId ?? '').trim()
    return {
        ok: params.ok === true,
        refreshed: params.refreshed === true,
        synced: params.synced === true,
        dry_run: params.dryRun === true,
        profile_present: params.profilePresent === true,
        has_credentials: params.hasCredentials === true,
        page_id: pageId || null,
        reason: reasonRaw ? reasonRaw.slice(0, 120) : (params.ok ? 'ok' : 'failed'),
    }
}

// Env subset the CloakBrowser Facebook posting bridge base URL is resolved from.
export interface CloakFbBridgeEnv {
    // Primary: the non-Electron CloakBrowser Facebook posting bridge.
    CLOAK_FB_BRIDGE_URL?: string
    // Deprecated fallback ONLY. The old Electron menu-bar bridge (video-onecard, port 3847,
    // tunnel https://video-onecard.wwoom.com) has been removed. If this env still holds
    // that retired URL/port it is IGNORED so active posting never targets the dead bridge;
    // a non-retired URL is honored only for backwards compatibility during migration.
    VIDEO_ONECARD_WORKER_URL?: string
}

// The retired Electron bridge — never targeted by active posting code, even if the old
// VIDEO_ONECARD_WORKER_URL env still holds its URL/port after the menu-bar app's removal.
export function isRetiredElectronBridge(rawUrl: unknown): boolean {
    const v = String(rawUrl ?? '').trim().toLowerCase()
    if (!v) return false
    return v.includes('video-onecard.wwoom.com') || /(^|[^0-9])3847(\D|$)/.test(v)
}

// Resolve the CloakBrowser FB posting bridge base URL. There is NO hardcoded default: when
// the bridge is not configured this returns '' and callers MUST fail closed with a precise
// `bridge_not_configured` error rather than silently hitting a dead tunnel. The bridge uses
// its own logged-in CloakBrowser session/page tokens internally — the Worker never sends,
// receives, or logs a raw token.
export function resolveCloakFbBridgeBaseUrl(env: CloakFbBridgeEnv | null | undefined): string {
    const trim = (v: unknown) => String(v ?? '').trim().replace(/\/+$/, '')
    const primary = trim(env?.CLOAK_FB_BRIDGE_URL)
    if (primary) return primary
    const legacy = trim(env?.VIDEO_ONECARD_WORKER_URL)
    if (legacy && !isRetiredElectronBridge(legacy)) return legacy
    return ''
}
