<script lang="ts">
  type AffiliateOption = {
    id: string
    account: string
    label: string
    alias: string
    note: string
  }

  type ShortenResponse = {
    ok?: boolean
    status?: string
    shortLink?: string
    longLink?: string
    original?: string
    error?: string
    message?: string
    details?: unknown
    upstreamStatus?: number
  }

  const AFFILIATES: AffiliateOption[] = [
    {
      id: '15130770000',
      account: 'CHEARB',
      label: 'CHEARB',
      alias: 'an_15130770000',
      note: 'เฉียบ / CHEARB',
    },
    {
      id: '15142270000',
      account: 'NEEZS',
      label: 'NEEZS',
      alias: 'an_15142270000',
      note: 'NEEZS',
    },
  ]
  const DEFAULT_AFFILIATE = AFFILIATES[0] as AffiliateOption

  let productUrl = $state('')
  let affiliateId = $state(DEFAULT_AFFILIATE.id)
  let sub1 = $state('')
  let sub2 = $state('')
  let sub3 = $state('')
  let sub4 = $state('')
  let sub5 = $state('')
  let loading = $state(false)
  let result = $state<ShortenResponse | null>(null)
  let error = $state('')
  let copied = $state(false)

  function selectedAffiliate(): AffiliateOption {
    return AFFILIATES.find((item) => item.id === affiliateId) ?? DEFAULT_AFFILIATE
  }

  function useAffiliate(option: AffiliateOption) {
    affiliateId = option.id
  }

  function responseMessage(data: ShortenResponse, fallback: string): string {
    if (data.status === 'manual_login_required' || data.error === 'manual_login_required') {
      return 'Custom Link API ต้อง login Shopee Affiliate ใหม่ก่อน แล้วค่อยลองสร้างลิงก์อีกครั้ง'
    }
    return data.message || data.error || fallback
  }

  async function submit(event: Event) {
    event.preventDefault()
    if (loading) return

    loading = true
    error = ''
    result = null
    copied = false

    const affiliate = selectedAffiliate()
    // Built-in affiliate presets use `id` as the single source of truth.
    // Upstream maps the id to the correct Shopee account, so we must NOT send
    // the UI label (CHEARB/NEEZS) as `account` — doing so triggers
    // shopee_affiliate_account_conflict upstream.
    const payload = {
      id: affiliate.id,
      url: productUrl.trim(),
      sub1: sub1.trim(),
      sub2: sub2.trim(),
      sub3: sub3.trim(),
      sub4: sub4.trim(),
      sub5: sub5.trim(),
    }

    try {
      const response = await fetch('/dashboard/api/custom-link/shorten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      })
      const text = await response.text()
      let data: ShortenResponse = {}
      if (text) {
        try {
          data = JSON.parse(text) as ShortenResponse
        } catch {
          data = { status: 'error', error: `HTTP ${response.status} response_not_json` }
        }
      }

      result = data
      if (!response.ok || data.status !== 'ok' || !data.shortLink) {
        throw new Error(responseMessage(data, `HTTP ${response.status} ${response.statusText}`))
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function copyShortLink() {
    if (!result?.shortLink) return
    try {
      await navigator.clipboard.writeText(result.shortLink)
      copied = true
      setTimeout(() => {
        copied = false
      }, 1600)
    } catch {
      error = 'คัดลอกไม่สำเร็จ'
    }
  }
</script>

<div class="space-y-4">
  <section class="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.04)]">
    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">Shopee Affiliate</p>
        <h1 class="mt-1 text-xl font-semibold text-slate-900">Custom Link</h1>
        <p class="mt-1 text-sm text-slate-500">Mint short links with campaign Sub IDs.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        {#each AFFILIATES as option (option.id)}
          {@const active = option.id === affiliateId}
          <button
            type="button"
            onclick={() => useAffiliate(option)}
            class="rounded-xl border px-3 py-2 text-left transition
              {active
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'}"
          >
            <span class="block text-xs font-bold">{option.label}</span>
            <span class="block font-mono text-[10px] opacity-70">{option.alias}</span>
          </button>
        {/each}
      </div>
    </div>

    <form class="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]" onsubmit={(e) => void submit(e)}>
      <div class="space-y-4">
        <label class="block">
          <span class="block text-xs font-semibold text-slate-600">Product URL</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">Shopee product URL · required</span>
          <input
            bind:value={productUrl}
            required
            type="url"
            class="field-input"
            placeholder="https://shopee.co.th/..."
          />
        </label>

        <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)]">
          <label class="block">
            <span class="block text-xs font-semibold text-slate-600">Affiliate ID</span>
            <span class="mb-1.5 block text-[11px] text-slate-400">{selectedAffiliate().note}</span>
            <select bind:value={affiliateId} class="field-input">
              {#each AFFILIATES as option (option.id)}
                <option value={option.id}>{option.label} · {option.id}</option>
              {/each}
            </select>
          </label>
          <div class="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Alias</p>
            <p class="mt-1 truncate font-mono text-sm font-semibold text-slate-900">{selectedAffiliate().alias}</p>
            <p class="mt-1 truncate text-[11px] text-slate-500">{selectedAffiliate().account}</p>
          </div>
        </div>

        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label class="block">
            <span class="block text-xs font-semibold text-slate-600">Sub 1</span>
            <span class="mb-1.5 block text-[11px] text-slate-400">campaign</span>
            <input bind:value={sub1} class="field-input" placeholder="1JUN26FBSPCAD" />
          </label>
          <label class="block">
            <span class="block text-xs font-semibold text-slate-600">Sub 2</span>
            <span class="mb-1.5 block text-[11px] text-slate-400">post / video id</span>
            <input bind:value={sub2} class="field-input" />
          </label>
          <label class="block">
            <span class="block text-xs font-semibold text-slate-600">Sub 3</span>
            <span class="mb-1.5 block text-[11px] text-slate-400">page id</span>
            <input bind:value={sub3} class="field-input" />
          </label>
          <label class="block">
            <span class="block text-xs font-semibold text-slate-600">Sub 4</span>
            <span class="mb-1.5 block text-[11px] text-slate-400">optional</span>
            <input bind:value={sub4} class="field-input" />
          </label>
          <label class="block">
            <span class="block text-xs font-semibold text-slate-600">Sub 5</span>
            <span class="mb-1.5 block text-[11px] text-slate-400">optional</span>
            <input bind:value={sub5} class="field-input" />
          </label>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={loading}
            class="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'กำลังสร้าง...' : 'สร้าง Short Link'}
          </button>
          <button
            type="button"
            onclick={() => {
              productUrl = ''
              sub1 = ''
              sub2 = ''
              sub3 = ''
              sub4 = ''
              sub5 = ''
              result = null
              error = ''
            }}
            class="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Clear
          </button>
        </div>
      </div>

      <aside class="space-y-3">
        {#if error}
          <div class="rounded-3xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        {/if}

        {#if result?.shortLink}
          <div class="rounded-3xl border border-emerald-200 bg-emerald-50 p-4">
            <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">Short Link</p>
            <div class="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <a
                href={result.shortLink}
                target="_blank"
                rel="noreferrer"
                class="min-w-0 flex-1 break-all rounded-2xl border border-emerald-200 bg-white px-3 py-2 font-mono text-sm font-semibold text-emerald-900"
              >
                {result.shortLink}
              </a>
              <button
                type="button"
                onclick={() => void copyShortLink()}
                class="shrink-0 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {#if result.longLink || result.original}
              <div class="mt-3 rounded-2xl border border-emerald-200 bg-white px-3 py-2 text-xs text-emerald-900">
                {#if result.longLink}
                  <p class="break-all"><span class="font-semibold">Long:</span> {result.longLink}</p>
                {/if}
                {#if result.original}
                  <p class="break-all"><span class="font-semibold">Original:</span> {result.original}</p>
                {/if}
              </div>
            {/if}
          </div>
        {:else}
          <div class="rounded-3xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
            Result will appear here after submit.
          </div>
        {/if}

        {#if result}
          <details class="rounded-3xl border border-slate-200 bg-white p-4">
            <summary class="cursor-pointer text-sm font-semibold text-slate-700">JSON details</summary>
            <pre class="mt-3 max-h-96 overflow-auto rounded-2xl bg-slate-950 p-3 text-xs leading-5 text-slate-100">{JSON.stringify(result, null, 2)}</pre>
          </details>
        {/if}
      </aside>
    </form>
  </section>
</div>
