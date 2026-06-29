import { z } from 'zod'
import { workerFetchJson } from '@/api/client'

// Typed client for the Explore "watched external pages" feature. These pages are
// NOT the operator's owned posting Pages — they are arbitrary Facebook pages the
// operator wants to watch. The worker fetches their posts/clips read-only into
// dashboard_external_watched_pages / dashboard_external_page_posts. Nothing here
// posts, comments, or creates ads — Explore is a read-only inventory until an
// explicit import action exists.

export const watchedPageSchema = z
  .object({
    page_id: z.string(),
    page_key: z.string().nullish(),
    page_url: z.string().nullish(),
    page_name: z.string().nullish(),
    enabled: z.boolean().default(true),
    created_at: z.string().nullish(),
    last_attempt_at: z.string().nullish(),
    last_synced_at: z.string().nullish(),
    last_error: z.string().nullish(),
    last_batch_count: z.number().nullish(),
    posts_count: z.number().nullish(),
  })
  .passthrough()

export const watchedPagesResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    namespace_id: z.string().nullish(),
    total_posts: z.number().nullish(),
    pages: z.array(watchedPageSchema).default([]),
  })
  .passthrough()

export const externalPostSchema = z
  .object({
    page_id: z.string().nullish(),
    page_name: z.string().nullish(),
    post_id: z.string().nullish(),
    video_id: z.string().nullish(),
    is_video: z.boolean().default(false),
    post_url: z.string().nullish(),
    source_url: z.string().nullish(),
    thumbnail: z.string().nullish(),
    title: z.string().nullish(),
    caption: z.string().nullish(),
    views: z.number().nullish(),
    created_time: z.string().nullish(),
    fetched_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough()

export const externalPostsResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    namespace_id: z.string().nullish(),
    page_id: z.string().nullish(),
    sort: z.string().nullish(),
    total: z.number().nullish(),
    data_source: z.string().nullish(),
    items: z.array(externalPostSchema).default([]),
  })
  .passthrough()

export type WatchedPage = z.infer<typeof watchedPageSchema>
export type ExternalPost = z.infer<typeof externalPostSchema>
export type WatchedPagesResponse = z.infer<typeof watchedPagesResponseSchema>
export type ExternalPostsResponse = z.infer<typeof externalPostsResponseSchema>

export interface ExternalPostsQuery {
  pageId?: string
  search?: string
  minViews?: number
  sort?: 'newest' | 'oldest' | 'views'
  limit?: number
  offset?: number
}

export async function fetchWatchedPages(signal?: AbortSignal): Promise<WatchedPagesResponse> {
  const raw = await workerFetchJson<unknown>('/api/dashboard/explore/watched-pages', {
    signal,
    timeoutMs: 30_000,
  })
  return watchedPagesResponseSchema.parse(raw)
}

export async function addWatchedPage(urlOrId: string, signal?: AbortSignal): Promise<WatchedPage | null> {
  const raw = await workerFetchJson<{ ok?: boolean; page?: unknown }>(
    '/api/dashboard/explore/watched-pages',
    { method: 'POST', body: { url_or_id: urlOrId }, signal, timeoutMs: 30_000 },
  )
  return raw?.page ? watchedPageSchema.parse(raw.page) : null
}

export async function setWatchedPageEnabled(
  pageKey: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<WatchedPage | null> {
  const raw = await workerFetchJson<{ ok?: boolean; page?: unknown }>(
    `/api/dashboard/explore/watched-pages/${encodeURIComponent(pageKey)}`,
    { method: 'PATCH', body: { enabled }, signal, timeoutMs: 30_000 },
  )
  return raw?.page ? watchedPageSchema.parse(raw.page) : null
}

export async function removeWatchedPage(pageKey: string, signal?: AbortSignal): Promise<void> {
  await workerFetchJson<{ ok?: boolean }>(
    `/api/dashboard/explore/watched-pages/${encodeURIComponent(pageKey)}`,
    { method: 'DELETE', signal, timeoutMs: 30_000 },
  )
}

export async function syncWatchedPages(
  params: { pageId?: string; all?: boolean },
  signal?: AbortSignal,
): Promise<{ ok: boolean; inserted?: number; reason?: string; synced?: number }> {
  const body: Record<string, unknown> = {}
  if (params.all) body.all = true
  if (params.pageId) body.page_id = params.pageId
  return workerFetchJson<{ ok: boolean; inserted?: number; reason?: string; synced?: number }>(
    '/api/dashboard/explore/sync',
    { method: 'POST', body, signal, timeoutMs: 60_000 },
  )
}

export async function fetchExternalPosts(
  params: ExternalPostsQuery,
  signal?: AbortSignal,
): Promise<ExternalPostsResponse> {
  const qs = new URLSearchParams()
  if (params.pageId) qs.set('page_id', params.pageId)
  if (params.search) qs.set('q', params.search)
  if (params.minViews != null) qs.set('min_views', String(params.minViews))
  if (params.sort) qs.set('sort', params.sort)
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  const raw = await workerFetchJson<unknown>(
    `/api/dashboard/explore/posts?${qs.toString()}`,
    { signal, timeoutMs: 30_000 },
  )
  return externalPostsResponseSchema.parse(raw)
}
