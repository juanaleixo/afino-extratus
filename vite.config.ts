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
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // pnpm or symlinked deps may live outside the project tree; relax the guard.
    fs: { strict: false },
  },
})
