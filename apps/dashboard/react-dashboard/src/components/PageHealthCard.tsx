import { useQuery } from '@tanstack/react-query'
import { fetchPageCore, type PageCore } from '@/api/pageDetail'
import { fetchPageSettings } from '@/api/settings'
import { formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'

// Read-only health/config summary for the selected page. Both action routes load
// this once a page is picked so the operator sees — before acting — exactly how
// the page is configured. It reuses the existing fetchPageCore contract and
// surfaces token state as presence-only (never the raw token).
//
// `variant` only changes which fields are emphasised:
//   - 'post' : what a force-post will publish (Reel vs OneCard, comment route,
//              caption link, posting schedule, last post).
//   - 'ads'  : ad-relevant defaults (ad account, ads-publish, onecard) — these
//              are page DEFAULTS shown for context; this card never creates ads.

function postTypeLabel(core: PageCore): string {
  if (core.oneCardEnabled) {
    const mode =
      core.oneCardLinkMode === 'lazada' ? 'Lazada' : core.oneCardLinkMode === 'none' ? 'ไม่มีลิงก์' : 'Shopee'
    return `OneCard (${mode})`
  }
  return 'Reel'
}

function tokenSourceLabel(value: 'stored_token' | 'cloak_browser'): string {
  return value === 'cloak_browser' ? 'CloakBrowser' : 'Page Token'
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium">{children}</span>
    </div>
  )
}

function Divider() {
  return <div className="mx-4 h-px bg-border" />
}

export function PageHealthCard({
  pageId,
  variant = 'post',
  tokenPresentOverride,
}: {
  pageId: string
  variant?: 'post' | 'ads'
  tokenPresentOverride?: boolean
}) {
  const coreQuery = useQuery({
    queryKey: ['page-core', pageId],
    queryFn: ({ signal }) => fetchPageCore(pageId, signal),
    enabled: !!pageId,
  })

  // Ad account lives in the dashboard settings store (per page_id). Only needed
  // for the ads variant; skipped entirely for the post console.
  const settingsQuery = useQuery({
    queryKey: ['page-settings-health', pageId],
    queryFn: ({ signal }) => fetchPageSettings(pageId, signal),
    enabled: !!pageId && variant === 'ads',
  })

  if (coreQuery.isLoading) {
    return <div className="h-44 animate-pulse rounded-xl bg-muted" />
  }

  if (coreQuery.isError || !coreQuery.data) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        โหลดการตั้งค่าเพจไม่สำเร็จ:{' '}
        {coreQuery.error instanceof Error ? coreQuery.error.message : 'unknown error'}
      </div>
    )
  }

  const core = coreQuery.data
  const tokenPresent = tokenPresentOverride ?? core.tokenPresent
  const adAccount = settingsQuery.data?.form.adAccount?.trim() || ''

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-3">
        <span className="text-sm font-semibold">{core.name || core.id}</span>
        <Badge variant={core.isActive ? 'success' : 'destructive'}>
          {core.isActive ? 'เพจเปิดใช้งาน' : 'เพจปิดอยู่'}
        </Badge>
        <Badge variant={tokenPresent ? 'secondary' : 'outline'}>
          {tokenPresent ? '🔒 มี token จาก Accounts Bridge' : 'ไม่มี token จาก Accounts Bridge'}
        </Badge>
      </div>

      {variant === 'post' ? (
        <>
          <Row label="ชนิดโพสต์">{postTypeLabel(core)}</Row>
          <Divider />
          <Row label="แหล่ง token โพสต์">{tokenSourceLabel(core.postingTokenSource)}</Row>
          <Divider />
          <Row label="แหล่ง token คอมเมนต์">{tokenSourceLabel(core.commentTokenSource)}</Row>
          <Divider />
          <Row label="แนบลิงก์ในแคปชัน">
            <Badge variant={core.captionLinkEnabled ? 'success' : 'outline'}>
              {core.captionLinkEnabled ? 'เปิด' : 'ปิด'}
            </Badge>
          </Row>
          <Divider />
          <Row label="รอบการโพสต์">{core.postHours ? core.postHours : `ทุก ${core.postIntervalMinutes} นาที`}</Row>
          <Divider />
          <Row label="โพสต์ล่าสุด">
            {core.lastPostAt ? formatThaiDateTime(core.lastPostAt) : '—'}
          </Row>
        </>
      ) : (
        <>
          <Row label="Ad account">
            <span className="font-mono text-xs">
              {settingsQuery.isLoading ? 'กำลังโหลด…' : adAccount || '— (ใช้ค่าเริ่มต้น)'}
            </span>
          </Row>
          <Divider />
          <Row label="เผยแพร่แอด (ads_publish)">
            <Badge variant={core.adsPublishEnabled ? 'success' : 'outline'}>
              {core.adsPublishEnabled ? 'เปิด' : 'ปิด'}
            </Badge>
          </Row>
          <Divider />
          <Row label="OneCard">
            <Badge variant={core.oneCardEnabled ? 'success' : 'outline'}>
              {core.oneCardEnabled ? postTypeLabel(core) : 'ปิด'}
            </Badge>
          </Row>
          <Divider />
          <Row label="CTA ปุ่ม">{core.oneCardCta === 'NO_BUTTON' ? 'ไม่มีปุ่ม' : 'SHOP_NOW'}</Row>
        </>
      )}
    </div>
  )
}
