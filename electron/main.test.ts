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
  failPropertyCommands: new Set<string>(),
  failSendCommands: new Set<string>(),
  mainWindow: null as any,
  dialog: { showOpenDialog: vi.fn() },
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
      { id: 3, type: 'audio', 'ff-index': 11 },
      { id: 4, type: 'sub', 'ff-index': 12 },
      { id: 5, type: 'audio', 'ff-index': 21 },
      { id: 6, type: 'sub', 'ff-index': 22 },
    ]],
  ])
  eventHandler?: (message: MpvIpcMessage) => void
  readonly send = vi.fn(async (command: unknown[]) => {
    if (typeof command[0] === 'string' && mocks.failSendCommands.has(command[0])) throw new Error(`send ${command[0]} failed`)
    if (command[0] !== 'loadlist' || typeof command[1] !== 'string' || !command[1].startsWith('hex://')) return
    const playlistText = Buffer.from(command[1].slice('hex://'.length), 'hex').toString('utf8')
    const count = playlistText.split(/\r?\n/).filter((line) => line.startsWith('#EXTINF:')).length
    this.properties.set('playlist', Array.from({ length: count }, (_, index) => ({ id: index + 1 })))
  })
  readonly setProperty = vi.fn(async (name: string, value: unknown) => {
    if (mocks.failPropertyCommands.has(name)) throw new Error(`set_property ${name} failed`)
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
    dialog: mocks.dialog,
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
    mocks.dialog.showOpenDialog.mockReset()
    mocks.waitSequences.length = 0
    mocks.failPropertyCommands.clear()
    mocks.failSendCommands.clear()
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
      .mockResolvedValueOnce(jsonResponse({ app_version: '0.2.4' }))
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
    const [loginUrl, loginInit] = mocks.fetchMock.mock.calls[2]
    expect(loginUrl).toBe('http://media.example.test/Users/AuthenticateByName')
    expect(JSON.parse(loginInit.body)).toEqual({ Username: 'mickey', Pw: 'secret' })

    const request = { itemId: 'item-1', imageType: 'Primary', tag: 'tag-1', maxWidth: 480 }
    await expect(handler('jellyfin:get-image')({}, request)).resolves.toBe('data:image/png;base64,AQID')
    await expect(handler('jellyfin:get-image')({}, request)).resolves.toBe('data:image/png;base64,AQID')
    expect(mocks.fetchMock).toHaveBeenCalledTimes(4)
    expect(mocks.fetchMock.mock.calls[3][0]).toContain('/Items/item-1/Images/Primary')
    expect((mocks.fetchMock.mock.calls[3][1].headers as Headers).get('Authorization')).toContain('Token="token-1"')

    let resolveImage!: (response: Response) => void
    const pendingImage = new Promise<Response>((resolve) => { resolveImage = resolve })
    mocks.fetchMock.mockReturnValueOnce(pendingImage)
    const concurrentRequest = { itemId: 'item-2', imageType: 'Primary', tag: 'tag-2', maxWidth: 480 }
    const first = handler('jellyfin:get-image')({}, concurrentRequest)
    const second = handler('jellyfin:get-image')({}, concurrentRequest)
    await flush()
    expect(mocks.fetchMock).toHaveBeenCalledTimes(5)
    resolveImage(new Response(Uint8Array.from([4, 5, 6]), { status: 200, headers: { 'content-type': 'image/png' } }))
    await expect(Promise.all([first, second])).resolves.toEqual([
      'data:image/png;base64,BAUG',
      'data:image/png;base64,BAUG',
    ])
    expect(mocks.fetchMock).toHaveBeenCalledTimes(5)
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
    const movieArgs = mocks.spawnMock.mock.calls.at(-1)?.[1] as string[]
    expect(movieArgs.some((arg) => arg.startsWith('--script-opt=osc-custom_button_1_'))).toBe(false)
    const ipc = mocks.mpvInstances.at(-1)
    expect(ipc).toBeDefined()
    expect(ipc?.setProperty).toHaveBeenCalledWith('pause', false)
    expect(ipc?.send.mock.calls.some(([command]) => command[0] === 'playlist-play-index')).toBe(true)
    expect(mocks.fetchMock.mock.calls.some(([url]) => url.includes('/Sessions/Playing'))).toBe(true)
    const playingCall = mocks.fetchMock.mock.calls.find(([url]) => url.includes('/Sessions/Playing') && !url.includes('/Progress'))
    expect(playingCall).toBeDefined()
    expect(JSON.parse(playingCall?.[1].body)).toMatchObject({
      ItemId: 'movie-1',
      PlayMethod: 'DirectPlay',
      AudioStreamIndex: 1,
      SubtitleStreamIndex: 2,
      PositionTicks: 20_000_000,
    })

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

  it('opens the subtitle file picker and returns the selected path', async () => {
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['C:\\Subtitles\\custom.ass'] })
    await expect(handler('subtitle:choose-file')()).resolves.toBe('C:\\Subtitles\\custom.ass')
    expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openFile'],
      filters: [{ name: '字幕文件', extensions: ['ass', 'ssa', 'srt', 'vtt', 'smi', 'sub'] }],
    }))
  })

  it('loads an external subtitle through the local gateway and selects it in MPV', async () => {
    const movie = { Id: 'movie-external-subtitle', Name: '外挂字幕测试', Type: 'Movie', MediaStreams: [] }
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-external-subtitle/PlaybackInfo')) {
        return jsonResponse({
          MediaSources: [{
            Id: 'external-source',
            SupportsDirectPlay: true,
            MediaStreams: [{ Type: 'Subtitle', Index: 7, Language: 'zh-CN', DeliveryMethod: 'External', DeliveryUrl: '/Videos/movie-external-subtitle/Subtitles/7/Stream' }],
          }],
        })
      }
      if (url.includes('/Users/user-1/Items/movie-external-subtitle')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, { itemId: movie.Id, subtitlePreference: { index: 7, isExternal: true, language: 'zh-CN' } })
    const ipc = mocks.mpvInstances.at(-1)
    expect(snapshot.phase).toBe('playing')
    expect(ipc?.send.mock.calls).toEqual(expect.arrayContaining([
      [['sub-add', expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/play\//), 'select']],
    ]))
    await handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'stop' })
  })

  it('mounts a manually selected local subtitle after the video loads', async () => {
    const movie = { Id: 'movie-local-subtitle', Name: '本地字幕测试', Type: 'Movie', MediaStreams: [] }
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-local-subtitle/PlaybackInfo')) return jsonResponse({
        MediaSources: [{ Id: 'local-source', SupportsDirectPlay: true, MediaStreams: [
          { Type: 'Subtitle', Index: 0, Language: 'zh-CN', DeliveryMethod: 'External', DeliveryUrl: '/broken-subtitle.srt' },
        ] }],
      })
      if (url.includes('/Users/user-1/Items/movie-local-subtitle')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, { itemId: movie.Id, localSubtitlePath: 'C:\\Subtitles\\custom.ass' })
    const ipc = mocks.mpvInstances.at(-1)
    expect(snapshot.phase).toBe('playing')
    expect(ipc?.send.mock.calls).toContainEqual([['sub-add', 'C:\\Subtitles\\custom.ass', 'select']])
    expect(ipc?.send.mock.calls.some(([command]) => command[0] === 'sub-add' && command[1] !== 'C:\\Subtitles\\custom.ass')).toBe(false)
    await handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'stop' })
  })

  it('returns control failures without changing a healthy playback phase', async () => {
    const movie = { Id: 'movie-command-error', Name: '控制错误测试', Type: 'Movie', MediaStreams: [] }
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-command-error/PlaybackInfo')) return jsonResponse({ MediaSources: [{ Id: 'command-error-source', SupportsDirectPlay: true }] })
      if (url.includes('/Users/user-1/Items/movie-command-error')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, { itemId: movie.Id })
    mocks.failPropertyCommands.add('pause')
    await expect(handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'pause' })).rejects.toThrow('set_property pause failed')
    expect((await handler('playback:snapshot')()).phase).toBe('playing')
    expect(mocks.mainWindow.webContents.send.mock.calls.some(([channel, payload]) => channel === 'playback:changed' && payload.type === 'error')).toBe(false)

    mocks.failPropertyCommands.delete('pause')
    await handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'pause' })
    const ipc = mocks.mpvInstances.at(-1)
    ipc?.emit({ event: 'property-change', name: 'pause', data: true })
    await flush()
    expect((await handler('playback:snapshot')()).phase).toBe('paused')
    ipc?.properties.set('playlist', 'invalid-playlist')
    await expect(handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'stop-after-current' })).rejects.toThrow('MPV 未返回有效的播放列表')
    expect((await handler('playback:snapshot')()).phase).toBe('paused')
    await handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'stop' })
  })

  it('terminates the session when an MPV event cannot refresh playlist state', async () => {
    const movie = { Id: 'movie-event-error', Name: '事件错误测试', Type: 'Movie', MediaStreams: [] }
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-event-error/PlaybackInfo')) return jsonResponse({ MediaSources: [{ Id: 'event-error-source', SupportsDirectPlay: true }] })
      if (url.includes('/Users/user-1/Items/movie-event-error')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, { itemId: movie.Id })
    const ipc = mocks.mpvInstances.at(-1)
    ipc?.properties.set('playlist', undefined)
    ipc?.emit({ event: 'end-file', reason: 'redirect', playlist_entry_id: 1 })
    await flush()
    await flush()
    const stopped = await handler('playback:snapshot')()
    expect(stopped).toMatchObject({ phase: 'error', sessionId: snapshot.sessionId })
    expect((mocks.spawnMock.mock.results.at(-1)?.value as ReturnType<typeof makeChild>).kill).toHaveBeenCalled()
  })

  it('serializes concurrent starts and tears down the previous MPV process first', async () => {
    const firstMovie = { Id: 'movie-concurrent-first', Name: '并发第一部', Type: 'Movie', MediaStreams: [] }
    const secondMovie = { Id: 'movie-concurrent-second', Name: '并发第二部', Type: 'Movie', MediaStreams: [] }
    let resolveFirstPlaybackInfo!: (response: Response) => void
    const firstPlaybackInfo = new Promise<Response>((resolve) => { resolveFirstPlaybackInfo = resolve })
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-concurrent-first/PlaybackInfo')) return firstPlaybackInfo
      if (url.includes('/Users/user-1/Items/movie-concurrent-first')) return jsonResponse(firstMovie)
      if (url.includes('/Items/movie-concurrent-second/PlaybackInfo')) return jsonResponse({ MediaSources: [{ Id: 'concurrent-second-source', SupportsDirectPlay: true }] })
      if (url.includes('/Users/user-1/Items/movie-concurrent-second')) return jsonResponse(secondMovie)
      return new Response(null, { status: 204 })
    })

    const first = handler('playback:start')({}, { itemId: firstMovie.Id })
    await flush()
    const second = handler('playback:start')({}, { itemId: secondMovie.Id })
    await flush()
    expect(mocks.spawnMock).not.toHaveBeenCalled()

    resolveFirstPlaybackInfo(jsonResponse({ MediaSources: [{ Id: 'concurrent-first-source', SupportsDirectPlay: true }] }))
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second])
    expect(firstSnapshot.currentItemId).toBe(firstMovie.Id)
    expect(secondSnapshot).toMatchObject({ phase: 'playing', currentItemId: secondMovie.Id })
    expect(mocks.spawnMock).toHaveBeenCalledTimes(2)
    const firstChild = mocks.spawnMock.mock.results[0]?.value as ReturnType<typeof makeChild>
    expect(firstChild.kill).toHaveBeenCalled()
    await handler('playback:command')({}, { sessionId: secondSnapshot.sessionId, command: 'stop' })
  })

  it('adds a visible OSC playlist selector for multi-episode playback', async () => {
    const episodes = [
      { Id: 'episode-1', Name: '第一集', Type: 'Episode', SeriesId: 'series-1', ParentIndexNumber: 1, IndexNumber: 1, MediaStreams: [] },
      { Id: 'episode-2', Name: '第二集', Type: 'Episode', SeriesId: 'series-1', ParentIndexNumber: 1, IndexNumber: 2, MediaStreams: [] },
    ]
    const playbackInfo = (id: string) => ({
      PlaySessionId: `session-${id}`,
      MediaSources: [{ Id: `source-${id}`, SupportsDirectPlay: true }],
    })
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Shows/series-1/Episodes')) return jsonResponse({ Items: episodes, TotalRecordCount: episodes.length })
      const episode = episodes.find((item) => url.includes(`/Items/${item.Id}`))
      if (episode && url.includes('/PlaybackInfo')) return jsonResponse(playbackInfo(episode.Id))
      if (episode) return jsonResponse(episode)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, { itemId: 'episode-2' })
    expect(snapshot).toMatchObject({ phase: 'playing', currentItemId: 'episode-2', currentIndex: 1 })
    expect(snapshot.queue.map((item) => item.itemId)).toEqual(['episode-1', 'episode-2'])
    const args = mocks.spawnMock.mock.calls.at(-1)?.[1] as string[]
    expect(args).toContain('--script-opt=osc-custom_button_1_content=\u2637')
    expect(args).toContain('--script-opt=osc-custom_button_1_mbtn_left_command=script-binding select/select-playlist; script-message-to osc osc-hide')

    const ipc = mocks.mpvInstances.at(-1)
    expect(ipc?.send).toHaveBeenCalledWith(['playlist-play-index', 1])
    ipc?.emit({ event: 'end-file', reason: 'stop', playlist_entry_id: 2 })
    ipc?.emit({ event: 'start-file', playlist_entry_id: 1 })
    ipc?.emit({ event: 'file-loaded' })
    await flush()
    await flush()
    const switched = await handler('playback:snapshot')()
    expect(switched).toMatchObject({ phase: 'playing', currentItemId: 'episode-1', currentIndex: 0 })
    const stoppedEpisodeIds = mocks.fetchMock.mock.calls
      .filter(([url]) => url.includes('/Sessions/Playing/Stopped'))
      .map(([, init]) => JSON.parse(init.body).ItemId)
    expect(stoppedEpisodeIds).toContain('episode-2')
    const switchedPlaying = mocks.fetchMock.mock.calls
      .filter(([url]) => url.includes('/Sessions/Playing') && !url.includes('/Progress') && !url.includes('/Stopped'))
      .map(([, init]) => JSON.parse(init.body).ItemId)
    expect(switchedPlaying).toContain('episode-1')
    await handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'stop' })
  })

  it('keeps the complete episode queue while resolving each episode with its own source and tracks', async () => {
    const episodes = [
      { Id: 'scoped-1', Name: '作用域第一集', Type: 'Episode', SeriesId: 'scoped-series', ParentIndexNumber: 1, IndexNumber: 1, MediaStreams: [{ Type: 'Audio', Index: 11, Language: 'ja' }, { Type: 'Subtitle', Index: 12, Language: 'chi' }] },
      { Id: 'scoped-2', Name: '作用域第二集', Type: 'Episode', SeriesId: 'scoped-series', ParentIndexNumber: 1, IndexNumber: 2, MediaStreams: [{ Type: 'Audio', Index: 21, Language: 'ja' }, { Type: 'Subtitle', Index: 22, Language: 'chi', DeliveryMethod: 'External', DeliveryUrl: '/subtitles/scoped-2.ass' }] },
    ]
    mocks.fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/Shows/scoped-series/Episodes')) return jsonResponse({ Items: episodes, TotalRecordCount: episodes.length })
      const episode = episodes.find((item) => url.includes(`/Items/${item.Id}`))
      if (episode && url.includes('/PlaybackInfo')) {
        return jsonResponse({ PlaySessionId: `play-${episode.Id}`, MediaSources: [{ Id: `source-${episode.Id}`, SupportsDirectPlay: true, MediaStreams: episode.MediaStreams }] })
      }
      if (episode) return jsonResponse(episode)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, {
      itemId: 'scoped-2',
      mediaSourceId: 'source-scoped-2',
      audioPreference: { index: 21, language: 'ja', title: '日语', codec: 'aac' },
      subtitlePreference: { index: 22, isExternal: true, language: 'chi', title: '中文字幕', codec: 'ass' },
    })
    expect(snapshot.queue.map((item) => item.itemId)).toEqual(['scoped-1', 'scoped-2'])
    const playbackCallsBeforeNext = mocks.fetchMock.mock.calls.filter(([url]) => url.includes('/PlaybackInfo'))
    expect(playbackCallsBeforeNext).toHaveLength(1)
    const selectedBody = JSON.parse(playbackCallsBeforeNext[0][1].body)
    expect(selectedBody).toMatchObject({ MediaSourceId: 'source-scoped-2', AudioStreamIndex: 21, SubtitleStreamIndex: 22 })

    const ipc = mocks.mpvInstances.at(-1)
    ipc?.emit({ event: 'end-file', reason: 'stop', playlist_entry_id: 2 })
    ipc?.emit({ event: 'start-file', playlist_entry_id: 1 })
    ipc?.emit({ event: 'file-loaded' })
    await flush()
    await flush()
    const playbackCallsAfterNext = mocks.fetchMock.mock.calls.filter(([url]) => url.includes('/PlaybackInfo'))
    expect(playbackCallsAfterNext).toHaveLength(2)
    const nextBody = JSON.parse(playbackCallsAfterNext[1][1].body)
    expect(nextBody).not.toHaveProperty('MediaSourceId')
    expect(nextBody).not.toHaveProperty('AudioStreamIndex')
    expect(nextBody).not.toHaveProperty('SubtitleStreamIndex')
    expect(ipc?.setProperty).toHaveBeenCalledWith('sid', 4)
    expect((await handler('playback:snapshot')()).queue).toHaveLength(2)
    await handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'stop' })
  })

  it('does not add an OSC playlist selector for a standalone episode', async () => {
    const episode = { Id: 'single-episode', Name: '单集', Type: 'Episode', MediaStreams: [] }
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/single-episode/PlaybackInfo')) {
        return jsonResponse({ PlaySessionId: 'single-session', MediaSources: [{ Id: 'single-source', SupportsDirectPlay: true }] })
      }
      if (url.includes('/Users/user-1/Items/single-episode')) return jsonResponse(episode)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, { itemId: episode.Id })
    const args = mocks.spawnMock.mock.calls.at(-1)?.[1] as string[]
    expect(snapshot.queue).toHaveLength(1)
    expect(args.some((arg) => arg.startsWith('--script-opt=osc-custom_button_1_'))).toBe(false)
    await handler('playback:command')({}, { sessionId: snapshot.sessionId, command: 'stop' })
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
      { event: 'end-file', reason: 'error', file_error: 'loading failed', playlist_entry_id: 1 },
    ])
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-error/PlaybackInfo')) return jsonResponse({ MediaSources: [{ Id: 'error-source', SupportsDirectPlay: true }] })
      if (url.includes('/Users/user-1/Items/movie-error')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    await expect(handler('playback:start')({}, { itemId: movie.Id })).rejects.toThrow('《错误测试》加载失败：媒体资源无法加载')
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

  it('keeps MPV playing when an automatic external subtitle has no URL', async () => {
    const movie = { Id: 'movie-strm', Name: 'STRM 测试', Type: 'Movie', MediaStreams: [{ Type: 'Subtitle', Index: 4, DeliveryMethod: 'External' }] }
    mocks.waitSequences.push([
      { event: 'start-file', playlist_entry_id: 1 },
      { event: 'file-loaded' },
    ])
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-strm/PlaybackInfo')) return jsonResponse({ MediaSources: [{ Id: 'strm-source', SupportsDirectPlay: true, MediaStreams: movie.MediaStreams }] })
      if (url.includes('/Users/user-1/Items/movie-strm')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })

    const snapshot = await handler('playback:start')({}, { itemId: movie.Id })
    expect(snapshot).toMatchObject({ phase: 'playing', message: expect.stringContaining('无字幕播放') })
    expect(mocks.spawnMock.mock.results.at(-1)?.value.kill).not.toHaveBeenCalled()
    expect(mocks.fetchMock.mock.calls.some(([url, options]) => url.includes('/Sessions/Playing/Progress') && JSON.stringify(options).includes('SubtitleStreamIndex'))).toBe(false)
  })

  it('surfaces named errors for missing and failed external subtitle loading', async () => {
    const movie = { Id: 'movie-external-subtitle-error', Name: '外挂字幕错误', Type: 'Movie', MediaStreams: [] }
    const playbackInfo = (deliveryUrl?: string) => ({ MediaSources: [{ Id: 'external-error-source', SupportsDirectPlay: true, MediaStreams: [{ Type: 'Subtitle', Index: 7, Language: 'zh-CN', DeliveryMethod: 'External', ...(deliveryUrl ? { DeliveryUrl: deliveryUrl } : {}) }] }] })
    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-external-subtitle-error/PlaybackInfo')) return jsonResponse(playbackInfo(undefined))
      if (url.includes('/Users/user-1/Items/movie-external-subtitle-error')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })
    await expect(handler('playback:start')({}, { itemId: movie.Id, subtitlePreference: { index: 7, isExternal: true } })).rejects.toThrow('《外挂字幕错误》的外挂字幕没有可用的 DeliveryUrl')

    mocks.fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/Items/movie-external-subtitle-error/PlaybackInfo')) return jsonResponse(playbackInfo('/subtitles/error.ass'))
      if (url.includes('/Users/user-1/Items/movie-external-subtitle-error')) return jsonResponse(movie)
      return new Response(null, { status: 204 })
    })
    mocks.failSendCommands.add('sub-add')
    await expect(handler('playback:start')({}, { itemId: movie.Id, subtitlePreference: { index: 7, isExternal: true } })).rejects.toThrow('《外挂字幕错误》外挂字幕加载失败：send sub-add failed')
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
    mocks.fetchMock
      .mockResolvedValueOnce(jsonResponse({ app_version: '0.2.4' }))
      .mockResolvedValueOnce(jsonResponse({ ProductName: 'Jellyfin Server', Version: '12.0.0-rc7' }))
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
