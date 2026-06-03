import { defineConfig } from 'astro/config'
import svelte from '@astrojs/svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  output: 'static',
  outDir: './dist',
  integrations: [svelte()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        '/worker-api': {
          target: 'https://api.pubilo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/worker-api/, ''),
        },
      },
    },
  },
})
