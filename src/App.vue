<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleUserRound,
  Clapperboard,
  Film,
  History,
  House,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Tv,
  Volume2,
  X,
} from 'lucide-vue-next'
import PosterImage from './components/PosterImage.vue'
import MediaCard from './components/MediaCard.vue'
import MediaRail from './components/MediaRail.vue'
import packageInfo from '../package.json'
import releaseNotesData from './data/release-notes.json'
import { chooseDefaultSubtitle, isExternalSubtitle, isChineseSubtitle } from './subtitlePreference'
import type {
  EmbyItem,
  EmbyView,
  MediaStream,
  MpvStatus,
  PlaybackInfo,
  PublicSettings,
  ItemsQuery,
  ReleaseNote,
} from './types'

type Page = 'home' | 'library' | 'settings' | 'updates'
type LibraryFilter = 'all' | 'Movie' | 'Series'

const appVersion = packageInfo.version
const releaseNotes = releaseNotesData as ReleaseNote[]
const currentRelease = computed(() => releaseNotes.find((release) => release.version === appVersion) || releaseNotes[0])

const settings = ref<PublicSettings | null>(null)
const appBooted = ref(false)
const isContentScrolled = ref(false)
const activePage = ref<Page>('home')
const activeFilter = ref<LibraryFilter>('all')
const views = ref<EmbyView[]>([])
const activeViewId = ref('')
const libraryItems = ref<EmbyItem[]>([])
const homeAllItems = ref<EmbyItem[]>([])
const homeMovieItems = ref<EmbyItem[]>([])
const homeShowItems = ref<EmbyItem[]>([])
const latestItems = ref<EmbyItem[]>([])
const recommendationItems = ref<EmbyItem[]>([])
const continueItems = ref<EmbyItem[]>([])
const searchResults = ref<EmbyItem[]>([])
const searchTerm = ref('')
const searchLoading = ref(false)
const searchError = ref('')
const selectedItem = ref<EmbyItem | null>(null)
const playbackInfo = ref<PlaybackInfo | null>(null)
const seasonItems = ref<EmbyItem[]>([])
const episodeItems = ref<EmbyItem[]>([])
const selectedAudio = ref<number | undefined>()
const selectedSubtitle = ref<number | undefined>()
const isLoading = ref(false)
const homeLoading = ref(false)
const libraryLoading = ref(false)
const isDetailLoading = ref(false)
const errorMessage = ref('')
const homeError = ref('')
const recommendationError = ref('')
const libraryError = ref('')
const notice = ref<{ message: string; kind: 'success' | 'error' } | null>(null)
const currentPlaybackId = ref('')
const currentPlaybackPosition = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)
const pageScroll = ref<HTMLElement | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let removeMpvListener: (() => void) | undefined
let homeRequestId = 0
let libraryRequestId = 0
let searchRequestId = 0
let heroTimer: ReturnType<typeof setInterval> | undefined

const form = reactive({
  serverUrl: 'http://127.0.0.1:8096',
  username: '',
  password: '',
  mpvPath: 'mpv.exe',
})

const isConnected = computed(() => Boolean(settings.value?.connected))
const activeView = computed(() => views.value.find((view) => view.Id === activeViewId.value) || views.value[0])
const heroItems = computed(() => recommendationItems.value.length ? recommendationItems.value : latestItems.value.slice(0, 8))
const heroIndex = ref(0)
const heroItem = computed(() => heroItems.value[heroIndex.value] || heroItems.value[0])
const heroLabel = computed(() => recommendationItems.value.length ? '电影推荐' : '最近加入')
const displayItems = computed(() => {
  return libraryItems.value
})
const selectedSource = computed(() => playbackInfo.value?.MediaSources?.[0])
const mediaStreams = computed<MediaStream[]>(() => {
  const sourceStreams = selectedSource.value?.MediaStreams
  return (sourceStreams?.length ? sourceStreams : selectedItem.value?.MediaStreams || []) as MediaStream[]
})
const audioStreams = computed(() => mediaStreams.value.filter((stream) => stream.Type === 'Audio'))
const subtitleStreams = computed(() => mediaStreams.value.filter((stream) => stream.Type === 'Subtitle'))
const selectedSubtitleStream = computed(() => subtitleStreams.value.find((stream) => stream.Index === selectedSubtitle.value))
const currentPlaybackItem = computed(() => {
  const all = [...libraryItems.value, ...latestItems.value, ...searchResults.value]
  return all.find((item) => item.Id === currentPlaybackId.value)
})

function formatRuntime(ticks?: number): string {
  if (!ticks) return ''
  const totalMinutes = Math.round(ticks / 10_000_000 / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`
}

function itemTypeLabel(item: EmbyItem): string {
  if (item.Type === 'Movie') return '电影'
  if (item.Type === 'Series') return '剧集'
  if (item.Type === 'Season') return `第 ${item.IndexNumber || 1} 季`
  if (item.Type === 'Episode') return `第 ${item.ParentIndexNumber || 1} 季 · 第 ${item.IndexNumber || 1} 集`
  return item.Type
}

function streamLabel(stream: MediaStream, kind: 'audio' | 'subtitle'): string {
  const name = stream.DisplayTitle || stream.Title || stream.DisplayLanguage || stream.Language
    || `${kind === 'audio' ? '音轨' : '字幕'} ${stream.Index ?? ''}`
  if (kind === 'subtitle') {
    const source = isExternalSubtitle(stream) ? '外挂' : '内嵌'
    return `${isChineseSubtitle(stream) ? '中文字幕' : name} · ${source}`
  }
  return name
}

function showNotice(message: string, kind: 'success' | 'error' = 'success'): void {
  notice.value = { message, kind }
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = null
  }, 4200)
}

function applySettings(next: PublicSettings): void {
  settings.value = next
  form.serverUrl = next.serverUrl
  form.username = next.username
  form.mpvPath = next.mpvPath || 'mpv.exe'
}

function viewSupportsFilter(view: EmbyView, filter: LibraryFilter): boolean {
  if (filter === 'all' || !view.CollectionType) return true
  const collectionType = view.CollectionType.toLowerCase()
  if (collectionType === 'mixed') return true
  if (filter === 'Movie') return collectionType === 'movies' || collectionType === 'movie'
  return collectionType === 'tvshows' || collectionType === 'tv' || collectionType === 'series'
}

function preferredViewId(filter: LibraryFilter): string {
  if (activeView.value && viewSupportsFilter(activeView.value, filter)) return activeView.value.Id
  return views.value.find((view) => viewSupportsFilter(view, filter))?.Id || views.value[0]?.Id || ''
}

async function loadAllItems(options: ItemsQuery): Promise<EmbyItem[]> {
  const items: EmbyItem[] = []
  let startIndex = 0
  let totalRecordCount = Number.POSITIVE_INFINITY
  let pageCount = 0
  while (startIndex < totalRecordCount && pageCount < 200) {
    const result = await window.emby.getItems({ ...options, startIndex, limit: 100 })
    items.push(...result.Items)
    totalRecordCount = result.TotalRecordCount
    if (!result.Items.length) break
    startIndex += result.Items.length
    pageCount += 1
  }
  return items
}

function uniqueItems(items: EmbyItem[]): EmbyItem[] {
  return [...new Map(items.map((item) => [item.Id, item])).values()]
}

function stopHeroAutoPlay(): void {
  if (heroTimer) clearInterval(heroTimer)
  heroTimer = undefined
}

function startHeroAutoPlay(): void {
  stopHeroAutoPlay()
  if (heroItems.value.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  heroTimer = setInterval(() => {
    heroIndex.value = (heroIndex.value + 1) % heroItems.value.length
  }, 8000)
}

function setHeroPaused(paused: boolean): void {
  if (paused) stopHeroAutoPlay()
  else startHeroAutoPlay()
}

function showHero(index: number): void {
  if (!heroItems.value.length) return
  heroIndex.value = (index + heroItems.value.length) % heroItems.value.length
  startHeroAutoPlay()
}

function showNextHero(): void {
  showHero(heroIndex.value + 1)
}

function showPreviousHero(): void {
  showHero(heroIndex.value - 1)
}

async function loadHome(): Promise<void> {
  if (!isConnected.value) return
  const requestId = ++homeRequestId
  homeLoading.value = true
  homeError.value = ''
  try {
    const nextViews = await window.emby.getViews()
    if (requestId !== homeRequestId) return
    views.value = nextViews
    if (!views.value.some((view) => view.Id === activeViewId.value)) {
      activeViewId.value = views.value[0]?.Id || ''
    }
    recommendationError.value = ''
    const [recommendations, latest, continued, allItems] = await Promise.all([
      window.emby.getMovieRecommendations().catch((error: unknown) => {
        recommendationError.value = error instanceof Error ? error.message : '读取电影推荐失败'
        return []
      }),
      window.emby.getItems({
        recursive: true,
        includeItemTypes: 'Movie,Series',
        sortBy: 'DateCreated',
        sortOrder: 'Descending',
        limit: 24,
      }),
      loadAllItems({
        recursive: true,
        includeItemTypes: 'Movie,Episode',
        filters: 'IsResumable',
        sortBy: 'DatePlayed',
        sortOrder: 'Descending',
      }),
      loadAllItems({
        recursive: true,
        includeItemTypes: 'Movie,Series',
        sortBy: 'SortName',
        sortOrder: 'Ascending',
      }),
    ])
    if (requestId !== homeRequestId) return
    latestItems.value = latest.Items
    recommendationItems.value = uniqueItems(recommendations.flatMap((category) => category.Items || []))
      .filter((item) => item.Type === 'Movie')
      .slice(0, 8)
    continueItems.value = uniqueItems(continued)
    homeAllItems.value = uniqueItems(allItems)
    homeMovieItems.value = homeAllItems.value.filter((item) => item.Type === 'Movie')
    homeShowItems.value = homeAllItems.value.filter((item) => item.Type === 'Series')
    libraryItems.value = homeAllItems.value
    heroIndex.value = 0
    startHeroAutoPlay()
  } catch (error) {
    if (requestId === homeRequestId) {
      homeError.value = error instanceof Error ? error.message : '加载 Emby 内容失败'
    }
  } finally {
    if (requestId === homeRequestId) homeLoading.value = false
  }
}

async function loadLibrary(viewId = activeViewId.value, filter = activeFilter.value): Promise<void> {
  if (!isConnected.value) return
  const resolvedViewId = viewId || preferredViewId(filter)
  const requestId = ++libraryRequestId
  activeViewId.value = resolvedViewId
  libraryLoading.value = true
  libraryError.value = ''
  try {
    const items: EmbyItem[] = []
    let startIndex = 0
    let totalRecordCount = Number.POSITIVE_INFINITY
    let pageCount = 0
    while (startIndex < totalRecordCount && pageCount < 200) {
      const result = await window.emby.getItems({
        parentId: resolvedViewId || undefined,
        recursive: true,
        includeItemTypes: filter === 'all' ? 'Movie,Series' : filter,
        sortBy: 'SortName',
        startIndex,
        limit: 100,
      })
      items.push(...result.Items)
      totalRecordCount = result.TotalRecordCount
      if (!result.Items.length) break
      startIndex += result.Items.length
      pageCount += 1
    }
    if (requestId !== libraryRequestId) return
    libraryItems.value = items
  } catch (error) {
    if (requestId === libraryRequestId) {
      libraryError.value = error instanceof Error ? error.message : '加载媒体库失败'
    }
  } finally {
    if (requestId === libraryRequestId) libraryLoading.value = false
  }
}

function goHome(): void {
  activePage.value = 'home'
  if ((!latestItems.value.length && !homeAllItems.value.length) || homeError.value) void loadHome()
}

function goLibrary(filter: LibraryFilter): void {
  activePage.value = 'library'
  activeFilter.value = filter
  void loadLibrary(preferredViewId(filter), filter)
}

function openSettings(): void {
  activePage.value = 'settings'
}

function openUpdates(): void {
  activePage.value = 'updates'
}

async function submitConnection(): Promise<void> {
  errorMessage.value = ''
  if (isConnected.value && !form.password.trim()) {
    try {
      applySettings(await window.emby.saveSettings({
        serverUrl: form.serverUrl,
        username: form.username,
        mpvPath: form.mpvPath,
      }))
      showNotice('设置已保存')
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '设置保存失败'
    }
    return
  }
  if (!form.serverUrl.trim() || !form.username.trim() || !form.password.trim()) {
    errorMessage.value = '服务器地址、用户名和密码不能为空'
    return
  }
  isLoading.value = true
  try {
    const result = await window.emby.login({
      serverUrl: form.serverUrl,
      username: form.username,
      password: form.password,
      mpvPath: form.mpvPath,
    })
    applySettings(result.settings)
    form.password = ''
    activePage.value = 'home'
    showNotice(`已连接到 Emby，欢迎回来，${result.user.Name}`)
    await loadHome()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '连接 Emby 失败'
  } finally {
    isLoading.value = false
  }
}

async function disconnect(): Promise<void> {
  try {
    applySettings(await window.emby.logout())
    views.value = []
    libraryItems.value = []
    homeAllItems.value = []
    homeMovieItems.value = []
    homeShowItems.value = []
    latestItems.value = []
    recommendationItems.value = []
    continueItems.value = []
    stopHeroAutoPlay()
    activePage.value = 'settings'
    showNotice('已断开 Emby 连接')
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '断开连接失败', 'error')
  }
}

async function performSearch(): Promise<void> {
  const term = searchTerm.value.trim()
  const requestId = ++searchRequestId
  if (term.length < 2 || !isConnected.value) {
    searchResults.value = []
    searchLoading.value = false
    searchError.value = ''
    return
  }
  searchLoading.value = true
  searchError.value = ''
  try {
    const result = await window.emby.getItems({
      searchTerm: term,
      recursive: true,
      includeItemTypes: 'Movie,Series,Episode',
      sortBy: 'SortName',
      limit: 36,
    })
    if (requestId === searchRequestId) searchResults.value = result.Items
  } catch (error) {
    if (requestId === searchRequestId) searchError.value = error instanceof Error ? error.message : '搜索失败'
  } finally {
    if (requestId === searchRequestId) searchLoading.value = false
  }
}

function focusSearch(): void {
  searchInput.value?.focus()
}

function handleKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    focusSearch()
  }
}

function handlePageScroll(): void {
  isContentScrolled.value = Boolean(pageScroll.value?.scrollTop)
}

watch(searchTerm, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void performSearch(), 360)
})

async function loadPlayableDetails(item: EmbyItem): Promise<void> {
  isDetailLoading.value = true
  try {
    playbackInfo.value = await window.emby.getPlaybackInfo(item.Id)
    const streams = (playbackInfo.value.MediaSources?.[0]?.MediaStreams || item.MediaStreams || []) as MediaStream[]
    selectedAudio.value = streams.find((stream) => stream.Type === 'Audio' && stream.IsDefault)?.Index
      ?? streams.find((stream) => stream.Type === 'Audio')?.Index
    selectedSubtitle.value = chooseDefaultSubtitle(streams)
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '读取播放信息失败', 'error')
  } finally {
    isDetailLoading.value = false
  }
}

async function openDetails(item: EmbyItem): Promise<void> {
  selectedItem.value = item
  playbackInfo.value = null
  seasonItems.value = []
  episodeItems.value = []
  selectedAudio.value = undefined
  selectedSubtitle.value = undefined
  isDetailLoading.value = true
  try {
    const detailed = await window.emby.getItem(item.Id)
    selectedItem.value = detailed
    if (detailed.Type === 'Series') {
      seasonItems.value = (await window.emby.getItems({
        parentId: detailed.Id,
        recursive: false,
        includeItemTypes: 'Season',
        sortBy: 'IndexNumber',
        limit: 100,
      })).Items
    } else if (detailed.Type === 'Season') {
      episodeItems.value = (await window.emby.getItems({
        parentId: detailed.Id,
        recursive: false,
        includeItemTypes: 'Episode',
        sortBy: 'IndexNumber',
        limit: 100,
      })).Items
    } else {
      await loadPlayableDetails(detailed)
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '读取媒体详情失败', 'error')
  } finally {
    isDetailLoading.value = false
  }
}

function closeDetails(): void {
  selectedItem.value = null
  playbackInfo.value = null
  seasonItems.value = []
  episodeItems.value = []
}

function resumePosition(item: EmbyItem): number {
  const position = item.UserData?.PlaybackPositionTicks || 0
  if (item.UserData?.Played) return 0
  return position
}

async function playSelected(): Promise<void> {
  const item = selectedItem.value
  if (!item || (item.Type !== 'Movie' && item.Type !== 'Episode')) return
  try {
    await window.emby.play({
      itemId: item.Id,
      mediaSourceId: selectedSource.value?.Id,
      audioStreamIndex: selectedAudio.value,
      subtitleStreamIndex: selectedSubtitle.value,
      startTimeTicks: resumePosition(item),
    })
    closeDetails()
    showNotice(`正在用 MPV 播放《${item.Name}》`)
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '启动 MPV 失败', 'error')
  }
}

async function stopPlayback(): Promise<void> {
  await window.emby.stop()
  currentPlaybackId.value = ''
}

function handleMpvStatus(status: MpvStatus): void {
  if (status.type === 'started') {
    currentPlaybackId.value = status.itemId || ''
  } else if (status.type === 'progress') {
    currentPlaybackPosition.value = status.positionTicks || 0
  } else if (status.type === 'stopped') {
    currentPlaybackId.value = ''
  } else if (status.type === 'error') {
    currentPlaybackId.value = ''
    showNotice(status.message || 'MPV 播放失败', 'error')
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  if (!window.emby) {
    errorMessage.value = '请通过 Ember Player 桌面应用启动此页面'
    activePage.value = 'settings'
    appBooted.value = true
    return
  }
  try {
    const saved = await window.emby.getSettings()
    applySettings(saved)
    appBooted.value = true
    removeMpvListener = window.emby.onMpvStatus(handleMpvStatus)
    if (saved.connected) {
      await loadHome()
    } else {
      activePage.value = 'settings'
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '读取本地设置失败'
    activePage.value = 'settings'
    appBooted.value = true
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (searchTimer) clearTimeout(searchTimer)
  if (noticeTimer) clearTimeout(noticeTimer)
  stopHeroAutoPlay()
  removeMpvListener?.()
})
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--standalone': !isConnected && appBooted, 'app-shell--booting': !appBooted }">
    <header v-if="isConnected" class="topbar" :class="{ 'topbar--scrolled': isContentScrolled }">
      <button class="brand" type="button" aria-label="返回首页" @click="goHome">
        <span class="brand-mark">E</span>
        <span class="brand-copy">EMBER<span>PLAYER</span></span>
      </button>

      <nav class="main-nav" aria-label="主导航">
        <button class="nav-item" :class="{ active: activePage === 'home' }" type="button" @click="goHome">
          <House :size="16" />
          <span>首页</span>
        </button>
        <button class="nav-item" :class="{ active: activePage === 'library' && activeFilter === 'Movie' }" type="button" @click="goLibrary('Movie')">
          <Film :size="16" />
          <span>电影</span>
        </button>
        <button class="nav-item" :class="{ active: activePage === 'library' && activeFilter === 'Series' }" type="button" @click="goLibrary('Series')">
          <Tv :size="16" />
          <span>剧集</span>
        </button>
        <button class="nav-item" :class="{ active: activePage === 'updates' }" type="button" @click="openUpdates">
          <History :size="16" />
          <span>更新</span>
        </button>
      </nav>

      <div class="topbar-actions">
        <label class="search-box" title="搜索媒体">
          <Search :size="18" />
          <input ref="searchInput" v-model="searchTerm" type="search" placeholder="搜索电影、剧集" />
          <kbd>Ctrl K</kbd>
        </label>
        <button class="icon-button" type="button" title="设置" @click="openSettings">
          <Settings2 :size="18" />
        </button>
        <button class="avatar-button" type="button" title="账户" @click="openSettings">
          <CircleUserRound :size="19" />
        </button>
      </div>
    </header>

    <main ref="pageScroll" class="page-content" :class="{ 'page-content--standalone': !isConnected && appBooted }" @scroll="handlePageScroll">
      <section v-if="!appBooted" class="boot-screen" aria-busy="true" aria-live="polite">
        <span class="brand-mark">E</span>
        <LoaderCircle class="spin" :size="22" />
        <span>正在准备 Ember Player</span>
      </section>

      <section v-else-if="!isConnected || activePage === 'settings'" class="settings-page">
        <div v-if="!isConnected" class="standalone-intro">
          <div class="brand standalone-brand">
            <span class="brand-mark">E</span>
            <span class="brand-copy">EMBER<span>PLAYER</span></span>
          </div>
          <p class="eyebrow">YOUR PERSONAL CINEMA</p>
          <h1>把你的片库，<br /><em>交给更好的播放器。</em></h1>
          <p class="intro-copy">连接 Emby，浏览完整媒体库，并用 MPV 播放每一个你真正想看的画面。</p>
        </div>

        <div class="settings-layout">
          <div class="settings-heading">
            <p class="eyebrow">CONNECTION</p>
            <h2>{{ isConnected ? '连接设置' : '连接你的 Emby' }}</h2>
            <p>填写 Emby 服务地址和账号，应用会在本机保存加密的登录令牌。</p>
          </div>
          <form class="settings-form" @submit.prevent="submitConnection">
            <label class="field-label" for="server-url">Emby 服务器地址</label>
            <input id="server-url" v-model="form.serverUrl" class="text-input" type="text" placeholder="http://192.168.1.100:8096" autocomplete="url" />
            <p class="field-hint">填写你在浏览器中访问 Emby 的服务根地址，例如 http://192.168.1.100:8096</p>

            <label class="field-label" for="username">用户名</label>
            <input id="username" v-model="form.username" class="text-input" type="text" autocomplete="username" />

            <label class="field-label" for="password">密码</label>
            <input id="password" v-model="form.password" class="text-input" type="password" :placeholder="isConnected ? '留空以保留当前连接' : '输入 Emby 密码'" autocomplete="current-password" />

            <label class="field-label" for="mpv-path">MPV 路径</label>
            <input id="mpv-path" v-model="form.mpvPath" class="text-input" type="text" placeholder="mpv.exe 或 C:\\Apps\\mpv\\mpv.exe" />
            <p class="field-hint">如果 mpv.exe 不在系统 PATH 中，请填写完整路径。</p>

            <div v-if="errorMessage" class="inline-error"><AlertCircle :size="16" />{{ errorMessage }}</div>
            <div class="settings-actions">
              <button v-if="isConnected" class="button button--ghost" type="button" @click="disconnect">
                <LogOut :size="17" />断开连接
              </button>
              <button class="button button--primary" type="submit" :disabled="isLoading">
                <LoaderCircle v-if="isLoading" class="spin" :size="17" />
                <Check v-else-if="isConnected && !form.password" :size="17" />
                <LogIn v-else :size="17" />
                {{ isConnected && !form.password ? '保存设置' : '连接 Emby' }}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section v-else-if="activePage === 'updates'" class="updates-page">
        <div class="updates-heading">
          <div>
            <p class="eyebrow">RELEASE NOTES</p>
            <h1>更新记录</h1>
            <p>按版本查看 Ember Player 的功能、优化与修复。</p>
          </div>
          <div class="current-version">
            <span>当前版本</span>
            <strong>v{{ appVersion }}</strong>
            <small>{{ currentRelease.date }}</small>
          </div>
        </div>

        <div class="release-timeline">
          <article
            v-for="release in releaseNotes"
            :key="release.version"
            class="release-entry"
            :class="{ 'release-entry--current': release.version === appVersion }"
          >
            <span class="release-marker" aria-hidden="true"></span>
            <div class="release-content">
              <div class="release-meta">
                <h2>v{{ release.version }}</h2>
                <time :datetime="release.date">{{ release.date }}</time>
                <span v-if="release.version === appVersion" class="release-tag">当前版本</span>
              </div>
              <p v-if="release.summary" class="release-summary">{{ release.summary }}</p>
              <div v-for="section in release.sections" :key="section.title" class="release-section">
                <h3>{{ section.title }}</h3>
                <ul>
                  <li v-for="item in section.items" :key="item">{{ item }}</li>
                </ul>
              </div>
            </div>
          </article>
        </div>
      </section>

      <template v-else-if="activePage === 'home'">
        <section
          v-if="heroItem"
          class="hero-section"
          @mouseenter="setHeroPaused(true)"
          @mouseleave="setHeroPaused(false)"
          @focusin="setHeroPaused(true)"
          @focusout="setHeroPaused(false)"
        >
           <Transition name="hero-fade" mode="out-in">
             <PosterImage :key="heroItem.Id" :item="heroItem" variant="backdrop" eager />
           </Transition>
          <div class="hero-overlay"></div>
          <div class="hero-content">
            <p class="eyebrow">{{ heroLabel }}</p>
            <h1>{{ heroItem.Name }}</h1>
            <div class="hero-meta">
              <span v-if="heroItem.ProductionYear">{{ heroItem.ProductionYear }}</span>
              <span v-if="heroItem.OfficialRating">{{ heroItem.OfficialRating }}</span>
              <span>{{ itemTypeLabel(heroItem) }}</span>
              <span v-if="heroItem.RunTimeTicks">{{ formatRuntime(heroItem.RunTimeTicks) }}</span>
            </div>
            <p class="hero-description">{{ heroItem.Overview || '打开详情，查看完整介绍与播放选项。' }}</p>
            <button class="button button--primary button--large" type="button" @click="openDetails(heroItem)">
              <Play :size="19" fill="currentColor" />查看详情
            </button>
          </div>
          <div v-if="heroItems.length > 1" class="hero-controls" role="group" aria-label="推荐轮播控制">
            <button class="hero-arrow" type="button" title="上一部推荐" aria-label="上一部推荐" @click="showPreviousHero"><ChevronRight :size="18" class="hero-arrow--previous" /></button>
            <div class="hero-dots" role="tablist" aria-label="选择推荐内容">
              <button
                v-for="(item, index) in heroItems"
                :key="item.Id"
                class="hero-dot"
                :class="{ active: index === heroIndex }"
                type="button"
                role="tab"
                :aria-selected="index === heroIndex"
                :aria-label="`第 ${index + 1} 部推荐：${item.Name}`"
                @click="showHero(index)"
              ></button>
            </div>
            <button class="hero-arrow" type="button" title="下一部推荐" aria-label="下一部推荐" @click="showNextHero"><ChevronRight :size="18" /></button>
          </div>
          <p v-if="recommendationError" class="hero-note">推荐暂时不可用，当前展示最近加入内容</p>
        </section>

        <div v-if="homeError" class="error-banner"><AlertCircle :size="18" />{{ homeError }}<button class="text-button" type="button" @click="loadHome">重试</button></div>
        <div v-if="homeLoading && !heroItem" class="loading-state"><LoaderCircle class="spin" :size="24" />正在加载媒体库</div>
        <div v-else-if="!homeLoading && !homeError && !heroItem" class="empty-state home-empty-state"><Clapperboard :size="32" /><h3>还没有可展示的内容</h3><p>请确认 Emby 媒体库已完成扫描，并检查当前账号权限。</p><button class="button button--ghost" type="button" @click="loadHome"><RefreshCw :size="16" />重新加载</button></div>

        <MediaRail v-if="continueItems.length" title="继续观看" :items="continueItems" @select="openDetails" />
        <MediaRail v-if="latestItems.length" title="最近加入" :items="latestItems" :show-progress="false" @select="openDetails" />

        <section v-if="homeAllItems.length" class="library-shelves">
          <div class="library-shelves-heading">
            <div><p class="eyebrow">YOUR LIBRARY</p><h2>完整媒体库</h2></div>
            <span class="section-count">{{ homeAllItems.length }} 项内容 · {{ views.length }} 个集合</span>
          </div>
          <MediaRail v-if="homeMovieItems.length" title="Movie · 电影" :items="homeMovieItems" :count="homeMovieItems.length" :show-progress="false" @select="openDetails" />
          <MediaRail v-if="homeShowItems.length" title="Show · 剧集" :items="homeShowItems" :count="homeShowItems.length" :show-progress="false" @select="openDetails" />
          <MediaRail title="All · 全部" :items="homeAllItems" :count="homeAllItems.length" :show-progress="false" @select="openDetails" />
        </section>
      </template>

      <section v-else class="library-page">
        <div class="library-page-heading">
           <div><p class="eyebrow">{{ activeView?.Name || 'YOUR LIBRARY' }}</p><h1>{{ activeFilter === 'Movie' ? '电影' : activeFilter === 'Series' ? '剧集' : '全部内容' }}</h1><span class="library-count">{{ displayItems.length }} 项</span></div>
          <div class="library-controls">
            <select v-model="activeViewId" class="select-input" aria-label="选择媒体库" @change="loadLibrary()">
              <option v-for="view in views" :key="view.Id" :value="view.Id">{{ view.Name }}</option>
            </select>
            <button class="icon-button" type="button" title="刷新媒体库" @click="loadLibrary()"><RefreshCw :size="17" /></button>
          </div>
        </div>
        <div v-if="libraryError" class="error-banner"><AlertCircle :size="18" />{{ libraryError }}<button class="text-button" type="button" @click="loadLibrary()">重试</button></div>
        <div v-if="libraryLoading" class="loading-state"><LoaderCircle class="spin" :size="24" />正在加载媒体库</div>
        <div v-else-if="displayItems.length" class="poster-grid">
          <MediaCard v-for="item in displayItems" :key="item.Id" :item="item" @select="openDetails" />
        </div>
        <div v-else class="empty-state"><Clapperboard :size="32" /><h3>这里还没有内容</h3><p>请检查媒体库权限或刷新连接。</p><button class="button button--ghost" type="button" @click="loadLibrary()"><RefreshCw :size="16" />重新加载</button></div>
      </section>
    </main>

    <div v-if="searchTerm.trim().length >= 2 && isConnected" class="search-drawer">
      <div class="search-drawer-inner">
        <div class="search-drawer-heading"><span>搜索结果</span><button class="icon-button" type="button" title="关闭搜索" @click="searchTerm = ''"><X :size="18" /></button></div>
        <div v-if="searchLoading" class="search-empty search-state"><LoaderCircle class="spin" :size="17" />正在搜索</div>
        <div v-else-if="searchError" class="search-empty search-state search-state--error"><AlertCircle :size="17" />{{ searchError }}<button class="text-button" type="button" @click="performSearch">重试</button></div>
        <div v-else-if="!searchResults.length" class="search-empty">没有找到匹配内容</div>
        <div v-else class="search-results">
          <button v-for="item in searchResults" :key="item.Id" class="search-result" type="button" @click="openDetails(item)">
            <div class="search-result-art"><PosterImage :item="item" /></div>
            <span><strong>{{ item.Name }}</strong><small>{{ item.ProductionYear || '' }} · {{ itemTypeLabel(item) }}</small></span>
            <ChevronRight :size="16" />
          </button>
        </div>
      </div>
    </div>

    <div v-if="currentPlaybackId" class="playback-bar">
      <div class="playback-bar-copy"><span class="playing-dot"></span><span>正在播放</span><strong>{{ currentPlaybackItem?.Name || 'MPV' }}</strong></div>
      <span class="playback-time">{{ Math.round(currentPlaybackPosition / 10_000_000 / 60) }} 分钟</span>
      <button class="icon-button icon-button--small" type="button" title="停止播放并同步进度" @click="stopPlayback"><X :size="16" /></button>
    </div>

    <div v-if="notice" class="toast" :class="`toast--${notice.kind}`"><Check v-if="notice.kind === 'success'" :size="17" /><AlertCircle v-else :size="17" />{{ notice.message }}</div>

    <div v-if="selectedItem" class="modal-backdrop" @click.self="closeDetails">
      <section class="detail-modal" role="dialog" aria-modal="true" :aria-label="selectedItem.Name">
        <button class="modal-close icon-button" type="button" title="关闭详情" @click="closeDetails"><X :size="20" /></button>
        <div class="detail-art"><PosterImage :item="selectedItem" variant="backdrop" eager /><div class="detail-art-fade"></div></div>
        <div class="detail-body">
          <p class="eyebrow">{{ itemTypeLabel(selectedItem) }}</p>
          <h2>{{ selectedItem.Name }}</h2>
          <div class="detail-meta"><span v-if="selectedItem.ProductionYear">{{ selectedItem.ProductionYear }}</span><span v-if="selectedItem.OfficialRating">{{ selectedItem.OfficialRating }}</span><span v-if="selectedItem.RunTimeTicks">{{ formatRuntime(selectedItem.RunTimeTicks) }}</span><span v-if="selectedItem.CommunityRating">评分 {{ selectedItem.CommunityRating.toFixed(1) }}</span></div>
          <p class="detail-overview">{{ selectedItem.Overview || '暂无简介。' }}</p>

          <div v-if="seasonItems.length" class="detail-subsection"><h3>选择季度</h3><div class="season-list"><button v-for="season in seasonItems" :key="season.Id" class="season-button" type="button" @click="openDetails(season)"><PosterImage :item="season" /><span>{{ season.Name }}</span><ChevronRight :size="16" /></button></div></div>
          <div v-if="episodeItems.length" class="detail-subsection"><h3>分集</h3><div class="episode-list"><button v-for="episode in episodeItems" :key="episode.Id" class="episode-button" type="button" @click="openDetails(episode)"><span class="episode-number">{{ String(episode.IndexNumber || 0).padStart(2, '0') }}</span><span><strong>{{ episode.Name }}</strong><small>{{ formatRuntime(episode.RunTimeTicks) }}</small></span><ChevronRight :size="16" /></button></div></div>

          <div v-if="selectedItem.Type === 'Movie' || selectedItem.Type === 'Episode'" class="detail-actions">
            <div v-if="isDetailLoading" class="loading-inline"><LoaderCircle class="spin" :size="18" />读取播放选项</div>
            <template v-else>
              <label v-if="audioStreams.length" class="track-select"><Volume2 :size="16" /><select v-model="selectedAudio" aria-label="选择音轨"><option :value="undefined">默认音轨</option><option v-for="stream in audioStreams" :key="stream.Index" :value="stream.Index">{{ streamLabel(stream, 'audio') }}</option></select></label>
              <label v-if="subtitleStreams.length" class="track-select"><Menu :size="16" /><select v-model="selectedSubtitle" aria-label="选择字幕"><option :value="undefined">关闭字幕</option><option v-for="stream in subtitleStreams" :key="stream.Index" :value="stream.Index">{{ streamLabel(stream, 'subtitle') }}{{ stream.Index === selectedSubtitleStream?.Index ? '（当前）' : '' }}</option></select></label>
              <button class="button button--primary button--large" type="button" :disabled="isDetailLoading" @click="playSelected"><Play :size="18" fill="currentColor" />{{ resumePosition(selectedItem) ? '继续播放' : '播放' }}</button>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
