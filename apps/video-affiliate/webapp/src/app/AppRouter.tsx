import {
  RouterProvider,
  createBrowserRouter,
  redirect,
  type LoaderFunctionArgs,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import App from '../App'
import { APP_TAB_ROUTES, getAppTabPath, getAppTabRouteFromSearch, stripLegacyTabSearchParams, type AppTabRoute } from './appRoutes'

function AppRouteShell({ tab }: { tab: AppTabRoute }) {
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <App
      controlledTab={tab}
      onControlledTabChange={(nextTab) => {
        const nextPath = getAppTabPath(nextTab)
        const nextSearch = stripLegacyTabSearchParams(location.search)
        if (nextPath !== location.pathname || nextSearch !== location.search) {
          navigate({ pathname: nextPath, search: nextSearch })
        }
      }}
    />
  )
}

function makeTabLoader(tab: AppTabRoute) {
  return ({ request }: LoaderFunctionArgs) => {
    const url = new URL(request.url)
    const requested = getAppTabRouteFromSearch(url.search)
    if (requested !== 'dashboard' && requested !== tab) {
      throw redirect(`${getAppTabPath(requested)}${stripLegacyTabSearchParams(url.search)}`)
    }
    if (requested === 'dashboard' && (url.searchParams.has('tab') || url.searchParams.has('liff.state'))) {
      throw redirect(`${getAppTabPath(tab)}${stripLegacyTabSearchParams(url.search)}`)
    }
    return null
  }
}

function legacyLoader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const requested = getAppTabRouteFromSearch(url.search)
  throw redirect(`${getAppTabPath(requested)}${stripLegacyTabSearchParams(url.search)}`)
}

const router = createBrowserRouter([
  {
    path: '/',
    loader: makeTabLoader('dashboard'),
    element: <AppRouteShell tab="dashboard" />,
  },
  ...APP_TAB_ROUTES
    .filter((tab) => tab !== 'dashboard')
    .map((tab) => ({
      path: `/${tab}`,
      loader: makeTabLoader(tab),
      element: <AppRouteShell tab={tab} />,
    })),
  {
    path: '*',
    loader: legacyLoader,
    element: <AppRouteShell tab="dashboard" />,
  },
])

export function AppRouter() {
  return <RouterProvider router={router} />
}
