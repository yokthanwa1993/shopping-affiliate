import { z } from 'zod'
import { workerFetchJson, DEFAULT_PAGE_ID, DEFAULT_PAGE_NAME } from '@/api/client'

// React settings adapter. Mirrors apps/dashboard/src/lib/settingsApi.ts (the
// Svelte adapter) and reuses the same worker contract unchanged:
//   - GET  /api/dashboard/facebook-page-sources  -> redacted page list
//   - GET  /api/dashboard/settings?page_id=...    -> page settings
//   - PUT  /api/dashboard/settings?page_id=...    -> save (default page only)
//
// Redaction rule (stricter than the Svelte panel): the raw Facebook sync token
// is NEVER pulled into React state or rendered. We surface only `tokenPresent`
// and `tokenUpdatedAt`. On save the token field is written ONLY when the
// operator explicitly types a new value; otherwise it is omitted from the PUT
// body so an existing token is never clobbered or echoed back.

export interface SettingsPage {
  id: string
  name: string
  iconUrl: string
  active: boolean
  /** Worker-side hint that a token exists. Never the token itself. */
  hasToken: boolean
}

// Non-secret, editable fields surfaced in the React form.
export const pageSettingsSchema = z.object({
  subId: z.string().max(300).default(''),
  subId2: z.string().max(300).default(''),
  subId3: z.string().max(300).default(''),
  subId4: z.string().max(300).default(''),
  subId5: z.string().max(300).default(''),
  shortlinkUrl: z.string().max(500).default(''),
  shortlinkProvider: z.enum(['api', 'extension']).default('api'),
  commentTemplate: z.string().max(4000).default(''),
  adAccount: z.string().max(120).default(''),
  campaignPrefix: z.string().max(120).default(''),
  adsPerRound: z.string().max(20).default(''),
  autoCreateTime: z.string().max(20).default(''),
})

export type PageSettingsForm = z.infer<typeof pageSettingsSchema>

export interface PageSettingsState {
  form: PageSettingsForm
  /** True when the worker has a sync token stored for this page. */
  tokenPresent: boolean
  tokenUpdatedAt: string
}

export const EMPTY_FORM: PageSettingsForm = {
  subId: '',
  subId2: '',
  subId3: '',
  subId4: '',
  subId5: '',
  shortlinkUrl: '',
  shortlinkProvider: 'api',
  commentTemplate: '',
  adAccount: '',
  campaignPrefix: '',
  adsPerRound: '',
  autoCreateTime: '',
}

export const FALLBACK_PAGES: SettingsPage[] = [
  { id: DEFAULT_PAGE_ID, name: DEFAULT_PAGE_NAME, iconUrl: '', active: true, hasToken: false },
]

export const DEFAULT_EDITABLE_PAGE_ID = DEFAULT_PAGE_ID

export async function fetchSettingsPages(signal?: AbortSignal): Promise<SettingsPage[]> {
  const data = await workerFetchJson<{
    ok?: boolean
    pages?: Array<Record<string, unknown>>
  }>(`/api/dashboard/facebook-page-sources`, { signal, timeoutMs: 15_000 })
  const pages = (data.pages || [])
    .map((p) => ({
      id: String(p.id || '').trim(),
      name: String(p.name || '').trim(),
      iconUrl: String(p.iconUrl || '').trim(),
      active: !!p.active,
      hasToken: !!p.hasToken,
    }))
    .filter((p) => p.id)
  return pages.length > 0 ? pages : FALLBACK_PAGES
}

type SettingsResponse = Record<string, string>

export async function fetchPageSettings(
  pageId: string,
  signal?: AbortSignal,
): Promise<PageSettingsState> {
  const data = await workerFetchJson<SettingsResponse>(
    `/api/dashboard/settings?page_id=${encodeURIComponent(pageId)}`,
    { signal, timeoutMs: 15_000 },
  )
  const provider = String(data.shortlink_provider || '').toLowerCase() === 'extension'
    ? 'extension'
    : 'api'
  return {
    form: {
      subId: String(data.sub_id || ''),
      subId2: String(data.sub_id2 || ''),
      subId3: String(data.sub_id3 || ''),
      subId4: String(data.sub_id4 || ''),
      subId5: String(data.sub_id5 || ''),
      shortlinkUrl: String(data.shortlink_url || ''),
      shortlinkProvider: provider,
      commentTemplate: String(data.comment_template || ''),
      adAccount: String(data.ad_account || ''),
      campaignPrefix: String(data.campaign_prefix || ''),
      adsPerRound: String(data.ads_per_round || ''),
      autoCreateTime: String(data.auto_create_time || ''),
    },
    // Presence only — the raw token string is intentionally dropped here.
    tokenPresent: !!data.facebook_sync_token || !!data.facebookSyncToken || !!data.facebookSyncTokenUpdatedAt,
    tokenUpdatedAt: String(data.facebookSyncTokenUpdatedAt || ''),
  }
}

export async function savePageSettings(
  pageId: string,
  form: PageSettingsForm,
  newToken?: string,
): Promise<void> {
  const body: Record<string, string> = {
    page_id: pageId,
    sub_id: form.subId,
    sub_id2: form.subId2,
    sub_id3: form.subId3,
    sub_id4: form.subId4,
    sub_id5: form.subId5,
    shortlink_url: form.shortlinkUrl,
    shortlink_provider: form.shortlinkProvider,
    comment_template: form.commentTemplate,
    ad_account: form.adAccount,
    campaign_prefix: form.campaignPrefix,
    ads_per_round: form.adsPerRound,
    auto_create_time: form.autoCreateTime,
  }
  // Only write the token when the operator typed a new one. Omitting the field
  // leaves any existing token untouched (and never echoes it back to the UI).
  const trimmed = (newToken ?? '').trim()
  if (trimmed) body.facebook_sync_token = trimmed

  await workerFetchJson<SettingsResponse>(
    `/api/dashboard/settings?page_id=${encodeURIComponent(pageId)}`,
    { method: 'PUT', timeoutMs: 15_000, body },
  )
}
