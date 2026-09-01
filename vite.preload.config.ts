import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'electron/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    minify: false,
    outDir: resolve(__dirname, 'dist-electron/electron'),
    rollupOptions: {
      external: ['electron'],
    },
  },
})
