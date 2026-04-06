import type { ReactRouterConfig } from '@react-router/dev/config'

export default {
  appDirectory: 'src',
  buildDirectory: 'dist',
  ssr: true,
  routeDiscovery: {
    mode: 'initial',
  },
} satisfies ReactRouterConfig
