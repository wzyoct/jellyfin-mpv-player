import { contextBridge, ipcRenderer } from 'electron'
import type {
  EmberApi,
  ImageRequest,
  ItemsQuery,
  PlayRequest,
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
  getImage: (request: ImageRequest) => ipcRenderer.invoke('emby:get-image', request),
  play: (request: PlayRequest) => ipcRenderer.invoke('mpv:play', request),
  stop: () => ipcRenderer.invoke('mpv:stop'),
  onMpvStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]) => callback(status)
    ipcRenderer.on('mpv:status', listener)
    return () => ipcRenderer.removeListener('mpv:status', listener)
  },
}

contextBridge.exposeInMainWorld('emby', api)
