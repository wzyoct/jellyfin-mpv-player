import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { JellyfinClient, normalizeServerUrl } from './jellyfinClient'
import { normalizeMpvPath } from './mpvPath'
import { logger } from './logger'
import { PlaybackManager } from './playbackManager'
import type {
  PlaybackCommand,
  StartPlaybackRequest,
  JellyfinIdentity,
  PlaybackInfoRequest,
} from '../src/types'

interface StoredSettings {
  serverUrl: string
  username: string
  userId?: string
  serverName?: string
  serverVersion?: string
  mediaWarpVersion?: string
  encryptedToken?: string
  mpvPath: string
  deviceId: string
}

let mainWindow: BrowserWindow | null = null
let settingsPath = ''
let storedSettings: StoredSettings = {
  serverUrl: 'http://127.0.0.1:9000',
  username: '',
  mpvPath: 'mpv.exe',
  deviceId: randomUUID(),
}
let jellyfinClient: JellyfinClient | null = null
let connectionError: string | undefined
const imageCache = new Map<string, string>()
const inFlightImageRequests = new Map<string, Promise<string>>()
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
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<StoredSettings> & {
      continuousPlayback?: unknown
      preferChineseSubtitles?: unknown
    }
    const { continuousPlayback: _legacyContinuousPlayback, preferChineseSubtitles: _legacyChineseSubtitles, ...persisted } = parsed
    storedSettings = {
      ...storedSettings,
      ...persisted,
      serverName: persisted.serverName,
      serverVersion: persisted.serverVersion,
      mpvPath: normalizeMpvPath(persisted.mpvPath),
      deviceId: persisted.deviceId || randomUUID(),
    }
    persistSettings()
  } catch {
    // A corrupted settings file should not prevent the app from opening.
    logger.warn('settings', 'read-failed', { settingsPath })
  }
}

function persistSettings(): void {
  if (!settingsPath) return
  mkdirSync(dirname(settingsPath), { recursive: true })
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
    serverName: storedSettings.serverName,
    serverVersion: storedSettings.serverVersion,
    mediaWarpVersion: storedSettings.mediaWarpVersion,
    connectionError,
    mpvPath: storedSettings.mpvPath || 'mpv.exe',
    connected: Boolean(jellyfinClient),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
  }
}

function resolveMpvPath(candidate?: string): string {
  const selected = typeof candidate === 'string' && candidate.trim() ? candidate : storedSettings.mpvPath
  return normalizeMpvPath(selected)
}

function requireText(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${label}无效`)
  return value.trim()
}

function parseMpvVersion(output: string): { raw?: string; supported: boolean } {
  const match = output.match(/(?:mpv\s+)?v?(\d+)\.(\d+)(?:\.(\d+))?/i)
  if (!match) return { supported: false }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3] || 0)
  return { raw: match[0].trim(), supported: major > 0 || minor >= 41 || (major === 0 && minor === 41 && patch >= 0) }
}

function validateMpvPath(candidate?: string): { valid: boolean; path: string; version?: string; message: string } {
  const mpvPath = resolveMpvPath(candidate)
  const result = spawnSync(mpvPath, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
  if (result.error || result.status !== 0) {
    return { valid: false, path: mpvPath, message: `找不到可用的 MPV：${mpvPath}` }
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const version = parseMpvVersion(output)
  const rawVersion = output.split(/\r?\n/).find((line) => line.trim())?.trim()
  if (!version.supported) return { valid: false, path: mpvPath, version: rawVersion, message: 'MPV 版本过低，需要 0.41 或更新版本' }
  return { valid: true, path: mpvPath, version: rawVersion, message: 'MPV 路径和版本有效' }
}

function testMpvPath(candidate?: string): { valid: boolean; path: string; version?: string; message: string } {
  const validation = validateMpvPath(candidate)
  if (!validation.valid) return validation
  const child = spawn(validation.path, ['--idle=yes', '--force-window=no', '--no-video', '--no-audio'], { windowsHide: true, stdio: 'ignore' })
  setTimeout(() => { if (!child.killed) child.kill() }, 700)
  return { ...validation, message: 'MPV 测试启动成功' }
}

async function restoreClient(): Promise<void> {
  const token = decryptToken()
  if (!token || !storedSettings.userId) return
  try {
    const inspected = await JellyfinClient.inspect(storedSettings.serverUrl)
    const identity: JellyfinIdentity = inspected.identity
    jellyfinClient = new JellyfinClient(inspected.baseUrl, token, storedSettings.userId, identity, storedSettings.deviceId)
    storedSettings.serverUrl = inspected.baseUrl
    storedSettings.serverName = identity.name
    storedSettings.serverVersion = identity.version
    storedSettings.mediaWarpVersion = inspected.mediaWarpVersion
    connectionError = undefined
    persistSettings()
    logger.info('jellyfin', 'restore-client-success', { mediaWarpVersion: inspected.mediaWarpVersion, jellyfinVersion: identity.version })
  } catch (error) {
    jellyfinClient = null
    connectionError = error instanceof Error ? error.message : '无法验证 MediaWarp 连接'
    logger.warn('jellyfin', 'restore-client-failed', { message: connectionError })
  }
}

function getClient(): JellyfinClient {
  if (!jellyfinClient) throw new Error('请先连接 Jellyfin 服务器')
  return jellyfinClient
}

const playbackManager = new PlaybackManager({
  getClient: () => jellyfinClient,
  getOptionalClient: () => jellyfinClient,
  resolveMpvPath: () => resolveMpvPath(),
  validateMpvPath: () => validateMpvPath(),
  emit: (event) => mainWindow?.webContents.send('playback:changed', event),
})

function rendererDiagnosticPayload(payload: unknown): { kind: string; message: string; stack?: string } {
  if (!payload || typeof payload !== 'object') return { kind: 'unknown', message: String(payload) }
  const value = payload as Record<string, unknown>
  return {
    kind: typeof value.kind === 'string' ? value.kind.slice(0, 80) : 'unknown',
    message: typeof value.message === 'string' ? value.message.slice(0, 2000) : '未知渲染错误',
    stack: typeof value.stack === 'string' ? value.stack.slice(0, 4000) : undefined,
  }
}

function registerProcessDiagnostics(): void {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logger.error('process', 'uncaught-exception', error, { origin })
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('process', 'unhandled-rejection', reason)
  })
}

function registerIpc(): void {
  ipcMain.on('diagnostics:renderer-error', (_event, payload: unknown) => {
    const diagnostic = rendererDiagnosticPayload(payload)
    logger.error('renderer', diagnostic.kind, new Error(diagnostic.message), diagnostic.stack ? { stack: diagnostic.stack } : undefined)
  })
  ipcMain.handle('diagnostics:open-log-directory', async () => {
    const directory = logger.getDirectory()
    if (!directory) throw new Error('日志目录尚未准备好')
    const error = await shell.openPath(directory)
    if (error) {
      logger.error('diagnostics', 'open-log-directory-failed', new Error(error))
      throw new Error('无法打开日志目录')
    }
  })
  ipcMain.handle('window:get-full-screen', () => Boolean(mainWindow?.isFullScreen()))
  ipcMain.handle('window:set-full-screen', (_event, enabled: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('窗口已关闭')
    mainWindow.setFullScreen(enabled === true)
    return mainWindow.isFullScreen()
  })
  ipcMain.handle('settings:get', () => publicSettings())
  ipcMain.handle('settings:save', async (_event, input: { serverUrl: string; username: string; mpvPath: string }) => {
    const nextUrl = normalizeServerUrl(requireText(input?.serverUrl, '服务器地址'))
    if (nextUrl !== storedSettings.serverUrl) {
      await playbackManager.stop('quit')
      jellyfinClient = null
      storedSettings.userId = undefined
      storedSettings.serverName = undefined
      storedSettings.serverVersion = undefined
      storedSettings.mediaWarpVersion = undefined
      storedSettings.encryptedToken = undefined
      connectionError = undefined
      imageCache.clear()
      inFlightImageRequests.clear()
    }
    storedSettings.serverUrl = nextUrl
    storedSettings.username = requireText(input?.username, '用户名')
    storedSettings.mpvPath = normalizeMpvPath(requireText(input?.mpvPath || storedSettings.mpvPath, 'MPV 路径'))
    connectionError = undefined
    persistSettings()
    return publicSettings()
  })
  ipcMain.handle('jellyfin:login', async (_event, input: { serverUrl: string; username: string; password: string; mpvPath: string }) => {
    try {
      const inspected = await JellyfinClient.inspect(requireText(input?.serverUrl, '服务器地址'))
      const username = requireText(input?.username, '用户名')
      const result = await JellyfinClient.authenticate(inspected.baseUrl, username, typeof input?.password === 'string' ? input.password : '', inspected.identity, storedSettings.deviceId)
      storedSettings.serverUrl = result.baseUrl
      storedSettings.username = username
      storedSettings.userId = result.User.Id
      storedSettings.serverName = result.identity.name
      storedSettings.serverVersion = result.identity.version
      storedSettings.mediaWarpVersion = inspected.mediaWarpVersion
      storedSettings.mpvPath = normalizeMpvPath(requireText(input?.mpvPath || storedSettings.mpvPath, 'MPV 路径'))
      storedSettings.encryptedToken = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(result.AccessToken).toString('base64')
        : undefined
      jellyfinClient = new JellyfinClient(result.baseUrl, result.AccessToken, result.User.Id, result.identity, storedSettings.deviceId)
      connectionError = undefined
      persistSettings()
      logger.info('jellyfin', 'connected', { mediaWarpVersion: inspected.mediaWarpVersion, jellyfinVersion: result.identity.version })
      return { settings: publicSettings(), user: result.User }
    } catch (error) {
      connectionError = error instanceof Error ? error.message : 'MediaWarp 连接失败'
      throw error
    }
  })
  ipcMain.handle('jellyfin:logout', async () => {
    await playbackManager.stop('quit')
    jellyfinClient = null
    storedSettings.userId = undefined
    storedSettings.serverName = undefined
    storedSettings.serverVersion = undefined
    storedSettings.mediaWarpVersion = undefined
    storedSettings.encryptedToken = undefined
    connectionError = undefined
    persistSettings()
    imageCache.clear()
    inFlightImageRequests.clear()
    return publicSettings()
  })
  ipcMain.handle('jellyfin:get-views', () => getClient().getViews())
  ipcMain.handle('jellyfin:get-items', (_event, query) => getClient().getItems(query || {}))
  ipcMain.handle('jellyfin:get-resume-items', () => getClient().getResumeItems())
  ipcMain.handle('jellyfin:get-movie-recommendations', () => getClient().getMovieRecommendations())
  ipcMain.handle('jellyfin:get-item', (_event, itemId: string) => getClient().getItem(requireText(itemId, '媒体 ID')))
  ipcMain.handle('jellyfin:get-playback-info', (_event, itemId: string, request?: PlaybackInfoRequest) => getClient().getPlaybackInfo(requireText(itemId, '媒体 ID'), request))
  ipcMain.handle('jellyfin:get-next-up', (_event, seriesId?: string) => getClient().getNextUp(seriesId ? requireText(seriesId, '剧集 ID') : undefined))
  ipcMain.handle('jellyfin:get-series-episodes', (_event, seriesId: string) => getClient().getSeriesEpisodes(requireText(seriesId, '剧集 ID')))
  ipcMain.handle('jellyfin:get-image', async (_event, request: { itemId: string; imageType?: string; tag?: string; maxWidth?: number }) => {
    const itemId = requireText(request?.itemId, '媒体 ID')
    const client = getClient()
    const safeRequest = { itemId, imageType: request.imageType, tag: request.tag, maxWidth: request.maxWidth }
    const key = JSON.stringify(safeRequest)
    const cached = readCachedImage(key)
    if (cached) return cached
    const pending = inFlightImageRequests.get(key)
    if (pending) return pending
    const requestPromise = client.getImage(itemId, request.imageType || 'Primary', request.tag, request.maxWidth || 480)
      .then((image) => {
        if (jellyfinClient === client) writeCachedImage(key, image)
        return image
      })
      .finally(() => {
        inFlightImageRequests.delete(key)
      })
    inFlightImageRequests.set(key, requestPromise)
    return requestPromise
  })
  ipcMain.handle('mpv:validate', (_event, mpvPath?: string) => {
    const result = validateMpvPath(mpvPath)
    return result
  })
  ipcMain.handle('mpv:test', (_event, mpvPath?: string) => {
    const result = testMpvPath(mpvPath)
    return result
  })
  ipcMain.handle('playback:start', async (_event, request: StartPlaybackRequest) => {
    try {
      return await playbackManager.start(request)
    } catch (error) {
      logger.error('playback', 'start-failed', error, { itemId: request.itemId })
      throw error
    }
  })
  ipcMain.handle('playback:command', (_event, request: PlaybackCommand) => playbackManager.command(request))
  ipcMain.handle('playback:snapshot', () => playbackManager.snapshot())
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
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logger.error('window', 'load-failed', new Error(errorDescription), { errorCode, validatedURL, isMainFrame })
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('window', 'render-process-gone', new Error(details.reason), { exitCode: details.exitCode })
  })
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('window:full-screen-changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('window:full-screen-changed', false)
  })
  if (!app.isPackaged) {
    void mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    void mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

if (app.isPackaged) {
  const portableRoot = dirname(process.execPath)
  const portableData = join(portableRoot, 'data')
  app.setPath('appData', portableRoot)
  app.setPath('userData', portableData)
  app.commandLine.appendSwitch('user-data-dir', portableData)
}
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    settingsPath = join(app.getPath('userData'), 'settings.json')
    logger.initialize(join(app.getPath('userData'), 'logs'))
    logger.info('app', 'started', {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
    })
    registerProcessDiagnostics()
    readSettings()
    void restoreClient().finally(() => {
      mainWindow?.webContents.send('settings:changed', publicSettings())
    })
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
    if (quitting) return
    logger.info('app', 'quit-requested')
    if (!playbackManager.hasActiveSession()) return
    event.preventDefault()
    quitting = true
    void playbackManager.stop('quit').finally(() => app.quit())
  })
}
