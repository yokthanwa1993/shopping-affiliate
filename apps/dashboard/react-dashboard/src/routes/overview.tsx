import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { fetchOverviewSummary, type ApiStatus, type OverviewSummary } from '@/api/overview'
import { cn } from '@/lib/utils'

// Shopee-Affiliate-style operator overview. Now backed by REAL Shopee dashboard
// metrics for the CHEARB affiliate account (fetchOverviewSummary -> daily-income
// report proxy): clicks, orders, est. commission, items sold, order amount. We
// never fabricate numbers — any metric Shopee does not expose (e.g. new buyers)
// renders "—" with a neutral note. The presentation is our own recreation of the
// Shopee look, not copied Shopee CSS.

const STATUS_LABEL: Record<ApiStatus, string> = {
  ok: 'ข้อมูลจริงจาก API',
  partial: 'บางบัญชียังไม่พร้อม',
  down: 'ดึงข้อมูลไม่ได้',
}

// Compact Thai formatting matching the Shopee dashboard pills:
//   23800 -> 23.8พัน   13000 -> 13พัน   744000 -> 744พัน   2_500_000 -> 2.5ล้าน
function trimNum(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString('th-TH', { maximumFractionDigits: 1 })
}

function formatCompact(value: number | null): string {
  if (value == null) return '—'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${trimNum(value / 1_000_000)}ล้าน`
  if (abs >= 1_000) return `${trimNum(value / 1_000)}พัน`
  return value.toLocaleString('th-TH', { maximumFractionDigits: 2 })
}

function formatBaht(value: number | null): string {
  if (value == null) return '—'
  return `฿${formatCompact(value)}`
}

// Exact figure for the hover title, so the compact display never hides the real
// number. Returns undefined (no title) when the metric is unavailable.
function exactTitle(value: number | null): string | undefined {
  return value == null ? undefined : value.toLocaleString('th-TH', { maximumFractionDigits: 2 })
}

// DD-MM-YYYY fallback for the Shopee "Data Period" pill. The report API
// defaults to yesterday because same-day Shopee totals are often not available yet.
function formatYesterdayBangkok(): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const bangkokToday = new Date(`${formatter.format(new Date())}T00:00:00+07:00`)
  bangkokToday.setDate(bangkokToday.getDate() - 1)
  const yyyy = bangkokToday.getFullYear()
  const mm = String(bangkokToday.getMonth() + 1).padStart(2, '0')
  const dd = String(bangkokToday.getDate()).padStart(2, '0')
  return `${dd}-${mm}-${yyyy}`
}

interface MetricCard {
  label: string
  sub: string
  value: number | null
  display: string
  // Neutral per-metric note — real source label or an "unavailable" hint. Never
  // a fabricated day-over-day delta.
  note: string
  available: boolean
}

function buildMetrics(data: OverviewSummary | undefined): MetricCard[] {
  const d = data
  return [
    {
      label: 'คลิก',
      sub: 'Clicks',
      value: d?.clicks ?? null,
      display: formatCompact(d?.clicks ?? null),
      note: d?.clicks != null ? 'ข้อมูลจริงจาก API' : 'ไม่มีข้อมูล',
      available: d?.clicks != null,
    },
    {
      label: 'คำสั่งซื้อ',
      sub: 'Orders',
      value: d?.orders ?? null,
      display: formatCompact(d?.orders ?? null),
      note: d?.orders != null ? 'ข้อมูลจริงจาก API' : 'ไม่มีข้อมูล',
      available: d?.orders != null,
    },
    {
      label: 'ค่าคอมมิชชั่นโดยประมาณ',
      sub: 'Est. Commission (฿)',
      value: d?.commission ?? null,
      display: formatBaht(d?.commission ?? null),
      note: d?.commission != null ? 'ข้อมูลจริงจาก API' : 'ไม่มีข้อมูล',
      available: d?.commission != null,
    },
    {
      label: 'จำนวนที่ขายได้',
      sub: 'Items Sold',
      value: d?.itemsSold ?? null,
      display: formatCompact(d?.itemsSold ?? null),
      note: d?.itemsSold != null ? 'ข้อมูลจริงจาก API' : 'ไม่มีข้อมูล',
      available: d?.itemsSold != null,
    },
    {
      label: 'จำนวนคำสั่งซื้อ',
      sub: 'Order Amount (฿)',
      value: d?.orderAmount ?? null,
      display: formatBaht(d?.orderAmount ?? null),
      note: d?.orderAmount != null ? 'ข้อมูลจริงจาก API' : 'ไม่มีข้อมูล',
      available: d?.orderAmount != null,
    },
    {
      label: 'ลูกค้าใหม่',
      sub: 'New Buyers',
      value: d?.newBuyers ?? null,
      display: formatCompact(d?.newBuyers ?? null),
      // Shopee's dashboard/detail summary doesn't expose this — keep it honest.
      note: 'API ไม่มีข้อมูลนี้',
      available: d?.newBuyers != null,
    },
  ]
}

export function OverviewPage() {
  const query = useQuery({
    queryKey: ['overview-summary'],
    queryFn: ({ signal }) => fetchOverviewSummary(signal),
  })

  const data = query.data
  const status: ApiStatus = query.isError ? 'down' : data?.apiStatus ?? 'down'
  const metrics = buildMetrics(data)
  const socialMediaClicks = data?.socialMediaClicks ?? null

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {/* Breadcrumb — Shopee shows "Homepage / Dashboard" above the content. */}
      <div className="text-[13px]">
        <span className="text-[#999999]">Homepage</span>
        <span className="mx-1 text-[#cccccc]">/</span>
        <span className="text-[#333333]">Dashboard</span>
      </div>

      {/* 1. Data Period bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-[2px] bg-white px-4 py-3 shadow-sm">
        <span className="text-sm font-medium text-[#333333]">Data Period</span>
        <span className="inline-flex items-center rounded-[2px] border border-[#e0e0e0] px-3 py-1 text-sm text-[#333333]">
          {data?.reportDateLabel ?? formatYesterdayBangkok()}
        </span>
        <span className="ml-auto text-[13px] text-[#999999]">
          {data?.lastUpdateTime
            ? `อัปเดตล่าสุดจาก Shopee: ${data.lastUpdateTime}`
            : 'ข้อมูลจริงจาก Shopee Affiliate · CHEARB · เมื่อวาน'}
        </span>
      </div>

      {/* 2. Key Metrics panel */}
      <section className="rounded-[2px] bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#333333]">Key Metrics</h2>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'text-[13px]',
                status === 'ok'
                  ? 'text-emerald-600'
                  : status === 'partial'
                    ? 'text-amber-600'
                    : 'text-[#ee4d2d]',
              )}
            >
              {query.isLoading ? 'กำลังโหลด…' : STATUS_LABEL[status]}
            </span>
            <button
              type="button"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              className="inline-flex items-center gap-1.5 rounded-[2px] border border-[#e0e0e0] px-2.5 py-1 text-xs font-medium text-[#666666] transition-colors hover:border-[#ee4d2d] hover:text-[#ee4d2d] disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin')} />
              {query.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {metrics.map((metric) => (
            <div
              key={metric.sub}
              title={exactTitle(metric.value)}
              className="rounded-[2px] border border-[#eeeeee] p-4"
            >
              <p className="text-[13px] text-[#666666]">{metric.label}</p>
              <p className="text-[11px] text-[#bbbbbb]">{metric.sub}</p>
              <div className="mt-2 flex items-end justify-between gap-2">
                <div
                  className={cn(
                    'text-2xl font-semibold tracking-tight',
                    metric.available ? 'text-[#222222]' : 'text-[#cccccc]',
                  )}
                >
                  {query.isLoading ? '…' : metric.display}
                </div>
                <span
                  className={cn(
                    'text-xs font-medium',
                    metric.available ? 'text-[#999999]' : 'text-[#cccccc]',
                  )}
                >
                  {metric.note}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 3. Click breakdown — our traffic is social/page-post driven, so the real
          clicks figure is shown as the single Social Media channel (no fabricated
          channel split). Hidden entirely when no real clicks count exists. */}
      {socialMediaClicks != null && (
        <section className="rounded-[2px] bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#333333]">Click Breakdown</h2>
            <span className="text-[13px] text-[#999999]">ตามช่องทาง · by channel</span>
          </div>
          <div className="flex items-center justify-between rounded-[2px] border border-[#eeeeee] px-4 py-3">
            <div>
              <p className="text-sm font-medium text-[#333333]">Social Media</p>
              <p className="text-[12px] text-[#999999]">โพสต์/เพจ Facebook · ทราฟฟิกทั้งหมดเป็นโซเชียล</p>
            </div>
            <span
              className="text-xl font-semibold text-[#222222]"
              title={exactTitle(socialMediaClicks)}
            >
              {query.isLoading ? '…' : formatCompact(socialMediaClicks)}
            </span>
          </div>
        </section>
      )}

      {/* Neutral data-source footer. Surfaces a redacted reason when the Shopee
          session needs attention, never a secret/token. */}
      <p className="px-1 text-[12px] text-[#999999]">
        ที่มา: Shopee Affiliate Dashboard (CHEARB) ผ่าน /worker-api → api.pubilo.com ·
        {' '}
        {query.isLoading
          ? 'กำลังตรวจสอบสถานะ…'
          : status === 'ok'
            ? 'ข้อมูลจริงจาก API'
            : `สถานะ: ${STATUS_LABEL[status]}${data?.error ? ` (${data.error})` : ''}`}
      </p>
    </div>
  )
}
