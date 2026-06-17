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

export async function fetchCampaigns(adAccount: string, signal?: AbortSignal): Promise<Campaign[]> {
  const data = await workerFetchJson<{ campaigns?: unknown[] }>(
    `/api/dashboard/campaigns?ad_account=${encodeURIComponent(adAccount)}`,
    { signal, timeoutMs: 30_000 },
  )
  const list = Array.isArray(data.campaigns) ? data.campaigns : []
  return list.map(normalize).filter((c): c is Campaign => c !== null)
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
