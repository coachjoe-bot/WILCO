import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Emits /asset-manifest.json listing every hashed /assets/ file in the current
// build. public/sw.js fetches it to prune dead hashed chunks from CacheStorage
// (the wilco-v4 cache is cache-first for /assets/, so without pruning every
// deploy permanently leaks its old chunks into the cache).
function assetManifest() {
  return {
    name: 'wilco-asset-manifest',
    generateBundle(_, bundle) {
      const assets = Object.keys(bundle).map(f => '/' + f).filter(p => p.startsWith('/assets/'))
      this.emitFile({
        type: 'asset',
        fileName: 'asset-manifest.json',
        source: JSON.stringify({ generated: Date.now(), assets })
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), assetManifest()],
  server: {
    // Dev-only: vite doesn't serve the Vercel api/* functions, so proxy them to
    // prod — same-origin from the app's point of view, real auth + AI in local dev.
    proxy: { "/api": { target: "https://app.trainwilco.com", changeOrigin: true } }
  },
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
