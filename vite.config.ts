import { resolve } from 'node:path'
import { crx } from '@crxjs/vite-plugin'
import { defineConfig } from 'vite'
import manifest from './src/manifest.json'

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // CRXJS injects a loading page that pings the dev server from a chrome-extension://
    // origin. Vite ships CORS off by default for non-allowed origins, so the ping is
    // blocked. Allow any chrome-extension origin in dev only.
    cors: {
      origin: /^chrome-extension:\/\//,
    },
    // pnpm or symlinked deps may live outside the project tree; relax the guard.
    fs: { strict: false },
  },
})
