import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cloud, CloudOff, ExternalLink, Laptop, Power, RefreshCw, Search, Settings } from 'lucide-react'
import {
  BridgeOfflineError,
  CloudNotConfiguredError,
  closeOnMac,
  fetchCloudAccounts,
  fetchCloudAgents,
  fetchCloudCommands,
  fetchCloudHealth,
  isAgentLive,
  openOnMac,
  type CloudAccount,
  type CloudAgent,
  type CloudCommand,
  type CommandStatus,
} from '@/api/accountsBridge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type PillKind = 'success' | 'secondary' | 'outline' | 'destructive'

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

function commandPill(status: CommandStatus): { label: string; kind: PillKind } {
  switch (status) {
    case 'queued':
      return { label: 'Queued', kind: 'outline' }
    case 'running':
      return { label: 'Running', kind: 'secondary' }
    case 'succeeded':
      return { label: 'Succeeded', kind: 'success' }
    case 'failed':
      return { label: 'Failed', kind: 'destructive' }
    case 'cancelled':
      return { label: 'Cancelled', kind: 'outline' }
    default:
      return { label: status, kind: 'outline' }
  }
}

function actionLabel(action: string): string {
  if (action === 'open_profile') return 'Open'
  if (action === 'close_profile') return 'Close'
  if (action === 'sync_accounts') return 'Sync'
  return action
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

function AgentCard({
  agent,
  selected,
  onSelect,
}: {
  agent: CloudAgent
  selected: boolean
  onSelect: () => void
}) {
  const live = isAgentLive(agent)
  const accountsCount =
    agent.detail && typeof agent.detail.accountsCount === 'number' ? (agent.detail.accountsCount as number) : null
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border p-3 text-left transition-colors ${
        selected ? 'border-[#ee4d2d] bg-[#fff5f2]' : 'border-border bg-white hover:bg-[#f5f5f5]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-[#333333]">
          <Laptop className="h-4 w-4 shrink-0" />
          {agent.label || agent.agent_id}
        </span>
        <Badge variant={live ? 'success' : 'destructive'}>{live ? 'Online' : 'Offline'}</Badge>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="font-mono">{agent.agent_id}</span>
        <span>heartbeat {since(agent.last_seen_at)}</span>
      </div>
      {accountsCount != null ? (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{accountsCount} accounts synced</div>
      ) : null}
    </button>
  )
}

function CommandRow({ command }: { command: CloudCommand }) {
  const pill = commandPill(command.status)
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border py-1.5 text-xs last:border-0">
      <span className="min-w-0 truncate">
        <span className="font-medium">{actionLabel(command.action)}</span>{' '}
        <span className="font-mono text-muted-foreground">{command.account_uid || '—'}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {command.error_code ? <span className="text-destructive">{command.error_code}</span> : null}
        <span className="text-muted-foreground">{since(command.updated_at)}</span>
        <Badge variant={pill.kind}>{pill.label}</Badge>
      </span>
    </div>
  )
}

function AccountDetail({
  account,
  agent,
  commands,
}: {
  account: CloudAccount
  agent: CloudAgent | null
  commands: CloudCommand[]
}) {
  const qc = useQueryClient()
  const uid = account.account_uid
  const agentLive = isAgentLive(agent)
  const canAct = !!agent && agentLive

  function refreshCommands() {
    void qc.invalidateQueries({ queryKey: ['accounts-bridge', 'commands'] })
  }

  const openMutation = useMutation({
    mutationFn: () => openOnMac(agent!.agent_id, uid),
    onSuccess: refreshCommands,
  })
  const closeMutation = useMutation({
    mutationFn: () => closeOnMac(agent!.agent_id, uid),
    onSuccess: refreshCommands,
  })

  const busy = openMutation.isPending || closeMutation.isPending
  const actionError = openMutation.error || closeMutation.error
  const accountCommands = commands.filter((c) => c.account_uid === uid).slice(0, 5)

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate">{account.display_label || account.account_uid}</CardTitle>
          <p className="mt-1 font-mono text-xs text-muted-foreground">UID: {account.account_uid}</p>
        </div>
        <Badge variant={account.status === 'active' ? 'success' : 'secondary'}>{account.status}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Platform</dt>
            <dd>{account.platform}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Target agent</dt>
            <dd className="truncate">{agent ? agent.label || agent.agent_id : '— ไม่มี agent —'}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" onClick={() => openMutation.mutate()} disabled={!canAct || busy}>
            <ExternalLink className="mr-1.5 h-4 w-4" />
            Open on Mac
          </Button>
          <Button variant="secondary" size="sm" onClick={() => closeMutation.mutate()} disabled={!canAct || busy}>
            <Power className="mr-1.5 h-4 w-4" />
            Close on Mac
          </Button>
          <Button variant="outline" size="sm" onClick={refreshCommands}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Refresh
          </Button>
        </div>

        {!agent ? (
          <p className="text-xs text-muted-foreground">ยังไม่มี Mac agent เชื่อมต่อ — เปิด Accounts Bridge บนเครื่อง Mac</p>
        ) : !agentLive ? (
          <p className="text-xs text-destructive">Agent ออฟไลน์ (heartbeat ค้าง {since(agent.last_seen_at)}) — คำสั่งจะค้างใน queue จนกว่า agent กลับมา</p>
        ) : null}

        {actionError ? (
          <p className="text-xs text-destructive">
            {isOffline(actionError) ? 'Cloud Accounts Bridge ไม่ตอบสนอง' : (actionError as Error).message}
          </p>
        ) : null}

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Recent commands</p>
          {accountCommands.length === 0 ? (
            <p className="text-xs text-muted-foreground">ยังไม่มีคำสั่งสำหรับบัญชีนี้</p>
          ) : (
            <div>{accountCommands.map((c) => <CommandRow key={c.id} command={c} />)}</div>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          Open enqueues a command; the Mac agent opens a VISIBLE Facebook Lite window with autofill and submit
          both OFF — no credential is read, no login is submitted, and no token is minted.
        </p>
      </CardContent>
    </Card>
  )
}

export function AccountsPage() {
  const [search, setSearch] = useState('')
  const [selectedUid, setSelectedUid] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)

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

  const selected = filtered.find((a) => a.account_uid === selectedUid) ?? filtered[0] ?? null

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-[#333333]">บัญชี · Accounts</h1>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Cloud className="h-4 w-4" />
          จัดการบัญชีผ่าน Accounts Bridge บนคลาวด์ — เปิด/ปิดโปรไฟล์บนเครื่อง Mac จากที่ไหนก็ได้ผ่าน agent
        </p>
      </div>

      {/* Cloud connectivity summary */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
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
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void healthQuery.refetch()
              void agentsQuery.refetch()
              void accountsQuery.refetch()
              void commandsQuery.refetch()
            }}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Refresh
          </Button>
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
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          {/* Left: agents + search + account list */}
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Mac agents</p>
              {agentsQuery.isLoading ? (
                <p className="px-1 text-sm text-muted-foreground">กำลังโหลด…</p>
              ) : agents.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">ยังไม่มี agent เชื่อมต่อ</p>
              ) : (
                agents.map((agent) => (
                  <AgentCard
                    key={agent.agent_id}
                    agent={agent}
                    selected={selectedAgent?.agent_id === agent.agent_id}
                    onSelect={() => setSelectedAgentId(agent.agent_id)}
                  />
                ))
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Accounts</p>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="ค้นหาบัญชี…"
                  className="pl-8"
                />
              </div>
              {accountsQuery.isLoading ? (
                <p className="px-1 text-sm text-muted-foreground">กำลังโหลด…</p>
              ) : filtered.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">ไม่พบบัญชี</p>
              ) : (
                filtered.map((account) => {
                  const active = selected?.account_uid === account.account_uid
                  return (
                    <button
                      key={account.account_uid}
                      type="button"
                      onClick={() => setSelectedUid(account.account_uid)}
                      className={`w-full rounded-md border p-3 text-left transition-colors ${
                        active ? 'border-[#ee4d2d] bg-[#fff5f2]' : 'border-border bg-white hover:bg-[#f5f5f5]'
                      }`}
                    >
                      <div className="truncate text-sm font-medium text-[#333333]">
                        {account.display_label || account.account_uid}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {account.account_uid}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          {/* Right: detail panel */}
          <div>
            {selected ? (
              <AccountDetail
                key={selected.account_uid}
                account={selected}
                agent={selectedAgent}
                commands={commands}
              />
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  {accounts.length === 0
                    ? 'ยังไม่มีบัญชีบนคลาวด์ — agent จะ sync บัญชีจากเครื่อง Mac ให้อัตโนมัติ'
                    : 'เลือกบัญชีทางซ้ายเพื่อดูรายละเอียด'}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
