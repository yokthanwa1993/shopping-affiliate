import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { fetchSettingsPages, type SettingsPage } from '@/api/settings'
import { PagePicker } from '@/components/PagePicker'
import { PageDetailView } from '@/routes/settings'

// Create Post — POST-ONLY console.
//
// The operator picks a page from the master list, then lands on a Mini App-like
// Page settings/detail screen scoped to NORMAL Facebook Page/Reels posting.
// That detail is the shared PageDetailView rendered in `mode="postOnly"`: the
// Video One Card and Auto-Ads surfaces are hidden, and on save oneCardEnabled /
// adsPublishEnabled are forced false — so this screen can never enable ad
// behavior. Campaign / Ad Set / paid-ad configuration lives entirely on Create
// Ads; the post-only ad-config surfaces will move there later.

export function CreatePostPage() {
  // Master-detail: no page is auto-selected. The operator must pick a page from
  // the list first; only then does the post-only detail screen come alive.
  const [selectedId, setSelectedId] = useState<string>('')

  const pagesQuery = useQuery({
    queryKey: ['settings-pages'],
    queryFn: ({ signal }) => fetchSettingsPages(signal),
  })

  const pages = pagesQuery.data ?? ([] as SettingsPage[])
  const selectedPage = pages.find((p) => p.id === selectedId) ?? null

  if (selectedPage) {
    // DETAIL — Mini App-like page settings, normal posting only. PageDetailView
    // renders its own centered avatar/name/id header with back/close (→ master).
    return (
      <div className="mx-auto w-full max-w-lg pb-10 lg:max-w-5xl xl:max-w-6xl">
        <PageDetailView
          page={selectedPage}
          canEdit
          mode="postOnly"
          onBack={() => setSelectedId('')}
        />
      </div>
    )
  }

  return (
    // Master (no page selected) breaks out of the shell's p-5 to become
    // full-bleed: the page-list card fills the whole content rect.
    <div className="-m-5 flex min-h-full flex-col gap-4 p-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">สร้างโพสต์เพจ</h1>
        <p className="text-sm text-muted-foreground">
          เลือกเพจ แล้วตั้งค่าการโพสต์ลงเพจ — หน้านี้ทำงานกับ “โพสต์” อย่างเดียว
        </p>
      </div>

      {/* Separation guarantee — explicit, always visible on the master view. */}
      <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-semibold">หน้านี้ตั้งค่าและโพสต์ลงเพจเท่านั้น</p>
          <p className="text-amber-800">
            ไม่มี Video One Card / ไม่สร้างแคมเปญ / Ad Set / โฆษณา — หากต้องการสร้างแอด ให้ไปที่{' '}
            <Link to="/create-ads" className="font-semibold underline">
              หน้าสร้างแอด
            </Link>
          </p>
        </div>
      </div>

      {/* MASTER — page list first. No detail renders until a page is chosen. */}
      <section className="flex min-h-0 flex-1 flex-col gap-3">
        <p className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
            1
          </span>
          แตะเพจที่ต้องการเพื่อเปิดหน้าตั้งค่าการโพสต์
        </p>
        <div className="min-h-0 flex-1">
          <PagePicker
            pages={pages}
            selectedId={null}
            onSelect={(p) => setSelectedId(p.id)}
            loading={pagesQuery.isLoading}
            error={pagesQuery.isError}
            searchable
            layout="table"
            fill
            title="เลือกเพจสำหรับตั้งค่าการโพสต์"
          />
        </div>
      </section>
    </div>
  )
}
