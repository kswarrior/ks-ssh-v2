import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../../packages/types') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8090', changeOrigin: false },
      '/port': { target: 'http://localhost:8090', changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 4000,
  },
})
