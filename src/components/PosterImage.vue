<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Film, ImageOff } from 'lucide-vue-next'
import { resolveBackdropSources, resolvePosterSource, type PosterSource } from '../posterSource'
import type { EmbyItem } from '../types'

const props = withDefaults(defineProps<{
  item: EmbyItem
  variant?: 'poster' | 'backdrop'
  eager?: boolean
  source?: PosterSource
}>(), {
  variant: 'poster',
  eager: false,
})

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
    : [props.source || resolvePosterSource(props.item)]
  imageCandidates.value = candidates
  if (!candidates.length) {
    loading.value = false
    return
  }
  await loadCandidate(requestId, 0)
}

async function buildBackdropCandidates(): Promise<PosterSource[]> {
  const ancestors: EmbyItem[] = []
  if (props.item.SeasonId) {
    try {
      ancestors.push(await window.emby.getItem(props.item.SeasonId))
    } catch {
      // The inherited parent metadata remains available when the season request fails.
    }
  }
  if (props.item.SeriesId && props.item.SeriesId !== props.item.Id) {
    try {
      ancestors.push(await window.emby.getItem(props.item.SeriesId))
    } catch {
      // The item's own primary image remains the final fallback.
    }
  }
  return resolveBackdropSources(props.item, ancestors)
}

async function loadCandidate(requestId: number, index: number): Promise<void> {
  if (requestId !== loadRequestId) return
  const candidate = imageCandidates.value[index]
  if (!candidate?.tag) {
    loading.value = false
    return
  }
  activeCandidateIndex.value = index
  try {
    const nextImageUrl = await window.emby.getImage({
      itemId: candidate.itemId,
      imageType: candidate.imageType,
      tag: candidate.tag,
      maxWidth: props.variant === 'backdrop' ? 1280 : 480,
    })
    if (requestId === loadRequestId) imageUrl.value = nextImageUrl
  } catch {
    await loadCandidate(requestId, index + 1)
    return
  }
  if (requestId === loadRequestId) loading.value = false
}

function handleImageError(): void {
  imageUrl.value = ''
  const nextIndex = activeCandidateIndex.value + 1
  if (nextIndex < imageCandidates.value.length) {
    loading.value = true
    void loadCandidate(loadRequestId, nextIndex)
  } else {
    loading.value = false
  }
}

function startLoading(): void {
  if (loadStarted.value) return
  loadStarted.value = true
  void loadImage()
}

function resetImage(): void {
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
  if (props.eager || !('IntersectionObserver' in window)) {
    startLoading()
    return
  }
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer?.disconnect()
      startLoading()
    }
  }, { rootMargin: '320px 0px' })
  if (imageRoot.value) observer.observe(imageRoot.value)
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
  props.item.SeriesId,
  props.item.SeriesPrimaryImageTag,
  props.source?.itemId,
  props.source?.tag,
], resetImage)
</script>

<template>
  <div ref="imageRoot" class="poster-image" :class="[`poster-image--${variant}`, { 'is-loading': loading, 'has-image': imageUrl }]">
    <img v-if="imageUrl" :src="imageUrl" :alt="item.Name" @load="loading = false" @error="handleImageError" />
    <div v-else class="poster-placeholder">
      <ImageOff v-if="!loading" :size="variant === 'backdrop' ? 32 : 24" stroke-width="1.4" />
      <Film v-else :size="variant === 'backdrop' ? 32 : 24" stroke-width="1.4" />
      <span v-if="variant === 'backdrop' && !loading">暂无背景图</span>
    </div>
  </div>
</template>
