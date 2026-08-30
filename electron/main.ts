import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import { EmbyClient, normalizeServerUrl, type MediaSourceInfo, type PlaybackInfo } from './emby'

interface StoredSettings {
  serverUrl: string
  username: string
  userId?: string
  encryptedToken?: string
  mpvPath: string
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
  positionSeconds: number
  durationSeconds?: number
  progressTimer: NodeJS.Timeout
  progressBusy: boolean
  stopped: boolean
  audioStreamIndex?: number
  subtitleStreamIndex?: number
}

let mainWindow: BrowserWindow | null = null
let settingsPath = ''
let storedSettings: StoredSettings = {
  serverUrl: 'http://127.0.0.1:8096',
  username: '',
  mpvPath: 'mpv.exe',
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
    }
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
      embyClient = new EmbyClient(storedSettings.serverUrl, token, storedSettings.userId)
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

function queryMpvProperty(pipeName: string, property: string): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    let received = ''
    const socket = net.createConnection(pipeName)
    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 1600)
    socket.once('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    socket.on('data', (chunk) => {
      received += chunk.toString()
      const lines = received.split('\n')
      received = lines.pop() || ''
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { request_id?: number; data?: unknown }
          if (message.request_id === 1) {
            clearTimeout(timer)
            finish(typeof message.data === 'number' ? message.data : null)
            return
          }
        } catch {
          // Ignore partial or non-JSON lines from MPV IPC.
        }
      }
    })
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ command: ['get_property', property], request_id: 1 })}\n`)
    })
  })
}

async function reportActiveProgress(force = false): Promise<void> {
  const active = activePlayback
  const client = embyClient
  if (!active || active.stopped || !client || (!force && active.progressBusy)) return
  active.progressBusy = true
  try {
    const [position, duration] = await Promise.all([
      queryMpvProperty(active.pipeName, 'time-pos'),
      queryMpvProperty(active.pipeName, 'duration'),
    ])
    if (position !== null) active.positionSeconds = position
    if (duration !== null) active.durationSeconds = duration
    const positionTicks = Math.max(0, Math.round(active.positionSeconds * 10_000_000))
    await client.reportProgress({
      ItemId: active.itemId,
      MediaSourceId: active.source.Id,
      PlaySessionId: active.playbackInfo.PlaySessionId,
      PositionTicks: positionTicks,
      IsPaused: false,
      CanSeek: true,
      AudioStreamIndex: active.audioStreamIndex,
      SubtitleStreamIndex: active.subtitleStreamIndex,
    })
    sendStatus({ type: 'progress', itemId: active.itemId, positionTicks, durationSeconds: active.durationSeconds })
  } catch {
    // MPV may close before the final progress request; playback itself remains valid.
  } finally {
    active.progressBusy = false
  }
}

async function finishPlayback(active: ActivePlayback, code: number | null): Promise<void> {
  if (active.stopped) return
  clearInterval(active.progressTimer)
  await reportActiveProgress(true)
  active.stopped = true
  const client = embyClient
  if (client) {
    try {
      await client.reportStopped({
        ItemId: active.itemId,
        MediaSourceId: active.source.Id,
        PlaySessionId: active.playbackInfo.PlaySessionId,
        PositionTicks: Math.max(0, Math.round(active.positionSeconds * 10_000_000)),
        CanSeek: true,
        AudioStreamIndex: active.audioStreamIndex,
        SubtitleStreamIndex: active.subtitleStreamIndex,
      })
    } catch {
      // Server-side progress is best effort when MPV has already exited.
    }
  }
  if (activePlayback === active) activePlayback = null
  sendStatus({ type: 'stopped', itemId: active.itemId, message: code === 0 ? '播放结束' : 'MPV 已退出' })
}

async function stopActivePlayback(): Promise<void> {
  const active = activePlayback
  if (!active) return
  clearInterval(active.progressTimer)
  try {
    await reportActiveProgress(true)
  } catch {
    // Continue to terminate MPV even if the server cannot be reached.
  }
  active.stopped = true
  if (!active.process.killed) active.process.kill()
  activePlayback = null
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
  const startTimeTicks = request.startTimeTicks || 0
  const streamUrl = client.buildStreamUrl(request.itemId, source, {
    audioStreamIndex: request.audioStreamIndex,
    subtitleStreamIndex: request.subtitleStreamIndex,
    startTimeTicks,
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
  if (request.subtitleStreamIndex !== undefined) {
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
    positionSeconds: startTimeTicks / 10_000_000,
    progressTimer: setInterval(() => void reportActiveProgress(), 10_000),
    progressBusy: false,
    stopped: false,
    audioStreamIndex: request.audioStreamIndex,
    subtitleStreamIndex: request.subtitleStreamIndex,
  }
  activePlayback = active

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
  } catch {
    // MPV can keep playing even if the optional Emby session notification fails.
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
    embyClient = new EmbyClient(serverUrl, result.AccessToken, result.User.Id)
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
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
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

app.on('before-quit', () => {
  if (activePlayback && !activePlayback.process.killed) activePlayback.process.kill()
})
