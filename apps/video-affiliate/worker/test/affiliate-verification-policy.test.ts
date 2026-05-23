import assert from 'node:assert/strict'
import test from 'node:test'
import {
    finalizePostingAffiliateVerification,
    validateAffiliateCommentPreflight,
    type PostingAffiliatePlatformVerification,
} from '../src/affiliate-verification-policy.js'

function platform(overrides: Partial<PostingAffiliatePlatformVerification> = {}): PostingAffiliatePlatformVerification {
    return {
        inputLink: '',
        resolvedLink: '',
        expectedId: '',
        actualId: '',
        status: 'skipped',
        match: null,
        error: null,
        ...overrides,
    }
}

test('enforced namespace blocks Shopee when an expected id exists but no link is present', () => {
    const result = finalizePostingAffiliateVerification({
        enforced: true,
        shopee: platform({ expectedId: '15130770000', status: 'missing_link' }),
        lazada: platform(),
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.shopee.status, 'missing_link')
    assert.equal(result.shopee.match, 0)
    assert.match(result.error || '', /Shopee affiliate link missing/)
})

test('enforced namespace blocks Lazada when a present link cannot resolve member_id', () => {
    const result = finalizePostingAffiliateVerification({
        enforced: true,
        shopee: platform(),
        lazada: platform({
            inputLink: 'https://s.lazada.co.th/example',
            expectedId: '199431090',
            status: 'skipped',
            match: 0,
        }),
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.lazada.status, 'mismatch')
    assert.equal(result.lazada.match, 0)
    assert.match(result.error || '', /Lazada member_id missing/)
})

test('enforced namespace blocks Lazada when caller marks Lazada as required but no link is present', () => {
    const result = finalizePostingAffiliateVerification({
        enforced: true,
        shopee: platform(),
        lazada: platform({ expectedId: '199431090', status: 'missing_link' }),
        lazadaRequired: true,
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.lazada.status, 'missing_link')
    assert.match(result.error || '', /Lazada affiliate link missing/)
})

test('enforced namespace keeps optional missing Lazada trace non-blocking', () => {
    const result = finalizePostingAffiliateVerification({
        enforced: true,
        shopee: platform(),
        lazada: platform({ expectedId: '199431090', status: 'missing_link' }),
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'skipped')
    assert.equal(result.error, null)
})

test('non-enforced namespace records invalid affiliate state without blocking', () => {
    const result = finalizePostingAffiliateVerification({
        enforced: false,
        shopee: platform({ expectedId: '15130770000', status: 'missing_link' }),
        lazada: platform(),
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'skipped')
    assert.match(result.error || '', /Shopee affiliate link missing/)
})

test('affiliate comment preflight blocks Shopee post when comment token is missing', () => {
    const result = validateAffiliateCommentPreflight({
        shopeeLink: 'https://s.shopee.co.th/example',
        hasCommentToken: false,
    })

    assert.equal(result.ok, false)
    assert.equal(result.required, true)
    assert.equal(result.error, 'comment_token_missing_before_post')
})

test('affiliate comment preflight allows explicit skipComment without token', () => {
    const result = validateAffiliateCommentPreflight({
        shopeeLink: 'https://s.shopee.co.th/example',
        hasCommentToken: false,
        skipComment: true,
    })

    assert.equal(result.ok, true)
    assert.equal(result.required, false)
    assert.equal(result.error, null)
})

test('affiliate comment preflight allows posts without Shopee affiliate comment requirement', () => {
    const result = validateAffiliateCommentPreflight({
        shopeeLink: '',
        hasCommentToken: false,
    })

    assert.equal(result.ok, true)
    assert.equal(result.required, false)
    assert.equal(result.error, null)
})
