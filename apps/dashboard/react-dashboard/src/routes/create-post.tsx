import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchSettingsPages, updatePageActive, type SettingsPage } from '@/api/settings'
import { PagePicker } from '@/components/PagePicker'
import { PageDetailView } from '@/routes/settings'

// Create Post — token-source console.
//
// The operator picks a page from the master list, then lands on a compact
// detail screen scoped to ONE decision per page: which token source to use for
// posting and which for commenting. That detail is the shared PageDetailView
// rendered in `mode="tokenSourcesOnly"`: only the two source selectors
// (โทเค้นสำหรับโพสต์ / โทเค้นสำหรับคอมเมนต์) + Save are shown, and on save ONLY
// postingTokenSource / commentTokenSource are persisted (every other core field
// is written back from its loaded base value). All full per-page setup —
// schedule, Shortlink, posting order, Avatar, Video One Card, etc. — lives in
// Settings > Pages.

export function CreatePostPage() {
  // Master-detail: no page is auto-selected. The operator must pick a page from
  // the list first; only then does the post-only detail screen come alive.
  const [selectedId, setSelectedId] = useState<string>('')
  const queryClient = useQueryClient()

  const pagesQuery = useQuery({
    queryKey: ['settings-pages'],
    queryFn: ({ signal }) => fetchSettingsPages(signal),
  })

  // Toggle a page's posting on/off straight from the master list. We optimistically
  // flip page.active in the cached list so the row greys/ungreys instantly, then
  // reconcile against the server (rolling back on error, invalidating on settle).
  const toggleActive = useMutation({
    mutationFn: ({ pageId, active }: { pageId: string; active: boolean }) =>
      updatePageActive(pageId, active),
    onMutate: async ({ pageId, active }) => {
      await queryClient.cancelQueries({ queryKey: ['settings-pages'] })
      const previous = queryClient.getQueryData<SettingsPage[]>(['settings-pages'])
      queryClient.setQueryData<SettingsPage[]>(['settings-pages'], (old) =>
        (old ?? []).map((p) => (p.id === pageId ? { ...p, active } : p)),
      )
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['settings-pages'], context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-pages'] })
    },
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
          mode="tokenSourcesOnly"
          onBack={() => setSelectedId('')}
        />
      </div>
    )
  }

  return (
    // Master (no page selected) breaks out of the shell's p-5 to become
    // full-bleed: the page-list card fills the whole content rect.
    <div className="-m-5 flex min-h-full flex-col gap-4 p-4">
      {/* MASTER — page list first. No detail renders until a page is chosen. */}
      <section className="flex min-h-0 flex-1 flex-col gap-3">
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
            onToggleActive={(p, active) => toggleActive.mutate({ pageId: p.id, active })}
            pendingToggleId={toggleActive.isPending ? toggleActive.variables?.pageId ?? null : null}
          />
        </div>
      </section>
    </div>
  )
}
