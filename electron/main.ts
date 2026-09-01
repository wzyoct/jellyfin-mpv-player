import { app, BrowserWindow, ipcMain, Menu, safeStorage, shell } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { JellyfinClient, isAbortError, normalizeServerUrl, type MediaSourceInfo, type PlaybackInfo } from './jellyfinClient'
import { PlaybackGateway } from './playbackGateway'
import { MpvIpc, type MpvIpcMessage } from './mpvIpc'
import { normalizeMpvPath } from './mpvPath'
import { logger } from './logger'
import { buildEpisodeQueue } from '../src/playbackQueue'
import { buildHexPlaylistUrl } from './playbackPlaylist'
import { chooseDefaultSubtitle } from '../src/subtitlePreference'
import { isResumePositionReached, resolveResumeTicks } from './playbackLogic'
import { formatPlaybackLoadError } from './playbackError'
import type {
  AudioPreference,
  MediaItem,
  MediaStream,
  PlaybackCommand,
  PlaybackEvent,
  PlaybackQueueItem,
  PlaybackReportPayload,
  PlaybackSnapshot,
  PlaybackQueueWarning,
  PlaybackPhase,
  StartPlaybackRequest,
  SubtitlePreference,
  JellyfinIdentity,
  PlaybackInfoRequest,
  PlaybackRoute,
  SubtitleRoute,
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

interface PlaybackEntry extends PlaybackQueueItem {
  item: MediaItem
  source?: MediaSourceInfo
  playbackInfo?: PlaybackInfo
  positionSeconds: number
  durationSeconds?: number
  positionFresh: boolean
  positionObserved: boolean
  isPaused: boolean
  audioStreamIndex?: number
  subtitleStreamIndex?: number
  finalized: boolean
  initialResumeTicks: number
  routeKind?: PlaybackRoute['kind']
  gatewayUrl?: string
  playlistEntryIds: number[]
  playlistIndexes: number[]
  activePlaylistEntryId?: number
  activePlaylistIndex?: number
  loaded: boolean
  subtitleRoute?: SubtitleRoute
  preparing?: Promise<PlaybackEntry>
  preparationError?: string
}

interface PlaybackSession {
  sessionId: string
  revision: number
  phase: PlaybackPhase
  queue: PlaybackQueueItem[]
  currentIndex: number
  currentEntry?: PlaybackEntry
  entries: Map<number, PlaybackEntry>
  process: ChildProcess
  pipeName: string
  ipc: MpvIpc
  progressTimer: NodeJS.Timeout
  progressPromise?: Promise<void>
  finalizePromise?: Promise<void>
  stopAfterCurrent: boolean
  stopped: boolean
  queueWarnings: PlaybackQueueWarning[]
  queueIndexByPlaylistId: Map<number, number>
  eventChain: Promise<void>
  pendingTransition: boolean
  stopRequested: boolean
  idleFinishTimer?: NodeJS.Timeout
  playlistTrimmed: boolean
  playlistReady: boolean
  startupPending: boolean
  syncError?: string
  endReason?: string
  audioPreference?: AudioPreference
  subtitlePreference?: SubtitlePreference
  mediaSourceId?: string
  selectedItemId: string
  abortController: AbortController
  gateway: PlaybackGateway
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
let activeSession: PlaybackSession | null = null
let revisionCounter = 0
let lastSnapshot: PlaybackSnapshot = {
  revision: 0,
  phase: 'idle',
  queue: [],
  currentIndex: -1,
  positionTicks: 0,
  queueWarnings: [],
}
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

function currentServerLabel(): string {
  return 'Jellyfin'
}

function queueItem(item: MediaItem): PlaybackQueueItem {
  return {
    itemId: item.Id,
    name: item.Name,
    type: item.Type,
    seriesName: item.SeriesName,
    seriesId: item.SeriesId,
    seasonId: item.SeasonId,
    seasonNumber: item.ParentIndexNumber,
    episodeNumber: item.IndexNumber,
    runtimeTicks: item.RunTimeTicks,
  }
}

async function buildQueue(client: JellyfinClient, itemId: string): Promise<{ items: MediaItem[]; startIndex: number }> {
  const selected = await client.getItem(itemId)
  if (selected.Type !== 'Episode' || !selected.SeriesId) return { items: [selected], startIndex: 0 }

  const episodes = (await client.getSeriesEpisodes(selected.SeriesId)).filter((item) => item.LocationType?.toLowerCase() !== 'virtual')
  return buildEpisodeQueue(episodes, selected)
}

function chooseAudio(streams: MediaStream[], preference?: AudioPreference, strictIndex = false): number | undefined {
  if (preference?.index !== undefined && strictIndex) {
    return streams.some((stream) => stream.Type === 'Audio' && stream.Index === preference.index) ? preference.index : undefined
  }
  const language = preference?.language?.toLowerCase()
  const title = preference?.title?.toLowerCase()
  const codec = preference?.codec?.toLowerCase()
  return streams.find((stream) => stream.Type === 'Audio' && language && (stream.Language || stream.DisplayLanguage || '').toLowerCase() === language && (!codec || (stream.Codec || '').toLowerCase() === codec))?.Index
    ?? streams.find((stream) => stream.Type === 'Audio' && title && (stream.Title || stream.DisplayTitle || '').toLowerCase().includes(title) && (!codec || (stream.Codec || '').toLowerCase() === codec))?.Index
    ?? streams.find((stream) => stream.Type === 'Audio' && language && (stream.Language || stream.DisplayLanguage || '').toLowerCase() === language)?.Index
    ?? streams.find((stream) => stream.Type === 'Audio' && title && (stream.Title || stream.DisplayTitle || '').toLowerCase().includes(title))?.Index
    ?? streams.find((stream) => stream.Type === 'Audio' && stream.IsDefault)?.Index
    ?? streams.find((stream) => stream.Type === 'Audio')?.Index
}

function chooseSubtitle(streams: MediaStream[], preference?: SubtitlePreference, strictIndex = false): number | undefined {
  if (preference?.disabled) return undefined
  if (preference?.index !== undefined && strictIndex) {
    return streams.some((stream) => stream.Type === 'Subtitle' && stream.Index === preference.index) ? preference.index : undefined
  }
  const language = preference?.language?.toLowerCase()
  const title = preference?.title?.toLowerCase()
  const codec = preference?.codec?.toLowerCase()
  return streams.find((stream) => stream.Type === 'Subtitle' && language && (stream.Language || stream.DisplayLanguage || '').toLowerCase() === language && (!codec || (stream.Codec || '').toLowerCase() === codec))?.Index
    ?? streams.find((stream) => stream.Type === 'Subtitle' && title && (stream.Title || stream.DisplayTitle || '').toLowerCase().includes(title) && (!codec || (stream.Codec || '').toLowerCase() === codec))?.Index
    ?? streams.find((stream) => stream.Type === 'Subtitle' && language && (stream.Language || stream.DisplayLanguage || '').toLowerCase() === language)?.Index
    ?? streams.find((stream) => stream.Type === 'Subtitle' && title && (stream.Title || stream.DisplayTitle || '').toLowerCase().includes(title))?.Index
    ?? chooseDefaultSubtitle(streams)
}

function createLogicalEntry(item: MediaItem, startTimeTicks = 0): PlaybackEntry {
  return {
    ...queueItem(item),
    item,
    positionSeconds: Math.max(0, startTimeTicks / 10_000_000),
    positionFresh: false,
    positionObserved: false,
    isPaused: false,
    finalized: false,
    initialResumeTicks: Math.max(0, startTimeTicks),
    playlistEntryIds: [],
    playlistIndexes: [],
    loaded: false,
  }
}

async function prepareEntry(session: PlaybackSession, item: MediaItem, startTimeTicks = 0): Promise<PlaybackEntry> {
  const client = getClient()
  const isSelected = item.Id === session.selectedItemId
  const requestedStreams = item.MediaStreams || []
  const playbackRequest: PlaybackInfoRequest = {
    ...(isSelected && session.mediaSourceId ? { mediaSourceId: session.mediaSourceId } : {}),
    ...(isSelected && session.audioPreference?.index !== undefined ? { audioStreamIndex: session.audioPreference.index } : {}),
    ...(isSelected && !session.subtitlePreference?.disabled && session.subtitlePreference?.index !== undefined ? { subtitleStreamIndex: session.subtitlePreference.index } : {}),
    startTimeTicks,
  }
  const playbackInfo = await client.getPlaybackInfo(item.Id, playbackRequest, session.abortController.signal)
  const sources = playbackInfo.MediaSources || []
  if (!sources.length) throw new Error(`《${item.Name}》没有可用的视频源`)
  const requestedSource = isSelected && session.mediaSourceId ? sources.find((candidate) => candidate.Id === session.mediaSourceId) : undefined
  if (isSelected && session.mediaSourceId && !requestedSource) throw new Error(`《${item.Name}》没有找到指定媒体源`)
  const source = requestedSource
    || sources.find((candidate) => candidate.SupportsDirectPlay)
    || sources.find((candidate) => candidate.SupportsDirectStream)
    || sources[0]
  const streams = (source.MediaStreams || item.MediaStreams || []) as MediaStream[]
  const audioStreamIndex = chooseAudio(streams, session.audioPreference, isSelected)
  const subtitleStreamIndex = chooseSubtitle(streams, session.subtitlePreference, isSelected)
  if (isSelected && session.audioPreference?.index !== undefined && audioStreamIndex === undefined) {
    throw new Error(`《${item.Name}》未找到用户指定的音轨 ${session.audioPreference.index}`)
  }
  if (isSelected && !session.subtitlePreference?.disabled && session.subtitlePreference?.index !== undefined && subtitleStreamIndex === undefined) {
    throw new Error(`《${item.Name}》未找到用户指定的字幕轨道 ${session.subtitlePreference.index}`)
  }
  const subtitle = subtitleStreamIndex === undefined ? undefined : streams.find((stream) => stream.Type === 'Subtitle' && stream.Index === subtitleStreamIndex)
  const route = client.buildPlaybackRoute(item.Id, source, {
    audioStreamIndex,
    subtitleStreamIndex,
    playSessionId: playbackInfo.PlaySessionId,
  })
  return {
    ...createLogicalEntry(item, startTimeTicks),
    source,
    playbackInfo,
    audioStreamIndex,
    subtitleStreamIndex,
    routeKind: route.kind,
    playlistEntryIds: [],
    playlistIndexes: [],
    subtitleRoute: subtitle && subtitleStreamIndex !== undefined ? {
      deliveryMethod: subtitle.DeliveryMethod || (subtitle.IsExternal ? 'External' : 'Embed'),
      deliveryUrl: subtitle.DeliveryUrl,
      codec: subtitle.Codec,
      streamIndex: subtitleStreamIndex,
      isExternal: Boolean(subtitle.IsExternal || subtitle.IsExternalUrl),
    } : undefined,
  }
}

async function ensureEntryPrepared(session: PlaybackSession, entry: PlaybackEntry): Promise<PlaybackEntry> {
  if (entry.source && entry.playbackInfo && entry.routeKind) return entry
  if (entry.preparing) return entry.preparing
  entry.preparationError = undefined
  const promise = prepareEntry(session, entry.item, entry.initialResumeTicks)
    .then((prepared) => {
      const playlistEntryIds = entry.playlistEntryIds
      const playlistIndexes = entry.playlistIndexes
      const gatewayUrl = entry.gatewayUrl
      Object.assign(entry, prepared, { playlistEntryIds, playlistIndexes, gatewayUrl, preparing: undefined })
      logger.info('playback', 'entry-prepared', { sessionId: session.sessionId, itemId: entry.itemId, queueIndex: session.queue.findIndex((item) => item.itemId === entry.itemId), routeKind: entry.routeKind })
      return entry
    })
    .catch((error) => {
      entry.preparing = undefined
      entry.preparationError = error instanceof Error ? error.message : '读取播放信息失败'
      throw error
    })
  entry.preparing = promise
  return promise
}

function snapshotFor(session: PlaybackSession | null): PlaybackSnapshot {
  if (!session) return lastSnapshot
  const entry = session.currentEntry
  return {
    sessionId: session.sessionId,
    revision: session.revision,
    phase: session.phase,
    queue: session.queue,
    currentIndex: session.currentIndex,
    currentItemId: entry?.itemId,
    positionTicks: Math.max(0, Math.round((entry?.positionSeconds || 0) * 10_000_000)),
    durationTicks: entry?.durationSeconds === undefined ? undefined : Math.round(entry.durationSeconds * 10_000_000),
    isPaused: entry?.isPaused,
    endReason: session.endReason,
    syncError: session.syncError,
    queueWarnings: session.queueWarnings,
  }
}

function emitPlayback(type: PlaybackEvent['type'], session: PlaybackSession | null, message?: string): PlaybackSnapshot {
  if (session && activeSession && activeSession !== session) return lastSnapshot
  if (session?.stopped && type !== 'snapshot') return lastSnapshot
  const revision = ++revisionCounter
  if (session) session.revision = revision
  const snapshot = snapshotFor(session)
  snapshot.revision = revision
  if (message) snapshot.message = message
  lastSnapshot = snapshot
  mainWindow?.webContents.send('playback:changed', { type, ...snapshot })
  return snapshot
}

function reportPayload(session: PlaybackSession, entry: PlaybackEntry, eventName?: PlaybackProgressEvent, playlistIndex = session.currentIndex): PlaybackReportPayload {
  if (!entry.source || !entry.playbackInfo || !entry.routeKind) throw new Error(`《${entry.name}》播放资源尚未准备好`)
  return {
    ItemId: entry.itemId,
    MediaSourceId: entry.source.Id,
    PlaySessionId: entry.playbackInfo.PlaySessionId,
    PlayMethod: entry.routeKind === 'transcode' ? 'Transcode' : entry.routeKind === 'direct-play' ? 'DirectPlay' : 'DirectStream',
    PositionTicks: Math.max(0, Math.round(entry.positionSeconds * 10_000_000)),
    IsPaused: entry.isPaused,
    CanSeek: true,
    AudioStreamIndex: entry.audioStreamIndex,
    SubtitleStreamIndex: entry.subtitleStreamIndex,
    PlaylistIndex: playlistIndex,
    PlaylistLength: session.queue.length,
    QueueableMediaTypes: ['Video'],
    ...(eventName ? { EventName: eventName } : {}),
  }
}

type PlaybackProgressEvent = NonNullable<PlaybackReportPayload['EventName']>

async function reportEntryProgress(session: PlaybackSession, entry: PlaybackEntry, force = false, eventName: PlaybackProgressEvent = 'TimeUpdate'): Promise<void> {
  const client = jellyfinClient
  if (!client || entry.finalized || (!force && !entry.positionFresh && !entry.isPaused)) return
  await client.reportProgress(reportPayload(session, entry, eventName))
  entry.positionFresh = false
  session.syncError = undefined
  emitPlayback('progress', session)
}

async function reportActiveProgress(force = false, eventName: PlaybackProgressEvent = 'TimeUpdate'): Promise<void> {
  const session = activeSession
  if (!session || session.stopped || !session.currentEntry) return
  if (session.progressPromise) {
    await session.progressPromise
    if (!force) return
  }
  const entry = session.currentEntry
  const promise = (async () => {
    try {
      await reportEntryProgress(session, entry, force, eventName)
    } catch (error) {
      session.syncError = error instanceof Error ? error.message : `${currentServerLabel()} 进度上报失败`
      emitPlayback('sync-error', session, session.syncError)
    } finally {
      session.progressPromise = undefined
    }
  })()
  session.progressPromise = promise
  await promise
}

async function readLatestMpvState(session: PlaybackSession, entry: PlaybackEntry): Promise<void> {
  if (session.currentEntry !== entry) return
  try {
    const [position, duration, paused] = await Promise.all([
      session.ipc.getProperty('time-pos', 800),
      session.ipc.getProperty('duration', 800),
      session.ipc.getProperty('pause', 800),
    ])
    if (typeof position === 'number' && Number.isFinite(position)) {
      entry.positionSeconds = Math.max(0, position)
      entry.positionFresh = true
      entry.positionObserved = true
    }
    if (typeof duration === 'number' && Number.isFinite(duration)) entry.durationSeconds = Math.max(0, duration)
    if (typeof paused === 'boolean') entry.isPaused = paused
  } catch {
    // The last observed values remain the best checkpoint if MPV is already closing.
  }
}

async function finalizeEntry(session: PlaybackSession, entry: PlaybackEntry, reason: string, keepProcess: boolean): Promise<void> {
  if (!entry || entry.finalized) return
  logger.info('playback', 'finalize-entry', { sessionId: session.sessionId, itemId: entry.itemId, reason, keepProcess })
  await readLatestMpvState(session, entry)
  session.endReason = reason
  if (reason === 'eof' && entry.durationSeconds !== undefined) {
    entry.positionSeconds = Math.max(entry.positionSeconds, entry.durationSeconds)
    entry.positionObserved = true
    entry.positionFresh = true
  }
  try {
    await reportEntryProgress(session, entry, true, 'TimeUpdate')
  } catch (error) {
    session.syncError = error instanceof Error ? error.message : `${currentServerLabel()} 进度上报失败`
  }
  if (!entry.positionObserved && !session.syncError) session.syncError = '未能取得 MPV 的最终播放位置'
  const client = jellyfinClient
  if (client) {
    try {
      await client.reportStopped(reportPayload(session, entry, undefined, session.currentIndex))
      session.syncError = undefined
    } catch (error) {
      session.syncError = error instanceof Error ? error.message : `${currentServerLabel()} 播放结束状态上报失败`
    }
  }
  entry.finalized = true
  session.phase = keepProcess ? 'switching' : 'stopping'
  emitPlayback('item-finalized', session)
}

async function finishSession(session: PlaybackSession, reason: string, terminate = true): Promise<void> {
  if (session.finalizePromise) {
    await session.finalizePromise
    return
  }
  session.finalizePromise = (async () => {
    session.phase = 'stopping'
    session.endReason = reason
    session.abortController.abort()
    emitPlayback('snapshot', session)
    clearInterval(session.progressTimer)
    try {
      if (session.currentEntry) await finalizeEntry(session, session.currentEntry, reason, false)
    } catch (error) {
      session.syncError = error instanceof Error ? error.message : '播放结束状态上报失败'
    }
    session.stopped = true
    if (session.idleFinishTimer) clearTimeout(session.idleFinishTimer)
    session.ipc.close()
    await session.gateway.dispose()
    if (terminate && !session.process.killed) session.process.kill()
    if (activeSession === session) activeSession = null
    session.phase = reason === 'error' ? 'error' : 'stopped'
    emitPlayback('snapshot', session, reason === 'eof' ? '播放完成' : reason === 'quit' ? 'MPV 已关闭' : reason === 'error' ? session.syncError : undefined)
  })()
  await session.finalizePromise
}

function registerPlaybackRoute(session: PlaybackSession, entry: PlaybackEntry): string {
  if (entry.gatewayUrl) return entry.gatewayUrl
  const gatewayUrl = session.gateway.register({ resolve: async () => {
    const prepared = await ensureEntryPrepared(session, entry)
    if (!prepared.source || !prepared.playbackInfo) throw new Error(`《${entry.name}》播放资源尚未准备好`)
    const route = getClient().buildPlaybackRoute(prepared.itemId, prepared.source, {
      audioStreamIndex: prepared.audioStreamIndex,
      subtitleStreamIndex: prepared.subtitleStreamIndex,
      playSessionId: prepared.playbackInfo.PlaySessionId,
    })
    if (prepared.routeKind && route.kind !== prepared.routeKind) throw new Error(`《${entry.name}》播放路由状态不一致`)
    prepared.routeKind = route.kind
    let host = 'unknown'
    try { host = new URL(route.upstreamUrl).hostname } catch { /* validated by the gateway */ }
    logger.info('playback', 'route-resolved', {
      sessionId: session.sessionId,
      itemId: prepared.itemId,
      kind: route.kind,
      host,
      mediaSourceId: route.mediaSourceId,
      hasDirectStreamUrl: Boolean(prepared.source.DirectStreamUrl),
      hasTranscodingUrl: Boolean(prepared.source.TranscodingUrl),
      supportsDirectPlay: Boolean(prepared.source.SupportsDirectPlay),
      supportsDirectStream: Boolean(prepared.source.SupportsDirectStream),
      requiredHeaderCount: Object.keys(route.requiredHttpHeaders).length,
    })
    return { upstreamUrl: route.upstreamUrl, requiredHeaders: route.requiredHttpHeaders }
  }})
  entry.gatewayUrl = gatewayUrl
  logger.info('playback', 'route-registered', { sessionId: session.sessionId, itemId: entry.itemId, queueIndex: session.queue.findIndex((item) => item.itemId === entry.itemId) })
  return gatewayUrl
}

async function seekEntry(session: PlaybackSession, entry: PlaybackEntry, startTimeTicks: number): Promise<void> {
  const targetSeconds = Math.max(0, startTimeTicks / 10_000_000)
  if (!targetSeconds) return
  logger.info('playback', 'seek-start', { sessionId: session.sessionId, itemId: entry.itemId, targetSeconds: Math.round(targetSeconds) })
  await session.ipc.send(['seek', targetSeconds, 'absolute+exact'])
  const deadline = Date.now() + 5000
  let latestPosition: unknown
  while (Date.now() < deadline) {
    latestPosition = await session.ipc.getProperty('time-pos', 900).catch(() => undefined)
    if (isResumePositionReached(latestPosition, targetSeconds)) {
      entry.positionSeconds = latestPosition
      entry.positionObserved = true
      entry.positionFresh = true
      logger.info('playback', 'seek-complete', { sessionId: session.sessionId, itemId: entry.itemId, actualSeconds: Math.round(latestPosition) })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`MPV 未能跳转到续播位置（目标 ${Math.round(targetSeconds)} 秒，实际 ${typeof latestPosition === 'number' ? Math.round(latestPosition) : '未知'} 秒）`)
}

async function activateLoadedEntry(session: PlaybackSession, entry: PlaybackEntry): Promise<void> {
  if (entry.loaded || session.stopped) return
  await ensureEntryPrepared(session, entry)
  if (!entry.source || !entry.playbackInfo || !entry.routeKind) throw new Error(`《${entry.name}》播放资源尚未准备好`)
  entry.loaded = true
  if (entry.initialResumeTicks > 0) await seekEntry(session, entry, entry.initialResumeTicks)
  if (entry.subtitleRoute) {
    const route = entry.subtitleRoute
    if (route.deliveryMethod.toLowerCase() === 'external' || route.isExternal) {
      if (!route.deliveryUrl) throw new Error(`《${entry.name}》的外挂字幕没有可用的 DeliveryUrl`)
      const subtitleUrl = session.gateway.register({ upstreamUrl: getClient().resolveUrl(route.deliveryUrl) })
      await session.ipc.send(['sub-add', subtitleUrl, 'select'])
    } else {
      const tracks = await session.ipc.getProperty('track-list')
      const track = Array.isArray(tracks)
        ? (tracks as Array<{ type?: unknown; id?: unknown; 'ff-index'?: unknown }>).find((candidate) => candidate.type === 'sub' && candidate['ff-index'] === route.streamIndex)
        : undefined
      if (!track || typeof track.id !== 'number') throw new Error(`《${entry.name}》未能映射内嵌字幕轨道 ${route.streamIndex}`)
      await session.ipc.setProperty('sid', track.id)
    }
  }
  if (entry.audioStreamIndex !== undefined) {
    const tracks = await session.ipc.getProperty('track-list')
    const track = Array.isArray(tracks)
      ? (tracks as Array<{ type?: unknown; id?: unknown; 'ff-index'?: unknown }>).find((candidate) => candidate.type === 'audio' && candidate['ff-index'] === entry.audioStreamIndex)
      : undefined
    if (!track || typeof track.id !== 'number') {
      if (session.audioPreference?.index !== undefined) throw new Error(`《${entry.name}》未能映射音轨 ${entry.audioStreamIndex}`)
    } else {
      await session.ipc.setProperty('aid', track.id)
    }
  }
  entry.isPaused = false
  await session.ipc.setProperty('pause', false)
  const client = jellyfinClient
  if (client) {
    try {
      await client.reportPlaying(reportPayload(session, entry))
      session.syncError = undefined
    } catch (error) {
      session.syncError = error instanceof Error ? error.message : `${currentServerLabel()} 播放开始状态上报失败`
    }
  }
  session.phase = 'playing'
  logger.info('playback', 'playing', { sessionId: session.sessionId, itemId: entry.itemId, index: session.currentIndex })
  emitPlayback('snapshot', session)
  void prefetchNextEntry(session)
}

async function prefetchNextEntry(session: PlaybackSession): Promise<void> {
  const nextIndex = session.currentIndex + 1
  if (session.stopped || nextIndex >= session.queue.length || session.stopAfterCurrent || session.playlistTrimmed) return
  const entry = session.entries.get(nextIndex)
  if (!entry || entry.source) return
  const startedAt = Date.now()
  try {
    await ensureEntryPrepared(session, entry)
    logger.info('playback', 'entry-prefetched', { sessionId: session.sessionId, itemId: entry.itemId, queueIndex: nextIndex, durationMs: Date.now() - startedAt })
  } catch (error) {
    if (session.stopped || isAbortError(error)) return
    entry.preparationError = error instanceof Error ? error.message : '读取播放信息失败'
    logger.warn('playback', 'entry-prefetch-failed', { sessionId: session.sessionId, itemId: entry.itemId, queueIndex: nextIndex, durationMs: Date.now() - startedAt })
  }
}

function setPlaylistEntryIds(entry: PlaybackEntry, ids: number[]): void {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id)))]
  entry.playlistEntryIds = uniqueIds
  entry.playlistIndexes = uniqueIds.map(() => -1)
  entry.activePlaylistEntryId = uniqueIds[0]
  entry.activePlaylistIndex = undefined
}

function firstPlaylistIndex(entry: PlaybackEntry): number | undefined {
  if (!entry.playlistEntryIds.length || entry.playlistIndexes.some((index) => index < 0)) return undefined
  const indexes = entry.playlistIndexes.filter((index) => index >= 0)
  if (entry.activePlaylistIndex !== undefined) return entry.activePlaylistIndex
  return indexes.length ? Math.min(...indexes) : undefined
}

function lastPlaylistIndex(entry: PlaybackEntry): number | undefined {
  if (!entry.playlistEntryIds.length || entry.playlistIndexes.some((index) => index < 0)) return undefined
  const indexes = entry.playlistIndexes.filter((index) => index >= 0)
  return indexes.length ? Math.max(...indexes) : firstPlaylistIndex(entry)
}

function isLastPhysicalEntry(entry: PlaybackEntry, playlistEntryId?: number): boolean {
  if (entry.playlistEntryIds.length <= 1 || playlistEntryId === undefined) return true
  const offset = entry.playlistEntryIds.indexOf(playlistEntryId)
  if (offset < 0) return true
  if (entry.playlistIndexes.some((index) => index < 0)) return offset === entry.playlistEntryIds.length - 1
  const known = entry.playlistEntryIds
    .map((id, index) => ({ id, playlistIndex: entry.playlistIndexes[index] ?? -1 }))
    .filter((value) => value.playlistIndex >= 0)
    .sort((left, right) => left.playlistIndex - right.playlistIndex)
  const lastKnown = known.at(-1)?.id
  return lastKnown === undefined ? offset === entry.playlistEntryIds.length - 1 : playlistEntryId === lastKnown
}

async function refreshPlaylistMap(session: PlaybackSession, strict = false): Promise<void> {
  const value = await session.ipc.getProperty('playlist')
  if (!Array.isArray(value)) throw new Error('MPV 未返回有效的播放列表')
  const list = value as Array<{ id?: unknown }>
  const playlistIndexes = new Map<number, number>()
  for (let playlistIndex = 0; playlistIndex < list.length; playlistIndex += 1) {
    const id = list[playlistIndex]?.id
    if (typeof id === 'number' && Number.isInteger(id)) playlistIndexes.set(id, playlistIndex)
  }
  session.queueIndexByPlaylistId.clear()
  const claimedIds = new Set<number>()
  for (const [queueIndex, entry] of session.entries) {
    entry.playlistIndexes = entry.playlistEntryIds.map((id) => playlistIndexes.get(id) ?? -1)
    entry.playlistIndexes.forEach((index, offset) => {
      if (index >= 0) claimedIds.add(entry.playlistEntryIds[offset])
    })
    if (entry.activePlaylistEntryId !== undefined) {
      const activeIndex = entry.playlistEntryIds.indexOf(entry.activePlaylistEntryId)
      entry.activePlaylistIndex = activeIndex >= 0 && entry.playlistIndexes[activeIndex] >= 0
        ? entry.playlistIndexes[activeIndex]
        : undefined
    }
    entry.playlistEntryIds.forEach((id) => session.queueIndexByPlaylistId.set(id, queueIndex))
  }

  const unassignedEntries = [...session.entries.entries()].filter(([, entry]) => entry.playlistEntryIds.length === 0)
  const unclaimedIds = list
    .map((item) => item.id)
    .filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && !claimedIds.has(id))
  for (let index = 0; index < Math.min(unassignedEntries.length, unclaimedIds.length); index += 1) {
    const [queueIndex, entry] = unassignedEntries[index]
    setPlaylistEntryIds(entry, [unclaimedIds[index]])
    entry.playlistIndexes = [playlistIndexes.get(unclaimedIds[index]) ?? -1]
    session.queueIndexByPlaylistId.set(unclaimedIds[index], queueIndex)
  }

  if (strict && (list.length !== session.queue.length || unassignedEntries.length > unclaimedIds.length)) {
    throw new Error('MPV 播放列表条目数量与应用队列不一致')
  }
}

function applyRedirectMapping(session: PlaybackSession, entry: PlaybackEntry, queueIndex: number, message: MpvIpcMessage): void {
  const insertedId = message.playlist_insert_id
  const insertedCount = message.playlist_insert_num_entries
  if (typeof insertedId !== 'number' || !Number.isInteger(insertedId) || typeof insertedCount !== 'number' || !Number.isInteger(insertedCount) || insertedCount < 1) {
    logger.info('playback', 'redirect', { sessionId: session.sessionId, itemId: entry.itemId, queueIndex, mapped: false })
    return
  }
  entry.playlistEntryIds.forEach((id) => {
    if (session.queueIndexByPlaylistId.get(id) === queueIndex) session.queueIndexByPlaylistId.delete(id)
  })
  const ids = Array.from({ length: insertedCount }, (_, index) => insertedId + index)
  setPlaylistEntryIds(entry, ids)
  ids.forEach((id) => session.queueIndexByPlaylistId.set(id, queueIndex))
  logger.info('playback', 'redirect', { sessionId: session.sessionId, itemId: entry.itemId, queueIndex, mapped: true, insertedCount })
}

async function handleEndFile(session: PlaybackSession, message: MpvIpcMessage): Promise<void> {
  if (session.stopped) return
  const queueIndex = typeof message.playlist_entry_id === 'number' ? session.queueIndexByPlaylistId.get(message.playlist_entry_id) : session.currentIndex
  const entry = queueIndex === undefined ? session.currentEntry : session.entries.get(queueIndex)
  if (!entry || entry.finalized) return
  const reason = message.reason || (message.file_error ? 'error' : 'eof')
  if (reason === 'redirect') {
    if (queueIndex !== undefined) {
      applyRedirectMapping(session, entry, queueIndex, message)
      await refreshPlaylistMap(session).catch((error) => {
        logger.warn('playback', 'redirect-playlist-refresh-failed', {
          sessionId: session.sessionId,
          itemId: entry.itemId,
          message: error instanceof Error ? error.message : String(error),
        })
      })
    }
    return
  }
  if (reason === 'eof') {
    if (!isLastPhysicalEntry(entry, message.playlist_entry_id)) {
      logger.info('playback', 'physical-entry-finished', {
        sessionId: session.sessionId,
        itemId: entry.itemId,
        playlistEntryId: message.playlist_entry_id,
      })
      return
    }
    await finalizeEntry(session, entry, 'eof', true)
    const hasNext = queueIndex !== undefined && queueIndex + 1 < session.queue.length && !session.stopAfterCurrent && !session.playlistTrimmed
    if (!hasNext) await finishSession(session, 'eof', true)
    return
  }
  if (reason === 'stop' && !session.stopRequested) {
    await finalizeEntry(session, entry, session.pendingTransition ? 'skip' : 'stop', true)
    if (session.pendingTransition) return
    if (session.idleFinishTimer) clearTimeout(session.idleFinishTimer)
    session.idleFinishTimer = setTimeout(() => {
      if (!session.stopped && !session.currentEntry?.loaded) void finishSession(session, 'stop', true)
    }, 600)
    return
  }
  if (reason === 'error' || reason === 'unknown') {
    const diagnostic = entry.gatewayUrl ? session.gateway.getDiagnostic(entry.gatewayUrl) : undefined
    logger.warn('playback', 'mpv-end-file', {
      sessionId: session.sessionId,
      itemId: entry.itemId,
      reason,
      fileError: message.file_error,
      playlistEntryId: message.playlist_entry_id,
      gatewayPhase: diagnostic?.phase,
      gatewayStatus: diagnostic?.status,
      gatewayRedirects: diagnostic?.redirects,
    })
    session.syncError = formatPlaybackLoadError(entry.name, message.file_error, diagnostic, reason)
    const hasNext = queueIndex !== undefined && queueIndex + 1 < session.queue.length && !session.stopAfterCurrent && !session.playlistTrimmed
    if (hasNext && !session.startupPending) {
      entry.preparationError = session.syncError
      entry.finalized = true
      session.queueWarnings.push({ itemId: entry.itemId, label: entry.name, reason: session.syncError })
      session.syncError = undefined
      emitPlayback('snapshot', session, `${entry.name} 播放失败，已跳过`)
      const nextEntry = queueIndex === undefined ? undefined : session.entries.get(queueIndex + 1)
      const nextPlaylistIndex = nextEntry ? firstPlaylistIndex(nextEntry) : undefined
      if (nextPlaylistIndex !== undefined) {
        session.pendingTransition = true
        await session.ipc.send(['playlist-play-index', nextPlaylistIndex]).catch(() => undefined)
      }
      return
    }
    await finishSession(session, 'error', true)
    if (!session.startupPending) emitPlayback('error', session, session.syncError)
    return
  }
  await finishSession(session, reason, true)
}

async function handleMpvEvent(session: PlaybackSession, message: MpvIpcMessage): Promise<void> {
  if (message.event === 'start-file') {
    if (session.idleFinishTimer) clearTimeout(session.idleFinishTimer)
    const id = message.playlist_entry_id
    const index = typeof id === 'number' ? session.queueIndexByPlaylistId.get(id) : undefined
    const entry = index === undefined ? undefined : session.entries.get(index)
    if (!entry) {
      session.phase = 'error'
      session.syncError = 'MPV 返回了未知的播放列表条目'
      if (!session.startupPending) emitPlayback('error', session, session.syncError)
      return
    }
    if (index === undefined) return
    const playlistOffset = typeof id === 'number' ? entry.playlistEntryIds.indexOf(id) : -1
    if (playlistOffset >= 0) {
      entry.activePlaylistEntryId = id
      entry.activePlaylistIndex = entry.playlistIndexes[playlistOffset] >= 0 ? entry.playlistIndexes[playlistOffset] : undefined
      if (entry.activePlaylistIndex === undefined) {
        await refreshPlaylistMap(session)
        const refreshedOffset = entry.playlistEntryIds.indexOf(id as number)
        entry.activePlaylistIndex = refreshedOffset >= 0 && entry.playlistIndexes[refreshedOffset] >= 0
          ? entry.playlistIndexes[refreshedOffset]
          : undefined
      }
    }
    if (session.currentEntry === entry && entry.loaded) return
    session.currentIndex = index
    session.currentEntry = entry
    session.pendingTransition = false
    entry.loaded = false
    session.phase = 'switching'
    emitPlayback('snapshot', session)
    return
  }
  if (message.event === 'file-loaded') {
    if (session.currentEntry) await activateLoadedEntry(session, session.currentEntry)
    return
  }
  if (message.event === 'end-file') {
    await handleEndFile(session, message)
    return
  }
  if (message.event === 'property-change' && message.name === 'idle-active' && message.data === true && session.playlistReady && !session.stopRequested && !session.pendingTransition && !session.stopped) {
    await finishSession(session, 'stop', true)
  }
}

async function attachMpvIpc(session: PlaybackSession): Promise<void> {
  await session.ipc.connectWithRetry()
  logger.info('mpv', 'ipc-connected', { sessionId: session.sessionId })
  session.ipc.onEvent((message) => {
    if (message.event === 'property-change' && session.currentEntry) {
      const entry = session.currentEntry
      if (message.name === 'time-pos' && typeof message.data === 'number' && Number.isFinite(message.data)) {
        entry.positionSeconds = Math.max(0, message.data)
        entry.positionFresh = true
        entry.positionObserved = true
        emitPlayback('progress', session)
      } else if (message.name === 'duration' && typeof message.data === 'number' && Number.isFinite(message.data)) {
        entry.durationSeconds = Math.max(0, message.data)
      } else if (message.name === 'pause' && typeof message.data === 'boolean') {
        entry.isPaused = message.data
        session.phase = message.data ? 'paused' : 'playing'
        void reportActiveProgress(true, message.data ? 'Pause' : 'Unpause')
        emitPlayback('snapshot', session)
      }
    }
    if (message.event === 'ipc-closed' && !session.stopped && !session.finalizePromise) {
      session.syncError = 'MPV 进度接口连接已断开'
      emitPlayback('sync-error', session, session.syncError)
      return
    }
    if (message.event === 'start-file' || message.event === 'file-loaded' || message.event === 'end-file' || (message.event === 'property-change' && message.name === 'idle-active')) {
      session.eventChain = session.eventChain.then(() => handleMpvEvent(session, message)).catch((error) => {
        session.syncError = error instanceof Error ? error.message : 'MPV 播放事件处理失败'
        session.phase = 'error'
        if (!session.startupPending) emitPlayback('error', session, session.syncError)
      })
    }
  })
  await Promise.all([
    session.ipc.observeProperty(1, 'time-pos'),
    session.ipc.observeProperty(2, 'duration'),
    session.ipc.observeProperty(3, 'pause'),
    session.ipc.observeProperty(4, 'idle-active'),
  ])
}

async function stopActivePlayback(): Promise<void> {
  const session = activeSession
  if (!session) return
  await finishSession(session, 'quit', true)
}

async function startPlayback(request: StartPlaybackRequest): Promise<PlaybackSnapshot> {
  const client = getClient()
  const mpvValidation = validateMpvPath()
  if (!mpvValidation.valid) throw new Error(mpvValidation.message)
  await stopActivePlayback()
  const queuePlan = await buildQueue(client, request.itemId)
  if (!queuePlan.items.length) throw new Error('没有可播放的剧集')
  const pipeName = `\\\\.\\pipe\\jellyfin-mpv-player-${randomUUID()}`
  const session: PlaybackSession = {
    sessionId: randomUUID(),
    revision: 0,
    phase: 'preparing',
    queue: [],
    currentIndex: -1,
    entries: new Map(),
    process: undefined as unknown as ChildProcess,
    pipeName,
    ipc: new MpvIpc(pipeName),
    progressTimer: undefined as unknown as NodeJS.Timeout,
    stopAfterCurrent: false,
    stopped: false,
    queueWarnings: [],
    queueIndexByPlaylistId: new Map(),
    eventChain: Promise.resolve(),
    pendingTransition: false,
    stopRequested: false,
    playlistTrimmed: false,
    playlistReady: false,
    startupPending: true,
    audioPreference: request.audioPreference,
    subtitlePreference: request.subtitlePreference,
    selectedItemId: request.itemId,
    abortController: new AbortController(),
    gateway: new PlaybackGateway(client),
  }
  session.mediaSourceId = request.mediaSourceId
  session.queue = queuePlan.items.map(queueItem)
  session.currentIndex = queuePlan.startIndex
  queuePlan.items.forEach((item, index) => {
    const resumeTicks = index === queuePlan.startIndex ? resolveResumeTicks(item, request.startTimeTicks) : 0
    session.entries.set(index, createLogicalEntry(item, resumeTicks))
  })
  const selectedEntry = session.entries.get(queuePlan.startIndex)
  if (!selectedEntry) throw new Error('当前剧集无法加入播放列表')
  const preparationStartedAt = Date.now()
  try {
    await ensureEntryPrepared(session, selectedEntry)
    logger.info('playback', 'current-entry-ready', { sessionId: session.sessionId, itemId: selectedEntry.itemId, queueLength: session.queue.length, durationMs: Date.now() - preparationStartedAt })
  } catch (error) {
    throw new Error(`当前剧集《${selectedEntry.name}》无法播放：${error instanceof Error ? error.message : '读取播放信息失败'}`)
  }
  const args = [
    '--idle=yes',
    '--pause=yes',
    '--force-window=immediate',
    '--resume-playback=no',
    '--keep-open=yes',
    '--title=Jellyfin MPV Player',
    '--msg-level=all=warn',
    `--input-ipc-server=${pipeName}`,
  ]
  if (selectedEntry.item.Type === 'Episode' && session.queue.length > 1) {
    args.push(
      '--script-opt=osc-custom_button_1_content=\u2637',
      '--script-opt=osc-custom_button_1_mbtn_left_command=script-binding select/select-playlist; script-message-to osc osc-hide',
    )
  }
  logger.info('playback', 'start', { sessionId: session.sessionId, queueLength: session.queue.length, resume: selectedEntry.initialResumeTicks > 0 })
  const child = spawn(resolveMpvPath(), args, { windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] })
  session.process = child
  activeSession = session
  session.progressTimer = setInterval(() => void reportActiveProgress(), 10_000)
  let stderrBuffer = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string | Buffer) => {
    stderrBuffer += chunk.toString()
    const lines = stderrBuffer.split(/\r?\n/)
    stderrBuffer = lines.pop() || ''
    for (const line of lines) {
      if (line.trim()) logger.warn('mpv', 'stderr', { sessionId: session.sessionId, message: line })
    }
  })
  child.once('error', (error) => {
    logger.error('mpv', 'process-error', error, { sessionId: session.sessionId })
    void finishSession(session, 'error', true).finally(() => {
      if (!session.startupPending) emitPlayback('error', session, `无法启动 MPV：${error.message}`)
    })
  })
  child.once('close', (code, signal) => {
    if (stderrBuffer.trim()) logger.warn('mpv', 'stderr', { sessionId: session.sessionId, message: stderrBuffer })
    logger.info('mpv', 'process-closed', {
      sessionId: session.sessionId,
      code,
      signal,
      requested: Boolean(session.stopRequested || session.finalizePromise),
    })
    if (!session.stopped && !session.finalizePromise) void finishSession(session, code === 0 ? 'quit' : 'error', false)
  })
  try {
    await session.gateway.start()
    await attachMpvIpc(session)
    const playlistUrl = buildHexPlaylistUrl([...session.entries.entries()].map(([, entry]) => ({ item: entry, url: registerPlaybackRoute(session, entry) })))
    await session.ipc.setProperty('pause', true)
    await session.ipc.setProperty('http-header-fields', [])
    await session.ipc.send(['keybind', 'MBTN_RIGHT', 'script-binding', 'select/select-playlist'])
    await session.ipc.send(['keybind', 'Ctrl+E', 'script-binding', 'select/select-playlist'])
    await session.ipc.send(['loadlist', playlistUrl, 'append'])
    await refreshPlaylistMap(session, true)
    session.playlistReady = true
    const selectedPlaylistEntry = session.entries.get(queuePlan.startIndex)
    if (!selectedPlaylistEntry) throw new Error('无法定位当前剧集在 MPV 播放列表中的位置')
    const selectedPlaylistIndex = firstPlaylistIndex(selectedPlaylistEntry)
    if (selectedPlaylistIndex === undefined) throw new Error('无法定位当前剧集在 MPV 播放列表中的位置')
    const loaded = session.ipc.waitForEvent((message) => {
      if (message.event === 'end-file' && message.reason === 'redirect') return false
      return message.event === 'file-loaded' || message.event === 'end-file' || message.event === 'ipc-closed'
    }, 60_000)
    await session.ipc.send(['playlist-play-index', selectedPlaylistIndex])
    const loadEvent = await loaded
    if (loadEvent.event !== 'file-loaded') {
      const diagnostic = selectedPlaylistEntry.gatewayUrl ? session.gateway.getDiagnostic(selectedPlaylistEntry.gatewayUrl) : undefined
      logger.warn('playback', 'startup-load-failed', {
        sessionId: session.sessionId,
        itemId: selectedPlaylistEntry.itemId,
        reason: loadEvent.reason,
        fileError: loadEvent.file_error,
        gatewayPhase: diagnostic?.phase,
        gatewayStatus: diagnostic?.status,
        gatewayRedirects: diagnostic?.redirects,
      })
      throw new Error(formatPlaybackLoadError(selectedPlaylistEntry.name, loadEvent.file_error, diagnostic, loadEvent.reason))
    }
    session.currentEntry = selectedPlaylistEntry
    await activateLoadedEntry(session, selectedPlaylistEntry)
    session.startupPending = false
    return emitPlayback('snapshot', session)
  } catch (error) {
    session.startupPending = false
    await finishSession(session, 'error', true)
    throw error
  }
}

async function playbackCommand(request: PlaybackCommand): Promise<PlaybackSnapshot> {
  const session = activeSession
  if (!session || session.sessionId !== request.sessionId) return lastSnapshot
  try {
    if (request.command === 'stop') {
      session.stopRequested = true
      await finishSession(session, 'quit', true)
    } else if (request.command === 'stop-after-current') {
      session.stopAfterCurrent = !session.stopAfterCurrent
      let currentPlaylistIndex = session.currentEntry ? lastPlaylistIndex(session.currentEntry) : undefined
      if (session.stopAfterCurrent && currentPlaylistIndex === undefined) {
        await refreshPlaylistMap(session)
        currentPlaylistIndex = session.currentEntry ? lastPlaylistIndex(session.currentEntry) : undefined
      }
      if (session.stopAfterCurrent && currentPlaylistIndex !== undefined) {
        const playlist = await session.ipc.getProperty('playlist')
        if (Array.isArray(playlist)) {
          for (let index = playlist.length - 1; index > currentPlaylistIndex; index -= 1) await session.ipc.send(['playlist-remove', index])
          for (let index = session.currentIndex + 1; index < session.queue.length; index += 1) {
            const entry = session.entries.get(index)
            if (entry) {
              entry.playlistEntryIds = []
              entry.playlistIndexes = []
              entry.activePlaylistEntryId = undefined
              entry.activePlaylistIndex = undefined
            }
          }
          session.playlistTrimmed = true
          await refreshPlaylistMap(session)
        }
      } else if (!session.stopAfterCurrent && session.playlistTrimmed) {
        const tail = Array.from(session.entries.entries())
          .filter(([index, entry]) => index > session.currentIndex && entry.playlistEntryIds.length === 0)
          .map(([, entry]) => ({ item: entry, url: registerPlaybackRoute(session, entry) }))
        if (tail.length) await session.ipc.send(['loadlist', buildHexPlaylistUrl(tail), 'append'])
        session.playlistTrimmed = false
        await refreshPlaylistMap(session)
      }
      emitPlayback('snapshot', session)
    } else if (request.command === 'pause' || request.command === 'resume') {
      await session.ipc.setProperty('pause', request.command === 'pause')
    } else if (request.command === 'next' || request.command === 'previous') {
      const nextIndex = request.command === 'next' ? session.currentIndex + 1 : session.currentIndex - 1
      if (nextIndex >= 0 && nextIndex < session.queue.length) {
        session.pendingTransition = true
        const targetEntry = session.entries.get(nextIndex)
        let targetPlaylistIndex = targetEntry ? firstPlaylistIndex(targetEntry) : undefined
        if (targetPlaylistIndex === undefined) {
          await refreshPlaylistMap(session)
          targetPlaylistIndex = targetEntry ? firstPlaylistIndex(targetEntry) : undefined
        }
        if (targetPlaylistIndex === undefined) throw new Error('目标剧集不在 MPV 播放列表中')
        await session.ipc.send(['playlist-play-index', targetPlaylistIndex])
      }
    }
  } catch (error) {
    session.phase = 'error'
    session.syncError = error instanceof Error ? error.message : '播放控制失败'
    emitPlayback('error', session, session.syncError)
  }
  return lastSnapshot
}

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
      await stopActivePlayback()
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
    await stopActivePlayback()
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
      return await startPlayback(request)
    } catch (error) {
      logger.error('playback', 'start-failed', error, { itemId: request.itemId })
      throw error
    }
  })
  ipcMain.handle('playback:command', (_event, request: PlaybackCommand) => playbackCommand(request))
  ipcMain.handle('playback:snapshot', () => snapshotFor(activeSession))
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
    if (!activeSession) return
    event.preventDefault()
    quitting = true
    void stopActivePlayback().finally(() => app.quit())
  })
}
