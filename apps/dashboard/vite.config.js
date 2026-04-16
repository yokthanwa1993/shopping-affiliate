import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        host: '0.0.0.0',
        port: 4174,
        proxy: {
            '/electron': {
                target: 'http://localhost:3847',
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/electron/, ''); },
            },
            '/facebook-graph': {
                target: 'https://graph.facebook.com',
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/facebook-graph/, ''); },
            },
            '/worker-api': {
                target: 'https://api.oomnn.com',
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/worker-api/, ''); },
            },
        },
    },
});
