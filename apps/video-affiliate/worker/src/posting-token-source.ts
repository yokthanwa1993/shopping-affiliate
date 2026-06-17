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
