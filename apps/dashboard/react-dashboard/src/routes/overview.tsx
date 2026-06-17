import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, Activity, Wallet, Users } from 'lucide-react'
import type { ComponentType } from 'react'
import { fetchOverviewSummary, type ApiStatus } from '@/api/overview'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Live operator overview — parity with the Svelte OverviewCards
// (apps/dashboard/src/components/OverviewCards.svelte): four summary tiles fed by
// the same read endpoints plus the API-status footer. The Astro index also had a
// demo trend chart and a static campaigns table; those carried no real data, so
// they are intentionally dropped here in favor of quick-links to the real tools.

type Tone = 'pos' | 'neg' | 'neutral'

interface Tile {
  label: string
  value: number | null
  meta: string
  tone: Tone
  icon: ComponentType<{ className?: string }>
  to: '/gallery' | '/processing' | '/source-inventory'
}

const SHORTCUTS = [
  { to: '/gallery', label: 'แกลลี่', desc: 'คลิปที่ import พร้อมโพสต์' },
  { to: '/source-inventory', label: 'คลังต้นฉบับ', desc: 'วิดีโอต้นฉบับจาก LINE Mini App' },
  { to: '/processing', label: 'Processing', desc: 'สถานะ pipeline แปลงคลิป' },
  { to: '/page-posts', label: 'โพสต์เพจ', desc: 'โพสต์เพจที่มียอดวิว ≥ 100K' },
  { to: '/campaigns', label: 'Campaigns', desc: 'real-time จาก Facebook Ads Manager' },
  { to: '/create-ads', label: 'Create Ads', desc: 'เลือกคลิป → enqueue สร้างแอด' },
  { to: '/queue', label: 'คิวสร้างแอด', desc: 'งานสร้างแอดที่กำลังทำ' },
  { to: '/history', label: 'History', desc: 'โพสต์ที่ promote แล้ววันนี้' },
] as const

const STATUS_LABEL: Record<ApiStatus, string> = {
  ok: 'ปกติ',
  partial: 'บางจุดล่ม',
  down: 'เข้าไม่ได้',
}

function formatValue(value: number | null): string {
  return value == null ? '—' : value.toLocaleString()
}

export function OverviewPage() {
  const query = useQuery({
    queryKey: ['overview-summary'],
    queryFn: ({ signal }) => fetchOverviewSummary(signal),
  })

  const data = query.data
  const tiles: Tile[] = [
    {
      label: 'Gallery ready',
      // Fast path returns presence (≥1), not an exact total — meta says so.
      value: data?.galleryReady ?? null,
      meta: (data?.galleryReady ?? 0) > 0 ? 'มีคลิปพร้อมโพสต์' : 'ยังไม่มี',
      tone: (data?.galleryReady ?? 0) > 0 ? 'pos' : 'neutral',
      icon: BarChart3,
      to: '/gallery',
    },
    {
      label: 'Processing active',
      value: data?.processingActive ?? null,
      meta: (data?.processingActive ?? 0) > 0 ? 'กำลังทำงาน' : 'ว่าง',
      tone: (data?.processingActive ?? 0) > 0 ? 'pos' : 'neutral',
      icon: Activity,
      to: '/processing',
    },
    {
      label: 'Failed jobs',
      value: data?.failedJobs ?? null,
      meta: (data?.failedJobs ?? 0) > 0 ? 'ตรวจสอบ' : 'ปกติ',
      tone: (data?.failedJobs ?? 0) > 0 ? 'neg' : 'pos',
      icon: Wallet,
      to: '/processing',
    },
    {
      label: 'คลังต้นฉบับ',
      value: data?.inboxUnprocessed ?? null,
      meta: 'รอประมวลผล',
      tone: (data?.inboxUnprocessed ?? 0) > 0 ? 'pos' : 'neutral',
      icon: Users,
      to: '/source-inventory',
    },
  ]

  const status: ApiStatus = query.isError ? 'down' : data?.apiStatus ?? 'down'

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">ภาพรวม</h1>
        <p className="text-sm text-muted-foreground">
          สรุปสถานะ pipeline แบบเรียลไทม์ · อ่านจาก{' '}
          <code className="rounded bg-muted px-1">/worker-api</code> เหมือนแดชบอร์ดเดิม
        </p>
      </div>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            to={tile.to}
            className="rounded-2xl border bg-card p-4 transition hover:border-foreground/20 hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">{tile.label}</p>
              <tile.icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-4 flex items-end justify-between gap-3">
              <p className="text-3xl font-semibold tracking-tight">
                {query.isLoading ? <span className="text-muted-foreground">…</span> : formatValue(tile.value)}
              </p>
              <span
                className={cn(
                  'text-sm font-semibold',
                  tile.tone === 'pos'
                    ? 'text-emerald-600'
                    : tile.tone === 'neg'
                      ? 'text-red-500'
                      : 'text-muted-foreground',
                )}
              >
                {tile.meta}
              </span>
            </div>
          </Link>
        ))}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card px-4 py-3 text-sm">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-block h-2.5 w-2.5 rounded-full',
              status === 'ok'
                ? 'bg-emerald-500'
                : status === 'partial'
                  ? 'bg-amber-500'
                  : query.isLoading
                    ? 'bg-muted-foreground/40'
                    : 'bg-rose-500',
            )}
          />
          <span className="font-medium">
            API status: {query.isLoading ? 'กำลังตรวจ…' : STATUS_LABEL[status]}
          </span>
          <span className="text-muted-foreground">· /worker-api → api.pubilo.com</span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
        </Button>
      </div>

      <section className="rounded-2xl border bg-card p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">ทางลัด</h2>
            <p className="text-xs text-muted-foreground">ไปยังเครื่องมือหลักของ operator console</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {SHORTCUTS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-2xl border bg-background p-3 transition hover:border-foreground/20 hover:shadow-sm"
            >
              <p className="text-sm font-semibold">{item.label}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{item.desc}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
