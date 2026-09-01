<script setup lang="ts">
import { computed } from 'vue'
import PosterImage from './PosterImage.vue'
import { resolvePosterSources, type PosterMode } from '../posterSource'
import { mediaPresentation } from '../mediaPresentation'
import type { EmbyItem } from '../types'

const props = withDefaults(defineProps<{
  item: EmbyItem
  showProgress?: boolean
  eager?: boolean
  posterMode?: PosterMode
}>(), {
  showProgress: true,
  eager: false,
  posterMode: 'item',
})

defineEmits<{
  select: [item: EmbyItem]
}>()

const progress = computed(() => {
  const position = props.item.UserData?.PlaybackPositionTicks || 0
  if (!props.item.RunTimeTicks || !position) return 0
  return Math.min(100, Math.round((position / props.item.RunTimeTicks) * 100))
})

const posterSources = computed(() => resolvePosterSources(props.item, props.posterMode))
const presentation = computed(() => mediaPresentation(props.item))
</script>

<template>
  <button class="poster-card" type="button" :aria-label="presentation.ariaLabel" @click="$emit('select', item)">
    <span class="poster-art">
      <PosterImage :item="item" :sources="posterSources" :eager="eager" />
      <span
        v-if="showProgress && progress"
        class="poster-progress"
        role="progressbar"
        aria-label="观看进度"
        :aria-valuenow="progress"
        aria-valuemin="0"
        aria-valuemax="100"
      ><span :style="{ width: `${progress}%` }"></span></span>
    </span>
    <span class="poster-info"><strong>{{ presentation.title }}</strong><small>{{ presentation.subtitle }}</small></span>
  </button>
</template>
