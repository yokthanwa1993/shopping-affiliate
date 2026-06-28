import { useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Check,
  ChevronDown,
  Clock,
  Cpu,
  Facebook,
  Film,
  Layers,
  LayoutDashboard,
  Link2,
  Megaphone,
  MessageSquare,
  PackageOpen,
  PenSquare,
  Settings,
  UserCog,
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

type NavGroup = {
  // Shopee groups its sidebar under gray/bold section headers (Offer, Campaign,
  // Report …). We keep every existing route + label, just clustered to mirror
  // that visual rhythm. `title: null` renders the group flush (the top
  // Dashboard entry), matching the screenshot's lead item.
  title: string | null
  items: readonly NavItem[]
}

// Mirrors the production Astro sidebar routes (apps/dashboard/src/layouts/Layout.astro)
// so every ported /dashboard_next/* route stays reachable from the nav. Same
// labels as before — only the grouping/skin changed to resemble the Shopee
// Affiliate dashboard. Settings stays pinned to the footer.
const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: null,
    items: [{ to: '/', label: 'ภาพรวม', sublabel: 'Dashboard', icon: LayoutDashboard, exact: true }],
  },
  {
    title: 'คอนเทนต์ · Content',
    items: [
      { to: '/source-inventory', label: 'คลังต้นฉบับ', sublabel: 'Source Inventory', icon: PackageOpen, exact: false },
      { to: '/processing', label: 'ประมวลผล', sublabel: 'Processing', icon: Cpu, exact: false },
      { to: '/gallery', label: 'แกลลี่', sublabel: 'Gallery', icon: Layers, exact: false },
      { to: '/media-library', label: 'คลังสื่อ', sublabel: 'Media Library', icon: Film, exact: false },
    ],
  },
  {
    title: 'เผยแพร่ · Publish',
    items: [
      { to: '/create-post', label: 'สร้างโพสต์', sublabel: 'Create Post', icon: PenSquare, exact: false },
      { to: '/create-ads', label: 'สร้างแอด', sublabel: 'Create Ads', icon: Users, exact: false },
      { to: '/page-posts', label: 'โพสต์เพจ', sublabel: 'Page Posts', icon: Facebook, exact: false },
    ],
  },
  {
    title: 'เครื่องมือ · Tools',
    items: [
      { to: '/custom-link', label: 'คัสตอมลิงก์', sublabel: 'Custom Link', icon: Link2, exact: false },
      { to: '/campaigns', label: 'แคมเปญ', sublabel: 'Campaigns', icon: Megaphone, exact: false },
      { to: '/queue', label: 'คิวสร้างแอด', sublabel: 'Queue', icon: Clock, exact: false },
    ],
  },
  {
    title: 'กิจกรรม · Activity',
    items: [{ to: '/history', label: 'ประวัติ', sublabel: 'History', icon: MessageSquare, exact: false }],
  },
] as const

// Account/user management lives on the dashboard now and drives the local Accounts Bridge (the token
// pool on this Mac). Pinned to the footer just before Settings.
const ACCOUNTS_NAV: NavItem = {
  to: '/accounts',
  label: 'บัญชี',
  sublabel: 'Accounts',
  icon: UserCog,
  exact: false,
}

const SETTINGS_NAV: NavItem = {
  to: '/settings',
  label: 'ตั้งค่า',
  sublabel: 'Settings',
  icon: Settings,
  exact: false,
}

// Shopee active-row treatment: pale-orange wash, orange text/icon, and a thick
// orange right rail. Inactive rows are flat dark-gray with a light hover. The
// icon inherits `currentColor`, so it flips orange together with the label.
function NavLink({ item }: { item: NavItem }) {
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.exact }}
      className="flex items-center gap-2.5 border-r-[3px] border-transparent px-4 py-2 text-[#333333] transition-colors hover:bg-[#f5f5f5]"
      activeProps={{
        className:
          '!border-r-[#ee4d2d] bg-[#fff5f2] text-[#ee4d2d] hover:bg-[#fff5f2]',
      }}
    >
      <item.icon className="h-[18px] w-[18px] shrink-0" />
      <span className="flex flex-col leading-tight">
        <span className="text-[13px] font-medium">{item.sublabel}</span>
        <span className="text-[11px] font-normal text-[#999999]">{item.label}</span>
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
        className="flex items-center gap-1.5 rounded-[2px] px-2.5 py-1.5 text-sm font-medium text-[#333333] transition-colors hover:bg-[#f5f5f5]"
      >
        <span>{workspace}</span>
        <ChevronDown className="h-4 w-4 shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-[2px] border bg-popover p-1 shadow-md"
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
              className="flex w-full items-center justify-between rounded-[2px] px-3 py-1.5 text-left text-sm text-[#333333] transition-colors hover:bg-[#f5f5f5]"
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
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f5f5f5]">
      {/* Full-width 56px Shopee-style header: white, thin border, brand pinned
          to the 200px sidebar column on the left so it aligns with the nav. */}
      <header className="flex h-14 shrink-0 items-center border-b border-[#ededed] bg-white px-5">
        <div className="hidden w-[200px] shrink-0 items-center gap-2 md:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-[2px] bg-[#ee4d2d] text-sm font-bold text-white">
            P
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight text-[#333333]">PUBILO</div>
            <div className="text-[11px] text-[#999999]">Affiliate Dashboard</div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-semibold text-[#333333] md:hidden">PUBILO</span>
          {previewMount ? (
            <Badge variant="secondary">preview · /dashboard_next</Badge>
          ) : null}
        </div>

        {/* Right-side controls: language + workspace selector + Help Center pill,
            minimal dark text to match the Shopee header. */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="ภาษา"
            className="flex items-center gap-1.5 rounded-[2px] px-2.5 py-1.5 text-sm font-medium text-[#333333] transition-colors hover:bg-[#f5f5f5]"
          >
            <span>ไทย</span>
            <ChevronDown className="h-4 w-4 shrink-0" />
          </button>
          <span aria-hidden="true" className="h-5 w-px bg-[#ededed]" />
          <WorkspaceSelector />
          <span aria-hidden="true" className="h-5 w-px bg-[#ededed]" />
          <a
            href="https://api.pubilo.com"
            target="_blank"
            rel="noreferrer"
            className="rounded-[2px] border border-[#ededed] px-2.5 py-1.5 text-xs font-medium text-[#666666] transition-colors hover:border-[#ee4d2d] hover:text-[#ee4d2d]"
          >
            Help Center
          </a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[200px] shrink-0 flex-col border-r border-[#ededed] bg-white md:flex">
          <nav className="flex-1 space-y-3 overflow-y-auto py-3">
            {NAV_GROUPS.map((group, index) => (
              <div key={group.title ?? `group-${index}`} className="space-y-0.5">
                {group.title ? (
                  <div className="flex items-center justify-between px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[#999999]">
                    <span>{group.title}</span>
                    <ChevronDown className="h-3 w-3" />
                  </div>
                ) : null}
                {group.items.map((item) => (
                  <NavLink key={item.to} item={item} />
                ))}
              </div>
            ))}
          </nav>
          <div className="border-t border-[#ededed] py-2">
            <NavLink item={ACCOUNTS_NAV} />
            <NavLink item={SETTINGS_NAV} />
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-[#f5f5f5] p-6">{children}</main>
      </div>
    </div>
  )
}
