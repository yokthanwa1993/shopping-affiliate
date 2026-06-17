import { useQuery } from '@tanstack/react-query'
import { fetchAdQueue, type AdQueueStatus } from '@/api/adQueue'
import { formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

function statusVariant(status: AdQueueStatus): 'success' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'destructive'
  if (status === 'processing') return 'secondary'
  return 'outline'
}

export function QueuePage() {
  const query = useQuery({
    queryKey: ['ad-queue'],
    queryFn: ({ signal }) => fetchAdQueue(signal),
  })

  const data = query.data
  const items = data?.items ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">คิวสร้างแอด</h1>
        <p className="text-sm text-muted-foreground">
          คิวงานสร้างโฆษณาอัตโนมัติ — ระบบรันงานในคิวให้ตามรอบเวลาที่ตั้งไว้
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-3">
          {data?.lastRunAt ? <span>รันล่าสุด {formatThaiDateTime(data.lastRunAt)}</span> : null}
          {data?.nextRunAt ? <span>· รันถัดไป {formatThaiDateTime(data.nextRunAt)}</span> : null}
          {data ? <span>· ทุก {data.intervalMinutes} นาที</span> : null}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
        </Button>
      </div>

      {query.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          โหลดคิวไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">งานในคิว ({items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">ไม่มีงานในคิว</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>วิดีโอ / แคมเปญ</TableHead>
                  <TableHead>สถานะ</TableHead>
                  <TableHead>สร้างเมื่อ</TableHead>
                  <TableHead>ผลลัพธ์</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">{item.id}</TableCell>
                    <TableCell>
                      <div className="max-w-[18rem]">
                        <p className="truncate text-sm">{item.newCampaignName || item.caption || '—'}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{item.videoId}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                      {item.errorMessage ? (
                        <p className="mt-0.5 max-w-[14rem] truncate text-[11px] text-destructive" title={item.errorMessage}>
                          {item.errorMessage}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatThaiDateTime(item.createdAt) || '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {item.resultAdId ? (
                        <span className="font-mono">ad {item.resultAdId}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
