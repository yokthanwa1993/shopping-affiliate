import type { ReactRouterConfig } from '@react-router/dev/config'

export default {
  appDirectory: 'src',
  buildDirectory: 'dist',
  ssr: false,
  routeDiscovery: {
    mode: 'initial',
  },
} satisfies ReactRouterConfig
