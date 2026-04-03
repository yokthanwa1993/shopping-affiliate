import { useEffect } from 'react'
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import App from '../App'
import { getAppTabPath, getAppTabRouteFromLocation } from './appRoutes'

function AppRouteShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const tab = getAppTabRouteFromLocation(location.pathname, location.search)

  useEffect(() => {
    const expectedPath = getAppTabPath(tab)
    if (expectedPath !== location.pathname) {
      navigate({ pathname: expectedPath, search: location.search }, { replace: true })
    }
  }, [location.pathname, location.search, navigate, tab])

  return (
    <App
      controlledTab={tab}
      onControlledTabChange={(nextTab) => {
        const nextPath = getAppTabPath(nextTab)
        if (nextPath !== location.pathname) navigate(nextPath)
      }}
    />
  )
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<AppRouteShell />} />
      </Routes>
    </BrowserRouter>
  )
}
