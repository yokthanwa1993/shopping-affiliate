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
// fix is to prefer the page-story target first and only fall back to the reel
// object id when the story target genuinely cannot accept a comment.

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

    if (reelId && reelId !== fbPostIdRaw) {
        // Reel/video object id — fallback only. Comments here do NOT show on the
        // page-story feed, which is the bug we are fixing.
        push(reelId)
    }

    return out
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
