/// <reference types="vite/client" />

import type { MediaServerApi } from './types'

declare global {
  interface Window {
    mediaServer: MediaServerApi
  }
}

export {}
