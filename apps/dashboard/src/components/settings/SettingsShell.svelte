<script lang="ts">
  import { onMount } from 'svelte'
  import { DEFAULT_PAGE } from '../../lib/api'
  import {
    EMPTY_PAGE_SETTINGS,
    FALLBACK_PAGES,
    fetchPageSettings,
    fetchSettingsPages,
    savePageSettings,
    type PageSettings,
    type SettingsPage,
  } from '../../lib/settingsApi'
  import PageSelector from './PageSelector.svelte'
  import ShortlinkCommentSection from './ShortlinkCommentSection.svelte'
  import AdsSchedulingSection from './AdsSchedulingSection.svelte'

  // Phase 1 of the dashboard-settings migration
  // (docs/plans/dashboard-settings-migration.md):
  // - real page selector backed by the redacted page-sources endpoint
  // - sections framework so legacy Mini App settings can move in one by one
  // - editing stays scoped to the default page (เฉียบ) — exactly what the old
  //   single-page panel supported. Other pages are read-only parity for now,
  //   with secrets masked. Save parity for all pages lands in Phase 2/3.

  let pages = $state<SettingsPage[]>([])
  let pagesLoading = $state(true)
  let pagesFallback = $state(false)
  let selectedPage = $state<SettingsPage>(FALLBACK_PAGES[0])

  let settings = $state<PageSettings>({ ...EMPTY_PAGE_SETTINGS })
  let syncTokenPresent = $state(false)
  let loading = $state(true)
  let saving = $state(false)
  let message = $state<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)

  // Writes stay limited to the page the legacy panel already wrote to.
  const canEdit = $derived(selectedPage.id === DEFAULT_PAGE.id)

  async function loadPages() {
    pagesLoading = true
    try {
      const fetched = await fetchSettingsPages()
      if (fetched.length > 0) {
        pages = fetched
        pagesFallback = false
      } else {
        pages = FALLBACK_PAGES
        pagesFallback = true
      }
    } catch {
      pages = FALLBACK_PAGES
      pagesFallback = true
    } finally {
      pagesLoading = false
      selectedPage = pages.find((p) => p.id === DEFAULT_PAGE.id) ?? pages[0]
    }
  }

  async function loadSettings(pageId: string) {
    loading = true
    message = null
    try {
      const fetched = await fetchPageSettings(pageId)
      if (pageId !== selectedPage.id) return // stale response after a page switch
      syncTokenPresent = !!fetched.facebookSyncToken || !!fetched.facebookSyncTokenUpdatedAt
      if (selectedPage.id !== DEFAULT_PAGE.id) {
        // Read-only pages: drop the raw token from client state entirely;
        // the section renders present/updated_at status instead.
        fetched.facebookSyncToken = ''
      }
      settings = fetched
    } catch (e) {
      if (pageId !== selectedPage.id) return
      settings = { ...EMPTY_PAGE_SETTINGS }
      syncTokenPresent = false
      message = {
        kind: 'error',
        text: `โหลด settings ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`,
      }
    } finally {
      if (pageId === selectedPage.id) loading = false
    }
  }

  function selectPage(page: SettingsPage) {
    if (page.id === selectedPage.id) return
    selectedPage = page
    settings = { ...EMPTY_PAGE_SETTINGS }
    syncTokenPresent = false
    void loadSettings(page.id)
  }

  async function saveSettings() {
    if (!canEdit) return
    saving = true
    message = null
    try {
      await savePageSettings(selectedPage.id, settings)
      message = { kind: 'success', text: 'บันทึกแล้ว' }
      await loadSettings(selectedPage.id)
    } catch (e) {
      message = {
        kind: 'error',
        text: `บันทึก settings ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`,
      }
    } finally {
      saving = false
    }
  }

  onMount(async () => {
    await loadPages()
    await loadSettings(selectedPage.id)
  })
</script>

<div class="space-y-4">
  <!-- Migration banner: makes it obvious this is the new settings center and
       the LINE/Telegram Mini App settings remain the working fallback. -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-4 py-3">
    <span class="rounded-full bg-indigo-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">ใหม่</span>
    <p class="text-sm font-semibold text-indigo-900">ศูนย์ตั้งค่า Dashboard</p>
    <p class="text-xs text-indigo-700/80">
      กำลังย้ายการตั้งค่าจาก Mini App (LINE/Telegram) เข้ามาทีละส่วน — Mini App ยังใช้งานได้ตามเดิมระหว่างย้าย
    </p>
  </div>

  <PageSelector
    {pages}
    selectedId={selectedPage.id}
    loading={pagesLoading}
    fallback={pagesFallback}
    onSelect={selectPage}
  />

  <div class="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
    {#if selectedPage.iconUrl}
      <img
        src={selectedPage.iconUrl}
        alt={selectedPage.name}
        class="h-10 w-10 shrink-0 rounded-xl object-cover ring-1 ring-slate-200"
        onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
      />
    {/if}
    <div class="min-w-0 flex-1">
      <p class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">การตั้งค่าของเพจ</p>
      <p class="truncate text-sm font-semibold text-slate-900">
        เพจ {selectedPage.name}
        <span class="ml-2 rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-500">
          {selectedPage.id}
        </span>
      </p>
    </div>
    {#if canEdit}
      <p class="hidden text-[11px] text-slate-400 sm:block">การตั้งค่านี้ใช้กับเพจนี้เท่านั้น</p>
    {:else}
      <span class="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
        ดูอย่างเดียว (Phase 1)
      </span>
    {/if}
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
    <ShortlinkCommentSection
      {settings}
      {loading}
      disabled={!canEdit}
      maskSecrets={!canEdit}
      {syncTokenPresent}
    />

    <AdsSchedulingSection {settings} {loading} disabled={!canEdit}>
      {#if canEdit}
        <button
          type="button"
          onclick={saveSettings}
          disabled={saving || loading}
          class="mt-5 w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'กำลังบันทึก...' : `บันทึกตั้งค่าของเพจ ${selectedPage.name}`}
        </button>
      {:else}
        <p class="mt-5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-center text-xs text-slate-500">
          เพจนี้เปิดดูอย่างเดียวใน Phase 1 — แก้ไขได้ผ่าน Mini App ตามเดิม
        </p>
      {/if}
    </AdsSchedulingSection>
  </div>
</div>
