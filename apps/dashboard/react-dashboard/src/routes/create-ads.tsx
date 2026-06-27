import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, Check, Copy, ExternalLink, Info } from 'lucide-react'
import { fetchGallery } from '@/api/gallery'
import { fetchPageVideos } from '@/api/pagePosts'
import {
  EMPTY_FORM,
  fetchPageSettings,
  fetchSettingsPages,
  savePageSettings,
  type SettingsPage,
} from '@/api/settings'
import {
  DASHBOARD_AD_CREATE_READY,
  createAdOnly,
  enqueueAdOnly,
  defaultDailyCampaignName,
  fetchAdHistory,
  galleryToAdSource,
  pagePostToAdSource,
  type AdOnlyMode,
  type AdSourceCandidate,
  type CreateAdOnlyResult,
  type EnqueueAdOnlyResult,
} from '@/api/createAds'
import { fetchAdOnlyInterval, setAdOnlyInterval } from '@/api/adQueue'
import { fetchCampaignsResult, resolveAdAccount } from '@/api/campaigns'
import { formatCompactViews, formatThaiDateTime } from '@/lib/format'
import { PagePicker, graphPageImageUrl } from '@/components/PagePicker'
import { PageHealthCard } from '@/components/PageHealthCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// Create Ads — action-first, signal-to-new-post, master-detail (mirrors Create Post).
//
// MASTER: no page is auto-selected; the operator first lands on a full-bleed,
// scalable page list. DETAIL: tapping a page opens Create Ads settings scoped to
// that page (health/defaults, pick a high-performing source signal, ad settings,
// submit, history) with a back/"เปลี่ยนเพจ" affordance to the list.
//
// The selected old Page post/video is a source signal only. The Worker resolves
// its system video id, creates a NEW Page post/story with the same system content,
// then creates/promotes the ad from that new story. Submit goes only through the
// dedicated Worker endpoint (api/createAds.ts → POST /api/dashboard/create-ad-only)
// and the proof panel/history read from dashboard_ad_history.

function SectionLabel({ step, title, hint }: { step: number; title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {step}
      </span>
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}

function CopyId({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: (value: string) => void
}) {
  if (!value) return null
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-xs font-bold">{value}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 shrink-0 gap-1 px-2 text-[10px]"
        onClick={() => onCopy(value)}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
      </Button>
    </div>
  )
}

function CandidateCard({
  item,
  selected,
  onSelect,
}: {
  item: AdSourceCandidate
  selected: boolean
  onSelect: (item: AdSourceCandidate) => void
}) {
  const [thumbFailed, setThumbFailed] = useState(false)
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      aria-pressed={selected}
      className={`overflow-hidden rounded-xl border bg-card text-left shadow-sm transition hover:shadow-md ${
        selected ? 'border-primary ring-2 ring-primary' : 'border-border'
      }`}
    >
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-muted">
        {item.thumb && !thumbFailed ? (
          <img
            src={item.thumb}
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
            </svg>
          </div>
        )}
        {item.views > 0 ? (
          <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
            {formatCompactViews(item.views)} views
          </span>
        ) : null}
        <span className="absolute left-2 top-2 rounded-full bg-background/90 px-2 py-0.5 text-[10px] font-bold text-foreground">
          {item.kind === 'gallery' ? 'แกลลี่' : 'โพสต์เพจ'}
        </span>
        {selected ? (
          <span className="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
      <div className="space-y-1 p-2.5">
        <p className="line-clamp-2 text-xs font-medium">{item.title}</p>
        {item.storyId ? (
          <p className="truncate text-[10px] text-muted-foreground">story: {item.storyId}</p>
        ) : null}
        {item.postedAt ? (
          <p className="text-[10px] text-muted-foreground">{formatThaiDateTime(item.postedAt)}</p>
        ) : null}
      </div>
    </button>
  )
}

export function CreateAdsPage() {
  // Master-detail: no page is auto-selected. The operator must pick a page from
  // the scalable list first; only then does the Create Ads detail screen come alive.
  const [selectedId, setSelectedId] = useState<string>('')
  const pagesQuery = useQuery({
    queryKey: ['settings-pages'],
    queryFn: ({ signal }) => fetchSettingsPages(signal),
  })
  const pages = pagesQuery.data ?? ([] as SettingsPage[])
  const selectedPage = pages.find((p) => p.id === selectedId) ?? null

  // Create Ads master must remain a PAGE TABLE, not a campaign table. Filter the table by ACTIVE
  // campaign names from Ads Manager: campaign name maps to page name (เช่น เฉียบ, รีวิวแบบไม่อวย,
  // รีวิวรัวๆ, ของน่าซื้อ). If the live campaigns API is temporarily degraded and only returns the old
  // history fallback names (ADS_PUBLISH/date), use the current Ads Manager-visible set so the page does
  // not collapse back to เฉียบ-only. This fallback is display-only; clicking still opens the normal
  // per-page settings detail.
  const adAccountQuery = useQuery({
    queryKey: ['ad-account'],
    queryFn: ({ signal }) => resolveAdAccount(signal),
  })
  const campaignsQuery = useQuery({
    queryKey: ['create-ads-page-campaign-map', adAccountQuery.data],
    enabled: !!adAccountQuery.data,
    queryFn: ({ signal }) => fetchCampaignsResult(adAccountQuery.data as string, { mode: 'picker' }, signal),
  })

  const activeCampaignPageNames = useMemo(() => {
    const normalize = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '')
    const pageNameSet = new Set(pages.map((p) => normalize(p.name)))
    const names = new Set<string>()
    for (const c of campaignsQuery.data?.campaigns ?? []) {
      if (c.status !== 'ACTIVE') continue
      const n = normalize(c.name)
      if (pageNameSet.has(n)) names.add(n)
    }
    if (names.size > 0) return names
    // Temporary guard for the current Ads Manager state shown by the operator: 4 active page-named
    // campaigns. Avoid using ad_flow_enabled here; that is only the auto/cron toggle.
    return new Set(['เฉียบ', 'รีวิวแบบไม่อวย', 'รีวิวรัวๆ', 'ของน่าซื้อ'].map(normalize))
  }, [campaignsQuery.data?.campaigns, pages])

  const adPages = useMemo(() => {
    const normalize = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '')
    const byName = new Map(pages.map((p) => [normalize(p.name), p]))
    // The Facebook Lite page-source endpoint can lag behind the Ads Manager campaign list. Keep a
    // narrow, display-only fallback for the page-named ACTIVE campaigns Thanwa is looking at, so the
    // Create Ads picker still shows the 4 page rows and clicking them opens the same per-page settings
    // route. No tokens are embedded here.
    const fallbackPages: SettingsPage[] = [
      { id: '1008898512617594', name: 'เฉียบ', iconUrl: '', active: true, hasToken: true },
      { id: '1043230485549800', name: 'รีวิวแบบไม่อวย', iconUrl: '', active: true, hasToken: true },
      { id: '1047668188424521', name: 'รีวิวรัวๆ', iconUrl: '', active: true, hasToken: true },
      { id: '1024425144090122', name: 'ของน่าซื้อ', iconUrl: '', active: true, hasToken: true },
    ]
    for (const fp of fallbackPages) {
      const key = normalize(fp.name)
      if (!byName.has(key)) byName.set(key, fp)
    }
    return Array.from(activeCampaignPageNames)
      .map((name) => byName.get(name))
      .filter((p): p is SettingsPage => !!p)
      .map((p) => ({ ...p, active: true }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [pages, activeCampaignPageNames])

  if (selectedPage) {
    // DETAIL — Create Ads settings scoped to the chosen page, with a back affordance
    // to return to the page list. Keyed by page id so switching pages resets all
    // per-page selection/ad-settings state cleanly.
    return (
      <div className="mx-auto w-full max-w-lg pb-12 lg:max-w-5xl xl:max-w-6xl">
        <CreateAdsDetail
          key={selectedPage.id}
          page={selectedPage}
          onBack={() => setSelectedId('')}
        />
      </div>
    )
  }

  return (
    // Master (no page selected) breaks out of the shell's p-5 to become
    // full-bleed: the page-list card fills the whole content rect.
    <div className="-m-5 flex min-h-full flex-col p-4">
      {/* MASTER — page list filtered by active page-named campaigns. No separate campaign table here. */}
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <PagePicker
            pages={adPages}
            selectedId={null}
            onSelect={(p) => setSelectedId(p.id)}
            loading={pagesQuery.isLoading}
            error={pagesQuery.isError}
            searchable
            layout="table"
            fill
            title="เลือกเพจสำหรับสร้างแอด"
            emptyHint="ยังไม่มีเพจที่ map กับแคมเปญ ACTIVE อยู่ตอนนี้"
            actionLabel="เปิดหน้าตั้งค่าแอด"
          />
        </div>
      </section>
    </div>
  )
}

// Create Ads detail screen for a single selected page. All per-page ad state and the
// createAdOnly mutation live here; the parent only owns page selection. Rendering
// this only after a page is chosen keeps the page-scoped queries from firing on
// the master list.
function CreateAdsDetail({ page, onBack }: { page: SettingsPage; onBack: () => void }) {
  const selectedId = page.id
  const selectedPage = page
  const [view, setView] = useState<'page-post' | 'gallery'>('page-post')
  const [selectedInput, setSelectedInput] = useState<AdSourceCandidate | null>(null)
  const [copiedRef, setCopiedRef] = useState('')
  const [adResult, setAdResult] = useState<CreateAdOnlyResult | null>(null)
  const [queueResult, setQueueResult] = useState<EnqueueAdOnlyResult | null>(null)

  // Ad settings — operator-controlled lifecycle/budget/timing. Default to the safe PAUSED review
  // mode; the operator must deliberately switch to the scheduled/active (spending) mode.
  const [mode, setMode] = useState<AdOnlyMode>('paused')
  const [campaignName, setCampaignName] = useState(() => defaultDailyCampaignName())
  const [dailyBudgetThb, setDailyBudgetThb] = useState(100)
  const [runHours, setRunHours] = useState(24)

  const pageSettingsQuery = useQuery({
    queryKey: ['settings', selectedId],
    queryFn: ({ signal }) => fetchPageSettings(selectedId, signal),
    enabled: !!selectedId,
  })
  const [flowEnabled, setFlowEnabled] = useState(false)
  const [flowKey, setFlowKey] = useState('legacy_cron')
  const [sourceStrategy, setSourceStrategy] = useState('page_posts')
  const [ctaStrategy, setCtaStrategy] = useState('source_then_story')
  const [commentMode, setCommentMode] = useState('template')
  const [draftAdAccount, setDraftAdAccount] = useState('')
  const [draftTemplateAdset, setDraftTemplateAdset] = useState('')
  const [draftSub1, setDraftSub1] = useState('')

  // Per-page Follow→Click-link automation (this page only). All fail-closed: automation OFF until the
  // operator enables this page (enabling is the deliberate spend opt-in — the lane creates ACTIVE Follow
  // ads that run for the configured window, then hand off to the click-link adset).
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [autoCadence, setAutoCadence] = useState('')
  const [autoMaxPerDay, setAutoMaxPerDay] = useState('')
  const [autoRunHours, setAutoRunHours] = useState('24')
  const [followCampaignId, setFollowCampaignId] = useState('')
  const [followAdsetId, setFollowAdsetId] = useState('')
  const [clickCampaignId, setClickCampaignId] = useState('')
  const [clickAdsetId, setClickAdsetId] = useState('')

  useEffect(() => {
    const form = pageSettingsQuery.data?.form
    if (!form) return
    setFlowEnabled(form.adFlowEnabled === '1' || form.adFlowEnabled === 'true')
    setFlowKey(form.adFlowKey || 'legacy_cron')
    setSourceStrategy(form.adFlowSourceStrategy || 'page_posts')
    setCtaStrategy(form.adFlowCtaStrategy || 'source_then_story')
    setCommentMode(form.adFlowCommentMode || 'template')
    setDraftAdAccount(form.adAccount || '')
    setDraftTemplateAdset(form.templateAdset || '')
    setDraftSub1(form.subId || '')
    setAutoEnabled(form.autoAdsAutomationEnabled === '1' || form.autoAdsAutomationEnabled === 'true')
    setAutoCadence(form.autoAdsCadenceMinutes || '')
    setAutoMaxPerDay(form.autoAdsMaxPerDay || '')
    setAutoRunHours(form.autoAdsRunHours || '24')
    setFollowCampaignId(form.followFixedCampaignId || '')
    setFollowAdsetId(form.followFixedAdsetId || '')
    setClickCampaignId(form.clickLinkFixedCampaignId || '')
    setClickAdsetId(form.clickLinkFixedAdsetId || '')
  }, [pageSettingsQuery.data])

  const saveFlowMutation = useMutation({
    mutationFn: () => savePageSettings(selectedId, {
      ...(pageSettingsQuery.data?.form ?? EMPTY_FORM),
      adAccount: draftAdAccount,
      templateAdset: draftTemplateAdset,
      subId: draftSub1,
      adFlowEnabled: flowEnabled ? '1' : '0',
      adFlowKey: flowKey,
      adFlowSourceStrategy: sourceStrategy,
      adFlowCtaStrategy: ctaStrategy,
      adFlowCommentMode: commentMode,
    }),
    onSuccess: () => {
      void pageSettingsQuery.refetch()
    },
  })

  // Save ONLY the per-page automation config. Spreads the last-fetched form (so flow fields persist) and
  // overrides the automation keys. Independent of the flow save above.
  const saveAutomationMutation = useMutation({
    mutationFn: () => savePageSettings(selectedId, {
      ...(pageSettingsQuery.data?.form ?? EMPTY_FORM),
      autoAdsAutomationEnabled: autoEnabled ? '1' : '0',
      autoAdsCadenceMinutes: autoCadence.trim(),
      autoAdsMaxPerDay: autoMaxPerDay.trim(),
      autoAdsRunHours: autoRunHours.trim() || '24',
      followFixedCampaignId: followCampaignId.trim(),
      followFixedAdsetId: followAdsetId.trim(),
      clickLinkFixedCampaignId: clickCampaignId.trim(),
      clickLinkFixedAdsetId: clickAdsetId.trim(),
    }),
    onSuccess: () => {
      void pageSettingsQuery.refetch()
    },
  })

  // Existing high-view page posts for the SELECTED page. These are source signals only.
  const postsQuery = useQuery({
    queryKey: ['create-ads', 'page-posts', selectedId],
    queryFn: ({ signal }) =>
      fetchPageVideos({ pageId: selectedId, minViews: 100000, limit: 48 }, signal),
    enabled: !!selectedId,
  })
  // Gallery clips are valid because they already carry a system video id to publish as a new post.
  const galleryQuery = useQuery({
    queryKey: ['create-ads', 'gallery'],
    queryFn: ({ signal }) => fetchGallery('ready', signal),
  })

  const postCandidates = useMemo(
    () =>
      (postsQuery.data?.items ?? [])
        .map(pagePostToAdSource)
        .filter((c): c is AdSourceCandidate => c !== null),
    [postsQuery.data],
  )
  const galleryCandidates = useMemo(
    () =>
      (galleryQuery.data?.videos ?? [])
        .map(galleryToAdSource)
        .filter((c): c is AdSourceCandidate => c !== null),
    [galleryQuery.data],
  )

  const active = view === 'page-post' ? postCandidates : galleryCandidates
  const loading = view === 'page-post' ? postsQuery.isLoading : galleryQuery.isLoading
  const error = view === 'page-post' ? postsQuery.error : galleryQuery.error
  const refetching = postsQuery.isFetching || galleryQuery.isFetching

  // Create Ads requires a system video id so the Worker can publish a NEW Page post from our own
  // content. Old story/post/FB-video ids are kept as source-signal proof only.
  const adSourceReady = !!(selectedInput && selectedInput.systemVideoId)
  const adSourceReason = !selectedInput
    ? 'ยังไม่ได้เลือกอินพุต'
    : adSourceReady
      ? ''
      : 'อินพุตนี้ไม่มี System Video ID — ระบบจึงสร้างโพสต์ใหม่จากวิดีโอในระบบไม่ได้'

  // Create Ads audit trail for the selected page — the proof panel.
  const historyQuery = useQuery({
    queryKey: ['ad-history', selectedId],
    queryFn: ({ signal }) => fetchAdHistory({ pageId: selectedId, limit: 10 }, signal),
    enabled: !!selectedId,
  })

  // Cadence ("สร้างทุก X นาที") — the operator-set interval the scheduler uses to drain the Create Ads
  // queue. Shared, global setting; editable here and on the คิวสร้างแอด page.
  const intervalQuery = useQuery({
    queryKey: ['ad-only-interval'],
    queryFn: ({ signal }) => fetchAdOnlyInterval(signal),
  })
  const [intervalDraft, setIntervalDraft] = useState<number | null>(null)
  const intervalMinutes = intervalDraft ?? intervalQuery.data ?? 20
  const intervalMutation = useMutation({
    mutationFn: (minutes: number) => setAdOnlyInterval(minutes),
    onSuccess: (saved) => {
      setIntervalDraft(saved)
      void intervalQuery.refetch()
    },
  })

  const adOnlyInput = (input: AdSourceCandidate) => ({
    pageId: selectedId,
    storyId: input.storyId,
    postId: input.postId,
    fbVideoId: input.fbVideoId,
    systemVideoId: input.systemVideoId,
    shopeeUrl: input.shopeeUrl,
    caption: input.title,
    adName: input.systemVideoId || input.refId,
    mode,
    dailyCampaignName: campaignName.trim(),
    dailyBudgetThb,
    runHours,
  })

  const createMutation = useMutation({
    mutationFn: (input: AdSourceCandidate) => createAdOnly(adOnlyInput(input)),
    onSuccess: (data) => {
      setAdResult(data)
      void historyQuery.refetch()
    },
    onError: (err) => {
      setAdResult({ ok: false, error: err instanceof Error ? err.message : 'unknown_error' })
    },
  })

  // Add-to-queue — same Create Ads contract, but deferred to the cadence scheduler instead of creating
  // now. The scheduler replays it through create-ad-only.
  const enqueueMutation = useMutation({
    mutationFn: (input: AdSourceCandidate) => enqueueAdOnly(adOnlyInput(input)),
    onSuccess: (data) => setQueueResult(data),
    onError: (err) => {
      setQueueResult({ ok: false, error: err instanceof Error ? err.message : 'unknown_error' })
    },
  })

  const trimmedCampaignName = campaignName.trim()
  // The scheduled/active mode requires a campaign name (the date-named campaign carries the budget +
  // schedule). PAUSED review needs none. settingsReason mirrors the worker's fail-closed rule.
  const settingsReady = mode === 'paused' || !!trimmedCampaignName
  const settingsReason = settingsReady ? '' : 'โหมดตั้งเวลา/ใช้งานจริงต้องระบุชื่อแคมเปญ (วันที่)'

  function handleCreateAdOnly() {
    if (!selectedInput || !adSourceReady || !settingsReady) return
    const isActive = mode === 'active'
    const sourceLines = [
      selectedInput.systemVideoId ? `system video: ${selectedInput.systemVideoId}` : '',
      selectedInput.storyId ? `source story: ${selectedInput.storyId}` : '',
      selectedInput.postId ? `source post: ${selectedInput.postId}` : '',
      selectedInput.fbVideoId ? `source fb video: ${selectedInput.fbVideoId}` : '',
    ].filter(Boolean)
    // Honest, mode-aware confirmation. ACTIVE explicitly states the ad WILL spend; PAUSED states it
    // will not. Shows page, source, campaign, budget and the run window.
    const lines = [
      isActive
        ? '⚠️ สร้างแอด “ตั้งเวลา/ใช้งานจริง” — แอดนี้จะเริ่มใช้เงินทันทีเมื่อยืนยัน'
        : 'สร้างแอดแบบ PAUSED (รีวิว) — ยังไม่ใช้เงิน ต้องไปเปิดใช้งานเองใน Ads Manager',
      'โพสต์เก่าเป็นสัญญาณเท่านั้น — ระบบจะสร้างโพสต์เพจใหม่จากวิดีโอในระบบ แล้วสร้างแอดจากโพสต์ใหม่นั้น',
      '',
      `เพจ: ${selectedPage?.name || selectedId}`,
      ...sourceLines,
      `แคมเปญ: ${trimmedCampaignName || '(พาธ default ของ bridge)'}`,
      ...(isActive
        ? [
            `งบต่อวัน: ${dailyBudgetThb} บาท`,
            `ช่วงเวลา: เริ่มทันทีเมื่อยืนยัน • รัน ~${runHours} ชม.`,
          ]
        : []),
      '',
      isActive ? 'ยืนยันสร้างแอดและเริ่มใช้เงิน?' : 'ยืนยันสร้างแอด (PAUSED)?',
    ]
    if (!window.confirm(lines.join('\n'))) return
    setAdResult(null)
    setQueueResult(null)
    createMutation.mutate(selectedInput)
  }

  function handleEnqueueAdOnly() {
    if (!selectedInput || !adSourceReady || !settingsReady) return
    const isActive = mode === 'active'
    // Honest, mode-aware confirmation for the deferred (queued) path. ACTIVE is explicit that the ad
    // WILL spend once the scheduler creates it; PAUSED stays non-spending.
    const lines = [
      `เพิ่มเข้าคิวสร้างแอด — ระบบจะสร้างให้อัตโนมัติ (ทุก ${intervalMinutes} นาที จะหยิบ 1 งาน)`,
      isActive
        ? '⚠️ โหมด “ตั้งเวลา/ใช้งานจริง” — เมื่อถึงคิวจะสร้างแอด ACTIVE และเริ่มใช้เงินทันที'
        : 'โหมด PAUSED (รีวิว) — เมื่อถึงคิวจะสร้างแอดแบบยังไม่ใช้เงิน',
      'ระบบจะสร้างโพสต์เพจใหม่จากวิดีโอในระบบ แล้วสร้างแอดจากโพสต์ใหม่นั้น',
      '',
      `เพจ: ${selectedPage?.name || selectedId}`,
      `แคมเปญ: ${trimmedCampaignName || '(พาธ default ของ bridge)'}`,
      ...(isActive ? [`งบต่อวัน: ${dailyBudgetThb} บาท · รัน ~${runHours} ชม.`] : []),
      '',
      'ยืนยันเพิ่มเข้าคิว?',
    ]
    if (!window.confirm(lines.join('\n'))) return
    setAdResult(null)
    setQueueResult(null)
    enqueueMutation.mutate(selectedInput)
  }

  function copy(value: string) {
    if (!value) return
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopiedRef(value)
        setTimeout(() => setCopiedRef((cur) => (cur === value ? '' : cur)), 1600)
      })
      .catch(() => undefined)
  }

  return (
    <div className="space-y-6">
      {/* Detail header — back/"เปลี่ยนเพจ" affordance + page identity. Returns to
          the master page list, mirroring the Create Post detail screen. */}
      <div className="space-y-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-2 h-8 gap-1.5 px-2 text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          เปลี่ยนเพจ
        </Button>
        <div className="flex items-center gap-3">
          <img
            src={selectedPage.iconUrl || graphPageImageUrl(selectedPage.id)}
            alt={selectedPage.name || selectedPage.id}
            loading="lazy"
            className="h-12 w-12 shrink-0 rounded-full border bg-muted object-cover"
          />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {selectedPage.name || selectedPage.id}
            </h1>
            <p className="truncate font-mono text-xs text-muted-foreground">{selectedPage.id}</p>
          </div>
        </div>
      </div>

      {/* Contract guarantee — explicit, always visible on the detail screen. */}
      <div className="flex items-start gap-2 rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-semibold">โพสต์เก่าคือต้นแบบ/สัญญาณสำหรับเลือกคอนเทนต์ยอดดี</p>
          <p className="text-sky-800">
            เมื่อสร้างแอด ระบบจะเผยแพร่โพสต์เพจใหม่ด้วยวิดีโอเดียวกันจากระบบ แล้วใช้โพสต์ใหม่นั้นเป็นพื้นผิวแอด
          </p>
        </div>
      </div>

      {/* Step 1 — ad-relevant page defaults. */}
      <section className="space-y-3">
        <SectionLabel step={1} title="ค่าตั้งต้นแอดของเพจ" hint="ข้อมูลอ้างอิง ไม่ใช่การสร้างแอด" />
        <PageHealthCard pageId={selectedId} variant="ads" />
      </section>

      {/* Step 2 — per-page flow settings. */}
      <section className="space-y-3">
        <SectionLabel step={2} title="ตั้งค่า Flow ของเพจนี้" hint="กัน flow ใหม่ไม่ให้ทับเพจเดิม" />
        <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold">เลือกวิธีสร้างแอดต่อเพจ</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                ค่าเหล่านี้ผูกกับ page_id นี้เท่านั้น — flow ใหม่ default ปิดไว้ก่อน จนกว่าจะเปิดเอง
              </p>
            </div>
            <Button
              type="button"
              variant={flowEnabled ? 'default' : 'outline'}
              onClick={() => setFlowEnabled(!flowEnabled)}
              className="shrink-0"
            >
              {flowEnabled ? 'เปิดใช้ flow นี้' : 'ปิดอยู่ / ไม่ให้ cron ใช้'}
            </Button>
          </div>

          {pageSettingsQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">กำลังโหลดค่าตั้งต้นของเพจ…</p>
          ) : pageSettingsQuery.isError ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              โหลด settings ไม่สำเร็จ — ยังไม่ควรเปิด flow ใหม่
            </p>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Flow/Preset</span>
              <select
                value={flowKey}
                onChange={(e) => setFlowKey(e.target.value)}
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              >
                <option value="legacy_cron">Legacy Cron เดิม</option>
                <option value="focus_create_ad">Focus Create Ad</option>
                <option value="new_flow_disabled">Flow ใหม่ (staging / ปิดไว้ก่อน)</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Source strategy</span>
              <select
                value={sourceStrategy}
                onChange={(e) => setSourceStrategy(e.target.value)}
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              >
                <option value="page_posts">โพสต์เพจยอดดีของเพจนี้</option>
                <option value="gallery_ready">Gallery ready ของระบบ</option>
                <option value="manual_only">Manual เท่านั้น ไม่ให้ cron เลือกเอง</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">CTA strategy</span>
              <select
                value={ctaStrategy}
                onChange={(e) => setCtaStrategy(e.target.value)}
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              >
                <option value="source_then_story">Creative=sub จาก source, Story/Comment=sub จาก dark story</option>
                <option value="story_only_guarded">Story/Comment only (guarded)</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Comment</span>
              <select
                value={commentMode}
                onChange={(e) => setCommentMode(e.target.value)}
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              >
                <option value="template">ใช้ template ปกติ</option>
                <option value="off">ปิด comment สำหรับ flow นี้</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Ad account</span>
              <input
                value={draftAdAccount}
                onChange={(e) => setDraftAdAccount(e.target.value)}
                placeholder="act_..."
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Template adset</span>
              <input
                value={draftTemplateAdset}
                onChange={(e) => setDraftTemplateAdset(e.target.value)}
                placeholder="120..."
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">sub1 / campaign sub</span>
              <input
                value={draftSub1}
                onChange={(e) => setDraftSub1(e.target.value)}
                placeholder="เช่น 16JUN26FBSPCAD"
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <Button
              type="button"
              onClick={() => saveFlowMutation.mutate()}
              disabled={saveFlowMutation.isPending || pageSettingsQuery.isLoading}
            >
              {saveFlowMutation.isPending ? 'กำลังบันทึก…' : 'บันทึกค่า flow ของเพจนี้'}
            </Button>
            {saveFlowMutation.isSuccess ? (
              <span className="text-xs font-medium text-emerald-700">บันทึกแล้ว</span>
            ) : saveFlowMutation.isError ? (
              <span className="text-xs font-medium text-amber-700">
                บันทึกไม่ได้: {saveFlowMutation.error instanceof Error ? saveFlowMutation.error.message : 'unknown_error'}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                ค่า flow ใหม่ถูกเก็บแยกต่อเพจ — เฉียบจะไม่เปลี่ยนจนกว่าจะเปิด/บันทึกที่เพจเฉียบเอง
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Per-page Follow → Click Link automation. Independent per page; fail-closed (off by default). */}
      <section className="space-y-3">
        <SectionLabel
          step={2}
          title="ยิงแอดอัตโนมัติของเพจนี้ (Follow → Click Link)"
          hint="ตั้งค่าแยกต่อเพจ · ปิดไว้ก่อนเป็นค่าเริ่มต้น"
        />
        <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">ระบบจะสร้างแอด Follow ทุกๆ รอบที่ตั้งไว้</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                แต่ละแอด Follow จะรัน ~{(Number(autoRunHours) || 24)} ชม. แล้วระบบจะ <strong>ปิดแอด Follow</strong> นั้น
                และใช้คอนเทนต์เดิมสร้างแอด <strong>Click Link</strong> ใน Ad set ที่ตั้งไว้ — ค่าทั้งหมดผูกกับเพจนี้เท่านั้น
              </p>
            </div>
            <Button
              type="button"
              variant={autoEnabled ? 'default' : 'outline'}
              onClick={() => setAutoEnabled((v) => !v)}
              className="shrink-0"
            >
              {autoEnabled ? 'เปิดอัตโนมัติ (ใช้เงินจริง)' : 'ปิดอยู่ — ไม่ยิงอัตโนมัติ'}
            </Button>
          </div>

          {autoEnabled ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                เปิดอยู่ — ระบบจะสร้างแอด <strong>Follow แบบ ACTIVE และเริ่มใช้เงินทันที</strong> ตามรอบเวลาที่ตั้งไว้
                ต้องตั้ง Ad set ของ Click Link ให้เรียบร้อยก่อน มิฉะนั้นช่วงส่งต่อ (handoff) จะถูกข้าม
              </span>
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">รอบการสร้าง (นาที)</span>
              <select
                value={autoCadence || '30'}
                onChange={(e) => setAutoCadence(e.target.value)}
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              >
                <option value="30">ทุก 30 นาที</option>
                <option value="60">ทุก 1 ชั่วโมง</option>
                <option value="120">ทุก 2 ชั่วโมง</option>
                <option value="180">ทุก 3 ชั่วโมง</option>
                <option value="360">ทุก 6 ชั่วโมง</option>
                <option value="720">ทุก 12 ชั่วโมง</option>
                <option value="1440">ทุก 24 ชั่วโมง</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">จำนวนต่อวัน (0 = ไม่จำกัด)</span>
              <input
                type="number"
                min={0}
                max={200}
                value={autoMaxPerDay}
                onChange={(e) => setAutoMaxPerDay(e.target.value)}
                placeholder="0"
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">รันต่อแอด (ชั่วโมง) ก่อนส่งต่อ</span>
              <input
                type="number"
                min={1}
                max={720}
                value={autoRunHours}
                onChange={(e) => setAutoRunHours(e.target.value)}
                placeholder="24"
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Follow · Campaign ID</span>
              <input
                value={followCampaignId}
                onChange={(e) => setFollowCampaignId(e.target.value)}
                placeholder="120..."
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Follow · Ad set ID</span>
              <input
                value={followAdsetId}
                onChange={(e) => setFollowAdsetId(e.target.value)}
                placeholder="120..."
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
            <div className="hidden xl:block" />
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Click Link · Campaign ID</span>
              <input
                value={clickCampaignId}
                onChange={(e) => setClickCampaignId(e.target.value)}
                placeholder="120248151339120263"
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Click Link · Ad set ID</span>
              <input
                value={clickAdsetId}
                onChange={(e) => setClickAdsetId(e.target.value)}
                placeholder="120248981778190263"
                className="w-full rounded-lg border bg-background px-2.5 py-2 text-sm"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <Button
              type="button"
              onClick={() => saveAutomationMutation.mutate()}
              disabled={saveAutomationMutation.isPending || pageSettingsQuery.isLoading}
            >
              {saveAutomationMutation.isPending ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่าอัตโนมัติ'}
            </Button>
            {saveAutomationMutation.isSuccess ? (
              <span className="text-xs font-medium text-emerald-700">บันทึกแล้ว</span>
            ) : saveAutomationMutation.isError ? (
              <span className="text-xs font-medium text-amber-700">
                บันทึกไม่ได้: {saveAutomationMutation.error instanceof Error ? saveAutomationMutation.error.message : 'unknown_error'}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                Ad account / Template / sub1 ใช้ค่าจากกล่อง “ตั้งค่า Flow ของเพจนี้” ด้านบน — บันทึกแยกกันได้
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Step 3 — pick a high-performing source signal. */}
      <section className="space-y-3">
        <SectionLabel step={3} title="เลือกต้นแบบ/สัญญาณยอดดี" hint="โพสต์เก่าหรือวิดีโอระบบ" />
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
                <Button
                  type="button"
                  size="sm"
                  variant={view === 'page-post' ? 'default' : 'ghost'}
                  onClick={() => setView('page-post')}
                >
                  โพสต์เพจยอดดี ({postCandidates.length})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={view === 'gallery' ? 'default' : 'ghost'}
                  onClick={() => setView('gallery')}
                >
                  วิดีโอในระบบ ({galleryCandidates.length})
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void postsQuery.refetch()
                  void galleryQuery.refetch()
                }}
                disabled={refetching}
              >
                {refetching ? 'กำลังโหลด…' : 'รีเฟรช'}
              </Button>
            </div>

            {error ? (
              <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                โหลดข้อมูลไม่สำเร็จ: {error instanceof Error ? error.message : 'unknown error'}
                <div className="mt-1 text-xs text-muted-foreground">
                  หมายเหตุ: ต้องเข้าสู่ระบบแดชบอร์ดก่อนจึงจะดึงข้อมูลได้
                </div>
              </div>
            ) : null}

            {loading && active.length === 0 ? (
              <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="aspect-[9/16] animate-pulse rounded-xl bg-muted" />
                ))}
              </div>
            ) : active.length === 0 ? (
              <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                {view === 'page-post'
                  ? 'ยังไม่มีโพสต์เพจยอดดีสำหรับเพจนี้ — ลอง sync จากหน้าโพสต์เพจ'
                  : 'ยังไม่มีวิดีโอในระบบที่พร้อมใช้ — ลองโหลดเพิ่มจากหน้าแกลลี่'}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {active.map((item) => (
                  <CandidateCard
                    key={item.refId}
                    item={item}
                    selected={selectedInput?.refId === item.refId}
                    onSelect={(it) => {
                      setSelectedInput(it)
                      setAdResult(null)
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Step 4 — selected signal summary + create action. */}
          <section className="space-y-3">
            <SectionLabel step={4} title="สรุปต้นแบบและสร้างแอด" hint="สร้างโพสต์ใหม่ก่อนสร้างแอด" />
            {!selectedInput ? (
              <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                ยังไม่ได้เลือกต้นแบบ — เลือกการ์ดด้านบนหนึ่งใบเพื่อใช้เป็นสัญญาณคอนเทนต์
              </p>
            ) : (
              <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary">{selectedPage.name || selectedPage.id}</Badge>
                  <Badge variant="outline">
                    {selectedInput.kind === 'gallery' ? 'สัญญาณ: วิดีโอในระบบ' : 'สัญญาณ: โพสต์เพจยอดดี'}
                  </Badge>
                  <span className="min-w-0 truncate text-muted-foreground">{selectedInput.title}</span>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <CopyId
                    label="System Video ID"
                    value={selectedInput.systemVideoId}
                    copied={copiedRef === selectedInput.systemVideoId}
                    onCopy={copy}
                  />
                  <CopyId
                    label="Source Story ID"
                    value={selectedInput.storyId}
                    copied={copiedRef === selectedInput.storyId}
                    onCopy={copy}
                  />
                  <CopyId
                    label="Facebook Video ID"
                    value={selectedInput.fbVideoId}
                    copied={copiedRef === selectedInput.fbVideoId}
                    onCopy={copy}
                  />
                  <CopyId
                    label="Post ID"
                    value={selectedInput.postId}
                    copied={copiedRef === selectedInput.postId}
                    onCopy={copy}
                  />
                </div>

                {selectedInput.linkUrl ? (
                  <a
                    href={selectedInput.linkUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold underline"
                  >
                    เปิดต้นแบบ/สัญญาณ <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}

                {/* Ad settings — operator-controlled lifecycle, campaign date/name, budget and run
                    window. Default is the safe PAUSED review mode; the operator must deliberately
                    switch to the scheduled/active (spending) mode. */}
                <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-sm font-semibold">ตั้งค่าแอด</h3>
                    <span className="text-xs text-muted-foreground">โหมด งบ และเวลา</span>
                  </div>

                  {/* Mode — explicit PAUSED (review) vs ACTIVE (spends). */}
                  <div className="inline-flex items-center gap-1 rounded-lg bg-background p-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={mode === 'paused' ? 'default' : 'ghost'}
                      onClick={() => setMode('paused')}
                    >
                      PAUSED (รีวิว)
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={mode === 'active' ? 'default' : 'ghost'}
                      onClick={() => setMode('active')}
                    >
                      ตั้งเวลา/ใช้งานจริง
                    </Button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="space-y-1">
                      <span className="block text-xs font-medium text-muted-foreground">ชื่อแคมเปญ (วันที่)</span>
                      <input
                        type="text"
                        value={campaignName}
                        onChange={(e) => setCampaignName(e.target.value)}
                        placeholder="18/Jun/2026"
                        className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-xs font-medium text-muted-foreground">งบต่อวัน (บาท)</span>
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        value={dailyBudgetThb}
                        disabled={mode !== 'active'}
                        onChange={(e) => setDailyBudgetThb(Math.max(1, Math.round(Number(e.target.value) || 0)))}
                        className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm disabled:opacity-50"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="block text-xs font-medium text-muted-foreground">รัน (ชั่วโมง)</span>
                      <input
                        type="number"
                        min={1}
                        max={720}
                        value={runHours}
                        disabled={mode !== 'active'}
                        onChange={(e) => setRunHours(Math.max(1, Math.round(Number(e.target.value) || 0)))}
                        className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm disabled:opacity-50"
                      />
                    </label>
                  </div>

                  {mode === 'active' ? (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        โหมดนี้จะสร้างแอด <strong>ACTIVE</strong> และเริ่มใช้เงินทันที — เริ่มเมื่อยืนยัน, รัน ~{runHours} ชม.,
                        งบ {dailyBudgetThb} บาท/วัน, แคมเปญ “{trimmedCampaignName || '—'}”
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      แอดจะถูกสร้างแบบ <strong>PAUSED</strong> (ยังไม่ใช้เงิน) — งบ/เวลาใช้เมื่อเปิดใช้งานเองใน Ads Manager
                    </p>
                  )}

                  {/* Cadence — "สร้างทุก X นาที", like the old queue system. Used by the scheduler to
                      drain the Create Ads queue. */}
                  <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                    <label className="space-y-1">
                      <span className="block text-xs font-medium text-muted-foreground">รอบการสร้างจากคิว (สร้างทุก … นาที)</span>
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={intervalMinutes}
                        onChange={(e) => setIntervalDraft(Math.max(1, Math.min(1440, Math.round(Number(e.target.value) || 0))))}
                        className="w-28 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
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
                    <span className="text-[11px] text-muted-foreground">
                      ระบบจะหยิบงานในคิวมาสร้าง 1 งานทุกๆ {intervalMinutes} นาที — แยกจากการเผยแพร่หน้าเพจโดยสิ้นเชิง
                    </span>
                  </div>
                </div>

                {/* Create action. Calls ONLY createAdOnly() (POST /api/dashboard/create-ad-only)
                    — never the legacy mixed create-ad or the ad-queue endpoints. Disabled with the
                    exact reason when the input lacks a system video id. */}
                <div className="flex flex-wrap items-center gap-3 border-t pt-3">
                  <Button
                    type="button"
                    onClick={handleCreateAdOnly}
                    disabled={!adSourceReady || !settingsReady || createMutation.isPending || enqueueMutation.isPending}
                    title={adSourceReason || settingsReason || 'สร้างโพสต์ใหม่และแอดใหม่จากวิดีโอในระบบ'}
                  >
                    {createMutation.isPending
                      ? 'กำลังสร้างแอด…'
                      : mode === 'active'
                        ? 'สร้างเลย + เริ่มใช้เงิน'
                        : 'สร้างเลย (PAUSED)'}
                  </Button>
                  {/* Defer to the cadence queue — same Create Ads contract, created later by the
                      scheduler (สร้างทุก X นาที). */}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleEnqueueAdOnly}
                    disabled={!adSourceReady || !settingsReady || createMutation.isPending || enqueueMutation.isPending}
                    title={adSourceReason || settingsReason || `เพิ่มเข้าคิว — สร้างอัตโนมัติทุก ${intervalMinutes} นาที`}
                  >
                    {enqueueMutation.isPending ? 'กำลังเพิ่มเข้าคิว…' : `เพิ่มเข้าคิว (ทุก ${intervalMinutes} นาที)`}
                  </Button>
                  {adSourceReason ? (
                    <span className="text-xs text-amber-700">{adSourceReason}</span>
                  ) : settingsReason ? (
                    <span className="text-xs text-amber-700">{settingsReason}</span>
                  ) : !DASHBOARD_AD_CREATE_READY ? (
                    <span className="text-xs text-muted-foreground">
                      การสร้างแอดแบบแยกฝั่งยังไม่เปิดใช้งาน — กดเพื่อดูเหตุผลที่ชัดเจน
                      หรือคัดลอก ID ไปสร้างแอดในเครื่องมือภายนอก
                    </span>
                  ) : mode === 'active' ? (
                    <span className="text-xs text-amber-700">
                      สร้างโพสต์ใหม่และแอด <strong>ACTIVE</strong> — <strong>เริ่มใช้เงินทันที</strong>
                      ตามงบ/เวลาที่ตั้งไว้ หลังระบบสร้างโพสต์เพจใหม่
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      ระบบจะสร้างโพสต์เพจใหม่ แล้วสร้างแอดแบบ <strong>PAUSED</strong> (ยังไม่ใช้เงิน)
                      ต้องไปเปิดใช้งานเองใน Ads Manager
                    </span>
                  )}
                </div>

                {/* Result proof — the honest outcome of the Create Ads call. */}
                {adResult ? (
                  <div
                    className={`space-y-2 rounded-xl border px-4 py-3 text-sm ${
                      adResult.ok
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                        : 'border-amber-300 bg-amber-50 text-amber-900'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {adResult.ok ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                      {adResult.ok
                        ? `สร้างแอดสำเร็จ${adResult.ad_status ? ` (${adResult.ad_status})` : ''}`
                        : `ยังสร้างแอดไม่ได้: ${adResult.error || 'unknown_error'}`}
                    </div>
                    {adResult.ok && (adResult.ad_status === 'PAUSED' || adResult.paused) ? (
                      <p className="text-xs">แอดถูกสร้างแบบ PAUSED (ยังไม่ใช้เงิน) — เปิดใช้งานเองใน Ads Manager</p>
                    ) : adResult.ok && adResult.ad_status === 'ACTIVE' ? (
                      <p className="text-xs">
                        แอด <strong>ACTIVE</strong> — กำลังใช้เงินตามงบ/เวลาที่ตั้งไว้
                        {adResult.start_time ? ` • เริ่ม ${adResult.start_time}` : ''}
                        {adResult.end_time ? ` • สิ้นสุด ${adResult.end_time}` : ''}
                      </p>
                    ) : null}
                    {adResult.reason ? <p className="text-xs">{adResult.reason}</p> : null}
                    {adResult.detail ? <p className="text-xs">{adResult.detail}</p> : null}
                    {adResult.missing_bridge_fields && adResult.missing_bridge_fields.length > 0 ? (
                      <div className="text-xs">
                        <p className="font-semibold">สิ่งที่ bridge ยังขาด (ส่งให้ Hermes):</p>
                        <ul className="ml-4 list-disc">
                          {adResult.missing_bridge_fields.map((f, i) => (
                            <li key={i} className="font-mono">{f}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {adResult.ad_id || adResult.adset_id || adResult.effective_object_story_id ? (
                      <div className="grid gap-1 text-xs font-mono">
                        {adResult.ad_id ? <span>ad_id: {adResult.ad_id}</span> : null}
                        {adResult.adset_id ? <span>adset_id: {adResult.adset_id}</span> : null}
                        {adResult.campaign_id ? (
                          <span>campaign_id: {adResult.campaign_id}{adResult.campaign_status ? ` (${adResult.campaign_status})` : ''}</span>
                        ) : null}
                        {adResult.campaign_name ? <span>campaign: {adResult.campaign_name}</span> : null}
                        {adResult.daily_budget ? <span>daily_budget: {adResult.daily_budget} (หน่วยย่อย)</span> : null}
                        {adResult.new_story_id ? <span>new_story_id: {adResult.new_story_id}</span> : null}
                        {adResult.new_post_id ? <span>new_post_id: {adResult.new_post_id}</span> : null}
                        {adResult.effective_object_story_id ? (
                          <span>effective_object_story_id: {adResult.effective_object_story_id}</span>
                        ) : null}
                        {adResult.source_signal_system_video_id ? <span>source_signal_system_video_id: {adResult.source_signal_system_video_id}</span> : null}
                        {adResult.click_link ? <span>click_link: {adResult.click_link}</span> : null}
                      </div>
                    ) : null}
                    {typeof adResult.history_id === 'number' && adResult.history_id > 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        บันทึกในประวัติแอด #{adResult.history_id}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* Enqueue outcome — added to the cadence queue (or the reason it was refused). */}
                {queueResult ? (
                  <div
                    className={`space-y-1 rounded-xl border px-4 py-3 text-sm ${
                      queueResult.ok
                        ? 'border-sky-300 bg-sky-50 text-sky-900'
                        : 'border-amber-300 bg-amber-50 text-amber-900'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {queueResult.ok ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                      {queueResult.ok
                        ? `เพิ่มเข้าคิวแล้ว${queueResult.queue_id ? ` #${queueResult.queue_id}` : ''}`
                        : `เพิ่มเข้าคิวไม่ได้: ${queueResult.error || 'unknown_error'}`}
                    </div>
                    {queueResult.ok ? (
                      <p className="text-xs">
                        โหมด {queueResult.mode === 'active' ? 'ACTIVE (ใช้เงิน)' : 'PAUSED (รีวิว)'}
                        {typeof queueResult.queued_count === 'number' ? ` · ในคิว ${queueResult.queued_count} งาน` : ''}
                        {queueResult.next_run_at ? ` · รันถัดไป ${formatThaiDateTime(queueResult.next_run_at)}` : ''}
                        {' '}— <Link to="/queue" className="font-semibold underline">ดูคิวสร้างแอด</Link>
                      </p>
                    ) : queueResult.detail ? (
                      <p className="text-xs">{queueResult.detail}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}

            {/* Create Ads history proof panel — separate audit trail (dashboard_ad_history), never
                post_history. */}
            <div className="space-y-2 rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">ประวัติการสร้างแอด</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void historyQuery.refetch()}
                  disabled={historyQuery.isFetching}
                >
                  {historyQuery.isFetching ? 'กำลังโหลด…' : 'รีเฟรช'}
                </Button>
              </div>
              {historyQuery.isLoading ? (
                <p className="text-xs text-muted-foreground">กำลังโหลดประวัติ…</p>
              ) : (historyQuery.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">ยังไม่มีประวัติการสร้างแอดสำหรับเพจนี้</p>
              ) : (
                <div className="space-y-1.5">
                  {(historyQuery.data ?? []).map((h) => (
                    <div
                      key={h.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs"
                    >
                      <Badge variant={h.status === 'created' ? 'default' : 'outline'}>{h.status}</Badge>
                      {h.mode ? (
                        <Badge variant={h.mode === 'active' ? 'destructive' : 'secondary'}>
                          {h.mode === 'active' ? 'ACTIVE' : 'PAUSED'}
                        </Badge>
                      ) : null}
                      <span className="text-muted-foreground">{formatThaiDateTime(h.completed_at || h.created_at)}</span>
                      {h.campaign_name ? <span className="font-mono">camp: {h.campaign_name}</span> : null}
                      {h.daily_budget ? <span className="font-mono">งบ: {h.daily_budget}</span> : null}
                      {h.run_hours ? <span className="font-mono">{h.run_hours} ชม.</span> : null}
                      {h.source_story_id ? <span className="font-mono">source: {h.source_story_id}</span> : null}
                      {h.fb_video_id ? <span className="font-mono">fb: {h.fb_video_id}</span> : null}
                      {h.effective_object_story_id ? <span className="font-mono">new: {h.effective_object_story_id}</span> : null}
                      {h.ad_id ? <span className="font-mono">ad: {h.ad_id}</span> : null}
                      {h.error_message ? <span className="text-amber-700">{h.error_message}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
    </div>
  )
}
