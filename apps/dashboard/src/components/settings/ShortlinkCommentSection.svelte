<script lang="ts">
  import { formatThaiDateTime } from '../../lib/api'
  import type { PageSettings } from '../../lib/settingsApi'

  let {
    settings,
    disabled = false,
    loading = false,
    maskSecrets = false,
    syncTokenPresent = false,
  }: {
    /** Shared $state proxy owned by SettingsShell — fields are bound in place. */
    settings: PageSettings
    disabled?: boolean
    loading?: boolean
    /**
     * Read-only mode for non-default pages: secret values are never rendered,
     * only present/updated_at status (migration plan rule — no raw tokens).
     */
    maskSecrets?: boolean
    syncTokenPresent?: boolean
  } = $props()
</script>

<section class="rounded-3xl border border-slate-200 bg-white p-5">
  <header class="mb-4">
    <h2 class="text-base font-semibold text-slate-900">Shortlink / Comment</h2>
    <p class="mt-0.5 text-xs text-slate-500">ค่าหลักที่ระบบสร้างแอดจะใช้</p>
  </header>

  <div class="grid gap-4">
    <label class="block">
      <span class="block text-xs font-semibold text-slate-600">Sub ID 1</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 1</span>
      <input bind:value={settings.subId} disabled={disabled || loading} class="field-input" placeholder="เช่น yok" />
    </label>
    <label class="block">
      <span class="block text-xs font-semibold text-slate-600">Sub ID 2</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 2</span>
      <input bind:value={settings.subId2} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block">
      <span class="block text-xs font-semibold text-slate-600">Sub ID 3</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 3</span>
      <input bind:value={settings.subId3} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block">
      <span class="block text-xs font-semibold text-slate-600">Sub ID 4</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 4</span>
      <input bind:value={settings.subId4} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block">
      <span class="block text-xs font-semibold text-slate-600">Sub ID 5</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">utm_content ตัวที่ 5</span>
      <input bind:value={settings.subId5} disabled={disabled || loading} class="field-input" />
    </label>

    <div>
      <span class="block text-xs font-semibold text-slate-600">ย่อลิงก์ผ่าน</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">
        API = call short.wwoom.com · Extension = ย่อผ่าน tab affiliate.shopee.co.th (ต้องเปิด tab ค้างไว้)
      </span>
      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled || loading}
          onclick={() => (settings.shortlinkProvider = 'api')}
          class="rounded-xl border px-3 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60
            {settings.shortlinkProvider === 'api'
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}"
        >
          <span class="block">API</span>
          <span class="block text-[10px] font-normal opacity-70">short.wwoom.com</span>
        </button>
        <button
          type="button"
          disabled={disabled || loading}
          onclick={() => (settings.shortlinkProvider = 'extension')}
          class="rounded-xl border px-3 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60
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
          disabled={disabled || loading}
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
        disabled={disabled || loading}
        rows="3"
        class="field-input resize-none"
      ></textarea>
    </label>

    <div class="block">
      <span class="block text-xs font-semibold text-slate-600">Facebook Sync Token</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">
        ใช้ token นี้สำหรับ sync โพสต์เข้า D1 เท่านั้น ไม่ผ่าน Electron
      </span>
      {#if maskSecrets}
        <!-- Read-only page view: never render the raw token, status only. -->
        <div class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
          {#if loading}
            กำลังตรวจสอบ token...
          {:else if syncTokenPresent}
            🔒 มี token บันทึกไว้ (ค่า token ไม่แสดงในโหมดดูอย่างเดียว)
            {#if settings.facebookSyncTokenUpdatedAt}
              · อัปเดตล่าสุด {formatThaiDateTime(settings.facebookSyncTokenUpdatedAt)}
            {/if}
          {:else}
            ยังไม่ได้บันทึก token สำหรับเพจนี้
          {/if}
        </div>
      {:else}
        <textarea
          bind:value={settings.facebookSyncToken}
          disabled={disabled || loading}
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
      {/if}
    </div>
  </div>
</section>
