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
// fix is to target the page-story whenever it exists and only fall back to the
// reel object id when no post_id / page-story object exists.

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

// Story-first ordered list of unique Graph comment-target candidates. The list
// is consumed left-to-right by the comment posting flow; the FIRST candidate
// that accepts the POST *and* shows the comment when /comments is queried is
// the one we commit to.
export function buildVisibleCommentTargetCandidates(input: VisibleCommentTargetInput): string[] {
    const pageId = String(input.pageId || '').trim()
    const fbPostIdRaw = String(input.fbPostId || '').trim()
    const reelInputRaw = String(input.fbReelUrlOrId || '').trim()
    const reelId = extractIdFromCommentTargetInput(reelInputRaw)

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

    if (fbPostIdRaw) {
        if (isLikelyFullStoryId(fbPostIdRaw)) {
            // Already pageid_storyid — use as-is (visible page-story target).
            push(fbPostIdRaw)
            const tail = extractStoryTailFromFullId(fbPostIdRaw)
            if (pageId && tail && !fbPostIdRaw.startsWith(`${pageId}_`)) {
                push(`${pageId}_${tail}`)
            }
            if (tail) push(tail)
        } else {
            // Bare story id — build the visible page-story form first.
            if (pageId) push(`${pageId}_${fbPostIdRaw}`)
            push(fbPostIdRaw)
        }
    }

    if (!fbPostIdRaw && reelId) {
        // Reel/video object id — fallback ONLY when no fb_post_id / page-story
        // object exists. When a page-story target is known the bare reel object is
        // never included: comments there do NOT show on the page-story feed, so a
        // candidate list that read/wrote/verified it would target the wrong object.
        push(reelId)
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

    const orderedCandidates: string[] = []
    for (const c of buildVisibleCommentTargetCandidates({
        pageId,
        fbReelUrlOrId: input.fbReelUrlOrId,
    })) orderedCandidates.push(c)

    if (initialTargetId) {
        orderedCandidates.push(initialTargetId)
        for (const c of buildLegacyCommentTargetCandidates(initialTargetId, pageId)) orderedCandidates.push(c)
    }

    return uniqueCommentTargetTokens(orderedCandidates)
}

export type CanonicalCommentTargetInput = {
    pageId?: string | null
    // Numeric post id tail (e.g. `1284990567138972`) or already-full `<page>_<post>`.
    postId?: string | null
    // canonical_post_id / post_canonical — may already be the full page-story form.
    canonicalPostId?: string | null
    // Reel/video object id (or a permalink we can extract it from). Fallback only.
    reelId?: string | null
    // Existing comment_target_id column (backwards compat). Only honoured when it is
    // already a full page-story id — a bare reel target is never silently kept.
    existingTarget?: string | null
}

export type CanonicalCommentTargetResult = {
    // The canonical comment target to use for /comments reads & writes.
    target: string
    // The page-story object id when one exists; '' when we fell back to the reel.
    pageStoryObjectId: string
    // The numeric post id tail when known.
    postTail: string
    source: 'canonical_post_id' | 'page_story_object' | 'existing_full_story' | 'reel_id' | 'none'
    fallback: boolean
    // '' when a page-story target was resolved; a visible fallback reason otherwise.
    reason: string
}

// Resolve the canonical Page-story comment target for a Reel/post.
//
// Facebook Reels expose BOTH a reel/video object id and a page-story object id
// (`<page_id>_<post_id>`). The canonical post/comment target for rewrite, comment
// read/write and verify MUST be the page-story object id whenever a post_id
// exists. The bare reel object id is a fallback only when no post_id / page-story
// object exists, and that fallback is always flagged via `reason` so responses can
// surface it. This is the single enforcement point for that invariant.
export function resolveCanonicalCommentTarget(input: CanonicalCommentTargetInput): CanonicalCommentTargetResult {
    const pageId = String(input.pageId || '').trim()
    const canonicalRaw = String(input.canonicalPostId || '').trim()
    const postRaw = String(input.postId || '').trim()
    const existingRaw = String(input.existingTarget || '').trim()
    const reelId = extractIdFromCommentTargetInput(String(input.reelId || '').trim())

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

    // Compose a page-story id from a bare numeric tail when we know the page id;
    // when the page id is unknown the bare story id is still better than the reel.
    const composeStory = (tail: string): string => (pageId ? `${pageId}_${tail}` : tail)

    // 1) canonical_post_id / post_canonical wins — full as-is, or composed.
    if (canonicalRaw) {
        if (isLikelyFullStoryId(canonicalRaw)) {
            return story(canonicalRaw, extractStoryTailFromFullId(canonicalRaw), 'canonical_post_id')
        }
        if (/^\d+$/.test(canonicalRaw)) {
            return story(composeStory(canonicalRaw), canonicalRaw, 'canonical_post_id')
        }
    }

    // 2) post_id — full page-story as-is, or compose `<page_id>_<post_id>`.
    if (postRaw) {
        if (isLikelyFullStoryId(postRaw)) {
            return story(postRaw, extractStoryTailFromFullId(postRaw), 'page_story_object')
        }
        if (/^\d+$/.test(postRaw)) {
            return story(composeStory(postRaw), postRaw, 'page_story_object')
        }
    }

    // 3) Existing comment_target_id, but ONLY when it is already a full page-story
    //    id. A bare reel target is never kept here — see the fallback below.
    if (existingRaw && isLikelyFullStoryId(existingRaw)) {
        return story(existingRaw, extractStoryTailFromFullId(existingRaw), 'existing_full_story')
    }

    // 4) Fallback: the bare reel/video object id only. Always flagged so responses
    //    make the fallback reason visible.
    if (reelId) {
        return {
            target: reelId,
            pageStoryObjectId: '',
            postTail: '',
            source: 'reel_id',
            fallback: true,
            reason: 'comment_target_fallback_reel_id,page_story_object_missing',
        }
    }

    return { target: '', pageStoryObjectId: '', postTail: '', source: 'none', fallback: true, reason: 'page_story_object_missing' }
}

// Candidate list for "is there already an affiliate comment on the visible
// target?" dedup checks. When a page-story target exists (fb_post_id is set),
// this returns ONLY the story-target candidates — a stray affiliate comment on
// the reel/video fallback object does NOT prove the page-story has one, and
// counting it would skip posting to the real visible target. When no story
// target is known, callers can still dedup against the reel/video object.
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
