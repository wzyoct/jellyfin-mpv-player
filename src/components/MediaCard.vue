<script setup lang="ts">
import { computed } from 'vue'
import PosterImage from './PosterImage.vue'
import type { EmbyItem } from '../types'

const props = withDefaults(defineProps<{
  item: EmbyItem
  showProgress?: boolean
}>(), {
  showProgress: true,
})

defineEmits<{
  select: [item: EmbyItem]
}>()

const progress = computed(() => {
  const position = props.item.UserData?.PlaybackPositionTicks || 0
  if (!props.item.RunTimeTicks || !position) return 0
  return Math.min(100, Math.round((position / props.item.RunTimeTicks) * 100))
})

const subtitle = computed(() => {
  if (props.item.SeriesName) return props.item.SeriesName
  if (props.item.ProductionYear) return String(props.item.ProductionYear)
  if (props.item.Type === 'Movie') return '电影'
  if (props.item.Type === 'Series') return '剧集'
  return props.item.Type
})
</script>

<template>
  <button class="poster-card" type="button" :aria-label="`打开 ${item.Name}`" @click="$emit('select', item)">
    <PosterImage :item="item" />
    <span v-if="showProgress && progress" class="poster-progress"><span :style="{ width: `${progress}%` }"></span></span>
    <span class="poster-info"><strong>{{ item.Name }}</strong><small>{{ subtitle }}</small></span>
  </button>
</template>
