import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, ChevronLeft, ChevronRight, Copy, Plus, Trash2, X } from 'lucide-react'
import {
  EMPTY_FORM,
  fetchPageSettings,
  fetchSettingsPages,
  pageSettingsSchema,
  savePageSettings,
  type PageSettingsForm,
  type SettingsPage,
} from '@/api/settings'
import {
  POSTING_ORDER_OPTIONS,
  createEmptyPageShortlinkSettingsForm,
  detectScheduleMode,
  fetchPageAvatarSettings,
  fetchPageCore,
  fetchPagePostingOrderSettings,
  fetchPageShortlinkSettings,
  forcePost,
  getPostingOrderOptionMeta,
  normalizeInterval,
  normalizePageAvatarSettings,
  normalizePageShortlinkSettingsForm,
  normalizePostingOrderOption,
  parseInterval,
  parsePostHours,
  savePageAvatarSettings,
  savePageCore,
  savePagePostingOrderSettings,
  savePageShortlinkSettings,
  type OneCardCta,
  type CommentTokenSource,
  type OneCardLinkMode,
  type PageShortlinkSettingsForm,
  type PostingOrderOption,
  type PostingTokenSource,
  type ScheduleMode,
} from '@/api/pageDetail'
import { CHIEB_NAMESPACE_ID, DEFAULT_PAGE_ID } from '@/api/client'
import { useWorkspace } from '@/contexts/workspace'
import { formatThaiDateTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// LINE Mini App admin/profile display values. Static, non-secret labels that
// mirror the LINE settings header so the web dashboard reaches menu parity.
const ADMIN_DISPLAY_NAME = 'YOK"Thanwa🤨'
// No LINE UID data source exists in the React preview; show a truncated,
// display-only placeholder so the info card matches the LINE layout. Copy still
// works (copies this value) but it is not a secret and not used for auth.
const LINE_UID_DISPLAY = 'U' + CHIEB_NAMESPACE_ID
const TEAM_MEMBER_COUNT = 12
// LINE Mini App host shown as the detail-page subtitle, mirroring the LIFF
// shell header in the screenshot. Display-only label.
const LINE_APP_HOST = 'app.oomnn.com'
// The LINE Pages grid renders a "<n> เวลา/วัน" badge from each page's posting
// schedule. The dashboard's redacted page list carries no schedule fields, so
// we show the screenshot's default cadence as a static placeholder.
const DEFAULT_SCHEDULE_BADGE = '24 เวลา/วัน'

function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

// Graph picture fallback when a page has no explicit iconUrl. Mirrors the LINE
// Mini App's getGraphPageImageUrl helper.
function graphPageImageUrl(pageId: string): string {
  return `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=large`
}

// Neutral placeholder shown if both iconUrl and the Graph picture fail to load.
const PAGE_IMG_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="%23e5e7eb"/></svg>',
  )

// In-page detail sections. Every settings tile now opens one of these in place
// (no navigation away). Form sections reuse the same react-hook-form state and
// the same PUT contract; the rest are read-only / placeholder detail views.
type SectionKey =
  | 'pages'
  | 'ads'
  | 'team'
  | 'shortlink'
  | 'post'
  | 'comment'
  | 'monitor'
  | 'token'

// Sections that carry editable fields and the save bar / mutation.
const FORM_SECTIONS = new Set<SectionKey>(['ads', 'shortlink', 'post', 'comment', 'token'])

// Text-heavy or short sections constrained to a centered reading column on wide
// screens; the rest fill the responsive container width.
const NARROW_SECTIONS = new Set<SectionKey>(['team', 'monitor', 'post', 'comment', 'token'])

const SECTION_TITLES: Record<SectionKey, string> = {
  pages: 'Pages',
  ads: 'จัดการ ADS',
  team: 'Team',
  shortlink: 'Shortlink',
  post: 'Post / โพสต์อัตโนมัติ',
  comment: 'Comment Template',
  monitor: 'Monitor',
  token: 'Facebook Sync Token',
}

type Tile =
  | { kind: 'section'; emoji: string; title: string; subtitle: string; section: SectionKey }
  | { kind: 'disabled'; emoji: string; title: string; subtitle: string }

export function SettingsPage() {
  const queryClient = useQueryClient()
  const { workspace, affiliate } = useWorkspace()
  const [pageId, setPageId] = useState(DEFAULT_PAGE_ID)
  // Write-only token field: empty means "leave existing token unchanged".
  const [newToken, setNewToken] = useState('')
  // null = show the LINE-style menu; otherwise the open detail section.
  const [section, setSection] = useState<SectionKey | null>(null)
  // When set, the in-page Page detail/settings screen is shown for this page
  // (opened by tapping a card in the Pages grid). Overrides `section`.
  const [pageDetail, setPageDetail] = useState<SettingsPage | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const pagesQuery = useQuery({
    queryKey: ['settings-pages'],
    queryFn: ({ signal }) => fetchSettingsPages(signal),
  })

  const settingsQuery = useQuery({
    queryKey: ['settings', pageId],
    queryFn: ({ signal }) => fetchPageSettings(pageId, signal),
  })

  // The dashboard settings worker stores settings per page_id — both
  // GET and PUT /api/dashboard/settings key on page_id (getPageSetting /
  // setPageSetting) — so any selected page is editable, not just the default
  // page. Saving applies to whichever page is currently selected.
  const canEdit = true

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<PageSettingsForm>({
    resolver: zodResolver(pageSettingsSchema),
    defaultValues: EMPTY_FORM,
  })

  // Hydrate the form whenever fresh settings arrive for the selected page.
  useEffect(() => {
    if (settingsQuery.data) {
      reset(settingsQuery.data.form)
      setNewToken('')
    }
  }, [settingsQuery.data, reset])

  const provider = watch('shortlinkProvider')
  const memberId = watch('subId')

  const mutation = useMutation({
    mutationFn: (values: PageSettingsForm) => savePageSettings(pageId, values, newToken),
    onSuccess: async () => {
      setNewToken('')
      await queryClient.invalidateQueries({ queryKey: ['settings', pageId] })
    },
  })

  const onSubmit = handleSubmit((values) => {
    if (!canEdit) return
    mutation.mutate(values)
  })

  const tokenPresent = settingsQuery.data?.tokenPresent ?? false
  const tokenUpdatedAt = settingsQuery.data?.tokenUpdatedAt ?? ''

  async function copyValue(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
    } catch {
      setCopied(`err:${key}`)
    }
    // Clear the "copied" affordance shortly after; guard against a newer copy.
    window.setTimeout(() => setCopied((current) => (current === key || current === `err:${key}` ? null : current)), 1600)
  }

  const pages = pagesQuery.data ?? ([] as SettingsPage[])
  const shortlinkSubtitle = `Account ${workspace} • UTM ${affiliate.id} • member_id ${memberId?.trim() || '—'}`

  // Tile order mirrors the LINE Mini App settings menu.
  const tiles: Tile[] = [
    {
      kind: 'section',
      emoji: '📄',
      title: 'Pages',
      subtitle: `${pages.length} เพจ • Auto Post`,
      section: 'pages',
    },
    {
      kind: 'section',
      emoji: '📣',
      title: 'จัดการ ADS',
      subtitle: 'Ad account, แคมเปญ, จำนวนแอดต่อรอบ, เวลาสร้างอัตโนมัติ',
      section: 'ads',
    },
    {
      kind: 'section',
      emoji: '👥',
      title: 'Team',
      subtitle: `${TEAM_MEMBER_COUNT} สมาชิก`,
      section: 'team',
    },
    {
      kind: 'section',
      emoji: '🔗',
      title: 'Shortlink',
      subtitle: shortlinkSubtitle,
      section: 'shortlink',
    },
    {
      kind: 'section',
      emoji: '🎯',
      title: 'Post / โพสต์อัตโนมัติ',
      subtitle: 'รอบการโพสต์ — เวลาสร้างอัตโนมัติและจำนวนแอดต่อรอบ',
      section: 'post',
    },
    {
      kind: 'section',
      emoji: '💬',
      title: 'Comment Template',
      subtitle: 'ข้อความคอมเมนต์อัตโนมัติใต้โพสต์',
      section: 'comment',
    },
    {
      kind: 'section',
      emoji: '📊',
      title: 'Monitor',
      subtitle: 'คิวสร้างแอดและสถานะการประมวลผล',
      section: 'monitor',
    },
    {
      kind: 'section',
      emoji: '🔒',
      title: 'Facebook Sync Token',
      subtitle: tokenPresent ? 'มี token บันทึกไว้ (ค่าไม่แสดง)' : 'ยังไม่ได้บันทึก token',
      section: 'token',
    },
    { kind: 'disabled', emoji: '🤖', title: 'AI API Keys', subtitle: 'เร็วๆ นี้' },
    { kind: 'disabled', emoji: '🎙️', title: 'เสียงพากย์', subtitle: 'เร็วๆ นี้' },
    { kind: 'disabled', emoji: '🅰️', title: 'ข้อความบนปก', subtitle: 'เร็วๆ นี้' },
  ]

  return (
    <div className="mx-auto w-full max-w-lg space-y-4 pb-10 lg:max-w-5xl xl:max-w-6xl">
      {pageDetail ? (
        <PageDetailView page={pageDetail} canEdit={canEdit} onBack={() => setPageDetail(null)} />
      ) : section ? (
        <SectionDetail
          section={section}
          onBack={() => setSection(null)}
          canEdit={canEdit}
          pages={pages}
          pagesLoading={pagesQuery.isLoading}
          pagesError={pagesQuery.isError}
          onOpenPage={(page) => {
            setPageId(page.id)
            setPageDetail(page)
          }}
          onSubmit={onSubmit}
          register={register}
          errors={errors}
          provider={provider}
          setValue={setValue}
          newToken={newToken}
          setNewToken={setNewToken}
          tokenPresent={tokenPresent}
          tokenUpdatedAt={tokenUpdatedAt}
          tokenLoading={settingsQuery.isLoading}
          isDirty={isDirty}
          mutation={mutation}
        />
      ) : (
        <>
          {/* Profile + identity — stacked on mobile, side by side on desktop. */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Profile / admin card */}
            <div className="flex items-center gap-3 rounded-2xl border bg-card p-4 shadow-sm">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
                {ADMIN_DISPLAY_NAME.slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-semibold leading-tight">{ADMIN_DISPLAY_NAME}</div>
                <div className="mt-1">
                  <Badge variant="success">Admin</Badge>
                </div>
              </div>
            </div>

            {/* Info rows with copy buttons */}
            <div className="space-y-2 rounded-2xl border bg-card p-2 shadow-sm">
              <InfoRow
                label="NAMESPACE ID"
                value={CHIEB_NAMESPACE_ID}
                copied={copied === 'ns'}
                error={copied === 'err:ns'}
                onCopy={() => copyValue('ns', CHIEB_NAMESPACE_ID)}
              />
              <div className="mx-3 h-px bg-border" />
              <InfoRow
                label="LINE UID"
                value={truncateMiddle(LINE_UID_DISPLAY)}
                copied={copied === 'uid'}
                error={copied === 'err:uid'}
                onCopy={() => copyValue('uid', LINE_UID_DISPLAY)}
              />
            </div>
          </div>

          {/* Page being configured — editing is limited to the main page. */}
          <div className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              เพจที่กำลังตั้งค่า
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {pages.map((page) => (
                <Button
                  key={page.id}
                  type="button"
                  size="sm"
                  variant={page.id === pageId ? 'default' : 'outline'}
                  onClick={() => setPageId(page.id)}
                >
                  {page.name || page.id}
                  {page.hasToken ? ' 🔒' : ''}
                </Button>
              ))}
              {pagesQuery.isError ? (
                <span className="text-xs text-destructive">โหลดรายการเพจไม่สำเร็จ — ใช้ค่าเริ่มต้น</span>
              ) : null}
            </div>
            {!canEdit ? (
              <p className="mt-2 text-xs text-muted-foreground">เพจนี้ดูอย่างเดียว — แก้ไขได้เฉพาะเพจหลัก</p>
            ) : null}
          </div>

          {settingsQuery.isError ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              โหลด settings ไม่สำเร็จ:{' '}
              {settingsQuery.error instanceof Error ? settingsQuery.error.message : 'unknown error'}
            </div>
          ) : null}

          {/* LINE-style menu tiles — single column on mobile, 2-up on desktop. */}
          <div className="grid gap-2 sm:grid-cols-2">
            {tiles.map((tile) => (
              <Tile key={tile.title} tile={tile} onSection={setSection} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function InfoRow({
  label,
  value,
  copied,
  error,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  error: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-sm">{value}</div>
      </div>
      <Button type="button" size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={onCopy}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {error ? 'ผิดพลาด' : copied ? 'คัดลอกแล้ว' : 'Copy'}
      </Button>
    </div>
  )
}

function Tile({ tile, onSection }: { tile: Tile; onSection: (s: SectionKey) => void }) {
  const inner = (
    <>
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-xl">
        {tile.emoji}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-tight">{tile.title}</div>
        <div className="truncate text-xs text-muted-foreground">{tile.subtitle}</div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </>
  )

  const base =
    'flex w-full items-center gap-3 rounded-2xl border bg-card p-3 text-left shadow-sm transition-colors'

  if (tile.kind === 'section') {
    return (
      <button type="button" onClick={() => onSection(tile.section)} className={`${base} hover:bg-accent`}>
        {inner}
      </button>
    )
  }
  return (
    <div className={`${base} cursor-not-allowed opacity-55`} aria-disabled="true">
      {inner}
    </div>
  )
}

// iOS/LINE-like detail header: back arrow left, centered title + host subtitle,
// close X right. Both the arrow and the X return to the settings menu.
function DetailHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="relative flex items-center justify-center px-1 py-1">
      <button
        type="button"
        onClick={onBack}
        aria-label="ย้อนกลับ"
        className="absolute left-0 flex h-9 w-9 items-center justify-center rounded-full text-foreground hover:bg-accent"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className="text-center">
        <div className="text-base font-semibold leading-tight">{title}</div>
        <div className="text-xs text-muted-foreground">{LINE_APP_HOST}</div>
      </div>
      <button
        type="button"
        onClick={onBack}
        aria-label="ปิด"
        className="absolute right-0 flex h-9 w-9 items-center justify-center rounded-full text-foreground hover:bg-accent"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  )
}

// One labelled field row inside a rounded white settings card. Stacks the label
// above the control with generous touch padding (LINE-style row).
function FieldRow({ children }: { children: ReactNode }) {
  return <div className="space-y-1.5 px-4 py-3">{children}</div>
}

function Divider() {
  return <div className="mx-4 h-px bg-border" />
}

// Staged image fallback shared by the Pages grid and the page-detail avatar:
// iconUrl → Graph picture → neutral placeholder.
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

// Pages detail — 3-column card grid mirroring the LINE Mini App Pages screen.
function PagesDetail({
  pages,
  loading,
  error,
  onOpenPage,
}: {
  pages: SettingsPage[]
  loading: boolean
  error: boolean
  onOpenPage: (page: SettingsPage) => void
}) {
  return (
    <div className="space-y-3">
      {/* Blue "เพิ่มเพจ" affordance — disabled because the dashboard has no safe
          token-import flow; adding pages stays in the LINE Mini App. */}
      <div className="flex justify-end px-1">
        <button
          type="button"
          disabled
          title="เพิ่มเพจได้จาก LINE Mini App เท่านั้น (ต้องใช้ Facebook User Token)"
          className="inline-flex shrink-0 cursor-not-allowed items-center gap-1.5 rounded-xl bg-blue-600/60 px-3.5 py-2 text-sm font-bold text-white"
        >
          <Plus className="h-4 w-4" />
          เพิ่มเพจ
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="aspect-square animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-5 text-center">
          <p className="text-sm font-semibold text-destructive">โหลดเพจไม่สำเร็จ</p>
        </div>
      ) : pages.length === 0 ? (
        <div className="rounded-2xl border bg-muted/40 px-4 py-5 text-center">
          <p className="text-sm font-semibold">ยังไม่พบเพจใน workspace นี้</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {pages.map((page) => (
            <PageCard key={page.id} page={page} onOpen={onOpenPage} />
          ))}
        </div>
      )}
    </div>
  )
}

function PageCard({ page, onOpen }: { page: SettingsPage; onOpen: (page: SettingsPage) => void }) {
  const isActive = page.active
  // Active → green glow; inactive → red glow, matching the LINE grid.
  const borderClass = isActive
    ? 'border-green-400 shadow-[0_0_0_2px_rgba(74,222,128,0.4),0_0_16px_rgba(34,197,94,0.6)]'
    : 'border-red-400 shadow-[0_0_0_2px_rgba(248,113,113,0.35),0_0_12px_rgba(239,68,68,0.42)]'
  const dotClass = isActive ? 'bg-green-500' : 'bg-gray-300'

  return (
    <div className="flex flex-col items-center">
      {/* Tapping the card opens the in-page Page detail/settings screen. */}
      <button
        type="button"
        onClick={() => onOpen(page)}
        aria-label={`ตั้งค่าเพจ ${page.name || page.id}`}
        className="relative w-full rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Posts-per-day badge (static placeholder — no schedule data exposed). */}
        <div className="absolute z-20 left-2 top-2 rounded-full bg-black/85 px-2.5 py-1 text-[10px] font-bold text-white shadow-md">
          {DEFAULT_SCHEDULE_BADGE}
        </div>
        <img
          src={page.iconUrl || graphPageImageUrl(page.id)}
          alt={page.name || page.id}
          loading="lazy"
          onError={(e) => handlePageImgError(e, page)}
          className={`w-full aspect-square cursor-pointer rounded-2xl border-2 bg-muted object-cover transition-transform active:scale-95 ${borderClass}`}
        />
        {/* Delete affordance — visible but inert: no safe dashboard endpoint.
            stopPropagation keeps a tap here from opening the detail screen. */}
        <span
          role="button"
          aria-label="ลบเพจ (ยังไม่รองรับในแดชบอร์ด)"
          aria-disabled="true"
          title="ลบเพจได้จาก LINE Mini App เท่านั้น"
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          className="absolute right-2 top-2 z-30 flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-full bg-red-500/95 text-white shadow-md"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </span>
        {/* Active/inactive status dot. */}
        <div className={`absolute bottom-2 right-2 z-20 h-3.5 w-3.5 rounded-full border-2 border-white shadow ${dotClass}`} />
      </button>
      <p
        className="mt-2 w-full truncate text-center text-[11px] font-semibold text-foreground"
        title={page.name || page.id}
      >
        {page.name || page.id}
      </p>
    </div>
  )
}

// LINE-style placeholder card with a leading icon, title and helper text.
function PlaceholderCard({
  icon,
  title,
  description,
}: {
  icon: string
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-xl">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-tight">{title}</div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

type Mutation = {
  isPending: boolean
  isSuccess: boolean
  isError: boolean
  error: unknown
}

type FormRegister = ReturnType<typeof useForm<PageSettingsForm>>['register']
type FormErrors = ReturnType<typeof useForm<PageSettingsForm>>['formState']['errors']
type FormSetValue = ReturnType<typeof useForm<PageSettingsForm>>['setValue']

// ---- Reusable editable field groups -------------------------------------
// Shared by the per-section detail (SectionDetail) and the per-page detail
// (PageDetailView). All bind to the same react-hook-form state and the same
// PUT contract, so editing in either place is interchangeable.

function ShortlinkFields({
  canEdit,
  register,
  errors,
  provider,
  setValue,
}: {
  canEdit: boolean
  register: FormRegister
  errors: FormErrors
  provider: PageSettingsForm['shortlinkProvider']
  setValue: FormSetValue
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
      <div className="rounded-2xl border bg-card shadow-sm">
        <FieldRow>
          <Label htmlFor="s-shortlink">Shortlink URL</Label>
          <Input id="s-shortlink" className="h-11" disabled={!canEdit} {...register('shortlinkUrl')} />
        </FieldRow>
        <Divider />
        <FieldRow>
          <Label>Shortlink provider</Label>
          <div className="flex gap-2">
            {(['api', 'extension'] as const).map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                disabled={!canEdit}
                variant={provider === p ? 'default' : 'outline'}
                onClick={() => setValue('shortlinkProvider', p, { shouldDirty: true })}
              >
                {p}
              </Button>
            ))}
          </div>
        </FieldRow>
      </div>
      <div className="rounded-2xl border bg-card shadow-sm">
        {(['subId', 'subId2', 'subId3', 'subId4', 'subId5'] as const).map((field, i) => (
          <div key={field}>
            {i > 0 ? <Divider /> : null}
            <FieldRow>
              <Label htmlFor={`s-${field}`}>{`sub_id${i === 0 ? '' : i + 1}`}</Label>
              <Input id={`s-${field}`} className="h-11" disabled={!canEdit} {...register(field)} />
              {errors[field] ? <p className="text-xs text-destructive">{errors[field]?.message}</p> : null}
            </FieldRow>
          </div>
        ))}
      </div>
    </div>
  )
}

function AdsFields({ canEdit, register }: { canEdit: boolean; register: FormRegister }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
      <div className="rounded-2xl border bg-card shadow-sm">
        <FieldRow>
          <Label htmlFor="s-adacct">Ad account</Label>
          <Input id="s-adacct" className="h-11" disabled={!canEdit} {...register('adAccount')} />
        </FieldRow>
        <Divider />
        <FieldRow>
          <Label htmlFor="s-prefix">Campaign prefix</Label>
          <Input id="s-prefix" className="h-11" disabled={!canEdit} {...register('campaignPrefix')} />
        </FieldRow>
      </div>
      <div className="rounded-2xl border bg-card shadow-sm">
        <FieldRow>
          <Label htmlFor="s-perround">Ads per round</Label>
          <Input id="s-perround" className="h-11" inputMode="numeric" disabled={!canEdit} {...register('adsPerRound')} />
        </FieldRow>
        <Divider />
        <FieldRow>
          <Label htmlFor="s-autotime">Auto create time</Label>
          <Input id="s-autotime" className="h-11" placeholder="HH:MM" disabled={!canEdit} {...register('autoCreateTime')} />
        </FieldRow>
      </div>
    </div>
  )
}

// Posting-cadence view. Reuses the auto-create time / ads-per-round fields
// (the only posting-order fields the worker contract exposes) and saves via
// the same PUT, so editing here is interchangeable with the ADS section.
function PostFields({ canEdit, register }: { canEdit: boolean; register: FormRegister }) {
  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-muted-foreground">
        ควบคุมรอบการโพสต์อัตโนมัติ — เวลาเริ่มสร้างแอดและจำนวนแอดต่อรอบ
      </p>
      <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
        <div className="rounded-2xl border bg-card shadow-sm">
          <FieldRow>
            <Label htmlFor="p-autotime">เวลาสร้างอัตโนมัติ</Label>
            <Input id="p-autotime" className="h-11" placeholder="HH:MM" disabled={!canEdit} {...register('autoCreateTime')} />
          </FieldRow>
        </div>
        <div className="rounded-2xl border bg-card shadow-sm">
          <FieldRow>
            <Label htmlFor="p-perround">จำนวนแอดต่อรอบ</Label>
            <Input id="p-perround" className="h-11" inputMode="numeric" disabled={!canEdit} {...register('adsPerRound')} />
          </FieldRow>
        </div>
      </div>
    </div>
  )
}

function CommentField({ canEdit, register }: { canEdit: boolean; register: FormRegister }) {
  return (
    <div className="rounded-2xl border bg-card shadow-sm">
      <FieldRow>
        <Label htmlFor="s-comment">Comment template</Label>
        <textarea
          id="s-comment"
          disabled={!canEdit}
          rows={6}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          {...register('commentTemplate')}
        />
      </FieldRow>
    </div>
  )
}

function TokenField({
  canEdit,
  newToken,
  setNewToken,
  tokenPresent,
  tokenUpdatedAt,
  tokenLoading,
}: {
  canEdit: boolean
  newToken: string
  setNewToken: (value: string) => void
  tokenPresent: boolean
  tokenUpdatedAt: string
  tokenLoading: boolean
}) {
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          ค่า token จะไม่แสดงในแดชบอร์ดนี้ — แสดงเฉพาะสถานะว่ามีหรือไม่
        </p>
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {tokenLoading ? (
            <span className="text-muted-foreground">กำลังตรวจสอบ token…</span>
          ) : tokenPresent ? (
            <>
              <Badge variant="success">🔒 มี token บันทึกไว้</Badge>
              <span className="text-xs text-muted-foreground">(ค่าไม่แสดง)</span>
              {tokenUpdatedAt ? (
                <span className="text-xs text-muted-foreground">
                  · อัปเดตล่าสุด {formatThaiDateTime(tokenUpdatedAt)}
                </span>
              ) : null}
            </>
          ) : (
            <Badge variant="outline">ยังไม่ได้บันทึก token</Badge>
          )}
        </div>
        {canEdit ? (
          <div className="space-y-1">
            <Label htmlFor="s-token">แทนที่ token (ไม่บังคับ)</Label>
            <textarea
              id="s-token"
              rows={4}
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
              placeholder="วาง Facebook access token ใหม่เพื่อแทนที่ — เว้นว่างไว้เพื่อคงค่าเดิม"
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              เว้นว่าง = ไม่เปลี่ยน token เดิม · ระบบจะไม่ดึงค่า token เดิมมาแสดง
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// Shared save bar — submit button + success / error / view-only status.
function SaveBar({
  canEdit,
  isDirty,
  newToken,
  mutation,
}: {
  canEdit: boolean
  isDirty: boolean
  newToken: string
  mutation: Mutation
}) {
  return (
    <div className="flex items-center gap-3 px-1">
      <Button type="submit" disabled={!canEdit || mutation.isPending || (!isDirty && !newToken.trim())}>
        {mutation.isPending ? 'กำลังบันทึก…' : 'บันทึก'}
      </Button>
      {mutation.isSuccess ? <span className="text-sm text-emerald-600">บันทึกแล้ว ✓</span> : null}
      {mutation.isError ? (
        <span className="text-sm text-destructive">
          {mutation.error instanceof Error ? mutation.error.message : 'บันทึกไม่สำเร็จ'}
        </span>
      ) : null}
      {!canEdit ? (
        <span className="text-xs text-muted-foreground">เพจนี้ดูอย่างเดียว</span>
      ) : null}
    </div>
  )
}

function SectionDetail({
  section,
  onBack,
  canEdit,
  pages,
  pagesLoading,
  pagesError,
  onOpenPage,
  onSubmit,
  register,
  errors,
  provider,
  setValue,
  newToken,
  setNewToken,
  tokenPresent,
  tokenUpdatedAt,
  tokenLoading,
  isDirty,
  mutation,
}: {
  section: SectionKey
  onBack: () => void
  canEdit: boolean
  pages: SettingsPage[]
  pagesLoading: boolean
  pagesError: boolean
  onOpenPage: (page: SettingsPage) => void
  onSubmit: (e?: React.BaseSyntheticEvent) => void
  register: FormRegister
  errors: FormErrors
  provider: PageSettingsForm['shortlinkProvider']
  setValue: FormSetValue
  newToken: string
  setNewToken: (value: string) => void
  tokenPresent: boolean
  tokenUpdatedAt: string
  tokenLoading: boolean
  isDirty: boolean
  mutation: Mutation
}) {
  const isForm = FORM_SECTIONS.has(section)

  let body: ReactNode = null

  if (section === 'pages') {
    body = <PagesDetail pages={pages} loading={pagesLoading} error={pagesError} onOpenPage={onOpenPage} />
  } else if (section === 'team') {
    body = (
      <PlaceholderCard
        icon="👥"
        title={`${TEAM_MEMBER_COUNT} สมาชิก`}
        description="จัดการสมาชิกทีมและสิทธิ์การเข้าถึงได้จาก LINE Mini App — ส่วนนี้แสดงจำนวนสมาชิกปัจจุบัน"
      />
    )
  } else if (section === 'monitor') {
    body = (
      <div className="space-y-3">
        <PlaceholderCard
          icon="📊"
          title="คิวสร้างแอดและการประมวลผล"
          description="ดูสถานะคิวสร้างแอดและการประมวลผลวิดีโอแบบเรียลไทม์ได้ที่หน้า Queue"
        />
        <Link
          to="/queue"
          className="flex items-center justify-between rounded-2xl border bg-card p-4 text-sm font-semibold shadow-sm transition-colors hover:bg-accent"
        >
          เปิดหน้า Monitor / Queue
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      </div>
    )
  } else if (section === 'shortlink') {
    body = <ShortlinkFields canEdit={canEdit} register={register} errors={errors} provider={provider} setValue={setValue} />
  } else if (section === 'ads') {
    body = <AdsFields canEdit={canEdit} register={register} />
  } else if (section === 'post') {
    body = <PostFields canEdit={canEdit} register={register} />
  } else if (section === 'comment') {
    body = <CommentField canEdit={canEdit} register={register} />
  } else {
    // token
    body = (
      <TokenField
        canEdit={canEdit}
        newToken={newToken}
        setNewToken={setNewToken}
        tokenPresent={tokenPresent}
        tokenUpdatedAt={tokenUpdatedAt}
        tokenLoading={tokenLoading}
      />
    )
  }

  // Text-heavy / short sections read better in a centered column instead of
  // stretching across the full desktop width. Wide sections (pages + the
  // two-column form groups) use the entire responsive container.
  const contentClass = NARROW_SECTIONS.has(section) ? 'mx-auto w-full max-w-2xl' : ''

  // Read-only sections render without a form/save bar.
  if (!isForm) {
    return (
      <div className="space-y-4">
        <DetailHeader title={SECTION_TITLES[section]} onBack={onBack} />
        <div className={contentClass}>{body}</div>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <DetailHeader title={SECTION_TITLES[section]} onBack={onBack} />

      <div className={`space-y-4 ${contentClass}`}>
        {body}
        <SaveBar canEdit={canEdit} isDirty={isDirty} newToken={newToken} mutation={mutation} />
      </div>
    </form>
  )
}

// LINE-style toggle pill (green by default, blue for the OneCard control).
function Toggle({
  on,
  onClick,
  disabled,
  color = 'green',
  label,
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
  color?: 'green' | 'blue'
  label: string
}) {
  const onBg = color === 'blue' ? 'bg-blue-600' : 'bg-green-500'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      className={`shrink-0 w-12 h-7 rounded-full relative transition-colors ${on ? onBg : 'bg-gray-300'} ${disabled ? 'opacity-60' : ''}`}
    >
      <span className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-all shadow-sm ${on ? 'right-1' : 'left-1'}`} />
    </button>
  )
}

// Plain white rounded card matching the LINE Mini App setting blocks.
function DetailCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border bg-card p-4 shadow-sm ${className ?? ''}`}>{children}</div>
}

// Dashboard operators in the CHEARB/PUBILO workspaces act as system admins, so
// the admin-only Auto-Ads block (mirrors the LINE `isSystemAdmin` gate) renders.
const IS_SYSTEM_ADMIN = true

// In-page Page detail/settings screen, opened by tapping a card in the Pages
// grid. Full port of the LINE Mini App PageDetail (apps/video-affiliate): every
// block, Thai label and interaction is mirrored so the team can manage a page
// entirely from the dashboard. Self-contained — it loads its own core page,
// shortlink, posting-order and avatar settings and writes them via the same
// worker endpoints the LINE app uses. The raw posting access token is never
// rendered: only presence is shown, and the edit modal is write-only.
function PageDetailView({
  page,
  onBack,
  canEdit,
}: {
  page: SettingsPage
  onBack: () => void
  canEdit: boolean
}) {
  const pageId = page.id

  // ---- Core page state ---------------------------------------------------
  const [coreLoading, setCoreLoading] = useState(true)
  const [coreError, setCoreError] = useState('')
  const [hourMinutes, setHourMinutes] = useState<Record<number, number>>({})
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('slots')
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [isActive, setIsActive] = useState(false)
  const [oneCardEnabled, setOneCardEnabled] = useState(false)
  const [adsPublishEnabled, setAdsPublishEnabled] = useState(false)
  const [captionLinkEnabled, setCaptionLinkEnabled] = useState(false)
  const [oneCardLinkMode, setOneCardLinkMode] = useState<OneCardLinkMode>('shopee')
  const [oneCardCta, setOneCardCta] = useState<OneCardCta>('SHOP_NOW')
  const [postingTokenSource, setPostingTokenSource] = useState<PostingTokenSource>('stored_token')
  const [commentTokenSource, setCommentTokenSource] = useState<CommentTokenSource>('stored_token')
  const [tokenPresent, setTokenPresent] = useState(page.hasToken)
  // Original loaded snapshot, used for the `base_*` fields in the PUT payload.
  const [basePostHours, setBasePostHours] = useState('')
  const [baseInterval, setBaseInterval] = useState<number | null>(null)
  const [baseIsActive, setBaseIsActive] = useState(0)

  // Write-only token replacement: '' means "leave the existing token unchanged".
  const [newToken, setNewToken] = useState('')
  const [editingToken, setEditingToken] = useState(false)
  const [editingTokenValue, setEditingTokenValue] = useState('')

  const [imageUrl, setImageUrl] = useState(page.iconUrl)
  const [pageName, setPageName] = useState(page.name || page.id)

  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | null>(null)
  const [saveError, setSaveError] = useState('')

  // ---- Shortlink override state -----------------------------------------
  const [shortlinkLoaded, setShortlinkLoaded] = useState(false)
  const [shortlinkLoading, setShortlinkLoading] = useState(false)
  const [shortlinkMessage, setShortlinkMessage] = useState('')
  const [globalShortlink, setGlobalShortlink] = useState<PageShortlinkSettingsForm>(() => createEmptyPageShortlinkSettingsForm())
  const [shortlink, setShortlink] = useState<PageShortlinkSettingsForm>(() => createEmptyPageShortlinkSettingsForm())
  const [shortlinkMax, setShortlinkMax] = useState({
    account: 64,
    baseUrl: 512,
    expectedUtm: 32,
    lazadaMember: 32,
    template: 2048,
    subId: 128,
  })

  // ---- Posting order state ----------------------------------------------
  const [postingOrderLoaded, setPostingOrderLoaded] = useState(false)
  const [postingOrderLoading, setPostingOrderLoading] = useState(false)
  const [postingOrderMessage, setPostingOrderMessage] = useState('')
  const [postingOrderOverride, setPostingOrderOverride] = useState(false)
  const [postingOrderDraft, setPostingOrderDraft] = useState<PostingOrderOption>('oldest_first')
  const [postingOrderGlobal, setPostingOrderGlobal] = useState<PostingOrderOption>('oldest_first')
  const [postingOrderUpdatedAt, setPostingOrderUpdatedAt] = useState('')
  const [postingOrderGlobalUpdatedAt, setPostingOrderGlobalUpdatedAt] = useState('')

  // ---- Avatar video state ------------------------------------------------
  const [avatarLoaded, setAvatarLoaded] = useState(false)
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarEnabled, setAvatarEnabled] = useState(false)
  const [avatarHasVideo, setAvatarHasVideo] = useState(false)
  const [avatarVersion, setAvatarVersion] = useState('')
  const [avatarUpdatedAt, setAvatarUpdatedAt] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarRemoveVideo, setAvatarRemoveVideo] = useState(false)
  const [avatarMessage, setAvatarMessage] = useState('')

  const [forcingPost, setForcingPost] = useState(false)

  // Load the authoritative core page fields.
  useEffect(() => {
    let cancelled = false
    setCoreLoading(true)
    setCoreError('')
    ;(async () => {
      try {
        const core = await fetchPageCore(pageId)
        if (cancelled) return
        setHourMinutes(parsePostHours(core.postHours))
        setScheduleMode(detectScheduleMode(core.postHours))
        setIntervalMinutes(parseInterval(core.postHours, core.postIntervalMinutes))
        setIsActive(core.isActive)
        setOneCardEnabled(core.oneCardEnabled)
        setAdsPublishEnabled(core.adsPublishEnabled)
        setCaptionLinkEnabled(core.captionLinkEnabled)
        setOneCardLinkMode(core.oneCardLinkMode)
        setOneCardCta(core.oneCardCta)
        setPostingTokenSource(core.postingTokenSource)
        setCommentTokenSource(core.commentTokenSource)
        setTokenPresent(core.tokenPresent)
        setBasePostHours(core.postHours)
        setBaseInterval(core.postIntervalMinutes ?? null)
        setBaseIsActive(core.isActive ? 1 : 0)
        if (core.imageUrl) setImageUrl(core.imageUrl)
        if (core.name) setPageName(core.name)
        setNewToken('')
        setEditingToken(false)
        setEditingTokenValue('')
      } catch (e) {
        if (!cancelled) setCoreError(e instanceof Error ? e.message : 'โหลดข้อมูลเพจไม่สำเร็จ')
      } finally {
        if (!cancelled) setCoreLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pageId])

  // Load per-page shortlink override.
  useEffect(() => {
    let cancelled = false
    setShortlinkLoading(true)
    setShortlinkLoaded(false)
    setShortlinkMessage('')
    ;(async () => {
      try {
        const data = await fetchPageShortlinkSettings(pageId)
        if (cancelled) return
        setGlobalShortlink(normalizePageShortlinkSettingsForm(data.global))
        setShortlink(normalizePageShortlinkSettingsForm(data.override))
        setShortlinkMax({
          account: data.max_account_chars && data.max_account_chars > 0 ? data.max_account_chars : 64,
          baseUrl: data.max_chars && data.max_chars > 0 ? data.max_chars : 512,
          expectedUtm: data.max_expected_utm_chars && data.max_expected_utm_chars > 0 ? data.max_expected_utm_chars : 32,
          lazadaMember: data.max_lazada_member_id_chars && data.max_lazada_member_id_chars > 0 ? data.max_lazada_member_id_chars : 32,
          template: data.max_template_chars && data.max_template_chars > 0 ? data.max_template_chars : 2048,
          subId: data.max_sub_id_chars && data.max_sub_id_chars > 0 ? data.max_sub_id_chars : 128,
        })
        setShortlinkLoaded(true)
      } catch (e) {
        if (!cancelled) setShortlinkMessage(e instanceof Error ? e.message : 'โหลด Shortlink เฉพาะเพจไม่สำเร็จ')
      } finally {
        if (!cancelled) setShortlinkLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pageId])

  // Load per-page posting order.
  useEffect(() => {
    let cancelled = false
    setPostingOrderLoading(true)
    setPostingOrderLoaded(false)
    setPostingOrderMessage('')
    ;(async () => {
      try {
        const data = await fetchPagePostingOrderSettings(pageId)
        if (cancelled) return
        const globalOrder = normalizePostingOrderOption(
          data.global?.posting_order || data.effective?.global_posting_order,
          'oldest_first',
        )
        const effectiveOrder = normalizePostingOrderOption(data.effective?.posting_order, globalOrder)
        const pageOrder = normalizePostingOrderOption(
          data.override?.posting_order || data.effective?.page_posting_order || effectiveOrder,
          effectiveOrder,
        )
        setPostingOrderGlobal(globalOrder)
        setPostingOrderDraft(pageOrder)
        setPostingOrderOverride(data.override?.override_enabled === true)
        setPostingOrderUpdatedAt(String(data.override?.updated_at || data.effective?.page_updated_at || ''))
        setPostingOrderGlobalUpdatedAt(String(data.global?.updated_at || data.effective?.global_updated_at || ''))
        setPostingOrderLoaded(true)
      } catch (e) {
        if (!cancelled) setPostingOrderMessage(e instanceof Error ? e.message : 'โหลดลำดับโพสต์เฉพาะเพจไม่สำเร็จ')
      } finally {
        if (!cancelled) setPostingOrderLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pageId])

  // Load per-page avatar video settings.
  useEffect(() => {
    let cancelled = false
    setAvatarLoading(true)
    setAvatarLoaded(false)
    setAvatarMessage('')
    ;(async () => {
      try {
        const data = await fetchPageAvatarSettings(pageId)
        if (cancelled) return
        const settings = normalizePageAvatarSettings(data.settings)
        setAvatarEnabled(settings.enabled)
        setAvatarHasVideo(settings.has_video)
        setAvatarVersion(settings.version)
        setAvatarUpdatedAt(settings.updated_at)
        setAvatarFile(null)
        setAvatarRemoveVideo(false)
        setAvatarLoaded(true)
      } catch (e) {
        if (!cancelled) setAvatarMessage(e instanceof Error ? e.message : 'โหลด Avatar เฉพาะเพจไม่สำเร็จ')
      } finally {
        if (!cancelled) setAvatarLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pageId])

  const hourOptions = Array.from({ length: 24 }, (_, i) => i)
  const selectedHours = Object.keys(hourMinutes).map(Number).sort((a, b) => a - b)
  const postHoursString = selectedHours.map((h) => `${h}:${hourMinutes[h].toString().padStart(2, '0')}`).join(',')

  const toggleHour = (hour: number) => {
    const next = { ...hourMinutes }
    if (hour in next) delete next[hour]
    else next[hour] = Math.floor(Math.random() * 59)
    setHourMinutes(next)
  }

  const globalShortlinkSummary = [
    globalShortlink.account ? `Account ${globalShortlink.account}` : '',
    globalShortlink.expected_utm_id ? `Shopee ${globalShortlink.expected_utm_id}` : '',
    globalShortlink.lazada_expected_member_id ? `Lazada ${globalShortlink.lazada_expected_member_id}` : '',
  ].filter(Boolean).join(' • ')
  const globalPostingOrderMeta = getPostingOrderOptionMeta(postingOrderGlobal)
  const postingOrderMessageIsError = !!postingOrderMessage && !postingOrderMessage.includes('บันทึก')
  const postingOrderTimestamp = postingOrderOverride ? postingOrderUpdatedAt : postingOrderGlobalUpdatedAt
  const shortlinkMessageIsError = !!shortlinkMessage && !shortlinkMessage.includes('บันทึกแล้ว')
  const avatarMessageIsError = !!avatarMessage && !avatarMessage.includes('บันทึก')

  const setShortlinkField = (patch: Partial<PageShortlinkSettingsForm>) => {
    setShortlink((prev) => ({ ...prev, ...patch }))
    if (shortlinkMessage) setShortlinkMessage('')
  }

  const handleSave = async () => {
    if (!canEdit || saving) return
    setSaving(true)
    setSaveStatus(null)
    setSaveError('')
    setShortlinkMessage('')
    setPostingOrderMessage('')
    setAvatarMessage('')
    try {
      const normalizedInterval = normalizeInterval(intervalMinutes)
      const schedulePostHours = scheduleMode === 'interval' ? `every:${normalizedInterval}` : postHoursString

      await savePageCore(pageId, {
        postHours: schedulePostHours,
        postIntervalMinutes: scheduleMode === 'interval' ? normalizedInterval : undefined,
        isActive,
        basePostHours,
        basePostIntervalMinutes: baseInterval,
        baseIsActive,
        oneCardEnabled,
        adsPublishEnabled,
        captionLinkEnabled,
        oneCardLinkMode,
        oneCardCta,
        postingTokenSource,
        commentTokenSource,
        newToken,
      })
      // Reflect the saved core values locally.
      setBasePostHours(schedulePostHours)
      setBaseInterval(scheduleMode === 'interval' ? normalizedInterval : baseInterval)
      setBaseIsActive(isActive ? 1 : 0)
      if (newToken.trim()) {
        setTokenPresent(true)
        setNewToken('')
      }
      setScheduleMode(detectScheduleMode(schedulePostHours))
      setIntervalMinutes(parseInterval(schedulePostHours, normalizedInterval))

      if (shortlinkLoaded) {
        const data = await savePageShortlinkSettings(pageId, shortlink)
        setGlobalShortlink(normalizePageShortlinkSettingsForm(data.global))
        setShortlink(normalizePageShortlinkSettingsForm(data.override))
      }

      if (postingOrderLoaded) {
        const data = await savePagePostingOrderSettings(pageId, postingOrderOverride, postingOrderDraft)
        const globalOrder = normalizePostingOrderOption(
          data.global?.posting_order || data.effective?.global_posting_order,
          postingOrderGlobal,
        )
        const effectiveOrder = normalizePostingOrderOption(data.effective?.posting_order, globalOrder)
        const pageOrder = normalizePostingOrderOption(
          data.override?.posting_order || data.effective?.page_posting_order || effectiveOrder,
          effectiveOrder,
        )
        setPostingOrderGlobal(globalOrder)
        setPostingOrderDraft(pageOrder)
        setPostingOrderOverride(data.override?.override_enabled === true)
        setPostingOrderUpdatedAt(String(data.override?.updated_at || data.effective?.page_updated_at || ''))
        setPostingOrderGlobalUpdatedAt(String(data.global?.updated_at || data.effective?.global_updated_at || ''))
      }

      if (avatarLoaded) {
        const settings = await savePageAvatarSettings(pageId, {
          enabled: avatarEnabled,
          version: avatarVersion,
          removeVideo: avatarRemoveVideo,
          file: avatarFile,
        })
        setAvatarEnabled(settings.enabled)
        setAvatarHasVideo(settings.has_video)
        setAvatarVersion(settings.version)
        setAvatarUpdatedAt(settings.updated_at)
        setAvatarFile(null)
        setAvatarRemoveVideo(false)
      }

      setSaveStatus('saved')
      window.setTimeout(() => setSaveStatus((s) => (s === 'saved' ? null : s)), 3000)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const handleFocusPost = async () => {
    if (forcingPost) return
    const confirmed = window.confirm(
      'โฟกัสโพสต์ตอนนี้ใช่ไหม? ระบบจะดึงคลิปจริงจาก Gallery แล้วโพสต์จริงเหมือน cron ทันที',
    )
    if (!confirmed) return
    setForcingPost(true)
    try {
      const result = await forcePost(pageId)
      window.alert(
        result.fbReelUrl
          ? `โฟกัสโพสต์สำเร็จ\n${result.fbReelUrl}`
          : `โฟกัสโพสต์สำเร็จ${result.fbPostId ? `\nPost ID: ${result.fbPostId}` : ''}`,
      )
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'โฟกัสโพสต์ไม่สำเร็จ')
    } finally {
      setForcingPost(false)
    }
  }

  return (
    <div className="space-y-4">
      <DetailHeader title={pageName} onBack={onBack} />

      <div className="mx-auto w-full max-w-2xl space-y-3">
        {/* Centered circular page avatar */}
        <div className="flex flex-col items-center pb-1">
          <img
            src={imageUrl || graphPageImageUrl(page.id)}
            alt={pageName}
            loading="lazy"
            onError={(e) => handlePageImgError(e, { ...page, iconUrl: imageUrl })}
            className="h-24 w-24 rounded-full border bg-muted object-cover shadow-sm"
          />
          <div className="mt-2 font-mono text-xs text-muted-foreground">{page.id}</div>
        </div>

        {coreError ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {coreError}
          </div>
        ) : null}

        {coreLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-muted" />
            ))}
          </div>
        ) : (
          <>
            {/* Auto Post */}
            <DetailCard className="flex items-center justify-between">
              <p className="font-bold text-foreground">Auto Post</p>
              <Toggle label="Auto Post" on={isActive} onClick={() => setIsActive(!isActive)} disabled={!canEdit} />
            </DetailCard>

            {/* Caption link */}
            <DetailCard>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-foreground">ใส่ลิงก์ในแคปชั่น</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">เปิด = ใส่ Shopee link บรรทัดแรกของแคปชั่นตอนโพสต์</p>
                </div>
                <Toggle label="ใส่ลิงก์ในแคปชั่น" on={captionLinkEnabled} onClick={() => setCaptionLinkEnabled(!captionLinkEnabled)} disabled={!canEdit} />
              </div>
            </DetailCard>

            {/* Video One Card */}
            <DetailCard className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-foreground">Video One Card</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">ตัวควบคุมหลัก: ปิด = โพสต์ Reel ปกติ, เปิด = โพสต์แบบ OneCard (สร้างแอด)</p>
                </div>
                <Toggle label="Video One Card" color="blue" on={oneCardEnabled} onClick={() => setOneCardEnabled(!oneCardEnabled)} disabled={!canEdit} />
              </div>

              {oneCardEnabled ? (
                <>
                  <div>
                    <p className="mb-2 text-xs font-bold text-foreground">ลิงก์ที่ใช้กับปุ่ม</p>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { value: 'shopee', label: 'Shopee' },
                        { value: 'lazada', label: 'Lazada' },
                        { value: 'none', label: 'ไม่ใส่ปุ่ม' },
                      ] as { value: OneCardLinkMode; label: string }[]).map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => setOneCardLinkMode(option.value)}
                          className={`rounded-lg py-2 text-sm font-medium transition-all ${oneCardLinkMode === option.value ? 'bg-blue-500 text-white' : 'bg-muted text-muted-foreground'}`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {oneCardLinkMode !== 'none' ? (
                    <div>
                      <p className="mb-2 text-xs font-bold text-foreground">ข้อความปุ่ม</p>
                      <div className="grid grid-cols-2 gap-2">
                        {([{ value: 'SHOP_NOW', label: 'Shop Now' }] as { value: OneCardCta; label: string }[]).map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            disabled={!canEdit}
                            onClick={() => setOneCardCta(option.value)}
                            className={`rounded-lg py-2 text-sm font-medium transition-all ${oneCardCta === option.value ? 'bg-blue-500 text-white' : 'bg-muted text-muted-foreground'}`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </DetailCard>

            {/* โทเค้นสำหรับใช้โพสต์ — two canonical modes (Page/Token + CloakBrowser) */}
            <DetailCard className="space-y-3">
              <div className="min-w-0">
                <p className="font-bold text-foreground">โทเค้นสำหรับใช้โพสต์</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  เลือกว่าจะให้เพจนี้โพสต์ด้วยโทเค้นที่กรอกเอง หรือผ่าน CloakBrowser ที่ login อยู่บนเครื่อง Mac
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: 'stored_token', label: 'Page/Token', hint: 'กรอก User/Page token เอง (legacy)' },
                  { value: 'cloak_browser', label: 'CloakBrowser', hint: 'ใช้ session ของ CloakBrowser โพสต์ให้' },
                ] as { value: PostingTokenSource; label: string; hint: string }[]).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setPostingTokenSource(option.value)}
                    aria-pressed={postingTokenSource === option.value}
                    className={`min-h-[74px] rounded-xl border px-3 py-2 text-left transition-all ${postingTokenSource === option.value ? 'border-blue-500 bg-blue-50' : 'border-border bg-muted/50'}`}
                  >
                    <span className={`block text-sm font-bold ${postingTokenSource === option.value ? 'text-blue-700' : 'text-foreground'}`}>{option.label}</span>
                    <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{option.hint}</span>
                  </button>
                ))}
              </div>

              {postingTokenSource === 'stored_token' ? (
                <div className="flex items-start justify-between gap-3 rounded-xl border bg-muted/50 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-foreground">Page/User Token</p>
                    <p className={`mt-1 text-xs font-bold ${newToken.trim() ? 'text-blue-600' : tokenPresent ? 'text-emerald-600' : 'text-orange-600'}`}>
                      {newToken.trim() ? 'จะบันทึกโทเค้นใหม่เมื่อกด Save' : tokenPresent ? '🔒 มีโทเค้นบันทึกไว้ (ค่าไม่แสดง)' : 'ยังไม่มีโทเค้น'}
                    </p>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      วาง Facebook User Token หรือ Page Token ได้เลย ระบบจะดึง page token ผ่าน <code>me/accounts</code> ให้เองถ้าจำเป็น · ค่าโทเค้นเดิมจะไม่ถูกดึงมาแสดงในแดชบอร์ด
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => {
                      // Write-only: the modal NEVER prefills with the existing
                      // token (the dashboard never loads its raw value).
                      setEditingTokenValue('')
                      setEditingToken(true)
                    }}
                    className="shrink-0 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-bold text-blue-600 active:scale-95"
                  >
                    แก้ไข
                  </button>
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-700">
                  CloakBrowser: ตอนโพสต์ระบบจะใช้ session ของ CloakBrowser ที่ login Facebook อยู่บนเครื่อง Mac โพสต์ให้ — <strong>ไม่เก็บ token ใดๆ ในระบบ</strong>. ถ้า <strong>Video One Card ปิด</strong> จะโพสต์ Reel ปกติ + คอมเมนต์ในนามเพจ; ถ้า <strong>Video One Card เปิด</strong> จะโพสต์แบบ OneCard (สร้างแอด) ให้แทน. ถ้า session/login ใช้ไม่ได้จะหยุดโพสต์ ไม่ fallback ไป token เก่า (ระบบ manual ยังใช้ได้ตามปกติ)
                </div>
              )}
            </DetailCard>

            {/* โทเค้นสำหรับใช้คอมเมนต์ — chosen independently of the posting source */}
            <DetailCard className="space-y-3">
              <div className="min-w-0">
                <p className="font-bold text-foreground">โทเค้นสำหรับใช้คอมเมนต์</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  เลือกว่าหลังโพสต์แล้วจะคอมเมนต์ลิงก์ด้วยโทเค้นที่กรอกเอง หรือคอมเมนต์ในนามเพจผ่าน CloakBrowser (แยกอิสระจากโทเค้นที่ใช้โพสต์)
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: 'stored_token', label: 'Page/Token', hint: 'คอมเมนต์ด้วย Page token ที่กรอกเอง' },
                  { value: 'cloak_browser', label: 'CloakBrowser', hint: 'คอมเมนต์ในนามเพจผ่าน session CloakBrowser' },
                ] as { value: CommentTokenSource; label: string; hint: string }[]).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setCommentTokenSource(option.value)}
                    aria-pressed={commentTokenSource === option.value}
                    className={`min-h-[74px] rounded-xl border px-3 py-2 text-left transition-all ${commentTokenSource === option.value ? 'border-blue-500 bg-blue-50' : 'border-border bg-muted/50'}`}
                  >
                    <span className={`block text-sm font-bold ${commentTokenSource === option.value ? 'text-blue-700' : 'text-foreground'}`}>{option.label}</span>
                    <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">{option.hint}</span>
                  </button>
                ))}
              </div>
              {commentTokenSource === 'stored_token' ? (
                <div className="rounded-xl border bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  Page/Token: คอมเมนต์ด้วย Page token ที่บันทึกไว้ (ช่อง <strong>โทเค้นสำหรับใช้โพสต์</strong>) — ต้องมีโทเค้น ถ้าไม่มีคอมเมนต์จะไม่สำเร็จ ระบบจะ<strong>ไม่</strong>สลับไปใช้ CloakBrowser ให้เอง
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-700">
                  CloakBrowser: คอมเมนต์ในนามเพจผ่าน session CloakBrowser ที่ login อยู่บนเครื่อง Mac — <strong>ไม่เก็บ token ใดๆ ในระบบ</strong>. ถ้า bridge/session ใช้ไม่ได้คอมเมนต์จะไม่สำเร็จ ระบบจะ<strong>ไม่</strong> fallback ไป token เก่า (โพสต์ยังสำเร็จตามปกติ)
                </div>
              )}
            </DetailCard>

            {/* Shortlink เฉพาะเพจนี้ */}
            <DetailCard className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-foreground">Shortlink เฉพาะเพจนี้</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {shortlink.override_enabled ? 'ใช้ค่าของเพจนี้ตอน cron โพสต์' : 'ใช้ค่ารวมของระบบ'}
                  </p>
                </div>
                <Toggle
                  label="Shortlink เฉพาะเพจนี้"
                  color="blue"
                  on={shortlink.override_enabled}
                  disabled={!canEdit || shortlinkLoading}
                  onClick={() => setShortlinkField({ override_enabled: !shortlink.override_enabled })}
                />
              </div>

              {shortlinkLoading ? (
                <p className="py-2 text-sm text-muted-foreground">กำลังโหลด Shortlink...</p>
              ) : shortlink.override_enabled ? (
                <div className="space-y-3">
                  <div className="space-y-3">
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">Shortlink account</p>
                      <Input
                        value={shortlink.account}
                        maxLength={shortlinkMax.account}
                        disabled={!canEdit}
                        onChange={(e) => setShortlinkField({ account: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })}
                        placeholder="CHEARB"
                        className="h-11"
                      />
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">Shortlink URL template</p>
                      <Input
                        value={shortlink.shortlink_url_template}
                        maxLength={shortlinkMax.template}
                        disabled={!canEdit}
                        onChange={(e) => setShortlinkField({ shortlink_url_template: e.target.value })}
                        placeholder="https://short.wwoom.com/?id=15130770000&url={url}&sub1={sub_id}"
                        className="h-11"
                      />
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">Sub ID 1</p>
                      <Input
                        value={shortlink.sub_id1}
                        maxLength={shortlinkMax.subId}
                        disabled={!canEdit}
                        onChange={(e) => setShortlinkField({ sub_id1: e.target.value })}
                        placeholder="page-sub1"
                        className="h-11"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">Shopee expected UTM</p>
                      <Input
                        value={shortlink.expected_utm_id}
                        maxLength={shortlinkMax.expectedUtm}
                        inputMode="numeric"
                        disabled={!canEdit}
                        onChange={(e) => setShortlinkField({ expected_utm_id: e.target.value.replace(/[^\d]/g, '') })}
                        placeholder="15130770000"
                        className="h-11"
                      />
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">Lazada member_id</p>
                      <Input
                        value={shortlink.lazada_expected_member_id}
                        maxLength={shortlinkMax.lazadaMember}
                        inputMode="numeric"
                        disabled={!canEdit}
                        onChange={(e) => setShortlinkField({ lazada_expected_member_id: e.target.value.replace(/[^\d]/g, '') })}
                        placeholder="199431090"
                        className="h-11"
                      />
                    </div>
                  </div>

                  <details className="rounded-xl border bg-muted/40 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-bold text-muted-foreground">Base URL และ Sub ID เพิ่มเติม</summary>
                    <div className="mt-3 space-y-3">
                      <Input
                        value={shortlink.base_url}
                        maxLength={shortlinkMax.baseUrl}
                        disabled={!canEdit}
                        onChange={(e) => setShortlinkField({ base_url: e.target.value })}
                        placeholder="Shopee base URL"
                        className="h-11"
                      />
                      <Input
                        value={shortlink.lazada_base_url}
                        maxLength={shortlinkMax.baseUrl}
                        disabled={!canEdit}
                        onChange={(e) => setShortlinkField({ lazada_base_url: e.target.value })}
                        placeholder="Lazada base URL"
                        className="h-11"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          { key: 'sub_id2', label: 'Sub ID 2' },
                          { key: 'sub_id3', label: 'Sub ID 3' },
                          { key: 'sub_id4', label: 'Sub ID 4' },
                          { key: 'sub_id5', label: 'Sub ID 5' },
                        ] as { key: keyof PageShortlinkSettingsForm; label: string }[]).map((item) => (
                          <Input
                            key={item.key}
                            value={String(shortlink[item.key] ?? '')}
                            maxLength={shortlinkMax.subId}
                            disabled={!canEdit}
                            onChange={(e) => setShortlinkField({ [item.key]: e.target.value } as Partial<PageShortlinkSettingsForm>)}
                            placeholder={item.label}
                            className="h-11"
                          />
                        ))}
                      </div>
                    </div>
                  </details>
                </div>
              ) : (
                <div className="rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  ใช้ค่ารวมของระบบ{globalShortlinkSummary ? `: ${globalShortlinkSummary}` : ''}
                </div>
              )}

              {shortlinkMessage ? (
                <p className={`text-xs ${shortlinkMessageIsError ? 'text-destructive' : 'text-emerald-600'}`}>{shortlinkMessage}</p>
              ) : null}
            </DetailCard>

            {/* ใช้ลำดับโพสต์เฉพาะเพจ */}
            <DetailCard className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-foreground">ใช้ลำดับโพสต์เฉพาะเพจ</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {postingOrderOverride ? 'เพจนี้เลือกคลิปตามค่าด้านล่าง' : `ใช้ค่ารวมของระบบ: ${globalPostingOrderMeta.title}`}
                  </p>
                </div>
                <Toggle
                  label="ใช้ลำดับโพสต์เฉพาะเพจ"
                  color="blue"
                  on={postingOrderOverride}
                  disabled={!canEdit || postingOrderLoading}
                  onClick={() => {
                    setPostingOrderOverride(!postingOrderOverride)
                    if (postingOrderMessage) setPostingOrderMessage('')
                  }}
                />
              </div>

              {postingOrderLoading ? (
                <p className="py-2 text-sm text-muted-foreground">กำลังโหลดลำดับโพสต์...</p>
              ) : (
                <div className="space-y-3">
                  {!postingOrderOverride ? (
                    <div className="rounded-xl bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
                      ใช้ค่ารวมของระบบ: <span className="font-bold text-foreground">{globalPostingOrderMeta.title}</span>
                      <span className="block">{globalPostingOrderMeta.subtitle}</span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {POSTING_ORDER_OPTIONS.map((option) => {
                        const active = postingOrderDraft === option.value
                        return (
                          <button
                            key={option.value}
                            type="button"
                            disabled={!canEdit}
                            onClick={() => {
                              setPostingOrderDraft(option.value)
                              if (postingOrderMessage) setPostingOrderMessage('')
                            }}
                            className={`w-full rounded-2xl border px-4 py-3 text-left transition-all active:scale-[0.99] ${active ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-border bg-muted/50'}`}
                          >
                            <div className="flex items-start gap-3">
                              <div className={`mt-0.5 h-4 w-4 rounded-full border ${active ? 'border-blue-500 bg-blue-500 shadow-[inset_0_0_0_3px_white]' : 'border-gray-300 bg-white'}`} />
                              <div className="min-w-0">
                                <p className={`text-sm font-bold ${active ? 'text-blue-700' : 'text-foreground'}`}>{option.title}</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">{option.subtitle}</p>
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {postingOrderTimestamp ? (
                    <p className="text-[11px] text-muted-foreground">อัปเดตล่าสุด: {formatThaiDateTime(postingOrderTimestamp)}</p>
                  ) : null}
                </div>
              )}

              {postingOrderMessage ? (
                <p className={`text-xs ${postingOrderMessageIsError ? 'text-destructive' : 'text-emerald-600'}`}>{postingOrderMessage}</p>
              ) : null}
            </DetailCard>

            {/* Avatar video เฉพาะเพจนี้ */}
            <DetailCard className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-foreground">Avatar video เฉพาะเพจนี้</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">ใช้เฉพาะตอนโพสต์จริง หลังระบบเลือกเพจแล้ว ก่อนส่ง Facebook</p>
                </div>
                <Toggle
                  label="Avatar video เฉพาะเพจนี้"
                  on={avatarEnabled}
                  disabled={!canEdit || avatarLoading}
                  onClick={() => setAvatarEnabled(!avatarEnabled)}
                />
              </div>

              <p className="rounded-xl bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
                วิดีโอ Avatar ต้องจัดตำแหน่งมาเต็มเฟรมแล้ว ระบบจะ scale ทั้งเฟรมเป็น 720x1280, ตัด green screen และวางทับที่มุม 0:0 โดยไม่ crop, ไม่ย้ายตำแหน่ง และไม่ย่อคนในคลิป
              </p>

              {avatarLoading ? (
                <p className="py-2 text-sm text-muted-foreground">กำลังโหลด Avatar...</p>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-xl border border-dashed bg-muted/40 px-3 py-3">
                    <input
                      type="file"
                      accept="video/mp4,video/*"
                      disabled={!canEdit}
                      onChange={(e) => {
                        const file = e.currentTarget.files?.[0] || null
                        setAvatarFile(file)
                        if (file) {
                          setAvatarRemoveVideo(false)
                          setAvatarHasVideo(true)
                        }
                        if (avatarMessage) setAvatarMessage('')
                      }}
                      className="w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-2 file:text-sm file:font-bold file:text-white"
                    />
                    <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                      <span className={avatarHasVideo ? 'text-emerald-600' : 'text-muted-foreground'}>
                        {avatarFile ? `เตรียมอัปโหลด: ${avatarFile.name}` : avatarHasVideo ? 'มีวิดีโอ Avatar แล้ว' : 'ยังไม่มีวิดีโอ Avatar'}
                      </span>
                      {avatarHasVideo || avatarFile ? (
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={() => {
                            setAvatarFile(null)
                            setAvatarHasVideo(false)
                            setAvatarRemoveVideo(true)
                            setAvatarEnabled(false)
                          }}
                          className="shrink-0 font-bold text-destructive"
                        >
                          ล้างวิดีโอ
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {avatarUpdatedAt ? (
                    <p className="text-[11px] text-muted-foreground">อัปเดตล่าสุด: {formatThaiDateTime(avatarUpdatedAt)}</p>
                  ) : null}
                </div>
              )}

              {avatarMessage ? (
                <p className={`text-xs ${avatarMessageIsError ? 'text-destructive' : 'text-emerald-600'}`}>{avatarMessage}</p>
              ) : null}
            </DetailCard>

            {/* Auto-Ads (admin namespace) */}
            {IS_SYSTEM_ADMIN ? (
              <DetailCard className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-foreground">ใช้ Video One Card ตอนโพสต์อัตโนมัติ</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">เปิดแล้ว cron จะโพสต์แบบ OneCard + ยิงแอด; ปิดแล้ว cron จะโพสต์ Reels ปกติ</p>
                  </div>
                  <Toggle
                    label="ยิงแอดอัตโนมัติทุกโพสต์"
                    on={adsPublishEnabled}
                    disabled={!canEdit}
                    onClick={() => setAdsPublishEnabled(!adsPublishEnabled)}
                  />
                </div>
              </DetailCard>
            ) : null}

            {/* โฟกัสโพสต์ */}
            <DetailCard className="border-blue-100">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-foreground">โฟกัสโพสต์</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">ดึงวิดีโอจริงและโพสต์จริงทันทีเหมือนตอน cron ทำงาน</p>
                </div>
                <button
                  type="button"
                  onClick={handleFocusPost}
                  disabled={!canEdit || forcingPost}
                  className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-all ${forcingPost ? 'bg-gray-300 text-white' : 'bg-blue-600 text-white active:scale-95'}`}
                >
                  {forcingPost ? 'กำลังโพสต์...' : 'โพสต์ตอนนี้'}
                </button>
              </div>
            </DetailCard>

            {/* โพสต์เวลาไหนบ้าง */}
            <DetailCard>
              <p className="mb-1 text-sm font-bold text-foreground">โพสต์เวลาไหนบ้าง</p>
              <div className="mb-3 flex rounded-xl bg-muted p-1">
                <button
                  type="button"
                  onClick={() => setScheduleMode('slots')}
                  className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all ${scheduleMode === 'slots' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
                >
                  ติ๊กเวลา
                </button>
                <button
                  type="button"
                  onClick={() => setScheduleMode('interval')}
                  className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all ${scheduleMode === 'interval' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}
                >
                  ทุกๆ X นาที
                </button>
              </div>

              {scheduleMode === 'slots' ? (
                <>
                  <p className="mb-3 text-xs text-muted-foreground">เลือกได้หลายเวลา (กดติ๊ก)</p>
                  <div className="grid grid-cols-6 gap-2">
                    {hourOptions.map((hour) => (
                      <button
                        key={hour}
                        type="button"
                        onClick={() => toggleHour(hour)}
                        className={`rounded-lg py-2 text-sm font-medium transition-all ${selectedHours.includes(hour) ? 'bg-blue-500 text-white' : 'bg-muted text-muted-foreground'}`}
                      >
                        {hour.toString().padStart(2, '0')}
                      </button>
                    ))}
                  </div>
                  {selectedHours.length > 0 ? (
                    <p className="mt-3 text-xs text-blue-500">
                      จะโพสต์เวลา: {selectedHours.map((h) => `${h.toString().padStart(2, '0')}:${hourMinutes[h].toString().padStart(2, '0')} น.`).join(', ')}
                    </p>
                  ) : (
                    <p className="mt-3 text-xs text-muted-foreground">ยังไม่เลือกเวลา</p>
                  )}
                </>
              ) : (
                <>
                  <p className="mb-3 text-xs text-muted-foreground">โพสต์วนทุกช่วงเวลา ไม่จำกัดจำนวนโพสต์ต่อวัน</p>
                  <div className="grid grid-cols-4 gap-2">
                    {[15, 20, 30, 45, 60, 90, 120, 180].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setIntervalMinutes(m)}
                        className={`rounded-lg py-2 text-sm font-medium transition-all ${intervalMinutes === m ? 'bg-blue-500 text-white' : 'bg-muted text-muted-foreground'}`}
                      >
                        {m} นาที
                      </button>
                    ))}
                  </div>
                </>
              )}
            </DetailCard>

            {/* Big Save button */}
            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={handleSave}
                disabled={!canEdit || saving}
                className={`w-full rounded-2xl py-4 text-base font-bold transition-all ${saving ? 'bg-gray-400 text-white' : 'bg-blue-600 text-white active:scale-95'}`}
              >
                {saving ? 'กำลังบันทึก...' : 'Save'}
              </button>
              {saveStatus === 'saved' ? <p className="text-center text-sm text-emerald-600">บันทึกแล้ว ✓</p> : null}
              {saveError ? <p className="text-center text-sm text-destructive">{saveError}</p> : null}
              {!canEdit ? <p className="text-center text-xs text-muted-foreground">เพจนี้ดูอย่างเดียว</p> : null}
            </div>
          </>
        )}
      </div>

      {/* Token edit modal — write-only, never prefilled with the existing token */}
      {editingToken ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6" onClick={() => setEditingToken(false)}>
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-center text-base font-bold text-foreground">Access Token (โพสต์)</h3>
            <textarea
              value={editingTokenValue}
              onChange={(e) => setEditingTokenValue(e.target.value)}
              placeholder="วาง Facebook User Token หรือ Page Token ที่นี่..."
              rows={4}
              autoComplete="off"
              spellCheck={false}
              className="w-full resize-none rounded-xl border border-input bg-background px-4 py-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground">
              ถ้าวาง User Token ระบบจะ resolve ให้เป็น token ของเพจนี้อัตโนมัติ · เว้นว่าง = ไม่เปลี่ยนโทเค้นเดิม
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setEditingToken(false)}
                className="flex-1 rounded-xl border border-input py-3 text-sm font-bold text-muted-foreground active:scale-95"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewToken(editingTokenValue.trim())
                  setEditingToken(false)
                }}
                className="flex-1 rounded-xl bg-blue-600 py-3 text-sm font-bold text-white active:scale-95"
              >
                บันทึก
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
