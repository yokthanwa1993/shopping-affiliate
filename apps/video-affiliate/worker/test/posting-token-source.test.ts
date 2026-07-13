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
    shouldAttemptFacebookLitePostingRefresh,
    buildFacebookLiteRefreshRequestBody,
    parseFacebookLiteRefreshResponse,
    redactFacebookLiteRefreshResult,
    buildBridgeTokenPagesUrl,
    extractBridgeTokenPageAccessToken,
    buildBridgeAutoSyncUrl,
    buildBridgeAutoSyncRequestBody,
    parseBridgeAutoSyncResponse,
    isBridgeAutoSyncAllowed,
    isFacebookCheckpointOrAutomationFailure,
    shouldArmPostingAuthCooldown,
    resolvePostingAuthCooldownMs,
    isPostingAuthCooldownActive,
    parseAccountFallbackMap,
    resolveBridgeFallbackAccounts,
    isFacebookLitePageToken,
    isFacebookLitePostingPermissionError,
    isPersistablePagePrimaryToken,
    prioritizeSyncedPageTokenPools,
    shouldFallbackToOrganicAfterOneCardFailure,
    resolveSessionBridgePostingTokenHint,
    isPersistedBridgeLaneHint,
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

// ---- Facebook Lite POSTING-token refresh predicate (publish-path twin) ---------------------

test('posting refresh: only stored_token, only on auth failure / missing token', () => {
    // The exact production failure must trigger a refresh.
    const prodErr = 'facebook_publish_all_paths_failed: direct=all_direct_video_tokens_failed: EAAD6V…: Error validating access token: The session has been invalidated because the user changed their password | video_reels=all_post_tokens_failed: EAAD6V…: Error validating access token: The session has been invalidated'
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'stored_token', error: prodErr }), true)
    // code 190 / OAuthException variants.
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'stored_token', error: 'OAuthException code 190' }), true)
    // explicit missing-token markers.
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'stored_token', error: 'facebook_access_token_missing' }), true)
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'stored_token', tokenMissing: true }), true)
    // A non-auth failure must NOT trigger a refresh (it would mask the real error).
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'stored_token', error: 'Please reduce the amount of data' }), false)
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'stored_token', error: 'Video too small (123 bytes)' }), false)
    // CloakBrowser posting never refreshes a stored token.
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'cloak_browser', error: prodErr }), false)
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'cloak_browser', tokenMissing: true }), false)
})

// ---- Bridge Token /pages fallback URL + token extraction -----------------------------------

test('bridge token /pages url: includes account + includeToken=1, omits empty account', () => {
    const withAccount = buildBridgeTokenPagesUrl({ baseUrl: 'https://short.wwoom.com', account: '100090320823561', includeToken: true })
    assert.ok(withAccount.startsWith('https://short.wwoom.com/pages?'), 'targets the bridge /pages route')
    assert.ok(/account=100090320823561/.test(withAccount), 'carries the candidate login id as account=')
    assert.ok(/includeToken=1/.test(withAccount), 'requests the raw token via includeToken=1')
    // No account → default session, no account= param, still includeToken=1.
    const defaultSession = buildBridgeTokenPagesUrl({ baseUrl: 'https://short.wwoom.com/', includeToken: true })
    assert.equal(defaultSession, 'https://short.wwoom.com/pages?includeToken=1')
    // Empty base → empty url (caller fails closed).
    assert.equal(buildBridgeTokenPagesUrl({ baseUrl: '', includeToken: true }), '')
})

test('bridge token /pages: extracts the matching page access_token, ignores others', () => {
    const data = {
        data: [
            { id: '999', name: 'other', hasToken: true, access_token: 'EAAotherZZZ' },
            { id: '1008898512617594', name: 'เฉียบ', hasToken: true, access_token: 'EAAfreshpagetoken' },
        ],
    }
    const hit = extractBridgeTokenPageAccessToken(data, '1008898512617594')
    assert.equal(hit.found, true)
    assert.equal(hit.hasToken, true)
    assert.equal(hit.accessToken, 'EAAfreshpagetoken')
    // Page absent → found:false, no token.
    const miss = extractBridgeTokenPageAccessToken(data, '111')
    assert.equal(miss.found, false)
    assert.equal(miss.accessToken, '')
    // hasToken flag with token withheld (non-local caller) → found but empty token.
    const withheld = extractBridgeTokenPageAccessToken({ data: [{ id: '5', hasToken: true }] }, '5')
    assert.equal(withheld.found, true)
    assert.equal(withheld.hasToken, true)
    assert.equal(withheld.accessToken, '')
    // Garbage payloads never throw.
    assert.equal(extractBridgeTokenPageAccessToken(null, '5').found, false)
    assert.equal(extractBridgeTokenPageAccessToken({ data: 'nope' }, '5').found, false)
})

// ---- Facebook Lite (EAAD6V) page-token prioritization ----------------------
// Regression guard for the live bug: after a facebook_lite_bridge export synced a fresh EAAD6V
// page token, force-post kept posting/commenting with the stale EAABsb token (row 33519). The
// fresh token must lead the pool + become the stored primary; stale EAABsb must fall behind.

const STALE_EAAB = 'EAABsbStaleToken000000000000ZDZD'
const FRESH_EAAD6V = 'EAAD6V7FreshLitePageToken1111111'

test('isFacebookLitePageToken matches EAAD6/EAAD6V only', () => {
    assert.equal(isFacebookLitePageToken(FRESH_EAAD6V), true)
    assert.equal(isFacebookLitePageToken('EAAD6vlowercase'), true)
    assert.equal(isFacebookLitePageToken(STALE_EAAB), false)
    assert.equal(isFacebookLitePageToken(''), false)
    assert.equal(isFacebookLitePageToken(null), false)
})

test('isPersistablePagePrimaryToken keeps EAAD6V page tokens (preserve gates must not blank them)', () => {
    // The bug: preserve gates used isPostRoleToken, which excludes EAAD6 and blanked a fresh Lite
    // token. The replacement predicate keeps ANY non-empty stored page token.
    assert.equal(isPersistablePagePrimaryToken(FRESH_EAAD6V), true)
    assert.equal(isPersistablePagePrimaryToken(STALE_EAAB), true)
    assert.equal(isPersistablePagePrimaryToken('   '), false)
    assert.equal(isPersistablePagePrimaryToken(''), false)
    assert.equal(isPersistablePagePrimaryToken(undefined), false)
})

test('prioritizeSyncedPageTokenPools: fresh EAAD6V leads, stale EAABsb falls to second (post + primary + comment)', () => {
    const out = prioritizeSyncedPageTokenPools({
        incomingToken: FRESH_EAAD6V,
        incomingCommentToken: FRESH_EAAD6V,
        existingPrimaryToken: STALE_EAAB,
        existingPostTokens: [STALE_EAAB],
        existingCommentTokens: [STALE_EAAB],
    })
    // Stored primary becomes the fresh EAAD6V — not the stale EAABsb.
    assert.equal(out.primaryToken, FRESH_EAAD6V)
    // Candidate order: fresh first, stale retained strictly AFTER as fallback (never dropped).
    assert.deepEqual(out.postTokens, [FRESH_EAAD6V, STALE_EAAB])
    assert.deepEqual(out.commentTokens, [FRESH_EAAD6V, STALE_EAAB])
})

test('prioritizeSyncedPageTokenPools: a facebook_lite_bridge export with no prior pool seeds the EAAD6V token as sole primary', () => {
    const out = prioritizeSyncedPageTokenPools({
        incomingToken: FRESH_EAAD6V,
        existingPrimaryToken: '',
        existingPostTokens: [],
        existingCommentTokens: [],
    })
    assert.equal(out.primaryToken, FRESH_EAAD6V)
    assert.deepEqual(out.postTokens, [FRESH_EAAD6V])
    // comment pool falls back to the access token when no explicit comment token is given.
    assert.deepEqual(out.commentTokens, [FRESH_EAAD6V])
})

test('prioritizeSyncedPageTokenPools: any newer page token (not only EAAD6V) outranks an existing stale token', () => {
    // Generic page token (simulating token_source=facebook_lite_bridge where the value is not EAAD6).
    const FRESH = 'EAApageNewlySynced999999'
    const out = prioritizeSyncedPageTokenPools({
        incomingToken: FRESH,
        existingPrimaryToken: STALE_EAAB,
        existingPostTokens: [STALE_EAAB, 'EAAolderpost222'],
    })
    assert.equal(out.primaryToken, FRESH)
    assert.equal(out.postTokens[0], FRESH)
    assert.ok(out.postTokens.includes(STALE_EAAB), 'stale token retained as fallback')
})

test('prioritizeSyncedPageTokenPools de-dupes case-insensitively and never blanks the primary when incoming is empty', () => {
    // Same token in pool + incoming → single leading entry.
    const dup = prioritizeSyncedPageTokenPools({
        incomingToken: FRESH_EAAD6V,
        existingPostTokens: [FRESH_EAAD6V.toLowerCase(), STALE_EAAB],
    })
    assert.equal(dup.postTokens.filter((t) => t.toLowerCase() === FRESH_EAAD6V.toLowerCase()).length, 1)
    assert.equal(dup.postTokens[0], FRESH_EAAD6V)
    // Empty incoming (defensive) → keep the existing stored primary, never blank it.
    const empty = prioritizeSyncedPageTokenPools({
        incomingToken: '',
        existingPrimaryToken: FRESH_EAAD6V,
        existingPostTokens: [FRESH_EAAD6V],
    })
    assert.equal(empty.primaryToken, FRESH_EAAD6V)
})

// ---- OneCard (ad-account) → organic Facebook Lite reel fallback ------------
// Page 1008898512617594 has onecard_enabled=1, so force-post routed into the cloak-fb-bridge
// ad-account create-ad path and failed `upload_video:(#10) Permission Denied`. A stored Facebook
// Lite (EAAD6V) page token cannot drive the ad account, so force-post must fall back to a REAL
// organic Page reel via that token instead of burning the row — without touching Power Editor.

test('shouldFallbackToOrganicAfterOneCardFailure: ad permission denied + stored token → fall back to organic EAAD6V', () => {
    assert.equal(
        shouldFallbackToOrganicAfterOneCardFailure({ haveStoredPostToken: true, error: 'upload_video:(#10) Permission Denied' }),
        true,
    )
    // Bridge problems are ad-path-only — an organic EAAD6V reel does not share them.
    assert.equal(shouldFallbackToOrganicAfterOneCardFailure({ haveStoredPostToken: true, error: 'bridge_not_configured' }), true)
    assert.equal(shouldFallbackToOrganicAfterOneCardFailure({ haveStoredPostToken: true, error: 'onecard_http_500' }), true)
})

test('shouldFallbackToOrganicAfterOneCardFailure: no stored token → keep failing closed (pure admin/CloakBrowser OneCard)', () => {
    assert.equal(shouldFallbackToOrganicAfterOneCardFailure({ haveStoredPostToken: false, error: 'upload_video:(#10) Permission Denied' }), false)
    assert.equal(shouldFallbackToOrganicAfterOneCardFailure({ haveStoredPostToken: false }), false)
})

test('shouldFallbackToOrganicAfterOneCardFailure: local/pre-upload failures organic would ALSO hit → do not fall back', () => {
    assert.equal(shouldFallbackToOrganicAfterOneCardFailure({ haveStoredPostToken: true, error: 'Video too small (123 bytes). Download failed.' }), false)
    assert.equal(shouldFallbackToOrganicAfterOneCardFailure({ haveStoredPostToken: true, error: 'Fetch video failed with status 404' }), false)
    assert.equal(shouldFallbackToOrganicAfterOneCardFailure({ haveStoredPostToken: true, error: 'avatar_compose_failed: avatar_url_invalid' }), false)
})

// ---- (#10) Permission Denied → Facebook Lite bridge organic fallback -------
// The stored EAAD6V page token cannot publish via the Worker Graph app / ad account ("(#10)
// Permission Denied"), which is NOT an auth/190 error. It must still reach the Facebook Lite bridge
// ORGANIC /post fallback (the local logged-in session CAN post). isFacebookLitePostingPermissionError
// is the gate that lets it through (shouldAttemptFacebookLitePostingRefresh only matches auth errors).

test('isFacebookLitePostingPermissionError matches the live (#10) Permission Denied publish errors', () => {
    assert.equal(isFacebookLitePostingPermissionError('upload_video:(#10) Permission Denied'), true)
    assert.equal(isFacebookLitePostingPermissionError('(#10) Permission Denied'), true)
    assert.equal(isFacebookLitePostingPermissionError('all_post_tokens_failed: (#10) Permission denied'), true)
    assert.equal(isFacebookLitePostingPermissionError('Graph error code: 10 permission'), true)
})

test('isFacebookLitePostingPermissionError does NOT match auth (190) or unrelated errors (no false promotion)', () => {
    assert.equal(isFacebookLitePostingPermissionError('(#190) error validating access token'), false)
    assert.equal(isFacebookLitePostingPermissionError('(#100) Tried accessing nonexisting field'), false)
    assert.equal(isFacebookLitePostingPermissionError('please reduce the amount of data'), false)
    assert.equal(isFacebookLitePostingPermissionError(''), false)
    assert.equal(isFacebookLitePostingPermissionError(null), false)
})

test('a (#10) permission error reaches the bridge fallback while an auth error stays on the refresh path', () => {
    // Auth errors keep working through shouldAttemptFacebookLitePostingRefresh (token re-mint)…
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'stored_token', error: '(#190) session has been invalidated' }), true)
    assert.equal(isFacebookLitePostingPermissionError('(#190) session has been invalidated'), false)
    // …while (#10) does NOT trigger a refresh (it is a permission, not a token, problem) but DOES
    // qualify for the bridge organic /post fallback. The wrapper enters the fallback on either.
    assert.equal(shouldAttemptFacebookLitePostingRefresh({ source: 'stored_token', error: 'upload_video:(#10) Permission Denied' }), false)
    assert.equal(isFacebookLitePostingPermissionError('upload_video:(#10) Permission Denied'), true)
})

// ---- Bridge /token/auto-sync (Worker → bridge TRUE-RECOVERY trigger) -------
// Recovery is fully AUTOMATIC and machine-to-machine: when a stored/Facebook Lite token is
// invalidated, the Worker POSTs the bridge's /token/auto-sync itself (no operator button). These
// pure helpers shape the URL/body, parse the token-free response, and back off to avoid spamming
// Facebook's login rate limiter.

test('buildBridgeAutoSyncUrl appends /token/auto-sync, returns "" when the bridge is unconfigured (fail closed)', () => {
    assert.equal(buildBridgeAutoSyncUrl('https://short.wwoom.com'), 'https://short.wwoom.com/token/auto-sync')
    assert.equal(buildBridgeAutoSyncUrl('https://short.wwoom.com/'), 'https://short.wwoom.com/token/auto-sync')
    assert.equal(buildBridgeAutoSyncUrl(''), '')
    assert.equal(buildBridgeAutoSyncUrl('   '), '')
})

test('buildBridgeAutoSyncRequestBody is always dryRun:false (internal trusted recovery), scopes by namespace, targets account/candidates', () => {
    // Bare namespace → all-account scan, live (never a preview that would resolve no token).
    assert.deepEqual(buildBridgeAutoSyncRequestBody({ namespaceId: '177', candidateLoginIds: [] }), { namespaceId: '177', dryRun: false })
    // A specific account is preferred over a candidate list.
    assert.deepEqual(buildBridgeAutoSyncRequestBody({ namespaceId: '177', account: '100090', candidateLoginIds: ['x'] }), { namespaceId: '177', dryRun: false, account: '100090' })
    // Candidate login ids (deduped, trimmed) only when no explicit account.
    assert.deepEqual(buildBridgeAutoSyncRequestBody({ namespaceId: '177', candidateLoginIds: [' a ', 'a', 'b'] }), { namespaceId: '177', dryRun: false, accounts: ['a', 'b'] })
})

test('buildBridgeAutoSyncRequestBody carries pageId + fallbackAccounts for page-targeted recovery (Chanalai → Thanwan), deduped, primary excluded', () => {
    // A page-targeted recovery: primary account named, the failing page id, and an explicit fallback.
    assert.deepEqual(
        buildBridgeAutoSyncRequestBody({ namespaceId: '177', account: '100090320823561', pageId: '182865331578296', fallbackAccounts: ['100077795357192'] }),
        { namespaceId: '177', dryRun: false, account: '100090320823561', pageId: '182865331578296', fallbackAccounts: ['100077795357192'] },
    )
    // Fallbacks are trimmed/deduped and never re-list the primary account.
    assert.deepEqual(
        buildBridgeAutoSyncRequestBody({ namespaceId: '177', account: 'A', fallbackAccounts: [' B ', 'B', 'A', 'C'] }),
        { namespaceId: '177', dryRun: false, account: 'A', fallbackAccounts: ['B', 'C'] },
    )
    // No fallback fields emitted when none supplied (back-compat with existing all-account scan).
    assert.deepEqual(buildBridgeAutoSyncRequestBody({ namespaceId: '177', candidateLoginIds: [] }), { namespaceId: '177', dryRun: false })
})

test('parseAccountFallbackMap: tolerant JSON/object → normalized id lists, malformed never throws', () => {
    // JSON string (env var shape): Chanalai uid → Thanwan uid.
    assert.deepEqual(parseAccountFallbackMap('{"100090320823561":["100077795357192"]}'), { '100090320823561': ['100077795357192'] })
    // Already-parsed object, comma/space string values, trimmed + deduped.
    assert.deepEqual(parseAccountFallbackMap({ p: 'a, b  b', q: ['c', 'c', ' d '] }), { p: ['a', 'b'], q: ['c', 'd'] })
    // Malformed / empty / wrong-type → {} (a bad env var can never break posting).
    assert.deepEqual(parseAccountFallbackMap('not json'), {})
    assert.deepEqual(parseAccountFallbackMap(''), {})
    assert.deepEqual(parseAccountFallbackMap(null), {})
    assert.deepEqual(parseAccountFallbackMap('[1,2,3]'), {})
    // Empty value lists are dropped.
    assert.deepEqual(parseAccountFallbackMap({ p: [] }), {})
})

test('resolveBridgeFallbackAccounts: ordered explicit → page-map → account-map, primary + page excluded, deduped', () => {
    const accountFallbackMap = { '100090320823561': ['100077795357192', 'ACC_X'] }
    const pageFallbackMap = { '182865331578296': ['PAGE_FB_1'] }
    // Page-targeted: page mapping wins ordering ahead of the account mapping; explicit hint first.
    assert.deepEqual(
        resolveBridgeFallbackAccounts({ primaryAccount: '100090320823561', pageId: '182865331578296', accountFallbackMap, pageFallbackMap, explicit: ['HINT'] }),
        ['HINT', 'PAGE_FB_1', '100077795357192', 'ACC_X'],
    )
    // The primary account is never returned as its own fallback even if a map lists it.
    assert.deepEqual(
        resolveBridgeFallbackAccounts({ primaryAccount: 'A', accountFallbackMap: { A: ['A', 'B'] } }),
        ['B'],
    )
    // No mappings → empty (so an all-account scan is unaffected).
    assert.deepEqual(resolveBridgeFallbackAccounts({ primaryAccount: 'A', pageId: 'P' }), [])
})

test('parseBridgeAutoSyncResponse reports synced from counts.synced or the synced flag, token-free, http failure never synced', () => {
    assert.equal(parseBridgeAutoSyncResponse(true, { ok: true, synced: true, counts: { synced: 2 } }).synced, true)
    assert.equal(parseBridgeAutoSyncResponse(true, { ok: true, counts: { synced: 1 } }).synced, true)
    assert.equal(parseBridgeAutoSyncResponse(true, { ok: true, status: 'synced_with_errors', counts: { synced: 0 } }).synced, false)
    // A throttled/dry response is NOT synced.
    assert.equal(parseBridgeAutoSyncResponse(true, { ok: true, synced: false, status: 'throttled' }).synced, false)
    // A non-2xx transport never counts as synced regardless of body.
    assert.equal(parseBridgeAutoSyncResponse(false, { ok: true, synced: true, counts: { synced: 5 } }).synced, false)
    // reason is a short hint, capped, never a token.
    const r = parseBridgeAutoSyncResponse(true, { ok: false, error: 'x'.repeat(400) })
    assert.ok(r.reason.length <= 120)
})

test('isBridgeAutoSyncAllowed: first attempt allowed, repeat within TTL blocked, after TTL allowed again, non-positive TTL disables throttle', () => {
    // Never attempted → allowed.
    assert.equal(isBridgeAutoSyncAllowed(undefined, 1_000_000, 60_000), true)
    assert.equal(isBridgeAutoSyncAllowed(0, 1_000_000, 60_000), true)
    // Within the window → blocked.
    assert.equal(isBridgeAutoSyncAllowed(1_000_000, 1_030_000, 60_000), false)
    // Exactly/after the window → allowed.
    assert.equal(isBridgeAutoSyncAllowed(1_000_000, 1_060_000, 60_000), true)
    assert.equal(isBridgeAutoSyncAllowed(1_000_000, 1_200_000, 60_000), true)
    // TTL<=0 disables throttling (test override).
    assert.equal(isBridgeAutoSyncAllowed(1_000_000, 1_000_001, 0), true)
})

test('isFacebookCheckpointOrAutomationFailure: flags checkpoint/automation/rate-limit, not a plain 190', () => {
    // Checkpoint / automation / lock signals → true (earns the long cooldown).
    assert.equal(isFacebookCheckpointOrAutomationFailure('Account requires a checkpoint'), true)
    assert.equal(isFacebookCheckpointOrAutomationFailure('We detected automated behavior on your account'), true)
    assert.equal(isFacebookCheckpointOrAutomationFailure('unusual activity detected'), true)
    assert.equal(isFacebookCheckpointOrAutomationFailure('Your account has been temporarily blocked'), true)
    assert.equal(isFacebookCheckpointOrAutomationFailure('Please confirm your identity'), true)
    assert.equal(isFacebookCheckpointOrAutomationFailure('(#368) blocked for abusive behavior'), true)
    // Plain invalidated-token / generic errors → false (short cooldown path).
    assert.equal(isFacebookCheckpointOrAutomationFailure('error validating access token: session invalidated (code 190)'), false)
    assert.equal(isFacebookCheckpointOrAutomationFailure('all_post_tokens_failed'), false)
    assert.equal(isFacebookCheckpointOrAutomationFailure(''), false)
    assert.equal(isFacebookCheckpointOrAutomationFailure(undefined), false)
})

test('shouldArmPostingAuthCooldown: arm on a real FB-contact failure, never on config/transport reasons', () => {
    // Reached Facebook and got rejected → arm.
    assert.equal(shouldArmPostingAuthCooldown('auto_sync_no_pages'), true)
    assert.equal(shouldArmPostingAuthCooldown('refresh_failed'), true)
    assert.equal(shouldArmPostingAuthCooldown(''), true)
    // Never reached Facebook (config/transport/throttle) → do NOT arm (would only block recovery).
    assert.equal(shouldArmPostingAuthCooldown('bridge_not_configured'), false)
    assert.equal(shouldArmPostingAuthCooldown('sync_secret_missing'), false)
    assert.equal(shouldArmPostingAuthCooldown('bridge_auto_sync_unreachable'), false)
    assert.equal(shouldArmPostingAuthCooldown('auto_sync_throttled'), false)
    assert.equal(shouldArmPostingAuthCooldown('auth_failure_cooldown'), false)
})

test('resolvePostingAuthCooldownMs: checkpoint earns the longer window, never shorter than auth', () => {
    assert.equal(resolvePostingAuthCooldownMs({ checkpoint: false, authCooldownMs: 1800_000, checkpointCooldownMs: 21600_000 }), 1800_000)
    assert.equal(resolvePostingAuthCooldownMs({ checkpoint: true, authCooldownMs: 1800_000, checkpointCooldownMs: 21600_000 }), 21600_000)
    // Checkpoint window can never resolve shorter than the auth window even if misconfigured.
    assert.equal(resolvePostingAuthCooldownMs({ checkpoint: true, authCooldownMs: 1800_000, checkpointCooldownMs: 60_000 }), 1800_000)
})

test('isPostingAuthCooldownActive: open while now<until, closed at/after until or when unset', () => {
    assert.equal(isPostingAuthCooldownActive(2_000_000, 1_000_000), true)
    assert.equal(isPostingAuthCooldownActive(1_000_000, 1_000_000), false)
    assert.equal(isPostingAuthCooldownActive(1_000_000, 1_500_000), false)
    assert.equal(isPostingAuthCooldownActive(0, 1_000_000), false)
    assert.equal(isPostingAuthCooldownActive(undefined, 1_000_000), false)
})

// ---- Session-bridge /post response `source` → truthful persisted hint -----
// Live regression (CHEARB force-post): the bridge /post response reported
// source='facebook_lite_eaad6' (Facebook Lite EAAD6 lane) but post_history recorded
// post_token_hint/comment_token_hint='cloak_session_bridge'. The hint resolver must
// trust the bridge-reported source over the generic default — and only that exact
// established source value, so no other routing/label contract moves.

test('resolveSessionBridgePostingTokenHint: exact facebook_lite_eaad6 source wins over any caller hint/default', () => {
    assert.equal(resolveSessionBridgePostingTokenHint('facebook_lite_eaad6', 'cloak_session_bridge'), 'facebook_lite_bridge')
    assert.equal(resolveSessionBridgePostingTokenHint('facebook_lite_eaad6', undefined), 'facebook_lite_bridge')
    assert.equal(resolveSessionBridgePostingTokenHint('facebook_lite_eaad6', ''), 'facebook_lite_bridge')
    assert.equal(resolveSessionBridgePostingTokenHint('facebook_lite_eaad6', 'facebook_lite_bridge'), 'facebook_lite_bridge')
    // Whitespace-tolerant but otherwise EXACT — only the established bridge label counts.
    assert.equal(resolveSessionBridgePostingTokenHint('  facebook_lite_eaad6  ', undefined), 'facebook_lite_bridge')
})

test('resolveSessionBridgePostingTokenHint: any other/absent source preserves the caller hint (default cloak_session_bridge)', () => {
    // No source in the response → exact legacy behavior.
    assert.equal(resolveSessionBridgePostingTokenHint(undefined, undefined), 'cloak_session_bridge')
    assert.equal(resolveSessionBridgePostingTokenHint('', ''), 'cloak_session_bridge')
    assert.equal(resolveSessionBridgePostingTokenHint(null, '   '), 'cloak_session_bridge')
    // A CloakBrowser-session response keeps the generic label.
    assert.equal(resolveSessionBridgePostingTokenHint('browser_session', undefined), 'cloak_session_bridge')
    // An explicit caller hint survives a non-Lite (or unknown) source untouched.
    assert.equal(resolveSessionBridgePostingTokenHint('browser_session', 'facebook_lite_bridge'), 'facebook_lite_bridge')
    assert.equal(resolveSessionBridgePostingTokenHint(undefined, 'facebook_lite_bridge'), 'facebook_lite_bridge')
    // Near-miss labels must NOT upgrade (exact match only — never guess a lane).
    assert.equal(resolveSessionBridgePostingTokenHint('facebook_lite', undefined), 'cloak_session_bridge')
    assert.equal(resolveSessionBridgePostingTokenHint('facebook_lite_bridge', undefined), 'cloak_session_bridge')
    assert.equal(resolveSessionBridgePostingTokenHint('FACEBOOK_LITE_EAAD6', undefined), 'cloak_session_bridge')
})

test('isPersistedBridgeLaneHint: established lane labels pass through verbatim, tokens/near-misses do not', () => {
    assert.equal(isPersistedBridgeLaneHint('facebook_lite_bridge'), true)
    assert.equal(isPersistedBridgeLaneHint('cloak_session_bridge'), true)
    assert.equal(isPersistedBridgeLaneHint('ads_publish'), true)
    assert.equal(isPersistedBridgeLaneHint('onecard'), true)
    assert.equal(isPersistedBridgeLaneHint(' facebook_lite_bridge '), true)
    // Raw tokens and unknown values still go through the token redaction path.
    assert.equal(isPersistedBridgeLaneHint('raw_token_like_value_123456'), false)
    assert.equal(isPersistedBridgeLaneHint('not_a_lane_token_value'), false)
    assert.equal(isPersistedBridgeLaneHint('facebook_lite'), false)
    assert.equal(isPersistedBridgeLaneHint(''), false)
    assert.equal(isPersistedBridgeLaneHint(undefined), false)
    assert.equal(isPersistedBridgeLaneHint(null), false)
})

test('a facebook_lite_eaad6-served bridge publish yields the exact persistable facebook_lite_bridge hint', () => {
    // End-to-end intent: the resolved hint must ALSO be recognized as a persisted lane label,
    // so deriveCommentTokenHint-style token redaction can never corrupt it into 'facebo...idge'
    // and history/comment classification receive 'facebook_lite_bridge' verbatim.
    const hint = resolveSessionBridgePostingTokenHint('facebook_lite_eaad6', undefined)
    assert.equal(hint, 'facebook_lite_bridge')
    assert.equal(isPersistedBridgeLaneHint(hint), true)
})
