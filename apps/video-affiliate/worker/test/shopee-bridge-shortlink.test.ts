import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// These are source-string assertions (the same style as page-post-link-rewrite and
// posting-token-source guards) because the Shopee bridge minting path lives inside
// the large Worker entry module `src/index.ts` and is gated behind two new env vars.
const source = readFileSync('src/index.ts', 'utf8')

function slice(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker)
    assert.ok(start > -1, `${startMarker} must exist`)
    const end = source.indexOf(endMarker, start)
    assert.ok(end > start, `${endMarker} must exist after ${startMarker}`)
    return source.slice(start, end)
}

test('Env type declares the Shopee bridge URL + token', () => {
    const pipeline = readFileSync('src/pipeline.ts', 'utf8')
    assert.match(pipeline, /SHOPEE_BRIDGE_API_URL\?:\s*string/)
    assert.match(pipeline, /SHOPEE_BRIDGE_API_TOKEN\?:\s*string/)
})

test('shortenShopeeLinkForNamespace mints via the bridge only when URL + token are configured', () => {
    const fn = slice('async function shortenShopeeLinkForNamespace', 'function isManagedShortlinkTransientFailure')
    assert.match(fn, /params\.env\.SHOPEE_BRIDGE_API_URL/)
    assert.match(fn, /params\.env\.SHOPEE_BRIDGE_API_TOKEN/)
    // Both must be present before the bridge branch runs.
    assert.match(fn, /if\s*\(bridgeApiUrl\s*&&\s*bridgeApiToken\)/)
    // The bridge branch must come BEFORE the legacy urlTemplate/baseUrl path so it
    // does not depend on the legacy customlink settings being configured.
    assert.ok(
        fn.indexOf('bridgeApiUrl && bridgeApiToken') < fn.indexOf('const urlTemplate = shortlinkSettings.urlTemplate'),
        'bridge branch must precede the legacy urlTemplate path'
    )
})

test('bridge branch maps sub1=campaign, sub2=page id, sub3=post/reel tail', () => {
    const fn = slice('async function shortenShopeeLinkForNamespace', 'function isManagedShortlinkTransientFailure')
    const branchStart = fn.indexOf('if (bridgeApiUrl && bridgeApiToken)')
    const branchEnd = fn.indexOf('const urlTemplate = shortlinkSettings.urlTemplate', branchStart)
    const branch = fn.slice(branchStart, branchEnd)
    assert.match(branch, /sub1:\s*effectiveSub1/)
    assert.match(branch, /sub2:\s*effectiveSub2/)
    assert.match(branch, /sub3:\s*effectiveSub3/)
})

test('bridge failure fails closed — never a raw fallback link', () => {
    const fn = slice('async function shortenShopeeLinkForNamespace', 'function isManagedShortlinkTransientFailure')
    const branchStart = fn.indexOf('if (bridgeApiUrl && bridgeApiToken)')
    const branchEnd = fn.indexOf('const urlTemplate = shortlinkSettings.urlTemplate', branchStart)
    const branch = fn.slice(branchStart, branchEnd)
    // On exhausting retries the branch traces a fallback error and returns '' (blocking
    // admin posting), never the raw originalLink.
    assert.match(branch, /status:\s*'fallback'/)
    assert.match(branch, /return ''/)
    assert.doesNotMatch(branch, /return originalLink/)
})

test('bridge response validation requires ok + affiliateVerified + direct shortlink + utm_content', () => {
    const validator = slice('function assertShopeeBridgeResponse', 'async function mintShopeeShortlinkViaBridge')
    // ok:true is mandatory.
    assert.match(validator, /data\.ok\s*!==\s*true/)
    // affiliateVerified must be true.
    assert.match(validator, /affiliateVerified\s*!==\s*true/)
    assert.match(validator, /shopee_bridge_affiliate_unverified/)
    // shortLink must be a direct s.shopee.co.th link.
    assert.match(validator, /isDirectShopeeShortlink\(shortLink\)/)
    // utm_content exactly `${sub1}-${sub2}-${sub3}--` when the full triple is present.
    assert.match(validator, /`\$\{subs\.sub1\}-\$\{subs\.sub2\}-\$\{subs\.sub3\}--`/)
    assert.match(validator, /shopee_bridge_utm_mismatch/)
    // Only assert utm_content when all three sub ids exist (pre-posting calls omit them).
    assert.match(validator, /if\s*\(subs\.sub1\s*&&\s*subs\.sub2\s*&&\s*subs\.sub3\)/)
})

test('bridge request uses browser-like UA + bearer/x-bridge-token headers and POST JSON body', () => {
    const minter = slice('async function mintShopeeShortlinkViaBridge', 'function isManagedShortlinkTransientFailure')
    assert.match(minter, /method:\s*'POST'/)
    assert.match(minter, /'authorization':\s*`Bearer \$\{args\.apiToken\}`/)
    assert.match(minter, /'x-bridge-token':\s*args\.apiToken/)
    assert.match(minter, /'user-agent':\s*'Mozilla\/5\.0/)
    // POST JSON body carries url + sub1 (sub2/sub3 optional).
    assert.match(minter, /url:\s*args\.originalLink/)
    assert.match(minter, /JSON\.stringify\(payload\)/)
})
