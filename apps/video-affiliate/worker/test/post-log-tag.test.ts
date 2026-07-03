import assert from 'node:assert/strict'
import test from 'node:test'
import {
    POST_LOG_CODE_LENGTH,
    POST_LOG_CODE_ALPHABET,
    POST_LOG_CODE_RE,
    generatePostLogCode,
    isValidPostLogCode,
    normalizePostLogCode,
    formatPostLogHashtag,
    extractExistingPostLogCode,
    resolveCaptionWithPostLogTag,
    isPostLogTagStampingEnabledForNamespace,
    isSecretKey,
    sanitizeSnapshot,
    serializeSnapshot,
    buildPostLogRecord,
    toSafePostLogOutput,
} from '../src/post-log-tag.js'

// ---------------------------------------------------------------------------------------
// Code generation: shape + uniqueness + determinism
// ---------------------------------------------------------------------------------------

test('generatePostLogCode returns 6 base36-lowercase chars', () => {
    assert.equal(POST_LOG_CODE_LENGTH, 6)
    for (let i = 0; i < 500; i++) {
        const code = generatePostLogCode()
        assert.equal(code.length, 6)
        assert.ok(POST_LOG_CODE_RE.test(code), `bad code shape: ${code}`)
        for (const ch of code) assert.ok(POST_LOG_CODE_ALPHABET.includes(ch))
    }
})

test('generatePostLogCode is effectively unique across many draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(generatePostLogCode())
    // 36^6 ≈ 2.2B space — collisions across 5000 draws must be vanishingly rare.
    assert.ok(seen.size >= 4995, `too many collisions: ${5000 - seen.size}`)
})

test('generatePostLogCode is deterministic with an injected random source', () => {
    // rng returns 0 → every index 0 → all first-alphabet char ('a').
    assert.equal(generatePostLogCode(() => 0), 'aaaaaa')
    // A fixed sequence maps to fixed alphabet indices. Use mid-bucket values ((idx+0.5)/36)
    // so float rounding can never tip floor() into an adjacent bucket.
    const indices = [0, 1, 2, 35, 10, 11] // a b c 9 k l
    const seq = indices.map((idx) => (idx + 0.5) / 36)
    let i = 0
    const code = generatePostLogCode(() => seq[i++])
    assert.equal(code, 'abc9kl')
})

test('isValidPostLogCode / normalizePostLogCode', () => {
    assert.ok(isValidPostLogCode('f2skgi'))
    assert.ok(!isValidPostLogCode('F2SKGI')) // uppercase not a stored code
    assert.ok(!isValidPostLogCode('abc'))
    assert.ok(!isValidPostLogCode('toolong7'))
    assert.equal(normalizePostLogCode('#F2SKGI'), 'f2skgi')
    assert.equal(normalizePostLogCode('  #f2skgi '), 'f2skgi')
    assert.equal(normalizePostLogCode('f2skgi'), 'f2skgi')
    assert.equal(normalizePostLogCode('#shopee!'), '')
    assert.equal(normalizePostLogCode(null), '')
    assert.equal(formatPostLogHashtag('f2skgi'), '#f2skgi')
})

// ---------------------------------------------------------------------------------------
// Caption append + idempotency (preserve Thai hashtags, never double, no false positives)
// ---------------------------------------------------------------------------------------

const THAI_CAPTION = 'สินค้าดีมาก คุ้มสุด ๆ\n#shopee #ของมันต้องมี'

test('resolveCaptionWithPostLogTag appends the tag inline on the final caption line exactly once', () => {
    const r = resolveCaptionWithPostLogTag({ caption: THAI_CAPTION, code: 'f2skgi' })
    assert.equal(r.appended, true)
    assert.equal(r.alreadyPresent, false)
    assert.equal(r.code, 'f2skgi')
    assert.equal(r.hashtag, '#f2skgi')
    assert.equal(r.caption, 'สินค้าดีมาก คุ้มสุด ๆ\n#f2skgi #shopee #ของมันต้องมี')
    // Existing Thai hashtags are preserved verbatim and the log tag stays inline.
    assert.ok(r.caption.includes('#f2skgi #shopee #ของมันต้องมี'))
})

test('resolveCaptionWithPostLogTag on empty caption returns just the tag', () => {
    const r = resolveCaptionWithPostLogTag({ caption: '', code: 'abc123' })
    assert.equal(r.caption, '#abc123')
    assert.equal(r.appended, true)
})

test('resolveCaptionWithPostLogTag trims trailing spaces before inline tag append', () => {
    const r = resolveCaptionWithPostLogTag({ caption: 'ข้อความสินค้า   ', code: 'z0lqfm' })
    assert.equal(r.caption, 'ข้อความสินค้า #z0lqfm')
})

test('resolveCaptionWithPostLogTag puts the log tag first on an existing hashtag line', () => {
    const r = resolveCaptionWithPostLogTag({ caption: 'ข้อความสินค้า\n   #shopee #ของมันต้องมี', code: 'zolqfm' })
    assert.equal(r.caption, 'ข้อความสินค้า\n   #zolqfm #shopee #ของมันต้องมี')
})

test('resolveCaptionWithPostLogTag is idempotent — never doubles the tag', () => {
    const once = resolveCaptionWithPostLogTag({ caption: THAI_CAPTION, code: 'f2skgi' })
    // Re-stamping the already-stamped caption with the SAME code is a no-op.
    const twice = resolveCaptionWithPostLogTag({ caption: once.caption, code: 'f2skgi' })
    assert.equal(twice.caption, once.caption)
    assert.equal(twice.appended, false)
    assert.equal(twice.alreadyPresent, true)
    assert.equal(twice.code, 'f2skgi')
})

test('resolveCaptionWithPostLogTag does not add a second tag when a DIFFERENT log tag exists', () => {
    const stamped = `${THAI_CAPTION}\n#aaaaaa`
    const r = resolveCaptionWithPostLogTag({ caption: stamped, code: 'zzzzzz' })
    // Reuses the existing lone tag, never appends a competing one.
    assert.equal(r.appended, false)
    assert.equal(r.alreadyPresent, true)
    assert.equal(r.code, 'aaaaaa')
    assert.equal(r.caption, stamped)
    assert.ok(!r.caption.includes('#zzzzzz'))
})

test('inline 6-letter hashtags like #shopee are NOT mistaken for a log tag', () => {
    // "#shopee" is 6 chars [a-z] but lives inline among other tags — must not be detected,
    // so a real log tag still gets appended.
    assert.equal(extractExistingPostLogCode(THAI_CAPTION), null)
    const r = resolveCaptionWithPostLogTag({ caption: THAI_CAPTION, code: 'f2skgi' })
    assert.equal(r.appended, true)
    assert.equal(r.caption, 'สินค้าดีมาก คุ้มสุด ๆ\n#f2skgi #shopee #ของมันต้องมี')
})

test('extractExistingPostLogCode matches a lone tag line or final inline log token', () => {
    assert.equal(extractExistingPostLogCode('hello\n#f2skgi'), 'f2skgi')
    assert.equal(extractExistingPostLogCode('#f2skgi'), 'f2skgi')
    assert.equal(extractExistingPostLogCode('  #f2skgi  '), 'f2skgi')
    assert.equal(extractExistingPostLogCode('hello #f2skgi'), 'f2skgi')
    assert.equal(extractExistingPostLogCode('#shopee #sale12'), 'sale12')
    assert.equal(extractExistingPostLogCode('text #f2skgi more'), null)
    assert.equal(extractExistingPostLogCode(''), null)
})


// ---------------------------------------------------------------------------------------
// Namespace gate — visible log hashtag is admin-only by default
// ---------------------------------------------------------------------------------------

test('isPostLogTagStampingEnabledForNamespace enables only primary admin namespace by default', () => {
    const admin = '1774858894802785816'
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: admin, adminNamespaceId: admin }), true)
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: '1775187092060317951', adminNamespaceId: admin }), false)
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: 'default', adminNamespaceId: admin }), false)
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: '', adminNamespaceId: admin }), false)
})

test('isPostLogTagStampingEnabledForNamespace can widen via explicit allowlist only', () => {
    const admin = '1774858894802785816'
    const member = '1775187092060317951'
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: member, adminNamespaceId: admin, enabledNamespaces: member }), true)
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: member, adminNamespaceId: admin, enabledNamespaces: '1779705687536764750,1778261517757841035' }), false)
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: member, adminNamespaceId: admin, enabledNamespaces: '*' }), true)
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: member, adminNamespaceId: admin, enabledNamespaces: 'all' }), true)
    // Admin remains enabled even if the optional allowlist omits it.
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: admin, adminNamespaceId: admin, enabledNamespaces: member }), true)
})

// ---------------------------------------------------------------------------------------
// Namespace gating — the visible `#code` hashtag is ADMIN-ONLY
// ---------------------------------------------------------------------------------------

const ADMIN_NS = '1774858894802785816' // primary admin namespace (page เฉียบ), from live evidence

test('admin namespace gets the post log tag stamped', () => {
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({ namespaceId: ADMIN_NS, adminNamespaceId: ADMIN_NS }),
        true,
    )
    // Namespace ids are Discord/snowflake-sized strings; unsafe JS numbers lose precision
    // and must not accidentally enable public tags for the wrong namespace.
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({ namespaceId: Number(ADMIN_NS), adminNamespaceId: ADMIN_NS }),
        false,
    )
})

test('non-admin / member namespace does NOT get the post log tag', () => {
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({ namespaceId: '61550488976801', adminNamespaceId: ADMIN_NS }),
        false,
    )
    // With no allowlist, ANY namespace other than admin is disabled.
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({ namespaceId: '9999999999', adminNamespaceId: ADMIN_NS }),
        false,
    )
})

test('gating fails closed when there is no resolvable admin namespace', () => {
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: ADMIN_NS, adminNamespaceId: '' }), false)
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: ADMIN_NS, adminNamespaceId: null }), false)
    // Empty / sentinel `default` namespace never gets a tag.
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: '', adminNamespaceId: ADMIN_NS }), false)
    assert.equal(isPostLogTagStampingEnabledForNamespace({ namespaceId: 'default', adminNamespaceId: ADMIN_NS }), false)
})

test('env allowlist can widen stamping, but only by explicit opt-in', () => {
    // Explicitly listed member namespace is enabled...
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({
            namespaceId: '61550488976801',
            adminNamespaceId: ADMIN_NS,
            enabledNamespaces: '61550488976801, 222',
        }),
        true,
    )
    // ...but one NOT listed stays disabled (allowlist is not "all").
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({
            namespaceId: '333',
            adminNamespaceId: ADMIN_NS,
            enabledNamespaces: '61550488976801, 222',
        }),
        false,
    )
    // Admin still gets its tag even if the allowlist omits it.
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({
            namespaceId: ADMIN_NS,
            adminNamespaceId: ADMIN_NS,
            enabledNamespaces: '61550488976801',
        }),
        true,
    )
    // `*` / `all` is a deliberate global opt-in.
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({ namespaceId: '333', adminNamespaceId: ADMIN_NS, enabledNamespaces: '*' }),
        true,
    )
    assert.equal(
        isPostLogTagStampingEnabledForNamespace({ namespaceId: '333', adminNamespaceId: '', enabledNamespaces: 'all' }),
        true,
    )
})

// ---------------------------------------------------------------------------------------
// Token-free record shaping — no secrets ever
// ---------------------------------------------------------------------------------------

test('isSecretKey flags token/cookie/secret-shaped keys', () => {
    for (const k of ['access_token', 'accessToken', 'fb_dtsg', 'cookie', 'Cookie', 'password',
        'client_secret', 'datr', 'totp', 'api_key', 'authorization', 'bearer', 'refresh_token',
        'c_user', 'jwt']) {
        assert.ok(isSecretKey(k), `${k} should be secret`)
    }
    for (const k of ['page_id', 'story_id', 'caption', 'shopee_link', 'status', 'hashtag']) {
        assert.ok(!isSecretKey(k), `${k} should NOT be secret`)
    }
})

test('sanitizeSnapshot deep-strips secret keys from objects and arrays', () => {
    const dirty = {
        page_id: '123',
        access_token: 'FAKE_SECRET_TOKEN',
        nested: { cookie: 'datr=xyz', story_id: 's1', creds: { password: 'p', ok: true } },
        list: [{ fb_dtsg: 'zzz', keep: 'yes' }],
    }
    const clean = sanitizeSnapshot(dirty) as Record<string, any>
    assert.equal(clean.page_id, '123')
    assert.equal('access_token' in clean, false)
    assert.equal('cookie' in clean.nested, false)
    assert.equal(clean.nested.story_id, 's1')
    assert.equal('password' in clean.nested.creds, false)
    assert.equal(clean.nested.creds.ok, true)
    assert.equal('fb_dtsg' in clean.list[0], false)
    assert.equal(clean.list[0].keep, 'yes')
    // Round-trip is JSON-serializable and secret-free.
    assert.ok(!serializeSnapshot(dirty).includes('FAKE_SECRET_TOKEN'))
    assert.ok(!serializeSnapshot(dirty).includes('password'))
})

test('buildPostLogRecord produces a token-free flat row with normalized fields', () => {
    const record = buildPostLogRecord({
        log_code: '#F2SKGI',
        bot_id: 61550488976801,
        page_id: 1008898512617594,
        page_name: 'เฉียบ',
        history_id: '30224',
        story_id: '1008898512617594_9988',
        shopee_link: 'https://s.shopee.co.th/abc',
        sub_ids: { sub1: 'CAMP', sub2: '9988', sub3: '1008898512617594' },
        posting_source: 'cloak_onecard_bridge',
        comment_source: 'cloak_browser',
        status: 'posting',
        snapshot: { access_token: 'FAKE_LEAK_TOKEN', fb_dtsg: 'x', page_name: 'เฉียบ' },
    })
    assert.equal(record.log_code, 'f2skgi')
    assert.equal(record.hashtag, '#f2skgi')
    assert.equal(record.bot_id, '61550488976801')
    assert.equal(record.page_id, '1008898512617594')
    assert.equal(record.history_id, 30224)
    assert.equal(record.status, 'posting')
    assert.equal(typeof record.sub_ids, 'string')
    assert.deepEqual(JSON.parse(record.sub_ids), { sub1: 'CAMP', sub2: '9988', sub3: '1008898512617594' })
    // Snapshot must be secret-free.
    assert.ok(!record.snapshot_json.includes('FAKE_LEAK_TOKEN'))
    assert.ok(!record.snapshot_json.includes('fb_dtsg'))
    assert.ok(record.snapshot_json.includes('เฉียบ'))
    // Whole serialized row must never contain a token/cookie value.
    const wire = JSON.stringify(record)
    assert.ok(!wire.includes('FAKE_LEAK_TOKEN'))
})

test('buildPostLogRecord handles missing/null history id and empty fields', () => {
    const record = buildPostLogRecord({ log_code: 'abc123' })
    assert.equal(record.history_id, null)
    assert.equal(record.story_id, '')
    assert.equal(record.shopee_link, '')
    assert.equal(record.snapshot_json, '')
    assert.equal(record.sub_ids, '')
})

test('toSafePostLogOutput strips secrets and parses embedded JSON', () => {
    const row = {
        log_code: 'f2skgi',
        page_id: '123',
        access_token: 'FAKE_SHOULD_NOT_BE_HERE',
        snapshot_json: JSON.stringify({ story_id: 's1', cookie: 'datr=x', ok: true }),
        sub_ids: JSON.stringify({ sub1: 'CAMP', session_secret: 'nope' }),
    }
    const safe = toSafePostLogOutput(row) as Record<string, any>
    assert.equal(safe.log_code, 'f2skgi')
    assert.equal('access_token' in safe, false)
    assert.equal(safe.snapshot.story_id, 's1')
    assert.equal('cookie' in safe.snapshot, false)
    assert.equal(safe.sub_ids_parsed.sub1, 'CAMP')
    assert.equal('session_secret' in safe.sub_ids_parsed, false)
    assert.equal(toSafePostLogOutput(null), null)
})
