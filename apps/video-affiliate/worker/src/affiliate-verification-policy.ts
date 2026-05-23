export type PostingAffiliatePlatformVerificationStatus = 'skipped' | 'missing_link' | 'verified' | 'mismatch' | 'error'

export type PostingAffiliatePlatformVerification = {
    inputLink: string
    resolvedLink: string
    expectedId: string
    actualId: string
    status: PostingAffiliatePlatformVerificationStatus
    match: number | null
    error: string | null
}

export type PostingAffiliateVerificationResult = {
    ok: boolean
    enforced: boolean
    status: 'skipped' | 'verified' | 'failed'
    error: string | null
    shopee: PostingAffiliatePlatformVerification
    lazada: PostingAffiliatePlatformVerification
}

export type PostingAffiliateCommentPreflightResult = {
    ok: boolean
    required: boolean
    error: 'comment_token_missing_before_post' | null
}

function hasValue(value: string | null | undefined): boolean {
    return !!String(value || '').trim()
}

export function validateAffiliateCommentPreflight(params: {
    shopeeLink?: string | null
    hasCommentToken: boolean
    skipComment?: boolean
}): PostingAffiliateCommentPreflightResult {
    const required = hasValue(params.shopeeLink) && !params.skipComment
    if (required && !params.hasCommentToken) {
        return {
            ok: false,
            required,
            error: 'comment_token_missing_before_post',
        }
    }

    return {
        ok: true,
        required,
        error: null,
    }
}

function markShopeeRequiredFailure(shopee: PostingAffiliatePlatformVerification) {
    if (!hasValue(shopee.inputLink)) {
        shopee.status = 'missing_link'
        shopee.match = 0
        shopee.error = shopee.error || `Shopee affiliate link missing (expected ${shopee.expectedId})`
        return
    }

    if (shopee.status !== 'verified' || shopee.match !== 1) {
        shopee.status = shopee.status === 'error' ? 'error' : 'mismatch'
        shopee.match = shopee.match === null ? 0 : shopee.match
        shopee.error = shopee.error || `Shopee affiliate id mismatch (expected ${shopee.expectedId}, actual ${shopee.actualId || '-'})`
    }
}

function markLazadaRequiredFailure(lazada: PostingAffiliatePlatformVerification) {
    if (!hasValue(lazada.inputLink)) {
        lazada.status = 'missing_link'
        lazada.match = 0
        lazada.error = lazada.error || `Lazada affiliate link missing (expected member_id ${lazada.expectedId})`
        return
    }

    if (lazada.status !== 'verified' || lazada.match !== 1) {
        lazada.status = lazada.status === 'error' ? 'error' : 'mismatch'
        lazada.match = lazada.match === null ? 0 : lazada.match
        lazada.error = lazada.error || (lazada.actualId
            ? `Lazada member_id mismatch (expected ${lazada.expectedId}, actual ${lazada.actualId})`
            : `Lazada member_id missing (expected ${lazada.expectedId})`)
    }
}

export function finalizePostingAffiliateVerification(params: {
    enforced: boolean
    shopee: PostingAffiliatePlatformVerification
    lazada: PostingAffiliatePlatformVerification
    lazadaRequired?: boolean
}): PostingAffiliateVerificationResult {
    const shopee = { ...params.shopee }
    const lazada = { ...params.lazada }

    if (hasValue(shopee.expectedId)) {
        markShopeeRequiredFailure(shopee)
    }

    const lazadaMustVerify = hasValue(lazada.expectedId) && (hasValue(lazada.inputLink) || !!params.lazadaRequired)
    if (lazadaMustVerify) {
        markLazadaRequiredFailure(lazada)
    }

    const blockingErrors = [shopee.error, lazada.error].filter((value) => !!String(value || '').trim())
    const verifiedAny = shopee.status === 'verified' || lazada.status === 'verified'
    const ok = params.enforced ? blockingErrors.length === 0 : true
    const status: 'skipped' | 'verified' | 'failed' = params.enforced
        ? (ok ? (verifiedAny ? 'verified' : 'skipped') : 'failed')
        : (verifiedAny ? 'verified' : 'skipped')
    const error = blockingErrors.join(' | ') || null

    return {
        ok,
        enforced: params.enforced,
        status,
        error,
        shopee,
        lazada,
    }
}
