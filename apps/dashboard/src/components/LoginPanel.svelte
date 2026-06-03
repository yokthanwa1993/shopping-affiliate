<script lang="ts">
  import { onMount } from 'svelte'
  import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

  let loading = $state(true)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let info = $state<string | null>(null)
  let setupAvailable = $state(false)
  let alreadyAuthenticated = $state(false)
  let email = $state('')
  let displayName = $state('')
  let namespaceId = $state('')
  let workspaceName = $state('PUBILO')

  function nextTarget(): string {
    const params = new URLSearchParams(window.location.search)
    const candidate = params.get('next') || '/'
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/'
    return candidate
  }

  async function refreshState() {
    loading = true
    try {
      const res = await fetch('/auth/session/me', { credentials: 'same-origin' })
      const data = (await res.json()) as {
        authenticated: boolean
        setupRequired: boolean
        namespaceId?: string
        workspaceId?: string
        user?: { displayName?: string | null; email?: string | null; workspaceName?: string | null }
      }
      alreadyAuthenticated = !!data.authenticated
      setupAvailable = !!data.setupRequired
      namespaceId = data.namespaceId || ''
      workspaceName = data.user?.workspaceName || 'PUBILO'
      if (data.user) {
        email = data.user.email || ''
        displayName = data.user.displayName || ''
      }
    } catch (err) {
      error = `ไม่สามารถเช็คสถานะ session ได้: ${(err as Error).message}`
    } finally {
      loading = false
    }
  }

  async function loginWithPasskey() {
    if (busy) return
    busy = true
    error = null
    info = null
    try {
      const optsRes = await fetch('/auth/passkey/login/options', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!optsRes.ok) {
        const text = await optsRes.text()
        throw new Error(`เปิด Passkey ไม่ได้ (HTTP ${optsRes.status}) ${text}`)
      }
      const optsPayload = (await optsRes.json()) as { challengeId: string; options: any }
      const assertion = await startAuthentication({ optionsJSON: optsPayload.options })
      const verifyRes = await fetch('/auth/passkey/login/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: optsPayload.challengeId, response: assertion }),
      })
      if (!verifyRes.ok) {
        const text = await verifyRes.text()
        throw new Error(`Passkey ไม่ผ่านการตรวจสอบ (HTTP ${verifyRes.status}) ${text}`)
      }
      info = 'เข้าสู่ระบบสำเร็จ กำลังเปิดหน้าหลัก...'
      window.location.href = nextTarget()
    } catch (err) {
      error = (err as Error).message || 'เข้าสู่ระบบไม่สำเร็จ'
    } finally {
      busy = false
    }
  }

  async function bootstrapPasskey() {
    if (busy) return
    busy = true
    error = null
    info = null
    try {
      const optsRes = await fetch('/auth/passkey/register/options', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim() || undefined,
          displayName: displayName.trim() || undefined,
        }),
      })
      if (!optsRes.ok) {
        const text = await optsRes.text()
        throw new Error(`สร้าง Passkey ไม่ได้ (HTTP ${optsRes.status}) ${text}`)
      }
      const optsPayload = (await optsRes.json()) as { challengeId: string; options: any }
      const attestation = await startRegistration({ optionsJSON: optsPayload.options })
      const verifyRes = await fetch('/auth/passkey/register/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: optsPayload.challengeId, response: attestation }),
      })
      if (!verifyRes.ok) {
        const text = await verifyRes.text()
        throw new Error(`สร้าง Passkey ไม่สำเร็จ (HTTP ${verifyRes.status}) ${text}`)
      }
      info = 'สร้าง Passkey สำเร็จ กำลังเปิดหน้าหลัก...'
      window.location.href = nextTarget()
    } catch (err) {
      error = (err as Error).message || 'สร้าง Passkey ไม่สำเร็จ'
    } finally {
      busy = false
    }
  }

  onMount(() => {
    refreshState()
  })
</script>

<section class="mx-auto flex min-h-[80vh] w-full max-w-md flex-col justify-center px-4">
  <div class="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
    <div class="flex items-center gap-3">
      <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-slate-900 to-slate-700 text-sm font-semibold text-white">PU</span>
      <div>
        <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{workspaceName} · Workspace</p>
        <h1 class="text-lg font-semibold text-slate-900">เข้าสู่ระบบ Dashboard</h1>
      </div>
    </div>

    <p class="mt-4 text-sm text-slate-500">
      ระบบนี้ใช้ Passkey แทนรหัสผ่าน เพื่อความปลอดภัยของ workspace {workspaceName}
    </p>

    {#if loading}
      <p class="mt-6 text-sm text-slate-400">กำลังตรวจสอบสถานะ...</p>
    {:else if alreadyAuthenticated}
      <p class="mt-6 text-sm text-emerald-600">คุณเข้าสู่ระบบอยู่แล้ว</p>
      <a
        href="/"
        class="mt-4 inline-flex w-full items-center justify-center rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
      >
        ไปที่หน้าหลัก
      </a>
    {:else}
      {#if setupAvailable}
        <div class="mt-6 space-y-3">
          <label class="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            อีเมล (ไม่จำเป็น)
            <input
              type="email"
              bind:value={email}
              placeholder="you@example.com"
              autocomplete="email"
              class="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:bg-white"
            />
          </label>
          <label class="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            ชื่อที่ใช้แสดง (ไม่จำเป็น)
            <input
              type="text"
              bind:value={displayName}
              placeholder="YOK"
              autocomplete="name"
              class="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:bg-white"
            />
          </label>
        </div>
      {/if}

      <button
        type="button"
        disabled={busy}
        onclick={loginWithPasskey}
        class="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        เข้าสู่ระบบด้วย Passkey
      </button>

      {#if setupAvailable}
        <button
          type="button"
          disabled={busy}
          onclick={bootstrapPasskey}
          class="mt-3 inline-flex w-full items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          สร้าง Passkey ครั้งแรก
        </button>
        <p class="mt-3 text-xs text-slate-500">
          ยังไม่มี Passkey ในระบบ — ปุ่มนี้จะใช้สำหรับติดตั้งครั้งแรกเท่านั้น หลังจากนี้ต้องเข้าสู่ระบบก่อนถึงจะเพิ่ม Passkey ตัวถัดไปได้
        </p>
      {/if}

      {#if error}
        <p class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
      {/if}
      {#if info}
        <p class="mt-4 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{info}</p>
      {/if}
    {/if}

    {#if namespaceId}
      <p class="mt-6 text-[11px] uppercase tracking-[0.16em] text-slate-300">Namespace · {namespaceId}</p>
    {/if}
  </div>
</section>
