import { workerFetchJson } from '@/api/client'
import { isRecord, safeNumber, safeString } from '@/lib/data'

// Read-only Shopee Affiliate dashboard metrics for the Overview page. Source is
// the public daily-income report behind the worker proxy alias
// (/worker-api/daily_income -> api.pubilo.com -> customlink.wwoom.com
// /daily-income-report), which fetches Shopee's own /api/v3/dashboard/detail
// for the CHEARB affiliate account. We surface only what the API actually
// returns — clicks, orders, est. commission, items sold, order amount — and
// leave anything Shopee does not expose (e.g. new buyers) as null so the UI can
// render "—" instead of a fabricated number.

export type ApiStatus = 'ok' | 'partial' | 'down'

// CHEARB / เฉียบ workspace Shopee affiliate id. Neesz (15142270000) is a
// separate account; the dashboard's current workspace is CHEARB so we default to
// Chearb only. Not a secret — this is a public affiliate id already used in the
// click/conversion report contract.
export const CHEARB_SHOPEE_AFFILIATE_ID = '15130770000'

export interface OverviewSummary {
  clicks: number | null
  orders: number | null
  // Estimated commission to the affiliate, in THB.
  commission: number | null
  itemsSold: number | null
  // Gross order amount (purchase value), in THB.
  orderAmount: number | null
  // Shopee's dashboard/detail summary does not break out new buyers, so this
  // stays null and the UI renders "—".
  newBuyers: number | null
  // Our traffic is social/page-post driven, so the single clicks figure doubles
  // as the "Social Media" channel count. Mirrors `clicks` when available.
  socialMediaClicks: number | null
  // Shopee's "last update" timestamp string, passed through verbatim when present.
  lastUpdateTime: string | null
  apiStatus: ApiStatus
  error: string | null
}

function emptySummary(): OverviewSummary {
  return {
    clicks: null,
    orders: null,
    commission: null,
    itemsSold: null,
    orderAmount: null,
    newBuyers: null,
    socialMediaClicks: null,
    lastUpdateTime: null,
    apiStatus: 'down',
    error: null,
  }
}

// Pull a numeric field from the top-level totals first (when the upstream sums
// it there) then fall back to summing the per-account values — Shopee's totals
// object only sums orders/purchase_value/commission, so clicks and item_sold
// have to be aggregated from accounts[].
function sumAccounts(accounts: Record<string, unknown>[], keys: string[]): number | null {
  let found = false
  let total = 0
  for (const account of accounts) {
    if (safeString(account.status) && safeString(account.status) !== 'ok') continue
    for (const key of keys) {
      if (account[key] != null) {
        total += safeNumber(account[key])
        found = true
        break
      }
    }
  }
  return found ? total : null
}

function pickTotal(
  totals: Record<string, unknown>,
  accounts: Record<string, unknown>[],
  totalKeys: string[],
  accountKeys: string[],
): number | null {
  for (const key of totalKeys) {
    if (totals[key] != null) return safeNumber(totals[key])
  }
  return sumAccounts(accounts, accountKeys)
}

export function normalizeOverviewSummary(payload: unknown): OverviewSummary {
  const summary = emptySummary()
  const record = isRecord(payload) ? payload : {}

  const rawAccounts = Array.isArray(record.accounts) ? record.accounts : []
  const accounts = rawAccounts.filter(isRecord)
  const totals = isRecord(record.totals) ? record.totals : {}

  summary.clicks = pickTotal(totals, accounts, ['clicks', 'clicks_sum'], ['clicks', 'clicks_sum'])
  summary.orders = pickTotal(
    totals,
    accounts,
    ['orders', 'total_count'],
    ['orders', 'total_count', 'cv_by_order_sum'],
  )
  summary.commission = pickTotal(
    totals,
    accounts,
    ['commission'],
    ['commission', 'est_commission_sum'],
  )
  summary.itemsSold = pickTotal(
    totals,
    accounts,
    ['item_sold', 'items_sold'],
    ['item_sold', 'items_sold', 'item_sold_sum'],
  )
  summary.orderAmount = pickTotal(
    totals,
    accounts,
    ['purchase_value', 'order_amount'],
    ['purchase_value', 'order_amount', 'order_amount_sum'],
  )

  // Shopee does not surface a new-buyers figure here; leave it null.
  summary.newBuyers = null
  // Single real clicks count, relabeled as the social-media channel.
  summary.socialMediaClicks = summary.clicks

  // First non-empty last_update_time wins (accounts share the same period).
  for (const account of accounts) {
    const ts = safeString(account.last_update_time)
    if (ts) {
      summary.lastUpdateTime = ts
      break
    }
  }
  if (!summary.lastUpdateTime) {
    const topTs = safeString(record.last_update_time)
    if (topTs) summary.lastUpdateTime = topTs
  }

  const okCount = accounts.filter((a) => safeString(a.status) === 'ok').length
  const overallStatus = safeString(record.status)
  if (accounts.length === 0) {
    summary.apiStatus = overallStatus === 'ok' ? 'ok' : 'down'
  } else if (okCount === accounts.length) {
    summary.apiStatus = 'ok'
  } else if (okCount === 0) {
    summary.apiStatus = 'down'
  } else {
    summary.apiStatus = 'partial'
  }

  // Surface a redacted, public reason when nothing usable came back (e.g. the
  // Shopee session needs a manual re-login) so the UI can show a neutral note.
  if (summary.apiStatus !== 'ok') {
    const reason = safeString(record.error) || safeString(record.reason)
    summary.error = reason || null
  }

  return summary
}

export async function fetchOverviewSummary(signal?: AbortSignal): Promise<OverviewSummary> {
  try {
    const payload = await workerFetchJson<unknown>(
      `/daily_income?ids=${CHEARB_SHOPEE_AFFILIATE_ID}&time=today`,
      { signal, timeoutMs: 20_000 },
    )
    return normalizeOverviewSummary(payload)
  } catch (error) {
    const summary = emptySummary()
    summary.apiStatus = 'down'
    summary.error = error instanceof Error ? error.message : 'unavailable'
    return summary
  }
}
