<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { PageSettings } from '../../lib/settingsApi'

  let {
    settings,
    disabled = false,
    loading = false,
    children,
  }: {
    /** Shared $state proxy owned by SettingsShell — fields are bound in place. */
    settings: PageSettings
    disabled?: boolean
    loading?: boolean
    children?: Snippet
  } = $props()
</script>

<section class="rounded-3xl border border-slate-200 bg-white p-5">
  <header class="mb-4">
    <h2 class="text-base font-semibold text-slate-900">Facebook / Scheduling</h2>
    <p class="mt-0.5 text-xs text-slate-500">ค่า default จากสเปกปัจจุบัน</p>
  </header>

  <div class="grid gap-4 sm:grid-cols-2">
    <label class="block">
      <span class="mb-1.5 block text-xs font-semibold text-slate-600">Default Page</span>
      <input bind:value={settings.defaultPage} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-xs font-semibold text-slate-600">Ad Account</span>
      <input bind:value={settings.adAccount} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block sm:col-span-2">
      <span class="block text-xs font-semibold text-slate-600">Template FB & IG Story</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">ใช้กับตัวเลือก FB & IG Story ในหน้าสร้างแอด</span>
      <input bind:value={settings.templateAdset} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block sm:col-span-2">
      <span class="block text-xs font-semibold text-slate-600">Template Facebook only</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">ใช้กับแคมเปญ/ชุดโฆษณา Facebook placements</span>
      <input bind:value={settings.templateAdsetFacebook} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block sm:col-span-2">
      <span class="block text-xs font-semibold text-slate-600">Template Instagram only</span>
      <span class="mb-1.5 block text-[11px] text-slate-400">ใช้กับแคมเปญ/ชุดโฆษณา Instagram Stories/Reels</span>
      <input bind:value={settings.templateAdsetInstagram} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-xs font-semibold text-slate-600">Campaign Prefix</span>
      <input bind:value={settings.campaignPrefix} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-xs font-semibold text-slate-600">จำนวนแอดต่อรอบ</span>
      <input bind:value={settings.adsPerRound} disabled={disabled || loading} class="field-input" />
    </label>
    <label class="block sm:col-span-2">
      <span class="mb-1.5 block text-xs font-semibold text-slate-600">เวลาสร้างแอดอัตโนมัติ</span>
      <input bind:value={settings.autoCreateTime} disabled={disabled || loading} class="field-input" />
    </label>
  </div>

  {@render children?.()}
</section>
