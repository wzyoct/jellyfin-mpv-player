import { app, BrowserWindow, ipcMain, Menu, safeStorage } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EmbyClient, normalizeServerUrl, type MediaSourceInfo, type PlaybackInfo } from './emby'
import { MpvIpc } from './mpvIpc'

interface StoredSettings {
  serverUrl: string
  username: string
  userId?: string
  encryptedToken?: string
  mpvPath: string
  deviceId: string
}

interface PlayRequest {
  itemId: string
  mediaSourceId?: string
  audioStreamIndex?: number
  subtitleStreamIndex?: number
  startTimeTicks?: number
}

interface ActivePlayback {
  itemId: string
  source: MediaSourceInfo
  playbackInfo: PlaybackInfo
  process: ChildProcess
  pipeName: string
  ipc: MpvIpc | null
  positionSeconds: number
  durationSeconds?: number
  positionFresh: boolean
  positionObserved: boolean
  isPaused: boolean
  progressTimer: NodeJS.Timeout
  progressBusy: boolean
  progressPromise?: Promise<void>
  stopped: boolean
  finalizing: boolean
  finalizePromise?: Promise<void>
  syncError?: string
  ipcCloseListener?: () => void
  lastStatusAt: number
  audioStreamIndex?: number
  subtitleStreamIndex?: number
}

let mainWindow: BrowserWindow | null = null
let settingsPath = ''
let storedSettings: StoredSettings = {
  serverUrl: 'http://127.0.0.1:8096',
  username: '',
  mpvPath: 'mpv.exe',
  deviceId: randomUUID(),
}
let embyClient: EmbyClient | null = null
let activePlayback: ActivePlayback | null = null
const imageCache = new Map<string, string>()
const IMAGE_CACHE_LIMIT = 120

function readCachedImage(key: string): string | undefined {
  const cached = imageCache.get(key)
  if (!cached) return undefined
  imageCache.delete(key)
  imageCache.set(key, cached)
  return cached
}

function writeCachedImage(key: string, value: string): void {
  imageCache.delete(key)
  imageCache.set(key, value)
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldestKey = imageCache.keys().next().value as string | undefined
    if (!oldestKey) break
    imageCache.delete(oldestKey)
  }
}

function readSettings(): void {
  if (!settingsPath || !existsSync(settingsPath)) return
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<StoredSettings>
    storedSettings = {
      ...storedSettings,
      ...parsed,
      mpvPath: parsed.mpvPath || 'mpv.exe',
      deviceId: parsed.deviceId || randomUUID(),
    }
    persistSettings()
  } catch {
    // A corrupted local settings file should not prevent the app from opening.
  }
}

function persistSettings(): void {
  if (!settingsPath) return
  writeFileSync(settingsPath, JSON.stringify(storedSettings, null, 2), 'utf8')
}

function decryptToken(): string {
  if (!storedSettings.encryptedToken || !safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(storedSettings.encryptedToken, 'base64'))
  } catch {
    return ''
  }
}

function publicSettings() {
  return {
    serverUrl: storedSettings.serverUrl,
    username: storedSettings.username,
    userId: storedSettings.userId,
    mpvPath: storedSettings.mpvPath || 'mpv.exe',
    connected: Boolean(embyClient),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
  }
}

function restoreClient(): void {
  const token = decryptToken()
  if (token && storedSettings.userId) {
    try {
      embyClient = new EmbyClient(storedSettings.serverUrl, token, storedSettings.userId, storedSettings.deviceId)
    } catch {
      embyClient = null
    }
  }
}

function sendStatus(status: Record<string, unknown>): void {
  mainWindow?.webContents.send('mpv:status', status)
}

function getClient(): EmbyClient {
  if (!embyClient) throw new Error('请先连接 Emby 服务器')
  return embyClient
}

function formatHeaderFields(source: MediaSourceInfo, token: string): string {
  const headers: Record<string, string> = {
    ...(source.RequiredHttpHeaders || {}),
    'X-MediaBrowser-Token': token,
  }
  return Object.entries(headers)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${value}`)
    .join(',')
}

async function reportActiveProgress(force = false): Promise<void> {
  const active = activePlayback
  const client = embyClient
  if (!active || active.stopped || !client) return
  if (active.progressPromise) {
    await active.progressPromise
    if (!force) return
  }
  if (!active.positionFresh && !active.isPaused) return
  active.progressBusy = true
  const progressPromise = (async () => {
    try {
      const positionTicks = Math.max(0, Math.round(active.positionSeconds * 10_000_000))
      await client.reportProgress({
        ItemId: active.itemId,
        MediaSourceId: active.source.Id,
        PlaySessionId: active.playbackInfo.PlaySessionId,
        PlayMethod: active.source.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream',
        PositionTicks: positionTicks,
        IsPaused: active.isPaused,
        CanSeek: true,
        AudioStreamIndex: active.audioStreamIndex,
        SubtitleStreamIndex: active.subtitleStreamIndex,
      })
      active.positionFresh = false
      active.syncError = undefined
      sendStatus({ type: 'progress', itemId: active.itemId, positionTicks, durationSeconds: active.durationSeconds, isPaused: active.isPaused })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Emby 进度上报失败'
      active.syncError = message
      sendStatus({ type: 'sync-error', itemId: active.itemId, message })
    } finally {
      active.progressBusy = false
      active.progressPromise = undefined
    }
  })()
  active.progressPromise = progressPromise
  await progressPromise
}

async function readLatestMpvState(active: ActivePlayback): Promise<void> {
  if (!active.ipc || active.ipc === null) return
  try {
    const [position, duration, paused] = await Promise.all([
      active.ipc.getProperty('time-pos', 800),
      active.ipc.getProperty('duration', 800),
      active.ipc.getProperty('pause', 800),
    ])
    if (typeof position === 'number' && Number.isFinite(position)) {
      active.positionSeconds = Math.max(0, position)
      active.positionFresh = true
      active.positionObserved = true
    }
    if (typeof duration === 'number' && Number.isFinite(duration)) active.durationSeconds = Math.max(0, duration)
    if (typeof paused === 'boolean') active.isPaused = paused
  } catch {
    // The last observed property values remain the best available checkpoint.
  }
}

async function finishPlayback(active: ActivePlayback, code: number | null, terminate = false): Promise<void> {
  if (active.finalizePromise) {
    await active.finalizePromise
    return
  }
  active.finalizing = true
  active.finalizePromise = (async () => {
    clearInterval(active.progressTimer)
    await readLatestMpvState(active)
    if (!active.positionObserved && !active.syncError) active.syncError = '未能取得 MPV 的最终播放位置'
    await reportActiveProgress(true)
    active.ipcCloseListener?.()
    active.ipcCloseListener = undefined
    active.ipc?.close()
    const client = embyClient
    let syncError = active.syncError
    if (client) {
      try {
        await client.reportStopped({
          ItemId: active.itemId,
          MediaSourceId: active.source.Id,
          PlaySessionId: active.playbackInfo.PlaySessionId,
          PlayMethod: active.source.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream',
          PositionTicks: Math.max(0, Math.round(active.positionSeconds * 10_000_000)),
          CanSeek: true,
          IsPaused: active.isPaused,
          AudioStreamIndex: active.audioStreamIndex,
          SubtitleStreamIndex: active.subtitleStreamIndex,
        })
      } catch (error) {
        syncError = error instanceof Error ? error.message : 'Emby 播放结束状态上报失败'
      }
    }
    active.syncError = syncError
    active.stopped = true
    if (activePlayback === active) activePlayback = null
    if (terminate && !active.process.killed) active.process.kill()
    sendStatus({
      type: 'stopped',
      itemId: active.itemId,
      positionTicks: Math.max(0, Math.round(active.positionSeconds * 10_000_000)),
      syncError,
      message: syncError || (code === 0 ? '播放结束' : 'MPV 已退出'),
    })
  })()
  await active.finalizePromise
}

async function stopActivePlayback(): Promise<void> {
  const active = activePlayback
  if (!active) return
  await finishPlayback(active, null, true)
}

async function attachMpvIpc(active: ActivePlayback): Promise<void> {
  const ipc = new MpvIpc(active.pipeName)
  active.ipc = ipc
  try {
    await ipc.connectWithRetry()
    if (active.stopped || active.finalizing) {
      ipc.close()
      return
    }
    const removeEventListener = ipc.onEvent((message) => {
      if (message.event === 'property-change') {
        if (message.name === 'time-pos' && typeof message.data === 'number' && Number.isFinite(message.data)) {
          active.positionSeconds = Math.max(0, message.data)
          active.positionFresh = true
          active.positionObserved = true
          const now = Date.now()
          if (now - active.lastStatusAt >= 500) {
            active.lastStatusAt = now
            sendStatus({ type: 'progress', itemId: active.itemId, positionTicks: Math.round(active.positionSeconds * 10_000_000), durationSeconds: active.durationSeconds, isPaused: active.isPaused })
          }
        } else if (message.name === 'duration' && typeof message.data === 'number' && Number.isFinite(message.data)) {
          active.durationSeconds = Math.max(0, message.data)
        } else if (message.name === 'pause' && typeof message.data === 'boolean') {
          active.isPaused = message.data
          void reportActiveProgress(true)
        }
      } else if (message.event === 'end-file') {
        void finishPlayback(active, 0)
      } else if (message.event === 'ipc-closed' && !active.stopped && !active.finalizing) {
        active.syncError = 'MPV 进度接口连接已断开'
        sendStatus({ type: 'sync-error', itemId: active.itemId, message: active.syncError })
      }
    })
    active.ipcCloseListener = removeEventListener
    await Promise.all([
      ipc.observeProperty(1, 'time-pos'),
      ipc.observeProperty(2, 'duration'),
      ipc.observeProperty(3, 'pause'),
    ])
    const [position, duration, paused] = await Promise.all([
      ipc.getProperty('time-pos'),
      ipc.getProperty('duration'),
      ipc.getProperty('pause'),
    ])
    if (typeof position === 'number' && Number.isFinite(position)) {
      active.positionSeconds = Math.max(0, position)
      active.positionFresh = true
    }
    if (typeof duration === 'number' && Number.isFinite(duration)) active.durationSeconds = Math.max(0, duration)
    if (typeof paused === 'boolean') active.isPaused = paused
    sendStatus({ type: 'progress', itemId: active.itemId, positionTicks: Math.round(active.positionSeconds * 10_000_000), durationSeconds: active.durationSeconds, isPaused: active.isPaused })
  } catch (error) {
    if (active.stopped || active.finalizing) return
    active.syncError = error instanceof Error ? error.message : '无法连接 MPV 进度接口'
    sendStatus({ type: 'sync-error', itemId: active.itemId, message: active.syncError })
    ipc.close()
  }
}

async function launchMpv(request: PlayRequest): Promise<{ itemId: string; sourceName: string }> {
  const client = getClient()
  await stopActivePlayback()
  const playbackInfo = await client.getPlaybackInfo(request.itemId)
  const sources = playbackInfo.MediaSources || []
  if (!sources.length) throw new Error('Emby 没有返回可用的视频源')
  const source = sources.find((candidate) => candidate.Id === request.mediaSourceId)
    || sources.find((candidate) => candidate.SupportsDirectPlay)
    || sources.find((candidate) => candidate.SupportsDirectStream)
    || sources[0]
  const subtitleStream = request.subtitleStreamIndex === undefined
    ? undefined
    : source.MediaStreams?.find((stream) => stream.Type === 'Subtitle' && stream.Index === request.subtitleStreamIndex)
  const startTimeTicks = request.startTimeTicks || 0
  const streamUrl = client.buildStreamUrl(request.itemId, source, {
    audioStreamIndex: request.audioStreamIndex,
    subtitleStreamIndex: request.subtitleStreamIndex,
    startTimeTicks,
    playSessionId: playbackInfo.PlaySessionId,
  })
  const pipeName = `\\\\.\\pipe\\ember-player-${randomUUID()}`
  const args = [
    '--force-window=yes',
    '--save-position-on-quit',
    `--title=Ember Player`,
    `--input-ipc-server=${pipeName}`,
    `--http-header-fields=${formatHeaderFields(source, client.token)}`,
  ]
  if (startTimeTicks > 0) args.push(`--start=${startTimeTicks / 10_000_000}`)
  if (request.subtitleStreamIndex !== undefined && (!subtitleStream || subtitleStream.IsTextSubtitleStream !== false)) {
    args.push(`--sub-file=${client.buildSubtitleUrl(request.itemId, source.Id, request.subtitleStreamIndex, startTimeTicks)}`)
  }
  args.push(streamUrl)

  const child = spawn(storedSettings.mpvPath || 'mpv.exe', args, { windowsHide: false, stdio: 'ignore' })
  const active: ActivePlayback = {
    itemId: request.itemId,
    source,
    playbackInfo,
    process: child,
    pipeName,
    ipc: null,
    positionSeconds: startTimeTicks / 10_000_000,
    positionFresh: false,
    positionObserved: false,
    isPaused: false,
    progressTimer: setInterval(() => void reportActiveProgress(), 10_000),
    progressBusy: false,
    stopped: false,
    finalizing: false,
    lastStatusAt: 0,
    audioStreamIndex: request.audioStreamIndex,
    subtitleStreamIndex: request.subtitleStreamIndex,
  }
  activePlayback = active
  void attachMpvIpc(active)

  child.once('error', async (error) => {
    await finishPlayback(active, null)
    sendStatus({ type: 'error', itemId: request.itemId, message: `无法启动 MPV：${error.message}` })
  })
  child.once('close', (code) => void finishPlayback(active, code))

  try {
    await client.reportPlaying({
      ItemId: request.itemId,
      MediaSourceId: source.Id,
      PlaySessionId: playbackInfo.PlaySessionId,
      PlayMethod: source.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream',
      PositionTicks: startTimeTicks,
      CanSeek: true,
      IsPaused: false,
      AudioStreamIndex: request.audioStreamIndex,
      SubtitleStreamIndex: request.subtitleStreamIndex,
    })
  } catch (error) {
    active.syncError = error instanceof Error ? error.message : 'Emby 播放开始状态上报失败'
    sendStatus({ type: 'sync-error', itemId: request.itemId, message: active.syncError })
  }
  sendStatus({ type: 'started', itemId: request.itemId })
  return { itemId: request.itemId, sourceName: source.Name || source.Container || 'Emby 视频源' }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => publicSettings())
  ipcMain.handle('settings:save', (_event, input: { serverUrl: string; username: string; mpvPath: string }) => {
    const nextUrl = normalizeServerUrl(input.serverUrl)
    if (nextUrl !== storedSettings.serverUrl) embyClient = null
    storedSettings.serverUrl = nextUrl
    storedSettings.username = input.username.trim()
    storedSettings.mpvPath = input.mpvPath.trim() || 'mpv.exe'
    persistSettings()
    return publicSettings()
  })
  ipcMain.handle('emby:login', async (_event, input: { serverUrl: string; username: string; password: string; mpvPath: string }) => {
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const result = await EmbyClient.authenticate(serverUrl, input.username.trim(), input.password)
    storedSettings.serverUrl = serverUrl
    storedSettings.username = input.username.trim()
    storedSettings.userId = result.User.Id
    storedSettings.mpvPath = input.mpvPath.trim() || 'mpv.exe'
    storedSettings.encryptedToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(result.AccessToken).toString('base64')
      : undefined
    embyClient = new EmbyClient(serverUrl, result.AccessToken, result.User.Id, storedSettings.deviceId)
    persistSettings()
    return { settings: publicSettings(), user: result.User }
  })
  ipcMain.handle('emby:logout', async () => {
    await stopActivePlayback()
    embyClient = null
    storedSettings.userId = undefined
    storedSettings.encryptedToken = undefined
    persistSettings()
    imageCache.clear()
    return publicSettings()
  })
  ipcMain.handle('emby:get-views', () => getClient().getViews())
  ipcMain.handle('emby:get-items', (_event, query) => getClient().getItems(query || {}))
  ipcMain.handle('emby:get-movie-recommendations', () => getClient().getMovieRecommendations())
  ipcMain.handle('emby:get-item', (_event, itemId: string) => getClient().getItem(itemId))
  ipcMain.handle('emby:get-playback-info', (_event, itemId: string) => getClient().getPlaybackInfo(itemId))
  ipcMain.handle('emby:get-image', async (_event, request: { itemId: string; imageType?: string; tag?: string; maxWidth?: number }) => {
    const client = getClient()
    const key = JSON.stringify(request)
    const cached = readCachedImage(key)
    if (cached) return cached
    const image = await client.getImage(request.itemId, request.imageType || 'Primary', request.tag, request.maxWidth || 480)
    writeCachedImage(key, image)
    return image
  })
  ipcMain.handle('mpv:play', (_event, request: PlayRequest) => launchMpv(request))
  ipcMain.handle('mpv:stop', () => stopActivePlayback())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#090a0c',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#f1f4f6',
      height: 64,
    },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const showWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    mainWindow.show()
    mainWindow.focus()
  }
  mainWindow.webContents.once('did-finish-load', showWindow)
  mainWindow.once('ready-to-show', showWindow)
  if (!app.isPackaged) {
    void mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    void mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  settingsPath = join(app.getPath('userData'), 'settings.json')
  readSettings()
  restoreClient()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false

app.on('before-quit', (event) => {
  if (quitting || !activePlayback) return
  event.preventDefault()
  quitting = true
  void stopActivePlayback().finally(() => app.quit())
})
