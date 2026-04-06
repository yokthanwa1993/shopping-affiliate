import { redirect, useLoaderData, useLocation, useNavigate, type LoaderFunctionArgs } from 'react-router'

import App from '../App'
import {
  getAppTabPath,
  getAppTabRouteFromLocation,
  getAppTabRouteFromSearch,
  stripLegacyTabSearchParams,
  type AppTabRoute,
} from '../app/appRoutes'
import { isAppHost } from '../liffConfig'

type AppShellLoaderData = {
  tab: AppTabRoute
}

export function makeAppTabLoader(tab: AppTabRoute) {
  return ({ request }: LoaderFunctionArgs) => {
    const url = new URL(request.url)
    const requested = getAppTabRouteFromSearch(url.search)
    if (requested !== 'dashboard' && requested !== tab) {
      throw redirect(`${getAppTabPath(requested)}${stripLegacyTabSearchParams(url.search)}`)
    }
    if (requested === 'dashboard' && (url.searchParams.has('tab') || url.searchParams.has('liff.state'))) {
      throw redirect(`${getAppTabPath(tab)}${stripLegacyTabSearchParams(url.search)}`)
    }
    return { tab } satisfies AppShellLoaderData
  }
}

export function legacyCatchAllLoader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const requested = getAppTabRouteFromSearch(url.search)
  throw redirect(`${getAppTabPath(requested)}${stripLegacyTabSearchParams(url.search)}`)
}

export default function AppShellRoute() {
  const { tab } = useLoaderData<typeof makeAppTabLoader extends never ? never : AppShellLoaderData>()
  const location = useLocation()
  const navigate = useNavigate()

  if (!isAppHost()) {
    return <App />
  }

  const controlledTab = getAppTabRouteFromLocation(location.pathname, location.search) || tab

  return (
    <App
      controlledTab={controlledTab}
      controlledLocationKey={`${location.pathname}${location.search}`}
      onControlledTabChange={(nextTab) => {
        const nextPath = getAppTabPath(nextTab)
        const nextSearch = stripLegacyTabSearchParams(location.search)
        if (nextPath !== location.pathname || nextSearch !== location.search) {
          navigate({ pathname: nextPath, search: nextSearch })
        }
      }}
      onControlledUrlChange={(nextUrl, historyMode) => {
        const parsed = new URL(nextUrl)
        const nextPath = parsed.pathname
        const nextSearch = parsed.search
        if (nextPath !== location.pathname || nextSearch !== location.search) {
          navigate(
            { pathname: nextPath, search: nextSearch },
            { replace: historyMode === 'replace' },
          )
        }
      }}
    />
  )
}
