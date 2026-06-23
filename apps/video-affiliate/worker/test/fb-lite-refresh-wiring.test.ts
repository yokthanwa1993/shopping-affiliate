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

// ─────────────────────────────────────────────────────────────────────────────
// Post-success immediate comment drain (no longer cron-only).
// A successful page post that leaves comment_status='pending' must trigger a
// TARGETED drain of just-that-row shortly after the post is persisted, instead
// of waiting minutes for the next cron scan. Cron stays the fallback. These
// tests read the worker source (index.ts cannot be imported under node:test).
// ─────────────────────────────────────────────────────────────────────────────

test('processPendingCommentBacklog accepts options (historyId/ignoreDueAt/limit)', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function processPendingCommentBacklog')
    assert.notEqual(start, -1, 'processPendingCommentBacklog must exist')
    const sig = src.slice(start, src.indexOf('Promise<void>', start))
    assert.ok(/options\s*:\s*\{[^}]*historyId\?[^}]*ignoreDueAt\?[^}]*limit\?/.test(sig.replace(/\n/g, ' ')),
        'must accept an options object with historyId/ignoreDueAt/limit')

    const fn = src.slice(start, src.indexOf('async function ensureCronRuntimeStateTable', start))
    // Targeting a specific row pins LIMIT 1 and bypasses the due_at gate.
    assert.ok(fn.includes('const targetHistoryId = Number(options.historyId || 0)'), 'must read options.historyId')
    assert.ok(/ignoreDueAt\s*=\s*!!options\.ignoreDueAt \|\| targetHistoryId > 0/.test(fn),
        'a concrete historyId must imply ignoreDueAt')
    assert.ok(fn.includes('ph.id = ?'), 'must filter by ph.id when targeting a row')
    // The due_at gate is only applied when NOT ignoring it (general cron scan).
    assert.ok(/if \(!ignoreDueAt\)/.test(fn), 'due_at predicate must be conditional on !ignoreDueAt')
    assert.ok(fn.includes("ph.comment_due_at IS NULL OR datetime(ph.comment_due_at) <= datetime('now')"),
        'general scan must still respect comment_due_at')
})

test('general backlog scan prioritizes fresh posts, not oldest-first only', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function processPendingCommentBacklog')
    const fn = src.slice(start, src.indexOf('async function ensureCronRuntimeStateTable', start))
    // The old unconditional "ORDER BY ... posted_at ASC, ph.id ASC" for the general scan must be
    // gone — that let months-old backlog (LIMIT 20) starve fresh deploy-boundary posts.
    assert.ok(!/ORDER BY datetime\(ph\.posted_at\) ASC, ph\.id ASC\b/.test(fn),
        'general scan must NOT order purely oldest-first anymore')
    // Recent-priority CASE puts last-6h posts first, then newest-first.
    assert.ok(/CASE WHEN datetime\(ph\.posted_at\) >= datetime\('now', '-6 hours'\) THEN 0 ELSE 1 END ASC/.test(fn),
        'general scan must put recently-posted rows first via a CASE bucket')
    assert.ok(/datetime\(ph\.posted_at\) DESC/.test(fn), 'general scan must then order newest-first')
    // The targeted (single-row) path is unaffected — ordering is moot there.
    assert.ok(/targetHistoryId > 0\s*\?\s*'datetime\(ph\.posted_at\) ASC, ph\.id ASC'/.test(fn),
        'targeted historyId path keeps a stable single-row order')
})

test('runPendingCommentBacklogSoon waits the fixed delay then targets the row ignoring due_at', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('function runPendingCommentBacklogSoon')
    assert.notEqual(start, -1, 'runPendingCommentBacklogSoon helper must exist')
    const fn = src.slice(start, src.indexOf('async function ensureCronRuntimeStateTable', start))
    // Bounded fixed delay (FB attachment readiness), never the random 1-59s + cron-only path.
    assert.ok(fn.includes('await waitMs(FACEBOOK_PAGE_COMMENT_DELAY_MS)'), 'must use the fixed bounded delay')
    assert.ok(!/getRandomCommentDelay/.test(fn), 'must NOT use the random comment delay')
    // Targeted drain of the exact row, ignoring due_at, limit 1.
    assert.ok(/processPendingCommentBacklog\(env,\s*\{[\s\S]*historyId:\s*targetHistoryId[\s\S]*ignoreDueAt:\s*true[\s\S]*limit:\s*1/.test(fn),
        'must call processPendingCommentBacklog with { historyId, ignoreDueAt: true, limit: 1 }')
    // Runs via waitUntil when an ExecutionContext is available (non-blocking), errors swallowed.
    assert.ok(fn.includes('enqueueBackgroundTask(ctx'), 'must dispatch via the background task helper (waitUntil-aware)')
    assert.ok(/\.catch\(/.test(fn), 'targeted drain errors must be caught/sanitized (comment failure non-fatal)')
})

test('every post-success pending path triggers the targeted drain', () => {
    const src = readVideoAffiliateIndex()
    // Force-post (regular reel, ads post-first, ads publish, cloak bridge), retry-post, and the
    // matching cron branches each call runPendingCommentBacklogSoon when they leave pending.
    const calls = (src.match(/runPendingCommentBacklogSoon\(/g) || []).length
    assert.ok(calls >= 7, `expected the targeted drain to be wired at every pending post-success site (found ${calls})`)
    // HTTP routes pass the request ExecutionContext; cron passes the scheduled ctx.
    assert.ok(src.includes("runPendingCommentBacklogSoon(env, retryHistoryId, 'RETRY-POST IMMEDIATE-COMMENT', c.executionCtx)"),
        'retry-post must trigger the targeted drain')
    assert.ok(src.includes("runPendingCommentBacklogSoon(env, forceHistoryId, 'FORCE-POST IMMEDIATE-COMMENT', c.executionCtx)"),
        'force-post regular reel must trigger the targeted drain')
    assert.ok(/runPendingCommentBacklogSoon\(env, Number\(cronHistoryId \|\| 0\), `CRON [^`]*IMMEDIATE-COMMENT`, ctx\)/.test(src),
        'cron post-success branches must trigger the targeted drain with the scheduled ctx')
})

test('generic cron comment drain still runs without ignoreDueAt (cron stays the fallback)', () => {
    const src = readVideoAffiliateIndex()
    // The scheduled handler drains the general backlog with NO options → due_at is respected.
    assert.ok(/runComments:\s*\(\)\s*=>\s*_ctx\.waitUntil\(processPendingCommentBacklog\(env\)\.catch/.test(src),
        'the every-minute cron must call processPendingCommentBacklog(env) with no options')
})

test('stuck comment_status=processing rows are reset by the general cron scan', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function processPendingCommentBacklog')
    const fn = src.slice(start, src.indexOf('async function ensureCronRuntimeStateTable', start))
    // Backstop only runs for the general scan (no concrete historyId) so an in-flight targeted
    // drain is never disturbed, and only resets rows with no FRESH comment-job lock.
    assert.ok(/if \(targetHistoryId <= 0\)/.test(fn), 'backstop must be gated to the general cron scan')
    assert.ok(fn.includes("comment_status='processing'"), 'backstop must target stuck processing rows')
    assert.ok(/SET comment_status='pending'/.test(fn), 'backstop must reset stuck rows to pending')
    assert.ok(fn.includes("'video::' || post_history.bot_id || '::comment:' || post_history.id"),
        'backstop must key off the comment-job posting lock')
    assert.ok(/datetime\('now', '-15 minutes'\)/.test(fn), 'backstop must only reset rows with no fresh (<15m) lock')
})
