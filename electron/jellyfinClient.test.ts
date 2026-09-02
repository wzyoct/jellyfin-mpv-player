import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JellyfinClient, identifyJellyfin, normalizeServerUrl, PlaybackInfoTimeoutError } from './jellyfinClient'

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const fetchMock = vi.fn()
const identity = { name: 'Jellyfin Server', version: '10.11.11' }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, statusText: status === 200 ? 'OK' : 'Bad Gateway', headers: { 'content-type': 'application/json' } })
}

describe('Jellyfin client contract', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterAll(() => vi.unstubAllGlobals())

  it('normalizes server URLs and requires HTTP(S)', () => {
    expect(normalizeServerUrl('media.example.test/web/index.html?x=1')).toBe('http://media.example.test')
    expect(normalizeServerUrl('https://media.example.test/jellyfin///')).toBe('https://media.example.test/jellyfin')
    expect(() => normalizeServerUrl('ftp://media.example.test')).toThrow('仅支持 HTTP 或 HTTPS')
    expect(() => normalizeServerUrl('  ')).toThrow('请输入 Jellyfin 服务器地址')
  })

  it('identifies only supported Jellyfin versions', () => {
    expect(identifyJellyfin({ ProductName: 'Jellyfin Server', ServerName: 'Home', Version: '10.11.11' })).toEqual({ name: 'Home', version: '10.11.11' })
    expect(() => identifyJellyfin({ ProductName: 'Emby', Version: '4.8.0' })).toThrow('不是 Jellyfin')
    expect(() => identifyJellyfin({ ProductName: 'Jellyfin Server', Version: '10.10.7' })).toThrow('需要 Jellyfin 10.11.x')
  })

  it('requires MediaWarp before accepting Jellyfin and returns both versions', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ app_version: '0.2.4' }))
      .mockResolvedValueOnce(jsonResponse({ ProductName: 'Jellyfin Server', ServerName: 'Home', Version: '10.11.11' }))
    await expect(JellyfinClient.inspect('http://media.example.test:9000')).resolves.toMatchObject({
      baseUrl: 'http://media.example.test:9000',
      mediaWarpVersion: '0.2.4',
      identity: { version: '10.11.11' },
    })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://media.example.test:9000/MediaWarp/version',
      'http://media.example.test:9000/System/Info/Public',
    ])
  })

  it('rejects a direct Jellyfin address with an actionable MediaWarp message', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({ ProductName: 'Jellyfin Server', Version: '10.11.11' }))
    await expect(JellyfinClient.inspect('http://media.example.test:8096')).rejects.toThrow('当前地址绕过 MediaWarp')
  })

  it('rejects MediaWarp versions older than 0.2.4', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ app_version: '0.2.3' }))
    await expect(JellyfinClient.inspect('http://media.example.test:9000')).rejects.toThrow('需要 0.2.4')
  })

  it('uses Jellyfin Authorization for API requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = new JellyfinClient('https://media.example.test', 'secret-token', 'user-1', identity, 'device-1')
    await client.request('/System/Info')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://media.example.test/System/Info')
    expect((init.headers as Headers).get('Authorization')).toContain('Token="secret-token"')
    expect((init.headers as Headers).get('X-Emby-Authorization')).toBeNull()
  })

  it('loads resume items through the dedicated endpoint with fixed media and image parameters', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [{ Id: 'resume-1' }], TotalRecordCount: 1 }))
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    await expect(client.getResumeItems()).resolves.toMatchObject({ Items: [{ Id: 'resume-1' }], TotalRecordCount: 1 })
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/Users/user-1/Items/Resume')
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
      UserId: 'user-1',
      Limit: '100',
      Recursive: 'true',
      MediaTypes: 'Video',
      EnableUserData: 'true',
      EnableImages: 'true',
      EnableImageTypes: 'Primary,Backdrop,Thumb',
    })
    expect((init.headers as Headers).get('Authorization')).toContain('Token="token"')
  })

  it('strictly validates the resume response shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [] }))
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    await expect(client.getResumeItems()).rejects.toThrow('缺少 Items 或 TotalRecordCount')
  })

  it('posts PlaybackInfo with MPV profile and selected tracks', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ MediaSources: [{ Id: 'source-1' }] }))
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    await client.getPlaybackInfo('item-1', { mediaSourceId: 'source-1', audioStreamIndex: 2, subtitleStreamIndex: 3, startTimeTicks: 40 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://media.example.test/Items/item-1/PlaybackInfo')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.UserId).toBe('user-1')
    expect(body.MediaSourceId).toBe('source-1')
    expect(body.AudioStreamIndex).toBe(2)
    expect(body.SubtitleStreamIndex).toBe(3)
    expect(body.StartTimeTicks).toBe(40)
    expect(body.DeviceProfile.DirectPlayProfiles).toEqual([{ Type: 'Video' }, { Type: 'Audio' }])
    expect(body.DeviceProfile.DirectPlayProfiles[0]).not.toHaveProperty('Container')
    expect(body.DeviceProfile.DirectPlayProfiles[0]).not.toHaveProperty('VideoCodec')
    expect(body.DeviceProfile.DirectPlayProfiles[0]).not.toHaveProperty('AudioCodec')
    expect(body.DeviceProfile.SubtitleProfiles).toEqual(expect.arrayContaining([{ Format: 'ass', Method: 'External' }]))
  })

  it('preserves MediaWarp-issued stream query parameters', () => {
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    const stream = client.buildStreamUrl('item-1', { Id: 'source-1', DirectStreamUrl: 'https://media.example.test/Videos/item-1/stream?Static=true&api_key=server-issued' }, { playSessionId: 'session-1', audioStreamIndex: 2 })
    expect(stream).toContain('Static=true')
    expect(stream).toContain('api_key=server-issued')
    expect(stream).toContain('PlaySessionId=session-1')
    expect(stream).toContain('AudioStreamIndex=2')
  })

  it('uses a transcoding URL when direct streaming is not returned', () => {
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    const stream = client.buildStreamUrl('item-1', { Id: 'source-1', TranscodingUrl: '/Videos/item-1/master.m3u8' }, {})
    expect(new URL(stream).pathname).toBe('/Videos/item-1/master.m3u8')
  })

  it('resolves direct play, direct stream, and transcode routes without fallback', () => {
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    expect(client.buildPlaybackRoute('movie-1', {
      Id: 'direct-play',
      SupportsDirectPlay: true,
      DirectStreamUrl: '/Videos/movie-1/stream?Static=true',
    }, {}).kind).toBe('direct-play')
    expect(client.buildPlaybackRoute('movie-1', {
      Id: 'direct-stream',
      SupportsDirectStream: true,
      DirectStreamUrl: '/Videos/movie-1/stream?Static=true',
    }, {}).kind).toBe('direct-stream')
    expect(client.buildPlaybackRoute('movie-1', {
      Id: 'transcode',
      TranscodingUrl: '/Videos/movie-1/master.m3u8',
    }, {}).kind).toBe('transcode')
  })

  it('rejects a media source with no server route or declared capability', () => {
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    expect(() => client.buildPlaybackRoute('movie-1', { Id: 'missing-route' }, {})).toThrow('没有可用的播放路由')
  })

  it('uses a static route only when Jellyfin declares direct capability', () => {
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    const route = client.buildPlaybackRoute('movie-1', { Id: 'static-route', SupportsDirectPlay: true }, { playSessionId: 'session-1' })
    const url = new URL(route.upstreamUrl)
    expect(url.pathname).toBe('/Videos/movie-1/stream')
    expect(url.searchParams.get('MediaSourceId')).toBe('static-route')
    expect(url.searchParams.get('Static')).toBe('true')
    expect(url.searchParams.get('PlaySessionId')).toBe('session-1')
  })

  it('validates query shapes and reports HTTP failures', async () => {
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [] }, 502))
    await expect(client.getViews()).rejects.toThrow('Jellyfin 请求失败（502）')
    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [] }))
    await expect(client.getViews()).rejects.toThrow('缺少 Items 或 TotalRecordCount')
  })

  it('translates a PlaybackInfo timeout without exposing AbortError text', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    await expect(client.getPlaybackInfo('slow-item')).rejects.toBeInstanceOf(PlaybackInfoTimeoutError)
  })
})
