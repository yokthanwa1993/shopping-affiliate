import { index, route, type RouteConfig } from '@react-router/dev/routes'

export default [
  index('routes/host.tsx', { id: 'routes/app-index' }),
  route('dashboard', 'routes/host.tsx', { id: 'routes/app-dashboard' }),
  route('inbox', 'routes/host.tsx', { id: 'routes/app-inbox' }),
  route('processing', 'routes/host.tsx', { id: 'routes/app-processing' }),
  route('gallery', 'routes/host.tsx', { id: 'routes/app-gallery' }),
  route('logs', 'routes/host.tsx', { id: 'routes/app-logs' }),
  route('settings', 'routes/host.tsx', { id: 'routes/app-settings' }),
  route('*', 'routes/host.tsx', { id: 'routes/app-catchall' }),
] satisfies RouteConfig
