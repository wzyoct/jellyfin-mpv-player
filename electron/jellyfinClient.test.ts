import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JellyfinClient, identifyJellyfin, normalizeServerUrl } from './jellyfinClient'

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

  it('uses Jellyfin Authorization for API requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = new JellyfinClient('https://media.example.test', 'secret-token', 'user-1', identity, 'device-1')
    await client.request('/System/Info')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://media.example.test/System/Info')
    expect((init.headers as Headers).get('Authorization')).toContain('Token="secret-token"')
    expect((init.headers as Headers).get('X-Emby-Authorization')).toBeNull()
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
    expect(body.DeviceProfile.DirectPlayProfiles[0].Container).toBe('*')
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

  it('validates query shapes and reports HTTP failures', async () => {
    const client = new JellyfinClient('https://media.example.test', 'token', 'user-1', identity)
    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [] }, 502))
    await expect(client.getViews()).rejects.toThrow('Jellyfin 请求失败（502）')
    fetchMock.mockResolvedValueOnce(jsonResponse({ Items: [] }))
    await expect(client.getViews()).rejects.toThrow('缺少 Items 或 TotalRecordCount')
  })
})
