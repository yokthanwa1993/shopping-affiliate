import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, RefreshCcw, ShoppingBag, Sparkles } from 'lucide-react'
import { fetchAiClips, type AiClip } from '@/api/aiClips'
import { formatThaiDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StudioSectionTabs } from '@/components/StudioSectionTabs'

function ProductLink({ label, href, accent }: { label: string; href: string; accent: string }) {
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold hover:bg-muted"
      style={{ color: accent }}
    >
      <ShoppingBag className="h-3.5 w-3.5" /> {label}
    </a>
  )
}

function AiGalleryCard({ item }: { item: AiClip }) {
  const videoUrl = item.previewUrl || item.originalUrl
  return (
    <article className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="aspect-[9/16] bg-black">
        {videoUrl ? (
          <video src={videoUrl} controls playsInline className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white">
            <Sparkles className="h-8 w-8" />
          </div>
        )}
      </div>
      <div className="space-y-2 p-3">
        <div>
          <h3 className="line-clamp-2 text-sm font-semibold">{item.title || item.id}</h3>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{item.id}</p>
        </div>
        {item.processedAt || item.createdAt ? (
          <p className="text-xs text-muted-foreground">{formatThaiDateTime(item.processedAt || item.createdAt)}</p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <ProductLink label="Shopee" href={item.shopeeLink} accent="#ee4d2d" />
          <ProductLink label="Lazada" href={item.lazadaLink} accent="#0f146d" />
          {videoUrl ? (
            <a
              href={videoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold hover:bg-muted"
            >
              <ExternalLink className="h-3.5 w-3.5" /> เปิดวิดีโอ
            </a>
          ) : null}
        </div>
      </div>
    </article>
  )
}

export function GalleryPage() {
  const [search, setSearch] = useState('')
  const query = useQuery({
    queryKey: ['ai-clips-gallery', 'processed'],
    queryFn: ({ signal }) => fetchAiClips('processed', signal),
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const videos = query.data ?? []
    if (!q) return videos
    return videos.filter((v) =>
      [v.id, v.title, v.shopeeLink, v.lazadaLink]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [query.data, search])

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 rounded-3xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-violet-600">AI Gallery</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">แกลลี่</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            แสดงเฉพาะคลิป AI ที่ประมวลผลแล้วใน namespace นี้ — ไม่ดึงคลิปจีน/LINE เดิม
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCcw className="mr-2 h-4 w-4" /> รีเฟรช
        </Button>
      </header>

      <StudioSectionTabs />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหา video id, ชื่อคลิป หรือ link"
          className="sm:max-w-sm"
        />
        <p className="text-sm text-muted-foreground">{filtered.length} คลิป</p>
      </div>

      {query.isLoading ? (
        <div className="rounded-3xl border bg-card p-8 text-center text-muted-foreground">กำลังโหลด…</div>
      ) : query.isError ? (
        <div className="rounded-3xl border border-destructive/40 bg-destructive/5 p-8 text-center text-destructive">
          โหลดแกลลี่ไม่สำเร็จ: {query.error instanceof Error ? query.error.message : 'unknown_error'}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-3xl border border-dashed bg-card p-10 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-violet-100 text-violet-700">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-lg font-semibold">แกลลี่ AI ยังว่าง</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            อัปโหลดคลิปที่ Source Inventory แล้วเมื่อคลิปถูกประมวลผลสำเร็จ จะแสดงที่นี่
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((item) => (
            <AiGalleryCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
