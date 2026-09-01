import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.{ts,vue}', 'electron/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        'src/env.d.ts',
        'src/types.ts',
        'src/main.ts',
        'electron/preload.ts',
      ],
      thresholds: {
        'electron/emby.ts': { lines: 90, statements: 90, functions: 90, branches: 80 },
        'electron/{errorMessage,logger,mpvHeaders,mpvIpc,mpvPath,playbackLogic,playbackPlaylist}.ts': {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 80,
        },
        'electron/main.ts': { lines: 50, statements: 50, functions: 45, branches: 40 },
        'src/{mediaPresentation,playbackQueue,posterSource,subtitlePreference}.ts': {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 80,
        },
        'src/App.vue': { lines: 55, statements: 55, functions: 50, branches: 45 },
        'src/components/PosterImage.vue': { lines: 80, statements: 80, functions: 80, branches: 70 },
      },
    },
  },
})
