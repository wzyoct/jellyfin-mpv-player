import { contextBridge, ipcRenderer } from 'electron'
import type {
  EmberApi,
  ImageRequest,
  ItemsQuery,
  PlaybackCommand,
  StartPlaybackRequest,
  SettingsInput,
} from '../src/types'

const api: EmberApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (input: SettingsInput) => ipcRenderer.invoke('settings:save', input),
  login: (input) => ipcRenderer.invoke('emby:login', input),
  logout: () => ipcRenderer.invoke('emby:logout'),
  getViews: () => ipcRenderer.invoke('emby:get-views'),
  getItems: (query?: ItemsQuery) => ipcRenderer.invoke('emby:get-items', query),
  getMovieRecommendations: () => ipcRenderer.invoke('emby:get-movie-recommendations'),
  getItem: (itemId: string) => ipcRenderer.invoke('emby:get-item', itemId),
  getPlaybackInfo: (itemId: string) => ipcRenderer.invoke('emby:get-playback-info', itemId),
  getNextUp: (seriesId?: string) => ipcRenderer.invoke('emby:get-next-up', seriesId),
  getSeriesEpisodes: (seriesId: string) => ipcRenderer.invoke('emby:get-series-episodes', seriesId),
  getImage: (request: ImageRequest) => ipcRenderer.invoke('emby:get-image', request),
  validateMpvPath: (path?: string) => ipcRenderer.invoke('mpv:validate', path),
  testMpvPath: (path?: string) => ipcRenderer.invoke('mpv:test', path),
  playbackStart: (request: StartPlaybackRequest) => ipcRenderer.invoke('playback:start', request),
  playbackCommand: (request: PlaybackCommand) => ipcRenderer.invoke('playback:command', request),
  getPlaybackSnapshot: () => ipcRenderer.invoke('playback:snapshot'),
  onPlaybackChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]) => callback(status)
    ipcRenderer.on('playback:changed', listener)
    return () => ipcRenderer.removeListener('playback:changed', listener)
  },
}

contextBridge.exposeInMainWorld('emby', api)
