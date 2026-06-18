import { workerFetchJson } from '@/api/client'

// POST-ONLY action wrapper. This is the *only* mutating call the Create Post
// console makes. It hits the existing worker route
//   POST /api/pages/:id/force-post
// which publishes the page's next queued gallery clip as a Page post (an organic
// Reel, or a OneCard video post when the page is OneCard-enabled) and, unless
// skipComment is set, posts the configured first comment.
//
// IMPORTANT separation guarantee: force-post publishes a POST. It does NOT
// create a Facebook campaign / adset / paid ad — paid ad creation goes through
// the separate ad-queue / create-ad paths, which are intentionally NOT called
// from here. Keep this module free of any ad-creation endpoint.
//
// workerFetchJson throws on a non-2xx response (surfacing the worker error
// message), so failures propagate to the caller. On a 2xx response we still
// report ok=false when the worker did not confirm a published post — we never
// fake success.

export interface PublishPagePostResult {
  /** True only when the worker confirmed a published post (success + fb id). */
  ok: boolean
  fbReelUrl: string
  fbPostId: string
  /** Worker-reported error/detail when ok is false on a 2xx response. */
  error: string
}

export async function publishPagePost(
  pageId: string,
  options: { skipComment?: boolean } = {},
): Promise<PublishPagePostResult> {
  const data = await workerFetchJson<{
    success?: boolean
    error?: string
    details?: string
    fb_reel_url?: string
    fb_post_id?: string
  }>(`/api/pages/${encodeURIComponent(pageId)}/force-post`, {
    method: 'POST',
    timeoutMs: 120_000,
    body: { skipComment: options.skipComment === true },
  })
  const fbPostId = String(data.fb_post_id || '')
  return {
    ok: data.success === true && !!fbPostId,
    fbReelUrl: String(data.fb_reel_url || ''),
    fbPostId,
    error: String(data.error || data.details || ''),
  }
}
