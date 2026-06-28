import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  Cloud,
  CloudOff,
  Facebook,
  Globe,
  Laptop,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import {
  archiveCloudAccount,
  BridgeOfflineError,
  CloudNotConfiguredError,
  closeOnMac,
  createCloudAccount,
  fetchCloudAccounts,
  fetchCloudAgents,
  fetchCloudCommands,
  fetchCloudHealth,
  isAgentLive,
  isValidAccountUid,
  openOnMac,
  updateCloudAccount,
  type CloudAccount,
  type CloudAccountInput,
  type CloudAgent,
  type CloudCommand,
} from '@/api/accountsBridge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

function isNotConfigured(error: unknown): boolean {
  return error instanceof CloudNotConfiguredError
}
function isOffline(error: unknown): boolean {
  return error instanceof BridgeOfflineError
}

// Short relative time for heartbeats / command timestamps. Cloud timestamps are ISO strings.
function since(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// Deterministic avatar tint from the account key so each profile reads as distinct without storing
// any per-account colour. Pure presentation — no secrets, no network.
const AVATAR_TINTS = [
  'bg-rose-100 text-rose-700',
  'bg-orange-100 text-orange-700',
  'bg-amber-100 text-amber-700',
  'bg-emerald-100 text-emerald-700',
  'bg-sky-100 text-sky-700',
  'bg-indigo-100 text-indigo-700',
  'bg-violet-100 text-violet-700',
  'bg-fuchsia-100 text-fuchsia-700',
]
function avatarTint(key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return AVATAR_TINTS[hash % AVATAR_TINTS.length]
}
function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Derive a GoLogin-style Running / Stopped status from the most recent command for this account on
// the selected agent. "Running" = an open succeeded/began recently and was not closed afterwards.
type RunState = { label: string; kind: 'success' | 'secondary' | 'destructive'; detail: string }
function runStateForAccount(uid: string, commands: CloudCommand[], agentLive: boolean): RunState {
  const latest = commands
    .filter((c) => c.account_uid === uid)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0]

  if (!latest) {
    return { label: 'Stopped', kind: 'secondary', detail: agentLive ? 'พร้อมเปิด' : 'agent ออฟไลน์' }
  }
  if (latest.status === 'failed') {
    return { label: 'Stopped', kind: 'destructive', detail: latest.error_code || 'ล่าสุดล้มเหลว' }
  }
  if (latest.action === 'open_profile' && (latest.status === 'succeeded' || latest.status === 'running' || latest.status === 'queued')) {
    return { label: 'Running', kind: 'success', detail: `เปิด ${since(latest.updated_at)}` }
  }
  return { label: 'Stopped', kind: 'secondary', detail: `${latest.action === 'close_profile' ? 'ปิด' : latest.action} ${since(latest.updated_at)}` }
}

// Clear "not configured" panel — the deliberate state when ACCOUNTS_BRIDGE_WORKER_URL is unset
// server-side. We never fall back to localhost as a main data source.
function NotConfiguredPanel() {
  return (
    <Card>
      <CardContent className="space-y-2 py-8 text-center">
        <Settings className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-[#333333]">Cloud bridge not configured</p>
        <p className="mx-auto max-w-md text-xs text-muted-foreground">
          ตั้งค่า <code className="font-mono">ACCOUNTS_BRIDGE_WORKER_URL</code> และ secret{' '}
          <code className="font-mono">ACCOUNTS_BRIDGE_API_KEY</code> ที่ฝั่ง dashboard worker
          เพื่อเชื่อมต่อ Accounts Bridge บนคลาวด์ — หน้านี้จะไม่ดึงข้อมูลจาก localhost
        </p>
      </CardContent>
    </Card>
  )
}

// One icon action button in the GoLogin-style action cluster. Disabled placeholders read as muted.
function IconAction({
  title,
  onClick,
  disabled,
  className,
  children,
  placeholder,
}: {
  title: string
  onClick?: () => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
  placeholder?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled || placeholder}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed ${
        placeholder
          ? 'border-transparent text-[#cfcfcf]'
          : 'border-border bg-white text-[#555555] hover:bg-[#f5f5f5] disabled:opacity-40'
      } ${className ?? ''}`}
    >
      {children}
    </button>
  )
}

function AccountRow({
  account,
  index,
  agent,
  commands,
  checked,
  onToggle,
  onRefresh,
  onEdit,
  onArchive,
  archiving,
}: {
  account: CloudAccount
  index: number
  agent: CloudAgent | null
  commands: CloudCommand[]
  checked: boolean
  onToggle: () => void
  onRefresh: () => void
  onEdit: () => void
  onArchive: () => void
  archiving: boolean
}) {
  const uid = account.account_uid
  const label = account.display_label || account.account_uid
  const agentLive = isAgentLive(agent)
  const canAct = !!agent && agentLive

  const openMutation = useMutation({
    mutationFn: () => openOnMac(agent!.agent_id, uid),
    onSuccess: onRefresh,
  })
  const closeMutation = useMutation({
    mutationFn: () => closeOnMac(agent!.agent_id, uid),
    onSuccess: onRefresh,
  })
  const busy = openMutation.isPending || closeMutation.isPending
  const actionError = openMutation.error || closeMutation.error

  const run = runStateForAccount(uid, commands, agentLive)
  const isRunning = run.label === 'Running'

  return (
    <tr className="border-b border-border last:border-0 hover:bg-[#fafafa]">
      {/* select */}
      <td className="w-10 px-3 py-3 align-middle">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`เลือก ${label}`}
          className="h-4 w-4 cursor-pointer accent-[#ee4d2d]"
        />
      </td>
      {/* # */}
      <td className="w-10 px-2 py-3 align-middle text-xs text-muted-foreground">{index + 1}</td>
      {/* NAME */}
      <td className="min-w-[260px] px-3 py-3 align-middle">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarTint(uid)}`}
          >
            {initials(label)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-[#333333]">{label}</span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">UID: {uid}</span>
          </span>
        </div>
      </td>
      {/* NOTES */}
      <td className="min-w-[140px] max-w-[220px] px-3 py-3 align-middle text-sm text-muted-foreground">
        {account.notes ? (
          <span className="line-clamp-2 whitespace-pre-wrap break-words" title={account.notes}>
            {account.notes}
          </span>
        ) : (
          <span className="text-[#cfcfcf]">—</span>
        )}
      </td>
      {/* TAG */}
      <td className="min-w-[120px] px-3 py-3 align-middle">
        <span className="flex flex-wrap items-center gap-1">
          {account.tags.length > 0 ? (
            account.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="bg-[#fff1ec] text-[#ee4d2d]">
                {tag}
              </Badge>
            ))
          ) : (
            <span className="text-sm text-[#cfcfcf]">—</span>
          )}
        </span>
      </td>
      {/* PAGE */}
      <td className="min-w-[200px] px-3 py-3 align-middle">
        <span className="flex items-center gap-2 text-sm text-[#333333]">
          <Facebook className="h-4 w-4 shrink-0 text-[#1877f2]" />
          <span className="min-w-0">
            <span className="block truncate" title={account.page_label ?? undefined}>
              {account.page_label || (account.platform === 'facebook' ? 'Facebook' : account.platform)}
            </span>
            <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <Laptop className="h-3 w-3 shrink-0" />
              {account.preferred_agent_id || (agent ? agent.label || agent.agent_id : 'ไม่มี agent')}
            </span>
          </span>
        </span>
      </td>
      {/* STATUS */}
      <td className="min-w-[150px] px-3 py-3 align-middle">
        <span className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${run.kind === 'success' ? 'bg-emerald-500' : run.kind === 'destructive' ? 'bg-red-500' : 'bg-gray-300'}`}
            />
            <Badge variant={run.kind}>{run.label}</Badge>
          </span>
          <span className="text-[11px] text-muted-foreground">{run.detail}</span>
          {actionError ? (
            <span className="text-[11px] text-destructive">
              {isOffline(actionError) ? 'cloud ไม่ตอบสนอง' : (actionError as Error).message}
            </span>
          ) : null}
        </span>
      </td>
      {/* ACTIONS */}
      <td className="min-w-[200px] px-3 py-3 align-middle">
        <div className="flex items-center gap-1.5">
          {/* One primary button, BrowserSaving-style: Play when stopped, Stop when running.
              Stop reuses closeOnMac → agent closes the browser and uploads the cookie/session archive. */}
          {isRunning ? (
            <button
              type="button"
              title={canAct ? 'หยุด & บันทึก session บน Mac (Stop on Mac · Save session)' : 'agent ออฟไลน์'}
              aria-label="Stop on Mac"
              onClick={() => closeMutation.mutate()}
              disabled={!canAct || busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              title={canAct ? 'เปิดโปรไฟล์บน Mac (Open on Mac)' : 'agent ออฟไลน์'}
              aria-label="Open on Mac"
              onClick={() => openMutation.mutate()}
              disabled={!canAct || busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Open
            </button>
          )}
          <IconAction title="รีเฟรชสถานะคำสั่ง" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
          </IconAction>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <IconAction title="เปิดเบราว์เซอร์ (เร็ว ๆ นี้)" placeholder>
            <Globe className="h-4 w-4" />
          </IconAction>
          <IconAction title="แก้ไขบัญชี (Edit)" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </IconAction>
          <IconAction
            title="เก็บถาวรบัญชี (Archive)"
            onClick={onArchive}
            disabled={archiving}
            className="hover:!bg-red-50 hover:!text-red-600"
          >
            <Trash2 className="h-4 w-4" />
          </IconAction>
        </div>
      </td>
    </tr>
  )
}

// Map a stored status to the value the form's <select> uses ('inactive' is shown as 'disabled').
function statusToFormValue(status: string | undefined): 'active' | 'disabled' | 'archived' {
  if (status === 'archived') return 'archived'
  if (status === 'inactive' || status === 'disabled') return 'disabled'
  return 'active'
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: 'ใช้งาน · Active' },
  { value: 'disabled', label: 'ปิดใช้งาน · Disabled' },
  { value: 'archived', label: 'เก็บถาวร · Archived' },
]
const ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '— ไม่ระบุ' },
  { value: 'post', label: 'โพสต์ · Post' },
  { value: 'ads', label: 'โฆษณา · Ads' },
  { value: 'general', label: 'ทั่วไป · General' },
]

const fieldLabelCls = 'mb-1 block text-xs font-medium text-[#555555]'
const fieldInputCls =
  'h-9 w-full rounded-md border border-input bg-white px-3 text-sm text-[#333333] focus:outline-none focus:ring-2 focus:ring-ring'

// Create/Edit account modal. NON-SECRET metadata fields only — there is intentionally no cookie /
// token / password / session field anywhere in this form.
function AccountFormModal({
  mode,
  account,
  agents,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'edit'
  account: CloudAccount | null
  agents: CloudAgent[]
  submitting: boolean
  error: string | null
  onClose: () => void
  onSubmit: (values: CloudAccountInput) => void
}) {
  const [uid, setUid] = useState(account?.account_uid ?? '')
  const [name, setName] = useState(account?.display_label ?? '')
  const [notes, setNotes] = useState(account?.notes ?? '')
  const [tags, setTags] = useState((account?.tags ?? []).join(', '))
  const [pageLabel, setPageLabel] = useState(account?.page_label ?? '')
  const [role, setRole] = useState(account?.account_role ?? '')
  const [status, setStatus] = useState<string>(statusToFormValue(account?.status))
  const [preferredAgent, setPreferredAgent] = useState(account?.preferred_agent_id ?? '')

  const isCreate = mode === 'create'
  const uidValid = isValidAccountUid(uid)
  const nameValid = name.trim().length > 0
  const canSubmit = nameValid && (isCreate ? uidValid : true) && !submitting

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    const values: CloudAccountInput = {
      display_label: name.trim(),
      notes: notes.trim() || null,
      tags: tags.trim(), // server normalizes the comma/newline-separated string
      page_label: pageLabel.trim() || null,
      account_role: role || null,
      preferred_agent_id: preferredAgent || null,
      status,
    }
    if (isCreate) {
      values.account_uid = uid.trim()
      values.platform = 'facebook'
    }
    onSubmit(values)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-semibold text-[#333333]">
            {isCreate ? 'เพิ่มบัญชี · Add account' : 'แก้ไขบัญชี · Edit account'}
          </h2>
          <button
            type="button"
            aria-label="ปิด"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#888888] hover:bg-[#f5f5f5]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 px-5 py-4">
          <div>
            <label className={fieldLabelCls} htmlFor="acc-uid">
              UID (ตัวเลขล้วน 5–32 หลัก) <span className="text-red-500">*</span>
            </label>
            <input
              id="acc-uid"
              value={uid}
              onChange={(e) => setUid(e.target.value)}
              disabled={!isCreate}
              inputMode="numeric"
              placeholder="100090320823561"
              className={`${fieldInputCls} font-mono disabled:bg-[#f5f5f5] disabled:text-muted-foreground`}
            />
            {isCreate && uid.length > 0 && !uidValid ? (
              <p className="mt-1 text-[11px] text-destructive">UID ต้องเป็นตัวเลขล้วน 5–32 หลัก</p>
            ) : null}
            {!isCreate ? <p className="mt-1 text-[11px] text-muted-foreground">UID เป็น identity แก้ไขไม่ได้</p> : null}
          </div>

          <div>
            <label className={fieldLabelCls} htmlFor="acc-name">
              ชื่อบัญชี · Name <span className="text-red-500">*</span>
            </label>
            <input
              id="acc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น Chanalai"
              className={fieldInputCls}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabelCls} htmlFor="acc-role">บทบาท · Role</label>
              <select id="acc-role" value={role} onChange={(e) => setRole(e.target.value)} className={fieldInputCls}>
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={fieldLabelCls} htmlFor="acc-status">สถานะ · Status</label>
              <select id="acc-status" value={status} onChange={(e) => setStatus(e.target.value)} className={fieldInputCls}>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={fieldLabelCls} htmlFor="acc-page">เพจ · Page label</label>
            <input
              id="acc-page"
              value={pageLabel}
              onChange={(e) => setPageLabel(e.target.value)}
              placeholder="เช่น เพจหลัก"
              className={fieldInputCls}
            />
          </div>

          <div>
            <label className={fieldLabelCls} htmlFor="acc-tags">แท็ก · Tags (คั่นด้วย ,)</label>
            <input
              id="acc-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="post, main"
              className={fieldInputCls}
            />
          </div>

          <div>
            <label className={fieldLabelCls} htmlFor="acc-agent">Agent ที่ต้องการ · Preferred agent</label>
            <select
              id="acc-agent"
              value={preferredAgent}
              onChange={(e) => setPreferredAgent(e.target.value)}
              className={fieldInputCls}
            >
              <option value="">— ไม่ระบุ</option>
              {agents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>{a.label || a.agent_id}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={fieldLabelCls} htmlFor="acc-notes">โน้ต · Notes</label>
            <textarea
              id="acc-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="บันทึกภายใน (ไม่ใช่ความลับ)"
              className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm text-[#333333] focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <p className="rounded-md bg-[#f7f7f7] px-3 py-2 text-[11px] text-muted-foreground">
            เก็บเฉพาะข้อมูลที่ไม่ใช่ความลับ — ไม่มีช่องสำหรับ cookie / token / password / session ที่นี่
          </p>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={submitting}>
              ยกเลิก
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {submitting ? 'กำลังบันทึก…' : isCreate ? 'เพิ่มบัญชี' : 'บันทึก'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function AccountsPage() {
  const [search, setSearch] = useState('')
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set())
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; account: CloudAccount | null } | null>(null)
  const qc = useQueryClient()

  const healthQuery = useQuery({
    queryKey: ['accounts-bridge', 'health'],
    queryFn: ({ signal }) => fetchCloudHealth(signal),
    retry: false,
    refetchInterval: 30000,
  })
  const notConfigured = isNotConfigured(healthQuery.error)
  const offline = isOffline(healthQuery.error)
  const cloudDown = notConfigured || offline

  const agentsQuery = useQuery({
    queryKey: ['accounts-bridge', 'agents'],
    queryFn: ({ signal }) => fetchCloudAgents(signal),
    enabled: !cloudDown,
    retry: false,
    refetchInterval: 10000,
  })

  const accountsQuery = useQuery({
    queryKey: ['accounts-bridge', 'accounts'],
    queryFn: ({ signal }) => fetchCloudAccounts(signal),
    enabled: !cloudDown,
    retry: false,
  })

  const agents = agentsQuery.data ?? []
  // Default selected agent: a live one if any, else the first known agent.
  const liveAgent = agents.find((a) => isAgentLive(a))
  const selectedAgent =
    agents.find((a) => a.agent_id === selectedAgentId) ?? liveAgent ?? agents[0] ?? null

  const commandsQuery = useQuery({
    queryKey: ['accounts-bridge', 'commands', selectedAgent?.agent_id ?? null],
    queryFn: ({ signal }) => fetchCloudCommands(selectedAgent?.agent_id, 30, signal),
    enabled: !cloudDown && !!selectedAgent,
    retry: false,
    refetchInterval: 5000,
  })

  const accounts = accountsQuery.data ?? []
  const commands = commandsQuery.data ?? []

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return accounts
    return accounts.filter(
      (a) =>
        a.account_uid.toLowerCase().includes(term) ||
        (a.display_label ?? '').toLowerCase().includes(term),
    )
  }, [accounts, search])

  function refreshCommands() {
    void qc.invalidateQueries({ queryKey: ['accounts-bridge', 'commands'] })
  }
  function refreshAccounts() {
    void qc.invalidateQueries({ queryKey: ['accounts-bridge', 'accounts'] })
  }
  function refreshAll() {
    void healthQuery.refetch()
    void agentsQuery.refetch()
    void accountsQuery.refetch()
    void commandsQuery.refetch()
  }

  // Create or update an account, then invalidate accounts + commands so the table reflects it.
  const saveMutation = useMutation({
    mutationFn: async (values: CloudAccountInput) => {
      if (modal?.mode === 'edit' && modal.account) {
        return updateCloudAccount(modal.account.platform, modal.account.account_uid, values)
      }
      const { account } = await createCloudAccount(values)
      return account
    },
    onSuccess: () => {
      setModal(null)
      refreshAccounts()
      refreshCommands()
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (account: CloudAccount) => archiveCloudAccount(account.platform, account.account_uid),
    onSuccess: () => {
      refreshAccounts()
      refreshCommands()
    },
  })

  function handleArchive(account: CloudAccount) {
    const label = account.display_label || account.account_uid
    if (!window.confirm(`เก็บถาวรบัญชี "${label}"?\nบัญชีจะถูกซ่อนจากตาราง แต่ไม่มีการลบ session/โปรไฟล์`)) return
    archiveMutation.mutate(account)
  }

  function saveErrorMessage(error: unknown): string | null {
    if (!error) return null
    if (isOffline(error)) return 'เชื่อมต่อ cloud ไม่ได้ — ลองอีกครั้ง'
    const code = (error as Error).message
    if (code === 'secret_field_rejected') return 'พบฟิลด์ที่ดูเหมือนข้อมูลลับ — ไม่อนุญาต'
    if (code === 'bad_account_uid') return 'UID ต้องเป็นตัวเลขล้วน 5–32 หลัก'
    return code || 'บันทึกไม่สำเร็จ'
  }
  function toggleUid(uid: string) {
    setSelectedUids((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }
  const allChecked = filtered.length > 0 && filtered.every((a) => selectedUids.has(a.account_uid))
  function toggleAll() {
    setSelectedUids((prev) => {
      if (filtered.every((a) => prev.has(a.account_uid))) {
        const next = new Set(prev)
        for (const a of filtered) next.delete(a.account_uid)
        return next
      }
      const next = new Set(prev)
      for (const a of filtered) next.add(a.account_uid)
      return next
    })
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-[#333333]">บัญชี · Accounts</h1>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Cloud className="h-4 w-4" />
          จัดการบัญชีผ่าน Accounts Bridge บนคลาวด์ — เปิด/ปิดโปรไฟล์บนเครื่อง Mac จากที่ไหนก็ได้ผ่าน agent
        </p>
      </div>

      {/* Top bar: cloud status + agent selector + search + refresh */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex flex-wrap items-center gap-3">
            {cloudDown ? (
              <Badge variant={notConfigured ? 'outline' : 'destructive'}>
                {notConfigured ? 'Not configured' : 'Cloud offline'}
              </Badge>
            ) : (
              <Badge variant="success">Cloud online</Badge>
            )}
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {cloudDown ? <CloudOff className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}
              {notConfigured
                ? 'ยังไม่ได้ตั้งค่า cloud bridge'
                : offline
                  ? 'เชื่อมต่อ cloud Accounts Bridge ไม่ได้'
                  : `${agents.length} agent · ${accounts.length} accounts`}
            </span>

            {!cloudDown && agents.length > 0 ? (
              <span className="relative flex items-center">
                <Laptop className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <select
                  value={selectedAgent?.agent_id ?? ''}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  className="h-9 appearance-none rounded-md border border-input bg-white pl-8 pr-8 text-sm text-[#333333] focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {agents.map((a) => (
                    <option key={a.agent_id} value={a.agent_id}>
                      {(a.label || a.agent_id) + (isAgentLive(a) ? ' • online' : ' • offline')}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาบัญชี…"
                className="h-9 w-48 pl-8"
              />
            </div>
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => {
                saveMutation.reset()
                setModal({ mode: 'create', account: null })
              }}
              disabled={cloudDown}
              className="bg-[#ee4d2d] text-white hover:bg-[#d8431f]"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              เพิ่มบัญชี
            </Button>
          </div>
        </CardContent>
      </Card>

      {notConfigured ? (
        <NotConfiguredPanel />
      ) : offline ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            เชื่อมต่อ cloud Accounts Bridge ไม่ได้ — ลองรีเฟรชอีกครั้ง
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {selectedAgent && !isAgentLive(selectedAgent) ? (
            <div className="border-b border-border bg-[#fff7ed] px-4 py-2 text-xs text-[#9a3412]">
              Agent ออฟไลน์ (heartbeat ค้าง {since(selectedAgent.last_seen_at)}) — คำสั่งจะค้างใน queue จนกว่า agent กลับมา
            </div>
          ) : null}
          {!selectedAgent ? (
            <div className="border-b border-border bg-[#f5f5f5] px-4 py-2 text-xs text-muted-foreground">
              ยังไม่มี Mac agent เชื่อมต่อ — เปิด Accounts Bridge บนเครื่อง Mac
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1200px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-[#f7f7f7] text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={toggleAll}
                      aria-label="เลือกทั้งหมด"
                      disabled={filtered.length === 0}
                      className="h-4 w-4 cursor-pointer accent-[#ee4d2d]"
                    />
                  </th>
                  <th className="w-10 px-2 py-2.5">#</th>
                  <th className="px-3 py-2.5">Name</th>
                  <th className="px-3 py-2.5">Notes</th>
                  <th className="px-3 py-2.5">Tag</th>
                  <th className="px-3 py-2.5">Page</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accountsQuery.isLoading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      กำลังโหลด…
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                      {accounts.length === 0
                        ? 'ยังไม่มีบัญชีบนคลาวด์ — agent จะ sync บัญชีจากเครื่อง Mac ให้อัตโนมัติ'
                        : 'ไม่พบบัญชีที่ค้นหา'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((account, i) => (
                    <AccountRow
                      key={account.account_uid}
                      account={account}
                      index={i}
                      agent={selectedAgent}
                      commands={commands}
                      checked={selectedUids.has(account.account_uid)}
                      onToggle={() => toggleUid(account.account_uid)}
                      onRefresh={refreshCommands}
                      onEdit={() => {
                        saveMutation.reset()
                        setModal({ mode: 'edit', account })
                      }}
                      onArchive={() => handleArchive(account)}
                      archiving={archiveMutation.isPending && archiveMutation.variables?.account_uid === account.account_uid}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            <span>{filtered.length} profiles</span>
            <span className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1">
                <Play className="h-3 w-3 fill-current text-emerald-600" /> เปิด · Open
              </span>
              <span className="text-[#dddddd]">·</span>
              <span className="inline-flex items-center gap-1">
                <Square className="h-3 w-3 fill-current text-red-600" /> หยุด · Stop = บันทึก session
              </span>
            </span>
          </div>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground">
        Open enqueues a command; the Mac agent opens a VISIBLE Facebook Lite window with autofill and submit
        both OFF — no credential is read, no login is submitted, and no token is minted. กด Stop เพื่อให้ agent
        ปิดเบราว์เซอร์แล้วอัปโหลด cookie/session archive กลับขึ้น Worker (ไม่มี token/cookie ดิบแสดงบนหน้านี้).
      </p>

      {archiveMutation.error ? (
        <p className="text-xs text-destructive">
          เก็บถาวรไม่สำเร็จ: {isOffline(archiveMutation.error) ? 'cloud ไม่ตอบสนอง' : (archiveMutation.error as Error).message}
        </p>
      ) : null}

      {modal ? (
        <AccountFormModal
          mode={modal.mode}
          account={modal.account}
          agents={agents}
          submitting={saveMutation.isPending}
          error={saveErrorMessage(saveMutation.error)}
          onClose={() => {
            if (saveMutation.isPending) return
            setModal(null)
          }}
          onSubmit={(values) => saveMutation.mutate(values)}
        />
      ) : null}
    </div>
  )
}
