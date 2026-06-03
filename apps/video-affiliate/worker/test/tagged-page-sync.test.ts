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

function getPrePostingShortlinkResolverSource(): string {
    const source = readFileSync('src/index.ts', 'utf8')
    const start = source.indexOf('async function resolvePrePostingShortlinksForNamespace')
    assert.notEqual(start, -1, 'resolvePrePostingShortlinksForNamespace must exist')

    const end = source.indexOf('\nasync function resolvePostingShopeeLinkForNamespace', start)
    assert.notEqual(end, -1, 'pre-posting shortlink resolver end marker must exist')

    return source.slice(start, end)
}

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
