// Dashboard settings adapter (Phase 1 of the dashboard-settings migration).
//
// Single place the new Dashboard Settings center talks to the video-affiliate
// Worker through. UI components never call fetch() directly so that, as legacy
// Mini App sections migrate over (docs/plans/dashboard-settings-migration.md),
// only this module needs to learn new endpoints.
//
// Safety rules baked in here:
// - Page list comes from /api/dashboard/facebook-page-sources which is already
//   redacted (id/name/iconUrl/active/hasToken only — never raw tokens).
// - Settings read/write reuses the existing page-scoped
//   /api/dashboard/settings contract unchanged (side-by-side, no new writes).
import { CHIEB_NAMESPACE_ID, DEFAULT_PAGE, fetchJson } from './api'

export type ShortlinkProvider = 'api' | 'extension'

/** Redacted page summary — safe for dashboard display, contains no secrets. */
export interface SettingsPage {
  id: string
  name: string
  iconUrl: string
  active: boolean
  /** Worker-side hint that a post/comment token exists. Never the token itself. */
  hasToken: boolean
}

export interface PageSettings {
  subId: string
  subId2: string
  subId3: string
  subId4: string
  subId5: string
  shortlinkUrl: string
  shortlinkProvider: ShortlinkProvider
  commentTemplate: string
  defaultPage: string
  adAccount: string
  templateAdset: string
  templateAdsetFacebook: string
  templateAdsetInstagram: string
  campaignPrefix: string
  adsPerRound: string
  autoCreateTime: string
  facebookSyncToken: string
  facebookSyncTokenUpdatedAt: string
}

export const EMPTY_PAGE_SETTINGS: PageSettings = {
  subId: '',
  subId2: '',
  subId3: '',
  subId4: '',
  subId5: '',
  shortlinkUrl: '',
  shortlinkProvider: 'api',
  commentTemplate: '',
  defaultPage: '',
  adAccount: '',
  templateAdset: '',
  templateAdsetFacebook: '',
  templateAdsetInstagram: '',
  campaignPrefix: '',
  adsPerRound: '',
  autoCreateTime: '',
  facebookSyncToken: '',
  facebookSyncTokenUpdatedAt: '',
}

/**
 * Static safe fallback when the page-sources endpoint is unreachable — the
 * shell stays usable for the default workspace page instead of dead-ending.
 */
export const FALLBACK_PAGES: SettingsPage[] = [
  {
    id: DEFAULT_PAGE.id,
    name: DEFAULT_PAGE.name,
    iconUrl: DEFAULT_PAGE.iconUrl,
    active: true,
    hasToken: false,
  },
]

export async function fetchSettingsPages(): Promise<SettingsPage[]> {
  const data = await fetchJson<{
    ok?: boolean
    pages?: Array<{
      id?: string
      name?: string
      iconUrl?: string
      active?: boolean
      hasToken?: boolean
    }>
  }>(
    `/api/dashboard/facebook-page-sources?namespace_id=${encodeURIComponent(CHIEB_NAMESPACE_ID)}`,
    { timeoutMs: 15000 },
  )
  return (data.pages || [])
    .map((p) => ({
      id: String(p.id || '').trim(),
      name: String(p.name || '').trim(),
      iconUrl: String(p.iconUrl || '').trim(),
      active: !!p.active,
      hasToken: !!p.hasToken,
    }))
    .filter((p) => p.id)
}

type SettingsResponse = Record<string, string>

function toPageSettings(data: SettingsResponse): PageSettings {
  return {
    ...EMPTY_PAGE_SETTINGS,
    subId: String(data.sub_id || ''),
    subId2: String(data.sub_id2 || ''),
    subId3: String(data.sub_id3 || ''),
    subId4: String(data.sub_id4 || ''),
    subId5: String(data.sub_id5 || ''),
    shortlinkUrl: String(data.shortlink_url || ''),
    shortlinkProvider: (String(data.shortlink_provider || '').toLowerCase() === 'extension'
      ? 'extension'
      : 'api') as ShortlinkProvider,
    commentTemplate: String(data.comment_template || ''),
    defaultPage: String(data.default_page || ''),
    adAccount: String(data.ad_account || ''),
    templateAdset: String(data.template_adset || ''),
    templateAdsetFacebook: String(data.template_adset_facebook || ''),
    templateAdsetInstagram: String(data.template_adset_instagram || ''),
    campaignPrefix: String(data.campaign_prefix || ''),
    adsPerRound: String(data.ads_per_round || ''),
    autoCreateTime: String(data.auto_create_time || ''),
    facebookSyncToken: String(data.facebook_sync_token || data.facebookSyncToken || ''),
    facebookSyncTokenUpdatedAt: String(data.facebookSyncTokenUpdatedAt || ''),
  }
}

export async function fetchPageSettings(pageId: string): Promise<PageSettings> {
  const data = await fetchJson<SettingsResponse>(
    `/api/dashboard/settings?page_id=${encodeURIComponent(pageId)}`,
    { timeoutMs: 15000 },
  )
  return toPageSettings(data)
}

export async function savePageSettings(pageId: string, settings: PageSettings): Promise<void> {
  await fetchJson<SettingsResponse>(
    `/api/dashboard/settings?page_id=${encodeURIComponent(pageId)}`,
    {
      method: 'PUT',
      timeoutMs: 15000,
      body: JSON.stringify({
        page_id: pageId,
        sub_id: settings.subId,
        sub_id2: settings.subId2,
        sub_id3: settings.subId3,
        sub_id4: settings.subId4,
        sub_id5: settings.subId5,
        shortlink_url: settings.shortlinkUrl,
        shortlink_provider: settings.shortlinkProvider,
        comment_template: settings.commentTemplate,
        default_page: settings.defaultPage,
        ad_account: settings.adAccount,
        template_adset: settings.templateAdset,
        template_adset_facebook: settings.templateAdsetFacebook,
        template_adset_instagram: settings.templateAdsetInstagram,
        campaign_prefix: settings.campaignPrefix,
        ads_per_round: settings.adsPerRound,
        auto_create_time: settings.autoCreateTime,
        facebook_sync_token: settings.facebookSyncToken,
      }),
    },
  )
}
