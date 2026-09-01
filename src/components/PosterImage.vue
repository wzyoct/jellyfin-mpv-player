<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Film, ImageOff } from 'lucide-vue-next'
import { resolveBackdropSources, resolvePosterSources, type PosterSource } from '../posterSource'
import type { MediaItem } from '../types'

const IMAGE_REQUEST_TIMEOUT_MS = 20_000

const props = withDefaults(defineProps<{
  item: MediaItem
  variant?: 'poster' | 'backdrop'
  eager?: boolean
  maxWidth?: number
  source?: PosterSource
  sources?: PosterSource[]
}>(), {
  variant: 'poster',
  eager: false,
})

const emit = defineEmits<{
  loaded: [url: string]
  failed: []
}>()

const imageRoot = ref<HTMLElement | null>(null)
const imageUrl = ref('')
const loading = ref(true)
const loadStarted = ref(false)
const imageCandidates = ref<PosterSource[]>([])
const activeCandidateIndex = ref(-1)
let loadRequestId = 0
let observer: IntersectionObserver | undefined

async function loadImage(): Promise<void> {
  const requestId = ++loadRequestId
  loading.value = true
  imageUrl.value = ''
  activeCandidateIndex.value = -1
  const candidates = props.variant === 'backdrop'
    ? await buildBackdropCandidates()
    : props.sources?.length ? props.sources : props.source ? [props.source] : resolvePosterSources(props.item)
  if (requestId !== loadRequestId) return
  imageCandidates.value = candidates
  if (!candidates.length) {
    loading.value = false
    return
  }
  await loadCandidate(requestId, 0)
}

async function buildBackdropCandidates(): Promise<PosterSource[]> {
  const ancestors: MediaItem[] = []
  const seasonId = props.item.SeasonId || (props.item.Type === 'Episode' ? props.item.ParentId : undefined)
  if (seasonId && seasonId !== props.item.Id) {
    try {
      ancestors.push(await window.mediaServer.getItem(seasonId))
    } catch {
      // The inherited parent metadata remains available when the season request fails.
    }
  }
  const seriesId = props.item.SeriesId || (props.item.Type === 'Season' ? props.item.ParentId : undefined)
  if (seriesId && seriesId !== props.item.Id && seriesId !== seasonId) {
    try {
      ancestors.push(await window.mediaServer.getItem(seriesId))
    } catch {
      // The item's own primary image remains the final fallback.
    }
  }
  return resolveBackdropSources(props.item, ancestors)
}

async function loadCandidate(requestId: number, index: number): Promise<void> {
  if (requestId !== loadRequestId) return
  const candidate = imageCandidates.value[index]
  if (!candidate?.itemId) {
    loading.value = false
    emit('failed')
    return
  }
  activeCandidateIndex.value = index
  try {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const nextImageUrl = await Promise.race([
      window.mediaServer.getImage({
        itemId: candidate.itemId,
        imageType: candidate.imageType,
        tag: candidate.tag,
        maxWidth: props.maxWidth || (props.variant === 'backdrop' ? 1280 : 480),
      }),
      new Promise<string>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('图片请求超时')), IMAGE_REQUEST_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId)
    })
    if (!nextImageUrl) throw new Error('图片地址为空')
    if (requestId === loadRequestId) imageUrl.value = nextImageUrl
  } catch {
    await loadCandidate(requestId, index + 1)
    return
  }
}

function handleImageError(): void {
  if (!imageUrl.value) return
  imageUrl.value = ''
  const nextIndex = activeCandidateIndex.value + 1
  if (nextIndex < imageCandidates.value.length) {
    loading.value = true
    void loadCandidate(loadRequestId, nextIndex)
  } else {
    loading.value = false
    emit('failed')
  }
}

function handleImageLoaded(): void {
  if (!imageUrl.value) return
  loading.value = false
  emit('loaded', imageUrl.value)
}

function startLoading(): void {
  if (loadStarted.value) return
  loadStarted.value = true
  void loadImage()
}

function resetImage(): void {
  loadRequestId += 1
  loadStarted.value = false
  imageUrl.value = ''
  imageCandidates.value = []
  loading.value = true
  if (props.eager || !('IntersectionObserver' in window)) {
    startLoading()
  } else if (imageRoot.value) {
    observer?.observe(imageRoot.value)
  }
}

onMounted(() => {
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect()
        startLoading()
      }
    }, { rootMargin: '320px 0px' })
    if (imageRoot.value) observer.observe(imageRoot.value)
  }
  if (props.eager || !observer) startLoading()
})

onUnmounted(() => observer?.disconnect())
watch(() => [
  props.item.Id,
  props.variant,
  props.item.ImageTags?.Primary,
  props.item.BackdropImageTags?.[0],
  props.item.ParentBackdropItemId,
  props.item.ParentBackdropImageTags?.[0],
  props.item.SeasonId,
  props.item.ParentId,
  props.item.SeriesId,
  props.item.SeriesPrimaryImageTag,
  props.source?.itemId,
  props.source?.tag,
  props.sources?.map((source) => `${source.itemId}:${source.imageType}:${source.tag || ''}`).join('|'),
  props.eager,
], resetImage)
</script>

<template>
  <div ref="imageRoot" class="poster-image" :class="[`poster-image--${variant}`, { 'is-loading': loading, 'has-image': imageUrl }]">
    <img v-if="imageUrl" :src="imageUrl" :alt="item.Name" @load="handleImageLoaded" @error="handleImageError" />
    <div v-else class="poster-placeholder">
      <ImageOff v-if="!loading" :size="variant === 'backdrop' ? 32 : 24" stroke-width="1.4" />
      <Film v-else :size="variant === 'backdrop' ? 32 : 24" stroke-width="1.4" />
      <span v-if="variant === 'backdrop' && !loading">暂无背景图</span>
    </div>
  </div>
</template>
