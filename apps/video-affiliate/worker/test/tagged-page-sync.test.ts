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
    const publishAt = functionSource.indexOf('publishReelWithCommentTokenPrimaryFallback({')
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
    const publishAt = routeSource.indexOf('publishReelWithCommentTokenPrimaryFallback({')

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
    const publishAt = routeSource.indexOf('publishReelWithCommentTokenPrimaryFallback({')

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

test('posting comment shortlink override carries sub4 log id and omits sub5', () => {
    const shortenerSource = getShortenShopeeLinkForNamespaceSource()
    const resolverSource = getPostingShopeeLinkResolverSource()

    assert.match(shortenerSource, /postSubId4\?: string/)
    assert.match(shortenerSource, /hasPostSubId4Override = params\.postSubId4 !== undefined/)
    assert.match(shortenerSource, /effectiveSub4 = hasPostSubId4Override \? overriddenSub4 : subIds\.sub4/)
    assert.match(shortenerSource, /effectiveSub5 = hasPostSubId4Override \? '' : subIds\.sub5/)
    assert.match(shortenerSource, /if \(effectiveSub4\) requestUrl\.searchParams\.set\('sub4', effectiveSub4\)/)
    assert.match(shortenerSource, /if \(effectiveSub5\) requestUrl\.searchParams\.set\('sub5', effectiveSub5\)/)
    assert.match(resolverSource, /postSubId4\?: string/)
    assert.match(resolverSource, /postSubId4:\s*params\.postSubId4/)
})

test('pending comments pass post_history id as postSubId4 when minting comment shortlink', () => {
    const pendingSource = getPendingCommentBacklogSource()

    assert.match(pendingSource, /const historyId = Number\(row\.id \|\| 0\)/)
    assert.match(pendingSource, /buildPostingCommentShortlinkSubIds\(\{[\s\S]*historyId,[\s\S]*logPrefix: `PENDING-COMMENT/)
    assert.match(pendingSource, /resolvePostingShopeeLinkForNamespace\(\{[\s\S]*\.\.\.commentSubIds/)
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
    assert.match(routeSource, /\/comments\?fields=id,from,message,created_time&limit=10&access_token=\$\{encodeURIComponent\(token\)\}/)
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
