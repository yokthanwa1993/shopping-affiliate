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

// Base number of columns in the `table` layout — kept in one place so the
// colSpan of the loading / empty / no-match state rows always matches the
// header. When an `onToggleActive` callback is wired up the table grows one more
// column for the inline toggle (see `cols` in the table layout).
const TABLE_COLS = 5

// Inline on/off switch used in the `table` layout's toggle column. Clicking it
// never bubbles to the row (so it can't select/open the page) and it stays
// usable even when the page is off, so an operator can switch a greyed page back
// on. Purely controlled — the caller owns the page.active state.
function PageActiveToggle({
  active,
  pending,
  onChange,
}: {
  active: boolean
  pending: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={active ? 'ปิดการโพสต์เพจนี้' : 'เปิดการโพสต์เพจนี้'}
      title={active ? 'ปิดการโพสต์เพจนี้' : 'เปิดการโพสต์เพจนี้'}
      disabled={pending}
      onClick={(e) => {
        // Never let the toggle select/open the row.
        e.stopPropagation()
        onChange(!active)
      }}
      // Keyboard activation of a <button> fires click (handled above); stop the
      // keydown here so it doesn't also trigger the row's Enter/Space handler.
      onKeyDown={(e) => e.stopPropagation()}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-wait disabled:opacity-60 ${
        active ? 'bg-emerald-500' : 'bg-muted-foreground/40'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          active ? 'translate-x-4' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

// One page rendered as a full-width clickable table row for the `table` layout.
// Same data + token-safety as PageOption (presence badge only, never the raw
// token). The whole <tr> is the click target with keyboard support, and the
// right-most cell carries the "open post manager" cue.
//
// When `onToggleActive` is supplied (Create Post mode) the row gains a toggle
// column AND becomes active-gated: an inactive page renders greyed, is not
// selectable/openable, and shows a muted "ปิดอยู่" action — but the toggle
// itself stays enabled so it can be turned back on. Without the callback the row
// keeps its original always-openable behavior (Create Ads is unaffected).
function PageTableRow({
  page,
  selected,
  onSelect,
  actionLabel,
  onToggleActive,
  togglePending,
  gateInactive,
}: {
  page: SettingsPage
  selected: boolean
  onSelect: (page: SettingsPage) => void
  actionLabel: string
  onToggleActive?: (page: SettingsPage, active: boolean) => void
  togglePending?: boolean
  gateInactive?: boolean
}) {
  const toggleEnabled = !!onToggleActive
  // Rows are active-gated when a toggle is wired (Create Post) OR when the caller
  // opts into `gateInactive` (Create Ads, which has no toggle column but still
  // greys out / locks pages that are off for the Create Ads auto context). With
  // neither, every row stays openable (the original Create Ads behavior).
  const interactive = !(toggleEnabled || gateInactive) || page.active
  return (
    <tr
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : -1}
      aria-pressed={interactive ? selected : undefined}
      aria-disabled={interactive ? undefined : true}
      onClick={interactive ? () => onSelect(page) : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(page)
              }
            }
          : undefined
      }
      className={`group border-b align-middle transition-colors last:border-b-0 ${
        interactive
          ? `cursor-pointer hover:bg-accent focus:bg-accent focus:outline-none ${
              selected ? 'bg-accent' : ''
            }`
          : 'cursor-default bg-muted/40 opacity-60'
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
      {/* Toggle column — only in Create Post (toggle) mode. */}
      {toggleEnabled && (
        <td className="px-4 py-3">
          <PageActiveToggle
            active={page.active}
            pending={!!togglePending}
            onChange={(next) => onToggleActive!(page, next)}
          />
        </td>
      )}
      {/* Action cue. Greyed "ปิดอยู่" when the page is off and gated. */}
      <td className="px-4 py-3 text-right">
        {interactive ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground group-hover:text-foreground">
            <span className="hidden sm:inline">{actionLabel}</span>
            <ChevronRight className="h-4 w-4" />
          </span>
        ) : (
          <span className="inline-flex items-center whitespace-nowrap text-xs font-medium text-muted-foreground/70">
            ปิดอยู่
          </span>
        )}
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
  onToggleActive,
  pendingToggleId = null,
  gateInactive = false,
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
  /** `table` layout only: opt into the inline on/off toggle column. Supplying
   *  this also active-gates rows (an off page greys out and won't open) — the
   *  Create Post master wires it; Create Ads omits it and is unaffected. The
   *  callback persists the new state (e.g. via updatePageActive). */
  onToggleActive?: (page: SettingsPage, active: boolean) => void
  /** Page id whose toggle is mid-flight; that switch shows a disabled/busy state. */
  pendingToggleId?: string | null
  /** `table` layout only: active-gate rows WITHOUT adding the inline toggle column.
   *  An off (`active:false`) page greys out and won't open, exactly like Create
   *  Post's off behavior, but no on/off switch is rendered. Create Ads uses this to
   *  reflect the Create Ads auto status (only the allowlisted page is openable). */
  gateInactive?: boolean
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
    // One extra column when the inline toggle is wired up.
    const cols = onToggleActive ? TABLE_COLS + 1 : TABLE_COLS
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
          <td colSpan={cols} className="px-4 py-3">
            <div className="h-10 animate-pulse rounded-lg bg-muted" />
          </td>
        </tr>
      ))
      footer = 'กำลังโหลด…'
    } else if (error && pages.length === 0) {
      body = (
        <tr>
          <td colSpan={cols} className="px-4 py-8 text-center text-sm text-destructive">
            โหลดรายการเพจไม่สำเร็จ — ต้องเข้าสู่ระบบแดชบอร์ดก่อนจึงจะเลือกเพจได้
          </td>
        </tr>
      )
      footer = 'แสดง 0 เพจ'
    } else if (pages.length === 0) {
      body = (
        <tr>
          <td colSpan={cols} className="px-4 py-8 text-center text-sm text-muted-foreground">
            {emptyHint}
          </td>
        </tr>
      )
      footer = 'แสดง 0 เพจ'
    } else if (filtered.length === 0) {
      body = (
        <tr>
          <td colSpan={cols} className="px-4 py-8 text-center text-sm text-muted-foreground">
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
          onToggleActive={onToggleActive}
          togglePending={pendingToggleId === page.id}
          gateInactive={gateInactive}
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
                {onToggleActive ? (
                  <th scope="col" className="px-4 py-2.5 font-medium">การโพสต์</th>
                ) : null}
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
