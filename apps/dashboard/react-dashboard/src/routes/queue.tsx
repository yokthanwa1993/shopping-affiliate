import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  fetchAdOnlyQueue,
  runNextAdOnlyQueue,
  cancelAdOnlyQueueItem,
  setAdOnlyInterval,
  type AdQueueStatus,
} from '@/api/adQueue'
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

// AD-ONLY queue — the cadence lane that replays each row through create-ad-only (never page publish /
// legacy create-ad). Shows interval, next run, campaign date, source id, mode and the ad result, with
// run-now / cancel / interval controls.
function AdOnlyQueueSection() {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['ad-only-queue'],
    queryFn: ({ signal }) => fetchAdOnlyQueue(signal),
  })
  const data = query.data
  const items = data?.items ?? []
  const [intervalDraft, setIntervalDraft] = useState<number | null>(null)
  const intervalMinutes = intervalDraft ?? data?.intervalMinutes ?? 20

  const intervalMutation = useMutation({
    mutationFn: (minutes: number) => setAdOnlyInterval(minutes),
    onSuccess: (saved) => {
      setIntervalDraft(saved)
      void query.refetch()
    },
  })
  const runNextMutation = useMutation({
    mutationFn: () => runNextAdOnlyQueue(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ad-only-queue'] }),
  })
  const cancelMutation = useMutation({
    mutationFn: (id: number) => cancelAdOnlyQueueItem(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ad-only-queue'] }),
  })

  const queuedCount = items.filter((i) => i.status === 'queued').length

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">คิวสร้างแอด (แยกจากการเผยแพร่หน้าเพจ) — {items.length} งาน</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Cadence + run controls. */}
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-card p-3">
          <div className="flex flex-wrap items-end gap-2 text-xs text-muted-foreground">
            <label className="space-y-1">
              <span className="block font-medium">สร้างทุก … นาที</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={intervalMinutes}
                onChange={(e) => setIntervalDraft(Math.max(1, Math.min(1440, Math.round(Number(e.target.value) || 0))))}
                className="w-24 rounded-lg border bg-background px-2.5 py-1.5 text-sm text-foreground"
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => intervalMutation.mutate(intervalMinutes)}
              disabled={intervalMutation.isPending}
            >
              {intervalMutation.isPending ? 'กำลังบันทึก…' : 'บันทึกรอบเวลา'}
            </Button>
            <div className="flex flex-col gap-0.5 pb-1">
              {data?.lastRunAt ? <span>รันล่าสุด {formatThaiDateTime(data.lastRunAt)}</span> : null}
              {data?.nextRunAt ? <span>รันถัดไป {formatThaiDateTime(data.nextRunAt)}</span> : null}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => runNextMutation.mutate()}
              disabled={runNextMutation.isPending || queuedCount === 0}
              title={queuedCount === 0 ? 'ไม่มีงานในคิว' : 'สร้างงานถัดไปทันที (ข้ามรอบเวลา)'}
            >
              {runNextMutation.isPending ? 'กำลังสร้าง…' : 'สร้างงานถัดไปทันที'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
            </Button>
          </div>
        </div>

        {runNextMutation.data && !runNextMutation.data.ok ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            สร้างงานถัดไปไม่สำเร็จ: {runNextMutation.data.error || runNextMutation.data.reason || 'unknown'}
          </div>
        ) : null}

        {query.isError ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            โหลดคิวไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
          </div>
        ) : query.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            ยังไม่มีงานในคิว — เพิ่มได้จาก <Link to="/create-ads" className="font-semibold underline">หน้าสร้างแอด</Link>
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>แคมเปญ / ต้นทาง</TableHead>
                <TableHead>โหมด</TableHead>
                <TableHead>สถานะ</TableHead>
                <TableHead>ผลลัพธ์</TableHead>
                <TableHead className="text-right">จัดการ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const sourceId = item.storyId || item.postId || (item.fbVideoId ? `FB:${item.fbVideoId}` : '') || item.systemVideoId
                return (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">{item.id}</TableCell>
                    <TableCell>
                      <div className="max-w-[18rem]">
                        <p className="truncate text-sm">{item.dailyCampaignName || '(default ของ bridge)'}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{sourceId || '—'}</p>
                        {item.mode === 'active' && (item.dailyBudgetThb || item.runHours) ? (
                          <p className="truncate text-[11px] text-muted-foreground">
                            {item.dailyBudgetThb ? `งบ ${item.dailyBudgetThb} บาท` : ''}
                            {item.runHours ? ` · ${item.runHours} ชม.` : ''}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={item.mode === 'active' ? 'destructive' : 'secondary'}>
                        {item.mode === 'active' ? 'ACTIVE' : 'PAUSED'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                      {item.errorMessage ? (
                        <p className="mt-0.5 max-w-[14rem] truncate text-[11px] text-destructive" title={item.errorMessage}>
                          {item.errorMessage}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {item.resultAdId ? (
                        <span className="font-mono">ad {item.resultAdId}</span>
                      ) : (
                        <span className="text-muted-foreground">{formatThaiDateTime(item.createdAt) || '—'}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.status === 'queued' ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-destructive"
                          onClick={() => cancelMutation.mutate(item.id)}
                          disabled={cancelMutation.isPending}
                        >
                          ยกเลิก
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

export function QueuePage() {
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">คิวสร้างแอด</h1>
        <p className="text-sm text-muted-foreground">
          คิวงานสร้างโฆษณาอัตโนมัติ — ระบบหยิบงานในคิวมาสร้างทีละงานตามรอบเวลาที่ตั้งไว้
          <strong> สร้างเฉพาะแอด ไม่เผยแพร่โพสต์ลงหน้าเพจ</strong>
        </p>
      </div>

      <AdOnlyQueueSection />
    </div>
  )
}
