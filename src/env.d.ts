/// <reference types="vite/client" />

import type { EmberApi } from './types'

declare global {
  interface Window {
    emby: EmberApi
  }
}

export {}
