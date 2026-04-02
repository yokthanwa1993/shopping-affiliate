import type { ReactNode } from 'react'

export type BottomNavTab = 'dashboard' | 'inbox' | 'processing' | 'gallery' | 'logs' | 'settings'

const DashboardIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M4 20V10M10 20V4M16 20v-7M22 20v-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const DashboardIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 10a1 1 0 011-1h1.5a1 1 0 011 1v10H4a1 1 0 01-1-1v-9zM9 4a1 1 0 011-1h1.5a1 1 0 011 1v16H9V4zM15 13a1 1 0 011-1h1.5a1 1 0 011 1v7H15v-7zM21 16a1 1 0 011-1h.5a1 1 0 011 1v4h-1.5a1 1 0 01-1-1v-3z" />
  </svg>
)
const InboxIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M4 5.5h16v10.5a2 2 0 01-2 2H6a2 2 0 01-2-2V5.5z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 14h4l2 3h4l2-3h4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 8v4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9.5 10.5L12 13l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const InboxIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v9.5a2.5 2.5 0 01-2.5 2.5h-2.36a1 1 0 00-.8.4L13.5 19a1 1 0 01-1.6 0l-1.84-2.45a1 1 0 00-.8-.4H6.5A2.5 2.5 0 014 13.5V5zm8 2.75a.75.75 0 00-.75.75v2.69l-.72-.72a.75.75 0 10-1.06 1.06l2 2a.75.75 0 001.06 0l2-2a.75.75 0 10-1.06-1.06l-.72.72V8.5a.75.75 0 00-.75-.75z" />
  </svg>
)
const VideoIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const VideoIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 6a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 14l5.293 2.646A1 1 0 0021 15.75V8.25a1 1 0 00-1.707-.896L14 10v4z" />
  </svg>
)
const ProcessIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
  </svg>
)
const ProcessIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M4.755 10.059a7.5 7.5 0 0112.548-3.364l1.903 1.903h-3.183a.75.75 0 100 1.5h4.992a.75.75 0 00.75-.75V4.356a.75.75 0 00-1.5 0v3.18l-1.9-1.9A9 9 0 003.306 9.67a.75.75 0 101.45.388zm15.408 3.352a.75.75 0 00-.919.53 7.5 7.5 0 01-12.548 3.364l-1.902-1.903h3.183a.75.75 0 000-1.5H2.984a.75.75 0 00-.75.75v4.992a.75.75 0 001.5 0v-3.18l1.9 1.9a9 9 0 0015.059-4.035.75.75 0 00-.53-.918z" clipRule="evenodd" />
  </svg>
)
const ListIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const ListIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M3 5.25a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H3.75A.75.75 0 013 5.25zm0 4.5A.75.75 0 013.75 9h16.5a.75.75 0 010 1.5H3.75A.75.75 0 013 9.75zm0 4.5a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75zm0 4.5a.75.75 0 01.75-.75h16.5a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
  </svg>
)
const SettingsIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const SettingsIconFilled = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 00-.986.57c-.166.115-.334.126-.45.083L6.3 5.508a1.875 1.875 0 00-2.282.819l-.922 1.597a1.875 1.875 0 00.432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 000 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 00-.432 2.385l.922 1.597a1.875 1.875 0 002.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 002.28-.819l.923-1.597a1.875 1.875 0 00-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 000-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 00-2.282-.818l-1.02.382c-.114.043-.282.031-.449-.083a7.49 7.49 0 00-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 00-1.85-1.567h-1.843zM12 15.75a3.75 3.75 0 100-7.5 3.75 3.75 0 000 7.5z" clipRule="evenodd" />
  </svg>
)

function NavItem({ icon, iconActive, label, active, onClick }: {
  icon: ReactNode
  iconActive: ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex-1 py-2 flex flex-col items-center relative group"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div className={`text-5xl mb-0.5 transition-all duration-300 ${active ? 'text-blue-600 scale-110' : 'text-gray-400 group-active:scale-95'}`}>
        {active ? iconActive : icon}
      </div>
      <span className={`text-[10px] font-bold tracking-wide transition-colors ${active ? 'text-blue-600' : 'text-gray-400'}`}>
        {label}
      </span>
      {active && (
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-blue-600 rounded-b-lg shadow-blue-400 shadow-[0_0_10px_rgba(37,99,235,0.5)]" />
      )}
    </button>
  )
}

export function BottomNav({
  tab,
  onChangeTab,
}: {
  tab: BottomNavTab
  onChangeTab: (tab: BottomNavTab) => void
}) {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 z-40"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex pt-1 pb-0">
        <NavItem icon={<DashboardIcon />} iconActive={<DashboardIconFilled />} label="แดชบอร์ด" active={tab === 'dashboard'} onClick={() => onChangeTab('dashboard')} />
        <NavItem icon={<InboxIcon />} iconActive={<InboxIconFilled />} label="ต้นฉบับ" active={tab === 'inbox'} onClick={() => onChangeTab('inbox')} />
        <NavItem icon={<ProcessIcon />} iconActive={<ProcessIconFilled />} label="ประมวลผล" active={tab === 'processing'} onClick={() => onChangeTab('processing')} />
        <NavItem icon={<VideoIcon />} iconActive={<VideoIconFilled />} label="แกลลี่" active={tab === 'gallery'} onClick={() => onChangeTab('gallery')} />
        <NavItem icon={<ListIcon />} iconActive={<ListIconFilled />} label="ประวัติ" active={tab === 'logs'} onClick={() => onChangeTab('logs')} />
        <NavItem icon={<SettingsIcon />} iconActive={<SettingsIconFilled />} label="ตั้งค่า" active={tab === 'settings'} onClick={() => onChangeTab('settings')} />
      </div>
    </div>
  )
}
