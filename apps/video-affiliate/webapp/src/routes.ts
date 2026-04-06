import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
  index('routes/index.tsx', { id: 'routes/app-index' }),
  route('dashboard', 'routes/dashboard.tsx', { id: 'routes/app-dashboard' }),
  route('inbox', 'routes/inbox.tsx', { id: 'routes/app-inbox' }),
  route('processing', 'routes/processing.tsx', { id: 'routes/app-processing' }),
  route('gallery', 'routes/gallery.tsx', { id: 'routes/app-gallery' }),
  route('logs', 'routes/logs.tsx', { id: 'routes/app-logs' }),
  route('settings', 'routes/settings.tsx', { id: 'routes/app-settings' }),
  route('pages', 'routes/settings.tsx', { id: 'routes/app-pages-legacy' }),
  route('*', 'routes/catchall.tsx', { id: 'routes/app-catchall' }),
] satisfies RouteConfig
