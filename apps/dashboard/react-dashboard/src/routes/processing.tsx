import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchProcessing, type ProcessingBucket } from '@/api/processing'
import { formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

const BUCKETS: Array<{ key: ProcessingBucket; label: string }> = [
  { key: 'active', label: 'กำลังทำงาน' },
  { key: 'failed', label: 'ล้มเหลว' },
  { key: 'completed', label: 'เสร็จแล้ว' },
]

export function ProcessingPage() {
  const [bucket, setBucket] = useState<ProcessingBucket>('active')
  const query = useQuery({
    queryKey: ['processing'],
    queryFn: ({ signal }) => fetchProcessing(signal),
  })

  const items = query.data?.items[bucket] ?? []
  const counts = query.data?.counts

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Processing</h1>
        <p className="text-sm text-muted-foreground">สถานะคิวประมวลผลวิดีโอ</p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          {BUCKETS.map((b) => (
            <Button
              key={b.key}
              type="button"
              size="sm"
              variant={bucket === b.key ? 'default' : 'ghost'}
              onClick={() => setBucket(b.key)}
            >
              {b.label}
              {counts ? ` (${counts[b.key]})` : ''}
            </Button>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
        </Button>
      </div>

      {query.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          โหลด processing ไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown error'}
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          ไม่มีรายการในกลุ่มนี้
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <Card key={item.id || `${item.title}-${i}`}>
              <CardContent className="flex flex-col gap-1 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
                  <Badge variant={bucket === 'failed' ? 'destructive' : bucket === 'completed' ? 'success' : 'secondary'}>
                    {item.status}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {item.id ? <span className="font-mono">{item.id}</span> : null}
                  {item.phase ? <span>· {item.phase}</span> : null}
                  {item.updatedAt ? <span>· {formatThaiDateTime(item.updatedAt)}</span> : null}
                </div>
                {item.error ? <p className="text-xs text-destructive">{item.error}</p> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
