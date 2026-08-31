import { Buffer } from 'node:buffer'
import packageInfo from '../package.json'
import type {
  EmbyItem,
  EmbyView,
  ItemResult,
  MediaSourceInfo,
  PlaybackInfo,
  PlaybackReportPayload,
  QueryResult,
  RecommendationDto,
} from '../src/types'

export type { MediaSourceInfo, PlaybackInfo } from '../src/types'

const CLIENT_HEADER = `MediaBrowser Client="Ember Player", Device="Windows", Version="${packageInfo.version}"`
const REQUEST_TIMEOUT_MS = 15_000

export interface AuthResponse {
  AccessToken: string
  User: {
    Id: string
    Name: string
  }
}

function parseQueryResult<T>(value: unknown, endpoint: string): QueryResult<T> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Emby 接口 ${endpoint} 返回格式无效`)
  }
  const result = value as Partial<QueryResult<T>>
  if (!Array.isArray(result.Items) || typeof result.TotalRecordCount !== 'number') {
    throw new Error(`Emby 接口 ${endpoint} 缺少 Items 或 TotalRecordCount`)
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
    throw new Error('请输入 Emby 服务器地址')
  }
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`
  }

  const parsed = new URL(value)
  let pathname = parsed.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/web(?:\/.*)?$/i, '')
  if (!pathname) {
    pathname = '/emby'
  }
  parsed.pathname = pathname
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

export class EmbyClient {
  readonly baseUrl: string
  readonly token: string
  readonly userId: string
  readonly deviceId: string

  constructor(baseUrl: string, token: string, userId: string, deviceId = 'ember-player') {
    this.baseUrl = normalizeServerUrl(baseUrl)
    this.token = token
    this.userId = userId
    this.deviceId = deviceId
  }

  static async authenticate(baseUrl: string, username: string, password: string): Promise<AuthResponse> {
    const client = new EmbyClient(normalizeServerUrl(baseUrl), '', '')
    return client.request<AuthResponse>('/Users/AuthenticateByName', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: password }),
    })
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    headers.set('X-Emby-Authorization', this.clientHeader())
    if (this.token) {
      headers.set('X-MediaBrowser-Token', this.token)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(this.resolveUrl(path), { ...init, headers, signal: init.signal || controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Emby 请求失败（${response.status}）：${body.slice(0, 180) || response.statusText}`)
    }

    if (response.status === 204) {
      return undefined as T
    }
    return response.json() as Promise<T>
  }

  async requestBinary(path: string): Promise<{ mimeType: string; data: string }> {
    const headers = new Headers()
    headers.set('X-Emby-Authorization', this.clientHeader())
    if (this.token) {
      headers.set('X-MediaBrowser-Token', this.token)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(this.resolveUrl(path), { headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new Error(`图片请求失败（${response.status}）`)
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const buffer = Buffer.from(await response.arrayBuffer())
    return { mimeType: contentType, data: buffer.toString('base64') }
  }

  async getViews(): Promise<EmbyView[]> {
    const result = parseQueryResult<EmbyView>(
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
      EnableUserData: 'true',
      ImageTypeLimit: '1',
    })
    if (options.parentId) params.set('ParentId', options.parentId)
    if (options.searchTerm) params.set('SearchTerm', options.searchTerm)
    if (options.filters) params.set('Filters', options.filters)
    if (options.isResumable) params.set('Filters', 'IsResumable')
    return parseQueryResult<EmbyItem>(
      await this.request(`/Users/${encodeURIComponent(this.userId)}/Items?${params.toString()}`),
      '/Users/{UserId}/Items',
    ) as ItemResult
  }

  async getMovieRecommendations(): Promise<RecommendationDto[]> {
    const params = new URLSearchParams({
      UserId: this.userId,
      CategoryLimit: '2',
      ItemLimit: '8',
      EnableImages: 'true',
      EnableUserData: 'true',
      ImageTypeLimit: '1',
    })
    const value = await this.request(`/Movies/Recommendations?${params.toString()}`)
    if (!Array.isArray(value)) {
      throw new Error('Emby 接口 /Movies/Recommendations 返回格式无效')
    }
    return value as RecommendationDto[]
  }

  async getItem(itemId: string): Promise<EmbyItem> {
    const params = new URLSearchParams({
      UserId: this.userId,
      Fields: 'Overview,Genres,MediaStreams,ProviderIds,DateCreated,UserData',
      EnableUserData: 'true',
      EnableImages: 'true',
    })
    return this.request(`/Users/${encodeURIComponent(this.userId)}/Items/${encodeURIComponent(itemId)}?${params.toString()}`)
  }

  async getPlaybackInfo(itemId: string): Promise<PlaybackInfo> {
    const params = new URLSearchParams({ UserId: this.userId })
    return this.request(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo?${params.toString()}`)
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
    startTimeTicks?: number
    playSessionId?: string
  }): string {
    const rawUrl = source.DirectStreamUrl || `/Videos/${encodeURIComponent(itemId)}/stream`
    const url = new URL(this.resolveUrl(rawUrl))
    if (!source.DirectStreamUrl) {
      url.searchParams.set('MediaSourceId', source.Id)
      url.searchParams.set('Static', 'true')
    }
    if (options.audioStreamIndex !== undefined) url.searchParams.set('AudioStreamIndex', String(options.audioStreamIndex))
    if (options.subtitleStreamIndex !== undefined) url.searchParams.set('SubtitleStreamIndex', String(options.subtitleStreamIndex))
    if (options.startTimeTicks) url.searchParams.set('StartTimeTicks', String(Math.round(options.startTimeTicks)))
    if (options.playSessionId) url.searchParams.set('PlaySessionId', options.playSessionId)
    return url.toString()
  }

  buildSubtitleUrl(itemId: string, mediaSourceId: string, subtitleIndex: number, startTimeTicks?: number): string {
    const url = new URL(this.resolveUrl(`/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${subtitleIndex}/Stream.srt`))
    if (startTimeTicks) url.searchParams.set('StartPositionTicks', String(Math.round(startTimeTicks)))
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

  private clientHeader(): string {
    return `${CLIENT_HEADER}, DeviceId="${this.deviceId}"`
  }
}
