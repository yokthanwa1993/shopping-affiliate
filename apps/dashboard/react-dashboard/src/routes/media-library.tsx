import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, Film, RefreshCw } from 'lucide-react'
import {
  fetchVideoMediaLibrary,
  uploadVideoToMediaLibrary,
  type VideoMediaLibraryItem,
} from '@/api/videoMediaLibrary'
import { formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Maps the worker's upload_status string to a Shopee-ish badge tone. Anything we
// don't recognize falls back to a neutral outline so new states still render.
function statusVariant(status: string): 'success' | 'destructive' | 'secondary' | 'outline' {
  const s = status.toLowerCase()
  if (s === 'success' || s === 'ready') return 'success'
  if (s === 'failed' || s.startsWith('skipped')) return 'destructive'
  if (s === 'uploading' || s === 'in_progress' || s === 'processing') return 'secondary'
  return 'outline'
}

// Small inline copy-to-clipboard affordance, mirroring the gallery card's copy
// button. Shows a transient check after a successful copy.
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-6 gap-1 px-2 text-[11px]"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => {},
        )
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'คัดลอกแล้ว' : label}
    </Button>
  )
}

function MediaRow({ item }: { item: VideoMediaLibraryItem }) {
  return (
    <div className="rounded-xl border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Film className="h-4 w-4 text-[#ee4d2d]" />
          <span className="break-all">{item.systemVideoId}</span>
        </div>
        <Badge variant={statusVariant(item.uploadStatus)}>
          {item.uploadStatus || 'unknown'}
          {item.advideoStatus ? ` · ${item.advideoStatus}` : ''}
        </Badge>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="flex items-center gap-2">
          <dt className="shrink-0 font-medium text-foreground/70">Meta video id</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <span className="break-all">{item.advideoId || '—'}</span>
            {item.advideoId ? <CopyButton value={item.advideoId} label="คัดลอก" /> : null}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="shrink-0 font-medium text-foreground/70">Ad account</dt>
          <dd className="break-all">{item.adAccount || '—'}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="shrink-0 font-medium text-foreground/70">อัปโหลด</dt>
          <dd>{formatThaiDateTime(item.uploadedAt) || '—'}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="shrink-0 font-medium text-foreground/70">อัปเดต</dt>
          <dd>{formatThaiDateTime(item.updatedAt) || '—'}</dd>
        </div>
      </dl>

      {item.error ? (
        <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
          {item.error}
        </p>
      ) : null}

      {item.fileUrl ? (
        <a
          href={item.fileUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-[#ee4d2d] hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          เปิดไฟล์ต้นทาง
        </a>
      ) : null}
    </div>
  )
}

export function MediaLibraryPage() {
  const qc = useQueryClient()
  const [systemVideoId, setSystemVideoId] = useState('')
  const [pageId, setPageId] = useState('')
  const [adAccount, setAdAccount] = useState('')

  const query = useQuery({
    queryKey: ['video-media-library'],
    queryFn: ({ signal }) => fetchVideoMediaLibrary(signal),
  })
  const items = query.data?.items ?? []

  const uploadMutation = useMutation({
    mutationFn: () =>
      uploadVideoToMediaLibrary({
        systemVideoId,
        pageId: pageId || undefined,
        adAccount: adAccount || undefined,
      }),
    onSuccess: () => {
      setSystemVideoId('')
      void qc.invalidateQueries({ queryKey: ['video-media-library'] })
    },
  })

  const uploadResultItem = uploadMutation.data?.item ?? null
  const uploadWarning = uploadMutation.data?.warning ?? ''

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-[#333333]">
          <Film className="h-5 w-5 text-[#ee4d2d]" />
          คลังสื่อวิดีโอ
        </h1>
        <p className="text-sm text-muted-foreground">
          Meta Asset Library — วิดีโอที่อัปโหลดเข้า media library ของบัญชีโฆษณา (advideos). Meta video id
          ที่ได้สามารถนำไปสร้างแอดได้ภายหลัง — หน้านี้ยังไม่สร้างแอดจริง
        </p>
      </div>

      {/* Manual upload of one system gallery video. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">อัปโหลดวิดีโอเข้าคลังสื่อ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="block font-medium text-foreground">System video id *</span>
              <input
                type="text"
                value={systemVideoId}
                onChange={(e) => setSystemVideoId(e.target.value)}
                placeholder="เช่น 2695c305"
                className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm text-foreground"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block font-medium text-foreground">Page id (ไม่บังคับ)</span>
              <input
                type="text"
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
                placeholder="ใช้ default_page ถ้าเว้นว่าง"
                className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm text-foreground"
              />
            </label>
            <label className="space-y-1 text-sm sm:col-span-2">
              <span className="block font-medium text-foreground">Ad account (ไม่บังคับ)</span>
              <input
                type="text"
                value={adAccount}
                onChange={(e) => setAdAccount(e.target.value)}
                placeholder="เช่น act_1030797047648459 — ใช้ค่าของเพจถ้าเว้นว่าง"
                className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm text-foreground"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => uploadMutation.mutate()}
              disabled={!systemVideoId.trim() || uploadMutation.isPending}
            >
              {uploadMutation.isPending ? 'กำลังอัปโหลด…' : 'อัปโหลดเข้าคลังสื่อ'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={`mr-1 h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />
              รีเฟรช
            </Button>
          </div>

          {uploadMutation.isError ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
              {(uploadMutation.error as Error)?.message || 'อัปโหลดไม่สำเร็จ'}
            </p>
          ) : null}
          {uploadMutation.isSuccess ? (
            <div className="space-y-2">
              <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800">
                {uploadResultItem
                  ? `บันทึกแล้ว — สถานะ: ${uploadResultItem.uploadStatus || 'unknown'}${uploadResultItem.advideoId ? ` · Meta video id ${uploadResultItem.advideoId}` : ''}`
                  : 'ส่งคำขออัปโหลดแล้ว — ยังอ่านแถวผลลัพธ์ไม่ได้ ลองรีเฟรช'}
              </p>
              {uploadWarning ? (
                <p className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                  {uploadWarning}
                </p>
              ) : null}
              {uploadResultItem ? <MediaRow item={uploadResultItem} /> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Existing library rows, newest-first. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">รายการในคลังสื่อ — {items.length} วิดีโอ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {query.isLoading ? (
            <p className="text-sm text-muted-foreground">กำลังโหลด…</p>
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              {(query.error as Error)?.message || 'โหลดคลังสื่อไม่สำเร็จ'}
            </p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              ยังไม่มีวิดีโอในคลังสื่อ — อัปโหลด system video id ด้านบนเพื่อเริ่มต้น
            </p>
          ) : (
            items.map((item) => (
              <MediaRow key={`${item.adAccount}:${item.systemVideoId}`} item={item} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
