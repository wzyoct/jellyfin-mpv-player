import { Buffer } from 'node:buffer'
import packageInfo from '../package.json'
import { logger } from './logger'
import type {
  MediaItem,
  MediaView,
  ItemResult,
  MediaSourceInfo,
  PlaybackInfo,
  PlaybackReportPayload,
  QueryResult,
  RecommendationDto,
  JellyfinIdentity,
  PlaybackInfoRequest,
  PlaybackRoute,
} from '../src/types'

export type { MediaSourceInfo, PlaybackInfo } from '../src/types'

const REQUEST_TIMEOUT_MS = 15_000
export const PLAYBACK_INFO_TIMEOUT_MS = 60_000
const INSPECT_TIMEOUT_MS = 10_000
const CLIENT_NAME = 'Jellyfin MPV Player'
const DEVICE_NAME = 'Windows'

export interface AuthResponse {
  AccessToken: string
  User: {
    Id: string
    Name: string
  }
}

interface PublicSystemInfo {
  ProductName?: string | null
  ServerName?: string | null
  Version?: string | null
}

interface MediaWarpVersionInfo {
  app_version?: string
  version?: string
}

export class PlaybackInfoTimeoutError extends Error {
  readonly code = 'PLAYBACK_INFO_TIMEOUT'

  constructor() {
    super('播放信息解析超时（60 秒）')
    this.name = 'PlaybackInfoTimeoutError'
  }
}

export function isAbortError(error: unknown): boolean {
  return (typeof DOMException !== 'undefined' && error instanceof DOMException)
    ? error.name === 'AbortError'
    : Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError')
}

export function jellyfinLabel(): string {
  return 'Jellyfin'
}

export function buildJellyfinAuthorization(token: string, deviceId = 'jellyfin-mpv-player'): string {
  const clientHeader = `MediaBrowser Client=\"${encodeURIComponent(CLIENT_NAME)}\", Device=\"${encodeURIComponent(DEVICE_NAME)}\", DeviceId=\"${encodeURIComponent(deviceId)}\", Version=\"${encodeURIComponent(packageInfo.version)}\"`
  return token ? `${clientHeader}, Token=\"${encodeURIComponent(token)}\"` : clientHeader
}

function parseVersion(version: string): [number, number] | undefined {
  const match = version.trim().match(/^(\d+)\.(\d+)/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2])]
}

function isVersionAtLeast(version: string, minimum: [number, number, number]): boolean {
  const match = version.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return false
  const actual = [Number(match[1]), Number(match[2]), Number(match[3] || 0)]
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

export function identifyJellyfin(info: PublicSystemInfo): JellyfinIdentity {
  const productName = typeof info.ProductName === 'string' ? info.ProductName.trim() : ''
  const version = typeof info.Version === 'string' ? info.Version.trim() : ''
  if (!version) throw new Error('媒体服务器未返回有效版本号')

  if (!/jellyfin/i.test(productName)) {
    throw new Error(`当前地址不是 Jellyfin 服务（${productName || '未知产品'}）`)
  }
  const parsed = parseVersion(version)
  if (!parsed || parsed[0] !== 10 || parsed[1] !== 11) {
    throw new Error(`当前 Jellyfin 版本为 ${version}，Jellyfin MPV Player 1.0.4 需要 Jellyfin 10.11.x`)
  }
  return { name: info.ServerName?.trim() || 'Jellyfin Server', version }
}

function parseQueryResult<T>(value: unknown, endpoint: string): QueryResult<T> {
  if (!value || typeof value !== 'object') {
    throw new Error(`媒体服务器接口 ${endpoint} 返回格式无效`)
  }
  const result = value as Partial<QueryResult<T>>
  if (!Array.isArray(result.Items) || typeof result.TotalRecordCount !== 'number') {
    throw new Error(`媒体服务器接口 ${endpoint} 缺少 Items 或 TotalRecordCount`)
  }
  return {
    Items: result.Items,
    TotalRecordCount: result.TotalRecordCount,
    StartIndex: typeof result.StartIndex === 'number' ? result.StartIndex : undefined,
  }
}

function parsePlaybackInfo(value: unknown): PlaybackInfo {
  if (!value || typeof value !== 'object') throw new Error('Jellyfin 播放信息返回格式无效')
  const result = value as Partial<PlaybackInfo>
  if (result.MediaSources !== undefined && !Array.isArray(result.MediaSources)) throw new Error('Jellyfin 播放信息缺少有效媒体源列表')
  const sources = (result.MediaSources || []).map((source) => {
    if (!source || typeof source !== 'object' || typeof source.Id !== 'string' || !source.Id.trim()) throw new Error('Jellyfin 播放信息包含无效媒体源')
    if (source.MediaStreams !== undefined && !Array.isArray(source.MediaStreams)) throw new Error(`Jellyfin 媒体源 ${source.Id} 包含无效轨道列表`)
    return source
  })
  return { MediaSources: sources, PlaySessionId: typeof result.PlaySessionId === 'string' ? result.PlaySessionId : undefined }
}

export function normalizeServerUrl(rawUrl: string): string {
  let value = rawUrl.trim()
  if (!value) {
    throw new Error('请输入 Jellyfin 服务器地址')
  }
  if (!/^https?:\/\//i.test(value)) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) throw new Error('服务器地址仅支持 HTTP 或 HTTPS')
    value = `http://${value}`
  }

  const parsed = new URL(value)
  if (parsed.username || parsed.password) {
    throw new Error('服务器地址不能包含用户名或密码')
  }
  let pathname = parsed.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/web(?:\/.*)?$/i, '')
  if (!pathname) pathname = '/'
  parsed.pathname = pathname
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

export class JellyfinClient {
  readonly baseUrl: string
  readonly token: string
  readonly userId: string
  readonly deviceId: string
  readonly identity: JellyfinIdentity

  constructor(baseUrl: string, token: string, userId: string, identity: JellyfinIdentity, deviceId = 'jellyfin-mpv-player') {
    this.baseUrl = normalizeServerUrl(baseUrl)
    this.token = token
    this.userId = userId
    this.identity = identity
    this.deviceId = deviceId
  }

  static async inspect(baseUrl: string): Promise<{ baseUrl: string; identity: JellyfinIdentity; mediaWarpVersion: string }> {
    const normalizedUrl = normalizeServerUrl(baseUrl)
    let mediaWarpResponse: Response
    try {
      mediaWarpResponse = await fetch(`${normalizedUrl}/MediaWarp/version`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS) })
    } catch (error) {
      throw new Error(`无法连接媒体服务器：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!mediaWarpResponse.ok) {
      let directInfo: PublicSystemInfo | undefined
      try {
        const response = await fetch(`${normalizedUrl}/System/Info/Public`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS) })
        if (response.ok) directInfo = await response.json() as PublicSystemInfo
      } catch {
        // Preserve the MediaWarp-specific error below when the endpoint is not a Jellyfin server.
      }
      if (directInfo && /jellyfin/i.test(typeof directInfo.ProductName === 'string' ? directInfo.ProductName : '')) {
        throw new Error('当前地址绕过 MediaWarp，请填写 MediaWarp 根地址，例如 http://主机:9000')
      }
      throw new Error(`当前地址不是可用的 MediaWarp 服务（${mediaWarpResponse.status}）`)
    }
    let mediaWarp: MediaWarpVersionInfo
    try {
      mediaWarp = await mediaWarpResponse.json() as MediaWarpVersionInfo
    } catch {
      throw new Error('MediaWarp 版本信息格式无效')
    }
    const mediaWarpVersion = typeof mediaWarp.app_version === 'string' ? mediaWarp.app_version.trim() : typeof mediaWarp.version === 'string' ? mediaWarp.version.trim() : ''
    if (!mediaWarpVersion || !isVersionAtLeast(mediaWarpVersion, [0, 2, 4])) {
      throw new Error(`MediaWarp 版本 ${mediaWarpVersion || '未知'} 过低，需要 0.2.4 或更新版本`)
    }
    let response: Response
    try {
      response = await fetch(`${normalizedUrl}/System/Info/Public`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS) })
    } catch (error) {
      throw new Error(`无法连接 Jellyfin：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`无法读取 Jellyfin 公开信息（${response.status}）：${response.statusText}`)
    let info: PublicSystemInfo
    try {
      info = await response.json() as PublicSystemInfo
    } catch {
      throw new Error('Jellyfin 返回的公开信息格式无效')
    }
    return { baseUrl: normalizedUrl, identity: identifyJellyfin(info), mediaWarpVersion }
  }

  static async authenticate(baseUrl: string, username: string, password: string, identity: JellyfinIdentity, deviceId = 'jellyfin-mpv-player'): Promise<AuthResponse & { identity: JellyfinIdentity; baseUrl: string }> {
    const client = new JellyfinClient(baseUrl, '', '', identity, deviceId)
    const result = await client.request<AuthResponse>('/Users/AuthenticateByName', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: password }),
    })
    if (!result || typeof result.AccessToken !== 'string' || !result.AccessToken.trim() || !result.User || typeof result.User.Id !== 'string' || !result.User.Id.trim() || typeof result.User.Name !== 'string' || !result.User.Name.trim()) {
      throw new Error('Jellyfin 登录响应缺少有效用户或令牌')
    }
    return { ...result, identity, baseUrl: client.baseUrl }
  }

  async request<T>(path: string, init: RequestInit = {}, options: { timeoutMs?: number; signal?: AbortSignal; timeoutError?: Error } = {}): Promise<T> {
    const method = init.method || 'GET'
    const endpoint = path.split('?')[0]
    const startedAt = Date.now()
    logger.info('jellyfin', 'request-start', { method, endpoint })
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    this.setAuthorization(headers)

    const controller = new AbortController()
    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let response: Response
    try {
      response = await fetch(this.resolveUrl(path), { ...init, headers, signal: controller.signal })
    } catch (error) {
      logger.error('jellyfin', 'request-failed', error, { method, endpoint, durationMs: Date.now() - startedAt })
      if (options.signal?.aborted) throw error
      if (options.timeoutError && (controller.signal.aborted || isAbortError(error))) throw options.timeoutError
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.warn('jellyfin', 'request-failed', { method, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      throw new Error(`Jellyfin 请求失败（${response.status}）：${body.slice(0, 180) || response.statusText}`)
    }

    if (response.status === 204) {
      logger.info('jellyfin', 'request-complete', { method, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      return undefined as T
    }
    try {
      const result = await response.json() as T
      logger.info('jellyfin', 'request-complete', { method, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      return result
    } catch (error) {
      logger.error('jellyfin', 'response-parse-failed', error, { method, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      throw error
    }
  }

  async requestBinary(path: string): Promise<{ mimeType: string; data: string }> {
    const endpoint = path.split('?')[0]
    const startedAt = Date.now()
    logger.info('jellyfin', 'binary-request-start', { method: 'GET', endpoint })
    const headers = new Headers()
    this.setAuthorization(headers)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(this.resolveUrl(path), { headers, signal: controller.signal })
    } catch (error) {
      logger.error('jellyfin', 'binary-request-failed', error, { endpoint, durationMs: Date.now() - startedAt })
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      logger.warn('jellyfin', 'binary-request-failed', { endpoint, status: response.status, durationMs: Date.now() - startedAt })
      throw new Error(`Jellyfin 图片请求失败（${response.status}）`)
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    try {
      const buffer = Buffer.from(await response.arrayBuffer())
      logger.info('jellyfin', 'binary-request-complete', { endpoint, status: response.status, durationMs: Date.now() - startedAt })
      return { mimeType: contentType, data: buffer.toString('base64') }
    } catch (error) {
      logger.error('jellyfin', 'binary-response-read-failed', error, { endpoint, status: response.status, durationMs: Date.now() - startedAt })
      throw error
    }
  }

  async getViews(): Promise<MediaView[]> {
    const result = parseQueryResult<MediaView>(
      await this.request(`/Users/${encodeURIComponent(this.userId)}/Views`),
      '/Users/{UserId}/Views',
    )
    return result.Items
  }

  async getItems(options: {
    parentId?: string
    includeItemTypes?: string
    recursive?: boolean
    searchTerm?: string
    sortBy?: string
    sortOrder?: string
    startIndex?: number
    limit?: number
    isResumable?: boolean
    filters?: string
    seriesId?: string
  } = {}): Promise<ItemResult> {
    const params = new URLSearchParams({
      UserId: this.userId,
      IncludeItemTypes: options.includeItemTypes || 'Movie,Series',
      Recursive: String(options.recursive ?? true),
      SortBy: options.sortBy || 'SortName',
      SortOrder: options.sortOrder || 'Ascending',
      StartIndex: String(options.startIndex || 0),
      Limit: String(options.limit || 48),
      Fields: 'Overview,Genres,MediaStreams,ProviderIds,DateCreated,UserData',
      EnableImages: 'true',
      EnableImageTypes: 'Primary,Backdrop,Thumb',
      EnableUserData: 'true',
      ImageTypeLimit: '1',
    })
    if (options.parentId) params.set('ParentId', options.parentId)
    if (options.seriesId) params.set('SeriesId', options.seriesId)
    if (options.searchTerm) params.set('SearchTerm', options.searchTerm)
    if (options.filters) params.set('Filters', options.filters)
    if (options.isResumable) params.set('Filters', 'IsResumable')
    return parseQueryResult<MediaItem>(
      await this.request(`/Users/${encodeURIComponent(this.userId)}/Items?${params.toString()}`),
      '/Users/{UserId}/Items',
    ) as ItemResult
  }

  async getMovieRecommendations(): Promise<RecommendationDto[]> {
    const params = new URLSearchParams({
      UserId: this.userId,
      CategoryLimit: '2',
      ItemLimit: '8',
      Fields: 'Overview',
      EnableImages: 'true',
      EnableImageTypes: 'Primary,Backdrop,Thumb',
      EnableUserData: 'true',
      ImageTypeLimit: '1',
    })
    const value = await this.request(`/Movies/Recommendations?${params.toString()}`)
    if (!Array.isArray(value)) {
      throw new Error('Jellyfin 接口 /Movies/Recommendations 返回格式无效')
    }
    return value as RecommendationDto[]
  }

  async getItem(itemId: string): Promise<MediaItem> {
    const params = new URLSearchParams({
      UserId: this.userId,
      Fields: 'Overview,Genres,MediaStreams,ProviderIds,DateCreated,UserData',
      EnableUserData: 'true',
      EnableImages: 'true',
      EnableImageTypes: 'Primary,Backdrop,Thumb',
    })
    return this.request(`/Users/${encodeURIComponent(this.userId)}/Items/${encodeURIComponent(itemId)}?${params.toString()}`)
  }

  async getPlaybackInfo(itemId: string, options: PlaybackInfoRequest = {}, signal?: AbortSignal): Promise<PlaybackInfo> {
    const body = {
      UserId: this.userId,
      DeviceProfile: {
        Name: 'Jellyfin MPV Player',
        MaxStreamingBitrate: 100_000_000,
        MaxStaticBitrate: 100_000_000,
        DirectPlayProfiles: [
          { Type: 'Video' },
          { Type: 'Audio' },
        ],
        TranscodingProfiles: [
          { Type: 'Video', Container: 'ts', AudioCodec: 'aac,mp3,ac3,eac3,opus,flac', VideoCodec: 'h264,hevc,vp9,av1', Protocol: 'hls', Context: 'Streaming', EnableMpegtsM2TsMode: true },
        ],
        SubtitleProfiles: [
          ...['srt', 'ass', 'ssa', 'smi', 'vtt'].map((Format) => ({ Format, Method: 'External' })),
          ...['sub', 'sup', 'pgs', 'dvdsub', 'dvbsub'].map((Format) => ({ Format, Method: 'Embed' })),
        ],
      },
      EnableDirectPlay: true,
      EnableDirectStream: true,
      EnableTranscoding: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      AutoOpenLiveStream: true,
      StartTimeTicks: Math.max(0, options.startTimeTicks || 0),
      ...(options.mediaSourceId ? { MediaSourceId: options.mediaSourceId } : {}),
      ...(options.audioStreamIndex !== undefined ? { AudioStreamIndex: options.audioStreamIndex } : {}),
      ...(options.subtitleStreamIndex !== undefined ? { SubtitleStreamIndex: options.subtitleStreamIndex } : {}),
    }
    const value = await this.request(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { timeoutMs: PLAYBACK_INFO_TIMEOUT_MS, signal, timeoutError: new PlaybackInfoTimeoutError() })
    return parsePlaybackInfo(value)
  }

  async getNextUp(seriesId?: string): Promise<ItemResult> {
    const params = new URLSearchParams({
      UserId: this.userId,
      Limit: '100',
      Fields: 'Overview,MediaStreams,DateCreated,UserData',
      EnableImages: 'true',
      EnableImageTypes: 'Primary,Backdrop,Thumb',
      EnableUserData: 'true',
      ImageTypeLimit: '1',
    })
    if (seriesId) params.set('SeriesId', seriesId)
    return parseQueryResult<MediaItem>(
      await this.request(`/Shows/NextUp?${params.toString()}`),
      '/Shows/NextUp',
    ) as ItemResult
  }

  async getSeriesEpisodes(seriesId: string): Promise<MediaItem[]> {
    const items: MediaItem[] = []
    let startIndex = 0
    let totalRecordCount = Number.POSITIVE_INFINITY
    let pageCount = 0
    while (startIndex < totalRecordCount && pageCount < 200) {
      const params = new URLSearchParams({
        UserId: this.userId,
        IncludeItemTypes: 'Episode',
        Recursive: 'true',
        SortBy: 'ParentIndexNumber,IndexNumber,SortName',
        SortOrder: 'Ascending',
        StartIndex: String(startIndex),
        Limit: '100',
        Fields: 'Overview,MediaStreams,DateCreated,UserData',
        EnableImages: 'true',
        EnableImageTypes: 'Primary,Backdrop,Thumb',
        EnableUserData: 'true',
        ImageTypeLimit: '1',
      })
      const result = parseQueryResult<MediaItem>(
        await this.request(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${params.toString()}`),
        '/Shows/{SeriesId}/Episodes',
      ) as ItemResult
      items.push(...result.Items)
      totalRecordCount = result.TotalRecordCount
      if (!result.Items.length) break
      startIndex += result.Items.length
      pageCount += 1
    }
    return items
  }

  async getImage(itemId: string, imageType: string, tag?: string, maxWidth = 480): Promise<string> {
    const params = new URLSearchParams({ maxWidth: String(maxWidth), quality: '88' })
    if (tag) params.set('tag', tag)
    const image = await this.requestBinary(`/Items/${encodeURIComponent(itemId)}/Images/${imageType}?${params.toString()}`)
    return `data:${image.mimeType};base64,${image.data}`
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`
  }

  buildStreamUrl(itemId: string, source: MediaSourceInfo, options: {
    audioStreamIndex?: number
    subtitleStreamIndex?: number
    playSessionId?: string
  }): string {
    const rawUrl = source.DirectStreamUrl
      || source.TranscodingUrl
      || ((source.SupportsDirectPlay || source.SupportsDirectStream) ? `/Videos/${encodeURIComponent(itemId)}/stream` : undefined)
    if (!rawUrl) {
      throw new Error(`媒体源 ${source.Id} 没有可用的播放地址`)
    }
    const url = new URL(this.resolveUrl(rawUrl))
    // The URL stays inside the loopback gateway. Keeping server-issued query
    // parameters is required for MediaWarp's short-lived redirect route.
    if (!source.DirectStreamUrl && !source.TranscodingUrl) {
      url.searchParams.set('MediaSourceId', source.Id)
      url.searchParams.set('Static', 'true')
    }
    if (options.audioStreamIndex !== undefined) url.searchParams.set('AudioStreamIndex', String(options.audioStreamIndex))
    if (options.subtitleStreamIndex !== undefined) url.searchParams.set('SubtitleStreamIndex', String(options.subtitleStreamIndex))
    if (options.playSessionId) url.searchParams.set('PlaySessionId', options.playSessionId)
    return url.toString()
  }

  buildPlaybackRoute(itemId: string, source: MediaSourceInfo, options: {
    audioStreamIndex?: number
    subtitleStreamIndex?: number
    playSessionId?: string
  }): PlaybackRoute {
    const kind: PlaybackRoute['kind'] = source.DirectStreamUrl
      ? source.SupportsDirectPlay ? 'direct-play' : 'direct-stream'
      : source.TranscodingUrl
        ? 'transcode'
        : source.SupportsDirectPlay
          ? 'direct-play'
          : source.SupportsDirectStream
            ? 'direct-stream'
            : (() => { throw new Error(`媒体源 ${source.Id} 没有可用的播放路由`) })()
    return {
      kind,
      upstreamUrl: this.buildStreamUrl(itemId, source, options),
      mediaSourceId: source.Id,
      playSessionId: options.playSessionId,
      requiredHttpHeaders: { ...(source.RequiredHttpHeaders || {}) },
    }
  }

  async reportPlaying(payload: PlaybackReportPayload): Promise<void> {
    await this.request('/Sessions/Playing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async reportProgress(payload: PlaybackReportPayload): Promise<void> {
    await this.request('/Sessions/Playing/Progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  async reportStopped(payload: PlaybackReportPayload): Promise<void> {
    await this.request('/Sessions/Playing/Stopped', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  buildAuthorization(): string {
    return buildJellyfinAuthorization(this.token, this.deviceId)
  }

  private setAuthorization(headers: Headers): void {
    headers.set('Authorization', this.buildAuthorization())
  }
}
