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
  ])
  eventHandler?: (message: MpvIpcMessage) => void
  readonly send = vi.fn(async () => undefined)
  readonly setProperty = vi.fn(async (name: string, value: unknown) => {
    this.properties.set(name, value)
  })
  readonly getProperty = vi.fn(async (name: string) => this.properties.get(name))
  readonly connectWithRetry = vi.fn(async () => undefined)
  readonly observeProperty = vi.fn(async () => undefined)
  readonly waitForEvent = vi.fn(async () => ({ event: 'file-loaded' as const }))
  readonly close = vi.fn()

  constructor(pipeName: string) {
    this.pipeName = pipeName
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
    readonly on = vi.fn()
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
    mocks.mpvInstances.length = 0
    mocks.spawnSyncMock.mockReturnValue({ status: 0, stdout: 'mpv 0.41.0', stderr: '' })
    mocks.spawnMock.mockImplementation(() => makeChild())
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
      serverUrl: 'http://media.example.test/emby',
      username: 'mickey',
      mpvPath: 'C:\\Program Files\\mpv\\mpv.exe',
      connected: false,
    })
  })

  it('logs in, forwards authenticated API calls, and caches images', async () => {
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ AccessToken: 'token-1', User: { Id: 'user-1', Name: 'Mickey' } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }))
    const result = await handler('emby:login')({}, {
      serverUrl: 'media.example.test',
      username: ' mickey ',
      password: 'secret',
      mpvPath: 'mpv.exe',
    })
    expect(result.user).toEqual({ Id: 'user-1', Name: 'Mickey' })
    expect(result.settings).toMatchObject({ connected: true, userId: 'user-1', username: 'mickey' })
    const [loginUrl, loginInit] = mocks.fetchMock.mock.calls[0]
    expect(loginUrl).toBe('http://media.example.test/emby/Users/AuthenticateByName')
    expect(JSON.parse(loginInit.body)).toEqual({ Username: 'mickey', Pw: 'secret' })

    const request = { itemId: 'item-1', imageType: 'Primary', tag: 'tag-1', maxWidth: 480 }
    await expect(handler('emby:get-image')({}, request)).resolves.toBe('data:image/png;base64,AQID')
    await expect(handler('emby:get-image')({}, request)).resolves.toBe('data:image/png;base64,AQID')
    expect(mocks.fetchMock).toHaveBeenCalledTimes(2)
    expect(mocks.fetchMock.mock.calls[1][0]).toContain('/Items/item-1/Images/Primary')
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

  it('returns the last snapshot for stale commands and surfaces MPV validation errors', async () => {
    const current = await handler('playback:snapshot')()
    await expect(handler('playback:command')({}, { sessionId: 'stale', command: 'pause' })).resolves.toEqual(current)

    mocks.spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: '', stderr: '', error: new Error('missing') })
    expect(handler('mpv:validate')({}, 'missing-mpv')).toMatchObject({
      valid: false,
      path: 'missing-mpv',
    })
  })

  it('logs out, clears connection state, and clears the image cache', async () => {
    const settings = await handler('emby:logout')()
    expect(settings).toMatchObject({ connected: false, userId: undefined })
    expect(await handler('settings:get')()).toMatchObject({ connected: false })
  })
})
