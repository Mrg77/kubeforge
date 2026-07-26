import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// KubeForge frontend build config.
// - Builds into ../dist, which the Go binary embeds (go:embed all:dist).
// - In dev (`npm run dev`), proxies /api to the Go server on :7777 so the
//   frontend and backend feel like one origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7777',
    },
  },
})
