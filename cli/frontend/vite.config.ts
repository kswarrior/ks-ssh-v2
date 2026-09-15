import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Single-file relay bundle (ui.rs inlines everything) is ~790kB by design —
// raise the warning limit so `vite build`/`preview` stays clean without
// hiding real regressions elsewhere.
export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 900 },
})
