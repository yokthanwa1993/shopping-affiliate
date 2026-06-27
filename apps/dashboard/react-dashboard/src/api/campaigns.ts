import { workerFetchJson, DEFAULT_AD_ACCOUNT, DEFAULT_PAGE_ID } from '@/api/client'
import { isRecord, safeNumber, safeString } from '@/lib/data'

// Read-only contract for GET /api/dashboard/campaigns?ad_account=... — same
// endpoint the Svelte CampaignsPanel reads live from Facebook Ads Manager. The
// active ad account comes from the page settings (falling back to the default).

export interface CampaignAdSet {
  id: string
  name: string
  status: string
}

export interface Campaign {
  id: string
  name: string
  status: string
  dailyBudget: string
  startTime: string
  adsetCount: number
  activeAdsetCount: number
  adsets: CampaignAdSet[]
  reach: string
  impressions: string
  spend: string
  costPerLinkClick: string
  /** Per-row provenance: 'graph' (live Ads Manager) or 'history_fallback' (verified D1 ad-history). */
  source: string
}

// Response-level provenance for the campaigns list. `source` is 'graph' when the live Facebook Graph
// account edge returned data, 'history_fallback' when the worker re-derived the open campaigns from
// verified dashboard_ad_history (live edge empty / wrong account / bridge error), or '' on hard error.
// graphError carries the bridge/Graph error message when the fallback fired because of a failure.
export interface CampaignsResult {
  campaigns: Campaign[]
  source: string
  graphAvailable: boolean
  graphError: string
}

function normalizeAdSet(raw: unknown): CampaignAdSet | null {
  if (!isRecord(raw)) return null
  return { id: safeString(raw.id), name: safeString(raw.name), status: safeString(raw.status) }
}

function normalize(raw: unknown): Campaign | null {
  if (!isRecord(raw)) return null
  const id = safeString(raw.id)
  if (!id) return null
  const adsets = Array.isArray(raw.adsets)
    ? raw.adsets.map(normalizeAdSet).filter((a): a is CampaignAdSet => a !== null)
    : []
  return {
    id,
    name: safeString(raw.name),
    status: safeString(raw.status),
    dailyBudget: safeString(raw.dailyBudget ?? raw.daily_budget),
    startTime: safeString(raw.startTime ?? raw.start_time),
    adsetCount: safeNumber(raw.adsetCount ?? raw.adset_count),
    activeAdsetCount: safeNumber(raw.activeAdsetCount ?? raw.active_adset_count),
    adsets,
    reach: safeString(raw.reach),
    impressions: safeString(raw.impressions),
    spend: safeString(raw.spend),
    costPerLinkClick: safeString(raw.costPerLinkClick ?? raw.cost_per_link_click),
    source: safeString(raw.source),
  }
}

// Resolve the ad account from page settings, falling back to the default.
export async function resolveAdAccount(signal?: AbortSignal): Promise<string> {
  try {
    const data = await workerFetchJson<Record<string, string>>(
      `/api/dashboard/settings?page_id=${encodeURIComponent(DEFAULT_PAGE_ID)}`,
      { signal, timeoutMs: 15_000 },
    )
    const acct = safeString(data.ad_account)
    return acct || DEFAULT_AD_ACCOUNT
  } catch {
    return DEFAULT_AD_ACCOUNT
  }
}

export interface FetchCampaignsOptions {
  /** Scope the worker's history fallback to these page ids (the Create Ads master's held pages). */
  pageIds?: string[]
  /** 'picker' = fast adset-count-only mode (no per-campaign insights); omit for full insights. */
  mode?: 'picker'
}

// Full read-only campaigns fetch — returns the normalized list AND the worker's provenance so the UI
// can be honest about whether the rows came from the live Graph account edge or the verified
// dashboard_ad_history fallback. Both /dashboard/campaigns and the Create Ads active-campaign summary
// call this, so they always agree on the same source.
export async function fetchCampaignsResult(
  adAccount: string,
  options: FetchCampaignsOptions = {},
  signal?: AbortSignal,
): Promise<CampaignsResult> {
  const qs = new URLSearchParams({ ad_account: adAccount })
  const ids = (options.pageIds ?? []).map((id) => id.trim()).filter(Boolean)
  if (ids.length) qs.set('page_ids', ids.join(','))
  if (options.mode) qs.set('mode', options.mode)
  const data = await workerFetchJson<{
    campaigns?: unknown[]
    source?: unknown
    graph_available?: unknown
    graph_error?: unknown
  }>(`/api/dashboard/campaigns?${qs.toString()}`, { signal, timeoutMs: 30_000 })
  const list = Array.isArray(data.campaigns) ? data.campaigns : []
  return {
    campaigns: list.map(normalize).filter((c): c is Campaign => c !== null),
    source: safeString(data.source),
    graphAvailable: data.graph_available !== false,
    graphError: safeString(data.graph_error),
  }
}

export async function fetchCampaigns(adAccount: string, signal?: AbortSignal): Promise<Campaign[]> {
  const result = await fetchCampaignsResult(adAccount, {}, signal)
  return result.campaigns
}

export function dailyBudgetThb(value: string): string {
  const n = safeNumber(value)
  if (!n) return '—'
  return `฿${(n / 100).toLocaleString()}`
}

export function adsManagerUrl(adAccount: string, campaignId: string): string {
  const acct = adAccount.replace(/^act_/, '')
  return `https://www.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(acct)}&campaign_ids=${encodeURIComponent(campaignId)}`
}
