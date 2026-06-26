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
        /if \(!secretAuthorized\) \{\s*return c\.json\(\{ error: 'direct_page_management_only' \}, 410\)/.test(body),
        'profile-sync must 410 only when no configured secret authorizes the caller',
    )
    // The legacy unconditional 410 at the top of the handler must be gone.
    assert.ok(
        !/app\.post\('\/api\/pages\/profile-sync', async \(c\) => \{\s*return c\.json\(\{ error: 'direct_page_management_only' \}, 410\)/.test(src),
        'profile-sync must not unconditionally 410 (that broke the FB Lite token sync)',
    )
    // It still upserts the freshly synced token into the namespace pool.
    assert.ok(body.includes('upsertNamespacePageFromProfileSync'), 'profile-sync must upsert into the token pool')
})

test('profile-sync accepts EITHER TAG_SYNC_PUSH_SECRET OR a dedicated BRIDGE_TOKEN_SYNC_SECRET', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf("app.post('/api/pages/profile-sync'")
    assert.notEqual(start, -1, 'profile-sync route must exist')
    const body = src.slice(start, src.indexOf("app.post('/api/pages/profile-token-health'", start))
    // Both secrets are read; the existing BrowserSaving secret keeps working AND a Bridge Token
    // exporter can be provisioned with its own secret without rotating the BrowserSaving one.
    assert.ok(/const tagSyncSecret = String\(c\.env\.TAG_SYNC_PUSH_SECRET \|\| ''\)\.trim\(\)/.test(body),
        'must still read TAG_SYNC_PUSH_SECRET')
    assert.ok(/BRIDGE_TOKEN_SYNC_SECRET/.test(body), 'must also read BRIDGE_TOKEN_SYNC_SECRET')
    // Authorization requires a non-empty provided secret matching one of the CONFIGURED secrets,
    // so an unset secret can never accidentally authorize (no empty-string match).
    assert.ok(/const secretAuthorized = !!providedSecret && \(/.test(body),
        'authorization must require a non-empty provided secret')
    assert.ok(/!!tagSyncSecret && providedSecret === tagSyncSecret/.test(body), 'tag-sync secret branch')
    assert.ok(/!!bridgeTokenSecret && providedSecret === bridgeTokenSecret/.test(body), 'bridge-token secret branch')
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

test('pending-comment refresh is BOUNDED to a single attempt (one-shot guard, never an infinite re-mint loop)', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function processPendingCommentBacklog')
    const fn = src.slice(start, src.indexOf('async function ensureCronRuntimeStateTable', start))
    // The reload closure must early-return when it has already run once this row, so a permanently
    // bad credential can never drive an unbounded mint/check loop (which is what tripped Facebook's
    // rate limiter during manual recovery).
    assert.ok(/if \(fbLiteRefreshAttempted\) return false/.test(fn), 'refresh must early-return once already attempted')
    assert.ok(/fbLiteRefreshAttempted = true/.test(fn), 'the one-shot guard must be set before the refresh call')
})

test('targeted comment drain failure requeues the row to pending AND releases the comment-job lock (no 15-min stall)', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function processPendingCommentBacklog')
    const fn = src.slice(start, src.indexOf('async function ensureCronRuntimeStateTable', start))
    // The per-row catch must terminally requeue a claimed 'processing' row back to 'pending' so a
    // crashed/failed targeted drain does not wait for the 15-min general backstop to recover it. Anchor
    // on the id-scoped requeue (distinct from the general backstop, which resets by status only).
    const requeueIdx = fn.indexOf("AND comment_status = 'processing'")
    assert.notEqual(requeueIdx, -1, 'per-row catch must requeue only a row it claimed (id-scoped processing guard)')
    const requeueBlock = fn.slice(Math.max(0, requeueIdx - 300), requeueIdx)
    assert.ok(/comment_status='pending'/.test(requeueBlock), 'catch must requeue the claimed row to pending')
    assert.ok(/WHERE id = \?/.test(requeueBlock), 'the requeue must be scoped to the specific history row id')
    // The finally must release the comment-job posting lock so the requeued row is immediately
    // eligible again instead of being blocked behind a held 15-min lock.
    assert.ok(fn.includes('releasePostingLock(env.DB, commentJobLockKey)'), 'finally must release the comment-job lock')
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

// ─────────────────────────────────────────────────────────────────────────────
// Stored-token / Facebook Lite PUBLISH auto-refresh (the production root fix).
// A force/retry/cron organic-Reel publish that fails with an auth-invalid stored
// token (190 / "session has been invalidated") must re-mint a fresh page token —
// BrowserSaving first, then the Bridge Token /pages tunnel — sync it into the pool,
// and retry the publish ONCE. Token-free. (index.ts read as source; not importable.)
// ─────────────────────────────────────────────────────────────────────────────

test('publish wrapper refreshes + retries once only on stored-token auth failure', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh')
    assert.notEqual(start, -1, 'the stored-token publish+refresh wrapper must exist')
    const fn = src.slice(start, src.indexOf('type PageOneCardLinkMode', start))
    // Happy path delegates to the existing fallback chain.
    assert.ok(fn.includes('await publishReelWithCommentTokenPrimaryFallback('), 'must call the existing publish fallback chain')
    // Refresh is gated by the pure posting predicate (auth-failure / missing token only).
    assert.ok(fn.includes('shouldAttemptFacebookLitePostingRefresh('), 'refresh must be gated by the posting predicate')
    // Non-auth failures are rethrown untouched (never masked).
    assert.ok(/throw publishErr/.test(fn), 'a non-auth failure must rethrow the original publish error')
    // Re-mint + reload + single retry.
    assert.ok(fn.includes('refreshFacebookLitePostingTokenForPage('), 'must call the posting-token refresh helper')
    assert.ok(fn.includes('params.reloadTokens()'), 'must reload the fresh token pool before retrying')
    assert.ok(fn.includes('POST-REFRESH-RETRY'), 'the retry must be a single labeled re-publish')
    // Only retries when a fresh token actually synced.
    assert.ok(/if \(!refresh\.synced\)/.test(fn), 'must only retry when a fresh token was synced')
    // Token-free: never interpolate a token into a log line.
    const logLines = fn.split('\n').filter((l) => /console\.(log|warn|error)/.test(l))
    assert.ok(logLines.every((l) => !/token=\$\{|accessToken|\.token\}/.test(l)), 'wrapper logs must never interpolate a token value')
})

test('publish wrapper routes (#10) Permission Denied to the Facebook Lite bridge ORGANIC /post (distinct, fail-closed)', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh')
    const fn = src.slice(start, src.indexOf('type PageOneCardLinkMode', start))
    // The gate now admits permission-denied (#10) in ADDITION to the auth-failure refresh predicate,
    // so the ad-account "(#10) Permission Denied" no longer rethrows before the bridge fallback.
    assert.ok(fn.includes('isFacebookLitePostingPermissionError('), '(#10) permission errors must be detected')
    assert.ok(/if \(!authFailure && !permissionDenied\)/.test(fn), 'gate must enter the fallback on auth failure OR permission denied')
    // The bridge ORGANIC /post is attempted (publishReelViaSessionBridge, facebook_lite_bridge hint).
    assert.ok(fn.includes('publishReelViaSessionBridge('), 'must attempt the Facebook Lite bridge organic /post')
    assert.ok(fn.includes("postingTokenHint: 'facebook_lite_bridge'"), 'bridge publish is tagged facebook_lite_bridge')
    // Fail-closed with DISTINCT errors so Hermes can see which path was attempted.
    assert.ok(fn.includes('facebook_lite_bridge_organic_post_failed:'), 'a failed bridge organic post surfaces a distinct error')
    assert.ok(fn.includes('facebook_lite_permission_denied_no_bridge_account:'), 'permission denied + no bridge account surfaces distinctly')
})

test('EAAD6V token publishes via direct /{page}/videos (is_reel OFF) as PRIMARY, never /video_reels; bridge organic /post is only the secondary', () => {
    const src = readVideoAffiliateIndex()
    const wrapStart = src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh')
    const wrapFn = src.slice(wrapStart, src.indexOf('type PageOneCardLinkMode', wrapStart))
    // Detect the Facebook Lite (EAAD6V) post token up front.
    assert.ok(/isFacebookLitePageToken\(litePostTokens\[0\]/.test(wrapFn), 'must detect a Facebook Lite (EAAD6V) post token up front')
    // PRIMARY: Worker-direct /{page}/videos multipart with is_reel:false (the confirmed working path).
    const litePrimaryIdx = wrapFn.indexOf('publishReelViaVideosEndpointWithTokenFallback(')
    assert.ok(litePrimaryIdx >= 0, 'EAAD6V lane publishes via the direct /videos endpoint helper')
    assert.ok(/isReel: false/.test(wrapFn), 'the EAAD6V /videos publish must OMIT is_reel (is_reel: false)')
    // It runs BEFORE the generic Worker-direct chain and is NOT the /video_reels resumable path.
    const genericDirectIdx = wrapFn.indexOf('return await publishReelWithCommentTokenPrimaryFallback({')
    assert.ok(litePrimaryIdx < genericDirectIdx, 'the EAAD6V /videos publish must precede the generic publish chain')
    // SECONDARY only (after the direct /videos attempt throws): the bridge organic /post.
    const bridgeIdx = wrapFn.indexOf('publishOrganicViaFacebookLiteBridge(')
    assert.ok(bridgeIdx > litePrimaryIdx, 'the bridge organic /post is a SECONDARY fallback, not the primary')
    assert.ok(/reason: 'eaad6_videos_direct_failed'/.test(wrapFn), 'the bridge secondary is reached only after the direct /videos attempt fails')

    // publishReelDirect omits is_reel when isReel===false (matches the confirmed curl: source + published only).
    const directStart = src.indexOf('async function publishReelDirect(')
    const directFn = src.slice(directStart, src.indexOf('async function applyPreferredVideoThumbnail', directStart))
    assert.ok(/if \(params\.isReel !== false\) formData\.append\('is_reel', 'true'\)/.test(directFn), 'is_reel is appended only when not explicitly disabled')

    // The bridge helper still surfaces a distinct, token-free capability blocker.
    const helperStart = src.indexOf('async function publishOrganicViaFacebookLiteBridge')
    const helperFn = src.slice(helperStart, src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh', helperStart))
    assert.ok(helperFn.includes('facebook_lite_publish_capability_blocked:'), 'no usable bridge → distinct capability blocker (not an endless (#10))')
})

test('posting-token refresh prefers BrowserSaving, falls back to the Bridge Token /pages tunnel', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function refreshFacebookLitePostingTokenForPage')
    assert.notEqual(start, -1, 'refreshFacebookLitePostingTokenForPage must exist')
    const fn = src.slice(start, src.indexOf('async function initReelUploadWithPostingTokenAutoRecover', start))
    // 1) BrowserSaving secret mint + profile-sync is tried first.
    assert.ok(fn.includes('refreshFacebookLiteCommentTokenForPage('), 'must try the BrowserSaving secret refresh first')
    assert.ok(/if \(bs\.synced\)/.test(fn), 'must short-circuit when BrowserSaving synced a fresh token')
    assert.ok(fn.includes("via: 'browsersaving'"), 'BrowserSaving success path is labeled')
    // 2) Bridge Token /pages fallback when BrowserSaving did not sync.
    assert.ok(fn.includes('fetchFacebookLitePageTokenFromBridge('), 'must fall back to the Bridge Token /pages fetch')
    assert.ok(fn.includes('upsertNamespacePageFromProfileSync('), 'must sync the bridge token into pages.access_token / pool')
    assert.ok(fn.includes("via: 'bridge_token_pages'"), 'bridge fallback success path is labeled')
})

test('bridge token fetch uses /pages?account=...&includeToken=1 and never logs the token', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function fetchFacebookLitePageTokenFromBridge')
    assert.notEqual(start, -1, 'fetchFacebookLitePageTokenFromBridge must exist')
    const fn = src.slice(start, src.indexOf('async function refreshFacebookLitePostingTokenForPage', start))
    // Resolves the Bridge Token base from env (CLOAK_FB_BRIDGE_URL = https://short.wwoom.com).
    assert.ok(fn.includes('resolveCloakFbBridgeBaseUrl('), 'must resolve the bridge base from env (CLOAK_FB_BRIDGE_URL)')
    // Hits the /pages route with includeToken and an optional account= candidate login id.
    assert.ok(fn.includes('buildBridgeTokenPagesUrl('), 'must build the /pages lookup url')
    assert.ok(/includeToken:\s*true/.test(fn), 'must request the raw token via includeToken=1')
    assert.ok(fn.includes('candidateLoginIds'), 'must try candidate login ids as account= first')
    // REGRESSION GUARD: the default-session sentinel ('') must be appended AFTER uniqueTokens —
    // uniqueTokens() drops blanks, so folding '' into the dedupe silently skips the no-account
    // default-session lookup, which is the LIVE production path (force-post/retry/cron pass no
    // candidate ids; the tool's default session lists every administered page, e.g. CHEARB).
    const flat = fn.replace(/\s+/g, ' ')
    // The candidates must be SPREAD out of uniqueTokens (`...uniqueTokens(...)`) with '' as a
    // sibling element — NOT `uniqueTokens([..., ''])`, which would drop the sentinel.
    assert.ok(/\.\.\.\s*uniqueTokens\(/.test(fn), 'candidate ids must be spread out of uniqueTokens so the sentinel stays a sibling')
    assert.ok(/\.\.\. ?uniqueTokens\(.+?\), ''/.test(flat), "default-session sentinel ('') must be appended after uniqueTokens, not deduped away")
    assert.ok(fn.includes('extractBridgeTokenPageAccessToken('), 'must extract the matching page access_token')
    // Token-free logging: only a presence flag is logged.
    assert.ok(fn.includes('token_present=true'), 'logs token presence, not the value')
    const logLines = fn.split('\n').filter((l) => /console\.(log|warn|error)/.test(l))
    assert.ok(logLines.every((l) => !/\$\{[^}]*token[^}]*\}/i.test(l) || /token_present/.test(l)), 'must never interpolate a raw token into logs')
})

test('profile-sync upsert accepts an EAAD6 Facebook Lite token as the lead post token (not dropped)', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function upsertNamespacePageFromProfileSync')
    assert.notEqual(start, -1, 'upsertNamespacePageFromProfileSync must exist')
    const fn = src.slice(start, src.indexOf('function uniqueTokens', start))
    // ROOT FIX: the old EAAD6-excluding gate must be gone. isPostRoleToken() treated EAAD6 as
    // "comment role" and so DROPPED a freshly-synced Facebook Lite page token from post_tokens /
    // pages.access_token, leaving the posting resolver on the stale EAABsb token (live row 33519
    // posted with a stale EAABsb even after a successful EAAD6V Bridge Token export).
    assert.ok(!/isPostRoleToken\(String\(existing\?\.access_token/.test(fn),
        'the upsert primary must NOT be gated behind isPostRoleToken (that blanks a fresh EAAD6V Lite token)')
    // The fresh token is now made authoritative via the pure, unit-tested helper.
    assert.ok(/prioritizeSyncedPageTokenPools\(\{/.test(fn),
        'upsert must delegate token ordering to prioritizeSyncedPageTokenPools (fresh token leads pool + primary)')
    // The fresh token becomes post_tokens[0]…
    assert.ok(/const nextPostTokens = prioritized\.postTokens/.test(fn),
        'fresh token leads post_tokens via the prioritization helper (becomes post_tokens[0])')
    // …and pages.access_token (the primary the posting resolver reads) is the prioritized primary…
    assert.ok(/const nextPrimaryToken = prioritized\.primaryToken/.test(fn),
        'pages.access_token primary must be the prioritized primary (the fresh token)')
    assert.ok(/UPDATE pages SET access_token = \?/.test(fn),
        'the fresh primary must be written back to pages.access_token')
})

test('profile-sync stages a NEW row inactive only for the Facebook Lite bulk import, default stays active', () => {
    const src = readVideoAffiliateIndex()

    // ── Route: parses the optional staging flag and forwards it to the upsert ──────────────────
    const routeStart = src.indexOf("app.post('/api/pages/profile-sync'")
    assert.notEqual(routeStart, -1, 'profile-sync route must exist')
    const route = src.slice(routeStart, src.indexOf("app.post('/api/pages/profile-token-health'", routeStart))
    // import_mode marker OR an explicit is_active:0/false/'0' stages the new row inactive.
    assert.ok(/importMode === 'facebook_lite_bridge_import'/.test(route), 'import_mode marker must trigger inactive staging')
    assert.ok(/rawInitialActive === 0 \|\| rawInitialActive === false \|\| rawInitialActive === '0'/.test(route),
        'an explicit is_active:0/false/"0" must trigger inactive staging')
    // Default is ACTIVE (1) — every normal sync/export/refresh omits these fields.
    assert.ok(/const initialIsActive = stageInactive \? 0 : 1/.test(route), 'default must remain active (1)')
    assert.ok(/initialIsActive,/.test(route), 'route must forward initialIsActive to the upsert')

    // ── Upsert: applies initialIsActive to the INSERT only, never to UPDATE/move ───────────────
    const upStart = src.indexOf('async function upsertNamespacePageFromProfileSync')
    assert.notEqual(upStart, -1, 'upsertNamespacePageFromProfileSync must exist')
    const fn = src.slice(upStart, src.indexOf('function uniqueTokens', upStart))
    // The param exists and only 0 stages inactive (anything else, incl. undefined, defaults to 1).
    assert.ok(/initialIsActive\?: number/.test(fn), 'upsert must accept an optional initialIsActive param')
    assert.ok(/const initialIsActive = params\.initialIsActive === 0 \? 0 : 1/.test(fn),
        'only an explicit 0 stages inactive; default stays active (1)')
    // The INSERT (NEW row) binds initialIsActive in the is_active column...
    assert.ok(/INSERT INTO pages \(id, name, image_url, access_token, post_interval_minutes, post_hours, is_active, bot_id\)/.test(fn),
        'INSERT must include is_active')
    assert.ok(/generateRandomPostHours\(\), initialIsActive, namespaceId\)\.run\(\)/.test(fn),
        'the NEW-row INSERT must bind initialIsActive (not a hardcoded 1)')
    // ...while neither the UPDATE nor the move touches is_active (existing rows keep their state).
    assert.ok(!/UPDATE pages SET[^\n]*is_active/.test(fn), 'no UPDATE/move statement may change is_active')
})

test('staging import (facebook_lite_bridge_import / initialIsActive=0) NEVER moves a page owned by another namespace — it skips with a structured conflict', () => {
    const src = readVideoAffiliateIndex()
    const upStart = src.indexOf('async function upsertNamespacePageFromProfileSync')
    assert.notEqual(upStart, -1, 'upsertNamespacePageFromProfileSync must exist')
    const fn = src.slice(upStart, src.indexOf('function uniqueTokens', upStart))

    // ── The staging-import signal is derived from import_mode OR the inactive-staging flag ───────
    assert.ok(/importMode\?: string/.test(fn), 'upsert must accept an optional importMode param')
    assert.ok(/const isStagingImport = importMode === 'facebook_lite_bridge_import' \|\| initialIsActive === 0/.test(fn),
        'staging import must be gated on import_mode OR initialIsActive=0')

    // ── The cross-namespace branch must SKIP (not move) when staging, returning a conflict ───────
    // Isolate the "exists in another namespace" branch body.
    const branchIdx = fn.indexOf("existingInOtherNamespace?.bot_id && String(existingInOtherNamespace.bot_id")
    assert.notEqual(branchIdx, -1, 'the cross-namespace branch must exist')
    const branch = fn.slice(branchIdx, fn.indexOf('} else {', branchIdx))
    // The staging guard short-circuits BEFORE the bot_id-moving UPDATE.
    const guardIdx = branch.indexOf('if (isStagingImport)')
    const moveIdx = branch.indexOf('UPDATE pages SET bot_id = ?')
    assert.ok(guardIdx !== -1, 'the cross-namespace branch must check isStagingImport')
    assert.ok(moveIdx !== -1, 'the cross-namespace branch must still contain the legacy move UPDATE')
    assert.ok(guardIdx < moveIdx, 'the staging-import skip must come BEFORE the move UPDATE (so it never relocates the row)')
    // The staging path returns skipped + the owning namespace, and does NOT run the move/pool write.
    assert.ok(/skipped = true/.test(branch), 'staging skip must set skipped = true')
    assert.ok(/conflictNamespaceId = otherNamespaceId/.test(branch), 'staging skip must record the owning namespace as the conflict')
    assert.ok(/return \{ created, updated, moved, skipped, conflictNamespaceId \}/.test(branch),
        'staging skip must early-return BEFORE touching the row or the token pool')

    // ── The return type carries skipped/conflict so callers can count them ───────────────────────
    assert.ok(/skipped: boolean/.test(fn), 'the upsert result type must include skipped')
    assert.ok(/conflictNamespaceId\?: string/.test(fn), 'the upsert result type must include the conflict namespace id')

    // ── Normal (non-staging) export still moves: the move UPDATE remains reachable for the else ──
    // The move must NOT have been deleted — only guarded.
    assert.ok(/moved = true/.test(branch), 'a non-staging cross-namespace sync (e.g. /token/export) must still move the row')

    // ── The route forwards import_mode to the upsert ─────────────────────────────────────────────
    const routeStart = src.indexOf("app.post('/api/pages/profile-sync'")
    const route = src.slice(routeStart, src.indexOf("app.post('/api/pages/profile-token-health'", routeStart))
    assert.ok(/\bimportMode,/.test(route), 'the profile-sync route must forward importMode to the upsert')
    // The response surfaces skipped + a snake_case conflict alias for the importer.
    assert.ok(/skipped: result\.skipped/.test(route), 'the route response must surface skipped')
    assert.ok(/conflict_namespace_id: result\.conflictNamespaceId \|\| null/.test(route),
        'the route response must surface a snake_case conflict_namespace_id for the importer')
})

test('all three stored-token publish sites use the auto-refresh wrapper', () => {
    const src = readVideoAffiliateIndex()
    // Retry awaits the wrapper directly; force-post + cron reference it via the
    // publishStoredFacebookLiteReel closure (`() => publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh(`).
    const calls = (src.match(/(?:await |=> )publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh\(/g) || []).length
    assert.ok(calls >= 3, `force/retry/cron stored-token publishes must use the refresh wrapper (found ${calls})`)
    // Each call site supplies a reloadTokens closure that re-reads the fresh pool.
    const reloadSites = (src.match(/reloadTokens: async \(\) => \{/g) || []).length
    assert.ok(reloadSites >= 3, `each publish site must pass a reloadTokens closure (found ${reloadSites})`)
})

test('onecard_enabled pages fall back to the organic EAAD6V reel when the ad-account OneCard publish fails (not Power Editor)', () => {
    const src = readVideoAffiliateIndex()
    // Both force-post and cron wrap the OneCard publish in try/catch and fall back to the SAME
    // organic Facebook Lite reel closure (publishStoredFacebookLiteReel) used by the stored_token
    // default path — never burning the row on an ad-permission denial.
    const oneCardCalls = (src.match(/await publishVideoViaOneCard\(/g) || []).length
    assert.ok(oneCardCalls >= 2, `force-post + cron must both dispatch OneCard (found ${oneCardCalls})`)
    const fallbackClosures = (src.match(/const publishStoredFacebookLiteReel = \(\) =>/g) || []).length
    assert.ok(fallbackClosures >= 2, `force-post + cron must define the organic EAAD6V fallback closure (found ${fallbackClosures})`)
    // The fallback is gated by the pure, tested predicate (no stored token → still fails closed).
    const gatedFallbacks = (src.match(/shouldFallbackToOrganicAfterOneCardFailure\(\{ haveStoredPostToken/g) || []).length
    assert.ok(gatedFallbacks >= 2, `OneCard catch must gate the organic fallback on a stored token (found ${gatedFallbacks})`)
    // Each catch invokes the organic reel fallback (never re-invokes the ad-account OneCard path).
    const fallbackInvocations = (src.match(/reelResult = await publishStoredFacebookLiteReel\(\)/g) || []).length
    assert.ok(fallbackInvocations >= 4, `each site uses the organic fallback as both default + OneCard-failure path (found ${fallbackInvocations})`)
})

test('EAAD6V tokens NEVER enter the OneCard/ad-account lane — OneCard is skipped up front for Facebook Lite tokens', () => {
    const src = readVideoAffiliateIndex()
    // Both force-post and cron gate the OneCard branch on a non-Lite primary token, so an EAAD6V page
    // (even with onecard_enabled=1) goes straight to the organic /{page}/videos lane — never advideos.
    const guarded = (src.match(/const useOneCardForThisPost = pageOneCardEnabled && !isFacebookLitePageToken\(primaryPostingTokenCandidates\[0\]/g) || []).length
    assert.ok(guarded >= 2, `force-post + cron must skip OneCard for EAAD6V tokens (found ${guarded})`)
    // The OneCard dispatch is gated by that flag (not the bare pageOneCardEnabled) at both sites.
    const dispatchGated = (src.match(/if \(useOneCardForThisPost\) \{/g) || []).length
    assert.ok(dispatchGated >= 2, `both publish sites must dispatch OneCard via useOneCardForThisPost (found ${dispatchGated})`)
})

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATIC bridge /token/auto-sync recovery (no operator button / manual sync).
// When a stored/Facebook Lite token is invalidated, the Worker itself POSTs the
// bridge's secret-authed /token/auto-sync, reloads the pool and retries ONCE.
// (index.ts read as source; not importable under node:test.)
// ─────────────────────────────────────────────────────────────────────────────

test('triggerBridgeAutoSyncForPage: secret-authed machine-to-machine call to the bridge /token/auto-sync, fails closed, token-free, backed off', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function triggerBridgeAutoSyncForPage')
    assert.notEqual(start, -1, 'triggerBridgeAutoSyncForPage must exist')
    const fn = src.slice(start, src.indexOf('async function refreshFacebookLitePostingTokenForPage', start))
    // Resolves the bridge base URL from configured env (CLOAK_FB_BRIDGE_URL) and the shared secret.
    assert.ok(fn.includes('resolveCloakFbBridgeBaseUrl(params.env)'), 'must resolve the bridge base url from env')
    assert.ok(fn.includes('getBridgeTokenSyncSecret(params.env)'), 'must resolve the shared bridge sync secret from env')
    // Fail closed (no recovery marked) when the bridge URL or secret is missing.
    assert.ok(/return \{ ok: false, synced: false, reason: 'bridge_not_configured' \}/.test(fn), 'must fail closed when the bridge url is missing')
    assert.ok(/return \{ ok: false, synced: false, reason: 'sync_secret_missing' \}/.test(fn), 'must fail closed when the secret is missing')
    // Sends the secret as a machine-to-machine header (NOT a UI/local-only path).
    assert.ok(fn.includes("'x-bridge-sync-secret': secret") || fn.includes('x-bridge-sync-secret'), 'must send the bridge sync secret header')
    // Uses the pure helpers to build the URL/body and parse the response.
    assert.ok(fn.includes('buildBridgeAutoSyncUrl('), 'must build the auto-sync url via the pure helper')
    assert.ok(fn.includes('buildBridgeAutoSyncRequestBody('), 'must build the request body via the pure helper')
    assert.ok(fn.includes('parseBridgeAutoSyncResponse('), 'must parse the response via the pure helper')
    // Page-targeted account fallback (Chanalai → Thanwan): the body carries the failing page id and a
    // resolved fallback-account chain (per-call hint merged with the env-configured mapping).
    assert.ok(fn.includes('resolveBridgeFallbackAccounts('), 'must resolve the fallback-account chain (env + per-call hint)')
    assert.ok(fn.includes('pageId: params.pageId'), 'must scope the recovery to the failing page id')
    assert.ok(fn.includes('fallbackAccounts'), 'must pass the resolved fallback accounts to the bridge')
    // Rate-limit backoff: one live trigger per namespace per TTL window (anti Facebook login spam).
    assert.ok(fn.includes('isBridgeAutoSyncAllowed('), 'must gate on the backoff predicate')
    assert.ok(fn.includes('bridgeAutoSyncLastAttemptByNamespace'), 'must track the per-namespace last attempt for backoff')
    assert.ok(/reason: 'auto_sync_throttled'/.test(fn), 'a throttled trigger must report a distinct reason and skip')
    // Token-free: dryRun is never true (would resolve no token) and no token is ever interpolated in logs.
    const logLines = fn.split('\n').filter((l) => /console\.(log|warn|error)/.test(l))
    assert.ok(logLines.every((l) => !/token=\$\{|accessToken|\.token\}/.test(l)), 'auto-sync logs must never interpolate a token value')
})

test('refreshFacebookLitePostingTokenForPage falls through to the bridge auto-sync as the final automatic tier', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function refreshFacebookLitePostingTokenForPage')
    assert.notEqual(start, -1, 'refreshFacebookLitePostingTokenForPage must exist')
    const fn = src.slice(start, src.indexOf('async function initReelUploadWithPostingTokenAutoRecover', start))
    // Tier 3: after BrowserSaving (tier 1) and Bridge /pages (tier 2), the bridge true-recovery runs.
    assert.ok(fn.includes('triggerBridgeAutoSyncForPage('), 'must call the bridge auto-sync as the last tier')
    assert.ok(/if \(autoSync\.synced\)/.test(fn), 'must only mark recovered when the auto-sync actually synced a token')
    assert.ok(fn.includes("via: 'bridge_auto_sync'"), 'the auto-sync success path is labeled')
    // The last tier is page-targeted with the env-resolved fallback chain so a dead primary account
    // (Chanalai) hands off to a configured fallback (Thanwan) that still administers the page.
    assert.ok(fn.includes('pageId: params.pageId'), 'auto-sync tier must scope to the failing page id')
    assert.ok(fn.includes('resolveFacebookLiteFallbackAccounts('), 'auto-sync tier must pass the env-resolved fallback accounts')
    // Ordering: BrowserSaving → Bridge /pages → auto-sync.
    const bsIdx = fn.indexOf('refreshFacebookLiteCommentTokenForPage(')
    const pagesIdx = fn.indexOf('fetchFacebookLitePageTokenFromBridge(')
    const autoIdx = fn.indexOf('triggerBridgeAutoSyncForPage(')
    assert.ok(bsIdx >= 0 && pagesIdx > bsIdx && autoIdx > pagesIdx, 'auto-sync must be the LAST recovery tier')
})

test('publish wrapper reaches the auto-sync (via the refresh helper) ONLY on an auth failure, never on a (#10) permission error', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh')
    const fn = src.slice(start, src.indexOf('type PageOneCardLinkMode', start))
    // The refresh helper (which contains the auto-sync tier) is invoked on the auth-failure path.
    const refreshIdx = fn.indexOf('refreshFacebookLitePostingTokenForPage(')
    assert.ok(refreshIdx >= 0, 'the wrapper must call the refresh helper (which triggers auto-sync)')
    // A permission-denied-without-auth-failure path throws BEFORE the refresh helper, so a (#10) error
    // can never drive a token re-mint / auto-sync loop.
    const permThrowIdx = fn.indexOf('facebook_lite_permission_denied_no_bridge_account:')
    assert.ok(permThrowIdx >= 0 && permThrowIdx < refreshIdx, 'a permission-only error must throw before reaching the refresh/auto-sync helper')
    // The refresh helper itself is gated by the auth-only predicate (no permission match).
    assert.ok(fn.includes('shouldAttemptFacebookLitePostingRefresh('), 'refresh/auto-sync must be gated by the auth-only predicate')
    // Single bounded retry after a successful refresh.
    assert.ok(/if \(!refresh\.synced\)/.test(fn), 'must only retry when a fresh token was synced')
    assert.ok(fn.includes('POST-REFRESH-RETRY'), 'the retry must be a single labeled re-publish')
})

test('pending-comment backlog: bridge auto-sync runs when BrowserSaving cannot re-mint, then reloads the fresh token (still one-shot, gated, no permission loop)', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function processPendingCommentBacklog')
    const fn = src.slice(start, src.indexOf('async function ensureCronRuntimeStateTable', start))
    // The reload closure tries the bridge auto-sync as a fallback when BrowserSaving did not refresh.
    assert.ok(fn.includes('triggerBridgeAutoSyncForPage('), 'comment backlog must trigger the bridge auto-sync fallback')
    assert.ok(/if \(!autoSync\.synced\) return false/.test(fn), 'must only continue when the auto-sync synced a fresh token')
    // It then re-reads the fresh token from the pool (never trusts the stale row).
    assert.ok(fn.includes('resolveFacebookCommentToken(env.DB, pageId, botId)'), 'must reload the fresh token from the pool')
    // Still bounded to one attempt and gated by the auth/missing predicate (permission never matches).
    assert.ok(/if \(fbLiteRefreshAttempted\) return false/.test(fn), 'refresh+auto-sync must remain one-shot per row')
    assert.ok(fn.includes('shouldAttemptFacebookLiteRefresh'), 'must stay gated by the auth/missing refresh predicate')
})
