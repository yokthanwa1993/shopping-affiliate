import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// These tests assert the cross-worker FB GET Token / Facebook Lite refresh WIRING by reading
// the worker source (index.ts modules cannot be imported under plain node:test because they
// pull in the full Cloudflare runtime). They lock in the root fix: a stored Facebook Lite
// token is never permanently "expired" — when it is missing or rejected (190 / invalidated)
// the Worker re-mints a fresh token from stored credentials via BrowserSaving and retries.

function readVideoAffiliateIndex(): string {
    return readFileSync('src/index.ts', 'utf8')
}

function readBrowserSavingIndex(): string {
    return readFileSync('../../browsersaving/worker/src/index.ts', 'utf8')
}

test('profile-sync receiver: secret-authed server push is honored, direct/client management stays 410', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf("app.post('/api/pages/profile-sync'")
    assert.notEqual(start, -1, 'profile-sync route must exist')
    const body = src.slice(start, src.indexOf("app.post('/api/pages/profile-token-health'", start))
    // The push secret gate returns 410 ONLY for non-secret callers (client/direct management).
    assert.ok(
        /if \(!configuredSecret \|\| providedSecret !== configuredSecret\) \{\s*return c\.json\(\{ error: 'direct_page_management_only' \}, 410\)/.test(body),
        'profile-sync must 410 only when the push secret is missing/mismatched',
    )
    // The legacy unconditional 410 at the top of the handler must be gone.
    assert.ok(
        !/app\.post\('\/api\/pages\/profile-sync', async \(c\) => \{\s*return c\.json\(\{ error: 'direct_page_management_only' \}, 410\)/.test(src),
        'profile-sync must not unconditionally 410 (that broke the FB Lite token sync)',
    )
    // It still upserts the freshly synced token into the namespace pool.
    assert.ok(body.includes('upsertNamespacePageFromProfileSync'), 'profile-sync must upsert into the token pool')
})

test('refresh helper posts to the BrowserSaving secret route via the authenticated base fetch', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function postFacebookLiteRefresh')
    assert.notEqual(start, -1, 'postFacebookLiteRefresh must exist')
    const fn = src.slice(start, src.indexOf('async function probeFacebookLiteProfilesForPage', start))
    assert.ok(fn.includes("'/api/fb-lite/refresh-comment-token'"), 'must call the BrowserSaving refresh route')
    assert.ok(fn.includes('fetchFromBrowserSavingBase'), 'must use the authenticated cross-worker fetch (adds x-tag-sync-secret)')
    assert.ok(fn.includes('buildFacebookLiteRefreshRequestBody'), 'must build the token-free request body')
    assert.ok(fn.includes('parseFacebookLiteRefreshResponse'), 'must parse the token-free response')
    // Token-free: the refresh helper must not log a token, only ids/booleans/redacted hints.
    const refreshStart = src.indexOf('async function refreshFacebookLiteCommentTokenForPage')
    const refreshFn = src.slice(refreshStart, src.indexOf('async function probeFacebookLiteProfilesForPage', refreshStart))
    const logLine = refreshFn.split('\n').find((l) => l.includes('console.log')) || ''
    assert.ok(!/token=\$\{/.test(logLine), 'refresh log must never interpolate a token value')
})

test('refresh is auto-discovery first-class: no_linked_profile is NOT terminal', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function refreshFacebookLiteCommentTokenForPage')
    const fn = src.slice(start, src.indexOf('async function probeFacebookLiteProfilesForPage', start))
    // The old terminal "no_linked_profile" early-return must be gone.
    assert.ok(!fn.includes("'no_linked_profile'"), 'must not early-return no_linked_profile')
    // Linked profiles are tried first, but a page-only auto-discovery request is always made
    // when nothing synced (profile_id omitted → BrowserSaving discovers the owner).
    assert.ok(fn.includes('buildFacebookLiteRefreshRequestBody({ profileId, pageId, pageName: params.pageName, namespaceId, ownerEmails, candidateLoginIds: explicitCandidateLoginIds })'), 'linked profile attempt')
    assert.ok(fn.includes('buildFacebookLiteRefreshRequestBody({ pageId, pageName: params.pageName, namespaceId, ownerEmails, candidateProfileIds: linkedIds, candidateLoginIds: explicitCandidateLoginIds })'), 'page-only auto-discovery attempt')
    // Owner-scoped discovery for multi-tenant safety.
    assert.ok(fn.includes('resolveNamespaceOwnerEmails'), 'must scope discovery by namespace owner email')
})

test('refresh profile resolution prefers linked profiles, falls back to tag-derived', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function resolveFacebookLiteRefreshProfileIdsForPage')
    assert.notEqual(start, -1, 'resolveFacebookLiteRefreshProfileIdsForPage must exist')
    const fn = src.slice(start, src.indexOf('async function resolveNamespaceOwnerEmails', start))
    assert.ok(fn.includes('getNamespaceLinkedTaggedProfiles'), 'must consult operator-linked profiles first')
    assert.ok(fn.includes('filterProfilesForTaggedPage'), 'must fall back to tag-derived profiles for the page')
})

test('pending-comment backlog: refresh+retry on missing token AND on auth failure, before bridge fallback', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function processPendingCommentBacklog')
    assert.notEqual(start, -1, 'processPendingCommentBacklog must exist')
    const fn = src.slice(start, src.indexOf('async function ensureCronRuntimeStateTable', start))

    // The reload-after-refresh closure exists and is gated by the pure helper.
    assert.ok(fn.includes('reloadCommentTokenViaFacebookLiteRefresh'), 'backlog must define the refresh+reload closure')
    assert.ok(fn.includes('shouldAttemptFacebookLiteRefresh'), 'reload must be gated by the pure refresh predicate')
    assert.ok(fn.includes('refreshFacebookLiteCommentTokenForPage'), 'backlog must call the refresh helper')
    // It re-reads the fresh token from the pool (resolveFacebookCommentToken), never trusts the stale row.
    assert.ok(fn.includes('resolveFacebookCommentToken(env.DB, pageId, botId)'), 'must reload the fresh token from the pool')

    // Triggered on BOTH the missing-token branch and the auth-failure branch.
    assert.ok(fn.includes("reloadCommentTokenViaFacebookLiteRefresh('missing')"), 'missing-token branch must try refresh first')
    assert.ok(fn.includes("reloadCommentTokenViaFacebookLiteRefresh('auth_failure', commentResult.error)"), 'auth-failure branch must try refresh + retry')

    // The previous CloakBrowser bridge fallback is preserved as the safety net.
    assert.ok(fn.includes('sendStoredCommentBridgeFallback'), 'bridge fallback must remain as the safety net')
})

test('manual maintenance endpoint: authenticated, namespace-scoped, dry-run-safe, token-free', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf("app.post('/api/pages/:id/refresh-comment-token'")
    assert.notEqual(start, -1, 'manual refresh endpoint must be registered')
    const route = src.slice(start, src.indexOf("app.post('/api/pages/:id/retry-failed-comments'", start))
    assert.ok(route.includes('requireAuthSession'), 'must require an authenticated session')
    assert.ok(route.includes("c.get('botId')"), 'must scope to the caller namespace')
    // dry_run defaults TRUE — only an explicit false performs the live refresh.
    assert.ok(/const dryRun = !\(dryRunRaw === false/.test(route), 'dry_run must default to true')
    assert.ok(route.includes('refreshFacebookLiteCommentTokenForPage'), 'live path calls the refresh helper')
    assert.ok(route.includes('probeFacebookLiteProfilesForPage'), 'dry-run path reports via the no-mint discovery probe')
    // Token-free response: returns counts/booleans/redacted reason, never a token field.
    assert.ok(!/access_token|comment_token|\btoken\b\s*:/.test(route), 'manual endpoint response must not expose any token')
})

test('BrowserSaving refresh route: secret-authed, auto-discovers by page, returns only redacted booleans/ids', () => {
    const src = readBrowserSavingIndex()
    const start = src.indexOf("app.post('/api/fb-lite/refresh-comment-token'")
    assert.notEqual(start, -1, 'BrowserSaving refresh route must be registered')
    const route = src.slice(start, src.indexOf("app.get('/api/postcron/:profileId/post'", start))
    assert.ok(route.includes('verifyVideoAffiliateProvisionSecret'), 'must be secret-authed (x-tag-sync-secret)')
    assert.ok(route.includes('fetchFreshCommentToken'), 're-mints a fresh token from stored credentials')
    assert.ok(route.includes('persistCommentTokenAndResolvedPage'), 'pushes the fresh token back to video-affiliate')
    assert.ok(route.includes('buildFbLiteRefreshResponse'), 'returns the token-free redacted response body')
    assert.ok(/body\?\.dry_run === true/.test(route), 'supports dry_run (report-only)')
    // profile_id OPTIONAL → auto-discovery when omitted (no manual linking required).
    assert.ok(route.includes('discoverFbLiteProfileForPage'), 'must auto-discover the owning profile when no profile_id')
    assert.ok(route.includes('profile_id_or_page_id_required'), 'accepts page_id without profile_id')
    // The route must never return the raw token / page_token / user token to the caller.
    assert.ok(!/\bpage_token\b/.test(route), 'route must not return page_token')
    assert.ok(!/raw_user_token/.test(route), 'route must not return the raw user token')
})

test('BrowserSaving auto-discovery: probes stored creds then mints, owner-scoped, token-free', () => {
    const src = readBrowserSavingIndex()
    const start = src.indexOf('async function discoverFbLiteProfileForPage')
    assert.notEqual(start, -1, 'discoverFbLiteProfileForPage must exist')
    const fn = src.slice(start, src.indexOf('function parseFbLiteOwnerEmails', start))
    // Searches credentialed profiles (uid/username + password), optionally owner/candidate scoped.
    assert.ok(/TRIM\(COALESCE\(password,''\)\) <> ''/.test(fn), 'must require stored password')
    assert.ok(fn.includes("owner_email") && fn.includes('ownerEmails'), 'must support owner_email scoping')
    // Pass 1 stored token, Pass 2 mint fresh (works when stored token is dead/invalidated).
    assert.ok(fn.includes('listFacebookPageIdsForToken'), 'must check page ownership via me/accounts')
    assert.ok(fn.includes('fetchFreshCommentToken') && /allowMint/.test(fn), 'must mint fresh when allowed')
    // page ownership match by id; no token returned in the result object beyond a reusable mint.
    assert.ok(fn.includes('ids.has(pid)'), 'must match the requested page id')

    // The dedicated read-only discovery route exists and never mints.
    const routeStart = src.indexOf("app.post('/api/fb-lite/profiles-for-page'")
    assert.notEqual(routeStart, -1, 'profiles-for-page discovery route must be registered')
    const route = src.slice(routeStart, src.indexOf("app.post('/api/fb-lite/refresh-comment-token'", routeStart))
    assert.ok(route.includes('verifyVideoAffiliateProvisionSecret'), 'discovery route must be secret-authed')
    assert.ok(/allowMint: false/.test(route), 'discovery route must NOT mint (read-only)')
    assert.ok(route.includes('would_refresh'), 'reports whether a credentialed owner exists')
    assert.ok(!/\bpage_token\b/.test(route) && !/access_token/.test(route), 'discovery route must not expose tokens')
})

test('BrowserSaving redaction: reason strips token-like substrings and caps length', () => {
    const src = readBrowserSavingIndex()
    const start = src.indexOf('function redactFbLiteReason')
    assert.notEqual(start, -1, 'redactFbLiteReason must exist')
    const fn = src.slice(start, src.indexOf('function buildFbLiteRefreshResponse', start))
    assert.ok(/EAA\[A-Za-z0-9\]\{6,\}/.test(fn) || fn.includes('EAA'), 'must redact EAA… token-like substrings')
    assert.ok(fn.includes('.slice(0, 120)'), 'must cap the reason length')
})
