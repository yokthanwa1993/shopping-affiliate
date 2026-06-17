import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

// Target mount path under the existing dashboard worker assets.
// Keeping a non-root base means the built asset URLs already point at
// /dashboard_next/... so wiring it into the worker later is a pure
// routing/whitelist change (see README "Wiring into the worker").
const BASE = '/dashboard_next/'

// Dev proxies mirror the existing Astro dashboard topology:
//   - /worker-api/*      -> video-affiliate worker (read APIs, e.g. page_posts)
//   - /customlink-api/*  -> dashboard worker (Shopee shortlink minting)
// Both are overridable via env so nobody hits production by accident.
const WORKER_API_TARGET = process.env.DASHBOARD_WORKER_API ?? 'https://api.pubilo.com'
const CUSTOMLINK_API_TARGET = process.env.DASHBOARD_CUSTOMLINK_API ?? 'https://www.pubilo.com'

export default defineConfig({
  base: BASE,
  plugins: [react(), tsconfigPaths()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/worker-api': {
        target: WORKER_API_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/worker-api/, ''),
      },
      '/customlink-api': {
        target: CUSTOMLINK_API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
