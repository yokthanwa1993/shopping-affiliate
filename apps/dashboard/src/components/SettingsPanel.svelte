<script lang="ts">
  import { onMount } from 'svelte'
  import { fetchJson, formatThaiDateTime, WORKER_API_BASE } from '../lib/api'

  type ShortlinkProvider = 'api' | 'extension'

  type SettingsResponse = Record<string, string>

  type Settings = {
    subId: string
    subId2: string
    subId3: string
    subId4: string
    subId5: string
    shortlinkUrl: string
    shortlinkProvider: ShortlinkProvider
    commentTemplate: string
    defaultPage: string
    adAccount: string
    templateAdset: string
    templateAdsetFacebook: string
    templateAdsetInstagram: string
    campaignPrefix: string
    adsPerRound: string
    autoCreateTime: string
    facebookSyncToken: string
    facebookSyncTokenUpdatedAt: string
  }

  // Hard-coded to the default workspace (เฉียบ) because the V3 dashboard ships
  // single-page only — switching workspaces is not exposed here yet. The id is
  // the FB page id used by the worker's per-page settings store.
  const SELECTED_PAGE = {
    id: '1008898512617594',
    name: 'เฉียบ',
    slug: 'chearb',
    iconUrl: '/page-icons/chieb.jpg',
  }

  const EMPTY: Settings = {
    subId: '',
    subId2: '',
    subId3: '',
    subId4: '',
    subId5: '',
    shortlinkUrl: '',
    shortlinkProvider: 'api',
    commentTemplate: '',
    defaultPage: '',
    adAccount: '',
    templateAdset: '',
    templateAdsetFacebook: '',
    templateAdsetInstagram: '',
    campaignPrefix: '',
    adsPerRound: '',
    autoCreateTime: '',
    facebookSyncToken: '',
    facebookSyncTokenUpdatedAt: '',
  }

  let settings = $state<Settings>({ ...EMPTY })
  let loading = $state(true)
  let saving = $state(false)
  let message = $state<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)

  async function loadSettings() {
    loading = true
    message = null
    try {
      const data = await fetchJson<SettingsResponse>(
        `/api/dashboard/settings?page_id=${encodeURIComponent(SELECTED_PAGE.id)}`,
        { timeoutMs: 15000 },
      )
      settings = {
        ...EMPTY,
        subId: String(data.sub_id || ''),
        subId2: String(data.sub_id2 || ''),
        subId3: String(data.sub_id3 || ''),
        subId4: String(data.sub_id4 || ''),
        subId5: String(data.sub_id5 || ''),
        shortlinkUrl: String(data.shortlink_url || ''),
        shortlinkProvider: (String(data.shortlink_provider || '').toLowerCase() === 'extension'
          ? 'extension'
          : 'api') as ShortlinkProvider,
        commentTemplate: String(data.comment_template || ''),
        defaultPage: String(data.default_page || ''),
        adAccount: String(data.ad_account || ''),
        templateAdset: String(data.template_adset || ''),
        templateAdsetFacebook: String(data.template_adset_facebook || ''),
        templateAdsetInstagram: String(data.template_adset_instagram || ''),
        campaignPrefix: String(data.campaign_prefix || ''),
        adsPerRound: String(data.ads_per_round || ''),
        autoCreateTime: String(data.auto_create_time || ''),
        facebookSyncToken: String(data.facebook_sync_token || data.facebookSyncToken || ''),
        facebookSyncTokenUpdatedAt: String(data.facebookSyncTokenUpdatedAt || ''),
      }
    } catch (e) {
      message = {
        kind: 'error',
        text: `โหลด settings ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`,
      }
    } finally {
      loading = false
    }
  }

  async function saveSettings() {
    saving = true
    message = null
    try {
      const response = await fetch(
        `${WORKER_API_BASE}/api/dashboard/settings?page_id=${encodeURIComponent(SELECTED_PAGE.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            page_id: SELECTED_PAGE.id,
            sub_id: settings.subId,
            sub_id2: settings.subId2,
            sub_id3: settings.subId3,
            sub_id4: settings.subId4,
            sub_id5: settings.subId5,
            shortlink_url: settings.shortlinkUrl,
            shortlink_provider: settings.shortlinkProvider,
            comment_template: settings.commentTemplate,
            default_page: settings.defaultPage,
            ad_account: settings.adAccount,
            template_adset: settings.templateAdset,
            template_adset_facebook: settings.templateAdsetFacebook,
            template_adset_instagram: settings.templateAdsetInstagram,
            campaign_prefix: settings.campaignPrefix,
            ads_per_round: settings.adsPerRound,
            auto_create_time: settings.autoCreateTime,
            facebook_sync_token: settings.facebookSyncToken,
          }),
        },
      )
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      message = { kind: 'success', text: 'บันทึกแล้ว' }
      await loadSettings()
    } catch (e) {
      message = {
        kind: 'error',
        text: `บันทึก settings ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`,
      }
    } finally {
      saving = false
    }
  }

  onMount(loadSettings)
</script>

<div class="space-y-4">
  <div class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
    <img
      src={SELECTED_PAGE.iconUrl}
      alt={SELECTED_PAGE.name}
      class="h-10 w-10 shrink-0 rounded-xl object-cover ring-1 ring-slate-200"
      onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
    />
    <div class="min-w-0 flex-1">
      <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">การตั้งค่าของเพจ</p>
      <p class="truncate text-sm font-semibold text-slate-900">
        เพจ {SELECTED_PAGE.name}
        <span class="ml-2 rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-500">
          /{SELECTED_PAGE.slug}
        </span>
      </p>
    </div>
    <p class="hidden text-[11px] text-slate-400 sm:block">การตั้งค่านี้ใช้กับเพจนี้เท่านั้น</p>
  </div>

  {#if message}
    <div
      class="rounded-2xl border px-4 py-3 text-sm
        {message.kind === 'error'
          ? 'border-rose-200 bg-rose-50 text-rose-700'
          : message.kind === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-slate-200 bg-slate-50 text-slate-700'}"
    >
      {message.text}
    </div>
  {/if}

  <div class="grid gap-4 xl:grid-cols-[0.95fr,1.05fr]">
    <section class="rounded-3xl border border-slate-200 bg-white p-5">
      <header class="mb-4">
        <h2 class="text-base font-semibold text-slate-900">Shortlink / Comment</h2>
        <p class="mt-0.5 text-xs text-slate-500">ค่าหลักที่ระบบสร้างแอดจะใช้</p>
      </header>

      <div class="grid gap-4">
        <label class="block">
          <span class="block text-xs font-semibold text-slate-600">Sub ID 1</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 1</span>
          <input bind:value={settings.subId} disabled={loading} class="field-input" placeholder="เช่น yok" />
        </label>
        <label class="block">
          <span class="block text-xs font-semibold text-slate-600">Sub ID 2</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 2</span>
          <input bind:value={settings.subId2} disabled={loading} class="field-input" />
        </label>
        <label class="block">
          <span class="block text-xs font-semibold text-slate-600">Sub ID 3</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 3</span>
          <input bind:value={settings.subId3} disabled={loading} class="field-input" />
        </label>
        <label class="block">
          <span class="block text-xs font-semibold text-slate-600">Sub ID 4</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 4</span>
          <input bind:value={settings.subId4} disabled={loading} class="field-input" />
        </label>
        <label class="block">
          <span class="block text-xs font-semibold text-slate-600">Sub ID 5</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 5</span>
          <input bind:value={settings.subId5} disabled={loading} class="field-input" />
        </label>

        <div>
          <span class="block text-xs font-semibold text-slate-600">ย่อลิงก์ผ่าน</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">
            API = call short.wwoom.com · Extension = ย่อผ่าน tab affiliate.shopee.co.th (ต้องเปิด tab ค้างไว้)
          </span>
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => (settings.shortlinkProvider = 'api')}
              class="rounded-xl border px-3 py-2.5 text-sm font-semibold transition
                {settings.shortlinkProvider === 'api'
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}"
            >
              <span class="block">API</span>
              <span class="block text-[10px] font-normal opacity-70">short.wwoom.com</span>
            </button>
            <button
              type="button"
              onclick={() => (settings.shortlinkProvider = 'extension')}
              class="rounded-xl border px-3 py-2.5 text-sm font-semibold transition
                {settings.shortlinkProvider === 'extension'
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}"
            >
              <span class="block">Extension</span>
              <span class="block text-[10px] font-normal opacity-70">Shopee Affiliate tab</span>
            </button>
          </div>
        </div>

        {#if settings.shortlinkProvider === 'api'}
          <label class="block">
            <span class="block text-xs font-semibold text-slate-600">Shortlink URL</span>
            <span class="mb-1.5 block text-[11px] text-slate-400">
              รูปแบบ https://short.wwoom.com/?account=CHEARB&amp;url=&#123;url&#125;&amp;sub1=&#123;sub_id&#125;
            </span>
            <textarea
              bind:value={settings.shortlinkUrl}
              disabled={loading}
              rows="3"
              class="field-input resize-none"
            ></textarea>
          </label>
        {:else}
          <div class="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-[11px] text-blue-700">
            🟦 โหมด Extension — ใช้ <code class="rounded bg-white px-1">affiliate.shopee.co.th</code> ตรงๆ ไม่ต้องตั้ง URL template
          </div>
        {/if}

        <label class="block">
          <span class="block text-xs font-semibold text-slate-600">เทมเพลตตอบคอมเมนต์</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">ใช้ &#123;shopee_link&#125; เป็น placeholder</span>
          <textarea
            bind:value={settings.commentTemplate}
            disabled={loading}
            rows="3"
            class="field-input resize-none"
          ></textarea>
        </label>

        <label class="block">
          <span class="block text-xs font-semibold text-slate-600">Facebook Sync Token</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">
            ใช้ token นี้สำหรับ sync โพสต์เข้า D1 เท่านั้น ไม่ผ่าน Electron
          </span>
          <textarea
            bind:value={settings.facebookSyncToken}
            disabled={loading}
            rows="6"
            class="field-input resize-none font-mono text-xs"
            placeholder="วาง Facebook access token"
          ></textarea>
          <div class="mt-2 text-xs text-slate-400">
            {#if loading}
              กำลังโหลด token...
            {:else if settings.facebookSyncTokenUpdatedAt}
              อัปเดตล่าสุด {formatThaiDateTime(settings.facebookSyncTokenUpdatedAt)}
            {:else}
              ยังไม่ได้บันทึก token
            {/if}
          </div>
        </label>
      </div>
    </section>

    <section class="rounded-3xl border border-slate-200 bg-white p-5">
      <header class="mb-4">
        <h2 class="text-base font-semibold text-slate-900">Facebook / Scheduling</h2>
        <p class="mt-0.5 text-xs text-slate-500">ค่า default จากสเปกปัจจุบัน</p>
      </header>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block">
          <span class="mb-1.5 block text-xs font-semibold text-slate-600">Default Page</span>
          <input bind:value={settings.defaultPage} disabled={loading} class="field-input" />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-semibold text-slate-600">Ad Account</span>
          <input bind:value={settings.adAccount} disabled={loading} class="field-input" />
        </label>
        <label class="block sm:col-span-2">
          <span class="block text-xs font-semibold text-slate-600">Template FB & IG Story</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">ใช้กับตัวเลือก FB & IG Story ในหน้าสร้างแอด</span>
          <input bind:value={settings.templateAdset} disabled={loading} class="field-input" />
        </label>
        <label class="block sm:col-span-2">
          <span class="block text-xs font-semibold text-slate-600">Template Facebook only</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">ใช้กับแคมเปญ/ชุดโฆษณา Facebook placements</span>
          <input bind:value={settings.templateAdsetFacebook} disabled={loading} class="field-input" />
        </label>
        <label class="block sm:col-span-2">
          <span class="block text-xs font-semibold text-slate-600">Template Instagram only</span>
          <span class="mb-1.5 block text-[11px] text-slate-400">ใช้กับแคมเปญ/ชุดโฆษณา Instagram Stories/Reels</span>
          <input bind:value={settings.templateAdsetInstagram} disabled={loading} class="field-input" />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-semibold text-slate-600">Campaign Prefix</span>
          <input bind:value={settings.campaignPrefix} disabled={loading} class="field-input" />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-semibold text-slate-600">จำนวนแอดต่อรอบ</span>
          <input bind:value={settings.adsPerRound} disabled={loading} class="field-input" />
        </label>
        <label class="block sm:col-span-2">
          <span class="mb-1.5 block text-xs font-semibold text-slate-600">เวลาสร้างแอดอัตโนมัติ</span>
          <input bind:value={settings.autoCreateTime} disabled={loading} class="field-input" />
        </label>
      </div>

      <button
        type="button"
        onclick={saveSettings}
        disabled={saving || loading}
        class="mt-5 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? 'กำลังบันทึก...' : `บันทึกตั้งค่าของเพจ ${SELECTED_PAGE.name}`}
      </button>
    </section>
  </div>
</div>
