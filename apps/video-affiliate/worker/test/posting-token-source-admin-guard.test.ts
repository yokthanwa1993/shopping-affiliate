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
