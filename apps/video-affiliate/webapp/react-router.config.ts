import type { ReactRouterConfig } from '@react-router/dev/config'

export default {
  appDirectory: 'src',
  buildDirectory: 'dist',
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true,
  },
  routeDiscovery: {
    mode: 'initial',
  },
} satisfies ReactRouterConfig
