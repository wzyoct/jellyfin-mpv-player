import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MpvIpcMessage } from './mpvIpc'

type Handler = (...args: any[]) => any

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  events: new Map<string, Handler>(),
  mpvInstances: [] as FakeMpvIpc[],
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  fetchMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  waitSequences: [] as MpvIpcMessage[][],
  mainWindow: null as any,
  logger: {
    initialize: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getDirectory: vi.fn(() => 'C:\\logs'),
  },
}))

class FakeMpvIpc {
  readonly pipeName: string
  readonly properties = new Map<string, unknown>([
    ['time-pos', 2],
    ['duration', 100],
    ['pause', true],
    ['playlist', [{ id: 1 }]],
    ['track-list', [
      { id: 1, type: 'audio', 'ff-index': 1 },
      { id: 2, type: 'sub', 'ff-index': 2 },
    ]],
  ])
  eventHandler?: (message: MpvIpcMessage) => void
  readonly send = vi.fn(async () => undefined)
  readonly setProperty = vi.fn(async (name: string, value: unknown) => {
    this.properties.set(name, value)
  })
  readonly getProperty = vi.fn(async (name: string) => this.properties.get(name))
  readonly connectWithRetry = vi.fn(async () => undefined)
  readonly observeProperty = vi.fn(async () => undefined)
  readonly waitSequence: MpvIpcMessage[]
  readonly waitForEvent = vi.fn(async (predicate: (message: MpvIpcMessage) => boolean) => {
    while (this.waitSequence.length) {
      const message = this.waitSequence.shift() as MpvIpcMessage
      this.emit(message)
      if (predicate(message)) return message
    }
    return { event: 'file-loaded' as const }
  })
  readonly close = vi.fn()

  constructor(pipeName: string) {
    this.pipeName = pipeName
    this.waitSequence = mocks.waitSequences.shift() || []
    mocks.mpvInstances.push(this)
  }

  onEvent(callback: (message: MpvIpcMessage) => void): void {
    this.eventHandler = callback
  }

  emit(message: MpvIpcMessage): void {
    this.eventHandler?.(message)
  }
}

vi.mock('electron', () => {
  class FakeBrowserWindow {
    fullScreen = false
    readonly windowEvents = new Map<string, Handler>()
    static getAllWindows = vi.fn(() => [])
    readonly webContents = {
      once: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    }
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly isDestroyed = vi.fn(() => false)
    readonly isVisible = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly restore = vi.fn()
    readonly loadURL = vi.fn(async () => undefined)
    readonly loadFile = vi.fn(async () => undefined)
    readonly isFullScreen = vi.fn(() => this.fullScreen)
    readonly setFullScreen = vi.fn((enabled: boolean) => {
      this.fullScreen = enabled
    })
    readonly once = vi.fn((event: string, handler: Handler) => {
      this.windowEvents.set(event, handler)
    })
    readonly on = vi.fn((event: string, handler: Handler) => {
      this.windowEvents.set(event, handler)
    })

    constructor() {
      mocks.mainWindow = this
    }
  }

  return {
    app: {
      isPackaged: false,
      requestSingleInstanceLock: vi.fn(() => true),
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn((event: string, handler: Handler) => mocks.events.set(event, handler)),
      quit: vi.fn(),
      setPath: vi.fn(),
      getPath: vi.fn(() => 'C:\\ember-data'),
      getVersion: vi.fn(() => '0.8.5'),
      commandLine: { appendSwitch: vi.fn() },
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)),
      on: vi.fn((channel: string, handler: Handler) => mocks.events.set(channel, handler)),
    },
    Menu: { setApplicationMenu: vi.fn() },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
    shell: { openPath: vi.fn(async () => '') },
  }
})

vi.mock('node:child_process', () => ({
  spawn: mocks.spawnMock,
  spawnSync: mocks.spawnSyncMock,
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: mocks.writeFileSyncMock,
  readFileSync: vi.fn(),
  writeFileSync: mocks.writeFileSyncMock,
}))

vi.mock('./mpvIpc', () => ({
  MpvIpc: FakeMpvIpc,
}))

vi.mock('./logger', () => ({ logger: mocks.logger }))

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeChild(): EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn>; stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> } } {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean
    kill: ReturnType<typeof vi.fn>
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  }
  child.killed = false
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  child.kill = vi.fn(() => {
    child.killed = true
    child.emit('close', 0)
    return true
  })
  return child
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function handler(name: string): Handler {
  const value = mocks.handlers.get(name)
  if (!value) throw new Error(`missing handler ${name}`)
  return value
}

describe('Electron main process IPC orchestration', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.fetchMock)
    await import('./main')
    await flush()
  })

  beforeEach(() => {
    mocks.fetchMock.mockReset()
    mocks.writeFileSyncMock.mockReset()
    mocks.spawnMock.mockReset()
    mocks.spawnSyncMock.mockReset()
    mocks.waitSequences.length = 0
    mocks.mpvInstances.length = 0
    mocks.spawnSyncMock.mockReturnValue({ status: 0, stdout: 'mpv 0.41.0', stderr: '' })
    mocks.spawnMock.mockImplementation(() => makeChild())
    if (mocks.mainWindow) {
      mocks.mainWindow.fullScreen = false
      mocks.mainWindow.webContents.send.mockReset()
    }
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('registers settings, normalizes saved input, and reports disconnected state', async () => {
    const initial = await handler('settings:get')()
    expect(initial.connected).toBe(false)

    const saved = await handler('settings:save')({}, {
      serverUrl: 'media.example.test/web/index.html',
      username: '  mickey  ',
      mpvPath: '  "C:\\Program Files\\mpv\\mpv.exe"  ',
    })
    expect(saved).toMatchObject({
      serverUrl: 'http://media.example.test',
      username: 'mickey',
      mpvPath: 'C:\\Program Files\\mpv\\mpv.exe',
      connected: false,
    })
  })

  it('controls fullscreen state and publishes native window events', async () => {
    expect(await handler('window:get-full-screen')()).toBe(false)
    expect(handler('window:set-full-screen')({}, true)).toBe(true)
    expect(mocks.mainWindow.setFullScreen).toHaveBeenCalledWith(true)

    const enterFullScreen = mocks.mainWindow.windowEvents.get('enter-full-screen')
    expect(enterFullScreen).toBeDefined()
    enterFullScreen?.()
    expect(mocks.mainWindow.webContents.send).toHaveBeenCalledWith('window:full-screen-changed', true)

    expect(handler('window:set-full-screen')({}, false)).toBe(false)
    const leaveFullScreen = mocks.mainWindow.windowEvents.get('leave-full-screen')
    expect(leaveFullScreen).toBeDefined()
    leaveFullScreen?.()
    expect(mocks.mainWindow.webContents.send).toHaveBeenCalledWith('window:full-screen-changed', false)
  })

  it('logs in, forwards authenticated API calls, and caches images', async () => {
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ ProductName: 'Jellyfin Server', ServerName: 'Test Jellyfin', Version: '10.11.11' }))
      .mockResolvedValueOnce(jsonResponse({ AccessToken: 'token-1', User: { Id: 'user-1', Name: 'Mickey' } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    const result = await handler('jellyfin:login')({}, {
      serverUrl: 'media.example.test',
      username: ' mickey ',
      password: 'secret',
      mpvPath: 'mpv.exe',
    })
    expect(result.user).toEqual({ Id: 'user-1', Name: 'Mickey' })
    expect(result.settings).toMatchObject({ connected: true, userId: 'user-1', username: 'mickey', serverVersion: '10.11.11' })
    const [loginUrl, loginInit] = mocks.fetchMock.mock.calls[1]
    expect(loginUrl).toBe('http://media.example.test/Users/AuthenticateByName')
    expect(JSON.parse(loginInit.body)).toEqual({ Username: 'mickey', Pw: 'secret' })

    const request = { itemId: 'item-1', imageType: 'Primary', tag: 'tag-1', maxWidth: 480 }
    await expect(handler('jellyfin:get-image')({}, request)).resolves.toBe('data:image/png;base64,AQID')
    await expect(handler('jellyfin:get-image')({}, request)).resolves.toBe('data:image/png;base64,AQID')
    expect(mocks.fetchMock).toHaveBeenCalledTimes(3)
    expect(mocks.fetchMock.mock.calls[2][0]).toContain('/Items/item-1/Images/Primary')
    expect((mocks.fetchMock.mock.calls[2][1].headers as Headers).get('Authorization')).toContain('Token="token-1"')

    let resolveImage!: (response: Response) => void
    const pendingImage = new Promise<Response>((resolve) => { resolveImage = resolve })
    mocks.fetchMock.mockReturnValueOnce(pendingImage)
    const concurrentRequest = { itemId: 'item-2', imageType: 'Primary', tag: 'tag-2', maxWidth: 480 }
    const first = handler('jellyfin:get-image')({}, concurrentRequest)
    const second = handler('jellyfin:get-image')({}, concurrentRequest)
    await flush()
    expect(mocks.fetchMock).toHaveBeenCalledTimes(4)
    resolveImage(new Response(Uint8Array.from([4, 5, 6]), { status: 200, headers: { 'content-type': 'image/png' } }))
    await expect(Promise.all([first, second])).resolves.toEqual([
      'data:image/png;base64,BAUG',
      'data:image/png;base64,BAUG',
    ])
    expect(mocks.fetchMock).toHaveBeenCalledTimes(4)
  })

  it('starts a resumed movie and drives MPV progress and completion events', async () => {
    const movie = { Id: 'movie-1', Name: '测试电影', Type: 'Movie', MediaStreams: [] }
    const playbackInfo = {
      PlaySessionId: 'play-session-1',
      MediaSources: [{
        Id: 'source-1',
        SupportsDirectPlay: true,
        RequiredHttpHeaders: { Referer: 'https://media.example.test' },
        MediaStreams: [
          { Type: 'Audio', Index: 1, Language: 'ja' },
          { Type: 'Subtitle', Index: 2, DisplayLanguage: '简体中文' },
        ],
      }],
    }
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-1/PlaybackInfo')) return jsonResponse(playbackInfo)
      if (url.includes('/Users/user-1/Items/movie-1')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, {
      itemId: 'movie-1',
      startTimeTicks: 20_000_000,
      audioPreference: { language: 'ja' },
      subtitlePreference: { index: 2 },
    })
    expect(snapshot).toMatchObject({ phase: 'playing', currentItemId: 'movie-1', positionTicks: 20_000_000 })
    const ipc = mocks.mpvInstances.at(-1)
    expect(ipc).toBeDefined()
    expect(ipc?.setProperty).toHaveBeenCalledWith('pause', false)
    expect(ipc?.send.mock.calls.some(([command]) => command[0] === 'playlist-play-index')).toBe(true)
    expect(mocks.fetchMock.mock.calls.some(([url]) => url.includes('/Sessions/Playing'))).toBe(true)

    ipc?.emit({ event: 'property-change', name: 'time-pos', data: 12 })
    ipc?.emit({ event: 'property-change', name: 'pause', data: true })
    await flush()
    expect(ipc?.setProperty).toHaveBeenCalledWith('pause', false)

    ipc?.emit({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 })
    await flush()
    await flush()
    const stopped = await handler('playback:snapshot')()
    expect(stopped.phase).toBe('stopped')
    expect(mocks.fetchMock.mock.calls.some(([url]) => url.includes('/Sessions/Playing/Stopped'))).toBe(true)
  })

  it('keeps MPV alive through redirect playlist expansion and finalizes only the last physical entry', async () => {
    const movie = { Id: 'movie-redirect', Name: '重定向测试', Type: 'Movie', MediaStreams: [] }
    const playbackInfo = {
      PlaySessionId: 'redirect-session',
      MediaSources: [{ Id: 'redirect-source', SupportsDirectPlay: true }],
    }
    mocks.waitSequences.push([
      { event: 'start-file', playlist_entry_id: 1 },
      { event: 'end-file', reason: 'redirect', playlist_entry_id: 1, playlist_insert_id: 10, playlist_insert_num_entries: 2 },
      { event: 'start-file', playlist_entry_id: 10 },
      { event: 'file-loaded' },
    ])
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-redirect/PlaybackInfo')) return jsonResponse(playbackInfo)
      if (url.includes('/Users/user-1/Items/movie-redirect')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, { itemId: movie.Id })
    const child = mocks.spawnMock.mock.results.at(-1)?.value as ReturnType<typeof makeChild>
    const ipc = mocks.mpvInstances.at(-1)
    expect(snapshot).toMatchObject({ phase: 'playing', currentItemId: movie.Id })
    expect(child.kill).not.toHaveBeenCalled()
    expect(mocks.mainWindow.webContents.send.mock.calls.some(([channel, payload]) => channel === 'playback:changed' && payload.type === 'error')).toBe(false)

    ipc?.emit({ event: 'end-file', reason: 'eof', playlist_entry_id: 10 })
    await flush()
    expect((await handler('playback:snapshot')()).phase).toBe('playing')
    expect(mocks.fetchMock.mock.calls.filter(([url]) => url.includes('/Sessions/Playing/Stopped')).length).toBe(0)

    ipc?.emit({ event: 'end-file', reason: 'eof', playlist_entry_id: 11 })
    await flush()
    await flush()
    expect((await handler('playback:snapshot')()).phase).toBe('stopped')
    expect(mocks.fetchMock.mock.calls.filter(([url]) => url.includes('/Sessions/Playing/Stopped')).length).toBe(1)
  })

  it('returns startup MPV errors once without publishing a duplicate renderer error event', async () => {
    const movie = { Id: 'movie-error', Name: '错误测试', Type: 'Movie', MediaStreams: [] }
    mocks.waitSequences.push([
      { event: 'start-file', playlist_entry_id: 1 },
      { event: 'end-file', reason: 'error', file_error: 'network unreachable', playlist_entry_id: 1 },
    ])
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-error/PlaybackInfo')) return jsonResponse({ MediaSources: [{ Id: 'error-source', SupportsDirectPlay: true }] })
      if (url.includes('/Users/user-1/Items/movie-error')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    await expect(handler('playback:start')({}, { itemId: movie.Id })).rejects.toThrow('network unreachable')
    expect((await handler('playback:snapshot')()).phase).toBe('error')
    expect(mocks.mainWindow.webContents.send.mock.calls.filter(([channel, payload]) => channel === 'playback:changed' && payload.type === 'error')).toHaveLength(0)
  })

  it('rejects explicit audio and subtitle selections instead of silently falling back', async () => {
    const movie = { Id: 'movie-explicit-track', Name: '指定轨道测试', Type: 'Movie', MediaStreams: [] }
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-explicit-track/PlaybackInfo')) {
        return jsonResponse({
          MediaSources: [{
            Id: 'source-explicit-track',
            SupportsDirectPlay: true,
            MediaStreams: [{ Type: 'Audio', Index: 1, Language: 'ja' }],
          }],
        })
      }
      if (url.includes('/Users/user-1/Items/movie-explicit-track')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    await expect(handler('playback:start')({}, {
      itemId: movie.Id,
      audioPreference: { index: 9 },
    })).rejects.toThrow('未找到用户指定的音轨 9')

    await expect(handler('playback:start')({}, {
      itemId: movie.Id,
      subtitlePreference: { index: 8 },
    })).rejects.toThrow('未找到用户指定的字幕轨道 8')
  })

  it('returns the last snapshot for stale commands and surfaces MPV validation errors', async () => {
    const current = await handler('playback:snapshot')()
    await expect(handler('playback:command')({}, { sessionId: 'stale', command: 'pause' })).resolves.toEqual(current)

    mocks.spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', error: new Error('missing') })
    expect(handler('mpv:validate')({}, 'missing-mpv')).toMatchObject({
      valid: false,
      path: 'missing-mpv',
    })
  })

  it('rejects a Jellyfin version outside the supported stable baseline', async () => {
    mocks.fetchMock.mockResolvedValueOnce(jsonResponse({ ProductName: 'Jellyfin Server', Version: '12.0.0-rc7' }))
    await expect(handler('jellyfin:login')({}, {
      serverUrl: 'media.example.test',
      username: 'mickey',
      password: '',
      mpvPath: 'mpv.exe',
    })).rejects.toThrow('需要 Jellyfin 10.11.x')
  })

  it('logs out, clears connection state, and clears the image cache', async () => {
    const switched = await handler('settings:save')({}, {
      serverUrl: 'other.example.test/jellyfin',
      username: 'next-user',
      mpvPath: 'mpv.exe',
    })
    expect(switched).toMatchObject({
      serverUrl: 'http://other.example.test/jellyfin',
      username: 'next-user',
      connected: false,
      userId: undefined,
      serverName: undefined,
      serverVersion: undefined,
    })

    const settings = await handler('jellyfin:logout')()
    expect(settings).toMatchObject({ connected: false, userId: undefined })
    expect(await handler('settings:get')()).toMatchObject({ connected: false })
  })
})
