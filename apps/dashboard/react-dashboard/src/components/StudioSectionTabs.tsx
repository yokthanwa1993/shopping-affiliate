import { Link } from '@tanstack/react-router'

// Segmented tab bar for the Studio "คลิปจีน" (Chinese Clips) folder. Renders near
// the top of the Source Inventory / Processing / Gallery pages so an operator can
// jump between the three views without going back to the sidebar — mirroring the
// rounded light container + active blue pill from the reference design. Each tab
// routes to an existing dashboard page; the active pill is driven by the router's
// own active-link matching so it tracks the URL automatically.
const STUDIO_TABS: ReadonlyArray<{ to: string; label: string }> = [
  { to: '/source-inventory', label: 'คลังต้นฉบับ' },
  { to: '/processing', label: 'Processing' },
  { to: '/gallery', label: 'แกลลี่' },
]

export function StudioSectionTabs() {
  return (
    <div className="inline-flex items-center gap-1 rounded-xl bg-[#f1f3f5] p-1">
      {STUDIO_TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          activeOptions={{ exact: false }}
          className="rounded-lg px-4 py-1.5 text-sm font-medium text-[#4b5563] transition-colors hover:text-[#1f2937]"
          activeProps={{
            className: 'bg-[#2563eb] text-white shadow-sm hover:text-white',
          }}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  )
}
