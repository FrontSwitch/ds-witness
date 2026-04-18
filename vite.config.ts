import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: !!process.env.TAURI_ENV_DEBUG,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'safari14',
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  optimizeDeps: {
    include: ['sql.js'],
  },
})
