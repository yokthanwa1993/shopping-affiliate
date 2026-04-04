import { defineConfig } from 'vite'
import { reactRouter } from '@react-router/dev/vite'
import path from 'path'

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
