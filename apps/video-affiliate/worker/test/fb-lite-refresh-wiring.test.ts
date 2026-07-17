import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// These tests assert the cross-worker FB GET Token / Facebook Lite refresh WIRING by reading
// the worker source (index.ts modules cannot be imported under plain node:test because they
// pull in the full Cloudflare runtime). The legacy BrowserSaving/8820 re-mint is REMOVED:
// a stale Facebook Lite token now fails closed with idlogin_relogin_required — minting lives
// ONLY in the IDLogin/IDBridge stack, and the Worker consumes it via profile-sync.

function readVideoAffiliateIndex(): string {
    return readFileSync('src/index.ts', 'utf8')
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

test('BrowserSaving FB Lite mint helper is REMOVED — no 8820/BrowserSaving Facebook Lite mint call remains', () => {
    const src = readVideoAffiliateIndex()
    // The BrowserSaving mint POST helper is gone entirely; minting moved to the IDLogin/IDBridge stack.
    assert.equal(src.indexOf('async function postFacebookLiteRefresh'), -1, 'postFacebookLiteRefresh must be removed')
    assert.ok(!src.includes("'/api/fb-lite/refresh-comment-token'"), 'no BrowserSaving FB Lite mint route call may remain')
    // refreshFacebookLiteCommentTokenForPage is now a fail-closed stub.
    const start = src.indexOf('async function refreshFacebookLiteCommentTokenForPage')
    const fn = src.slice(start, src.indexOf('async function probeFacebookLiteProfilesForPage', start))
    assert.ok(fn.includes("reason: 'idlogin_relogin_required'"), 'refresh helper must fail closed with idlogin_relogin_required')
    assert.ok(!fn.includes('fetchFromBrowserSavingBase'), 'refresh helper must not call BrowserSaving')
})

test('refreshFacebookLiteCommentTokenForPage no longer mints/auto-discovers — fails closed', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function refreshFacebookLiteCommentTokenForPage')
    const fn = src.slice(start, src.indexOf('async function probeFacebookLiteProfilesForPage', start))
    assert.ok(fn.includes("return { refreshed: false, synced: false, profileCount: 0, reason: 'idlogin_relogin_required' }"), 'must fail closed')
    assert.ok(!fn.includes('buildFacebookLiteRefreshRequestBody'), 'no BrowserSaving refresh request may be built')
    assert.ok(!fn.includes('postFacebookLiteRefresh'), 'no BrowserSaving mint may be invoked')
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

test('publish wrapper fails closed on a stored-token auth failure — no re-mint, no retry (idlogin_relogin_required)', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh')
    assert.notEqual(start, -1, 'the stored-token publish wrapper must exist')
    const fn = src.slice(start, src.indexOf('type PageOneCardLinkMode', start))
    // Happy path still delegates to the existing publish chain.
    assert.ok(fn.includes('await publishReelWithCommentTokenPrimaryFallback('), 'must call the existing publish fallback chain')
    // Auth failure is still classified, but there is NO re-mint / auto-sync / reload+retry.
    assert.ok(fn.includes('shouldAttemptFacebookLitePostingRefresh('), 'auth failure is still classified')
    assert.ok(!fn.includes('refreshFacebookLitePostingTokenForPage('), 'must NOT call the posting-token re-mint')
    assert.ok(!fn.includes('params.reloadTokens()'), 'must NOT reload + retry after a re-mint')
    assert.ok(!fn.includes('POST-REFRESH-RETRY'), 'no re-mint retry may remain')
    assert.ok(fn.includes('idlogin_relogin_required:'), 'an auth/invalidation failure surfaces idlogin_relogin_required')
    assert.ok(/throw publishErr/.test(fn), 'a non-auth failure rethrows the original error')
})

test('publish wrapper does NOT fall back to the CloakBrowser bridge organic /post for a Facebook Lite page', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh')
    const fn = src.slice(start, src.indexOf('type PageOneCardLinkMode', start))
    // The bridge organic /post fallback is gone entirely from the wrapper.
    assert.ok(!fn.includes('publishReelViaSessionBridge('), 'no CloakBrowser bridge organic /post fallback may remain')
    assert.ok(!fn.includes('publishOrganicViaFacebookLiteBridge('), 'the FB Lite bridge organic helper is not called')
    // A (#10) permission or auth failure fails closed with idlogin_relogin_required.
    assert.ok(fn.includes('isFacebookLitePostingPermissionError('), 'permission errors are still classified')
    assert.ok(fn.includes('idlogin_relogin_required:'), 'permission/auth failure fails closed to idlogin_relogin_required')
})

test('EAAD6V token publishes via direct /{page}/videos (is_reel OFF) as the ONLY path — no bridge organic secondary', () => {
    const src = readVideoAffiliateIndex()
    const wrapStart = src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh')
    const wrapFn = src.slice(wrapStart, src.indexOf('type PageOneCardLinkMode', wrapStart))
    // Detect the Facebook Lite (EAAD6V) post token up front (PRESERVED).
    assert.ok(/isFacebookLitePageToken\(litePostTokens\[0\]/.test(wrapFn), 'must detect a Facebook Lite (EAAD6V) post token up front')
    // PRIMARY (and only) publish: Worker-direct /{page}/videos multipart with is_reel:false.
    assert.ok(wrapFn.includes('publishReelViaVideosEndpointWithTokenFallback('), 'EAAD6V lane publishes via the direct /videos endpoint helper')
    assert.ok(/isReel: false/.test(wrapFn), 'the EAAD6V /videos publish must OMIT is_reel (is_reel: false)')
    // The bridge organic /post secondary is GONE — a direct failure fails closed.
    assert.ok(!wrapFn.includes('publishOrganicViaFacebookLiteBridge('), 'no bridge organic /post secondary may remain')
    assert.ok(!/reason: 'eaad6_videos_direct_failed'/.test(wrapFn), 'the removed bridge secondary marker must be gone')
    assert.ok(wrapFn.includes('idlogin_relogin_required: Facebook Lite direct /videos publish failed'), 'a direct /videos failure fails closed to idlogin_relogin_required')

    // publishReelDirect still omits is_reel when isReel===false (unchanged).
    const directStart = src.indexOf('async function publishReelDirect(')
    const directFn = src.slice(directStart, src.indexOf('async function applyPreferredVideoThumbnail', directStart))
    assert.ok(/if \(params\.isReel !== false\) formData\.append\('is_reel', 'true'\)/.test(directFn), 'is_reel is appended only when not explicitly disabled')

    // The removed bridge organic helper is gone entirely.
    assert.equal(src.indexOf('async function publishOrganicViaFacebookLiteBridge'), -1, 'publishOrganicViaFacebookLiteBridge must be removed')
})

test('refreshFacebookLitePostingTokenForPage is a fail-closed stub — no BrowserSaving mint, no Bridge /pages, no auto-sync', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function refreshFacebookLitePostingTokenForPage')
    assert.notEqual(start, -1, 'refreshFacebookLitePostingTokenForPage must exist (fail-closed stub)')
    const fn = src.slice(start, src.indexOf('async function initReelUploadWithPostingTokenAutoRecover', start))
    assert.ok(fn.includes("return { refreshed: false, synced: false, via: 'none', reason: 'idlogin_relogin_required' }"), 'must fail closed')
    assert.ok(!fn.includes('refreshFacebookLiteCommentTokenForPage('), 'no BrowserSaving mint tier may remain')
    assert.ok(!fn.includes('upsertNamespacePageFromProfileSync('), 'no Bridge /pages token upsert tier may remain')
    assert.ok(!fn.includes('triggerBridgeAutoSyncForPage('), 'no auto-sync tier may remain')
})

test('fetchFacebookLitePageTokenFromBridge is a stub — no 8820 /pages token fetch', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function fetchFacebookLitePageTokenFromBridge')
    assert.notEqual(start, -1, 'fetchFacebookLitePageTokenFromBridge must exist (stub)')
    const fn = src.slice(start, src.indexOf('async function refreshFacebookLitePostingTokenForPage', start))
    assert.ok(fn.includes("return { token: '', account: '' }"), 'must return no token (no 8820 contact)')
    assert.ok(!fn.includes('buildBridgeTokenPagesUrl('), 'no /pages lookup url may be built')
    assert.ok(!fn.includes('extractBridgeTokenPageAccessToken('), 'no page token extraction may remain')
    assert.ok(!fn.includes('fetchWithTimeout('), 'no bridge fetch may remain')
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

test('triggerBridgeAutoSyncForPage is a fail-closed stub — no bridge /token/auto-sync POST', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function triggerBridgeAutoSyncForPage')
    assert.notEqual(start, -1, 'triggerBridgeAutoSyncForPage must exist (stub)')
    const fn = src.slice(start, src.indexOf('async function refreshFacebookLitePostingTokenForPage', start))
    assert.ok(fn.includes("return { ok: false, synced: false, reason: 'idlogin_relogin_required' }"), 'must fail closed')
    assert.ok(!fn.includes('buildBridgeAutoSyncUrl('), 'no auto-sync url may be built')
    assert.ok(!fn.includes('buildBridgeAutoSyncRequestBody('), 'no auto-sync request may be built')
    assert.ok(!fn.includes('x-bridge-sync-secret'), 'no machine-to-machine auto-sync call may remain')
    assert.ok(!fn.includes('fetchWithTimeout('), 'no bridge fetch may remain')
})

test('refreshFacebookLitePostingTokenForPage has NO recovery tiers (BrowserSaving / Bridge /pages / auto-sync all removed)', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function refreshFacebookLitePostingTokenForPage')
    const fn = src.slice(start, src.indexOf('async function initReelUploadWithPostingTokenAutoRecover', start))
    assert.ok(!fn.includes('triggerBridgeAutoSyncForPage('), 'no auto-sync tier may remain')
    assert.ok(!fn.includes("via: 'bridge_auto_sync'"), 'no auto-sync success label may remain')
    assert.ok(!fn.includes("via: 'browsersaving'"), 'no BrowserSaving success label may remain')
    assert.ok(!fn.includes("via: 'bridge_token_pages'"), 'no Bridge /pages success label may remain')
    assert.ok(fn.includes("reason: 'idlogin_relogin_required'"), 'the stub fails closed to idlogin_relogin_required')
})

test('publish wrapper never triggers a re-mint / auto-sync — an auth failure fails closed', () => {
    const src = readVideoAffiliateIndex()
    const start = src.indexOf('async function publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh')
    const fn = src.slice(start, src.indexOf('type PageOneCardLinkMode', start))
    assert.ok(!fn.includes('refreshFacebookLitePostingTokenForPage('), 'the wrapper must not call the (removed) re-mint helper')
    assert.ok(fn.includes('shouldAttemptFacebookLitePostingRefresh('), 'auth failure is still classified (to fail closed)')
    assert.ok(fn.includes('idlogin_relogin_required:'), 'an auth failure surfaces idlogin_relogin_required')
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
