// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import type {
  JellyfinApi,
  MediaItem,
  PlaybackEvent,
  PlaybackSnapshot,
  PublicSettings,
} from './types'

const settings = (connected = false): PublicSettings => ({
  serverUrl: 'http://media.example.test',
  username: connected ? 'mickey' : '',
  userId: connected ? 'user-1' : undefined,
  serverName: connected ? 'Jellyfin Server' : undefined,
  serverVersion: connected ? '10.11.11' : undefined,
  mpvPath: 'mpv.exe',
  connected,
  secureStorageAvailable: true,
})

const movie = (id: string, name: string): MediaItem => ({
  Id: id,
  Name: name,
  Type: 'Movie',
  Overview: `${name} 简介`,
  ProductionYear: 2026,
  RunTimeTicks: 7_200_000_000,
  ImageTags: { Primary: `${id}-tag` },
})

const idleSnapshot = (): PlaybackSnapshot => ({
  revision: 0,
  phase: 'idle',
  queue: [],
  currentIndex: -1,
  positionTicks: 0,
})

function createApi(overrides: Partial<Record<keyof JellyfinApi, unknown>> = {}): JellyfinApi {
  const api: Record<string, unknown> = {
    getSettings: vi.fn(async () => settings(false)),
    saveSettings: vi.fn(async () => settings(true)),
    login: vi.fn(async () => ({ settings: settings(true), user: { Id: 'user-1', Name: 'Mickey' } })),
    logout: vi.fn(async () => settings(false)),
    getViews: vi.fn(async () => []),
    getItems: vi.fn(async () => ({ Items: [], TotalRecordCount: 0 })),
    getMovieRecommendations: vi.fn(async () => []),
    getItem: vi.fn(async (item: MediaItem) => item),
    getPlaybackInfo: vi.fn(async () => ({ MediaSources: [] })),
    getNextUp: vi.fn(async () => ({ Items: [], TotalRecordCount: 0 })),
    getSeriesEpisodes: vi.fn(async () => []),
    getImage: vi.fn(async () => 'data:image/jpeg;base64,test'),
    getFullScreen: vi.fn(async () => false),
    setFullScreen: vi.fn(async (enabled: boolean) => enabled),
    onFullScreenChanged: vi.fn(() => vi.fn()),
    validateMpvPath: vi.fn(async () => ({ valid: true, path: 'mpv.exe', message: 'MPV 路径和版本有效' })),
    testMpvPath: vi.fn(async () => ({ valid: true, path: 'mpv.exe', message: 'MPV 测试启动成功' })),
    openLogDirectory: vi.fn(async () => undefined),
    playbackStart: vi.fn(async () => idleSnapshot()),
    playbackCommand: vi.fn(async () => idleSnapshot()),
    getPlaybackSnapshot: vi.fn(async () => idleSnapshot()),
    onPlaybackChanged: vi.fn(() => vi.fn()),
  }
  Object.assign(api, overrides)
  return api as unknown as JellyfinApi
}

const iconNames = [
  'House', 'Film', 'Tv', 'History', 'Search', 'Settings2', 'CircleUserRound', 'Maximize2', 'Minimize2', 'LoaderCircle', 'Check',
  'Play', 'FolderOpen', 'AlertCircle', 'LogOut', 'Info', 'ChevronRight', 'Clapperboard', 'RefreshCw',
  'X', 'SkipBack', 'Pause', 'SkipForward', 'Square', 'AlertTriangle', 'Volume2', 'Menu',
]

const stubs: Record<string, any> = Object.fromEntries(iconNames.map((name) => [name, true]))
stubs.PosterImage = { template: '<div class="poster-image-stub"></div>' }
stubs.MediaCard = {
  props: ['item'],
  emits: ['select'],
  template: '<button class="media-card-stub" type="button" @click="$emit(\'select\', item)">{{ item.Name }}</button>',
}
stubs.MediaRail = {
  props: ['title', 'items'],
  emits: ['select'],
  template: '<section class="media-rail-stub"><h2>{{ title }}</h2><button v-for="item in items" :key="item.Id" type="button" @click="$emit(\'select\', item)">{{ item.Name }}</button></section>',
}

const mountedWrappers: VueWrapper[] = []

function mountApp(api: JellyfinApi, attachTo?: Element): VueWrapper {
  window.jellyfin = api
  const wrapper = mount(App, { attachTo, global: { stubs } })
  mountedWrappers.push(wrapper)
  return wrapper
}

function connectedHomeApi(): JellyfinApi {
  const latest = movie('latest-1', '最近加入')
  const recommended = movie('recommended-1', '推荐电影')
  const continued = { ...movie('continue-1', '继续观看'), UserData: { PlaybackPositionTicks: 10_000_000 } }
  const next = { ...movie('next-1', '下一集'), Type: 'Episode' as const, SeriesName: '一部剧' }
  const all = [movie('all-movie', '片库电影'), { Id: 'all-series', Name: '片库剧集', Type: 'Series' as const }]
  return createApi({
    getSettings: vi.fn(async () => settings(true)),
    getViews: vi.fn(async () => [{ Id: 'view-1', Name: '电影库', CollectionType: 'movies' }]),
    getMovieRecommendations: vi.fn(async () => [{ Items: [recommended, recommended] }]),
    getNextUp: vi.fn(async () => ({ Items: [next], TotalRecordCount: 1 })),
    getItems: vi.fn(async (query: any = {}) => {
      if (query.filters === 'IsResumable') return { Items: [continued], TotalRecordCount: 1 }
      if (query.sortBy === 'DateCreated') return { Items: [latest], TotalRecordCount: 1 }
      if (query.sortBy === 'SortName') return { Items: all, TotalRecordCount: all.length }
      if (query.searchTerm) return { Items: [movie('search-1', query.searchTerm)], TotalRecordCount: 1 }
      return { Items: [], TotalRecordCount: 0 }
    }),
  })
}

describe('App', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
    })
  })

  afterEach(() => {
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows the Jellyfin-first connection form when no saved connection exists', async () => {
    const api = createApi()
    const wrapper = mountApp(api)
    await flushPromises()

    expect(wrapper.text()).toContain('连接你的 Jellyfin')
    expect(wrapper.find('#server-url').exists()).toBe(true)
    expect(vi.mocked(api.getViews)).not.toHaveBeenCalled()
  })

  it('shows the detected Jellyfin identity after restoring a connection', async () => {
    const api = createApi({
      getSettings: vi.fn(async () => ({
        ...settings(true),
        serverUrl: 'http://media.example.test/jellyfin',
        serverName: 'Home Jellyfin',
        serverVersion: '10.11.11',
      })),
    })
    const wrapper = mountApp(api)
    await flushPromises()
    await wrapper.get('button[title="设置"]').trigger('click')
    expect(wrapper.text()).toContain('当前服务：Home Jellyfin 10.11.11')
    expect(wrapper.text()).toContain('Jellyfin 服务器地址')
  })

  it('loads the home collections, paginates, deduplicates recommendations, and renders fallbacks', async () => {
    const api = connectedHomeApi()
    const wrapper = mountApp(api)
    await flushPromises()

    expect(wrapper.get('header.topbar').classes()).toContain('topbar--immersive')
    expect(wrapper.text()).toContain('推荐电影')
    expect(wrapper.text()).toContain('继续观看')
    expect(wrapper.text()).toContain('下一集')
    expect(wrapper.text()).toContain('最近加入')
    expect(wrapper.text()).toContain('完整媒体库')
    expect(wrapper.text()).toContain('2 项内容')
    expect(wrapper.text()).toContain('推荐电影 简介')
    expect(wrapper.text()).not.toContain('打开详情，查看完整介绍与播放选项。')
    expect(vi.mocked(api.getItems).mock.calls.some(([query]) => query?.filters === 'IsResumable')).toBe(true)
  })

  it('hides the hero description when overview metadata is unavailable', async () => {
    const api = connectedHomeApi()
    vi.mocked(api.getMovieRecommendations).mockResolvedValue([{ Items: [{ Id: 'no-overview', Name: '无简介电影', Type: 'Movie' }] }])
    const wrapper = mountApp(api)
    await flushPromises()

    expect(wrapper.find('.hero-description').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('打开详情，查看完整介绍与播放选项。')
  })

  it('falls back to latest content when recommendations fail', async () => {
    const api = connectedHomeApi()
    vi.mocked(api.getMovieRecommendations).mockRejectedValueOnce(new Error('recommendations unavailable'))
    vi.mocked(api.getNextUp).mockRejectedValueOnce(new Error('next up unavailable'))
    const wrapper = mountApp(api)
    await flushPromises()

    expect(wrapper.text()).toContain('最近加入')
    expect(wrapper.text()).toContain('推荐暂时不可用')
  })

  it('navigates between pages, runs MPV diagnostics, saves settings, and disconnects', async () => {
    const api = connectedHomeApi()
    const wrapper = mountApp(api)
    await flushPromises()

    await wrapper.findAll('button.nav-item')[3].trigger('click')
    expect(wrapper.get('header.topbar').classes()).not.toContain('topbar--immersive')
    expect(wrapper.text()).toContain('更新记录')
    await wrapper.get('button.brand').trigger('click')
    await wrapper.get('button[title="设置"]').trigger('click')
    expect(wrapper.text()).toContain('连接设置')

    await wrapper.get('#mpv-path').setValue('C:/Apps/mpv.exe')
    await wrapper.get('.mpv-tools button').trigger('click')
    await wrapper.get('.mpv-tools button:nth-child(2)').trigger('click')
    await wrapper.get('.mpv-tools button:nth-child(3)').trigger('click')
    expect(api.validateMpvPath).toHaveBeenCalledWith('C:/Apps/mpv.exe')
    expect(api.testMpvPath).toHaveBeenCalledWith('C:/Apps/mpv.exe')
    expect(api.openLogDirectory).toHaveBeenCalledTimes(1)

    await wrapper.get('form.settings-form').trigger('submit')
    await flushPromises()
    expect(api.saveSettings).toHaveBeenCalled()
    const disconnectButton = wrapper.findAll('button.button--ghost').find((button) => button.text().includes('断开连接'))
    expect(disconnectButton).toBeDefined()
    await disconnectButton?.trigger('click')
    await flushPromises()
    expect(api.logout).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('连接你的 Jellyfin')
  })

  it('validates and submits the login form, then loads the home page', async () => {
    const api = createApi()
    const wrapper = mountApp(api, document.body)
    await flushPromises()
    await wrapper.get('form.settings-form').trigger('submit')
    expect(wrapper.text()).toContain('服务器地址和用户名不能为空')

    await wrapper.get('#server-url').setValue('http://media.example.test')
    await wrapper.get('#username').setValue('mickey')
    await wrapper.get('#password').setValue('secret')
    await wrapper.get('form.settings-form').trigger('submit')
    await flushPromises()

    expect(api.login).toHaveBeenCalledWith({
      serverUrl: 'http://media.example.test',
      username: 'mickey',
      password: 'secret',
      mpvPath: 'mpv.exe',
    })
    expect(wrapper.find('header.topbar').exists()).toBe(true)
  })

  it('debounces search and keeps the newest response when requests resolve out of order', async () => {
    const api = connectedHomeApi()
    let resolveFirst!: (value: { Items: MediaItem[]; TotalRecordCount: number }) => void
    let resolveSecond!: (value: { Items: MediaItem[]; TotalRecordCount: number }) => void
    vi.mocked(api.getItems).mockImplementation(async (query: any = {}) => {
      if (query.searchTerm === 'first') return new Promise((resolve) => { resolveFirst = resolve })
      if (query.searchTerm === 'second') return new Promise((resolve) => { resolveSecond = resolve })
      if (query.filters === 'IsResumable') return { Items: [], TotalRecordCount: 0 }
      if (query.sortBy === 'DateCreated' || query.sortBy === 'SortName') return { Items: [], TotalRecordCount: 0 }
      return { Items: [], TotalRecordCount: 0 }
    })
    const wrapper = mountApp(api)
    await flushPromises()
    const search = wrapper.get('.search-box input')
    await search.setValue('first')
    await new Promise((resolve) => setTimeout(resolve, 380))
    await search.setValue('second')
    await new Promise((resolve) => setTimeout(resolve, 380))
    resolveSecond({ Items: [movie('second-id', '第二次结果')], TotalRecordCount: 1 })
    await flushPromises()
    resolveFirst({ Items: [movie('first-id', '第一次结果')], TotalRecordCount: 1 })
    await flushPromises()

    expect(wrapper.text()).toContain('第二次结果')
    expect(wrapper.text()).not.toContain('第一次结果')
  })

  it('opens details, loads playback options, and starts direct playback', async () => {
    const item = movie('movie-1', '可播放电影')
    const api = connectedHomeApi()
    vi.mocked(api.getItems).mockImplementation(async (query: any = {}) => {
      if (query.sortBy === 'DateCreated') return { Items: [item], TotalRecordCount: 1 }
      if (query.sortBy === 'SortName') return { Items: [item], TotalRecordCount: 1 }
      return { Items: [], TotalRecordCount: 0 }
    })
    vi.mocked(api.getMovieRecommendations).mockResolvedValue([])
    vi.mocked(api.getPlaybackInfo).mockResolvedValue({ MediaSources: [{ Id: 'source-1', MediaStreams: [] }] })
    vi.mocked(api.getItem).mockResolvedValue(item)
    vi.mocked(api.playbackStart).mockResolvedValue({ ...idleSnapshot(), revision: 1, phase: 'playing', sessionId: 'session-1', currentItemId: item.Id, queue: [{ itemId: item.Id, name: item.Name, type: item.Type }], currentIndex: 0 })
    const wrapper = mountApp(api)
    await flushPromises()
    await wrapper.get('.hero-actions button.button--ghost').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(api.getPlaybackInfo).toHaveBeenCalledWith('movie-1')
    await wrapper.get('[role="dialog"] .detail-actions button.button--primary').trigger('click')
    await flushPromises()
    expect(api.playbackStart).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'movie-1' }))
    expect(wrapper.text()).toContain('正在用 MPV 播放')
  })

  it('starts playback from the hero and handles keyboard focus and page scrolling', async () => {
    const api = connectedHomeApi()
    const item = movie('hero-1', '英雄电影')
    vi.mocked(api.getItems).mockImplementation(async (query: any = {}) => {
      if (query.sortBy === 'DateCreated' || query.sortBy === 'SortName') return { Items: [item], TotalRecordCount: 1 }
      return { Items: [], TotalRecordCount: 0 }
    })
    vi.mocked(api.getMovieRecommendations).mockResolvedValue([{ Items: [item] }])
    vi.mocked(api.playbackStart).mockResolvedValue({ ...idleSnapshot(), revision: 1, phase: 'playing', sessionId: 'hero-session', currentItemId: item.Id, queue: [{ itemId: item.Id, name: item.Name, type: item.Type }], currentIndex: 0 })
    const wrapper = mountApp(api, document.body)
    await flushPromises()
    await wrapper.get('.hero-actions button.button--primary').trigger('click')
    await flushPromises()
    expect(api.playbackStart).toHaveBeenCalledWith({ itemId: 'hero-1' })

    wrapper.get('.search-box input')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    expect(document.activeElement?.getAttribute('type')).toBe('search')
    const page = wrapper.get('.page-content').element as HTMLElement
    Object.defineProperty(page, 'scrollTop', { configurable: true, value: 18 })
    await wrapper.get('.page-content').trigger('scroll')
    expect(wrapper.get('header.topbar').classes()).toContain('topbar--scrolled')
  })

  it('toggles fullscreen from the toolbar and keyboard shortcuts', async () => {
    const api = connectedHomeApi()
    let fullScreenListener: ((enabled: boolean) => void) | undefined
    const removeListener = vi.fn()
    vi.mocked(api.onFullScreenChanged).mockImplementation((callback) => {
      fullScreenListener = callback
      return removeListener
    })
    const wrapper = mountApp(api)
    await flushPromises()

    expect(wrapper.find('button[title="进入全屏"]').exists()).toBe(true)
    await wrapper.get('button[title="进入全屏"]').trigger('click')
    await flushPromises()
    expect(api.setFullScreen).toHaveBeenCalledWith(true)

    fullScreenListener?.(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('button[title="退出全屏"]').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11' }))
    await flushPromises()
    expect(api.setFullScreen).toHaveBeenLastCalledWith(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(api.setFullScreen).toHaveBeenLastCalledWith(false)
    wrapper.unmount()
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('accepts newer playback snapshots, controls pause, and refreshes after stop', async () => {
    const api = connectedHomeApi()
    let playbackListener: ((event: PlaybackEvent) => void) | undefined
    vi.mocked(api.onPlaybackChanged).mockImplementation((callback) => {
      playbackListener = callback
      return vi.fn()
    })
    const current = movie('playing-1', '正在播放')
    vi.mocked(api.getItem).mockResolvedValue({ ...current, UserData: { PlaybackPositionTicks: 50_000_000 } })
    const wrapper = mountApp(api)
    await flushPromises()
    const playing: PlaybackEvent = {
      ...idleSnapshot(),
      type: 'snapshot',
      revision: 2,
      phase: 'playing',
      sessionId: 'session-1',
      currentItemId: current.Id,
      queue: [{ itemId: current.Id, name: current.Name, type: current.Type }],
      currentIndex: 0,
      positionTicks: 20_000_000,
    }
    playbackListener?.(playing)
    await flushPromises()
    expect(wrapper.text()).toContain('正在播放')
    playbackListener?.({ ...playing, revision: 1, currentItemId: 'stale', type: 'snapshot' })
    await flushPromises()
    expect(wrapper.text()).not.toContain('stale')

    vi.mocked(api.playbackCommand).mockResolvedValue({ ...playing, revision: 3, phase: 'paused', isPaused: true })
    await wrapper.get('button[title="暂停播放"]').trigger('click')
    await flushPromises()
    expect(api.playbackCommand).toHaveBeenCalledWith({ sessionId: 'session-1', command: 'pause' })

    playbackListener?.({ ...playing, revision: 4, type: 'sync-error', syncError: '服务器暂时不可用' })
    await flushPromises()
    expect(wrapper.text()).toContain('播放进度同步失败：服务器暂时不可用')
    playbackListener?.({ ...playing, revision: 5, type: 'snapshot', phase: 'stopped', currentItemId: undefined })
    await flushPromises()
    expect(api.getItem).toHaveBeenCalledWith('playing-1')
  })

  it('sends queue controls and retries an errored playback session', async () => {
    const api = connectedHomeApi()
    let playbackListener: ((event: PlaybackEvent) => void) | undefined
    vi.mocked(api.onPlaybackChanged).mockImplementation((callback) => {
      playbackListener = callback
      return vi.fn()
    })
    const wrapper = mountApp(api)
    await flushPromises()
    const base: PlaybackEvent = {
      ...idleSnapshot(),
      type: 'snapshot',
      revision: 1,
      phase: 'playing',
      sessionId: 'session-2',
      currentItemId: 'episode-2',
      queue: [
        { itemId: 'episode-1', name: '第一集', type: 'Episode' },
        { itemId: 'episode-2', name: '第二集', type: 'Episode' },
      ],
      currentIndex: 1,
      positionTicks: 30_000_000,
    }
    playbackListener?.(base)
    await flushPromises()
    vi.mocked(api.playbackCommand)
      .mockResolvedValueOnce({ ...base, revision: 2, currentIndex: 0 })
      .mockResolvedValue(base)
    await wrapper.get('button[title="上一集"]').trigger('click')
    await wrapper.get('button[title="下一集"]').trigger('click')
    await wrapper.get('button[title="播完本集后停止"]').trigger('click')
    expect(api.playbackCommand).toHaveBeenCalledWith({ sessionId: 'session-2', command: 'previous' })
    expect(api.playbackCommand).toHaveBeenCalledWith({ sessionId: 'session-2', command: 'next' })
    expect(api.playbackCommand).toHaveBeenCalledWith({ sessionId: 'session-2', command: 'stop-after-current' })

    const errorEvent: PlaybackEvent = { ...base, revision: 2, type: 'error', phase: 'error', message: 'MPV 崩溃' }
    playbackListener?.(errorEvent)
    await flushPromises()
    vi.mocked(api.playbackStart).mockResolvedValue(base)
    await wrapper.get('button[title="重试播放"]').trigger('click')
    await flushPromises()
    expect(api.playbackStart).toHaveBeenCalledWith({ itemId: 'episode-2', startTimeTicks: 30_000_000 })
  })
})
