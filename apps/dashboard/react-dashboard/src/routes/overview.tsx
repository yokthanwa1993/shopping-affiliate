import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Activity, RefreshCw } from 'lucide-react'
import { fetchOverviewSummary, type ApiStatus } from '@/api/overview'
import { cn } from '@/lib/utils'

// Shopee-Affiliate-style operator overview. Same live data as the previous
// build (gallery/processing/inbox counts + worker API status from
// fetchOverviewSummary) — only the presentation was reworked to resemble the
// Shopee Affiliate dashboard: a Data Period bar, a white Key Metrics panel of
// metric boxes, a worker-health row (the Shopee "Clicks Breakdown" slot), and a
// tools table (the Shopee "My Top 5 Products" slot). No fake/secret data: every
// number is a real summary count or "—" when unavailable.

type Tone = 'pos' | 'neg' | 'neutral'

// A metric box is either a live count ('number'), the worker status dot
// ('status'), or a static text value ('text' — e.g. the workspace name).
type MetricKind = 'number' | 'status' | 'text'

interface Metric {
  label: string
  kind: MetricKind
  value: number | null
  text?: string
  meta: string
  tone: Tone
  to: '/gallery' | '/processing' | '/source-inventory' | '/campaigns'
}

interface ToolRow {
  to: '/gallery' | '/processing' | '/source-inventory' | '/create-ads' | '/campaigns' | '/queue'
  name: string
  sub: string
  // `dynamic` rows carry a live count (show "…" while loading); link-only rows
  // have no metric and render "—".
  dynamic: boolean
  value: number | null
  status: string
  tone: Tone
}

const STATUS_LABEL: Record<ApiStatus, string> = {
  ok: 'ปกติ',
  partial: 'บางจุดล่ม',
  down: 'เข้าไม่ได้',
}

function formatValue(value: number | null): string {
  return value == null ? '—' : value.toLocaleString()
}

// DD-MM-YYYY to match the Shopee "Data Period" pill (e.g. 24-06-2026).
function formatToday(): string {
  const now = new Date()
  const dd = String(now.getDate()).padStart(2, '0')
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${now.getFullYear()}`
}

function toneClass(tone: Tone): string {
  return tone === 'pos'
    ? 'text-emerald-600'
    : tone === 'neg'
      ? 'text-[#ee4d2d]'
      : 'text-[#999999]'
}

export function OverviewPage() {
  const query = useQuery({
    queryKey: ['overview-summary'],
    queryFn: ({ signal }) => fetchOverviewSummary(signal),
  })

  const data = query.data
  const status: ApiStatus = query.isError ? 'down' : data?.apiStatus ?? 'down'

  const galleryReady = data?.galleryReady ?? null
  const processingActive = data?.processingActive ?? null
  const failedJobs = data?.failedJobs ?? null
  const inboxUnprocessed = data?.inboxUnprocessed ?? null

  const metrics: Metric[] = [
    {
      label: 'Gallery ready',
      kind: 'number',
      value: galleryReady,
      meta: (galleryReady ?? 0) > 0 ? 'มีคลิปพร้อมโพสต์' : 'ยังไม่มี',
      tone: (galleryReady ?? 0) > 0 ? 'pos' : 'neutral',
      to: '/gallery',
    },
    {
      label: 'Processing active',
      kind: 'number',
      value: processingActive,
      meta: (processingActive ?? 0) > 0 ? 'กำลังทำงาน' : 'ว่าง',
      tone: (processingActive ?? 0) > 0 ? 'pos' : 'neutral',
      to: '/processing',
    },
    {
      label: 'Failed jobs',
      kind: 'number',
      value: failedJobs,
      meta: (failedJobs ?? 0) > 0 ? 'ต้องตรวจสอบ' : 'ปกติ',
      tone: (failedJobs ?? 0) > 0 ? 'neg' : 'pos',
      to: '/processing',
    },
    {
      label: 'Source inventory',
      kind: 'number',
      value: inboxUnprocessed,
      meta: 'รอประมวลผล',
      tone: (inboxUnprocessed ?? 0) > 0 ? 'pos' : 'neutral',
      to: '/source-inventory',
    },
    {
      label: 'API status',
      kind: 'status',
      value: null,
      meta: query.isLoading ? 'กำลังตรวจ…' : STATUS_LABEL[status],
      tone: status === 'ok' ? 'pos' : status === 'partial' ? 'neutral' : 'neg',
      to: '/processing',
    },
    {
      label: 'Workspace',
      kind: 'text',
      value: null,
      text: 'PUBILO',
      meta: 'เครื่องมือทั้งหมด',
      tone: 'neutral',
      to: '/campaigns',
    },
  ]

  const tools: ToolRow[] = [
    {
      to: '/gallery',
      name: 'แกลลี่',
      sub: 'Gallery',
      dynamic: true,
      value: galleryReady,
      status: (galleryReady ?? 0) > 0 ? 'พร้อมโพสต์' : 'ว่าง',
      tone: (galleryReady ?? 0) > 0 ? 'pos' : 'neutral',
    },
    {
      to: '/processing',
      name: 'ประมวลผล',
      sub: 'Processing',
      dynamic: true,
      value: processingActive,
      status: (processingActive ?? 0) > 0 ? 'กำลังทำงาน' : 'ว่าง',
      tone: (processingActive ?? 0) > 0 ? 'pos' : 'neutral',
    },
    {
      to: '/source-inventory',
      name: 'คลังต้นฉบับ',
      sub: 'Source Inventory',
      dynamic: true,
      value: inboxUnprocessed,
      status: (inboxUnprocessed ?? 0) > 0 ? 'รอประมวลผล' : 'ว่าง',
      tone: (inboxUnprocessed ?? 0) > 0 ? 'pos' : 'neutral',
    },
    {
      to: '/create-ads',
      name: 'สร้างแอด',
      sub: 'Create Ads',
      dynamic: false,
      value: null,
      status: 'พร้อมใช้',
      tone: 'neutral',
    },
    {
      to: '/campaigns',
      name: 'แคมเปญ',
      sub: 'Campaigns',
      dynamic: false,
      value: null,
      status: 'พร้อมใช้',
      tone: 'neutral',
    },
    {
      to: '/queue',
      name: 'คิวสร้างแอด',
      sub: 'Queue',
      dynamic: false,
      value: null,
      status: 'พร้อมใช้',
      tone: 'neutral',
    },
  ]

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
          {formatToday()}
        </span>
        <span className="ml-auto text-[13px] text-[#999999]">
          ข้อมูลอัปเดตอัตโนมัติเมื่อรีเฟรช · Data is updated on refresh
        </span>
      </div>

      {/* 2. Key Metrics panel */}
      <section className="rounded-[2px] bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#333333]">Key Metrics</h2>
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-[#999999]">vs previous day</span>
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
            <Link
              key={metric.label}
              to={metric.to}
              className="rounded-[2px] border border-[#eeeeee] p-4 transition-colors hover:border-[#ee4d2d]/50 hover:shadow-sm"
            >
              <p className="text-[13px] text-[#666666]">{metric.label}</p>
              <div className="mt-2 flex items-end justify-between gap-2">
                <div className="text-2xl font-semibold tracking-tight text-[#222222]">
                  {metric.kind === 'number' ? (
                    query.isLoading ? '…' : formatValue(metric.value)
                  ) : metric.kind === 'status' ? (
                    <span
                      className={cn(
                        'inline-block h-4 w-4 rounded-full',
                        status === 'ok'
                          ? 'bg-emerald-500'
                          : status === 'partial'
                            ? 'bg-amber-500'
                            : query.isLoading
                              ? 'bg-[#cccccc]'
                              : 'bg-[#ee4d2d]',
                      )}
                    />
                  ) : (
                    metric.text
                  )}
                </div>
                <span className={cn('text-xs font-medium', toneClass(metric.tone))}>{metric.meta}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* 3. Clicks-Breakdown slot → worker health row */}
      <section className="rounded-[2px] bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-[#333333]">Worker Health</h2>
        <div className="flex items-center justify-between rounded-[2px] border border-[#eeeeee] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'inline-block h-2.5 w-2.5 rounded-full',
                status === 'ok'
                  ? 'bg-emerald-500'
                  : status === 'partial'
                    ? 'bg-amber-500'
                    : query.isLoading
                      ? 'bg-[#cccccc]'
                      : 'bg-[#ee4d2d]',
              )}
            />
            <Activity className="h-4 w-4 text-[#999999]" />
            <span className="text-sm text-[#333333]">
              Worker API · <span className="text-[#999999]">/worker-api → api.pubilo.com</span>
            </span>
          </div>
          <span className="text-sm font-semibold text-[#333333]">
            {query.isLoading ? 'กำลังตรวจ…' : STATUS_LABEL[status]}
          </span>
        </div>
      </section>

      {/* 4. My-Top-5-Products slot → tools table */}
      <section className="rounded-[2px] bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-semibold text-[#333333]">เครื่องมือหลัก · Tools</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[#eeeeee] text-left text-[13px] text-[#999999]">
                <th className="py-2.5 pr-3 font-normal">Tool</th>
                <th className="py-2.5 px-3 font-normal">Status</th>
                <th className="py-2.5 px-3 text-right font-normal">Metric</th>
                <th className="py-2.5 pl-3 text-right font-normal">Action</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.to + tool.name} className="border-b border-[#f5f5f5] last:border-0">
                  <td className="py-3 pr-3">
                    <div className="font-medium text-[#2673dd]">{tool.name}</div>
                    <div className="text-[12px] text-[#999999]">{tool.sub}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={cn('text-[13px] font-medium', toneClass(tool.tone))}>{tool.status}</span>
                  </td>
                  <td className="px-3 py-3 text-right text-[#333333]">
                    {query.isLoading && tool.dynamic ? '…' : formatValue(tool.value)}
                  </td>
                  <td className="py-3 pl-3 text-right">
                    <Link
                      to={tool.to}
                      className="inline-flex items-center rounded-[2px] bg-[#ee4d2d] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#d8431f]"
                    >
                      เปิด
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
