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
  templateAdset: z.string().max(120).default(''),
  campaignPrefix: z.string().max(120).default(''),
  adsPerRound: z.string().max(20).default(''),
  autoCreateTime: z.string().max(20).default(''),
  adFlowEnabled: z.string().max(10).default('0'),
  adFlowKey: z.string().max(80).default('legacy_cron'),
  adFlowSourceStrategy: z.string().max(80).default('page_posts'),
  adFlowCtaStrategy: z.string().max(80).default('source_then_story'),
  adFlowCommentMode: z.string().max(80).default('template'),
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
  templateAdset: '',
  campaignPrefix: '',
  adsPerRound: '',
  autoCreateTime: '',
  adFlowEnabled: '0',
  adFlowKey: 'legacy_cron',
  adFlowSourceStrategy: 'page_posts',
  adFlowCtaStrategy: 'source_then_story',
  adFlowCommentMode: 'template',
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
      templateAdset: String(data.template_adset || ''),
      campaignPrefix: String(data.campaign_prefix || ''),
      adsPerRound: String(data.ads_per_round || ''),
      autoCreateTime: String(data.auto_create_time || ''),
      adFlowEnabled: String(data.ad_flow_enabled || '0'),
      adFlowKey: String(data.ad_flow_key || 'legacy_cron'),
      adFlowSourceStrategy: String(data.ad_flow_source_strategy || 'page_posts'),
      adFlowCtaStrategy: String(data.ad_flow_cta_strategy || 'source_then_story'),
      adFlowCommentMode: String(data.ad_flow_comment_mode || 'template'),
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
    template_adset: form.templateAdset,
    campaign_prefix: form.campaignPrefix,
    ads_per_round: form.adsPerRound,
    auto_create_time: form.autoCreateTime,
    ad_flow_enabled: form.adFlowEnabled,
    ad_flow_key: form.adFlowKey,
    ad_flow_source_strategy: form.adFlowSourceStrategy,
    ad_flow_cta_strategy: form.adFlowCtaStrategy,
    ad_flow_comment_mode: form.adFlowCommentMode,
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

// Toggle a page's posting on/off. Hits the page resource endpoint (not the
// dashboard settings blob) and sends ONLY the `is_active` flag — no token or
// other field is ever included, so flipping the switch can't clobber settings.
export async function updatePageActive(pageId: string, active: boolean): Promise<void> {
  await workerFetchJson<Record<string, unknown>>(
    `/api/pages/${encodeURIComponent(pageId)}`,
    { method: 'PUT', timeoutMs: 15_000, body: { is_active: active } },
  )
}

// ─── Create Ads auto status (per-page toggle) ──────────────────────────────
// The Create Ads master-list toggle controls a page's Create Ads AUTO status only — the persisted
// per-page setting `ad_flow_enabled`. This is independent of normal Page posting (updatePageActive /
// is_active above): turning Create Ads off here never stops a page from posting, and vice versa.

// The only page treated as Create-Ads-ON when no explicit ad_flow_enabled setting exists yet. Mirrors
// the worker's AUTO_ADS_DEFAULT_ENABLED_PAGE_ID so the master list's default state matches what the
// unattended auto-pick scheduler actually does (เฉียบ on, every other held page off).
export const CREATE_ADS_DEFAULT_ENABLED_PAGE_ID = '1008898512617594'

// Resolve a page's Create Ads enabled state from its raw ad_flow_enabled value. An explicit on/off
// value wins; an UNSET value defaults to ON only for the default page (เฉียบ) and OFF for every other
// page — preserving current production until the operator toggles something. Mirrors the worker's
// isAdFlowEnabledForPage so the UI and the scheduler agree.
export function resolveCreateAdsEnabled(pageId: string, rawAdFlowEnabled: string | null | undefined): boolean {
  const s = String(rawAdFlowEnabled ?? '').trim().toLowerCase()
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === 'enabled') return true
  if (s === '0' || s === 'false' || s === 'off' || s === 'no' || s === 'disabled') return false
  return pageId === CREATE_ADS_DEFAULT_ENABLED_PAGE_ID
}

// Fetch the per-page Create Ads enabled map for a BOUNDED list of pages (the held pages — 8 today).
// Reads each page's ad_flow_enabled via the existing settings GET (token fields are never pulled into
// this map), then applies the default rule. A failed read falls back to the default rule so the master
// list still renders. Returns { [pageId]: boolean }.
export async function fetchCreateAdsEnabledMap(
  pageIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    pageIds.map(async (pageId) => {
      try {
        const data = await workerFetchJson<SettingsResponse>(
          `/api/dashboard/settings?page_id=${encodeURIComponent(pageId)}`,
          { signal, timeoutMs: 15_000 },
        )
        return [pageId, resolveCreateAdsEnabled(pageId, String(data.ad_flow_enabled || ''))] as const
      } catch {
        return [pageId, resolveCreateAdsEnabled(pageId, '')] as const
      }
    }),
  )
  return Object.fromEntries(entries)
}

// Persist ONLY the Create Ads toggle (ad_flow_enabled) for a page. Sends a minimal PUT body —
// page_id + ad_flow_enabled — so flipping the switch can NEVER clobber other page settings (the worker
// writes only the keys present in the body). Distinct from updatePageActive (normal posting); this
// toggles the Create Ads auto status alone.
export async function updatePageAdFlowEnabled(pageId: string, enabled: boolean): Promise<void> {
  await workerFetchJson<SettingsResponse>(
    `/api/dashboard/settings?page_id=${encodeURIComponent(pageId)}`,
    { method: 'PUT', timeoutMs: 15_000, body: { page_id: pageId, ad_flow_enabled: enabled ? '1' : '0' } },
  )
}
