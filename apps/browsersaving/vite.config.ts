import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/launcher': {
        target: 'http://127.0.0.1:3456',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/launcher/, ''),
        ws: true,
      },
      '/token-svc': {
        target: 'http://127.0.0.1:3457',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/token-svc/, ''),
      },
    },
  },
})
