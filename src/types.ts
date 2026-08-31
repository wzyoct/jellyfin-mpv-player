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
  SeasonId?: string
  ParentId?: string
  SeriesPrimaryImageTag?: string
  ImageTags?: Record<string, string>
  BackdropImageTags?: string[]
  ParentBackdropItemId?: string
  ParentBackdropImageTags?: string[]
  ParentThumbItemId?: string
  ParentThumbImageTag?: string
  LocationType?: 'FileSystem' | 'Remote' | 'Virtual' | string
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

export interface MpvValidationResult {
  valid: boolean
  path: string
  version?: string
  message: string
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
  seriesId?: string
}

export interface ImageRequest {
  itemId: string
  imageType?: 'Primary' | 'Backdrop' | 'Thumb'
  tag?: string
  maxWidth?: number
}

export type PlaybackPhase = 'idle' | 'preparing' | 'playing' | 'paused' | 'switching' | 'stopping' | 'stopped' | 'error'

export interface AudioPreference {
  index?: number
  language?: string
  title?: string
}

export interface SubtitlePreference {
  index?: number
  disabled?: boolean
}

export interface StartPlaybackRequest {
  itemId: string
  startTimeTicks?: number
  mediaSourceId?: string
  audioPreference?: AudioPreference
  subtitlePreference?: SubtitlePreference
}

export interface PlaybackCommand {
  sessionId: string
  command: 'pause' | 'resume' | 'previous' | 'next' | 'stop' | 'stop-after-current'
}

export interface PlaybackQueueItem {
  itemId: string
  name: string
  type: string
  seriesName?: string
  seriesId?: string
  seasonId?: string
  seasonNumber?: number
  episodeNumber?: number
  runtimeTicks?: number
}

export interface PlaybackSnapshot {
  sessionId?: string
  revision: number
  phase: PlaybackPhase
  queue: PlaybackQueueItem[]
  currentIndex: number
  positionTicks: number
  durationTicks?: number
  currentItemId?: string
  isPaused?: boolean
  endReason?: string
  syncError?: string
  message?: string
}

export interface PlaybackEvent extends PlaybackSnapshot {
  type: 'snapshot' | 'item-finalized' | 'progress' | 'sync-error' | 'error'
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
  PlaylistIndex?: number
  PlaylistLength?: number
  EventName?: 'TimeUpdate' | 'Pause' | 'Unpause' | 'VolumeChange' | 'RepeatModeChange' | 'AudioTrackChange' | 'SubtitleTrackChange' | 'PlaylistItemMove' | 'PlaylistItemRemove' | 'PlaylistItemAdd' | 'QualityChange' | 'SubtitleOffsetChange' | 'PlaybackRateChange'
  QueueableMediaTypes?: string[]
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
  getNextUp(seriesId?: string): Promise<ItemResult>
  getSeriesEpisodes(seriesId: string): Promise<EmbyItem[]>
  getImage(request: ImageRequest): Promise<string>
  validateMpvPath(path?: string): Promise<MpvValidationResult>
  testMpvPath(path?: string): Promise<MpvValidationResult>
  openLogDirectory(): Promise<void>
  playbackStart(request: StartPlaybackRequest): Promise<PlaybackSnapshot>
  playbackCommand(request: PlaybackCommand): Promise<PlaybackSnapshot>
  getPlaybackSnapshot(): Promise<PlaybackSnapshot>
  onPlaybackChanged(callback: (event: PlaybackEvent) => void): () => void
}
