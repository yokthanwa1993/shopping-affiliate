import type { DashboardData } from '../sharedTypes'

export function DashboardTab({
  dashboardDateFilter,
  onDashboardDateChange,
  onSelectToday,
  dashboardLoading,
  dashboardData,
}: {
  dashboardDateFilter: string
  onDashboardDateChange: (value: string) => void
  onSelectToday: () => void
  dashboardLoading: boolean
  dashboardData: DashboardData | null
}) {
  return (
    <div className="px-4 space-y-4">
      <div className="bg-white border border-gray-200 rounded-2xl p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              type="date"
              value={dashboardDateFilter}
              onChange={(e) => onDashboardDateChange(e.target.value)}
              className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
            />
            <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 flex items-center gap-3 active:scale-95 transition-all">
              <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-[11px] text-gray-400 font-medium">เลือกวันที่รายงาน</p>
                <p className="text-sm font-bold text-gray-900">{dashboardDateFilter}</p>
              </div>
            </div>
          </div>
          <button
            onClick={onSelectToday}
            className="shrink-0 bg-blue-500 text-white px-4 py-3 rounded-2xl text-sm font-bold active:scale-95 transition-all shadow-sm shadow-blue-200"
          >
            วันนี้
          </button>
        </div>
      </div>

      {dashboardLoading && !dashboardData ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-2xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <p className="text-xs text-gray-400 font-semibold">โพสต์ทั้งหมด</p>
              <p className="mt-2 text-2xl font-extrabold text-gray-900">{dashboardData?.totals.posts_all || 0}</p>
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <p className="text-xs text-gray-400 font-semibold">โพสต์วันนี้</p>
              <p className="mt-2 text-2xl font-extrabold text-blue-600">{dashboardData?.totals.posts_on_date || 0}</p>
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <p className="text-xs text-gray-400 font-semibold">ลิงก์ทั้งหมด</p>
              <p className="mt-2 text-2xl font-extrabold text-gray-900">{dashboardData?.totals.links_all || 0}</p>
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
              <p className="text-xs text-gray-400 font-semibold">ลิงก์วันนี้</p>
              <p className="mt-2 text-2xl font-extrabold text-emerald-600">{dashboardData?.totals.links_on_date || 0}</p>
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
            <p className="text-sm font-bold text-gray-900 mb-3">ผู้ส่งลิงก์ต่อวัน</p>
            {dashboardData?.admins?.length ? (
              <div className="space-y-2">
                {dashboardData.admins.map((admin) => (
                  <div key={`${admin.telegram_id}:${admin.email}`} className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2">
                    <div className="min-w-0 flex items-center gap-3">
                      {admin.picture_url ? (
                        <img src={admin.picture_url} className="h-10 w-10 rounded-full object-cover shrink-0" />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-600">
                          {(String(admin.display_name || admin.line_user_id || '?').trim().charAt(0) || '?').toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{admin.display_name || admin.line_user_id || 'LINE User'}</p>
                        <p className="text-[11px] text-gray-400 truncate">
                          {admin.line_user_id ? `LINE UID: ${admin.line_user_id}` : `TG ID: ${admin.telegram_id}`}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs font-bold text-white bg-black px-2.5 py-1 rounded-full">{admin.links} ลิงก์</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">ยังไม่มีข้อมูลลิงก์ในวันที่เลือก</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
