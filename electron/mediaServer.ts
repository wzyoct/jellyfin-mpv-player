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
  MediaServerIdentity,
  MediaServerKind,
} from '../src/types'

export type { MediaSourceInfo, PlaybackInfo } from '../src/types'

const CLIENT_HEADER = `MediaBrowser Client="Ember Player", Device="Windows", Version="${packageInfo.version}"`
const REQUEST_TIMEOUT_MS = 15_000
const CLIENT_NAME = 'Ember Player'
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

export function mediaServerLabel(kind?: MediaServerKind): string {
  return kind === 'jellyfin' ? 'Jellyfin' : kind === 'emby' ? 'Emby' : '媒体服务器'
}

export function buildMediaServerAuthorization(kind: MediaServerKind, token: string, deviceId = 'ember-player'): string {
  const clientHeader = `MediaBrowser Client=\"${encodeURIComponent(CLIENT_NAME)}\", Device=\"${encodeURIComponent(DEVICE_NAME)}\", DeviceId=\"${encodeURIComponent(deviceId)}\", Version=\"${encodeURIComponent(packageInfo.version)}\"`
  return kind === 'jellyfin' && token ? `${clientHeader}, Token=\"${encodeURIComponent(token)}\"` : clientHeader
}

function parseVersion(version: string): [number, number] | undefined {
  const match = version.trim().match(/^(\d+)\.(\d+)/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2])]
}

export function identifyMediaServer(info: PublicSystemInfo): MediaServerIdentity {
  const productName = typeof info.ProductName === 'string' ? info.ProductName.trim() : ''
  const version = typeof info.Version === 'string' ? info.Version.trim() : ''
  if (!version) throw new Error('媒体服务器未返回有效版本号')

  if (/jellyfin/i.test(productName)) {
    const parsed = parseVersion(version)
    if (!parsed || parsed[0] !== 10 || parsed[1] !== 11) {
      throw new Error(`当前 Jellyfin 版本为 ${version}，Ember Player 0.9.0 需要 Jellyfin 10.11.x`)
    }
    return { kind: 'jellyfin', name: info.ServerName?.trim() || 'Jellyfin Server', version }
  }

  if (/emby/i.test(productName) || (!productName && parseVersion(version)?.[0] === 4)) {
    return { kind: 'emby', name: info.ServerName?.trim() || 'Emby Server', version }
  }

  throw new Error(`无法识别媒体服务器（${productName || '未知产品'} ${version}）`)
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

export function normalizeServerUrl(rawUrl: string): string {
  let value = rawUrl.trim()
  if (!value) {
    throw new Error('请输入 Jellyfin 或 Emby 服务器地址')
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

export class MediaServerClient {
  readonly baseUrl: string
  readonly token: string
  readonly userId: string
  readonly deviceId: string
  readonly identity: MediaServerIdentity

  constructor(baseUrl: string, token: string, userId: string, identity: MediaServerIdentity, deviceId = 'ember-player') {
    this.baseUrl = normalizeServerUrl(baseUrl)
    this.token = token
    this.userId = userId
    this.identity = identity
    this.deviceId = deviceId
  }

  static async inspect(baseUrl: string): Promise<{ baseUrl: string; identity: MediaServerIdentity }> {
    const normalizedUrl = normalizeServerUrl(baseUrl)
    let response: Response
    try {
      response = await fetch(`${normalizedUrl}/System/Info/Public`, { headers: { Accept: 'application/json' } })
    } catch (error) {
      throw new Error(`无法连接媒体服务器：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      throw new Error(`无法连接媒体服务器（${response.status}）：${response.statusText}`)
    }
    let info: PublicSystemInfo
    try {
      info = await response.json() as PublicSystemInfo
    } catch {
      throw new Error('媒体服务器返回的公开信息格式无效')
    }
    const finalUrl = response.url.replace(/\/System\/Info\/Public\/?$/i, '') || normalizedUrl
    return { baseUrl: normalizeServerUrl(finalUrl), identity: identifyMediaServer(info) }
  }

  static async authenticate(baseUrl: string, username: string, password: string, identity: MediaServerIdentity, deviceId = 'ember-player'): Promise<AuthResponse & { identity: MediaServerIdentity; baseUrl: string }> {
    const client = new MediaServerClient(baseUrl, '', '', identity, deviceId)
    const result = await client.request<AuthResponse>('/Users/AuthenticateByName', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: password }),
    })
    if (!result || typeof result.AccessToken !== 'string' || !result.AccessToken.trim() || !result.User || typeof result.User.Id !== 'string' || !result.User.Id.trim() || typeof result.User.Name !== 'string' || !result.User.Name.trim()) {
      throw new Error(`${mediaServerLabel(identity.kind)} 登录响应缺少有效用户或令牌`)
    }
    return { ...result, identity, baseUrl: client.baseUrl }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = init.method || 'GET'
    const endpoint = path.split('?')[0]
    const startedAt = Date.now()
    logger.info('media-server', 'request-start', { kind: this.identity.kind, method, endpoint })
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    this.setAuthorization(headers)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(this.resolveUrl(path), { ...init, headers, signal: init.signal || controller.signal })
    } catch (error) {
      logger.error('media-server', 'request-failed', error, { kind: this.identity.kind, method, endpoint, durationMs: Date.now() - startedAt })
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.warn('media-server', 'request-failed', { kind: this.identity.kind, method, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      throw new Error(`${mediaServerLabel(this.identity.kind)} 请求失败（${response.status}）：${body.slice(0, 180) || response.statusText}`)
    }

    if (response.status === 204) {
      logger.info('media-server', 'request-complete', { kind: this.identity.kind, method, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      return undefined as T
    }
    try {
      const result = await response.json() as T
      logger.info('media-server', 'request-complete', { kind: this.identity.kind, method, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      return result
    } catch (error) {
      logger.error('media-server', 'response-parse-failed', error, { kind: this.identity.kind, method, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      throw error
    }
  }

  async requestBinary(path: string): Promise<{ mimeType: string; data: string }> {
    const endpoint = path.split('?')[0]
    const startedAt = Date.now()
    logger.info('media-server', 'binary-request-start', { kind: this.identity.kind, method: 'GET', endpoint })
    const headers = new Headers()
    this.setAuthorization(headers)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(this.resolveUrl(path), { headers, signal: controller.signal })
    } catch (error) {
      logger.error('media-server', 'binary-request-failed', error, { kind: this.identity.kind, endpoint, durationMs: Date.now() - startedAt })
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      logger.warn('media-server', 'binary-request-failed', { kind: this.identity.kind, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      throw new Error(`${mediaServerLabel(this.identity.kind)} 图片请求失败（${response.status}）`)
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    try {
      const buffer = Buffer.from(await response.arrayBuffer())
      logger.info('media-server', 'binary-request-complete', { kind: this.identity.kind, endpoint, status: response.status, durationMs: Date.now() - startedAt })
      return { mimeType: contentType, data: buffer.toString('base64') }
    } catch (error) {
      logger.error('media-server', 'binary-response-read-failed', error, { kind: this.identity.kind, endpoint, status: response.status, durationMs: Date.now() - startedAt })
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
      throw new Error(`${mediaServerLabel(this.identity.kind)} 接口 /Movies/Recommendations 返回格式无效`)
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

  async getPlaybackInfo(itemId: string): Promise<PlaybackInfo> {
    const params = new URLSearchParams({ UserId: this.userId })
    return this.request(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo?${params.toString()}`)
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
    const rawUrl = source.DirectStreamUrl || `/Videos/${encodeURIComponent(itemId)}/stream`
    const url = new URL(this.resolveUrl(rawUrl))
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:api[_-]?key|access[_-]?token|x[-_]emby[-_]token|x[-_]mediabrowser[-_]token|token)$/i.test(key)) url.searchParams.delete(key)
    }
    if (!source.DirectStreamUrl) {
      url.searchParams.set('MediaSourceId', source.Id)
      url.searchParams.set('Static', 'true')
    }
    if (options.audioStreamIndex !== undefined) url.searchParams.set('AudioStreamIndex', String(options.audioStreamIndex))
    if (options.subtitleStreamIndex !== undefined) url.searchParams.set('SubtitleStreamIndex', String(options.subtitleStreamIndex))
    if (options.playSessionId) url.searchParams.set('PlaySessionId', options.playSessionId)
    return url.toString()
  }

  buildSubtitleUrl(itemId: string, mediaSourceId: string, subtitleIndex: number): string {
    const url = new URL(this.resolveUrl(`/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${subtitleIndex}/Stream.srt`))
    return url.toString()
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

  private setAuthorization(headers: Headers): void {
    if (this.identity.kind === 'jellyfin') {
      headers.set('Authorization', buildMediaServerAuthorization(this.identity.kind, this.token, this.deviceId))
      return
    }
    headers.set('X-Emby-Authorization', this.clientHeader())
    if (this.token) headers.set('X-MediaBrowser-Token', this.token)
  }

  private clientHeader(): string {
    return `${CLIENT_HEADER}, DeviceId="${this.deviceId}"`
  }
}
