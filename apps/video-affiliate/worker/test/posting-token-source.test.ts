import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
    normalizePagePostingTokenSource,
    resolvePostingRoute,
    postingSourceHint,
    resolveCloakFbBridgeBaseUrl,
    isRetiredElectronBridge,
    normalizePageCommentTokenSource,
    defaultCommentSourceForRoute,
    isCloakBridgeCommentFallbackEligible,
    isStoredCommentTokenAuthFailure,
    shouldAttemptFacebookLiteRefresh,
    buildFacebookLiteRefreshRequestBody,
    parseFacebookLiteRefreshResponse,
    redactFacebookLiteRefreshResult,
} from '../src/posting-token-source'

test('normalize: only two modes — stored_token and cloak_browser', () => {
    assert.equal(normalizePagePostingTokenSource('stored_token'), 'stored_token')
    assert.equal(normalizePagePostingTokenSource('cloak_browser'), 'cloak_browser')
    // legacy/internal DB values collapse to the single CloakBrowser source (no third provider)
    assert.equal(normalizePagePostingTokenSource('post-reels-token-cloak'), 'cloak_browser')
    assert.equal(normalizePagePostingTokenSource('post-reels-token-ads'), 'cloak_browser')
    assert.equal(normalizePagePostingTokenSource('cloak'), 'cloak_browser')
    assert.equal(normalizePagePostingTokenSource('cloakbrowser'), 'cloak_browser')
    // case-insensitive + trimmed
    assert.equal(normalizePagePostingTokenSource('  POST-REELS-TOKEN-ADS '), 'cloak_browser')
    assert.equal(normalizePagePostingTokenSource('  CLOAK_BROWSER '), 'cloak_browser')
    // invalid / missing → legacy default
    assert.equal(normalizePagePostingTokenSource(undefined), 'stored_token')
    assert.equal(normalizePagePostingTokenSource(null), 'stored_token')
    assert.equal(normalizePagePostingTokenSource(''), 'stored_token')
    assert.equal(normalizePagePostingTokenSource('garbage'), 'stored_token')
})

test('route: CloakBrowser + One Card OFF → organic Reel via the bridge', () => {
    assert.equal(resolvePostingRoute({ source: 'cloak_browser' }), 'cloak_organic_reel')
    assert.equal(resolvePostingRoute({ source: 'cloak_browser', oneCardEnabled: false }), 'cloak_organic_reel')
})

test('route: CloakBrowser + One Card ON → OneCard/create-ad via the bridge', () => {
    assert.equal(resolvePostingRoute({ source: 'cloak_browser', oneCardEnabled: true }), 'cloak_onecard_bridge')
    // legacy admin ads-publish flag also selects the OneCard/create-ad route under CloakBrowser
    assert.equal(resolvePostingRoute({ source: 'cloak_browser', adsPublishLegacyFlag: true }), 'cloak_onecard_bridge')
})

test('route: stored_token stays stored unless the legacy ads-publish flag promotes it', () => {
    assert.equal(resolvePostingRoute({ source: 'stored_token' }), 'stored_token')
    assert.equal(resolvePostingRoute({ source: 'stored_token', oneCardEnabled: false }), 'stored_token')
    // backwards compatible: the legacy admin flag still routes a stored page to create-ad
    assert.equal(resolvePostingRoute({ source: 'stored_token', adsPublishLegacyFlag: true }), 'cloak_onecard_bridge')
})

test('route: a CloakBrowser selection is never silently downgraded to a stored token', () => {
    assert.notEqual(resolvePostingRoute({ source: 'cloak_browser' }), 'stored_token')
    assert.notEqual(resolvePostingRoute({ source: 'cloak_browser', oneCardEnabled: true }), 'stored_token')
})

test('source hint maps route → token-free label (never a token, never video-onecard)', () => {
    assert.equal(postingSourceHint('cloak_organic_reel'), 'cloak_organic_reel')
    assert.equal(postingSourceHint('cloak_onecard_bridge'), 'cloak_onecard_bridge')
    assert.equal(postingSourceHint('stored_token'), 'stored_token')
})

test('Cloak FB bridge base URL: CLOAK_FB_BRIDGE_URL is primary, trailing slash trimmed', () => {
    assert.equal(
        resolveCloakFbBridgeBaseUrl({ CLOAK_FB_BRIDGE_URL: 'https://fb-bridge.example.com/' }),
        'https://fb-bridge.example.com',
    )
    assert.equal(
        resolveCloakFbBridgeBaseUrl({ CLOAK_FB_BRIDGE_URL: 'http://127.0.0.1:8830' }),
        'http://127.0.0.1:8830',
    )
    // Primary wins over the deprecated fallback even if both are set.
    assert.equal(
        resolveCloakFbBridgeBaseUrl({
            CLOAK_FB_BRIDGE_URL: 'http://127.0.0.1:8830',
            VIDEO_ONECARD_WORKER_URL: 'https://something-else.example.com',
        }),
        'http://127.0.0.1:8830',
    )
})

test('Cloak FB bridge base URL: NO default — unconfigured returns "" so callers fail closed', () => {
    assert.equal(resolveCloakFbBridgeBaseUrl(undefined), '')
    assert.equal(resolveCloakFbBridgeBaseUrl(null), '')
    assert.equal(resolveCloakFbBridgeBaseUrl({}), '')
    assert.equal(resolveCloakFbBridgeBaseUrl({ CLOAK_FB_BRIDGE_URL: '' }), '')
    assert.equal(resolveCloakFbBridgeBaseUrl({ CLOAK_FB_BRIDGE_URL: '   ' }), '')
})

test('Cloak FB bridge base URL never resolves to the retired Electron video-onecard bridge / port 3847', () => {
    assert.equal(resolveCloakFbBridgeBaseUrl({ VIDEO_ONECARD_WORKER_URL: 'https://video-onecard.wwoom.com' }), '')
    assert.equal(resolveCloakFbBridgeBaseUrl({ VIDEO_ONECARD_WORKER_URL: 'https://video-onecard.wwoom.com/' }), '')
    assert.equal(resolveCloakFbBridgeBaseUrl({ VIDEO_ONECARD_WORKER_URL: 'http://127.0.0.1:3847' }), '')
    // A non-retired deprecated URL is still honored (backwards-compatible migration window).
    assert.equal(
        resolveCloakFbBridgeBaseUrl({ VIDEO_ONECARD_WORKER_URL: 'http://127.0.0.1:8830' }),
        'http://127.0.0.1:8830',
    )
    assert.ok(isRetiredElectronBridge('https://video-onecard.wwoom.com'))
    assert.ok(isRetiredElectronBridge('http://127.0.0.1:3847'))
    assert.ok(!isRetiredElectronBridge('http://127.0.0.1:8830'))
    assert.ok(!isRetiredElectronBridge(''))
})

test('comment source: explicit values win (decoupled from posting source)', () => {
    // Fallback is ignored whenever a valid value is stored.
    assert.equal(normalizePageCommentTokenSource('stored_token', 'cloak_browser'), 'stored_token')
    assert.equal(normalizePageCommentTokenSource('cloak_browser', 'stored_token'), 'cloak_browser')
    // Legacy aliases collapse to cloak_browser, same as the posting source.
    assert.equal(normalizePageCommentTokenSource('post-reels-token-cloak', 'stored_token'), 'cloak_browser')
    assert.equal(normalizePageCommentTokenSource('post-reels-token-ads', 'stored_token'), 'cloak_browser')
    assert.equal(normalizePageCommentTokenSource('  CLOAK ', 'stored_token'), 'cloak_browser')
    assert.equal(normalizePageCommentTokenSource('PAGE_TOKEN', 'cloak_browser'), 'stored_token')
})

test('comment source: missing/invalid falls back to the page posting source (behavior preserved)', () => {
    assert.equal(normalizePageCommentTokenSource(undefined, 'cloak_browser'), 'cloak_browser')
    assert.equal(normalizePageCommentTokenSource(null, 'stored_token'), 'stored_token')
    assert.equal(normalizePageCommentTokenSource('', 'cloak_browser'), 'cloak_browser')
    assert.equal(normalizePageCommentTokenSource('garbage', 'stored_token'), 'stored_token')
    // Default fallback when none supplied is the legacy stored_token.
    assert.equal(normalizePageCommentTokenSource(undefined), 'stored_token')
})

test('comment source default mirrors the resolved posting route', () => {
    assert.equal(defaultCommentSourceForRoute('stored_token'), 'stored_token')
    assert.equal(defaultCommentSourceForRoute('cloak_organic_reel'), 'cloak_browser')
    assert.equal(defaultCommentSourceForRoute('cloak_onecard_bridge'), 'cloak_browser')
})

test('bridge-comment fallback eligibility: only session-bridge / ads-publish posts qualify', () => {
    // The original post went out through the admin-owned CloakBrowser bridge → eligible.
    assert.equal(isCloakBridgeCommentFallbackEligible('cloak_session_bridge'), true)
    assert.equal(isCloakBridgeCommentFallbackEligible('ads_publish'), true)
    // case-insensitive + trimmed
    assert.equal(isCloakBridgeCommentFallbackEligible('  CLOAK_SESSION_BRIDGE '), true)
    // A stored/manual-token post never proves bridge access → not eligible.
    assert.equal(isCloakBridgeCommentFallbackEligible('stored_token'), false)
    assert.equal(isCloakBridgeCommentFallbackEligible('EAAD6V...ZDZD'), false)
    assert.equal(isCloakBridgeCommentFallbackEligible(undefined), false)
    assert.equal(isCloakBridgeCommentFallbackEligible(null), false)
    assert.equal(isCloakBridgeCommentFallbackEligible(''), false)
})

test('stored-comment token failure classifier: auth/session/missing errors trigger fallback', () => {
    // The exact production signature from page เฉียบ row 32995.
    assert.equal(isStoredCommentTokenAuthFailure('Error validating access token: The session has been invalidated...'), true)
    assert.equal(isStoredCommentTokenAuthFailure('access_token_missing'), true)
    assert.equal(isStoredCommentTokenAuthFailure('OAuthException: ...'), true)
    assert.equal(isStoredCommentTokenAuthFailure('{"error":{"code":190,"message":"..."}}'), true)
    assert.equal(isStoredCommentTokenAuthFailure('code: 190 invalid'), true)
    assert.equal(isStoredCommentTokenAuthFailure('access token has expired'), true)
    assert.equal(isStoredCommentTokenAuthFailure('Malformed access token'), true)
    // Unrelated failures must NOT silently route to the bridge — operator keeps seeing them.
    assert.equal(isStoredCommentTokenAuthFailure('missing_page_story_object_id'), false)
    assert.equal(isStoredCommentTokenAuthFailure('shopee_shortlink_failed'), false)
    assert.equal(isStoredCommentTokenAuthFailure('rate limit reached, code 4'), false)
    assert.equal(isStoredCommentTokenAuthFailure(''), false)
    assert.equal(isStoredCommentTokenAuthFailure(undefined), false)
})

test('fb-lite refresh gate: only stored_token + missing/auth-failure triggers a refresh', () => {
    // Missing stored token → refresh (a Facebook Lite token is never permanently expired).
    assert.equal(shouldAttemptFacebookLiteRefresh({ commentSource: 'stored_token', tokenMissing: true }), true)
    // Graph auth error (190 / invalidated session) → refresh + retry.
    assert.equal(shouldAttemptFacebookLiteRefresh({
        commentSource: 'stored_token',
        error: 'Error validating access token: The session has been invalidated...',
    }), true)
    assert.equal(shouldAttemptFacebookLiteRefresh({
        commentSource: 'stored_token',
        error: '{"error":{"code":190,"message":"..."}}',
    }), true)
    // Present token + unrelated failure → do NOT refresh (refreshing would mask the real error).
    assert.equal(shouldAttemptFacebookLiteRefresh({ commentSource: 'stored_token', error: 'rate limit reached, code 4' }), false)
    assert.equal(shouldAttemptFacebookLiteRefresh({ commentSource: 'stored_token' }), false)
    // CloakBrowser/Power Editor comments never use a stored token → never refreshed.
    assert.equal(shouldAttemptFacebookLiteRefresh({ commentSource: 'cloak_browser', tokenMissing: true }), false)
    assert.equal(shouldAttemptFacebookLiteRefresh({
        commentSource: 'cloak_browser',
        error: 'OAuthException: ...',
    }), false)
})

test('fb-lite refresh request body: profile_id required, hints optional, dry_run only when true', () => {
    assert.deepEqual(
        buildFacebookLiteRefreshRequestBody({ profileId: ' p1 ', pageId: ' 100 ', namespaceId: ' ns ' }),
        { profile_id: 'p1', page_id: '100', namespace_id: 'ns' },
    )
    // Empty hints are omitted entirely.
    assert.deepEqual(buildFacebookLiteRefreshRequestBody({ profileId: 'p1' }), { profile_id: 'p1' })
    assert.deepEqual(
        buildFacebookLiteRefreshRequestBody({ profileId: 'p1', pageId: '', namespaceId: '   ' }),
        { profile_id: 'p1' },
    )
    // dry_run only set when explicitly true.
    assert.deepEqual(
        buildFacebookLiteRefreshRequestBody({ profileId: 'p1', dryRun: true }),
        { profile_id: 'p1', dry_run: true },
    )
    assert.equal('dry_run' in buildFacebookLiteRefreshRequestBody({ profileId: 'p1', dryRun: false }), false)
})

test('fb-lite refresh request body: profile_id is OPTIONAL (page-only auto-discovery) + owner scoping', () => {
    // No profile_id → page-only auto-discovery request; profile_id is omitted entirely.
    const discover = buildFacebookLiteRefreshRequestBody({ pageId: '100', namespaceId: 'ns', ownerEmails: ['A@x.com', 'a@x.com', '  b@y.com '] })
    assert.equal('profile_id' in discover, false)
    assert.deepEqual(discover, { page_id: '100', namespace_id: 'ns', owner_emails: ['a@x.com', 'b@y.com'] })
    // Empty owner list is omitted.
    assert.equal('owner_emails' in buildFacebookLiteRefreshRequestBody({ pageId: '100', ownerEmails: ['', '   '] }), false)
    // Fully empty input → empty body (no profile_id stub).
    assert.deepEqual(buildFacebookLiteRefreshRequestBody({}), {})
})

test('fb-lite refresh response parse: token-free outcome, requires ok+refreshed', () => {
    const good = parseFacebookLiteRefreshResponse(true, { ok: true, refreshed: true, synced: true, page_id: '100', reason: 'refreshed_and_synced' })
    assert.deepEqual(good, { ok: true, refreshed: true, synced: true, pageId: '100', reason: 'refreshed_and_synced' })
    // refreshed but sync failed → synced:false (caller must not assume the pool is fresh).
    assert.equal(parseFacebookLiteRefreshResponse(true, { ok: true, refreshed: true, synced: false }).synced, false)
    // HTTP failure forces ok/refreshed/synced false regardless of body.
    const httpFail = parseFacebookLiteRefreshResponse(false, { ok: true, refreshed: true, synced: true })
    assert.equal(httpFail.ok, false)
    assert.equal(httpFail.refreshed, false)
    assert.equal(httpFail.synced, false)
    // ok:false body → not refreshed; reason falls back to error/redacted hint.
    const failed = parseFacebookLiteRefreshResponse(true, { ok: false, error: 'missing_credentials' })
    assert.equal(failed.refreshed, false)
    assert.equal(failed.reason, 'missing_credentials')
    // Garbage payloads never throw.
    assert.equal(parseFacebookLiteRefreshResponse(true, null).ok, false)
    assert.equal(parseFacebookLiteRefreshResponse(true, undefined).refreshed, false)
})

test('fb-lite refresh response shaper (server side): only booleans + redacted hints, never a token', () => {
    const dry = redactFacebookLiteRefreshResult({ ok: true, dryRun: true, profilePresent: true, hasCredentials: true, pageId: '100', reason: 'dry_run_credentials_present' })
    assert.deepEqual(dry, {
        ok: true, refreshed: false, synced: false, dry_run: true,
        profile_present: true, has_credentials: true, page_id: '100', reason: 'dry_run_credentials_present',
    })
    // No token-bearing fields are ever emitted.
    const keys = Object.keys(redactFacebookLiteRefreshResult({ ok: true, refreshed: true, synced: true }))
    assert.deepEqual(keys.sort(), ['dry_run', 'has_credentials', 'ok', 'page_id', 'profile_present', 'reason', 'refreshed', 'synced'])
    // reason is capped so a leaked error string can't smuggle a long token through.
    const long = redactFacebookLiteRefreshResult({ ok: false, reason: 'x'.repeat(500) })
    assert.ok(long.reason.length <= 120)
    // Empty pageId normalizes to null.
    assert.equal(redactFacebookLiteRefreshResult({ ok: false, pageId: '   ' }).page_id, null)
})

test('module exposes only the two-mode source type (no third provider)', () => {
    const src = readFileSync('src/posting-token-source.ts', 'utf8')
    // No active default URL pointing at any old provider / dead tunnel.
    assert.ok(!/['"`]http:\/\/127\.0\.0\.1:8820['"`]/.test(src), 'must not default to the 8820 provider URL')
    assert.ok(!/['"`]https:\/\/video-onecard\.wwoom\.com['"`]/.test(src), 'must not default to the retired video-onecard tunnel URL')
    // The source union must be exactly the two product modes.
    assert.ok(/'stored_token'/.test(src) && /'cloak_browser'/.test(src), 'both modes present')
})
