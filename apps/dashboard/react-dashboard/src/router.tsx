import type { ReactNode } from 'react'
import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import { AppShell } from '@/components/AppShell'
import { OverviewPage } from '@/routes/overview'
import { GalleryPage } from '@/routes/gallery'
import { SourceInventoryPage } from '@/routes/source-inventory'
import { ProcessingPage } from '@/routes/processing'
import { PagePostsPage } from '@/routes/page-posts'
import { CustomLinkPage } from '@/routes/custom-link'
import { CampaignsPage } from '@/routes/campaigns'
import { CreatePostPage } from '@/routes/create-post'
import { CreateAdsPage } from '@/routes/create-ads'
import { QueuePage } from '@/routes/queue'
import { HistoryPage } from '@/routes/history'
import { SettingsPage } from '@/routes/settings'

// Basepath derives from Vite's `base` (/dashboard_next/) for the preview mount,
// but the SAME build is also served at the canonical /dashboard/* space once the
// worker cutover (DASHBOARD_REACT_CUTOVER) is on. Detect the mount at runtime
// from the entry URL so <Link> targets and route matching stay correct under
// either prefix without a second build. Hashed assets are always referenced at
// the absolute /dashboard_next/assets/* path (Vite `base`), so they load the
// same regardless of which prefix served index.html — only the router prefix
// has to adapt here.
const BUILD_BASE = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/'

function resolveBasepath(): string {
  if (typeof window === 'undefined') return BUILD_BASE
  const path = window.location.pathname
  if (path === '/dashboard' || path.startsWith('/dashboard/')) return '/dashboard'
  return BUILD_BASE
}

const basepath = resolveBasepath()

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
})

// Each route mirrors a production dashboard path. Aliases reuse the same page
// component so e.g. /page_posts and /page-posts render identically. The `const`
// path generic preserves the literal so TanStack Router can type-check <Link to>.
function page<const TPath extends string>(path: TPath, component: () => ReactNode) {
  return createRoute({ getParentRoute: () => rootRoute, path, component })
}

const overviewRoute = page('/', OverviewPage)
const galleryRoute = page('/gallery', GalleryPage)
const sourceInventoryRoute = page('/source-inventory', SourceInventoryPage)
// Production exposes the source inventory under both /source-inventory and the
// legacy /inbox + /source-processing slugs — alias them to the same page.
const inboxRoute = page('/inbox', SourceInventoryPage)
const sourceProcessingRoute = page('/source-processing', SourceInventoryPage)
const processingRoute = page('/processing', ProcessingPage)
const pagePostsRoute = page('/page-posts', PagePostsPage)
// Production nav links to /page_posts (underscore); keep it as an alias.
const pagePostsAliasRoute = page('/page_posts', PagePostsPage)
const customLinkRoute = page('/custom-link', CustomLinkPage)
const campaignsRoute = page('/campaigns', CampaignsPage)
const createPostRoute = page('/create-post', CreatePostPage)
const createAdsRoute = page('/create-ads', CreateAdsPage)
const queueRoute = page('/queue', QueuePage)
const historyRoute = page('/history', HistoryPage)
const settingsRoute = page('/settings', SettingsPage)

const routeTree = rootRoute.addChildren([
  overviewRoute,
  galleryRoute,
  sourceInventoryRoute,
  inboxRoute,
  sourceProcessingRoute,
  processingRoute,
  pagePostsRoute,
  pagePostsAliasRoute,
  customLinkRoute,
  campaignsRoute,
  createPostRoute,
  createAdsRoute,
  queueRoute,
  historyRoute,
  settingsRoute,
])

export const router = createRouter({
  routeTree,
  basepath,
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
