import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
    normalizePagePostingTokenSource,
    normalizePageCommentTokenSource,
    resolvePostingRoute,
    restrictCloakToAdminNamespace,
} from '../src/posting-token-source'

// Regression: member/other namespaces that use their own manually stored Facebook token were
// being routed to the Power Editor / CloakBrowser session bridge (post_token_hint
// 'cloak_session_bridge'), hard-failing `cloak_post_failed: session_bridge_page_not_authorized`
// because the bridge only knows the admin operator's own Pages. Power Editor / CloakBrowser is
// admin-owned only; non-admin namespaces must always resolve/persist to stored_token.

test('admin guard: non-admin namespace collapses any non-stored source to stored_token', () => {
    // Explicit cloak_browser from a client payload is refused for a non-admin namespace.
    assert.equal(restrictCloakToAdminNamespace('cloak_browser', false), 'stored_token')
    // Stored stays stored regardless of namespace ownership.
    assert.equal(restrictCloakToAdminNamespace('stored_token', false), 'stored_token')
    assert.equal(restrictCloakToAdminNamespace('stored_token', true), 'stored_token')
})

test('admin guard: admin namespace passes the selected source through unchanged', () => {
    assert.equal(restrictCloakToAdminNamespace('cloak_browser', true), 'cloak_browser')
    assert.equal(restrictCloakToAdminNamespace('stored_token', true), 'stored_token')
})

test('PUT persistence: non-admin namespace stores stored_token even when client sends cloak_browser/legacy', () => {
    // Mirrors the PUT /api/pages/:id composition: normalize(client value) then admin guard.
    const persist = (clientValue: unknown, isAdmin: boolean) =>
        restrictCloakToAdminNamespace(normalizePagePostingTokenSource(clientValue), isAdmin)

    // Non-admin (member) namespace: canonical + every legacy alias is forced back to stored_token.
    assert.equal(persist('cloak_browser', false), 'stored_token')
    assert.equal(persist('post-reels-token-cloak', false), 'stored_token')
    assert.equal(persist('post-reels-token-ads', false), 'stored_token')
    assert.equal(persist('cloak', false), 'stored_token')
    assert.equal(persist('stored_token', false), 'stored_token')

    // Admin namespace: explicit Power Editor selection is honored (behavior unchanged).
    assert.equal(persist('cloak_browser', true), 'cloak_browser')
    assert.equal(persist('post-reels-token-cloak', true), 'cloak_browser')
    assert.equal(persist('stored_token', true), 'stored_token')
})

test('PUT persistence: comment source is admin-gated the same way as the posting source', () => {
    const persistComment = (clientValue: unknown, isAdmin: boolean) =>
        restrictCloakToAdminNamespace(normalizePageCommentTokenSource(clientValue), isAdmin)
    assert.equal(persistComment('cloak_browser', false), 'stored_token')
    assert.equal(persistComment('post-reels-token-ads', false), 'stored_token')
    assert.equal(persistComment('cloak_browser', true), 'cloak_browser')
})

test('force-post route: non-admin manual-token page resolves to stored_token, never the cloak bridge', () => {
    // A member page whose DB value is cloak_browser (or a stale legacy alias) must NOT resolve to
    // a cloak_* route — those are the only routes that call publishReelViaSessionBridge.
    const routeFor = (dbValue: unknown, isAdmin: boolean) =>
        resolvePostingRoute({
            source: restrictCloakToAdminNamespace(normalizePagePostingTokenSource(dbValue), isAdmin),
        })

    assert.equal(routeFor('cloak_browser', false), 'stored_token')
    assert.equal(routeFor('post-reels-token-cloak', false), 'stored_token')
    assert.equal(routeFor('post-reels-token-ads', false), 'stored_token')
    assert.equal(routeFor('stored_token', false), 'stored_token')
    // Resolving to 'stored_token' means the worker takes publishReelWithCommentTokenPrimaryFallback,
    // not publishReelViaSessionBridge.

    // Admin namespace keeps the explicit CloakBrowser organic-reel route (unchanged behavior).
    assert.equal(routeFor('cloak_browser', true), 'cloak_organic_reel')
})

test('force-post route: legacy ads_publish_enabled flag cannot promote a non-admin page onto the bridge', () => {
    // The legacy ads_publish_enabled flag promotes even a stored_token source to the OneCard/
    // create-ad bridge route. That bridge is admin-owned only, so the flag must be gated on
    // namespace ownership (adsPublishLegacyFlag && namespaceIsAdminOwned) at both call sites.
    const routeFor = (dbValue: unknown, adsPublishEnabled: boolean, isAdmin: boolean) =>
        resolvePostingRoute({
            source: restrictCloakToAdminNamespace(normalizePagePostingTokenSource(dbValue), isAdmin),
            adsPublishLegacyFlag: adsPublishEnabled && isAdmin,
        })

    // Non-admin stored_token page with a stale ads_publish_enabled=1 stays on the stored path.
    assert.equal(routeFor('stored_token', true, false), 'stored_token')
    // Even a cloak_browser DB value + ads flag on a non-admin namespace stays stored.
    assert.equal(routeFor('cloak_browser', true, false), 'stored_token')
    assert.equal(routeFor('post-reels-token-ads', true, false), 'stored_token')

    // Admin namespace: the legacy flag still promotes to the OneCard/create-ad bridge route.
    assert.equal(routeFor('stored_token', true, true), 'cloak_onecard_bridge')
    assert.equal(routeFor('cloak_browser', true, true), 'cloak_onecard_bridge')
})

// ---- Wiring assertions: the admin guard is actually applied at every decision point. --------
// The worker is a single large module tested at source level (same pattern as the other
// index.ts route tests in this suite).

function indexSrc(): string {
    return readFileSync('src/index.ts', 'utf8')
}

test('wiring: index.ts imports and applies restrictCloakToAdminNamespace', () => {
    const src = indexSrc()
    assert.ok(
        /restrictCloakToAdminNamespace,?\n/.test(src),
        'index.ts must import restrictCloakToAdminNamespace from ./posting-token-source',
    )
    // PUT persistence + force-post posting/comment + cron posting/comment all funnel through it.
    const applications = src.match(/restrictCloakToAdminNamespace\(/g) || []
    assert.ok(
        applications.length >= 5,
        `expected restrictCloakToAdminNamespace to gate persistence + force-post + cron (>=5 call sites), got ${applications.length}`,
    )
})

test('wiring: PUT /api/pages persistence gates the token source on admin ownership', () => {
    const src = indexSrc()
    const start = src.indexOf("UPDATE pages SET posting_token_source = ?, updated_at")
    assert.notEqual(start, -1, 'posting_token_source UPDATE must exist')
    // Look back a short window before the UPDATE for the admin-ownership resolution + guard.
    const window = src.slice(Math.max(0, start - 1200), start + 200)
    assert.ok(
        /isNamespaceShortlinkAdminManaged\(/.test(window),
        'PUT must resolve namespace admin ownership via isNamespaceShortlinkAdminManaged',
    )
    assert.ok(
        /restrictCloakToAdminNamespace\(\s*\n?\s*normalizePagePostingTokenSource\(/.test(window),
        'PUT must persist restrictCloakToAdminNamespace(normalizePagePostingTokenSource(...))',
    )
})

test('wiring: force-post resolves the admin guard before resolvePostingRoute / session bridge', () => {
    const src = indexSrc()
    const logIdx = src.indexOf('[FORCE-POST] page=')
    assert.notEqual(logIdx, -1, 'force-post log marker must exist')
    // Region from the start of this force-post attempt up to the session-bridge call site.
    const regionStart = src.lastIndexOf('namespaceIsAdminOwned = await isNamespaceShortlinkAdminManaged', logIdx)
    assert.notEqual(regionStart, -1, 'force-post must resolve namespaceIsAdminOwned before logging the route')
    const bridgeIdx = src.indexOf('publishReelViaSessionBridge', logIdx)
    assert.notEqual(bridgeIdx, -1, 'force-post still has a session-bridge call site for admin pages')
    const region = src.slice(regionStart, bridgeIdx)
    const guardIdx = region.indexOf('restrictCloakToAdminNamespace(')
    const routeIdx = region.indexOf('resolvePostingRoute(')
    assert.ok(guardIdx !== -1, 'force-post must apply restrictCloakToAdminNamespace')
    assert.ok(routeIdx !== -1, 'force-post must call resolvePostingRoute')
    assert.ok(
        guardIdx < routeIdx,
        'the admin guard must collapse the source BEFORE resolvePostingRoute picks the bridge route',
    )
    assert.ok(
        /adsPublishLegacyFlag:\s*pageAdsPublishLegacyFlag\s*&&\s*namespaceIsAdminOwned/.test(region),
        'force-post must gate the legacy ads_publish_enabled bridge promotion on namespaceIsAdminOwned',
    )
})

test('wiring: cron auto-post path applies the same admin guard before routing', () => {
    const src = indexSrc()
    const logIdx = src.indexOf('[CRON] page=')
    assert.notEqual(logIdx, -1, 'cron log marker must exist')
    const regionStart = src.lastIndexOf('namespaceIsAdminOwned = await isNamespaceShortlinkAdminManaged', logIdx)
    assert.notEqual(regionStart, -1, 'cron must resolve namespaceIsAdminOwned before routing')
    const region = src.slice(regionStart, logIdx)
    const guardIdx = region.indexOf('restrictCloakToAdminNamespace(')
    const routeIdx = region.indexOf('resolvePostingRoute(')
    assert.ok(guardIdx !== -1 && routeIdx !== -1 && guardIdx < routeIdx,
        'cron must apply restrictCloakToAdminNamespace before resolvePostingRoute')
    assert.ok(
        /adsPublishLegacyFlag:\s*pageAdsPublishLegacyFlag\s*&&\s*namespaceIsAdminOwned/.test(region),
        'cron must gate the legacy ads_publish_enabled bridge promotion on namespaceIsAdminOwned',
    )
})

test('wiring: retry-failed-comments route is authenticated, namespace-scoped, dry_run-default, helper-gated', () => {
    const src = indexSrc()
    const routeIdx = src.indexOf("app.post('/api/pages/:id/retry-failed-comments'")
    assert.notEqual(routeIdx, -1, 'retry-failed-comments POST route must be registered')
    // Region from the route start to the next route registration.
    const nextRouteIdx = src.indexOf('app.get(\'/api/pages/:id/stats\'', routeIdx)
    assert.notEqual(nextRouteIdx, -1, 'route region boundary (stats route) must exist')
    const region = src.slice(routeIdx, nextRouteIdx)

    // Same dashboard-session auth surface as the other write routes — never an admin endpoint.
    assert.ok(/requireAuthSession\(c\)/.test(region), 'must gate on requireAuthSession (dashboard session)')
    assert.ok(!/adminAuthMiddleware|requireSystemAdminSession/.test(region), 'must NOT be an admin endpoint')
    // Namespace derived from session context + page ownership enforced.
    assert.ok(/const namespaceId = String\(c\.get\('botId'\)/.test(region), 'namespace must come from c.get(botId)')
    assert.ok(/FROM pages WHERE id = \? AND bot_id = \?/.test(region), 'must scope the page to the current namespace')
    // dry_run defaults true: only an explicit false writes.
    assert.ok(/const dryRun = !\(dryRunRaw === false/.test(region), 'dry_run must default true (explicit false to write)')
    // Eligibility is gated by BOTH shared helpers, not ad-hoc string checks.
    assert.ok(/isCloakBridgeCommentFallbackEligible\(/.test(region), 'must filter on isCloakBridgeCommentFallbackEligible')
    assert.ok(/isStoredCommentTokenAuthFailure\(/.test(region), 'must filter on isStoredCommentTokenAuthFailure')
    // Selection criteria + bounded limit.
    assert.ok(/status = 'success'/.test(region) && /comment_status = 'failed'/.test(region), 'must select success+failed-comment rows')
    assert.ok(/TRIM\(COALESCE\(fb_post_id, ''\)\) <> ''/.test(region), 'must require a present fb_post_id')
    assert.ok(/Math\.min\(10, Math\.max\(1, limit\)\)/.test(region), 'limit must be clamped to <= 10')
    // Write mode re-queues to pending and processes the backlog once.
    assert.ok(/comment_status='pending', comment_error=NULL/.test(region), 'write mode must re-queue to pending and clear the error')
    assert.ok(/processPendingCommentBacklog\(c\.env\)/.test(region), 'write mode must run the backlog once for immediate repair')
})

// ─────────────────────────────────────────────────────────────────────────────
// Cloak bridge account threading (pages.posting_profile_uid).
// Regression: CHEARB (1008898512617594) is cloak_browser-configured with
// posting_profile_uid=100090320823561 (Power Editor). The bridge's DEFAULT
// session is the Facebook Lite account, whose /pages does NOT administer that
// page, so force-post/cron failed `session_bridge_page_not_authorized` because
// the explicit cloak publish/comment calls omitted `account`. The configured
// uid must be threaded into BOTH the publish and the page-comment bridge calls
// at BOTH trigger sites. A blank posting_profile_uid keeps the default session
// (sanitizePostingProfileUid returns '' → the helpers add no ?account=).
// ─────────────────────────────────────────────────────────────────────────────

// Slice one bridge call: logPrefix is the LAST property at every call site, so the
// text between the nearest call opener and the logPrefix marker holds all its params.
function bridgeCallParams(src: string, opener: string, logPrefixMarker: string): string {
    const markerIdx = src.indexOf(logPrefixMarker)
    assert.notEqual(markerIdx, -1, `bridge call marker must exist: ${logPrefixMarker}`)
    const openerIdx = src.lastIndexOf(opener, markerIdx)
    assert.notEqual(openerIdx, -1, `bridge call opener must precede the marker: ${opener}`)
    return src.slice(openerIdx, markerIdx)
}

test('wiring: force-post cloak organic publish + comment thread the page-configured bridge account', () => {
    const src = indexSrc()
    const publish = bridgeCallParams(src, 'await publishReelViaSessionBridge({', "logPrefix: 'FORCE-POST CLOAK-BRIDGE'")
    assert.ok(publish.includes('account: configuredPostingProfileUid'),
        'force-post cloak publish must pass pages.posting_profile_uid as the bridge account')
    const comment = bridgeCallParams(src, 'await sendPageCommentViaCloakBridge({', "logPrefix: 'FORCE-POST CLOAK-COMMENT'")
    assert.ok(comment.includes('account: configuredPostingProfileUid'),
        'force-post cloak comment must use the SAME configured bridge account as the publish')
})

test('wiring: cron cloak organic publish + comment thread the page-configured bridge account', () => {
    const src = indexSrc()
    const publish = bridgeCallParams(src, 'await publishReelViaSessionBridge({', 'logPrefix: `CRON CLOAK-BRIDGE ${page.name}`')
    assert.ok(publish.includes('account: configuredPostingProfileUid'),
        'cron cloak publish must pass pages.posting_profile_uid as the bridge account')
    const comment = bridgeCallParams(src, 'await sendPageCommentViaCloakBridge({', 'logPrefix: `CRON CLOAK-COMMENT ${page.name}`')
    assert.ok(comment.includes('account: configuredPostingProfileUid'),
        'cron cloak comment must use the SAME configured bridge account as the publish')
    // Both trigger sites derive the uid from the page row via the shared sanitizer.
    const derivations = (src.match(/const configuredPostingProfileUid = sanitizePostingProfileUid\(/g) || []).length
    assert.ok(derivations >= 2, `force-post + cron must derive configuredPostingProfileUid from the page row (found ${derivations})`)
})

test('wiring: the bridge helpers apply params.account to authorization and post/comment bodies', () => {
    const src = indexSrc()
    const pubStart = src.indexOf('async function publishReelViaSessionBridge')
    assert.notEqual(pubStart, -1, 'publishReelViaSessionBridge must exist')
    const pub = src.slice(pubStart, src.indexOf('function buildPageStoryId', pubStart))
    // The /token + /pages preflight (where session_bridge_page_not_authorized comes from)
    // must run against the SELECTED account, not the bridge default session.
    assert.ok(pub.includes("const account = String(params.account || '').trim()"), 'publish must read params.account')
    assert.ok(pub.includes('`${baseUrl}/token${accountQuery}`'), '/token preflight must carry ?account=')
    assert.ok(pub.includes('`${baseUrl}/pages${accountQuery}`'), '/pages authorization must carry ?account=')
    assert.ok(pub.includes('if (account) postBody.account = account'), '/post body must carry the account')

    const comStart = src.indexOf('async function sendPageCommentViaCloakBridge')
    assert.notEqual(comStart, -1, 'sendPageCommentViaCloakBridge must exist')
    const com = src.slice(comStart, src.indexOf('async function sendStoredCommentBridgeFallback', comStart))
    assert.ok(com.includes("{ account: String(params.account || '').trim() }"),
        '/page-comment body must carry the account when provided')
})

test('wiring: the fix is scoped to the cloak organic lane — FB Lite comment + stored fallback keep their own account semantics', () => {
    const src = indexSrc()
    // The Facebook Lite bridge POST path keeps commenting through the account that created
    // the post (facebookLiteBridgeAccount), never the cloak posting_profile_uid.
    const liteComment = bridgeCallParams(src, 'await sendPageCommentViaCloakBridge({', "logPrefix: 'FORCE-POST FB-LITE-COMMENT'")
    assert.ok(liteComment.includes('account: facebookLiteBridgeAccount'),
        'FB Lite comment branch must keep threading facebookLiteBridgeAccount')
    assert.ok(!liteComment.includes('configuredPostingProfileUid'),
        'FB Lite comment branch must NOT switch to the cloak posting_profile_uid')
    // The stored-token pending-comment bridge fallback stays on the bridge default session.
    const fbStart = src.indexOf('async function sendStoredCommentBridgeFallback')
    assert.notEqual(fbStart, -1, 'sendStoredCommentBridgeFallback must exist')
    const fb = src.slice(fbStart, src.indexOf('async function loadPostingThumbnailAsset', fbStart))
    assert.ok(fb.includes('sendPageCommentViaCloakBridge('), 'fallback still comments via the bridge helper')
    assert.ok(!/\baccount\b\s*:/.test(fb), 'stored-comment bridge fallback must keep the bridge default session (no account override)')
})
