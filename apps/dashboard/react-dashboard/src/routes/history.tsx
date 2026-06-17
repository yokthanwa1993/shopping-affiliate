import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { buildFbPostUrl, fetchHistory } from '@/api/history'
import { todayBangkokDate, formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

function statusVariant(status: string): 'success' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'success' || status === 'verified') return 'success'
  if (status === 'failed' || status === 'error') return 'destructive'
  if (status === 'pending' || status === 'queued') return 'secondary'
  return 'outline'
}

export function HistoryPage() {
  const [date, setDate] = useState(todayBangkokDate())
  const query = useQuery({
    queryKey: ['post-history', date],
    queryFn: ({ signal }) => fetchHistory(date, signal),
  })

  const rows = query.data ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <p className="text-sm text-muted-foreground">ประวัติการเผยแพร่โพสต์ไปเพจ</p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <Label htmlFor="h-date">วันที่ (Asia/Bangkok)</Label>
          <Input id="h-date" type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
        </Button>
      </div>

      {query.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          โหลดประวัติไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          ไม่มีการเผยแพร่ในวันที่เลือก
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const postUrl = buildFbPostUrl(row)
            return (
              <Card key={row.id || row.videoId}>
                <CardContent className="space-y-1.5 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={statusVariant(row.status)}>โพสต์: {row.status || '—'}</Badge>
                    {row.commentStatus ? (
                      <Badge variant={statusVariant(row.commentStatus)}>คอมเมนต์: {row.commentStatus}</Badge>
                    ) : null}
                    {row.triggerSource ? <Badge variant="outline">{row.triggerSource}</Badge> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="font-mono">{row.videoId || `#${row.id}`}</span>
                    {row.postedAt ? <span>· {formatThaiDateTime(row.postedAt)}</span> : null}
                    {row.postProfileName ? <span>· โดย {row.postProfileName}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-3 pt-0.5 text-xs">
                    {postUrl ? (
                      <a href={postUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        เปิดโพสต์ ↗
                      </a>
                    ) : null}
                    {row.shopeeLink ? (
                      <a href={row.shopeeLink} target="_blank" rel="noreferrer" className="text-orange-700 hover:underline">
                        Shopee ↗
                      </a>
                    ) : null}
                  </div>
                  {row.errorMessage ? <p className="text-xs text-destructive">{row.errorMessage}</p> : null}
                  {row.commentError ? <p className="text-xs text-destructive">comment: {row.commentError}</p> : null}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
