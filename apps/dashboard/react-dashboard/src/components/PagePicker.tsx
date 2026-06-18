import { useMemo, useState } from 'react'
import { ChevronRight, Search } from 'lucide-react'
import type { SettingsPage } from '@/api/settings'
import { Badge } from '@/components/ui/badge'

// Shared page-first selector used by the action-first dashboard routes
// (Create Post / Create Ads). The whole UX hinges on choosing a page first, so
// this is the entry point of both flows. It is purely presentational: the caller
// owns the page list (fetchSettingsPages), the selected id and the onSelect
// handler. Tokens are presence-only (SettingsPage.hasToken) — no raw token ever
// reaches this component.
//
// Two layouts: `grid` (default, compact cards — Create Ads keeps this) and
// `table` (a full-width rounded card with a header row, a real <table> of pages,
// and a footer count — Create Post uses it so the picker fills the content area
// instead of centering small cards). Only `SettingsPage` fields are shown, so
// the table omits posting-mode / last-post columns that would need extra fetches.

// Graph picture fallback when a page has no explicit iconUrl. Mirrors the LINE
// Mini App / settings helper so avatars resolve the same everywhere.
export function graphPageImageUrl(pageId: string): string {
  return `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large`
}

// Neutral placeholder shown if both iconUrl and the Graph picture fail to load.
export const PAGE_IMG_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="%23e5e7eb"/></svg>',
  )

// Staged image fallback: iconUrl → Graph picture → neutral placeholder.
function handlePageImgError(e: React.SyntheticEvent<HTMLImageElement>, page: SettingsPage) {
  const img = e.currentTarget
  const stage = img.dataset.fallbackStage || '0'
  if (stage === '0' && page.iconUrl) {
    img.dataset.fallbackStage = '1'
    img.src = graphPageImageUrl(page.id)
  } else if (stage !== '2') {
    img.dataset.fallbackStage = '2'
    img.src = PAGE_IMG_PLACEHOLDER
  }
}

function PageOption({
  page,
  selected,
  onSelect,
}: {
  page: SettingsPage
  selected: boolean
  onSelect: (page: SettingsPage) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(page)}
      aria-pressed={selected}
      className={`flex items-center gap-3 rounded-xl border bg-card p-3 text-left shadow-sm transition-colors hover:bg-accent ${
        selected ? 'border-primary ring-2 ring-primary' : 'border-border'
      }`}
    >
      <img
        src={page.iconUrl || graphPageImageUrl(page.id)}
        alt={page.name || page.id}
        loading="lazy"
        onError={(e) => handlePageImgError(e, page)}
        className="h-12 w-12 shrink-0 rounded-full border bg-muted object-cover"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-tight" title={page.name || page.id}>
          {page.name || page.id}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{page.id}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant={page.active ? 'success' : 'outline'}>
            {page.active ? 'เปิดใช้งาน' : 'ปิดอยู่'}
          </Badge>
          <Badge variant={page.hasToken ? 'secondary' : 'outline'}>
            {page.hasToken ? '🔒 มี token' : 'ไม่มี token'}
          </Badge>
        </div>
      </div>
    </button>
  )
}

// Number of columns in the `table` layout — kept in one place so the colSpan of
// the loading / empty / no-match state rows always matches the header.
const TABLE_COLS = 5

// One page rendered as a full-width clickable table row for the `table` layout.
// Same data + token-safety as PageOption (presence badge only, never the raw
// token). The whole <tr> is the click target with keyboard support, and the
// right-most cell carries the "open post manager" cue.
function PageTableRow({
  page,
  selected,
  onSelect,
  actionLabel,
}: {
  page: SettingsPage
  selected: boolean
  onSelect: (page: SettingsPage) => void
  actionLabel: string
}) {
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(page)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(page)
        }
      }}
      className={`group cursor-pointer border-b align-middle transition-colors last:border-b-0 hover:bg-accent focus:bg-accent focus:outline-none ${
        selected ? 'bg-accent' : ''
      }`}
    >
      {/* Selection indicator (the reference's leading select column). */}
      <td className="px-4 py-3">
        <span
          aria-hidden
          className={`block h-3.5 w-3.5 rounded-full border-2 ${
            selected ? 'border-primary bg-primary' : 'border-muted-foreground/40'
          }`}
        />
      </td>
      {/* Page: avatar + name + page id. */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <img
            src={page.iconUrl || graphPageImageUrl(page.id)}
            alt={page.name || page.id}
            loading="lazy"
            onError={(e) => handlePageImgError(e, page)}
            className="h-10 w-10 shrink-0 rounded-full border bg-muted object-cover"
          />
          <div className="min-w-0">
            <div className="truncate font-semibold leading-tight" title={page.name || page.id}>
              {page.name || page.id}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{page.id}</div>
          </div>
        </div>
      </td>
      {/* Status: colored dot + label. */}
      <td className="px-4 py-3">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden
            className={`h-2 w-2 rounded-full ${page.active ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
          />
          <span className={page.active ? 'text-emerald-700' : 'text-muted-foreground'}>
            {page.active ? 'เปิดใช้งาน' : 'ปิดอยู่'}
          </span>
        </span>
      </td>
      {/* Token: presence badge only — never the raw token. */}
      <td className="px-4 py-3">
        <Badge variant={page.hasToken ? 'secondary' : 'outline'}>
          {page.hasToken ? '🔒 มี token' : 'ไม่มี token'}
        </Badge>
      </td>
      {/* Action cue. */}
      <td className="px-4 py-3 text-right">
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground group-hover:text-foreground">
          <span className="hidden sm:inline">{actionLabel}</span>
          <ChevronRight className="h-4 w-4" />
        </span>
      </td>
    </tr>
  )
}

export function PagePicker({
  pages,
  selectedId,
  onSelect,
  loading = false,
  error = false,
  emptyHint = 'ยังไม่พบเพจใน workspace นี้',
  searchable = false,
  layout = 'grid',
  fill = false,
  title = 'รายการเพจ',
  actionLabel = 'เปิดหน้าจัดการโพสต์',
}: {
  pages: SettingsPage[]
  selectedId: string | null
  onSelect: (page: SettingsPage) => void
  loading?: boolean
  error?: boolean
  emptyHint?: string
  /** Show a name/id search box (above the grid, or in the table header). Opt-in
   *  so existing callers keep their compact layout; the Create Post master
   *  enables it to scale. */
  searchable?: boolean
  /** Item layout. `grid` (default) keeps the compact card grid used by Create
   *  Ads. `table` renders a full-width card + <table> for the Create Post master. */
  layout?: 'grid' | 'table'
  /** `table` layout only: stretch the card to fill its parent's height so the
   *  page list spans the whole content area (Create Post master is full-bleed).
   *  The parent must give a definite height; the table body scrolls inside. */
  fill?: boolean
  /** Card-header title shown only in the `table` layout. */
  title?: string
  /** Right-most table action cue. Defaults to the Create Post wording. */
  actionLabel?: string
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pages
    return pages.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    )
  }, [pages, query])

  // ── Table layout ──────────────────────────────────────────────────────────
  // A single rounded card that fills the content width: header (title + search),
  // a real <table> (horizontally scrollable on narrow screens), and a footer
  // count. All states (loading / error / empty / no-match) render inside the
  // card body so the chrome stays consistent.
  if (layout === 'table') {
    const searchBox = searchable ? (
      <div className="relative w-full sm:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ค้นหาเพจ (ชื่อ หรือ page id)"
          className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
    ) : null

    let body: React.ReactNode
    let footer: string
    if (loading && pages.length === 0) {
      body = Array.from({ length: 6 }).map((_, i) => (
        <tr key={i} className="border-b last:border-b-0">
          <td colSpan={TABLE_COLS} className="px-4 py-3">
            <div className="h-10 animate-pulse rounded-lg bg-muted" />
          </td>
        </tr>
      ))
      footer = 'กำลังโหลด…'
    } else if (error && pages.length === 0) {
      body = (
        <tr>
          <td colSpan={TABLE_COLS} className="px-4 py-8 text-center text-sm text-destructive">
            โหลดรายการเพจไม่สำเร็จ — ต้องเข้าสู่ระบบแดชบอร์ดก่อนจึงจะเลือกเพจได้
          </td>
        </tr>
      )
      footer = 'แสดง 0 เพจ'
    } else if (pages.length === 0) {
      body = (
        <tr>
          <td colSpan={TABLE_COLS} className="px-4 py-8 text-center text-sm text-muted-foreground">
            {emptyHint}
          </td>
        </tr>
      )
      footer = 'แสดง 0 เพจ'
    } else if (filtered.length === 0) {
      body = (
        <tr>
          <td colSpan={TABLE_COLS} className="px-4 py-8 text-center text-sm text-muted-foreground">
            ไม่พบเพจที่ตรงกับ “{query.trim()}”
          </td>
        </tr>
      )
      footer = `แสดง 0 จาก ${pages.length} เพจ`
    } else {
      body = filtered.map((page) => (
        <PageTableRow
          key={page.id}
          page={page}
          selected={selectedId === page.id}
          onSelect={onSelect}
          actionLabel={actionLabel}
        />
        ))
      footer = `แสดง 1 ถึง ${filtered.length} จาก ${pages.length} เพจ`
    }

    return (
      <div
        className={`overflow-hidden rounded-xl border bg-card shadow-sm ${
          fill ? 'flex h-full flex-col' : ''
        }`}
      >
        <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {searchBox}
        </div>
        <div className={`overflow-x-auto ${fill ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}>
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2.5 font-medium">
                  <span className="sr-only">เลือก</span>
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">เพจ</th>
                <th scope="col" className="px-4 py-2.5 font-medium">สถานะ</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Token</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  <span className="sr-only">การจัดการ</span>
                </th>
              </tr>
            </thead>
            <tbody>{body}</tbody>
          </table>
        </div>
        <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">{footer}</div>
      </div>
    )
  }

  // ── Grid layout (default) ───────────────────────────────────────────────────
  if (loading && pages.length === 0) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[88px] animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    )
  }

  if (error && pages.length === 0) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        โหลดรายการเพจไม่สำเร็จ — ต้องเข้าสู่ระบบแดชบอร์ดก่อนจึงจะเลือกเพจได้
      </div>
    )
  }

  if (pages.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        {emptyHint}
      </p>
    )
  }

  const grid = (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {filtered.map((page) => (
        <PageOption
          key={page.id}
          page={page}
          selected={page.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  )

  if (!searchable) return grid

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาเพจ (ชื่อ หรือ page id)"
            className="h-9 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {query.trim() ? `พบ ${filtered.length} จาก ${pages.length} เพจ` : `ทั้งหมด ${pages.length} เพจ`}
        </span>
      </div>
      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          ไม่พบเพจที่ตรงกับ “{query.trim()}”
        </p>
      ) : (
        grid
      )}
    </div>
  )
}
