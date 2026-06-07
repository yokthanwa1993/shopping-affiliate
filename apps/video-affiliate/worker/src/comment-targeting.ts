// Pure helpers for selecting and verifying the *visible* Facebook comment target
// for affiliate posts. Extracted into a separate module so the candidate ordering
// can be unit-tested without pulling in Worker runtime types.
//
// Background: when we publish a Reel via Graph, FB creates two related objects:
//   - a video/reel object (e.g. id `998726829758584`), surfaced via fb_reel_url
//   - a page-story object that actually appears on the page feed
//     (e.g. id `1008898512617594_1284990567138972`, surfaced as fb_post_id)
//
// Comments posted to the reel object do NOT propagate to the page-story, so to
// operators the page looks empty even though history says COMMENT succeeded. The
// operational comment target is therefore strictly the full Page story object
// `<page_id>_<post_id>`. Bare Reel/video ids and bare post tails are metadata only.

export type VisibleCommentTargetInput = {
    pageId?: string | null
    fbPostId?: string | null
    fbReelUrlOrId?: string | null
}

function extractStoryTailFromFullId(fullId: string): string {
    const value = String(fullId || '').trim()
    if (!value) return ''
    const parts = value.split('_')
    return parts.length > 1 ? parts[parts.length - 1] : ''
}

function isLikelyFullStoryId(value: string): boolean {
    const trimmed = String(value || '').trim()
    return /^\d+_\d+$/.test(trimmed)
}

export function extractIdFromCommentTargetInput(raw: string | null | undefined): string {
    const clean = String(raw || '').trim()
    if (!clean) return ''
    // Already a bare numeric id (or full pageid_storyid form)
    if (/^\d+(_\d+)?$/.test(clean)) return clean
    const reelMatch = clean.match(/\/reel\/(\d+)/i)
    if (reelMatch?.[1]) return reelMatch[1]
    const videoMatch = clean.match(/\/videos\/(\d+)/i)
    if (videoMatch?.[1]) return videoMatch[1]
    const watchMatch = clean.match(/[?&]v=(\d+)/i)
    if (watchMatch?.[1]) return watchMatch[1]
    const postsMatch = clean.match(/\/posts\/(\d+)/i)
    if (postsMatch?.[1]) return postsMatch[1]
    return ''
}

// Ordered list of unique Graph comment-target candidates. Only full Page story
// objects (`<page_id>_<post_id>`) are valid targets for reads, writes, verify and
// dedup. Bare Reel/video ids and bare post tails are intentionally excluded.
export function buildVisibleCommentTargetCandidates(input: VisibleCommentTargetInput): string[] {
    const pageId = String(input.pageId || '').trim()
    const fbPostIdRaw = String(input.fbPostId || '').trim()
    const reelInputRaw = String(input.fbReelUrlOrId || '').trim()
    const reelOrStoryId = extractIdFromCommentTargetInput(reelInputRaw)
    const postIdIsBareReelId = !!(
        fbPostIdRaw
        && reelOrStoryId
        && !isLikelyFullStoryId(fbPostIdRaw)
        && !isLikelyFullStoryId(reelOrStoryId)
        && fbPostIdRaw === reelOrStoryId
    )

    const out: string[] = []
    const seen = new Set<string>()
    const push = (candidate: string) => {
        const value = String(candidate || '').trim()
        if (!value) return
        const key = value.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        out.push(value)
    }

    if (fbPostIdRaw && !postIdIsBareReelId) {
        if (isLikelyFullStoryId(fbPostIdRaw)) {
            // Already pageid_storyid — use as-is (visible page-story target).
            push(fbPostIdRaw)
            const tail = extractStoryTailFromFullId(fbPostIdRaw)
            if (pageId && tail && !fbPostIdRaw.startsWith(`${pageId}_`)) {
                push(`${pageId}_${tail}`)
            }
        } else {
            // Bare story id — valid only once we can build the full Page story id.
            if (pageId) push(`${pageId}_${fbPostIdRaw}`)
        }
    }

    if (!fbPostIdRaw && isLikelyFullStoryId(reelOrStoryId)) {
        for (const c of buildVisibleCommentTargetCandidates({
            pageId,
            fbPostId: reelOrStoryId,
        })) push(c)
    }

    return out
}

export type PostingCommentTargetCandidatesInput = VisibleCommentTargetInput & {
    initialTargetId?: string | null
}

function buildLegacyCommentTargetCandidates(targetIdRaw: string, pageIdRaw?: string | null): string[] {
    const targetId = String(targetIdRaw || '').trim()
    const pageId = String(pageIdRaw || '').trim()
    if (!targetId) return []

    const candidates: string[] = [targetId]
    const hasUnderscore = targetId.includes('_')

    if (hasUnderscore) {
        const tail = targetId.split('_').pop() || ''
        if (tail) {
            candidates.push(tail)
            if (pageId) candidates.push(`${pageId}_${tail}`)
        }
    } else if (pageId) {
        candidates.push(`${pageId}_${targetId}`)
    }

    if (pageId && !targetId.startsWith(`${pageId}_`)) {
        candidates.push(`${pageId}_${targetId}`)
    }

    return uniqueCommentTargetTokens(candidates)
}

function uniqueCommentTargetTokens(candidates: string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
        const value = String(candidate || '').trim()
        if (!value) continue
        const key = value.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(value)
    }
    return out
}

export function buildPostingCommentTargetCandidates(input: PostingCommentTargetCandidatesInput): string[] {
    const pageId = String(input.pageId || '').trim()
    const fbPostIdRaw = String(input.fbPostId || '').trim()
    const reelOrStoryId = extractIdFromCommentTargetInput(input.fbReelUrlOrId)
    const initialTargetId = String(input.initialTargetId || '').trim()

    if (fbPostIdRaw) {
        return buildVisibleCommentTargetCandidates({
            pageId,
            fbPostId: fbPostIdRaw,
        })
    }

    if (isLikelyFullStoryId(reelOrStoryId)) {
        return buildVisibleCommentTargetCandidates({
            pageId,
            fbPostId: reelOrStoryId,
        })
    }

    if (isLikelyFullStoryId(initialTargetId)) {
        return buildVisibleCommentTargetCandidates({
            pageId,
            fbPostId: initialTargetId,
        })
    }

    return []
}

export type CanonicalCommentTargetInput = {
    pageId?: string | null
    // Numeric post id tail (e.g. `1284990567138972`) or already-full `<page>_<post>`.
    postId?: string | null
    // canonical_post_id / post_canonical — may already be the full page-story form.
    canonicalPostId?: string | null
    // Reel/video object id (or a permalink we can extract it from). Metadata only.
    reelId?: string | null
    // Existing comment_target_id column (backwards compat). Only honoured when it is
    // already a full page-story id — a bare reel target is never silently kept.
    existingTarget?: string | null
}

export type CanonicalCommentTargetResult = {
    // The canonical comment target to use for /comments reads & writes.
    target: string
    // The page-story object id when one exists; '' when it cannot be built.
    pageStoryObjectId: string
    // The numeric post id tail when known.
    postTail: string
    source: 'canonical_post_id' | 'page_story_object' | 'existing_full_story' | 'none'
    fallback: boolean
    // '' when a page-story target was resolved; a visible block reason otherwise.
    reason: string
}

// Resolve the canonical Page-story comment target for a Reel/post.
//
// Facebook Reels expose BOTH a reel/video object id and a page-story object id
// (`<page_id>_<post_id>`). The canonical post/comment target for rewrite,
// comment read/write and verify MUST be the page-story object id. Bare reel/video
// ids and bare post tails are never returned as operational targets. This is the
// single enforcement point for that invariant.
export function resolveCanonicalCommentTarget(input: CanonicalCommentTargetInput): CanonicalCommentTargetResult {
    const pageId = String(input.pageId || '').trim()
    const canonicalRaw = String(input.canonicalPostId || '').trim()
    const postRaw = String(input.postId || '').trim()
    const existingRaw = String(input.existingTarget || '').trim()
    const reelId = extractIdFromCommentTargetInput(String(input.reelId || '').trim())
    const missing = (postTail = ''): CanonicalCommentTargetResult => ({
        target: '',
        pageStoryObjectId: '',
        postTail,
        source: 'none',
        fallback: true,
        reason: 'missing_page_story_object_id',
    })
    const isBareReelAlias = (value: string): boolean => !!(
        reelId
        && value
        && /^\d+$/.test(value)
        && value === reelId
    )

    const story = (
        full: string,
        tail: string,
        source: CanonicalCommentTargetResult['source'],
    ): CanonicalCommentTargetResult => ({
        target: full,
        pageStoryObjectId: full,
        postTail: tail,
        source,
        fallback: false,
        reason: '',
    })

    // Compose a page-story id from a bare numeric tail only when we know the page id.
    const composeStory = (tail: string): string => (pageId ? `${pageId}_${tail}` : '')

    // 1) canonical_post_id / post_canonical wins — full as-is, or composed.
    if (canonicalRaw) {
        if (isLikelyFullStoryId(canonicalRaw)) {
            return story(canonicalRaw, extractStoryTailFromFullId(canonicalRaw), 'canonical_post_id')
        }
        if (/^\d+$/.test(canonicalRaw) && !isBareReelAlias(canonicalRaw)) {
            const full = composeStory(canonicalRaw)
            return full ? story(full, canonicalRaw, 'canonical_post_id') : missing(canonicalRaw)
        }
        if (isBareReelAlias(canonicalRaw)) return missing()
    }

    // 2) post_id — full page-story as-is, or compose `<page_id>_<post_id>`.
    if (postRaw) {
        if (isLikelyFullStoryId(postRaw)) {
            return story(postRaw, extractStoryTailFromFullId(postRaw), 'page_story_object')
        }
        if (/^\d+$/.test(postRaw) && !isBareReelAlias(postRaw)) {
            const full = composeStory(postRaw)
            return full ? story(full, postRaw, 'page_story_object') : missing(postRaw)
        }
        if (isBareReelAlias(postRaw)) return missing()
    }

    // 3) Existing comment_target_id, but ONLY when it is already a full page-story
    //    id. A bare reel target is never kept here — see the fallback below.
    if (existingRaw && isLikelyFullStoryId(existingRaw)) {
        return story(existingRaw, extractStoryTailFromFullId(existingRaw), 'existing_full_story')
    }

    return missing()
}

// Candidate list for "is there already an affiliate comment on the visible
// target?" dedup checks. When a page-story target exists (fb_post_id is set),
// this returns ONLY the story-target candidates — a stray affiliate comment on
// the reel/video fallback object does NOT prove the page-story has one, and
// counting it would skip posting to the real visible target. When no story
// target is known, callers do not dedup against Reel/video objects; those are not
// visible Page story targets.
export function buildExistingCommentDedupCandidates(input: VisibleCommentTargetInput): string[] {
    const fbPostIdRaw = String(input.fbPostId || '').trim()
    if (fbPostIdRaw) {
        return buildVisibleCommentTargetCandidates({
            pageId: input.pageId,
            fbPostId: fbPostIdRaw,
        })
    }
    return buildVisibleCommentTargetCandidates({
        pageId: input.pageId,
        fbReelUrlOrId: input.fbReelUrlOrId,
    })
}

export type AffiliateCommentItem = {
    id?: string | null
    message?: string | null
}

export type AffiliateCommentMatchOptions = {
    commentId?: string | null
    expectedMessage?: string | null
    affiliateHostPattern?: RegExp
}

// Pure check: given a /comments listing returned for a candidate target, did our
// affiliate comment land on this target? Matches by exact comment id (or the
// `parent_storyid_commentid` form returned by Graph for some objects), or by
// affiliate-host URL substring inside the message.
export function isAffiliateCommentMatch(
    items: AffiliateCommentItem[] | null | undefined,
    options: AffiliateCommentMatchOptions = {},
): { matched: boolean; matchedBy?: 'comment_id' | 'comment_id_suffix' | 'message' } {
    const list = Array.isArray(items) ? items : []
    if (list.length === 0) return { matched: false }

    const wantId = String(options.commentId || '').trim()
    const expectedMessage = String(options.expectedMessage || '').replace(/\s+/g, ' ').trim()
    const expectedSnippet = expectedMessage.slice(0, 60)
    const hostPattern = options.affiliateHostPattern || /s\.shopee\.co\.th|shopee\.co\.th/i

    for (const item of list) {
        const id = String(item?.id || '').trim()
        const message = String(item?.message || '')

        if (wantId && id) {
            if (id === wantId) return { matched: true, matchedBy: 'comment_id' }
            if (id.endsWith(`_${wantId}`) || wantId.endsWith(`_${id}`)) {
                return { matched: true, matchedBy: 'comment_id_suffix' }
            }
        }

        if (hostPattern.test(message)) {
            return { matched: true, matchedBy: 'message' }
        }

        if (expectedSnippet) {
            const messageNorm = message.replace(/\s+/g, ' ').trim()
            if (messageNorm.includes(expectedSnippet)) {
                return { matched: true, matchedBy: 'message' }
            }
        }
    }

    return { matched: false }
}
