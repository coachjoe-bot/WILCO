import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // react/react-dom in their own chunk: its hash is stable across app-only
        // deploys, so with the SW's cache-first /assets/ strategy a returning user
        // re-downloads just the app code after a deploy, not the framework.
        manualChunks: { "vendor-react": ["react", "react-dom"] }
      }
    }
  }
})
