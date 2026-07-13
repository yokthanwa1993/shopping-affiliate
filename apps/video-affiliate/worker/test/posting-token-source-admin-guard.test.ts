import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
    defaultCommentSourceForRoute,
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
// No page-id special cases (CHEARB stored_token regression).
// Force-post used to hardcode page 1008898512617594 (เฉียบ/CHEARB) to
// pagePostingTokenSource='cloak_browser' — and promote its comment source to
// match — overriding the persisted posting_token_source='stored_token'. Normal
// CHEARB page posting is the Facebook Lite lane (FBGetToken / Bridge Token →
// stored_token semantics, EAAD6*/facebook_lite_bridge hints), and Power Editor
// is unrelated to it: the cloak session bridge must never be forced by page id.
// Force-post and cron must both resolve the persisted posting/comment sources
// through the same normalize + admin-guard pipeline for every page.
// ─────────────────────────────────────────────────────────────────────────────

test('stored_token stays stored_token for an admin-owned page (CHEARB lane): posting, comment, and route', () => {
    // Admin ownership must not promote a persisted stored_token source anywhere in the pipeline.
    const posting = restrictCloakToAdminNamespace(normalizePagePostingTokenSource('stored_token'), true)
    assert.equal(posting, 'stored_token')
    assert.equal(resolvePostingRoute({ source: posting }), 'stored_token')
    // The comment source resolves the same way: an explicit stored_token stays put, and a
    // missing value follows the effective (stored) posting route — never the cloak bridge.
    assert.equal(restrictCloakToAdminNamespace(normalizePageCommentTokenSource('stored_token'), true), 'stored_token')
    const commentFallback = defaultCommentSourceForRoute(resolvePostingRoute({ source: posting }))
    assert.equal(restrictCloakToAdminNamespace(normalizePageCommentTokenSource(undefined, commentFallback), true), 'stored_token')
})

test('wiring: force-post resolves posting + comment sources from the page row only — no page-id promotion', () => {
    const src = indexSrc()
    const logIdx = src.indexOf('[FORCE-POST] page=')
    assert.notEqual(logIdx, -1, 'force-post log marker must exist')
    const regionStart = src.lastIndexOf('namespaceIsAdminOwned = await isNamespaceShortlinkAdminManaged', logIdx)
    assert.notEqual(regionStart, -1, 'force-post must resolve namespaceIsAdminOwned before logging the route')
    const region = src.slice(regionStart, logIdx)
    // Both sources are const bindings of the shared normalize + admin-guard pipeline…
    assert.ok(/const pagePostingTokenSource = restrictCloakToAdminNamespace\(/.test(region),
        'force-post posting source must be a const of the admin-guard pipeline')
    assert.ok(/const pageCommentTokenSource: PageCommentTokenSource = restrictCloakToAdminNamespace\(/.test(region),
        'force-post comment source must be a const of the admin-guard pipeline')
    // …never `let` + a later promotion, and never special-cased by page id (the CHEARB hardcode).
    assert.ok(!/let pagePostingTokenSource|let pageCommentTokenSource/.test(region),
        'force-post sources must not be reassignable after normalization')
    assert.ok(!/pagePostingTokenSource = 'cloak_browser'|pageCommentTokenSource = 'cloak_browser'/.test(region),
        'force-post must never force a resolved source to cloak_browser')
    assert.ok(!region.includes('1008898512617594'), 'force-post must not hardcode any page id into source resolution')
})

test('wiring: cron resolves sources through the SAME pipeline — no page-id override at either trigger site', () => {
    const src = indexSrc()
    const logIdx = src.indexOf('[CRON] page=')
    assert.notEqual(logIdx, -1, 'cron log marker must exist')
    const regionStart = src.lastIndexOf('namespaceIsAdminOwned = await isNamespaceShortlinkAdminManaged', logIdx)
    assert.notEqual(regionStart, -1, 'cron must resolve namespaceIsAdminOwned before routing')
    const region = src.slice(regionStart, logIdx)
    assert.ok(/const pagePostingTokenSource = restrictCloakToAdminNamespace\(/.test(region),
        'cron posting source must be a const of the admin-guard pipeline')
    assert.ok(/const pageCommentTokenSource: PageCommentTokenSource = restrictCloakToAdminNamespace\(/.test(region),
        'cron comment source must be a const of the admin-guard pipeline')
    assert.ok(!region.includes('1008898512617594'), 'cron must not hardcode any page id into source resolution')
    // Nowhere in the worker may a page-id equality force a posting/comment source or route.
    assert.equal((src.match(/===\s*'1008898512617594'/g) || []).length, 0,
        'no CHEARB page-id equality special case may exist anywhere in index.ts')
})

// Slice one bridge call site: logPrefix is the LAST property at these call sites, so the
// text between the nearest call opener and the logPrefix marker holds all of its params.
function cloakCallParams(src: string, opener: string, logPrefixMarker: string): string {
    const markerIdx = src.indexOf(logPrefixMarker)
    assert.notEqual(markerIdx, -1, `bridge call marker must exist: ${logPrefixMarker}`)
    const openerIdx = src.lastIndexOf(opener, markerIdx)
    assert.notEqual(openerIdx, -1, `bridge call opener must precede the marker: ${opener}`)
    return src.slice(openerIdx, markerIdx)
}

test('wiring: explicit cloak publish/comment calls carry no per-page account override (no special Power Editor route)', () => {
    const src = indexSrc()
    const sites: Array<[string, string]> = [
        ['await publishReelViaSessionBridge({', "logPrefix: 'FORCE-POST CLOAK-BRIDGE'"],
        ['await sendPageCommentViaCloakBridge({', "logPrefix: 'FORCE-POST CLOAK-COMMENT'"],
        ['await publishReelViaSessionBridge({', 'logPrefix: `CRON CLOAK-BRIDGE ${page.name}`'],
        ['await sendPageCommentViaCloakBridge({', 'logPrefix: `CRON CLOAK-COMMENT ${page.name}`'],
    ]
    for (const [opener, marker] of sites) {
        const call = cloakCallParams(src, opener, marker)
        assert.ok(!call.includes('configuredPostingProfileUid'),
            `cloak bridge call must not thread posting_profile_uid as its bridge account (${marker})`)
    }
    assert.ok(!src.includes('account: configuredPostingProfileUid'),
        'no call may pass posting_profile_uid as a cloak bridge account')
})

test('wiring: Facebook Lite lane untouched — posting_profile_uid still threads into the stored-token refresh at both trigger sites', () => {
    const src = indexSrc()
    // Both trigger sites still derive the per-page uid from the page row via the shared sanitizer…
    const derivations = (src.match(/const configuredPostingProfileUid = sanitizePostingProfileUid\(/g) || []).length
    assert.ok(derivations >= 2, `force-post + cron must derive configuredPostingProfileUid from the page row (found ${derivations})`)
    // …and thread it into the stored-token Facebook Lite publish wrapper (so the FB Lite refresh
    // targets the configured account, e.g. Chanalai for CHEARB) at BOTH trigger sites.
    const storedThreads = (src.match(/^\s+configuredPostingProfileUid,$/gm) || []).length
    assert.ok(storedThreads >= 2, `the stored-token publish closures must thread configuredPostingProfileUid (found ${storedThreads})`)
    // The FB Lite bridge comment branch keeps commenting through the account that created the post.
    const liteComment = cloakCallParams(src, 'await sendPageCommentViaCloakBridge({', "logPrefix: 'FORCE-POST FB-LITE-COMMENT'")
    assert.ok(liteComment.includes('account: facebookLiteBridgeAccount'),
        'the FB Lite comment branch must keep threading facebookLiteBridgeAccount')
})

// ─────────────────────────────────────────────────────────────────────────────
// Truthful bridge-lane audit hints (source-aware).
// Live regression: a CHEARB force-post succeeded through the local bridge's
// Facebook Lite EAAD6 lane (bridge /post response `source: 'facebook_lite_eaad6'`,
// Graph readback confirms the Page post + comment), but post_history recorded
// post_token_hint/comment_token_hint='cloak_session_bridge'. The Worker must
// persist the lane the bridge RESPONSE reports — never assume the generic cloak
// label — without changing any routing (CHEARB stays on the Facebook Lite
// stored-token lane; nothing is promoted to Power Editor / cloak_browser).
// ─────────────────────────────────────────────────────────────────────────────

test('wiring: publishReelViaSessionBridge resolves its returned postingToken from the bridge response source', () => {
    const src = indexSrc()
    const start = src.indexOf('async function publishReelViaSessionBridge')
    assert.notEqual(start, -1, 'publishReelViaSessionBridge must exist')
    const end = src.indexOf('\nfunction buildPageStoryId', start)
    assert.notEqual(end, -1, 'function boundary (buildPageStoryId) must exist')
    const fn = src.slice(start, end)
    // The /post response parse includes the safe token-free `source` field…
    assert.ok(/source\?: string/.test(fn), '/post response type must parse the safe source field')
    // …and the returned hint resolves source-first, with the caller-requested hint as fallback
    // (default cloak_session_bridge preserved for every non-Lite response).
    assert.ok(/const requestedPostingTokenHint = String\(params\.postingTokenHint \|\| ''\)\.trim\(\) \|\| 'cloak_session_bridge'/.test(fn),
        'caller hint/default resolution must be unchanged (fallback role only)')
    assert.ok(/const postingTokenHint = resolveSessionBridgePostingTokenHint\(data\.source, requestedPostingTokenHint\)/.test(fn),
        'returned hint must be resolved from the bridge-reported source')
    assert.ok(fn.includes('postingToken: postingTokenHint'), 'return keeps the token-free hint field')
})

test('wiring: force-post + cron cloak branches persist the bridge-reported lane (history + comment hint)', () => {
    const src = indexSrc()
    const branches: Array<[string, string]> = [
        ["logPrefix: 'FORCE-POST CLOAK-BRIDGE'", 'CLOAK-BRIDGE POST OK'],
        ['logPrefix: `CRON CLOAK-BRIDGE ${page.name}`', 'CLOAK-BRIDGE POST OK'],
    ]
    for (const [callMarker, endMarker] of branches) {
        const callIdx = src.indexOf(callMarker)
        assert.notEqual(callIdx, -1, `bridge call marker must exist: ${callMarker}`)
        const endIdx = src.indexOf(endMarker, callIdx)
        assert.notEqual(endIdx, -1, `branch end marker must exist after ${callMarker}`)
        const region = src.slice(callIdx, endIdx)
        // The lane comes from the bridge response (cloakResult.postingToken), exact-match only.
        assert.ok(region.includes("const cloakPostedViaFacebookLite = cloakResult.postingToken === 'facebook_lite_bridge'"),
            `cloak branch must read the bridge-reported lane (${callMarker})`)
        // Both persisted labels exist verbatim: Lite-served rows record facebook_lite_bridge,
        // session-served rows keep the legacy cloak_session_bridge label (never renamed).
        assert.ok(region.includes("post_token_hint='facebook_lite_bridge'"),
            `lite-served publish must persist post_token_hint='facebook_lite_bridge' (${callMarker})`)
        assert.ok(region.includes("post_token_hint='cloak_session_bridge'"),
            `session-served publish must keep the legacy label (${callMarker})`)
        // The bridge comment hint follows the SAME reported lane — never a hardcoded cloak label.
        assert.ok(!region.includes("cloakCommentTokenHint = 'cloak_session_bridge'"),
            `cloak comment hint must not be hardcoded to cloak_session_bridge (${callMarker})`)
        assert.ok(region.includes('cloakCommentTokenHint = cloakPostTokenHint'),
            `cloak comment hint must follow the bridge-reported lane (${callMarker})`)
    }
})

test('wiring: deriveCommentTokenHint persists established lane labels verbatim (facebook_lite_bridge never redacts to facebo...idge)', () => {
    const src = indexSrc()
    const start = src.indexOf('function deriveCommentTokenHint')
    assert.notEqual(start, -1, 'deriveCommentTokenHint must exist')
    const fn = src.slice(start, start + 700)
    assert.ok(/if \(isPersistedBridgeLaneHint\(normalized\)\) return normalized/.test(fn),
        'lane labels must bypass token redaction so history + comment classification see the exact hint')
    // The redaction path for RAW tokens is unchanged (still token-free in history).
    assert.ok(fn.includes('normalized.slice(0, 6)'), 'raw tokens must still be redacted')
})
