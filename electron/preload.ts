import { contextBridge, ipcRenderer } from 'electron'
import type {
  JellyfinApi,
  PlaybackInfoRequest,
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

const api: JellyfinApi = {
  getSettings: () => invoke('settings:get'),
  saveSettings: (input: SettingsInput) => invoke('settings:save', input),
  login: (input) => invoke('jellyfin:login', input),
  logout: () => invoke('jellyfin:logout'),
  getViews: () => invoke('jellyfin:get-views'),
  getItems: (query?: ItemsQuery) => invoke('jellyfin:get-items', query),
  getResumeItems: () => invoke('jellyfin:get-resume-items'),
  getMovieRecommendations: () => invoke('jellyfin:get-movie-recommendations'),
  getItem: (itemId: string) => invoke('jellyfin:get-item', itemId),
  getPlaybackInfo: (itemId: string, request?: PlaybackInfoRequest) => invoke('jellyfin:get-playback-info', itemId, request),
  getNextUp: (seriesId?: string) => invoke('jellyfin:get-next-up', seriesId),
  getSeriesEpisodes: (seriesId: string) => invoke('jellyfin:get-series-episodes', seriesId),
  getImage: (request: ImageRequest) => invoke('jellyfin:get-image', request),
  getFullScreen: () => invoke('window:get-full-screen'),
  setFullScreen: (enabled: boolean) => invoke('window:set-full-screen', enabled),
  onFullScreenChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) => callback(enabled)
    ipcRenderer.on('window:full-screen-changed', listener)
    return () => ipcRenderer.removeListener('window:full-screen-changed', listener)
  },
  onSettingsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: Parameters<typeof callback>[0]) => callback(settings)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  validateMpvPath: (path?: string) => invoke('mpv:validate', path),
  testMpvPath: (path?: string) => invoke('mpv:test', path),
  chooseSubtitleFile: () => invoke('subtitle:choose-file'),
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

contextBridge.exposeInMainWorld('jellyfin', api)

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
