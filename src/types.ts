export type ItemType = 'Movie' | 'Series' | 'Season' | 'Episode' | string

export interface UserData {
  PlaybackPositionTicks?: number
  PlayedPercentage?: number
  Played?: boolean
  IsFavorite?: boolean
}

export interface MediaStream {
  Index?: number
  Type?: 'Audio' | 'Video' | 'Subtitle' | string
  Codec?: string
  Language?: string
  DisplayLanguage?: string
  DisplayTitle?: string
  Title?: string
  IsDefault?: boolean
  IsExternal?: boolean
  IsExternalUrl?: boolean
  IsTextSubtitleStream?: boolean
  DeliveryUrl?: string
  SupportsExternalStream?: boolean
  Path?: string
}

export interface EmbyItem {
  Id: string
  Name: string
  Type: ItemType
  Overview?: string
  ProductionYear?: number
  PremiereDate?: string
  RunTimeTicks?: number
  ChildCount?: number
  IndexNumber?: number
  ParentIndexNumber?: number
  SeriesName?: string
  SeriesId?: string
  SeriesPrimaryImageTag?: string
  ImageTags?: Record<string, string>
  BackdropImageTags?: string[]
  UserData?: UserData
  MediaStreams?: MediaStream[]
  Genres?: string[]
  OfficialRating?: string
  CommunityRating?: number
}

export interface EmbyView {
  Id: string
  Name: string
  CollectionType?: string
  ImageTags?: Record<string, string>
}

export interface QueryResult<T> {
  Items: T[]
  TotalRecordCount: number
  StartIndex?: number
}

export type ItemResult = QueryResult<EmbyItem>

export interface RecommendationDto {
  Items: EmbyItem[]
  RecommendationType?: string
  BaselineItemName?: string
  CategoryId?: number
}

export interface ReleaseNoteSection {
  title: string
  items: string[]
}

export interface ReleaseNote {
  version: string
  date: string
  summary?: string
  sections: ReleaseNoteSection[]
}

export interface MediaSourceInfo {
  Id: string
  Name?: string
  Container?: string
  SupportsDirectPlay?: boolean
  SupportsDirectStream?: boolean
  DirectStreamUrl?: string
  TranscodingUrl?: string
  AddApiKeyToDirectStreamUrl?: boolean
  RequiredHttpHeaders?: Record<string, string>
  MediaStreams?: MediaStream[]
}

export interface PlaybackInfo {
  MediaSources?: MediaSourceInfo[]
  PlaySessionId?: string
}

export interface PublicSettings {
  serverUrl: string
  username: string
  userId?: string
  mpvPath: string
  connected: boolean
  secureStorageAvailable: boolean
}

export interface LoginResult {
  settings: PublicSettings
  user: {
    Id: string
    Name: string
  }
}

export interface SettingsInput {
  serverUrl: string
  username: string
  mpvPath: string
}

export interface ItemsQuery {
  parentId?: string
  includeItemTypes?: string
  recursive?: boolean
  searchTerm?: string
  sortBy?: string
  sortOrder?: 'Ascending' | 'Descending'
  startIndex?: number
  limit?: number
  isResumable?: boolean
  filters?: string
}

export interface ImageRequest {
  itemId: string
  imageType?: 'Primary' | 'Backdrop' | 'Thumb'
  tag?: string
  maxWidth?: number
}

export interface PlayRequest {
  itemId: string
  mediaSourceId?: string
  audioStreamIndex?: number
  subtitleStreamIndex?: number
  startTimeTicks?: number
}

export interface MpvStatus {
  type: 'started' | 'progress' | 'sync-error' | 'stopped' | 'error'
  itemId?: string
  positionTicks?: number
  durationSeconds?: number
  isPaused?: boolean
  syncError?: string
  message?: string
}

export interface PlaybackReportPayload {
  ItemId: string
  MediaSourceId?: string
  PlaySessionId?: string
  PlayMethod?: string
  PositionTicks?: number
  IsPaused?: boolean
  CanSeek?: boolean
  AudioStreamIndex?: number
  SubtitleStreamIndex?: number
}

export interface EmberApi {
  getSettings(): Promise<PublicSettings>
  saveSettings(input: SettingsInput): Promise<PublicSettings>
  login(input: { serverUrl: string; username: string; password: string; mpvPath: string }): Promise<LoginResult>
  logout(): Promise<PublicSettings>
  getViews(): Promise<EmbyView[]>
  getItems(query?: ItemsQuery): Promise<ItemResult>
  getMovieRecommendations(): Promise<RecommendationDto[]>
  getItem(itemId: string): Promise<EmbyItem>
  getPlaybackInfo(itemId: string): Promise<PlaybackInfo>
  getImage(request: ImageRequest): Promise<string>
  play(request: PlayRequest): Promise<{ itemId: string; sourceName: string }>
  stop(): Promise<void>
  onMpvStatus(callback: (status: MpvStatus) => void): () => void
}
