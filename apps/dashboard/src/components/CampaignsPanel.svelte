<script lang="ts">
  import { onMount } from 'svelte'
  import { fetchJson, DEFAULT_AD_ACCOUNT, DEFAULT_PAGE } from '../lib/api'

  type AdSet = {
    id: string
    name: string
    status: string
  }
  type Campaign = {
    id: string
    name: string
    status: string
    dailyBudget: string
    startTime: string
    adsetCount: number
    activeAdsetCount: number
    adsets: AdSet[]
    reach: string
    impressions: string
    spend: string
    costPerLinkClick: string
  }

  let campaigns = $state<Campaign[]>([])
  let loading = $state(true)
  let error = $state('')
  let adAccount = $state(DEFAULT_AD_ACCOUNT)
  let updatedAt = $state('')

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }
  function safeString(v: unknown): string {
    if (typeof v === 'string') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return ''
  }
  function safeNumber(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return 0
  }
  function normalizeAdSet(raw: unknown): AdSet | null {
    if (!isRecord(raw)) return null
    return {
      id: safeString(raw.id),
      name: safeString(raw.name),
      status: safeString(raw.status),
    }
  }
  function normalize(raw: unknown): Campaign | null {
    if (!isRecord(raw)) return null
    const id = safeString(raw.id)
    if (!id) return null
    const adsets = Array.isArray(raw.adsets) ? raw.adsets.map(normalizeAdSet).filter((a): a is AdSet => a !== null) : []
    return {
      id,
      name: safeString(raw.name),
      status: safeString(raw.status),
      dailyBudget: safeString(raw.dailyBudget ?? raw.daily_budget),
      startTime: safeString(raw.startTime ?? raw.start_time),
      adsetCount: safeNumber(raw.adsetCount ?? raw.adset_count),
      activeAdsetCount: safeNumber(raw.activeAdsetCount ?? raw.active_adset_count),
      adsets,
      reach: safeString(raw.reach),
      impressions: safeString(raw.impressions),
      spend: safeString(raw.spend),
      costPerLinkClick: safeString(raw.costPerLinkClick ?? raw.cost_per_link_click),
    }
  }

  async function loadSettings() {
    try {
      const data = await fetchJson<Record<string, string>>(
        `/api/dashboard/settings?page_id=${encodeURIComponent(DEFAULT_PAGE.id)}`,
        { timeoutMs: 15000 },
      )
      const acct = safeString(data.ad_account)
      if (acct) adAccount = acct
    } catch {
      // keep default ad account
    }
  }

  async function load() {
    loading = true
    error = ''
    try {
      const data = await fetchJson<{ campaigns?: unknown[] }>(
        `/api/dashboard/campaigns?ad_account=${encodeURIComponent(adAccount)}`,
        { timeoutMs: 30000 },
      )
      const list = Array.isArray(data.campaigns) ? data.campaigns : []
      campaigns = list.map(normalize).filter((c): c is Campaign => c !== null)
      updatedAt = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  function statusColor(status: string): string {
    if (status === 'ACTIVE') return 'bg-emerald-50 text-emerald-700'
    if (status === 'PAUSED') return 'bg-amber-50 text-amber-700'
    return 'bg-slate-100 text-slate-500'
  }

  function dailyBudgetThb(value: string): string {
    const n = safeNumber(value)
    if (!n) return '—'
    return `฿${(n / 100).toLocaleString()}`
  }

  function adsManagerUrl(campaignId: string): string {
    const acct = adAccount.replace(/^act_/, '')
    return `https://www.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(acct)}&campaign_ids=${encodeURIComponent(campaignId)}`
  }

  onMount(async () => {
    await loadSettings()
    await load()
  })
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Campaigns</p>
      <p class="mt-0.5 text-xs text-slate-600">
        Real-time จาก Facebook Ads Manager · <span class="font-mono">{adAccount}</span>
      </p>
    </div>
    <div class="flex items-center gap-3 text-xs text-slate-500">
      {#if updatedAt}<span>อัปเดต {updatedAt}</span>{/if}
      <button
        type="button"
        onclick={() => void load()}
        disabled={loading}
        class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {loading ? 'กำลังโหลด…' : 'รีเฟรช'}
      </button>
    </div>
  </div>

  {#if error}
    <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      โหลด campaigns ไม่สำเร็จ: {error}
    </div>
  {/if}

  {#if loading && campaigns.length === 0}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="h-32 animate-pulse rounded-3xl bg-slate-100"></div>
      {/each}
    </div>
  {:else if campaigns.length === 0}
    <div class="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500">
      ไม่มีแคมเปญใน ad account นี้
    </div>
  {:else}
    <div class="space-y-3">
      {#each campaigns as camp (camp.id)}
        <article class="rounded-3xl border border-slate-200 bg-white p-4">
          <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <div>
                  <p class="text-base font-semibold text-slate-950">{camp.name}</p>
                  <p class="text-[11px] text-slate-400">ID: {camp.id}</p>
                </div>
                <span class="rounded-full px-2.5 py-1 text-[11px] font-bold {statusColor(camp.status)}">
                  {camp.status || 'UNKNOWN'}
                </span>
              </div>
              <p class="mt-2 text-sm text-slate-500">
                {camp.activeAdsetCount} active adsets / {camp.adsetCount} total · Budget {dailyBudgetThb(camp.dailyBudget)}/day
              </p>
            </div>
            <div class="grid grid-cols-3 gap-2">
              <div class="rounded-2xl bg-slate-50 px-3 py-2 text-center">
                <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Reach</p>
                <p class="mt-0.5 text-sm font-bold text-slate-900">{safeNumber(camp.reach).toLocaleString()}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-3 py-2 text-center">
                <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Impressions</p>
                <p class="mt-0.5 text-sm font-bold text-slate-900">{safeNumber(camp.impressions).toLocaleString()}</p>
              </div>
              <div class="rounded-2xl bg-slate-50 px-3 py-2 text-center">
                <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Spend</p>
                <p class="mt-0.5 text-sm font-bold text-slate-900">฿{safeNumber(camp.spend).toLocaleString()}</p>
              </div>
            </div>
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <a
              href={adsManagerUrl(camp.id)}
              target="_blank"
              rel="noreferrer"
              class="rounded-xl bg-[#1877f2] px-3 py-2 text-xs font-semibold text-white hover:bg-[#166fe0]"
            >
              เปิดใน Ads Manager
            </a>
            {#if camp.adsets.length > 0}
              <span class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Ad sets: {camp.adsets.map((a) => a.name).join(' · ')}
              </span>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
