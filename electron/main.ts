import { app, BrowserWindow, ipcMain, Menu, safeStorage, shell } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EmbyClient, normalizeServerUrl, type MediaSourceInfo, type PlaybackInfo } from './emby'
import { MpvIpc, type MpvIpcMessage } from './mpvIpc'
import { buildMpvHttpHeaders } from './mpvHeaders'
import { normalizeMpvPath } from './mpvPath'
import { logger } from './logger'
import { buildEpisodeQueue } from '../src/playbackQueue'
import { chooseDefaultSubtitle } from '../src/subtitlePreference'
import { isResumePositionReached, resolveResumeTicks, shouldAdvanceAfterEnd } from './playbackLogic'
import type {
  AudioPreference,
  EmbyItem,
  MediaStream,
  PlaybackCommand,
  PlaybackEvent,
  PlaybackQueueItem,
  PlaybackReportPayload,
  PlaybackSnapshot,
  PlaybackPhase,
  StartPlaybackRequest,
  SubtitlePreference,
} from '../src/types'

interface StoredSettings {
  serverUrl: string
  username: string
  userId?: string
  encryptedToken?: string
  mpvPath: string
  deviceId: string
}

interface PlaybackEntry extends PlaybackQueueItem {
  item: EmbyItem
  source: MediaSourceInfo
  playbackInfo: PlaybackInfo
  positionSeconds: number
  durationSeconds?: number
  positionFresh: boolean
  positionObserved: boolean
  isPaused: boolean
  audioStreamIndex?: number
  subtitleStreamIndex?: number
  finalized: boolean
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
  loadingNext: boolean
  transitioning: boolean
  stopAfterCurrent: boolean
  stopped: boolean
  syncError?: string
  endReason?: string
  audioPreference?: AudioPreference
  subtitlePreference?: SubtitlePreference
  mediaSourceId?: string
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
let activeSession: PlaybackSession | null = null
let revisionCounter = 0
let lastSnapshot: PlaybackSnapshot = {
  revision: 0,
  phase: 'idle',
  queue: [],
  currentIndex: -1,
  positionTicks: 0,
}
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
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<StoredSettings> & {
      continuousPlayback?: unknown
      preferChineseSubtitles?: unknown
    }
    const { continuousPlayback: _legacyContinuousPlayback, preferChineseSubtitles: _legacyChineseSubtitles, ...persisted } = parsed
    storedSettings = {
      ...storedSettings,
      ...persisted,
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
    mpvPath: storedSettings.mpvPath || 'mpv.exe',
    connected: Boolean(embyClient),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
  }
}

function resolveMpvPath(candidate?: string): string {
  const selected = typeof candidate === 'string' && candidate.trim() ? candidate : storedSettings.mpvPath
  return normalizeMpvPath(selected)
}

function validateMpvPath(candidate?: string): { path: string; version?: string; message: string } {
  const mpvPath = resolveMpvPath(candidate)
  const result = spawnSync(mpvPath, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
  if (result.error || result.status !== 0) {
    return { path: mpvPath, message: `找不到可用的 MPV：${mpvPath}` }
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  return { path: mpvPath, version: output.split(/\r?\n/).find((line) => line.trim())?.trim(), message: 'MPV 路径有效' }
}

function testMpvPath(candidate?: string): { path: string; version?: string; message: string } {
  const validation = validateMpvPath(candidate)
  if (!validation.version) return validation
  const child = spawn(validation.path, ['--idle=yes', '--force-window=no', '--no-video', '--no-audio'], { windowsHide: true, stdio: 'ignore' })
  setTimeout(() => { if (!child.killed) child.kill() }, 700)
  return { ...validation, message: 'MPV 测试启动成功' }
}

function restoreClient(): void {
  const token = decryptToken()
  if (token && storedSettings.userId) {
    try {
      embyClient = new EmbyClient(storedSettings.serverUrl, token, storedSettings.userId, storedSettings.deviceId)
    } catch (error) {
      embyClient = null
      logger.error('emby', 'restore-client-failed', error)
    }
  }
}

function getClient(): EmbyClient {
  if (!embyClient) throw new Error('请先连接 Emby 服务器')
  return embyClient
}

function queueItem(item: EmbyItem): PlaybackQueueItem {
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

async function buildQueue(client: EmbyClient, itemId: string): Promise<EmbyItem[]> {
  const selected = await client.getItem(itemId)
  if (selected.Type !== 'Episode' || !selected.SeriesId) return [selected]

  const episodes = (await client.getSeriesEpisodes(selected.SeriesId)).filter((item) => item.LocationType?.toLowerCase() !== 'virtual')
  return buildEpisodeQueue(episodes, selected)
}

function chooseAudio(streams: MediaStream[], preference?: AudioPreference): number | undefined {
  if (preference?.index !== undefined && streams.some((stream) => stream.Type === 'Audio' && stream.Index === preference.index)) return preference.index
  const language = preference?.language?.toLowerCase()
  const title = preference?.title?.toLowerCase()
  return streams.find((stream) => stream.Type === 'Audio' && language && (stream.Language || stream.DisplayLanguage || '').toLowerCase() === language)?.Index
    ?? streams.find((stream) => stream.Type === 'Audio' && title && (stream.Title || stream.DisplayTitle || '').toLowerCase().includes(title))?.Index
    ?? streams.find((stream) => stream.Type === 'Audio' && stream.IsDefault)?.Index
    ?? streams.find((stream) => stream.Type === 'Audio')?.Index
}

function chooseSubtitle(streams: MediaStream[], preference?: SubtitlePreference): number | undefined {
  if (preference?.disabled) return undefined
  if (preference?.index !== undefined && streams.some((stream) => stream.Type === 'Subtitle' && stream.Index === preference.index)) return preference.index
  return chooseDefaultSubtitle(streams)
}

async function prepareEntry(session: PlaybackSession, item: EmbyItem, startTimeTicks = 0): Promise<PlaybackEntry> {
  const client = getClient()
  const playbackInfo = await client.getPlaybackInfo(item.Id)
  const sources = playbackInfo.MediaSources || []
  if (!sources.length) throw new Error(`《${item.Name}》没有可用的视频源`)
  const requestedSource = session.mediaSourceId ? sources.find((candidate) => candidate.Id === session.mediaSourceId) : undefined
  const source = requestedSource
    || sources.find((candidate) => candidate.SupportsDirectPlay)
    || sources.find((candidate) => candidate.SupportsDirectStream)
    || sources[0]
  const streams = (source.MediaStreams || item.MediaStreams || []) as MediaStream[]
  const audioStreamIndex = chooseAudio(streams, session.audioPreference)
  const subtitleStreamIndex = chooseSubtitle(streams, session.subtitlePreference)
  return {
    ...queueItem(item),
    item,
    source,
    playbackInfo,
    positionSeconds: Math.max(0, startTimeTicks / 10_000_000),
    positionFresh: false,
    positionObserved: false,
    isPaused: false,
    audioStreamIndex,
    subtitleStreamIndex,
    finalized: false,
  }
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

function reportPayload(session: PlaybackSession, entry: PlaybackEntry, eventName?: PlaybackProgressEvent): PlaybackReportPayload {
  return {
    ItemId: entry.itemId,
    MediaSourceId: entry.source.Id,
    PlaySessionId: entry.playbackInfo.PlaySessionId,
    PlayMethod: entry.source.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream',
    PositionTicks: Math.max(0, Math.round(entry.positionSeconds * 10_000_000)),
    IsPaused: entry.isPaused,
    CanSeek: true,
    AudioStreamIndex: entry.audioStreamIndex,
    SubtitleStreamIndex: entry.subtitleStreamIndex,
    PlaylistIndex: session.currentIndex,
    PlaylistLength: session.queue.length,
    QueueableMediaTypes: ['Video'],
    ...(eventName ? { EventName: eventName } : {}),
  }
}

type PlaybackProgressEvent = NonNullable<PlaybackReportPayload['EventName']>

async function reportEntryProgress(session: PlaybackSession, entry: PlaybackEntry, force = false, eventName: PlaybackProgressEvent = 'TimeUpdate'): Promise<void> {
  const client = embyClient
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
      session.syncError = error instanceof Error ? error.message : 'Emby 进度上报失败'
      emitPlayback('sync-error', session, session.syncError)
    } finally {
      session.progressPromise = undefined
    }
  })()
  session.progressPromise = promise
  await promise
}

async function readLatestMpvState(session: PlaybackSession): Promise<void> {
  const entry = session.currentEntry
  if (!entry) return
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

async function finalizeEntry(session: PlaybackSession, reason: string, keepProcess: boolean): Promise<void> {
  const entry = session.currentEntry
  if (!entry || entry.finalized) return
  logger.info('playback', 'finalize-entry', { sessionId: session.sessionId, itemId: entry.itemId, reason, keepProcess })
  await readLatestMpvState(session)
  session.endReason = reason
  if (reason === 'eof' && entry.durationSeconds !== undefined) {
    entry.positionSeconds = Math.max(entry.positionSeconds, entry.durationSeconds)
    entry.positionObserved = true
    entry.positionFresh = true
  }
  await reportActiveProgress(true, 'TimeUpdate')
  if (!entry.positionObserved && !session.syncError) session.syncError = '未能取得 MPV 的最终播放位置'
  const client = embyClient
  if (client) {
    try {
      await client.reportStopped(reportPayload(session, entry))
      session.syncError = undefined
    } catch (error) {
      session.syncError = error instanceof Error ? error.message : 'Emby 播放结束状态上报失败'
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
    session.transitioning = true
    session.phase = 'stopping'
    session.endReason = reason
    emitPlayback('snapshot', session)
    clearInterval(session.progressTimer)
    try {
      await finalizeEntry(session, reason, false)
    } catch (error) {
      session.syncError = error instanceof Error ? error.message : '播放结束状态上报失败'
    }
    session.stopped = true
    session.ipc.close()
    if (terminate && !session.process.killed) session.process.kill()
    if (activeSession === session) activeSession = null
    session.phase = reason === 'error' ? 'error' : 'stopped'
    emitPlayback('snapshot', session, reason === 'eof' ? '播放完成' : reason === 'quit' ? 'MPV 已关闭' : undefined)
  })()
  await session.finalizePromise
}

function buildStreamUrl(session: PlaybackSession, entry: PlaybackEntry): string {
  return getClient().buildStreamUrl(entry.itemId, entry.source, {
    audioStreamIndex: entry.audioStreamIndex,
    subtitleStreamIndex: entry.subtitleStreamIndex,
    playSessionId: entry.playbackInfo.PlaySessionId,
  })
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

async function loadEntry(session: PlaybackSession, index: number, startTimeTicks = 0): Promise<void> {
  if (index < 0 || index >= session.queue.length || session.stopped) return
  const item = session.entries.get(index)?.item || await getClient().getItem(session.queue[index].itemId)
  const cachedEntry = session.entries.get(index)
  const entry = cachedEntry && !cachedEntry.finalized
    ? { ...cachedEntry, positionSeconds: Math.max(0, startTimeTicks / 10_000_000), positionFresh: false, positionObserved: false, isPaused: false }
    : await prepareEntry(session, item, startTimeTicks)
  session.entries.set(index, entry)
  logger.info('playback', 'load-entry', { sessionId: session.sessionId, itemId: entry.itemId, index, resume: startTimeTicks > 0 })
  session.phase = 'switching'
  session.loadingNext = true
  session.transitioning = true
  try {
    await session.ipc.setProperty('pause', true)
    const loaded = session.ipc.waitForEvent(
      (message) => message.event === 'file-loaded' || message.event === 'end-file' || message.event === 'ipc-closed',
    )
    await session.ipc.setProperty('http-header-fields', buildMpvHttpHeaders(entry.source, getClient().token))
    await session.ipc.send(['loadfile', buildStreamUrl(session, entry), 'replace'])
    const loadEvent = await loaded
    if (loadEvent.event !== 'file-loaded') {
      throw new Error(loadEvent.file_error || `《${entry.name}》加载失败`)
    }
    session.currentIndex = index
    session.currentEntry = entry
    if (startTimeTicks > 0) {
      await seekEntry(session, entry, startTimeTicks)
    }
    if (entry.subtitleStreamIndex !== undefined) {
      const subtitle = entry.source.MediaStreams?.find((stream) => stream.Type === 'Subtitle' && stream.Index === entry.subtitleStreamIndex)
      if (!subtitle || subtitle.IsTextSubtitleStream !== false) {
        await session.ipc.send(['sub-add', getClient().buildSubtitleUrl(entry.itemId, entry.source.Id, entry.subtitleStreamIndex), 'select']).catch(() => undefined)
      }
    }
    entry.isPaused = false
    await session.ipc.setProperty('pause', false)
    const client = embyClient
    if (client) {
      try {
        await client.reportPlaying(reportPayload(session, entry))
        session.syncError = undefined
      } catch (error) {
        session.syncError = error instanceof Error ? error.message : 'Emby 播放开始状态上报失败'
      }
    }
    session.phase = 'playing'
    logger.info('playback', 'playing', { sessionId: session.sessionId, itemId: entry.itemId, index })
    emitPlayback('snapshot', session)
  } finally {
    session.loadingNext = false
    session.transitioning = false
  }
}

async function handleEndFile(session: PlaybackSession, message: MpvIpcMessage): Promise<void> {
  if (session.stopped || session.transitioning || session.loadingNext || !session.currentEntry || session.currentEntry.finalized) return
  const reason = message.reason || (message.file_error ? 'error' : 'eof')
  if (shouldAdvanceAfterEnd({
    reason,
    stopAfterCurrent: session.stopAfterCurrent,
    currentIndex: session.currentIndex,
    queueLength: session.queue.length,
    transitioning: session.transitioning || session.loadingNext,
  })) {
    session.loadingNext = true
    session.transitioning = true
    try {
      await finalizeEntry(session, 'eof', true)
      await loadEntry(session, session.currentIndex + 1)
    } finally {
      session.loadingNext = false
      session.transitioning = false
    }
    return
  }
  await finishSession(session, reason, true)
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
    } else if (message.event === 'end-file' && !session.transitioning) {
      void handleEndFile(session, message).catch((error) => {
        session.syncError = error instanceof Error ? error.message : '切换下一集失败'
        session.phase = 'error'
        emitPlayback('error', session, session.syncError)
      })
    } else if (message.event === 'ipc-closed' && !session.stopped && !session.finalizePromise) {
      session.syncError = 'MPV 进度接口连接已断开'
      emitPlayback('sync-error', session, session.syncError)
    }
  })
  await Promise.all([
    session.ipc.observeProperty(1, 'time-pos'),
    session.ipc.observeProperty(2, 'duration'),
    session.ipc.observeProperty(3, 'pause'),
  ])
}

async function stopActivePlayback(): Promise<void> {
  const session = activeSession
  if (!session) return
  await finishSession(session, 'quit', true)
}

async function startPlayback(request: StartPlaybackRequest): Promise<PlaybackSnapshot> {
  const client = getClient()
  await stopActivePlayback()
  const items = await buildQueue(client, request.itemId)
  if (!items.length) throw new Error('没有可播放的剧集')
  const selected = items[0]
  const resumeTicks = resolveResumeTicks(selected, request.startTimeTicks)
  const pipeName = `\\\\.\\pipe\\ember-player-${randomUUID()}`
  const session: PlaybackSession = {
    sessionId: randomUUID(),
    revision: 0,
    phase: 'preparing',
    queue: items.map(queueItem),
    currentIndex: 0,
    entries: new Map(),
    process: undefined as unknown as ChildProcess,
    pipeName,
    ipc: new MpvIpc(pipeName),
    progressTimer: undefined as unknown as NodeJS.Timeout,
    loadingNext: false,
    transitioning: false,
    stopAfterCurrent: false,
    stopped: false,
    audioPreference: request.audioPreference,
    subtitlePreference: request.subtitlePreference,
  }
  session.mediaSourceId = request.mediaSourceId
  const firstEntry = await prepareEntry(session, selected, resumeTicks)
  session.entries.set(0, firstEntry)
  const args = [
    '--idle=yes',
    '--pause=yes',
    '--force-window=immediate',
    '--resume-playback=no',
    '--title=Ember Player',
    '--msg-level=all=warn',
    `--input-ipc-server=${pipeName}`,
  ]
  logger.info('playback', 'start', { sessionId: session.sessionId, queueLength: session.queue.length, resume: resumeTicks > 0 })
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
    void finishSession(session, 'error', true).finally(() => emitPlayback('error', session, `无法启动 MPV：${error.message}`))
  })
  child.once('close', (code) => {
    if (stderrBuffer.trim()) logger.warn('mpv', 'stderr', { sessionId: session.sessionId, message: stderrBuffer })
    logger.info('mpv', 'process-closed', { sessionId: session.sessionId, code })
    if (!session.stopped && !session.finalizePromise) void finishSession(session, code === 0 ? 'quit' : 'error', false)
  })
  try {
    await attachMpvIpc(session)
    await loadEntry(session, 0, resumeTicks)
    return emitPlayback('snapshot', session)
  } catch (error) {
    await finishSession(session, 'error', true)
    throw error
  }
}

async function playbackCommand(request: PlaybackCommand): Promise<PlaybackSnapshot> {
  const session = activeSession
  if (!session || session.sessionId !== request.sessionId) return lastSnapshot
  try {
    if (request.command === 'stop') {
      await finishSession(session, 'quit', true)
    } else if (request.command === 'stop-after-current') {
      session.stopAfterCurrent = !session.stopAfterCurrent
      emitPlayback('snapshot', session)
    } else if (request.command === 'pause' || request.command === 'resume') {
      await session.ipc.setProperty('pause', request.command === 'pause')
    } else if (request.command === 'next' || request.command === 'previous') {
      const nextIndex = request.command === 'next' ? session.currentIndex + 1 : session.currentIndex - 1
      if (nextIndex >= 0 && nextIndex < session.queue.length) {
        await finalizeEntry(session, 'skip', true)
        session.loadingNext = true
        session.transitioning = true
        try {
          const stopped = session.ipc.waitForEvent((message) => message.event === 'end-file')
          await session.ipc.send(['stop'])
          await stopped
        } finally {
          session.loadingNext = false
          session.transitioning = false
        }
        await loadEntry(session, nextIndex)
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
  ipcMain.handle('settings:get', () => publicSettings())
  ipcMain.handle('settings:save', (_event, input: { serverUrl: string; username: string; mpvPath: string }) => {
    const nextUrl = normalizeServerUrl(input.serverUrl)
    if (nextUrl !== storedSettings.serverUrl) embyClient = null
    storedSettings.serverUrl = nextUrl
    storedSettings.username = input.username.trim()
    storedSettings.mpvPath = normalizeMpvPath(input.mpvPath)
    persistSettings()
    return publicSettings()
  })
  ipcMain.handle('emby:login', async (_event, input: { serverUrl: string; username: string; password: string; mpvPath: string }) => {
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const result = await EmbyClient.authenticate(serverUrl, input.username.trim(), input.password)
    storedSettings.serverUrl = serverUrl
    storedSettings.username = input.username.trim()
    storedSettings.userId = result.User.Id
    storedSettings.mpvPath = normalizeMpvPath(input.mpvPath)
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
  ipcMain.handle('emby:get-next-up', (_event, seriesId?: string) => getClient().getNextUp(seriesId))
  ipcMain.handle('emby:get-series-episodes', (_event, seriesId: string) => getClient().getSeriesEpisodes(seriesId))
  ipcMain.handle('emby:get-image', async (_event, request: { itemId: string; imageType?: string; tag?: string; maxWidth?: number }) => {
    const client = getClient()
    const key = JSON.stringify(request)
    const cached = readCachedImage(key)
    if (cached) return cached
    const image = await client.getImage(request.itemId, request.imageType || 'Primary', request.tag, request.maxWidth || 480)
    writeCachedImage(key, image)
    return image
  })
  ipcMain.handle('mpv:validate', (_event, mpvPath?: string) => {
    const result = validateMpvPath(mpvPath)
    return { valid: Boolean(result.version), ...result }
  })
  ipcMain.handle('mpv:test', (_event, mpvPath?: string) => {
    const result = testMpvPath(mpvPath)
    return { valid: Boolean(result.version), ...result }
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
    if (quitting) return
    logger.info('app', 'quit-requested')
    if (!activeSession) return
    event.preventDefault()
    quitting = true
    void stopActivePlayback().finally(() => app.quit())
  })
}
