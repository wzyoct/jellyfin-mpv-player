import { contextBridge, ipcRenderer } from 'electron'
import type {
  EmberApi,
  ImageRequest,
  ItemsQuery,
  PlaybackCommand,
  StartPlaybackRequest,
  SettingsInput,
} from '../src/types'
import { unwrapIpcError } from './errorMessage'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    throw new Error(unwrapIpcError(error))
  }) as Promise<T>
}

const api: EmberApi = {
  getSettings: () => invoke('settings:get'),
  saveSettings: (input: SettingsInput) => invoke('settings:save', input),
  login: (input) => invoke('emby:login', input),
  logout: () => invoke('emby:logout'),
  getViews: () => invoke('emby:get-views'),
  getItems: (query?: ItemsQuery) => invoke('emby:get-items', query),
  getMovieRecommendations: () => invoke('emby:get-movie-recommendations'),
  getItem: (itemId: string) => invoke('emby:get-item', itemId),
  getPlaybackInfo: (itemId: string) => invoke('emby:get-playback-info', itemId),
  getNextUp: (seriesId?: string) => invoke('emby:get-next-up', seriesId),
  getSeriesEpisodes: (seriesId: string) => invoke('emby:get-series-episodes', seriesId),
  getImage: (request: ImageRequest) => invoke('emby:get-image', request),
  validateMpvPath: (path?: string) => invoke('mpv:validate', path),
  testMpvPath: (path?: string) => invoke('mpv:test', path),
  openLogDirectory: () => invoke('diagnostics:open-log-directory'),
  playbackStart: (request: StartPlaybackRequest) => invoke('playback:start', request),
  playbackCommand: (request: PlaybackCommand) => invoke('playback:command', request),
  getPlaybackSnapshot: () => invoke('playback:snapshot'),
  onPlaybackChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]) => callback(status)
    ipcRenderer.on('playback:changed', listener)
    return () => ipcRenderer.removeListener('playback:changed', listener)
  },
}

contextBridge.exposeInMainWorld('emby', api)

function reportRendererError(kind: string, error: unknown): void {
  const value = error instanceof Error ? error : new Error(String(error))
  try {
    ipcRenderer.send('diagnostics:renderer-error', {
      kind,
      message: value.message,
      stack: value.stack,
    })
  } catch {
    // The renderer can be shutting down while an error event is delivered.
  }
}

window.addEventListener('error', (event) => reportRendererError('uncaught-error', event.error || event.message))
window.addEventListener('unhandledrejection', (event) => reportRendererError('unhandled-rejection', event.reason))
