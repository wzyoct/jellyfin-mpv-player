<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { Film, ImageOff } from 'lucide-vue-next'
import type { EmbyItem } from '../types'

const props = withDefaults(defineProps<{
  item: EmbyItem
  variant?: 'poster' | 'backdrop'
}>(), {
  variant: 'poster',
})

const imageUrl = ref('')
const loading = ref(true)
let loadRequestId = 0

async function loadImage(): Promise<void> {
  const requestId = ++loadRequestId
  loading.value = true
  imageUrl.value = ''
  const imageType = props.variant === 'backdrop' ? 'Backdrop' : 'Primary'
  const tag = props.variant === 'backdrop'
    ? props.item.BackdropImageTags?.[0]
    : props.item.ImageTags?.Primary
  if (!tag) {
    loading.value = false
    return
  }
  try {
    const nextImageUrl = await window.emby.getImage({
      itemId: props.item.Id,
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

onMounted(() => void loadImage())
watch(() => [props.item.Id, props.variant, props.item.ImageTags?.Primary, props.item.BackdropImageTags?.[0]], () => void loadImage())
</script>

<template>
  <div class="poster-image" :class="[`poster-image--${variant}`, { 'is-loading': loading }]">
    <img v-if="imageUrl" :src="imageUrl" :alt="item.Name" @load="loading = false" @error="imageUrl = ''; loading = false" />
    <div v-else class="poster-placeholder">
      <ImageOff v-if="!loading" :size="variant === 'backdrop' ? 32 : 24" stroke-width="1.4" />
      <Film v-else :size="variant === 'backdrop' ? 32 : 24" stroke-width="1.4" />
      <span v-if="variant === 'backdrop' && !loading">暂无背景图</span>
    </div>
  </div>
</template>
