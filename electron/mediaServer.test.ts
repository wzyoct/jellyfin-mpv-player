import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaServerClient, identifyMediaServer, normalizeServerUrl } from './mediaServer'
import type { MediaServerIdentity } from '../src/types'

vi.mock('./logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const fetchMock = vi.fn()

const embyIdentity: MediaServerIdentity = { kind: 'emby', name: 'Emby Server', version: '4.9.5.0' }
const jellyfinIdentity: MediaServerIdentity = { kind: 'jellyfin', name: 'Jellyfin Server', version: '10.11.11' }

function createClient(baseUrl: string, token: string, userId: string, deviceId = 'ember-player'): MediaServerClient {
  const embyBaseUrl = /\/emby\/?$/i.test(baseUrl) ? baseUrl : `${baseUrl}/emby`
  return new MediaServerClient(embyBaseUrl, token, userId, embyIdentity, deviceId)
}

function createJellyfinClient(baseUrl: string, token: string, userId: string, deviceId = 'ember-player'): MediaServerClient {
  return new MediaServerClient(baseUrl, token, userId, jellyfinIdentity, deviceId)
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    headers: { 'content-type': 'application/json' },
  })
}

describe('normalizeServerUrl', () => {
  it('preserves the server base path and removes web/query fragments', () => {
    expect(normalizeServerUrl('  media.example.test/web/index.html?foo=bar#section ')).toBe('http://media.example.test')
    expect(normalizeServerUrl('https://media.example.test/emby///')).toBe('https://media.example.test/emby')
    expect(normalizeServerUrl('https://media.example.test/jellyfin/web/index.html')).toBe('https://media.example.test/jellyfin')
    expect(normalizeServerUrl('http://media.example.test/custom/')).toBe('http://media.example.test/custom')
    expect(() => normalizeServerUrl('https://user:password@media.example.test')).toThrow('不能包含用户名或密码')
    expect(() => normalizeServerUrl('ftp://media.example.test')).toThrow('仅支持 HTTP 或 HTTPS')
  })

  it('rejects an empty address', () => {
    expect(() => normalizeServerUrl('  ')).toThrow('请输入 Jellyfin 或 Emby 服务器地址')
  })
})

describe('identifyMediaServer', () => {
  it('recognizes supported Jellyfin and legacy Emby responses', () => {
    expect(identifyMediaServer({ ProductName: 'Jellyfin Server', ServerName: 'Home', Version: '10.11.11' })).toEqual({
      kind: 'jellyfin', name: 'Home', version: '10.11.11',
    })
    expect(identifyMediaServer({ ProductName: null, ServerName: 'Emby', Version: '4.9.5.0' })).toEqual({
      kind: 'emby', name: 'Emby', version: '4.9.5.0',
    })
  })

  it('rejects unsupported and unknown server versions', () => {
    expect(() => identifyMediaServer({ ProductName: 'Jellyfin Server', Version: '12.0.0-rc7' })).toThrow('需要 Jellyfin 10.11.x')
    expect(() => identifyMediaServer({ ProductName: 'Other Media Server', Version: '1.0.0' })).toThrow('无法识别媒体服务器')
    expect(() => identifyMediaServer({ ProductName: 'Other Media Server', Version: '4.9.0.0' })).toThrow('无法识别媒体服务器')
  })
})

describe('MediaServerClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('sends authorization and preserves caller headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = createClient('https://media.example.test', 'secret-token', 'user-1', 'device-1')

    await expect(client.request('/System/Info?fields=1', {
      headers: { 'X-Test': 'yes' },
    })).resolves.toEqual({ ok: true })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://media.example.test/emby/System/Info?fields=1')
    const headers = init.headers as Headers
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('X-Test')).toBe('yes')
    expect(headers.get('X-MediaBrowser-Token')).toBe('secret-token')
    expect(headers.get('X-Emby-Authorization')).toContain('DeviceId="device-1"')
  })

  it('inspects the public server identity and follows a configured base URL redirect', async () => {
    const response = jsonResponse({ ProductName: 'Jellyfin Server', ServerName: 'Home', Version: '10.11.11' })
    Object.defineProperty(response, 'url', { value: 'https://media.example.test/jellyfin/System/Info/Public' })
    fetchMock.mockResolvedValueOnce(response)
    await expect(MediaServerClient.inspect('https://media.example.test')).resolves.toEqual({
      baseUrl: 'https://media.example.test/jellyfin',
      identity: { kind: 'jellyfin', name: 'Home', version: '10.11.11' },
    })
    expect(fetchMock.mock.calls[0][0]).toBe('https://media.example.test/System/Info/Public')
  })

  it('authenticates without sending a token and handles empty responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ AccessToken: 'token', User: { Id: 'u1', Name: 'Mickey' } }))
    await expect(MediaServerClient.authenticate('media.example.test/emby', 'mickey', 'password', embyIdentity)).resolves.toMatchObject({
      AccessToken: 'token',
      User: { Id: 'u1', Name: 'Mickey' },
      identity: embyIdentity,
      baseUrl: 'http://media.example.test/emby',
    })
    const [, authInit] = fetchMock.mock.calls[0]
    expect((authInit.headers as Headers).get('X-MediaBrowser-Token')).toBeNull()
    expect(JSON.parse(authInit.body)).toEqual({ Username: 'mickey', Pw: 'password' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ AccessToken: 'token', User: { Id: 'u1', Name: 'Mickey' } }))
    await MediaServerClient.authenticate('media.example.test', 'mickey', '', jellyfinIdentity)
    const [, jellyfinAuthInit] = fetchMock.mock.calls[1]
    expect((jellyfinAuthInit.headers as Headers).get('Authorization')).not.toContain('Token=')

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(createClient('media.example.test', 'token', 'u1').request('/Sessions/Playing/Stopped', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('rejects authentication responses without a usable user or token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ User: { Id: 'u1', Name: 'Mickey' } }))
    await expect(MediaServerClient.authenticate('media.example.test', 'mickey', '', jellyfinIdentity)).rejects.toThrow('登录响应缺少有效用户或令牌')

    fetchMock.mockResolvedValueOnce(jsonResponse({ AccessToken: 'token', User: { Id: '', Name: 'Mickey' } }))
    await expect(MediaServerClient.authenticate('media.example.test', 'mickey', '', jellyfinIdentity)).rejects.toThrow('登录响应缺少有效用户或令牌')
  })

  it('uses the standard Jellyfin authorization header and keeps tokens out of URLs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = createJellyfinClient('https://media.example.test', 'secret-token', 'user-1', 'device-1')
    await client.request('/System/Info')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://media.example.test/System/Info')
    const headers = init.headers as Headers
    expect(headers.get('Authorization')).toContain('MediaBrowser')
    expect(headers.get('Authorization')).toContain('Token="secret-token"')
    expect(headers.get('X-Emby-Authorization')).toBeNull()
    expect(headers.get('X-MediaBrowser-Token')).toBeNull()
    expect(url).not.toContain('secret-token')
  })

  it('surfaces HTTP, network and JSON parsing failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(300), { status: 502, statusText: 'Bad Gateway' }))
    await expect(createClient('media.example.test', 'token', 'u1').request('/System/Info')).rejects.toThrow(/^Emby 请求失败（502）：x{180}$/)

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(createClient('media.example.test', 'token', 'u1').request('/System/Info')).rejects.toThrow('offline')

    fetchMock.mockResolvedValueOnce(new Response('{not-json', { status: 200 }))
    await expect(createClient('media.example.test', 'token', 'u1').request('/System/Info')).rejects.toThrow()
  })

  it('builds query requests and paginates series episodes', async () => {
    const client = createClient('media.example.test', 'token', 'user/1')
    const movie = { Id: 'movie-1', Name: 'Movie', Type: 'Movie' }
    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [movie], TotalRecordCount: 1 }))
    await expect(client.getItems({
      parentId: 'view-1',
      includeItemTypes: 'Movie,Episode',
      searchTerm: 'Dune',
      isResumable: true,
      filters: 'IsPlayed',
      sortOrder: 'Descending',
      startIndex: 4,
      limit: 2,
    })).resolves.toEqual({ Items: [movie], TotalRecordCount: 1 })
    const query = new URL(fetchMock.mock.calls[0][0]).searchParams
    expect(query.get('UserId')).toBe('user/1')
    expect(query.get('ParentId')).toBe('view-1')
    expect(query.get('SearchTerm')).toBe('Dune')
    expect(query.get('Filters')).toBe('IsResumable')
    expect(query.get('StartIndex')).toBe('4')
    expect(query.get('Limit')).toBe('2')

    const episode1 = { Id: 'episode-1', Name: 'Episode 1', Type: 'Episode' }
    const episode2 = { Id: 'episode-2', Name: 'Episode 2', Type: 'Episode' }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ Items: [episode1], TotalRecordCount: 2 }))
      .mockResolvedValueOnce(jsonResponse({ Items: [episode2], TotalRecordCount: 2 }))
    await expect(client.getSeriesEpisodes('series/1')).resolves.toEqual([episode1, episode2])
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('StartIndex')).toBe('0')
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('StartIndex')).toBe('1')
  })

  it('calls views, recommendations, item and playback endpoints', async () => {
    const client = createClient('media.example.test', 'token', 'u1')
    const view = { Id: 'view-1', Name: '电影库' }
    const recommendation = { Items: [{ Id: 'movie-1', Name: '推荐', Type: 'Movie' }] }
    const item = { Id: 'movie-1', Name: '推荐', Type: 'Movie' }
    const playback = { MediaSources: [{ Id: 'source-1' }] }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ Items: [view], TotalRecordCount: 1 }))
      .mockResolvedValueOnce(jsonResponse([recommendation]))
      .mockResolvedValueOnce(jsonResponse(item))
      .mockResolvedValueOnce(jsonResponse(playback))
      .mockResolvedValueOnce(jsonResponse({ Items: [], TotalRecordCount: 0 }))

    await expect(client.getViews()).resolves.toEqual([view])
    await expect(client.getMovieRecommendations()).resolves.toEqual([recommendation])
    await expect(client.getItem('movie-1')).resolves.toEqual(item)
    await expect(client.getPlaybackInfo('movie-1')).resolves.toEqual(playback)
    await expect(client.getNextUp()).resolves.toEqual({ Items: [], TotalRecordCount: 0 })
    expect(new URL(fetchMock.mock.calls[4][0]).searchParams.has('SeriesId')).toBe(false)
    const recommendationUrl = new URL(fetchMock.mock.calls[1][0])
    expect(recommendationUrl.searchParams.get('Fields')).toBe('Overview')
    expect(recommendationUrl.searchParams.get('EnableImageTypes')).toBe('Primary,Backdrop,Thumb')
  })

  it('validates query response shapes and recommendation arrays', async () => {
    const client = createClient('media.example.test', 'token', 'u1')
    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [] }))
    await expect(client.getViews()).rejects.toThrow('缺少 Items 或 TotalRecordCount')

    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [] }))
    await expect(client.getMovieRecommendations()).rejects.toThrow('返回格式无效')
  })

  it('reads images and builds stream and subtitle URLs', async () => {
    const client = createClient('media.example.test', 'token', 'u1')
    fetchMock.mockResolvedValueOnce(new Response(Uint8Array.from([0, 1, 2]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    await expect(client.getImage('item/1', 'Backdrop', 'tag-1', 720)).resolves.toBe('data:image/png;base64,AAEC')
    const [imageUrl] = fetchMock.mock.calls[0]
    expect(new URL(imageUrl).searchParams.get('maxWidth')).toBe('720')
    expect(new URL(imageUrl).searchParams.get('tag')).toBe('tag-1')

    const direct = client.buildStreamUrl('item/1', {
      Id: 'source-1',
      DirectStreamUrl: 'https://cdn.example.test/file.mp4?existing=1&api_key=secret-token',
    }, { audioStreamIndex: 2, subtitleStreamIndex: 3, playSessionId: 'session-1' })
    expect(new URL(direct).searchParams.get('MediaSourceId')).toBeNull()
    expect(new URL(direct).searchParams.get('api_key')).toBeNull()
    expect(direct).not.toContain('secret-token')
    expect(new URL(direct).searchParams.get('AudioStreamIndex')).toBe('2')
    expect(new URL(direct).searchParams.get('SubtitleStreamIndex')).toBe('3')

    const embyStream = client.buildStreamUrl('item/1', { Id: 'source-1' }, {})
    expect(new URL(embyStream).pathname).toBe('/emby/Videos/item%2F1/stream')
    expect(new URL(embyStream).searchParams.get('Static')).toBe('true')
    expect(client.buildSubtitleUrl('item/1', 'source/1', 0)).toContain('/Subtitles/0/Stream.srt')
  })

  it('reports playing, progress and stopped payloads', async () => {
    const client = createClient('media.example.test', 'token', 'u1')
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const payload = { ItemId: 'item-1', PositionTicks: 123, IsPaused: false }
    await client.reportPlaying(payload)
    await client.reportProgress(payload)
    await client.reportStopped(payload)

    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/emby/Sessions/Playing',
      '/emby/Sessions/Playing/Progress',
      '/emby/Sessions/Playing/Stopped',
    ])
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'POST')).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(payload)
  })

  it('rejects binary responses with a useful status', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await expect(createClient('media.example.test', 'token', 'u1').requestBinary('/missing')).rejects.toThrow('图片请求失败（404）')
  })

  it('uses binary defaults and stops pagination on an empty page', async () => {
    const client = createClient('media.example.test', 'token', 'u1')
    fetchMock.mockResolvedValueOnce(new Response(Uint8Array.from([255]), { status: 200 }))
    await expect(client.requestBinary('/image')).resolves.toEqual({ mimeType: 'image/jpeg', data: '/w==' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [], TotalRecordCount: 100 }))
    await expect(client.getSeriesEpisodes('series-1')).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('aborts requests that exceed the client timeout', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const client = createClient('media.example.test', 'token', 'u1')
    const request = client.request('/slow')
    const requestResult = request.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(requestResult).resolves.toMatchObject({ message: 'aborted' })

    const binary = client.requestBinary('/slow-image')
    const binaryResult = binary.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(binaryResult).resolves.toMatchObject({ message: 'aborted' })
    vi.useRealTimers()
  })
})
