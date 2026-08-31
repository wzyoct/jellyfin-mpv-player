<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Film, ImageOff } from 'lucide-vue-next'
import { resolvePosterSource, type PosterSource } from '../posterSource'
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
let loadRequestId = 0
let observer: IntersectionObserver | undefined

async function loadImage(): Promise<void> {
  const requestId = ++loadRequestId
  loading.value = true
  imageUrl.value = ''
  const imageType = props.variant === 'backdrop' ? 'Backdrop' : 'Primary'
  const source = props.variant === 'backdrop'
    ? { itemId: props.item.Id, tag: props.item.BackdropImageTags?.[0] }
    : props.source || resolvePosterSource(props.item)
  const tag = source.tag
  if (!tag) {
    loading.value = false
    return
  }
  try {
    const nextImageUrl = await window.emby.getImage({
      itemId: source.itemId,
      imageType,
      tag,
      maxWidth: props.variant === 'backdrop' ? 1280 : 480,
    })
    if (requestId === loadRequestId) imageUrl.value = nextImageUrl
  } catch {
    if (requestId === loadRequestId) imageUrl.value = ''
  } finally {
    if (requestId === loadRequestId) loading.value = false
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
  props.source?.itemId,
  props.source?.tag,
], resetImage)
</script>

<template>
  <div ref="imageRoot" class="poster-image" :class="[`poster-image--${variant}`, { 'is-loading': loading }]">
    <img v-if="imageUrl" :src="imageUrl" :alt="item.Name" @load="loading = false" @error="imageUrl = ''; loading = false" />
    <div v-else class="poster-placeholder">
      <ImageOff v-if="!loading" :size="variant === 'backdrop' ? 32 : 24" stroke-width="1.4" />
      <Film v-else :size="variant === 'backdrop' ? 32 : 24" stroke-width="1.4" />
      <span v-if="variant === 'backdrop' && !loading">暂无背景图</span>
    </div>
  </div>
</template>
