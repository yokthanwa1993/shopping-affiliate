import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Laptop, RefreshCw, Search, ExternalLink, Power } from 'lucide-react'
import {
  ACCOUNTS_BRIDGE_BASE,
  BridgeOfflineError,
  closeSession,
  fetchBridgeAccounts,
  fetchBridgeHealth,
  fetchBridgeStatus,
  fetchProfileStatus,
  openSafeSession,
  type BridgeAccount,
} from '@/api/accountsBridge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type PillKind = 'success' | 'secondary' | 'outline' | 'destructive'

function isOffline(error: unknown): boolean {
  return error instanceof BridgeOfflineError
}

// Single source of truth for the per-account status pill. Offline (bridge unreachable) and Unknown
// (bridge up but profile state not resolvable) are distinct so the operator can tell the difference.
function statusPill(opts: {
  offline: boolean
  loading: boolean
  running?: boolean
  statusKnown?: boolean
}): { label: string; kind: PillKind } {
  if (opts.offline) return { label: 'Offline', kind: 'destructive' }
  if (opts.loading) return { label: 'Checking…', kind: 'outline' }
  if (opts.statusKnown === false || opts.running === undefined) return { label: 'Unknown', kind: 'outline' }
  if (opts.running) return { label: 'Running', kind: 'success' }
  return { label: 'Stopped', kind: 'secondary' }
}

function ReadinessChips({ account }: { account: BridgeAccount }) {
  // Presence-only readiness, never the secret. Power Editor = ads, Facebook Lite = posting.
  const chips: Array<{ label: string; on: boolean }> = [
    { label: 'Credential', on: account.credentialPresent },
    { label: '2FA', on: account.totpPresent },
    { label: 'datr', on: account.datrPresent },
    { label: 'In registry', on: account.inRegistry },
  ]
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <Badge key={chip.label} variant={chip.on ? 'success' : 'outline'}>
          {chip.label}: {chip.on ? 'yes' : 'no'}
        </Badge>
      ))}
    </div>
  )
}

function AccountDetail({
  account,
  offline,
}: {
  account: BridgeAccount
  offline: boolean
}) {
  const qc = useQueryClient()
  const uid = account.account

  const profileQuery = useQuery({
    queryKey: ['accounts-bridge', 'profile-status', uid],
    queryFn: ({ signal }) => fetchProfileStatus(uid, signal),
    enabled: !offline,
    retry: false,
  })

  const profileOffline = isOffline(profileQuery.error)
  const profile = profileQuery.data
  const pill = statusPill({
    offline: offline || profileOffline,
    loading: profileQuery.isFetching && !profile,
    running: profile?.running,
    statusKnown: profile?.statusKnown,
  })

  function refreshProfile() {
    void qc.invalidateQueries({ queryKey: ['accounts-bridge', 'profile-status', uid] })
  }

  const openMutation = useMutation({
    mutationFn: () => openSafeSession(uid),
    onSuccess: refreshProfile,
  })
  const closeMutation = useMutation({
    mutationFn: () => closeSession(uid),
    onSuccess: refreshProfile,
  })

  const busy = openMutation.isPending || closeMutation.isPending
  const actionsDisabled = offline || !uid || busy
  const actionError = openMutation.error || closeMutation.error

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate">{account.displayName || account.account}</CardTitle>
          <p className="mt-1 font-mono text-xs text-muted-foreground">UID: {account.key}</p>
        </div>
        <Badge variant={pill.kind}>{pill.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Provider</dt>
            <dd>{account.provider}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Role / type</dt>
            <dd>{account.inRegistry ? 'Registered account' : 'Selector-only'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Domain</dt>
            <dd>{account.domain || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Token mode</dt>
            <dd>{account.convertTokenMode}</dd>
          </div>
        </dl>

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Readiness</p>
          <ReadinessChips account={account} />
        </div>

        {profile && !profileOffline ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Session</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={profile.profileExists ? 'success' : 'outline'}>
                Profile: {profile.profileExists ? 'yes' : 'no'}
              </Badge>
              <Badge variant={profile.bridgeSession ? 'success' : 'outline'}>
                Bridge session: {profile.bridgeSession ? 'yes' : 'no'}
              </Badge>
              <Badge variant={profile.visibleSession ? 'success' : 'outline'}>
                Visible window: {profile.visibleSession ? 'yes' : 'no'}
              </Badge>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={refreshProfile} disabled={offline || profileQuery.isFetching}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Refresh status
          </Button>
          <Button size="sm" onClick={() => openMutation.mutate()} disabled={actionsDisabled}>
            <ExternalLink className="mr-1.5 h-4 w-4" />
            Open safe session
          </Button>
          <Button variant="secondary" size="sm" onClick={() => closeMutation.mutate()} disabled={actionsDisabled}>
            <Power className="mr-1.5 h-4 w-4" />
            Close session
          </Button>
        </div>

        {actionError ? (
          <p className="text-xs text-destructive">
            {isOffline(actionError) ? 'Accounts Bridge is offline.' : (actionError as Error).message}
          </p>
        ) : null}
        <p className="text-[11px] text-muted-foreground">
          Open launches a VISIBLE Facebook Lite window with autofill and submit both OFF — no credential
          is read, no login is submitted, and no token is minted.
        </p>
      </CardContent>
    </Card>
  )
}

export function AccountsPage() {
  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const healthQuery = useQuery({
    queryKey: ['accounts-bridge', 'health'],
    queryFn: ({ signal }) => fetchBridgeHealth(signal),
    retry: false,
    refetchInterval: 30000,
  })
  const offline = isOffline(healthQuery.error)

  const accountsQuery = useQuery({
    queryKey: ['accounts-bridge', 'accounts'],
    queryFn: ({ signal }) => fetchBridgeAccounts(signal),
    enabled: !offline,
    retry: false,
  })

  const statusQuery = useQuery({
    queryKey: ['accounts-bridge', 'status'],
    queryFn: ({ signal }) => fetchBridgeStatus(signal),
    enabled: !offline,
    retry: false,
  })

  const accounts = accountsQuery.data ?? []
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return accounts
    return accounts.filter(
      (a) =>
        a.account.toLowerCase().includes(term) ||
        a.key.toLowerCase().includes(term) ||
        (a.displayName ?? '').toLowerCase().includes(term),
    )
  }, [accounts, search])

  const selected = filtered.find((a) => a.key === selectedKey) ?? filtered[0] ?? null
  const bridgeOffline = offline || isOffline(accountsQuery.error)

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-[#333333]">บัญชี · Accounts</h1>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Laptop className="h-4 w-4" />
          หน้านี้ควบคุม Accounts Bridge บนเครื่อง Mac นี้ ({ACCOUNTS_BRIDGE_BASE}) — pool ของบัญชี
          Facebook Lite (โพสต์) / Power Editor (โฆษณา)
        </p>
      </div>

      {/* Bridge health summary */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
            <Badge variant={bridgeOffline ? 'destructive' : 'success'}>
              {bridgeOffline ? 'Offline' : 'Online'}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {bridgeOffline
                ? 'ไม่พบ Accounts Bridge บนเครื่องนี้ — เปิดแอป Accounts Bridge แล้วลองใหม่'
                : `${statusQuery.data?.facebook.accountsCount ?? accounts.length} accounts · ${
                    healthQuery.data?.app ?? 'accounts-bridge'
                  }`}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void healthQuery.refetch()
              void accountsQuery.refetch()
              void statusQuery.refetch()
            }}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Refresh
          </Button>
        </CardContent>
      </Card>

      {bridgeOffline ? null : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          {/* Left: search + account list */}
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาบัญชี…"
                className="pl-8"
              />
            </div>
            <div className="space-y-2">
              {accountsQuery.isLoading ? (
                <p className="px-1 text-sm text-muted-foreground">กำลังโหลด…</p>
              ) : filtered.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">ไม่พบบัญชี</p>
              ) : (
                filtered.map((account) => {
                  const active = selected?.key === account.key
                  return (
                    <button
                      key={account.key}
                      type="button"
                      onClick={() => setSelectedKey(account.key)}
                      className={`w-full rounded-md border p-3 text-left transition-colors ${
                        active
                          ? 'border-[#ee4d2d] bg-[#fff5f2]'
                          : 'border-border bg-white hover:bg-[#f5f5f5]'
                      }`}
                    >
                      <div className="truncate text-sm font-medium text-[#333333]">
                        {account.displayName || account.account}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {account.key}
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
              <AccountDetail key={selected.key} account={selected} offline={bridgeOffline} />
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  เลือกบัญชีทางซ้ายเพื่อดูรายละเอียด
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
