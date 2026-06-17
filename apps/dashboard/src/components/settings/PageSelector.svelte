<script lang="ts">
  import type { SettingsPage } from '../../lib/settingsApi'

  let {
    pages,
    selectedId,
    loading = false,
    fallback = false,
    onSelect,
  }: {
    pages: SettingsPage[]
    selectedId: string
    loading?: boolean
    fallback?: boolean
    onSelect: (page: SettingsPage) => void
  } = $props()
</script>

<div class="rounded-2xl border border-slate-200 bg-white px-4 py-3">
  <div class="mb-2 flex items-center justify-between gap-2">
    <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">เลือกเพจ / Workspace</p>
    {#if fallback}
      <span class="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
        โหลดรายชื่อเพจไม่สำเร็จ — แสดงเฉพาะเพจหลัก
      </span>
    {/if}
  </div>

  {#if loading}
    <div class="flex gap-2">
      {#each Array(3) as _}
        <div class="h-12 w-40 animate-pulse rounded-xl bg-slate-100"></div>
      {/each}
    </div>
  {:else if pages.length === 0}
    <p class="text-sm text-slate-500">ไม่พบเพจใน workspace นี้</p>
  {:else}
    <div class="scrollbar-thin flex gap-2 overflow-x-auto pb-1">
      {#each pages as page (page.id)}
        {@const isSelected = page.id === selectedId}
        <button
          type="button"
          onclick={() => onSelect(page)}
          aria-pressed={isSelected}
          class="flex shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition
            {isSelected
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'}"
        >
          {#if page.iconUrl}
            <img
              src={page.iconUrl}
              alt=""
              loading="lazy"
              class="h-8 w-8 shrink-0 rounded-lg object-cover ring-1 {isSelected ? 'ring-white/20' : 'ring-slate-200'}"
              onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
            />
          {/if}
          <span class="min-w-0">
            <span class="block max-w-[10rem] truncate text-sm font-semibold">{page.name || page.id}</span>
            <span class="flex items-center gap-1.5 text-[10px] {isSelected ? 'text-white/70' : 'text-slate-400'}">
              {#if page.active}
                <span>● Active</span>
              {:else}
                <span>○ Inactive</span>
              {/if}
              {#if page.hasToken}
                <span>· Token ✓</span>
              {/if}
            </span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
