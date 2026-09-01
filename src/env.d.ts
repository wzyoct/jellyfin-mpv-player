/// <reference types="vite/client" />

import type { JellyfinApi } from './types'

declare global {
  interface Window {
    jellyfin: JellyfinApi
  }
}

export {}
