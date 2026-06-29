import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function getSyncTaggedPagesFromProfileMetadataSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function syncTaggedPagesFromProfileMetadata')
    assert.notEqual(start, -1, 'syncTaggedPagesFromProfileMetadata must exist')

    const end = source.indexOf('\nfunction extractProfileIdsFromTagAmbiguousError', start)
    assert.notEqual(end, -1, 'syncTaggedPagesFromProfileMetadata end marker must exist')

    return source.slice(start, end)
}

function getHandleScheduledSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function handleScheduled')
    assert.notEqual(start, -1, 'handleScheduled must exist')

    const end = source.indexOf('\n// Container class', start)
    assert.notEqual(end, -1, 'handleScheduled end marker must exist')

    return source.slice(start, end)
}

function getPagePostingOrderResolverSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function resolveEffectivePagePostingOrder')
    assert.notEqual(start, -1, 'resolveEffectivePagePostingOrder must exist')

    const end = source.indexOf('\nfunction normalizeShortlinkBaseUrl', start)
    assert.notEqual(end, -1, 'resolveEffectivePagePostingOrder end marker must exist')

    return source.slice(start, end)
}

function getPagePostingOrderSettingsRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.get('/api/pages/:id/posting-order-settings'")
    assert.notEqual(start, -1, 'GET /api/pages/:id/posting-order-settings route must exist')

    const end = source.indexOf("\napp.get('/api/pages/:id/shortlink-settings'", start)
    assert.notEqual(end, -1, 'posting order settings route block end marker must exist')

    return source.slice(start, end)
}

function getEnsurePagesOneCardColumnsSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function ensurePagesOneCardColumns')
    assert.notEqual(start, -1, 'ensurePagesOneCardColumns must exist')

    const end = source.indexOf('\nasync function publishVideoViaOneCard', start)
    assert.notEqual(end, -1, 'ensurePagesOneCardColumns end marker must exist')

    return source.slice(start, end)
}

function getNormalizePagePostingTokenSourceSource(): string {
    // The normalizer + routing decisions now live in the standalone, unit-tested
    // posting-token-source module (imported by index.ts).
    const source = readFileSync('src/posting-token-source.ts', 'utf8')
    const start = source.indexOf('export function normalizePagePostingTokenSource')
    assert.notEqual(start, -1, 'normalizePagePostingTokenSource must exist')

    const end = source.indexOf('\nexport function resolvePostingRoute', start)
    assert.notEqual(end, -1, 'normalizePagePostingTokenSource end marker must exist')

    return source.slice(start, end)
}

function getPagePutRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.put('/api/pages/:id'")
    assert.notEqual(start, -1, 'PUT /api/pages/:id route must exist')

    const end = source.indexOf("\napp.delete('/api/pages/:id'", start)
    assert.notEqual(end, -1, 'PUT /api/pages/:id route end marker must exist')

    return source.slice(start, end)
}

function getDashboardCreateAdRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.post('/api/dashboard/create-ad'")
    assert.notEqual(start, -1, 'POST /api/dashboard/create-ad route must exist')

    const end = source.indexOf("\napp.get('/api/dashboard/ad-links'", start)
    assert.notEqual(end, -1, 'create-ad route end marker must exist')

    return source.slice(start, end)
}

function getForcePostRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.post('/api/pages/:id/force-post'")
    assert.notEqual(start, -1, 'force-post route must exist')

    const end = source.indexOf('\n// ==================== MANUAL REEL POST', start)
    assert.notEqual(end, -1, 'force-post route end marker must exist')

    return source.slice(start, end)
}

function getRetryPostRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.post('/api/post-history/:id/retry-post'")
    assert.notEqual(start, -1, 'retry-post route must exist')

    const end = source.indexOf("\napp.get('/api/pages/:id/history'", start)
    assert.notEqual(end, -1, 'retry-post route end marker must exist')

    return source.slice(start, end)
}

function getListFacebookPageVideoCacheSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function listFacebookPageVideoCache')
    assert.notEqual(start, -1, 'listFacebookPageVideoCache must exist')

    const end = source.indexOf('\nasync function countFacebookPageVideoCache', start)
    assert.notEqual(end, -1, 'listFacebookPageVideoCache end marker must exist')

    return source.slice(start, end)
}

function getFacebookPageVideosRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.get('/api/dashboard/facebook-page-videos'")
    assert.notEqual(start, -1, 'GET /api/dashboard/facebook-page-videos route must exist')

    const end = source.indexOf('\napp.', start + 1)
    assert.notEqual(end, -1, 'facebook-page-videos route end marker must exist')

    return source.slice(start, end)
}

function getBackfillFromFacebookRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.post('/api/dashboard/facebook-page-videos/backfill-from-facebook'")
    assert.notEqual(start, -1, 'POST backfill-from-facebook route must exist')

    const end = source.indexOf("\napp.post('/api/dashboard/facebook-page-videos/backfill-shopee-links'", start)
    assert.notEqual(end, -1, 'backfill-from-facebook route end marker must exist')

    return source.slice(start, end)
}

function getPrePostingShortlinkResolverSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function resolvePrePostingShortlinksForNamespace')
    assert.notEqual(start, -1, 'resolvePrePostingShortlinksForNamespace must exist')

    const end = source.indexOf('\nasync function resolvePostingShopeeLinkForNamespace', start)
    assert.notEqual(end, -1, 'pre-posting shortlink resolver end marker must exist')

    return source.slice(start, end)
}

function getShortenShopeeLinkForNamespaceSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function shortenShopeeLinkForNamespace')
    assert.notEqual(start, -1, 'shortenShopeeLinkForNamespace must exist')

    const end = source.indexOf('\nfunction isManagedShortlinkTransientFailure', start)
    assert.notEqual(end, -1, 'shortenShopeeLinkForNamespace end marker must exist')

    return source.slice(start, end)
}

function getPostingCommentShortlinkSubIdsSource(): string {
    // The pure post-id/page-id Sub ID derivation lives in shortlink-template.ts so it can
    // be unit-tested without the Cloudflare runtime (see shortlink-template.test.ts).
    const source = readFileSync('src/shortlink-template.ts', 'utf8')
    const start = source.indexOf('export function buildPostingCommentShortlinkSubIds')
    assert.notEqual(start, -1, 'buildPostingCommentShortlinkSubIds must exist')

    // It is the last export in shortlink-template.ts, so read through end of file.
    return source.slice(start)
}

function getPostingShopeeLinkResolverSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function resolvePostingShopeeLinkForNamespace')
    assert.notEqual(start, -1, 'resolvePostingShopeeLinkForNamespace must exist')

    const end = source.indexOf('\nasync function isNamespaceAffiliateVerificationEnforced', start)
    assert.notEqual(end, -1, 'resolvePostingShopeeLinkForNamespace end marker must exist')

    return source.slice(start, end)
}

function getPendingCommentBacklogSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function processPendingCommentBacklog')
    assert.notEqual(start, -1, 'processPendingCommentBacklog must exist')

    const end = source.indexOf('\nasync function handleScheduled', start)
    assert.notEqual(end, -1, 'processPendingCommentBacklog end marker must exist')

    return source.slice(start, end)
}

function getManualPostReelRouteSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf("app.post('/api/manual-post-reel'")
    assert.notEqual(start, -1, 'manual-post-reel route must exist')

    const end = source.indexOf('\n// ==================== SCHEDULED HANDLER', start)
    assert.notEqual(end, -1, 'manual-post-reel route end marker must exist')

    return source.slice(start, end)
}

test('facebook page video cache list applies bounded offset and oldest ordering', () => {
    const fnSource = getListFacebookPageVideoCacheSource()

    // Offset is bounded 0..10000 and bound as a parameter, not interpolated.
    assert.match(fnSource, /Math\.min\(10000,\s*Math\.max\(0,\s*Math\.floor\(offsetRaw\)\)\)/)
    assert.match(fnSource, /LIMIT \? OFFSET \?/)
    // oldest/asc flips only created_time direction; views DESC tiebreaker preserved.
    assert.match(fnSource, /createdTimeOrder = directionRaw === 'oldest' \|\| directionRaw === 'asc' \? 'ASC' : 'DESC'/)
    assert.match(fnSource, /ORDER BY created_time \$\{createdTimeOrder\}, views DESC/)
})

test('facebook page video cache list date filters are whitelisted and bound, not interpolated', () => {
    const fnSource = getListFacebookPageVideoCacheSource()

    // Date inputs are classified by strict whitelist (date-only + ISO prefix).
    assert.match(fnSource, /sanitizeFacebookPageVideoDateInput\(params\.fromDate\)/)
    assert.match(fnSource, /sanitizeFacebookPageVideoDateInput\(params\.toDate\)/)
    // from_date is an inclusive lower bound via lexical >=.
    assert.match(fnSource, /conditions\.push\('created_time >= \?'\)/)
    // date-only to_date becomes an exclusive next-day upper bound (inclusive day).
    assert.match(fnSource, /nextUtcDayFromDateOnly\(toInput\.value\)/)
    assert.match(fnSource, /conditions\.push\('created_time < \?'\)/)
    // ISO/prefix to_date uses a simple lexical <=.
    assert.match(fnSource, /conditions\.push\('created_time <= \?'\)/)
    // Values flow through bound params; no string interpolation of date input.
    assert.match(fnSource, /\.bind\(\.\.\.binds\)/)
    assert.doesNotMatch(fnSource, /created_time\s*[<>]=?\s*['"`]\$\{/)
})

test('facebook page video cache date sanitizer accepts date-only and ISO prefixes only', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('function sanitizeFacebookPageVideoDateInput')
    assert.notEqual(start, -1, 'sanitizeFacebookPageVideoDateInput must exist')
    const end = source.indexOf('\nfunction nextUtcDayFromDateOnly', start)
    assert.notEqual(end, -1, 'sanitizer end marker must exist')
    const fnSource = source.slice(start, end)

    assert.match(fnSource, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//)
    assert.match(fnSource, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\[T \]\[0-9:\.\+\\-Z\]\*\$\//)
    assert.match(fnSource, /return null/)
})

test('facebook-page-videos route wires date range, offset, order and echoes data_source', () => {
    const routeSource = getFacebookPageVideosRouteSource()

    assert.match(routeSource, /c\.req\.query\('from_date'\)/)
    assert.match(routeSource, /c\.req\.query\('to_date'\)/)
    assert.match(routeSource, /listFacebookPageVideoCache\(c\.env\.DB,\s*\{[^}]*fromDate[^}]*toDate[^}]*\}\)/)
    assert.match(routeSource, /data_source:\s*'facebook_page_video_cache'/)
    assert.match(routeSource, /from_date:\s*fromDate \|\| null/)
    assert.match(routeSource, /to_date:\s*toDate \|\| null/)
})

test('facebook-page-videos GET route is read-only and never persists sync state', () => {
    const routeSource = getFacebookPageVideosRouteSource()

    // No sync-state write call (a comment may mention the helper name, so we
    // only forbid an actual invocation with an argument list).
    assert.doesNotMatch(
        routeSource,
        /upsertFacebookPageVideoSyncState\s*\(/,
        'GET facebook-page-videos must not call upsertFacebookPageVideoSyncState',
    )
    // No DB write SQL of any kind inside this GET handler.
    assert.doesNotMatch(routeSource, /INSERT\s+INTO/i, 'GET facebook-page-videos must not INSERT')
    assert.doesNotMatch(routeSource, /\bUPDATE\s+\w/i, 'GET facebook-page-videos must not UPDATE')
    assert.doesNotMatch(routeSource, /DELETE\s+FROM/i, 'GET facebook-page-videos must not DELETE')
    // page_name response is still derived via the sync/query fallback.
    assert.match(routeSource, /page_name:\s*String\(sync\?\.page_name \|\| pageName \|\| ''\)\.trim\(\)/)
})


test('tagged page metadata sync never deletes pages rows when rebuilding', () => {
    const functionSource = getSyncTaggedPagesFromProfileMetadataSource()

    assert.doesNotMatch(
        functionSource,
        /DELETE\s+FROM\s+pages\b[\s\S]*tagged-%/i,
        'tagged/feed page sync must be non-destructive when BrowserSaving metadata is empty or partial',
    )
    assert.match(functionSource, /Tags no longer control page existence/)
})

test('cron organic Reel path composes enabled page avatar before Facebook publish', () => {
    const functionSource = getHandleScheduledSource()
    const composeAt = functionSource.indexOf('videoBuffer = await composeAvatarVideoForPosting({')
    const publishAt = functionSource.indexOf('publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh({')
    const errorCheckAt = functionSource.indexOf("const isAvatarComposeError = errorMsg.includes('avatar_compose_failed')")
    const recoveryGuardAt = functionSource.indexOf('if (!isAvatarComposeError) {', errorCheckAt)

    assert.ok(composeAt > -1, 'cron normal Reel path must call composeAvatarVideoForPosting')
    assert.ok(publishAt > -1, 'cron normal Reel path must publish through publishReelWithCommentTokenPrimaryFallback')
    assert.ok(composeAt < publishAt, 'avatar compose must happen before Facebook publish')
    assert.match(
        functionSource,
        /if \(!pageOneCardEnabled && !pageAdsPublishEnabled\) \{[\s\S]*const avatarSettings = await getPageAvatarSettings\(env\.DB, page\.id\)\.catch\(\(\) => null\)[\s\S]*avatarSettings\?\.enabled[\s\S]*avatar_video_key_missing[\s\S]*avatar_video_missing[\s\S]*avatar_url_invalid[\s\S]*composeAvatarVideoForPosting/,
        'avatar compose must be limited to the normal organic Reel branch and fail closed for missing/invalid avatar inputs',
    )
    assert.ok(errorCheckAt > -1, 'cron catch must classify avatar compose failures')
    assert.ok(recoveryGuardAt > errorCheckAt, 'cron recovery must be skipped for avatar compose failures')
})

test('avatar compose uses Worker-served page avatar video, not direct public R2 page-assets URL', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    const helperAt = source.indexOf('function buildAvatarObjectUrl')
    assert.ok(helperAt > -1, 'buildAvatarObjectUrl must exist')
    const helperEnd = source.indexOf('\nasync function composeAvatarVideoForPosting', helperAt)
    assert.ok(helperEnd > helperAt, 'buildAvatarObjectUrl end marker must exist')
    const helperSource = source.slice(helperAt, helperEnd)

    assert.match(helperSource, /\/api\/pages\/\$\{encodeURIComponent\(pageId\)\}\/avatar-video\/public/)
    assert.doesNotMatch(helperSource, /buildNamespaceObjectUrl\(env\.R2_PUBLIC_URL, namespaceId, avatarVideoKey\)/)
    assert.match(source, /app\.get\('\/api\/pages\/:id\/avatar-video\/public'/)
})

test('avatar compose polling keeps 5 minute headroom for 1080 jobs', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    const composeAt = source.indexOf('async function composeAvatarVideoForPosting')
    assert.ok(composeAt > -1, 'composeAvatarVideoForPosting must exist')
    const composeEnd = source.indexOf('\nfunction normalizeFacebookPageVideoCacheRow', composeAt)
    assert.ok(composeEnd > composeAt, 'composeAvatarVideoForPosting end marker must exist')
    const composeSource = source.slice(composeAt, composeEnd)

    assert.match(source, /const AVATAR_COMPOSE_MAX_WAIT_MS = 300_000/)
    assert.match(composeSource, /Date\.now\(\) \+ AVATAR_COMPOSE_MAX_WAIT_MS/)
    assert.match(composeSource, /\/avatar-compose\/start/)
    assert.match(composeSource, /\/avatar-compose\/result\/\$\{encodeURIComponent\(jobId\)\}/)
    assert.match(composeSource, /avatar_compose_failed: merge_job_timeout/)
})

test('force-post converts configured shortlinks before affiliate verification and records conversion trace', () => {
    const routeSource = getForcePostRouteSource()
    const conversionAt = routeSource.indexOf('resolvePrePostingShortlinksForNamespace({')
    const insertAt = routeSource.indexOf('INSERT INTO post_history')
    const verifyAt = routeSource.indexOf('verifyAffiliateLinksForPosting({')
    const publishAt = routeSource.indexOf('publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh({')

    assert.ok(conversionAt > -1, 'force-post must resolve pre-posting shortlinks')
    assert.ok(verifyAt > -1, 'force-post must verify affiliate links')
    assert.ok(publishAt > -1, 'force-post must publish to Facebook')
    assert.ok(conversionAt < verifyAt, 'force-post shortlink conversion must happen before affiliate verification')
    assert.ok(verifyAt < publishAt, 'force-post affiliate verification must happen before Facebook publish')
    assert.ok(insertAt > conversionAt, 'force-post history row should be inserted after conversion result is known')
    assert.match(routeSource, /pageId:\s*String\(page\.id \|\| ''\)/)
    assert.match(routeSource, /requireLazadaLink:\s*shortlinkResolution\.lazadaRequired/)
    assert.match(routeSource, /shortlink_conversion_status,\s*shortlink_conversion_error,\s*source_fingerprint/)
    assert.match(routeSource, /shortlinkResolution\.errorMessage[\s\S]*UPDATE post_history SET status = 'failed'[\s\S]*error:\s*'shortlink_failed'/)
})

test('retry-post re-converts old history links before affiliate verification and records conversion trace', () => {
    const routeSource = getRetryPostRouteSource()
    const conversionAt = routeSource.indexOf('resolvePrePostingShortlinksForNamespace({')
    const insertAt = routeSource.indexOf('INSERT INTO post_history')
    const verifyAt = routeSource.indexOf('verifyAffiliateLinksForPosting({')
    const publishAt = routeSource.indexOf('publishReelWithCommentTokenPrimaryFallbackAndLiteRefresh({')

    assert.ok(conversionAt > -1, 'retry-post must resolve pre-posting shortlinks')
    assert.ok(verifyAt > -1, 'retry-post must verify affiliate links')
    assert.ok(publishAt > -1, 'retry-post must publish to Facebook')
    assert.ok(conversionAt < verifyAt, 'retry-post shortlink conversion must happen before affiliate verification')
    assert.ok(verifyAt < publishAt, 'retry-post affiliate verification must happen before Facebook publish')
    assert.ok(insertAt > conversionAt, 'retry-post history row should be inserted after conversion result is known')
    assert.match(routeSource, /pageId:\s*String\(page\.id \|\| ''\)/)
    assert.match(routeSource, /requireLazadaLink:\s*shortlinkResolution\.lazadaRequired/)
    assert.match(routeSource, /shortlink_conversion_status,\s*shortlink_conversion_error,\s*source_fingerprint/)
    assert.match(routeSource, /shortlinkResolution\.errorMessage[\s\S]*UPDATE post_history SET status = 'failed'[\s\S]*error:\s*'shortlink_failed'/)
})

test('pre-posting shortlink resolver uses effective page settings and fails closed when required conversion fails', () => {
    const resolverSource = getPrePostingShortlinkResolverSource()

    assert.match(resolverSource, /isNamespaceShortlinkAdminManaged\(params\.env\.DB,\s*namespaceId\)/)
    assert.match(resolverSource, /isNamespaceAffiliateShortlinkRequired\(params\.env\.DB,\s*namespaceId\)/)
    assert.match(resolverSource, /shortenShopeeLinkForNamespace\(\{[\s\S]*pageId,[\s\S]*trace:\s*shopeeTrace/)
    assert.match(resolverSource, /shortenLazadaLinkForNamespace\(\{[\s\S]*pageId,[\s\S]*trace:\s*lazadaTrace/)
    assert.match(resolverSource, /const shopeeShortlinkFailed = !!rawShopeeLink && shopeeTrace\.status !== 'shortened' && shopeeTrace\.status !== 'disabled'/)
    assert.match(resolverSource, /const lazadaShortlinkFailed = lazadaRequired && lazadaTrace\.status !== 'shortened' && lazadaTrace\.status !== 'disabled'/)
    assert.match(resolverSource, /errorMessage = failedPlatforms[\s\S]*shortlink_failed:\$\{failedPlatforms\}/)
})

test('posting comment shortlink override intentionally omits sub4 and sub5', () => {
    const shortenerSource = getShortenShopeeLinkForNamespaceSource()
    const resolverSource = getPostingShopeeLinkResolverSource()
    const subIdSource = getPostingCommentShortlinkSubIdsSource()

    assert.match(shortenerSource, /postSubId4\?: string/)
    assert.match(shortenerSource, /hasPostSubId4Override = params\.postSubId4 !== undefined/)
    assert.match(shortenerSource, /effectiveSub4 = hasPostSubId4Override \? overriddenSub4 : subIds\.sub4/)
    assert.match(shortenerSource, /effectiveSub5 = hasPostSubId4Override \? '' : subIds\.sub5/)
    assert.match(shortenerSource, /if \(effectiveSub4\) requestUrl\.searchParams\.set\('sub4', effectiveSub4\)/)
    assert.match(shortenerSource, /if \(effectiveSub5\) requestUrl\.searchParams\.set\('sub5', effectiveSub5\)/)
    assert.match(resolverSource, /postSubId4\?: string/)
    assert.match(resolverSource, /postSubId4:\s*params\.postSubId4/)
    assert.match(subIdSource, /const postSubId4 = ''/)
    assert.doesNotMatch(subIdSource, /postSubId4\s*=\s*[^\n]*input\.historyId/)
})

test('pending comments keep post_history id internal when minting comment shortlink', () => {
    const pendingSource = getPendingCommentBacklogSource()
    const subIdSource = getPostingCommentShortlinkSubIdsSource()

    assert.match(pendingSource, /const historyId = Number\(row\.id \|\| 0\)/)
    assert.match(pendingSource, /buildPostingCommentShortlinkSubIds\(\{[\s\S]*historyId,[\s\S]*logPrefix: `PENDING-COMMENT/)
    assert.match(pendingSource, /resolvePostingShopeeLinkForNamespace\(\{[\s\S]*\.\.\.commentSubIds/)
    assert.match(subIdSource, /const postSubId4 = ''/)
})

test('force retry and manual posting responses expose log_id for comment-link audits', () => {
    const forceSource = getForcePostRouteSource()
    const retrySource = getRetryPostRouteSource()
    const manualSource = getManualPostReelRouteSource()

    assert.match(forceSource, /historyId:\s*forceHistoryId/)
    assert.match(forceSource, /log_id:\s*forceHistoryId/)
    assert.match(retrySource, /historyId:\s*retryHistoryId/)
    assert.match(retrySource, /log_id:\s*retryHistoryId/)
    assert.match(manualSource, /historyId:\s*manualHistoryId/)
    assert.match(manualSource, /log_id:\s*manualHistoryId/)
})

test('backfill-from-facebook stays POST, requires page_id, and defaults to dry run', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // Still a POST handler with page_id required (preserves old callers).
    assert.match(routeSource, /app\.post\('\/api\/dashboard\/facebook-page-videos\/backfill-from-facebook'/)
    assert.match(routeSource, /if \(!pageId\) return c\.json\(\{ ok: false, error: 'page_id_required' \}, 400\)/)
    // dry_run defaults to true: only an explicit false flips to write mode.
    assert.match(routeSource, /const dryRun = !isExplicitFalse\(dryRunRaw\)/)
    assert.match(routeSource, /const writeMode = !dryRun/)
    // The response echoes the mode + bounds back to the operator.
    assert.match(routeSource, /dry_run: dryRun/)
    assert.match(routeSource, /write_mode: writeMode/)
})

test('backfill-from-facebook caps limit small and bounds offset', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // limit is capped to <=150 (small), floored to >=1.
    assert.match(routeSource, /Math\.min\(150,\s*Math\.max\(1,\s*Math\.floor\(limitRaw\)\)\)/)
    // offset is bounded 0..10000.
    assert.match(routeSource, /Math\.min\(10000,\s*Math\.max\(0,\s*Math\.floor\(offsetRaw\)\)\)/)
    // Candidate query is constrained by page_id and a bounded LIMIT/OFFSET window.
    assert.match(routeSource, /WHERE \$\{conditions\.join\(' AND '\)\}/)
    assert.match(routeSource, /LIMIT \? OFFSET \?/)
})

test('backfill-from-facebook requires a valid date range only for write mode', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // Dates validated via the shared whitelist + next-day helpers.
    assert.match(routeSource, /sanitizeFacebookPageVideoDateInput\(body\.from_date \?\? c\.req\.query\('from_date'\)\)/)
    assert.match(routeSource, /sanitizeFacebookPageVideoDateInput\(body\.to_date \?\? c\.req\.query\('to_date'\)\)/)
    assert.match(routeSource, /nextUtcDayFromDateOnly\(toInput\.value\)/)
    // Write mode demands an explicit, valid (ordered) range; dry_run may read unbounded.
    assert.match(routeSource, /if \(writeMode\) \{[\s\S]*date_range_required_for_write[\s\S]*invalid_date_range[\s\S]*\}/)
    // Date values flow through bound params, never string-interpolated into SQL.
    assert.match(routeSource, /\.bind\(\.\.\.binds\)/)
    assert.doesNotMatch(routeSource, /created_time\s*[<>]=?\s*['"`]\$\{/)
})

test('backfill-from-facebook never updates D1 in dry run, only updates cache when writing', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // The ONLY DB write is gated behind writeMode (so dry_run never persists).
    const updateAt = routeSource.indexOf('UPDATE facebook_page_video_cache')
    assert.ok(updateAt > -1, 'write path must UPDATE the cache table')
    const guardAt = routeSource.indexOf('if (writeMode && (linkChanged || postIdChanged))')
    assert.ok(guardAt > -1, 'cache UPDATE must be guarded by writeMode')
    assert.ok(guardAt < updateAt, 'writeMode guard must precede the UPDATE')
    // linkChanged never overwrites an existing cached link, but postIdChanged can
    // still fill post_id for rows that already have shopee_link.
    assert.match(routeSource, /const postIdChanged = !!postId && postId !== originalPostId/)
    assert.match(routeSource, /const linkChanged = !cacheLink && !!foundLink/)
    assert.match(routeSource, /postIdChanged \? postId : ''/)
    assert.match(routeSource, /linkChanged \? foundLink : ''/)
    // Exactly one UPDATE and it targets only the cache table — no other DB writes.
    assert.equal(routeSource.match(/UPDATE\s+\w/gi)?.length, 1, 'route must contain a single UPDATE statement')
    assert.doesNotMatch(routeSource, /INSERT\s+INTO/i, 'backfill must not INSERT')
    assert.doesNotMatch(routeSource, /DELETE\s+FROM/i, 'backfill must not DELETE')
    // Writes are cache-only: shopee_link / post_id / audit timestamps.
    assert.match(routeSource, /shopee_link = CASE WHEN \? != '' THEN \? ELSE shopee_link END/)
    assert.match(routeSource, /updated_at = datetime\('now'\),\s*\n\s*fetched_at = datetime\('now'\)/)
})

test('backfill-from-facebook reads via Graph GET only and never returns the token', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // Graph reads use plain fetch (GET) with bounded comment window of 10.
    assert.match(routeSource, /fields=description,title,permalink_url,post_id,created_time/)
    // Comment window now also requests id/created_time but stays bounded at 10.
    assert.match(routeSource, /\/comments\?fields=id,from,message,created_time&limit=10/)
    // No Graph mutations (method POST/DELETE) and no comment edits.
    assert.doesNotMatch(routeSource, /method:\s*'(POST|DELETE)'/i)
    // Token is only used inside the Graph URL, never surfaced in the response/items.
    assert.doesNotMatch(routeSource, /token:\s*token/)
    assert.doesNotMatch(routeSource, /access_token:\s*token/)
    // Response exposes audit counts + source classification, not secrets.
    assert.match(routeSource, /source_counts: sourceCounts/)
    assert.match(routeSource, /scanned,\s*\n\s*found,\s*\n\s*updated,\s*\n\s*missing,\s*\n\s*existing,/)
})

test('backfill-from-facebook adds opt-in comment counts that default off with body winning over query', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // include_comment_counts is a default-OFF opt-in: only an explicit true-like value enables it.
    assert.match(routeSource, /const includeCommentCounts = isExplicitTrue\(includeCommentCountsRaw\)/)
    // Body wins over query (same tri-state pattern as dry_run / only_missing).
    assert.match(
        routeSource,
        /body\.include_comment_counts !== undefined\s*\n?\s*\?\s*body\.include_comment_counts\s*\n?\s*:\s*c\.req\.query\('include_comment_counts'\)/,
    )
    // The explicit-true helper recognizes the usual true-like values.
    assert.match(routeSource, /v === true \|\| s === 'true' \|\| s === '1' \|\| s === 'yes' \|\| s === 'on'/)
    // Mode is echoed back to the operator.
    assert.match(routeSource, /include_comment_counts: includeCommentCounts/)
})

test('backfill-from-facebook requires a valid ordered date range when counting comments, even in dry run', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // include_comment_counts demands an explicit, valid range regardless of dry_run/write mode.
    assert.match(
        routeSource,
        /if \(includeCommentCounts\) \{[\s\S]*date_range_required_for_comment_counts[\s\S]*invalid_date_range[\s\S]*\}/,
    )
    // This guard is independent of (and additional to) the write-mode date guard.
    const writeGuardAt = routeSource.indexOf('date_range_required_for_write')
    const countGuardAt = routeSource.indexOf('date_range_required_for_comment_counts')
    assert.ok(writeGuardAt > -1 && countGuardAt > -1, 'both date guards must exist')
    assert.ok(countGuardAt > writeGuardAt, 'comment-count date guard is separate from the write-mode guard')
})

test('backfill-from-facebook comment scan stays a bounded read-only GET with id/from/message limit 10', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // Single shared bounded comment-window reader, GET only, limit 10, requesting id.
    assert.match(routeSource, /const scanCommentWindow = async \(targetId: string\)/)
    assert.match(routeSource, /\/comments\?fields=id,from,message,created_time&limit=10&access_token=\$\{encodeURIComponent\(commentReadToken\)\}/)
    // It classifies page-authored vs. other comments and caps collected page ids at 5.
    assert.match(routeSource, /if \(fromId && fromId === pageId\) \{[\s\S]*pageCommentCount\+\+[\s\S]*pageCommentIds\.length < 5/)
    assert.match(routeSource, /\} else \{\s*\n\s*otherCommentCount\+\+/)
    // It also derives a missing post_id from the canonical prefix of comment ids.
    assert.match(routeSource, /resolvedPostId = derivePostIdFromCommentId\(cmt\.id\)/)
    // Still no Graph mutations and the token is never surfaced in the response.
    assert.doesNotMatch(routeSource, /method:\s*'(POST|DELETE)'/i)
    assert.doesNotMatch(routeSource, /token:\s*token/)
    assert.doesNotMatch(routeSource, /access_token:\s*token/)
})

test('backfill-from-facebook resolves missing post_id from bounded video-id comments', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // Raw Graph post ids and comment-id prefixes normalize pageId_postTail to the stored tail.
    assert.match(routeSource, /const normalizeGraphPostId = \(raw: unknown\): string =>/)
    assert.match(routeSource, /const pagePrefix = `\$\{pageId\}_`/)
    assert.match(routeSource, /return id\.startsWith\(pagePrefix\) \? id\.slice\(pagePrefix\.length\) : id/)
    assert.match(routeSource, /const derivePostIdFromCommentId = \(raw: unknown\): string =>/)
    assert.match(routeSource, /const splitAt = id\.lastIndexOf\('_'\)/)
    assert.match(routeSource, /const prefix = id\.slice\(0, splitAt\)/)

    // When metadata still leaves post_id missing, scan the video/reel id target itself.
    assert.match(routeSource, /if \(!postId\) \{[\s\S]*const scan = await scanCommentWindow\(videoId\)[\s\S]*applyCommentScan\(scan, 'scanned_via_video_id', 'video_id_comments_no_post_id_prefix'\)/)
    assert.match(routeSource, /markResolvedPostId\(scan\.resolvedPostId, 'comment_id_prefix', `derived_from_\$\{scannedStatus\}`\)/)
    assert.match(routeSource, /postIdResolutionReason = scan\.ok \? unresolvedReason : `\$\{scannedStatus\}_comment_scan_error`/)
    assert.doesNotMatch(routeSource, /mintCustomlink\s*\(|createCustomlink\s*\(|customlinks\.\w+\s*\(/i)
})

test('backfill-from-facebook exposes read-only comment-count fields on every scanned item', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // Each item carries the four read-only comment fields, ids bounded to first 5.
    assert.match(routeSource, /page_comment_count: pageCommentCount/)
    assert.match(routeSource, /page_comment_ids: pageCommentIds\.slice\(0, 5\)/)
    assert.match(routeSource, /other_comment_count: otherCommentCount/)
    assert.match(routeSource, /comment_scan_status: commentScanStatus/)
    assert.match(routeSource, /post_id_resolution_status: PostIdResolutionStatus/i)
    assert.match(routeSource, /post_id_resolution_reason: PostIdResolutionReason/i)
    // Default is a non-scanned ("skipped") state so the old no-scan default reads truthfully.
    assert.match(routeSource, /let commentScanStatus = 'skipped'/)
    assert.match(routeSource, /let postIdResolutionStatus = postId \? 'cached' : 'unresolved'/)
    assert.match(routeSource, /let postIdResolutionReason = postId \? 'cache_post_id_present' : 'post_id_missing'/)
})

test('backfill-from-facebook preserves cached-link count opt-in while resolving missing post_id', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // The cached-link branch keeps comment-count scans behind include_comment_counts
    // when post_id exists, but still does the new video-id scan if post_id is absent.
    const cacheBranchAt = routeSource.indexOf("source = 'cache'")
    assert.ok(cacheBranchAt > -1, 'cache branch must exist')
    const cacheBranch = routeSource.slice(
        routeSource.indexOf('// Preserve old behavior: do NOT scan comments for cached rows', cacheBranchAt),
        routeSource.indexOf('// 2. Read a small bounded comment window', cacheBranchAt),
    )
    assert.match(cacheBranch, /if \(!postId\) \{[\s\S]*scanCommentWindow\(videoId\)[\s\S]*scanned_via_video_id/)
    // The canonical count scan is a separate (not else-if) branch so it also runs
    // after a video-id scan has just resolved a missing post_id in this same row.
    assert.match(cacheBranch, /if \(postId && includeCommentCounts\) \{[\s\S]*const commentTargetId = buildPostCommentTarget\(postId\)[\s\S]*scanCommentWindow\(commentTargetId\)/)
    assert.doesNotMatch(cacheBranch, /else if \(includeCommentCounts\) \{/)
    assert.match(routeSource, /const buildPostCommentTarget = \(storedPostId: string\): string =>/)
    assert.match(routeSource, /return id\.includes\('_'\) \? id : `\$\{pageId\}_\$\{id\}`/)
    // Counting must never introduce writes/mutations in this path.
    assert.doesNotMatch(routeSource, /INSERT\s+INTO/i)
    assert.doesNotMatch(routeSource, /DELETE\s+FROM/i)
    assert.equal(routeSource.match(/UPDATE\s+\w/gi)?.length, 1, 'route must still contain a single UPDATE statement')
    // No customlink minting call is introduced (the descriptive header comment aside).
    assert.doesNotMatch(routeSource, /mintCustomlink\s*\(|createCustomlink\s*\(|customlinks\.\w+\s*\(/i, 'comment counting must not mint customlinks')
})

test('backfill-from-facebook comment counts target the canonical post after post_id resolution', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // Canonical target: a stored/current post_id that already contains an underscore
    // is used as-is; a bare tail is re-prefixed with the page id. Never videoId.
    assert.match(routeSource, /const buildPostCommentTarget = \(storedPostId: string\): string => \{/)
    assert.match(routeSource, /return id\.includes\('_'\) \? id : `\$\{pageId\}_\$\{id\}`/)

    // Once post_id is resolved in the same row, the comment-count scan targets the
    // canonical post (buildPostCommentTarget(postId)) and does NOT fall back to videoId.
    // The count scan must NOT be gated on !usedVideoIdCommentScan: a post_id derived
    // by the video-id scan still gets a canonical re-scan when counts are requested.
    assert.match(routeSource, /const needCountScan = includeCommentCounts && !!postId$/m)
    assert.doesNotMatch(routeSource, /const needCountScan = includeCommentCounts && !!postId && !usedVideoIdCommentScan/)
    assert.match(routeSource, /const commentTargetId = buildPostCommentTarget\(postId\)\s*\n\s*const scan = await scanCommentWindow\(commentTargetId\)/)
    // The only videoId comment scan is guarded behind a missing post_id (post_id
    // resolution fallback), so counts never target videoId once post_id is known.
    assert.match(routeSource, /if \(!postId\) \{\s*\n\s*const scan = await scanCommentWindow\(videoId\)/)
    // The link scan keeps the single-flight guard; only the count scan drops it.
    assert.match(routeSource, /const needLinkScan = !foundLink && !!postId && !usedVideoIdCommentScan/)
})

test('backfill-from-facebook surfaces sanitized comment scan errors without leaking the token', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    // A dedicated sanitizer strips the literal token and any access_token=... pair.
    assert.match(routeSource, /const sanitizeGraphErrorText = \(text: unknown\): string =>/)
    assert.match(routeSource, /if \(token\) s = s\.split\(token\)\.join\('\[REDACTED\]'\)/)
    assert.match(routeSource, /s\.replace\(\/access_token=\[\^&\\s"'\]\+\/gi, 'access_token=\[REDACTED\]'\)/)

    // The comment scan failure reason includes HTTP status + sanitized message/code/type.
    assert.match(routeSource, /`http_\$\{commentsResp\.status\}`/)
    assert.match(routeSource, /const errCode = graphErr\?\.code !== undefined \? sanitizeGraphErrorText\(graphErr\.code\) : ''/)
    assert.match(routeSource, /errCode \? `code=\$\{errCode\}` : ''/)
    assert.match(routeSource, /errType \? `type=\$\{errType\}` : ''/)
    assert.match(routeSource, /const errMsg = sanitizeGraphErrorText\(\(graphErr\?\.message\) \|\| `comments_fetch_\$\{commentsResp\.status\}`\)/)

    // applyCommentScan captures the scan error so an 'error' status is never empty.
    assert.match(routeSource, /if \(!scan\.ok && scan\.error\) commentScanError = scan\.error/)

    // Each item exposes comment_scan_error and item.error falls back to it.
    assert.match(routeSource, /comment_scan_error: commentScanError/)
    assert.match(routeSource, /error: rowError \|\| commentScanError/)

    // Still no token surfaced anywhere in the route.
    assert.doesNotMatch(routeSource, /token:\s*token/)
    assert.doesNotMatch(routeSource, /access_token:\s*token/)
})

test('backfill-from-facebook adds opt-in CTA scan that requires a bounded date range', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    assert.match(routeSource, /body\.include_cta !== undefined\s*\n?\s*\?\s*body\.include_cta\s*\n?\s*:\s*c\.req\.query\('include_cta'\)/)
    assert.match(routeSource, /const includeCta = isExplicitTrue\(includeCtaRaw\)/)
    assert.match(routeSource, /include_cta: includeCta/)
    assert.match(routeSource, /if \(includeCta\) \{[\s\S]*date_range_required_for_cta[\s\S]*invalid_date_range[\s\S]*\}/)
})

test('backfill-from-facebook CTA scan is read-only Graph GET and never returns the token', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    assert.match(routeSource, /const scanCtaTarget = async \(targetId: string\)/)
    assert.match(routeSource, /fields=\$\{encodeURIComponent\(fields\)\}&access_token=\$\{encodeURIComponent\(token\)\}/)
    assert.match(routeSource, /call_to_action/)
    assert.match(routeSource, /link,permalink_url/)
    assert.match(routeSource, /`\$\{targetPath\}\/attachments`/)
    assert.doesNotMatch(routeSource, /attachments\{[^}]+\}/)
    assert.doesNotMatch(routeSource, /child_attachments/)
    assert.doesNotMatch(routeSource, /subattachments/)
    assert.doesNotMatch(routeSource, /method:\s*'(POST|DELETE)'/i)
    assert.doesNotMatch(routeSource, /customlink\.wwoom\.com|\/api\/customlink|mintCustomlink/i)
    assert.doesNotMatch(routeSource, /token:\s*token/)
    assert.doesNotMatch(routeSource, /access_token:\s*token/)
})

test('backfill-from-facebook exposes response-only CTA fields on every scanned item', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    assert.match(routeSource, /cta_present: ctaPresent/)
    assert.match(routeSource, /cta_type: ctaType/)
    assert.match(routeSource, /cta_title: ctaTitle/)
    assert.match(routeSource, /cta_url: ctaUrl/)
    assert.match(routeSource, /cta_source: ctaSource/)
    assert.match(routeSource, /cta_scan_status: ctaScanStatus/)
    assert.match(routeSource, /cta_scan_error: ctaScanError/)
    assert.match(routeSource, /let ctaScanStatus = 'skipped'/)
    assert.match(routeSource, /ctaUrl = sanitizeGraphErrorText\(cta\.url\)/)
    assert.equal(routeSource.match(/UPDATE\s+\w/gi)?.length, 1, 'CTA audit must not add DB writes')
    assert.doesNotMatch(routeSource, /INSERT\s+INTO/i)
    assert.doesNotMatch(routeSource, /DELETE\s+FROM/i)
})

test('backfill-from-facebook CTA scan targets canonical post first with video fallback', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    assert.match(routeSource, /const ctaTargetId = postId \? buildPostCommentTarget\(postId\) : videoId/)
    assert.match(routeSource, /const cta = await scanCtaTarget\(ctaTargetId\)/)
    assert.match(routeSource, /ctaScanStatus = cta\.status/)
    assert.match(routeSource, /ctaScanStatus = 'no_target'/)
})

test('backfill-from-facebook CTA scan retries Graph field failures without clamping audit limit', () => {
    const routeSource = getBackfillFromFacebookRouteSource()

    assert.match(routeSource, /code === '12'/)
    assert.match(routeSource, /deprecate_post_aggregated_fields_for_attachement/)
    assert.match(routeSource, /fieldUnavailable: isFieldUnavailableGraphError\(resp, json\)/)
    assert.match(routeSource, /status: 'field_unavailable'/)
    assert.match(routeSource, /status: 'scanned'/)
    assert.match(routeSource, /const limit = Number\.isFinite\(limitRaw\) \? Math\.min\(150, Math\.max\(1, Math\.floor\(limitRaw\)\)\) : 100/)
    assert.doesNotMatch(routeSource, /effectiveLimit\s*=\s*[^\n]*\?\s*1\s*:\s*limit/)
    assert.doesNotMatch(routeSource, /includeCta[\s\S]{0,120}\?\s*1\s*:\s*limit/)
    assert.doesNotMatch(routeSource, /clamped_to_safe_max/)
})

test('per-page posting order override wins when enabled with a valid order', () => {
    const resolverSource = getPagePostingOrderResolverSource()
    const pageReturnAt = resolverSource.indexOf("source: 'page'")
    const globalReturnAt = resolverSource.indexOf("source: 'global'")

    assert.match(resolverSource, /getPagePostingOrderOverrideSettings\(db,\s*normalizedPageId\)/)
    assert.match(resolverSource, /if\s*\(\s*pageSettings\.overrideEnabled\s*&&\s*pageSettings\.postingOrder\s*\)/)
    assert.ok(pageReturnAt > -1, 'resolver must return source=page for an enabled valid override')
    assert.ok(globalReturnAt > -1, 'resolver must return source=global fallback')
    assert.ok(pageReturnAt < globalReturnAt, 'page override branch must be checked before global fallback')
})

test('disabled per-page posting order falls back to namespace global order', () => {
    const resolverSource = getPagePostingOrderResolverSource()

    assert.match(resolverSource, /const globalSettings = await getNamespacePostingOrderEntry\(db,\s*namespaceId\)/)
    assert.match(resolverSource, /pageOverrideEnabled:\s*pageSettings\?\.overrideEnabled === true/)
    assert.match(resolverSource, /postingOrder:\s*globalSettings\.postingOrder/)
    assert.match(resolverSource, /updatedAt:\s*globalSettings\.updatedAt/)
})

test('page posting order settings route rejects invalid posting_order values', () => {
    const routeSource = getPagePostingOrderSettingsRouteSource()

    assert.match(routeSource, /app\.put\('\/api\/pages\/:id\/posting-order-settings'/)
    assert.match(routeSource, /requireAuthSession\(c\)/)
    assert.match(routeSource, /if\s*\(\s*rawPostingOrder\s*&&\s*!isNamespacePostingOrder\(rawPostingOrder\)\s*\)/)
    assert.match(routeSource, /invalid_posting_order/)
    assert.match(routeSource, /allowed:\s*POSTING_ORDER_VALUES/)
})

test('runtime ensure idempotently adds the posting_token_source column', () => {
    const ensureSource = getEnsurePagesOneCardColumnsSource()

    assert.match(
        ensureSource,
        /ALTER TABLE pages ADD COLUMN posting_token_source TEXT DEFAULT 'stored_token'/,
        'ensurePagesOneCardColumns must add posting_token_source so old DBs gain the column at runtime',
    )
    // ALTERs stay best-effort (idempotent) so re-running never throws on existing columns.
    assert.match(ensureSource, /\.run\(\)\.catch\(\(\) => undefined\)/)
})

test('posting token source normalizer collapses to two modes (stored_token | cloak_browser)', () => {
    const fnSource = getNormalizePagePostingTokenSourceSource()

    assert.match(fnSource, /PagePostingTokenSource/)
    // Legacy/internal DB values both collapse to the single CloakBrowser source.
    assert.match(fnSource, /value === 'post-reels-token-cloak'/)
    assert.match(fnSource, /value === 'post-reels-token-ads'/)
    assert.match(fnSource, /value === 'cloak_browser'/)
    assert.match(fnSource, /return 'cloak_browser'/)
    // Everything invalid/missing falls back to the legacy default.
    assert.match(fnSource, /return 'stored_token'/)
})

test('PUT /api/pages/:id persists posting_token_source independent of manual token edits', () => {
    const routeSource = getPagePutRouteSource()

    // The value is read from the request body and normalized before persistence.
    assert.match(routeSource, /posting_token_source,/)
    assert.match(routeSource, /normalizePagePostingTokenSource\(posting_token_source\)/)
    // Persisted via its own UPDATE, gated only by `posting_token_source !== undefined`
    // (NOT by token validation) so saving CloakBrowser never requires editing access_token.
    assert.match(routeSource, /if \(posting_token_source !== undefined\) \{/)
    assert.match(
        routeSource,
        /UPDATE pages SET posting_token_source = \?, updated_at = datetime\("now"\) WHERE id = \? AND bot_id = \?/,
    )
    // Selecting CloakBrowser is NOT admin-restricted (organic posting). The OneCard/create-ad
    // route keeps its own admin guard (ads_publish_enabled + the create-ad runtime check), so
    // the source-selection UPDATE must NOT carry an ads_publish_admin_only gate.
    assert.ok(
        !/normalizedPostingTokenSource ===[\s\S]*ads_publish_admin_only/.test(routeSource),
        'selecting a posting source must not be admin-gated',
    )
    // The updated page is read back WITH posting_token_source so the UI restores the saved value.
    assert.match(routeSource, /SELECT[\s\S]*posting_token_source[\s\S]*FROM pages WHERE id = \? AND bot_id = \?/)
})

test('runtime ensure idempotently adds the comment_token_source column (NULL default = follow posting source)', () => {
    const ensureSource = getEnsurePagesOneCardColumnsSource()
    // No DEFAULT — a NULL value is normalized at runtime to the page's effective posting
    // source so existing pages keep their current comment behavior.
    assert.match(
        ensureSource,
        /ALTER TABLE pages ADD COLUMN comment_token_source TEXT/,
        'ensurePagesOneCardColumns must add comment_token_source so old DBs gain the column at runtime',
    )
})

test('PUT /api/pages/:id persists comment_token_source independently of posting source and token edits', () => {
    const routeSource = getPagePutRouteSource()

    // Read from the body and normalized before persistence, independent of posting_token_source.
    assert.match(routeSource, /comment_token_source,/)
    assert.match(routeSource, /normalizePageCommentTokenSource\(comment_token_source\)/)
    // Persisted via its own UPDATE, gated only by `comment_token_source !== undefined` (no
    // token validation, no admin gate) so selecting a comment source never requires a token edit.
    assert.match(routeSource, /if \(comment_token_source !== undefined\) \{/)
    assert.match(
        routeSource,
        /UPDATE pages SET comment_token_source = \?, updated_at = datetime\("now"\) WHERE id = \? AND bot_id = \?/,
    )
    // Read back WITH comment_token_source so the UI restores the saved value.
    assert.match(routeSource, /SELECT[\s\S]*comment_token_source[\s\S]*FROM pages WHERE id = \? AND bot_id = \?/)
})

test('sendPageCommentViaCloakBridge comments as the Page and fails closed (no stored-token fallback)', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function sendPageCommentViaCloakBridge')
    assert.notEqual(start, -1, 'sendPageCommentViaCloakBridge must exist')
    const end = source.indexOf('\nasync function loadPostingThumbnailAsset', start)
    const fn = source.slice(start, end > -1 ? end : start + 4000)

    // Base URL from the Cloak FB bridge resolver, fails closed when unconfigured.
    assert.match(fn, /resolveCloakFbBridgeBaseUrl\(params\.env\)/)
    assert.match(fn, /throw new Error\('bridge_not_configured'\)/)
    // Posts page_id/story_id/message to /page-comment — never a token. Optional account
    // is allowed so Facebook Lite can select the correct Token Bridge session.
    assert.match(fn, /\$\{baseUrl\}\/page-comment`/)
    assert.match(fn, /body: JSON\.stringify\(\{ page_id: pageId, story_id: storyId, message,[\s\S]*account/)
    // Nothing to comment → not_configured; any failure → 'failed' (never silent success).
    assert.match(fn, /return \{ status: 'not_configured'/)
    assert.match(fn, /status: 'failed'/)
    // No stored/manual token anywhere in the bridge comment path.
    assert.ok(!fn.includes('commentToken'), 'bridge comment must not use a stored comment token')
})

test('force-post routes CloakBrowser OneCard vs organic Reel without stored-token fallback', () => {
    const routeSource = getForcePostRouteSource()

    // SELECT reads the saved source back (posting + comment token sources).
    assert.match(routeSource, /SELECT[\s\S]*posting_token_source, comment_token_source, posting_profile_uid FROM pages WHERE id = \? AND bot_id = \?/)
    // Effective decision is centralized in the tested resolvePostingRoute helper.
    assert.match(routeSource, /normalizePagePostingTokenSource\(\(page as Record<string, unknown>\)\.posting_token_source\)/)
    // The Video One Card flag selects OneCard/create-ad vs organic Reel for a CloakBrowser page.
    // The legacy ads_publish_enabled bridge promotion is admin-owned only, so it is gated on
    // namespace ownership (&& namespaceIsAdminOwned) alongside the source admin guard.
    assert.match(routeSource, /resolvePostingRoute\(\{ source: pagePostingTokenSource, oneCardEnabled: pageOneCardEnabled, adsPublishLegacyFlag: pageAdsPublishLegacyFlag && namespaceIsAdminOwned \}\)/)
    assert.match(routeSource, /const pageAdsPublishEnabled = pagePostingRoute === 'cloak_onecard_bridge'/)
    // Cloak organic branch routes to the session-cookie bridge, never the stored token.
    assert.match(routeSource, /const pageCloakPostSelected = pagePostingRoute === 'cloak_organic_reel'/)
    assert.match(routeSource, /if \(pageCloakPostSelected\) \{[\s\S]*publishReelViaSessionBridge/)
    // Cloak post hint/profile must NOT derive from a stored/manual token candidate.
    assert.match(routeSource, /const initialPostTokenHint = pageCloakPostSelected \? 'cloak_session_bridge' : deriveCommentTokenHint/)
    assert.match(routeSource, /resolvePostHistoryProfileByToken\(env, pageCloakPostSelected \? null :/)
    // History post_token_hint stays the LEGACY persisted label ('cloak_session_bridge') on
    // purpose — only the UI/source modes collapse to two (stored_token | cloak_browser).
    // Renaming the stored hint would force a post_history data migration, so it is left as-is.
    assert.match(routeSource, /post_token_hint='cloak_session_bridge'/)
    // Cloak comment re-mints the link with the post id (sub2=post id / sub3=page id), builds the
    // affiliate comment from that re-minted link, and posts it AS THE PAGE via the shared fail-closed
    // bridge helper — the comment status comes from the bridge result (never a fake success).
    assert.match(routeSource, /if \(pageCloakPostSelected\) \{[\s\S]*buildAffiliateCommentMessage\(env\.DB, botId, commentShopeeLink\)[\s\S]*sendPageCommentViaCloakBridge\(\{[\s\S]*message: cloakOverrideText/)
    assert.match(routeSource, /if \(pageCloakPostSelected\) \{[\s\S]*cloakCommentStatus = bridged\.status/)
    // Comment SOURCE is decoupled from posting route: the bridge only posts the comment when
    // comment_token_source='cloak_browser' (commentViaCloakBridge); otherwise the stored-token
    // backlog handles it.
    assert.match(routeSource, /if \(pageCloakPostSelected\) \{[\s\S]*if \(commentViaCloakBridge\) \{/)
    // The stored-token override defers via comment_due_at (pending backlog).
    assert.match(routeSource, /if \(pageCloakPostSelected\) \{[\s\S]*cloakCommentStatus = 'pending'/)
    // No facebook-token-cloak provider endpoints / env / port anywhere in the branch.
    assert.ok(!routeSource.includes('/provider/post'), 'must not call the old /provider/post')
    assert.ok(!routeSource.includes('FACEBOOK_TOKEN_CLOAK'), 'must not read FACEBOOK_TOKEN_CLOAK env')
    assert.ok(!routeSource.includes('127.0.0.1:8820'), 'must not target port 8820')
    // Admin-only guard still enforced on the ads branch.
    assert.match(routeSource, /if \(pageAdsPublishEnabled\) \{[\s\S]*isNamespaceShortlinkAdminManaged/)
    // OneCard/Ads must comment as the PAGE too (parity with organic Reels). create-ad runs
    // with skip_comment so it never comments; this branch posts the single comment via the
    // bridge /page-comment route (page token internal, never the user token).
    assert.match(routeSource, /skip_comment: true/)
    // ADS comment honors comment_token_source: bridge (cloak) vs deferred stored backlog.
    assert.match(routeSource, /if \(!adsData\.commentPosted && adsCommentShopeeLink && !skipComment && storyId && commentViaCloakBridge\) \{/)
    assert.match(routeSource, /if \(pageAdsPublishEnabled\) \{[\s\S]*sendPageCommentViaCloakBridge\(\{[\s\S]*pageId: String\(page\.id \|\| ''\),[\s\S]*storyId,[\s\S]*message: adsCommentText/)
    // Stored-token override sets the deferred pending state instead of calling the bridge.
    assert.match(routeSource, /if \(pageAdsPublishEnabled\) \{[\s\S]*adsCommentStatus = 'pending'/)
    // After story_id exists the comment link is re-minted with sub2=post id / sub3=page id.
    assert.match(routeSource, /adsCommentRemint = await remintOneCardCommentShortlink\(\{[\s\S]*storyId,[\s\S]*managedShopeeLink: normalizedShopeeLink,/)
    assert.match(routeSource, /adsCommentShopeeLink = adsCommentRemint\.commentShopeeLink/)
    // The post_history UPDATE binds the final comment status/id/error, token-free hint,
    // deferred schedule, AND the re-minted link.
    assert.match(routeSource, /comment_status=\?, comment_fb_id=\?, comment_error=\?, comment_token_hint=\?, comment_delay_seconds=\?, comment_due_at=\?, shopee_link=\?, error_message=NULL[\s\S]*\.bind\([\s\S]*adsCommentStatus,[\s\S]*adsCommentId,[\s\S]*adsCommentError,[\s\S]*adsCommentShopeeLink/)
    // A failed comment must NOT fail the post.
    assert.match(routeSource, /adsCommentStatus = 'failed'/)
    // Response exposes comment_posted=true only when the (fallback) comment succeeded.
    assert.match(routeSource, /comment_posted: adsCommentStatus === 'success'/)
    // Source-aware log carries a token-free source hint.
    assert.match(routeSource, /\[FORCE-POST\][\s\S]*posting_token_source=\$\{pagePostingTokenSource\}[\s\S]*source_hint=\$\{postingSourceHint\(pagePostingRoute\)\}/)
})

test('cron routes CloakBrowser OneCard vs organic Reel without stored-token fallback', () => {
    const cronSource = getHandleScheduledSource()

    // SELECT reads the saved source back for every candidate page (posting + comment).
    assert.match(cronSource, /SELECT[\s\S]*ads_publish_enabled, posting_token_source, comment_token_source, posting_profile_uid\s*\n\s*FROM pages/)
    // Same centralized decision as force-post; never silently falls back to the stored token.
    assert.match(cronSource, /normalizePagePostingTokenSource\(page\.posting_token_source\)/)
    // Mirror of the force-post guard: legacy ads_publish_enabled promotion is admin-gated.
    assert.match(cronSource, /resolvePostingRoute\(\{ source: pagePostingTokenSource, oneCardEnabled: pageOneCardEnabled, adsPublishLegacyFlag: pageAdsPublishLegacyFlag && namespaceIsAdminOwned \}\)/)
    assert.match(cronSource, /const pageAdsPublishEnabled = pagePostingRoute === 'cloak_onecard_bridge'/)
    assert.match(cronSource, /const pageCloakPostSelected = pagePostingRoute === 'cloak_organic_reel'/)
    // Cloak organic branch uses the session-cookie bridge and fails closed.
    assert.match(cronSource, /if \(pageCloakPostSelected\) \{[\s\S]*publishReelViaSessionBridge[\s\S]*cloak_post_failed/)
    // Cloak post hint must NOT derive from a stored/manual token candidate.
    assert.match(cronSource, /const initialPostTokenHint = pageCloakPostSelected \? 'cloak_session_bridge' : deriveCommentTokenHint/)
    // Cloak branch re-mints the link with the post id, builds an affiliate comment from it, and
    // posts AS THE PAGE via the shared fail-closed bridge helper (status from the bridge result).
    assert.match(cronSource, /if \(pageCloakPostSelected\) \{[\s\S]*buildAffiliateCommentMessage\(env\.DB, botId, commentShopeeLink\)[\s\S]*sendPageCommentViaCloakBridge\(\{[\s\S]*message: cloakOverrideText[\s\S]*cloakCommentStatus = bridged\.status/)
    assert.ok(!cronSource.includes('/provider/post'), 'must not call the old /provider/post')
    assert.ok(!cronSource.includes('FACEBOOK_TOKEN_CLOAK'), 'must not read FACEBOOK_TOKEN_CLOAK env')
    // Admin-only runtime re-check preserved on the cron ads branch.
    assert.match(cronSource, /if \(pageAdsPublishEnabled\) \{[\s\S]*isNamespaceShortlinkAdminManaged/)
    // create-ad runs with skip_comment; cron posts the single re-minted comment itself.
    assert.match(cronSource, /if \(pageAdsPublishEnabled\) \{[\s\S]*skip_comment: true/)
    assert.match(cronSource, /cronAdsCommentRemint = await remintOneCardCommentShortlink\(\{[\s\S]*storyId,[\s\S]*managedShopeeLink: normalizedShopeeLink,/)
    // ADS comment honors comment_token_source: cloak bridge vs deferred stored backlog.
    assert.match(cronSource, /if \(commentViaCloakBridge\) \{[\s\S]*sendPageCommentViaCloakBridge\(\{[\s\S]*pageId: String\(page\.id \|\| ''\),[\s\S]*storyId,[\s\S]*message: cronAdsCommentText/)
    assert.match(cronSource, /cronAdsCommentStatus = 'pending'/)
    // post_history records the real comment status/id, token-free hint, schedule, and link.
    assert.match(cronSource, /comment_status=\?, comment_fb_id=\?, comment_error=\?, comment_token_hint=\?, comment_delay_seconds=\?, comment_due_at=\?, shopee_link=\?, posted_at=\?, error_message=NULL[\s\S]*\.bind\([\s\S]*cronAdsCommentStatus,[\s\S]*cronAdsCommentId,[\s\S]*cronAdsCommentError,[\s\S]*cronAdsCommentShopeeLink/)
})

test('publishReelViaSessionBridge validates /token + /pages then posts /post via the Cloak FB bridge (no token leak, no 8820, fail-closed)', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function publishReelViaSessionBridge')
    assert.notEqual(start, -1, 'publishReelViaSessionBridge must exist')
    const end = source.indexOf('\nasync function loadPostingThumbnailAsset', start)
    const fn = source.slice(start, end > -1 ? end : start + 5000)

    // Base URL comes from the Cloak FB bridge resolver (CLOAK_FB_BRIDGE_URL), with NO
    // hardcoded default, and fails closed when unconfigured rather than hitting a dead tunnel.
    assert.match(fn, /resolveCloakFbBridgeBaseUrl\(params\.env\)/)
    assert.match(fn, /if \(!baseUrl\) throw new Error\('bridge_not_configured'\)/)
    assert.ok(!fn.includes('video-onecard.wwoom.com'), 'must not target the retired video-onecard tunnel')
    assert.ok(!fn.includes(':3847'), 'must not target the retired Electron port 3847')
    assert.ok(!fn.includes('127.0.0.1:8820'), 'must not target port 8820')
    assert.ok(!fn.includes('FACEBOOK_TOKEN_CLOAK'), 'must not read FACEBOOK_TOKEN_CLOAK env')
    assert.ok(!fn.includes('/provider/'), 'must not call any /provider/* endpoint')
    // Fail-closed validation: /token (boolean session check) then /pages authorization.
    assert.match(fn, /\/token\$\{accountQuery\}`[\s\S]*tokenData\.accessToken !== true[\s\S]*session_bridge_token_unavailable/)
    assert.match(fn, /\/pages\$\{accountQuery\}`[\s\S]*session_bridge_page_not_authorized/)
    // Posts the organic Reel via the bridge /post route.
    assert.match(fn, /\$\{baseUrl\}\/post`/)
    // Comment is posted AS THE PAGE via the bridge /page-comment route (resolves the page
    // token internally, fails closed, no session-user fallback). Worker sends only
    // page_id/story_id/message (+ optional account selector) — never a token.
    assert.match(fn, /\$\{baseUrl\}\/page-comment`/)
    assert.match(fn, /body: JSON\.stringify\(\{ page_id: pageId, story_id: storyId, message: commentText,[\s\S]*account/)
    // Must NOT comment via the /graph proxy (that path authors the comment as the
    // logged-in user, not the Page — the bug this fix removes).
    assert.ok(!/\/graph\?path=[^]*\/comments/.test(fn), 'organic Cloak comment must NOT use /graph?path=.../comments')
    // Missing page-comment id → failed (never silently success), no user-token fallback.
    assert.match(fn, /Missing page-comment id[\s\S]*commentStatus = 'failed'/)
    // Returns a token-free bridge source hint, not a stored token nor facebook-token-cloak.
    assert.match(fn, /postingToken: postingTokenHint/)
})

test('create-ad accepts an explicit pre-shortened comment link and skips its own shortener', () => {
    const routeSource = getDashboardCreateAdRouteSource()

    // Explicit field is read from the body and validated as http(s).
    assert.match(routeSource, /comment_shortlink\?: string/)
    assert.match(routeSource, /const explicitCommentShortlink = String\(body\.comment_shortlink \|\| ''\)\.trim\(\)/)
    assert.match(routeSource, /const hasExplicitCommentShortlink = \/\^https\?:\\\/\\\/\/i\.test\(explicitCommentShortlink\)/)

    // When present, shortLink is the explicit link and the legacy short.wwoom fetch
    // is gated behind the else-if so it never double-shortens an already-short link.
    assert.match(
        routeSource,
        /if \(hasExplicitCommentShortlink\) \{[\s\S]*shortLink = explicitCommentShortlink[\s\S]*\} else if \(shopeeLink\) \{/,
    )
    // The short.wwoom GET only lives inside the else-if (template) branch.
    const explicitBranchIdx = routeSource.indexOf('shortLink = explicitCommentShortlink')
    const fetchIdx = routeSource.indexOf('await fetch(shortlinkUrl,')
    assert.ok(explicitBranchIdx > -1 && fetchIdx > -1, 'both branches must exist')
    assert.ok(explicitBranchIdx < fetchIdx, 'explicit branch must precede (and short-circuit) the template fetch')

    // A Shopee/product URL is still required for the CTA (shopee_link_not_found guard).
    assert.match(routeSource, /if \(!shopeeLink\) \{[\s\S]*shopee_link_not_found/)

    // skip_comment lets the OneCard auto route defer the comment so it can re-mint the
    // link with sub2=post id / sub3=page id after story_id exists. The comment block is
    // gated on !skipComment and the response advertises commentSkipped.
    assert.match(routeSource, /skip_comment\?: boolean/)
    assert.match(routeSource, /const skipComment = body\.skip_comment === true/)
    assert.match(routeSource, /if \(cleanShortLink && placementTemplate !== 'instagram' && !skipComment\) \{/)
    assert.match(routeSource, /commentSkipped: skipComment/)
})

test('create-ad uses the SAME Cloak FB bridge for every source — no provider branch, fail-closed when unconfigured', () => {
    const routeSource = getDashboardCreateAdRouteSource()

    // create-ad always targets the non-Electron Cloak FB bridge via baseUrl, resolved with
    // no hardcoded default and failing closed (bridge_not_configured) when unset.
    assert.match(routeSource, /const baseUrl = resolveCloakFbBridgeBaseUrl\(c\.env\)/)
    assert.match(routeSource, /if \(!baseUrl\) return c\.json\(\{ ok: false, error: 'bridge_not_configured'/)
    assert.match(routeSource, /callVideoOnecardCreateAd\(templateAdsetFromSettings\)/)
    assert.match(routeSource, /await fetch\(`\$\{baseUrl\}\/create-ad`/)
    // The old facebook-token-cloak provider dispatch is fully removed.
    assert.ok(!routeSource.includes('/provider/create-ad'), 'must not call /provider/create-ad')
    assert.ok(!routeSource.includes("=== 'cloak_provider'"), 'old cloak_provider create-ad branch must be gone')
    assert.ok(!routeSource.includes('FACEBOOK_TOKEN_CLOAK'), 'must not read FACEBOOK_TOKEN_CLOAK env')
    assert.ok(!routeSource.includes('127.0.0.1:8820'), 'must not target port 8820')
    assert.ok(!routeSource.includes('video-onecard.wwoom.com'), 'must not target the retired video-onecard tunnel')
    assert.ok(!routeSource.includes('cloak_create_ad_pending_browser_publish'), 'no stale pending stub state')
})

test('worker config/env never references the legacy facebook-token-cloak provider', () => {
    const indexSrc = readFileSync('src/index.ts', 'utf8')
    const pipelineSrc = readFileSync('src/pipeline.ts', 'utf8')
    const wrangler = readFileSync('wrangler.jsonc', 'utf8')
    for (const [name, src] of [['index.ts', indexSrc], ['pipeline.ts', pipelineSrc], ['wrangler.jsonc', wrangler]] as const) {
        assert.ok(!/FACEBOOK_TOKEN_CLOAK_URL|FACEBOOK_TOKEN_CLOAK_ACCOUNT/.test(src), `${name} must not reference FACEBOOK_TOKEN_CLOAK_* env`)
        assert.ok(!/['"`]https?:\/\/127\.0\.0\.1:8820/.test(src), `${name} must not point at the 8820 provider URL`)
        assert.ok(!src.includes('/provider/post') && !src.includes('/provider/create-ad'), `${name} must not call /provider/* endpoints`)
    }
    // The active Env binding for the bridge is now CLOAK_FB_BRIDGE_URL (the non-Electron
    // Cloak FB posting bridge). VIDEO_ONECARD_WORKER_URL remains only as a deprecated
    // migration fallback and must NEVER default to the retired video-onecard tunnel.
    assert.match(pipelineSrc, /CLOAK_FB_BRIDGE_URL\?: string/)
    assert.match(wrangler, /"CLOAK_FB_BRIDGE_URL":\s*"[^"]*"/)
    assert.ok(!/"VIDEO_ONECARD_WORKER_URL":\s*"https:\/\/video-onecard\.wwoom\.com"/.test(wrangler), 'wrangler must not point VIDEO_ONECARD_WORKER_URL at the retired tunnel')
    assert.ok(!/"CLOAK_FB_BRIDGE_URL":\s*"[^"]*video-onecard\.wwoom\.com/.test(wrangler), 'CLOAK_FB_BRIDGE_URL must not point at the retired tunnel')
})

test('force-post ads branch passes the pre-shortened managed link as comment_shortlink', () => {
    const routeSource = getForcePostRouteSource()

    const callIdx = routeSource.indexOf("'force_ads_publish'")
    assert.ok(callIdx > -1, 'force-post must call create-ad with force_ads_publish tag')
    const callBlock = routeSource.slice(routeSource.lastIndexOf('/api/dashboard/create-ad', callIdx), callIdx)

    // CTA uses the original Shopee URL (raw) with a managed-link fallback.
    assert.match(callBlock, /shopee_url:\s*rawShopeeLink \|\| normalizedShopeeLink/)
    // Comment shortlink is the already managed/shortened link so create-ad won't re-shorten.
    assert.match(callBlock, /comment_shortlink:\s*normalizedShopeeLink/)
    // Internal gallery id is uploaded by URL (the avatar-composed posting URL derived from
    // realVideoUrl), NOT sent as a Facebook video id.
    assert.match(callBlock, /video_url:\s*postingVideoUrl/)
    assert.match(callBlock, /source_video_id:\s*unpostedId/)
    assert.doesNotMatch(callBlock, /\bvideo_id:\s*unpostedId/)
})

test('cron ads branch passes the pre-shortened managed link as comment_shortlink', () => {
    const cronSource = getHandleScheduledSource()

    const callIdx = cronSource.indexOf("'cron_ads_publish'")
    assert.ok(callIdx > -1, 'cron must call create-ad with cron_ads_publish tag')
    const callBlock = cronSource.slice(cronSource.lastIndexOf('/api/dashboard/create-ad', callIdx), callIdx)

    assert.match(callBlock, /shopee_url:\s*rawShopeeLink \|\| normalizedShopeeLink/)
    assert.match(callBlock, /comment_shortlink:\s*normalizedShopeeLink/)
    // Internal gallery id is uploaded by URL (the avatar-composed posting URL derived from
    // realVideoUrl), NOT sent as a Facebook video id.
    assert.match(callBlock, /video_url:\s*postingVideoUrl/)
    assert.match(callBlock, /source_video_id:\s*unpostedId/)
    assert.doesNotMatch(callBlock, /\bvideo_id:\s*unpostedId/)
})

test('force-post and cron use effective page posting order with source-aware logs', () => {
    const forceSource = getForcePostRouteSource()
    const cronSource = getHandleScheduledSource()

    assert.match(forceSource, /resolveEffectivePagePostingOrder\(env\.DB,\s*botId,\s*page\.id\)/)
    assert.match(forceSource, /posting_order=\$\{postingOrder\} source=\$\{postingOrderSource\}/)
    assert.doesNotMatch(forceSource, /getNamespacePostingOrderEntry\(env\.DB,\s*botId\)\)\.postingOrder/)

    assert.match(cronSource, /resolveEffectivePagePostingOrder\(env\.DB,\s*botId,\s*String\(page\.id \|\| ''\)\)/)
    assert.match(cronSource, /posting_order=\$\{postingOrder\} source=\$\{postingOrderSource\}/)
    assert.doesNotMatch(cronSource, /getNamespacePostingOrderEntry\(env\.DB,\s*botId\)\)\.postingOrder/)
})

// Reads the runOneCardPostFirstAds helper source (module-level function in index.ts).
function getPostFirstHelperSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function runOneCardPostFirstAds(')
    assert.notEqual(start, -1, 'runOneCardPostFirstAds must exist')
    const end = source.indexOf('\nasync function isNamespaceAffiliateVerificationEnforced', start)
    assert.notEqual(end, -1, 'runOneCardPostFirstAds end marker must exist')
    return source.slice(start, end)
}

test('post-first ADS honors comment_token_source (bridge vs deferred stored), Page story target', () => {
    const helper = getPostFirstHelperSource()

    // Comment delivery is parameterized, decoupled from the ADS posting route.
    assert.match(helper, /commentSource: PageCommentTokenSource/)
    assert.match(helper, /hasCommentToken: boolean/)
    // 'cloak_browser' → bridge /page-comment via the shared fail-closed helper, Page story id.
    assert.match(helper, /params\.commentSource === 'cloak_browser'[\s\S]*sendPageCommentViaCloakBridge\(\{[\s\S]*storyId,[\s\S]*message: commentText/)
    // 'stored_token' → deferred to the pending backlog (never silently uses the bridge).
    assert.match(helper, /else if \(params\.hasCommentToken\) \{[\s\S]*commentStatus = 'pending'[\s\S]*commentDueAt = new Date\(/)
    // Missing stored comment token fails per existing stored semantics.
    assert.match(helper, /commentError = 'access_token_missing'/)
    // The comment target is the Page story id — never the ad id or video id.
    assert.ok(!/story_id: adId/.test(helper), 'comment must not target the ad id')
    assert.ok(!/story_id: videoId/.test(helper), 'comment must not target the video id')
})

test('create-ad route forwards skip_ad to the bridge (post-first Phase A: publish post, no ad)', () => {
    const routeSource = getDashboardCreateAdRouteSource()
    assert.match(routeSource, /skip_ad\?: boolean/)
    assert.match(routeSource, /const skipAd = body\.skip_ad === true/)
    // Phase A bridge call includes skip_ad so the bridge stops after publishing the post.
    assert.match(routeSource, /\.\.\.\(skipAd \? \{ skip_ad: true \} : \{\}\)/)
    // Phase A must not forward any Worker redirect or pre-final visible CTA payload.
    assert.doesNotMatch(routeSource, /cta_redirect_url/)
    assert.doesNotMatch(routeSource, /onecard-cta/)
})

test('post-first OneCard is opt-in via ADS_POST_FIRST_ENABLED and runs A→mint→B(promote)→comment', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    // Env gate, default off.
    assert.match(source, /function oneCardPostFirstEnabled\(env: Env\): boolean \{[\s\S]*ADS_POST_FIRST_ENABLED/)

    const helper = getPostFirstHelperSource()
    // Phase A: create-ad with skip_ad + skip_comment (publish post only), with no visible CTA URL.
    assert.match(helper, /\/api\/dashboard\/create-ad`[\s\S]*skip_ad: true,[\s\S]*skip_comment: true/)
    assert.doesNotMatch(helper, /cta_redirect_url/)
    assert.doesNotMatch(helper, /onecard-cta/)
    assert.doesNotMatch(helper, /api\.pubilo\.com\/onecard-cta/)
    // Mint the final link (sub2=post id, sub3=page id) AFTER the post id exists.
    assert.match(helper, /remintOneCardCommentShortlink\(\{[\s\S]*storyId,[\s\S]*managedShopeeLink: params\.managedShopeeLink/)
    // Fail closed before Phase B unless re-mint produced the direct final Shopee shortlink.
    // The step name must not imply an organic page CTA change.
    assert.match(helper, /if \(!remint\.reminted \|\| !isDirectShopeeShortlink\(finalLink\)\) \{[\s\S]*final_shortlink_mint/)
    // Phase B: promote the ad with the FINAL link in the CTA, reusing the Phase A video.
    assert.match(helper, /\$\{baseUrl\}\/promote`[\s\S]*video_id: videoId[\s\S]*final_cta_link: finalLink/)
    // The visible-page CTA report is taken strictly from the bridge value (organic post
    // unchanged → false), never inferred from the promoted-ad link.
    assert.match(helper, /visiblePageCtaLink = String\(dataB\.visible_page_cta_link \|\| ''\)\.trim\(\)/)
    assert.match(helper, /visiblePageCtaFinal = dataB\.visible_page_cta_final === true/)
    assert.doesNotMatch(helper, /visible_page_cta_link \|\| dataB\.promoted_ad_cta_link/)
    // Comment the SAME final link on the visible post, as the Page, via the shared fail-closed
    // bridge helper targeting the Page story id.
    assert.match(helper, /sendPageCommentViaCloakBridge\(\{[\s\S]*storyId,[\s\S]*message: commentText/)
    // CTA/comment parity flag is only true when the final link was actually re-minted.
    assert.match(helper, /ctaParity: !!finalLink && remint\.reminted/)
    // Never publishes a second page post — that is the bridge /promote contract; helper must
    // not call /post or re-publish.
    assert.doesNotMatch(helper, /\/post`/)
})

test('post-first Phase B success is gated on the promoted-ad CTA only, never the organic page CTA', () => {
    const helper = getPostFirstHelperSource()
    // Phase B success is proven by the PROMOTED AD creative CTA: final + direct Shopee shortlink.
    assert.match(helper, /promotedAdCtaFinal: !!adId && !!finalLink && remint\.reminted/)
    assert.match(helper, /!dataB\.promoted_ad_cta_final/)
    assert.match(helper, /promotedCtaLink !== finalLink/)
    assert.match(helper, /!isDirectShopeeShortlink\(promotedCtaLink\)/)
    // It must NOT require any organic/visible page CTA change (the old wrong assumption).
    assert.doesNotMatch(helper, /visibleCtaLink !== finalLink/)
    assert.doesNotMatch(helper, /!isDirectShopeeShortlink\(visibleCtaLink\)/)
    assert.doesNotMatch(helper, /!dataB\.visible_page_cta_final \|\|/)
    // The visible-page report mirrors the bridge value (false) and only claims parity when the
    // bridge itself confirmed a final visible CTA — which it does not for the promoted-ad flow.
    assert.match(helper, /visiblePageCtaFinal,/)
    assert.match(helper, /visiblePageCtaCommentParity: visiblePageCtaFinal && visiblePageCtaLink === finalLink/)

    // The FORCE-POST response must report parity PER OBJECT and must not claim the visible page
    // CTA equals the comment unless Phase B confirmed the final link. cta_comment_parity is back-compat ==
    // the promoted ad only.
    const forceSource = getForcePostRouteSource()
    assert.match(forceSource, /cta_comment_parity: pf\.promotedAdCtaFinal/)
    assert.match(forceSource, /promoted_ad_cta_comment_parity: pf\.promotedAdCtaFinal/)
    assert.match(forceSource, /visible_page_cta_comment_parity: pf\.visiblePageCtaCommentParity/)
    assert.match(forceSource, /visible_page_cta_final: pf\.visiblePageCtaFinal/)
    assert.match(forceSource, /visible_page_cta_link: pf\.visiblePageCtaFinal \? \(pf\.visiblePageCtaLink \|\| pf\.ctaShortlink \|\| null\) : null/)
    assert.doesNotMatch(forceSource, /visible_page_cta_redirect_url/)
    assert.doesNotMatch(forceSource, /onecard-cta/)
    // The visible page CTA parity must NEVER be wired to the promoted-ad flag (no overclaim).
    assert.doesNotMatch(forceSource, /visible_page_cta_comment_parity: pf\.(ctaParity|promotedAdCtaFinal)/)
})

test('public onecard CTA redirect route is removed from production path', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    assert.doesNotMatch(source, /app\.get\('\/onecard-cta\/:key'/)
    assert.doesNotMatch(source, /onecard-cta/)
    assert.doesNotMatch(source, /cta_redirect_url/)
    assert.doesNotMatch(source, /onecard-cta-redirect/)
})

test('both ads branches gate post-first behind the env flag (default off keeps create-ad path)', () => {
    const forceSource = getForcePostRouteSource()
    const cronSource = getHandleScheduledSource()
    for (const [label, src] of [['force-post', forceSource], ['cron', cronSource]] as const) {
        assert.match(src, /if \(oneCardPostFirstEnabled\(env\)\) \{[\s\S]*runOneCardPostFirstAds\(\{/, `${label} must gate post-first behind the flag`)
        // The single-shot create-ad path is still present (flag-off fallback).
        assert.match(src, /cleanShortLink|comment_shortlink: normalizedShopeeLink/, `${label} keeps the create-ad fallback`)
    }
})

// ============================================================================
// EXPLORE — WATCHED EXTERNAL PAGES (read-only feature, distinct from owned pages)
// ============================================================================

function getExternalWatchedBlockSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('// EXPLORE — WATCHED EXTERNAL FACEBOOK PAGES')
    assert.notEqual(start, -1, 'explore external watched-pages block must exist')
    const end = source.indexOf("app.get('/api/dashboard/facebook-page-sources'", start)
    assert.notEqual(end, -1, 'explore block end marker must exist')
    return source.slice(start, end)
}

function getExternalRouteSource(routeStart: string, routeEnd: string): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf(routeStart)
    assert.notEqual(start, -1, `${routeStart} must exist`)
    const end = source.indexOf(routeEnd, start + routeStart.length)
    assert.notEqual(end, -1, `${routeStart} end marker (${routeEnd}) must exist`)
    return source.slice(start, end)
}

test('explore uses distinct external tables, separate from owned posting pages', () => {
    const block = getExternalWatchedBlockSource()
    assert.match(block, /CREATE TABLE IF NOT EXISTS dashboard_external_watched_pages/)
    assert.match(block, /CREATE TABLE IF NOT EXISTS dashboard_external_page_posts/)
    // Provenance columns are preserved on the cached posts.
    for (const col of ['page_key', 'page_name', 'post_id', 'video_id', 'permalink_url', 'source_url', 'picture', 'views', 'created_time']) {
        assert.match(block, new RegExp(`\\b${col}\\b`), `external posts must store ${col}`)
    }
    // Tables are namespace-scoped via composite primary keys.
    assert.match(block, /PRIMARY KEY \(namespace_id, page_key\)/)
    assert.match(block, /PRIMARY KEY \(namespace_id, page_key, post_id\)/)
    // It must NOT reuse the owned-page tables for the watch list.
    assert.doesNotMatch(block, /INSERT INTO pages\b/)
    assert.doesNotMatch(block, /facebook_page_video_cache/)
})

test('explore never gates on page ownership / is_active / posting token source / ad flow', () => {
    const block = getExternalWatchedBlockSource()
    assert.doesNotMatch(block, /is_active/)
    assert.doesNotMatch(block, /post_tokens/)
    assert.doesNotMatch(block, /comment_tokens/)
    assert.doesNotMatch(block, /getNamespacePagesTokenPool/)
    assert.doesNotMatch(block, /create-ad|createAd|dashboard_ad_history/)
})

test('explore is read-only against Facebook (no posting/commenting/ads endpoints)', () => {
    const block = getExternalWatchedBlockSource()
    // No Graph WRITE/publish calls: external sync only reads /posts + /{id} fields.
    assert.doesNotMatch(block, /method:\s*'POST'[\s\S]*graph\.facebook\.com/)
    assert.doesNotMatch(block, /\/page-comment|\/feed['"`]|publishReel|buildAffiliateCommentMessage/)
    // The Graph reads it does make are GET /posts and a name lookup only.
    assert.match(block, /\/posts\?\$\{params\.toString\(\)\}/)
    assert.match(block, /fields=name&access_token/)
})

test('explore resolves a read-only sync token and surfaces missing token as status, not a crash', () => {
    const block = getExternalWatchedBlockSource()
    assert.match(block, /resolveFacebookSyncToken\(env\.DB, key, ns\)/)
    assert.match(block, /last_error: 'facebook_sync_token_missing'/)
    // syncExternalWatchedPage captures Graph failures into last_error and returns ok:false.
    assert.match(block, /last_error: message\.slice\(0, 200\)/)
    // Never returns raw token to the client.
    assert.doesNotMatch(block, /token:\s*token\b/)
})

test('normalizeExternalPageInput whitelists keys and rejects junk', () => {
    const block = getExternalWatchedBlockSource()
    assert.match(block, /function normalizeExternalPageInput/)
    // Numeric ids, profile.php?id=, /people|/pages/<id>, and vanity slugs are handled.
    assert.match(block, /profile\.php/)
    assert.match(block, /people' \|\| first === 'pages'/)
    // Key charset is whitelisted so it is safe to interpolate into a Graph path.
    assert.match(block, /\[A-Za-z0-9\.\]\[A-Za-z0-9\._-\]/)
    // Host is validated against facebook.com / fb.com before accepting a URL.
    assert.match(block, /const host = parsed\.hostname\.toLowerCase\(\)/)
})

test('explore add/patch/delete/sync routes are auth-gated; GET reads are namespace-scoped', () => {
    const addRoute = getExternalRouteSource("app.post('/api/dashboard/explore/watched-pages'", "app.patch('/api/dashboard/explore/watched-pages/:pageKey'")
    const patchRoute = getExternalRouteSource("app.patch('/api/dashboard/explore/watched-pages/:pageKey'", "app.delete('/api/dashboard/explore/watched-pages/:pageKey'")
    const deleteRoute = getExternalRouteSource("app.delete('/api/dashboard/explore/watched-pages/:pageKey'", "app.post('/api/dashboard/explore/sync'")
    const syncRoute = getExternalRouteSource("app.post('/api/dashboard/explore/sync'", "app.get('/api/dashboard/explore/posts'")
    for (const [label, src] of [['add', addRoute], ['patch', patchRoute], ['delete', deleteRoute], ['sync', syncRoute]] as const) {
        assert.match(src, /requireAuthSession\(c\)/, `${label} route must require auth`)
        assert.match(src, /c\.get\('botId'\)/, `${label} route must be namespace-scoped`)
    }
    // GET routes resolve the namespace from x-bot-id (c.get('botId')) too.
    const listRoute = getExternalRouteSource("app.get('/api/dashboard/explore/watched-pages'", "app.post('/api/dashboard/explore/watched-pages'")
    const postsRoute = getExternalRouteSource("app.get('/api/dashboard/explore/posts'", "app.get('/api/dashboard/facebook-page-sources'")
    assert.match(listRoute, /c\.get\('botId'\)/)
    assert.match(postsRoute, /c\.get\('botId'\)/)
})

test('explore cron sync is bounded, cooldown-gated, and wired into the scheduled handler', () => {
    const block = getExternalWatchedBlockSource()
    assert.match(block, /EXTERNAL_WATCHED_CRON_MAX_PER_TICK = 2/)
    assert.match(block, /EXTERNAL_WATCHED_CRON_COOLDOWN_MS/)
    assert.match(block, /function maybeSyncExternalWatchedPagesOnSchedule/)
    assert.match(block, /enabled = 1/)
    assert.match(block, /LIMIT \?/)
    const source = readFileSync('src/index.ts', 'utf8')
    // The scheduled handler runs it in its own waitUntil with error swallow.
    assert.match(source, /_ctx\.waitUntil\(maybeSyncExternalWatchedPagesOnSchedule\(env\)\.catch/)
})
