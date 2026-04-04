import { useLocation, useNavigate } from 'react-router'

import App from '../App'
import { APP_TAB_ROUTES, getAppTabPath, stripLegacyTabSearchParams, type AppTabRoute } from '../app/appRoutes'
import { isAppHost } from '../liffConfig'

const APP_TABS = new Set<AppTabRoute>(APP_TAB_ROUTES)

function getTabFromPathname(pathname: string): AppTabRoute {
  const segment = pathname.replace(/^\/+/, '').split('/')[0]
  return APP_TABS.has(segment as AppTabRoute) ? (segment as AppTabRoute) : 'dashboard'
}

export default function HostRoute() {
  const location = useLocation()
  const navigate = useNavigate()

  if (!isAppHost()) {
    return <App />
  }

  const tab = getTabFromPathname(location.pathname)

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
