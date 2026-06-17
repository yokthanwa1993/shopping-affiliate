import { useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Check,
  ChevronDown,
  Clock,
  Cpu,
  Facebook,
  Layers,
  LayoutDashboard,
  Link2,
  Megaphone,
  MessageSquare,
  PackageOpen,
  Settings,
  Users,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { WorkspaceProvider, useWorkspace } from '@/contexts/workspace'

type NavItem = {
  to: string
  label: string
  sublabel: string
  icon: ComponentType<{ className?: string }>
  exact: boolean
}

// Mirrors the production Astro sidebar (apps/dashboard/src/layouts/Layout.astro)
// ordering so every ported /dashboard_next/* route is reachable from the nav,
// not only via a typed-in deep link. Settings is pinned to the footer, matching
// the live dashboard.
const NAV: readonly NavItem[] = [
  { to: '/', label: 'ภาพรวม', sublabel: 'Overview', icon: LayoutDashboard, exact: true },
  { to: '/gallery', label: 'แกลลี่', sublabel: 'Gallery', icon: Layers, exact: false },
  { to: '/source-inventory', label: 'คลังต้นฉบับ', sublabel: 'Source Inventory', icon: PackageOpen, exact: false },
  { to: '/processing', label: 'ประมวลผล', sublabel: 'Processing', icon: Cpu, exact: false },
  { to: '/page-posts', label: 'โพสต์เพจ', sublabel: 'Page Posts', icon: Facebook, exact: false },
  { to: '/custom-link', label: 'คัสตอมลิงก์', sublabel: 'Custom Link', icon: Link2, exact: false },
  { to: '/campaigns', label: 'แคมเปญ', sublabel: 'Campaigns', icon: Megaphone, exact: false },
  { to: '/create-ads', label: 'สร้างแอด', sublabel: 'Create Ads', icon: Users, exact: false },
  { to: '/queue', label: 'คิวสร้างแอด', sublabel: 'Queue', icon: Clock, exact: false },
  { to: '/history', label: 'ประวัติ', sublabel: 'History', icon: MessageSquare, exact: false },
] as const

const SETTINGS_NAV: NavItem = {
  to: '/settings',
  label: 'ตั้งค่า',
  sublabel: 'Settings',
  icon: Settings,
  exact: false,
}

function NavLink({ item }: { item: NavItem }) {
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.exact }}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      activeProps={{ className: 'bg-primary/10 text-foreground font-medium hover:bg-primary/10 hover:text-foreground' }}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-foreground">{item.sublabel}</span>
        <span className="text-[11px] font-normal text-muted-foreground">{item.label}</span>
      </span>
    </Link>
  )
}

// True when this build is mounted at the canonical /dashboard space (after the
// worker cutover) rather than the /dashboard_next rollback alias. The same build
// serves both; in production (/dashboard) the header stays clean, while the
// rollback/preview alias surfaces a small badge so an operator can tell at a
// glance they are NOT on the canonical production mount.
function isPreviewMount(): boolean {
  if (typeof window === 'undefined') return false
  const path = window.location.pathname
  return !(path === '/dashboard' || path.startsWith('/dashboard/'))
}

// The topnav selector now reads/writes the shared WorkspaceProvider state so the
// selected workspace is the single source of truth across dashboard routes
// (notably Custom Link's affiliate preset). UI-only for now — selecting a
// workspace does NOT change API headers or data scoping yet; it only updates the
// visible label and the customlink affiliate id/email. Wiring it to request
// scoping is a separate, deliberate change.
function WorkspaceSelector() {
  const [open, setOpen] = useState(false)
  const { workspace, setWorkspace, workspaces } = useWorkspace()
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click while the menu is open.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="เลือก workspace"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        <span>{workspace}</span>
        <ChevronDown className="h-4 w-4 shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-lg border bg-popover p-1 shadow-md"
        >
          {workspaces.map((name) => (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={name === workspace}
              onClick={() => {
                setWorkspace(name)
                setOpen(false)
              }}
              className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              <span>{name}</span>
              {name === workspace ? <Check className="h-4 w-4 shrink-0" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const previewMount = isPreviewMount()
  return (
    <WorkspaceProvider>
      <AppShellLayout previewMount={previewMount}>{children}</AppShellLayout>
    </WorkspaceProvider>
  )
}

function AppShellLayout({
  children,
  previewMount,
}: {
  children: ReactNode
  previewMount: boolean
}) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Full-viewport-width topnav (Shopee-style): spans above the sidebar.
          Left brand area is sized to the sidebar width so it visually aligns
          with the nav column underneath it. */}
      <header className="flex h-16 shrink-0 items-center border-b bg-background/80 px-5 backdrop-blur">
        <div className="hidden w-64 shrink-0 items-center gap-2 md:flex">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            P
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">PUBILO</div>
            <div className="text-xs text-foreground">Dashboard</div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-semibold">PUBILO Dashboard</span>
          {previewMount ? (
            <Badge variant="secondary">preview · /dashboard_next</Badge>
          ) : null}
        </div>

        {/* Right-side topnav controls: language + workspace selector,
            generously spaced with a vertical divider between them. */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            aria-label="ภาษา"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <span>ไทย</span>
            <ChevronDown className="h-4 w-4 shrink-0" />
          </button>
          <span aria-hidden="true" className="h-6 w-px bg-border" />
          <WorkspaceSelector />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-card md:flex">
          <nav className="flex-1 space-y-1 overflow-y-auto p-3">
            {NAV.map((item) => (
              <NavLink key={item.to} item={item} />
            ))}
          </nav>
          <div className="space-y-1 border-t p-3">
            <NavLink item={SETTINGS_NAV} />
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto p-5">{children}</main>
      </div>
    </div>
  )
}
