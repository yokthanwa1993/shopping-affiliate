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

// Posting-side twin of shouldAttemptFacebookLiteRefresh. A stored-token / Facebook Lite
// PUBLISH (organic Reel) that fails because the stored page token is missing or has been
// rejected by Graph (190 / invalidated session / "error validating access token") is exactly
// the case the FB GET Token / Bridge Token system can recover from by re-minting a fresh page
// token and retrying. The publish-path errors are aggregate strings the fallback chain throws
// (`all_direct_video_tokens_failed`, `all_post_tokens_failed`, `facebook_publish_all_paths_failed`,
// `facebook_access_token_missing`); isStoredCommentTokenAuthFailure already matches the embedded
// 190/invalidated/validating substrings, and access_token_missing is matched explicitly here.
// Any other failure (transient FB 5xx, "reduce the amount of data", rate limit, video too small)
// returns false so the original error surfaces unchanged instead of being masked by a refresh.
export function shouldAttemptFacebookLitePostingRefresh(params: {
    source: PagePostingTokenSource
    tokenMissing?: boolean
    error?: unknown
}): boolean {
    if (params.source !== 'stored_token') return false
    if (params.tokenMissing) return true
    const msg = String(params.error ?? '').toLowerCase()
    if (msg.includes('access_token_missing')) return true
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

// ---- Facebook Lite (EAAD6V) page-token prioritization --------------------
// A Facebook Lite page token is EAAD6/EAAD6V-prefixed. The legacy isPostRoleToken() gate in
// index.ts excludes EAAD6 (it predates Facebook Lite), which made a freshly-synced EAAD6V token
// LOSE to a stale EAABsb token: the upsert/preserve gates dropped the EAAD6V from the stored
// PRIMARY (`isPostRoleToken(existing) ? existing : ''` blanks an EAAD6V), and the candidate order
// then kept the stale EAABsb ahead. These pure helpers fix that — an EAAD6V page token is a fully
// valid stored_token POST candidate, and a freshly-synced page token (facebook_lite_bridge export
// or the newest access_token) must lead the pool.

export function isFacebookLitePageToken(token: unknown): boolean {
    return /^EAAD6/i.test(String(token ?? '').trim())
}

// A page access_token worth keeping as the stored PRIMARY token — ANY non-empty page token,
// EAAB- or EAAD6-prefixed. Used by the "preserve existing primary" gates so a fresh Facebook
// Lite (EAAD6V) token is never wiped/blanked just because it is not EAAB-prefixed (the bug that
// let stale EAABsb stay primary). It never PROMOTES a token ahead of a fresher one — it only
// decides whether an EXISTING stored token is worth keeping when nothing fresher is available.
export function isPersistablePagePrimaryToken(token: unknown): boolean {
    return String(token ?? '').trim().length > 0
}

export interface SyncedPageTokenPools {
    primaryToken: string
    postTokens: string[]
    commentTokens: string[]
}

// Case-insensitive, order-preserving de-dupe (mirrors index.ts uniqueTokens semantics) so this
// module stays self-contained and unit-testable.
function dedupePreserveOrder(tokens: Array<string | null | undefined>): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of tokens) {
        const token = String(raw ?? '').trim()
        if (!token) continue
        const key = token.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(token)
    }
    return out
}

// Compute the next stored pools when a freshly-synced page token arrives (profile-sync /
// Token Bridge facebook_lite_bridge export). The fresh token ALWAYS leads post_tokens,
// comment_tokens AND becomes the stored primary — so a fresh EAAD6V immediately outranks any
// stale EAABsb already present (post + access_token). Prior tokens are retained strictly AFTER as
// fallback (deduped, case-insensitive); none are deleted. When the incoming token is empty, the
// freshest existing stored token is kept (never blanked). Promotion is unconditional so BOTH a
// `token_source=facebook_lite_bridge` push and a bare EAAD6V accessToken are prioritized.
export function prioritizeSyncedPageTokenPools(params: {
    incomingToken: string
    incomingCommentToken?: string
    existingPrimaryToken?: string
    existingPostTokens?: string[]
    existingCommentTokens?: string[]
}): SyncedPageTokenPools {
    const incoming = String(params.incomingToken ?? '').trim()
    const incomingComment = String(params.incomingCommentToken ?? '').trim()
    const existingPrimary = String(params.existingPrimaryToken ?? '').trim()
    const postTokens = dedupePreserveOrder([
        incoming,
        ...(params.existingPostTokens || []),
        existingPrimary,
    ])
    const commentTokens = dedupePreserveOrder([
        incomingComment || incoming,
        incoming,
        ...(params.existingCommentTokens || []),
    ])
    const primaryToken = incoming || postTokens[0] || existingPrimary || ''
    return { primaryToken, postTokens, commentTokens }
}

// A Facebook Lite (EAAD6V) page token cannot publish through the Worker's own Graph app /
// the ad account: those calls return "(#10) Permission Denied" (Graph error code 10), NOT an
// auth/190 error. This is recoverable ONLY by posting through the local Facebook Lite bridge's
// own logged-in session (organic /post), so it must trigger the bridge fallback the same way an
// auth failure does. shouldAttemptFacebookLitePostingRefresh (auth/190/invalidated only) does NOT
// match (#10), which is exactly why the bridge fallback was being skipped and the row burned.
export function isFacebookLitePostingPermissionError(error: unknown): boolean {
    const msg = String(error ?? '').toLowerCase()
    if (!msg) return false
    return (
        /\(#10\)/.test(msg) ||
        msg.includes('permission denied') ||
        /(^|[^0-9])(?:code["']?\s*[:=]\s*)10(\D|$)/.test(msg)
    )
}

// ---- OneCard (ad-account) → organic Facebook Lite reel fallback -----------
// A page with onecard_enabled=1 publishes through the cloak-fb-bridge ad-account/create-ad path
// (Power Editor). A stored Facebook Lite (EAAD6V) page token CANNOT drive the ad account, so an
// ad-permission failure there (e.g. "upload_video:(#10) Permission Denied") must not burn the
// post_history row. When a usable stored page post token exists, force-post falls back to a REAL
// organic Page reel via that EAAD6V token (Worker Graph /video_reels|/videos + the Facebook Lite
// bridge) instead of Power Editor. This pure predicate gates that fallback so it stays testable.
export function shouldFallbackToOrganicAfterOneCardFailure(params: {
    haveStoredPostToken: boolean
    error?: unknown
}): boolean {
    // No stored page token → pure admin/CloakBrowser OneCard page; keep failing closed (unchanged).
    if (!params.haveStoredPostToken) return false
    // Local/pre-upload failures an organic retry would ALSO hit → no point falling back.
    const msg = String(params.error ?? '').toLowerCase()
    if (
        msg.includes('video too small') ||
        msg.includes('fetch video failed') ||
        msg.includes('avatar_compose_failed')
    ) {
        return false
    }
    // Everything else (ad permission denied, bridge unreachable/not configured, advideos failure)
    // is an ad-path problem an organic EAAD6V reel does NOT share → fall back.
    return true
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

// ---- Bridge Token (Facebook Lite / Power Editor) /pages page-token fallback --------------
// When the BrowserSaving secret refresh route is unavailable (e.g. returns "Not found"), the
// Worker can still re-mint a stored-token page's posting token from the SAME Bridge Token local
// tool that powers Facebook Lite / Power Editor — exposed in production at CLOAK_FB_BRIDGE_URL
// (https://short.wwoom.com). The tool's `GET /pages?account=<login>&includeToken=1` route returns
// the page-scoped access_token for every page the logged-in session administers. `includeToken=1`
// is gated to local requests on the tool, but a cloudflared tunnel origin request arrives as
// 127.0.0.1, so the tunnel returns the token (verified in production). The Worker reads that token
// IN MEMORY ONLY — it is synced into the pool and used for the retry, never returned or logged.

// Build the Bridge Token /pages lookup URL. `account` (a Facebook login/candidate id) is optional:
// omitted → the tool uses its default logged-in session, which lists every administered page.
export function buildBridgeTokenPagesUrl(params: {
    baseUrl: string
    account?: string
    includeToken?: boolean
}): string {
    const base = String(params.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!base) return ''
    const qs = new URLSearchParams()
    const account = String(params.account ?? '').trim()
    if (account) qs.set('account', account)
    if (params.includeToken) qs.set('includeToken', '1')
    const query = qs.toString()
    return query ? `${base}/pages?${query}` : `${base}/pages`
}

// Token-bearing result of a Bridge Token /pages lookup. `accessToken` is a RAW page token held in
// memory only — callers must sync it into storage and never log/return it. `hasToken` reflects the
// tool's own presence flag so a caller can distinguish "page found but token withheld" from "page
// not administered".
export interface BridgeTokenPageLookup {
    found: boolean
    hasToken: boolean
    accessToken: string
}

// Extract the page-scoped access_token for `pageId` from a Bridge Token /pages response
// (`{ data: [{ id, name, hasToken, access_token? }] }`). Returns the first matching row's token.
export function extractBridgeTokenPageAccessToken(data: unknown, pageId: string): BridgeTokenPageLookup {
    const wantId = String(pageId ?? '').trim()
    const rows = (data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data))
        ? (data as { data: unknown[] }).data
        : []
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const r = row as Record<string, unknown>
        if (String(r.id ?? '').trim() !== wantId) continue
        const token = String(r.access_token ?? '').trim()
        return { found: true, hasToken: token.length > 0 || r.hasToken === true, accessToken: token }
    }
    return { found: false, hasToken: false, accessToken: '' }
}

// ---- Bridge /token/auto-sync (Worker → bridge TRUE-RECOVERY trigger) -------
// The product is fully self-healing: there is NO operator button/manual sync/manual export. When a
// stored/Facebook Lite PUBLISH or COMMENT fails because the page token was invalidated (190 /
// "session has been invalidated"), the Worker AUTOMATICALLY asks the local Facebook Lite bridge to
// run its true-bridge recovery — re-mint a fresh token from the stored credentials/session, list
// the administered pages in real time, and refresh every matching page token back into THIS
// namespace's pool. The Worker then reloads the pool and retries once. These pure helpers keep the
// URL/body shaping, response parsing and rate-limit backoff testable and token-free. The bridge
// endpoint is internal machine-to-machine (secret-authenticated), never UI-driven.

// The bridge auto-sync URL. `baseUrl` must already be resolved (resolveCloakFbBridgeBaseUrl); '' when
// the bridge is not configured, so the caller fails closed with a sanitized `bridge_not_configured`.
export function buildBridgeAutoSyncUrl(baseUrl: string): string {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
    return base ? `${base}/token/auto-sync` : ''
}

// Token-free body the Worker POSTs to /token/auto-sync. `namespaceId` scopes the recovery to the
// failing page's namespace; `account` / `candidateLoginIds` target a specific FB Lite login (omitted
// → the bridge scans all FB-Lite-likely accounts). `dryRun` is ALWAYS false for an internal trusted
// recovery call — a dry run would resolve no token and leave posting broken.
export interface BridgeAutoSyncRequestBody {
    namespaceId: string
    dryRun: false
    account?: string
    accounts?: string[]
    // Page-targeted recovery: when a SPECIFIC page's token was invalidated, scope the bridge scan to
    // that page so it refreshes exactly that row (and reports a page-not-found outcome instead of
    // silently touching nothing) — the difference between "tried and the account lacks the page" and
    // "recovered the whole namespace".
    pageId?: string
    // Explicit fallback accounts to try (in order, AFTER the primary `account`) when the page's primary
    // bridge account can no longer mint a token / no longer administers the page. e.g. Chanalai →
    // Thanwan. The bridge ALSO merges any env-configured fallback mapping; this is the per-call hint.
    fallbackAccounts?: string[]
}

export function buildBridgeAutoSyncRequestBody(params: {
    namespaceId: string
    account?: string
    candidateLoginIds?: string[]
    pageId?: string
    fallbackAccounts?: string[]
}): BridgeAutoSyncRequestBody {
    const body: BridgeAutoSyncRequestBody = { namespaceId: String(params.namespaceId ?? '').trim(), dryRun: false }
    const account = String(params.account ?? '').trim()
    const accounts = Array.from(new Set(
        (params.candidateLoginIds ?? []).map((v) => String(v ?? '').trim()).filter(Boolean),
    ))
    if (account) body.account = account
    else if (accounts.length) body.accounts = accounts
    const pageId = String(params.pageId ?? '').trim()
    if (pageId) body.pageId = pageId
    // Fallback accounts are sent verbatim (deduped/trimmed) and never collapsed into `account`/`accounts`
    // — the bridge appends them to the scan order so the primary is always tried first.
    const fallbackAccounts = Array.from(new Set(
        (params.fallbackAccounts ?? []).map((v) => String(v ?? '').trim()).filter(Boolean),
    )).filter((a) => a !== account)
    if (fallbackAccounts.length) body.fallbackAccounts = fallbackAccounts
    return body
}

// Parse an env-configured account/page → fallback-accounts mapping. Accepts a JSON object whose values
// are arrays or comma/space separated strings of account ids: e.g.
//   {"100090320823561":["100077795357192"]}   (Chanalai → Thanwan)
// Returns a normalized map of trimmed key → deduped trimmed id list. Malformed input yields {} (never
// throws) so a bad env var can never break posting. Token-free (account ids are public uids).
export function parseAccountFallbackMap(raw: unknown): Record<string, string[]> {
    let parsed: unknown = raw
    if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (!trimmed) return {}
        try { parsed = JSON.parse(trimmed) } catch { return {} }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const key = String(k ?? '').trim()
        if (!key) continue
        let items: unknown[] = []
        if (Array.isArray(v)) items = v
        else if (typeof v === 'string') items = v.split(/[\s,]+/)
        else continue
        const ids = Array.from(new Set(items.map((x) => String(x ?? '').trim()).filter(Boolean)))
        if (ids.length) out[key] = ids
    }
    return out
}

// Resolve the ordered fallback-account list for a failing page from env-configured mappings + an
// optional explicit hint. Primary account (and the page itself) are excluded — the bridge always tries
// the primary first, so a fallback list that re-listed it would be wasted. Deduped, order-preserving:
// explicit hints first, then page→accounts mapping, then account→accounts mapping.
export function resolveBridgeFallbackAccounts(params: {
    primaryAccount?: string
    pageId?: string
    accountFallbackMap?: Record<string, string[]>
    pageFallbackMap?: Record<string, string[]>
    explicit?: string[]
}): string[] {
    const primary = String(params.primaryAccount ?? '').trim()
    const pageId = String(params.pageId ?? '').trim()
    const seen = new Set<string>()
    if (primary) seen.add(primary)
    const out: string[] = []
    const push = (list: string[] | undefined) => {
        for (const raw of list ?? []) {
            const id = String(raw ?? '').trim()
            if (!id || seen.has(id)) continue
            seen.add(id)
            out.push(id)
        }
    }
    push(params.explicit)
    if (pageId) push(params.pageFallbackMap?.[pageId])
    if (primary) push(params.accountFallbackMap?.[primary])
    return out
}

// Token-free outcome the Worker keeps after an auto-sync call. `synced` = the bridge refreshed ≥1
// page token into the pool (so the caller may reload + retry). `reason` is a short redacted hint,
// never a token. The bridge response is already token-free (booleans/ids/sanitized reasons only).
export interface BridgeAutoSyncOutcome {
    ok: boolean
    synced: boolean
    reason: string
}

export function parseBridgeAutoSyncResponse(httpOk: boolean, data: unknown): BridgeAutoSyncOutcome {
    const payload = (data && typeof data === 'object') ? data as Record<string, unknown> : {}
    const counts = (payload.counts && typeof payload.counts === 'object') ? payload.counts as Record<string, unknown> : {}
    const syncedCount = Number(counts.synced ?? 0)
    const synced = httpOk && (payload.synced === true || syncedCount > 0)
    const ok = httpOk && payload.ok === true
    const reasonRaw = String(payload.status ?? payload.error ?? '').trim()
    return { ok, synced, reason: reasonRaw ? reasonRaw.slice(0, 120) : (synced ? 'synced' : 'auto_sync_no_pages') }
}

// Rate-limit backoff: fire at most ONE live auto-sync per namespace per TTL window. A repeated
// publish/comment failure across pages / cron passes in the same window must NOT re-trigger a fresh
// mint — that is exactly what trips Facebook's login rate limiter. Pure, so it is unit-testable.
// Returns true when a NEW attempt is allowed at `nowMs` given the last attempt (0/undefined = never
// attempted). A non-positive TTL disables throttling (used by tests).
export function isBridgeAutoSyncAllowed(lastAttemptMs: number | undefined, nowMs: number, ttlMs: number): boolean {
    const last = Number(lastAttemptMs || 0)
    if (!last) return true
    if (!(ttlMs > 0)) return true
    return (nowMs - last) >= ttlMs
}
