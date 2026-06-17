import { useQuery } from '@tanstack/react-query'
import {
  adsManagerUrl,
  dailyBudgetThb,
  fetchCampaigns,
  resolveAdAccount,
} from '@/api/campaigns'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

function statusVariant(status: string): 'success' | 'secondary' | 'outline' {
  if (status === 'ACTIVE') return 'success'
  if (status === 'PAUSED') return 'secondary'
  return 'outline'
}

export function CampaignsPage() {
  const adAccountQuery = useQuery({
    queryKey: ['ad-account'],
    queryFn: ({ signal }) => resolveAdAccount(signal),
  })
  const adAccount = adAccountQuery.data

  const query = useQuery({
    queryKey: ['campaigns', adAccount],
    enabled: !!adAccount,
    queryFn: ({ signal }) => fetchCampaigns(adAccount as string, signal),
  })

  const campaigns = query.data ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          ข้อมูลเรียลไทม์จาก Facebook Ads Manager
          {adAccount ? <> · <span className="font-mono">{adAccount}</span></> : null}
        </p>
      </div>

      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching || !adAccount}>
          {query.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
        </Button>
      </div>

      {query.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          โหลด campaigns ไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
        </div>
      ) : null}

      {query.isLoading || adAccountQuery.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          ไม่พบแคมเปญในบัญชีโฆษณานี้
        </p>
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => (
            <Card key={c.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{c.name || c.id}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{c.id}</p>
                  </div>
                  <Badge variant={statusVariant(c.status)}>{c.status || '—'}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <Stat label="งบ/วัน" value={dailyBudgetThb(c.dailyBudget)} />
                  <Stat label="Ad sets" value={`${c.activeAdsetCount}/${c.adsetCount || c.adsets.length}`} />
                  <Stat label="Reach" value={c.reach || '—'} />
                  <Stat label="ใช้จ่าย" value={c.spend ? `฿${c.spend}` : '—'} />
                </div>
                <a
                  href={adsManagerUrl(adAccount as string, c.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block text-xs text-primary hover:underline"
                >
                  เปิดใน Ads Manager ↗
                </a>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  )
}
