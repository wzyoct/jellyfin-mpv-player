<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-vue-next'
import MediaCard from './MediaCard.vue'
import type { PosterMode } from '../posterSource'
import type { EmbyItem } from '../types'

const props = withDefaults(defineProps<{
  title: string
  items: EmbyItem[]
  count?: number
  loading?: boolean
  showProgress?: boolean
  emptyLabel?: string
  posterMode?: PosterMode
}>(), {
  count: undefined,
  loading: false,
  showProgress: true,
  emptyLabel: '暂无内容',
  posterMode: 'item',
})

defineEmits<{
  select: [item: EmbyItem]
}>()

const rail = ref<HTMLElement | null>(null)
const canScrollBack = ref(false)
const canScrollForward = ref(false)

function updateScrollState(): void {
  const element = rail.value
  if (!element) return
  const maxScrollLeft = element.scrollWidth - element.clientWidth
  canScrollBack.value = element.scrollLeft > 2
  canScrollForward.value = maxScrollLeft - element.scrollLeft > 2
}

function scrollRail(direction: -1 | 1): void {
  const element = rail.value
  if (!element) return
  element.scrollBy({ left: direction * element.clientWidth * 0.86, behavior: 'smooth' })
  window.setTimeout(updateScrollState, 260)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    scrollRail(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    scrollRail(1)
  }
}

onMounted(() => {
  rail.value?.addEventListener('scroll', updateScrollState, { passive: true })
  window.addEventListener('resize', updateScrollState)
  nextTick(updateScrollState)
})

onUnmounted(() => {
  rail.value?.removeEventListener('scroll', updateScrollState)
  window.removeEventListener('resize', updateScrollState)
})

watch(() => props.items, () => nextTick(updateScrollState), { deep: true })
</script>

<template>
  <section class="content-section media-rail-section">
    <div class="section-heading">
      <div>
        <h2>{{ title }}</h2>
        <span v-if="count !== undefined" class="section-count">{{ count }} 项</span>
      </div>
      <div class="rail-controls" role="group" :aria-label="`${title}滚动控制`">
        <button
          class="rail-arrow"
          type="button"
          :disabled="!canScrollBack"
          :aria-label="`向左浏览${title}`"
          :title="`向左浏览${title}`"
          @click="scrollRail(-1)"
          @keydown="handleKeydown"
        >
          <ChevronLeft :size="18" />
        </button>
        <button
          class="rail-arrow"
          type="button"
          :disabled="!canScrollForward"
          :aria-label="`向右浏览${title}`"
          :title="`向右浏览${title}`"
          @click="scrollRail(1)"
          @keydown="handleKeydown"
        >
          <ChevronRight :size="18" />
        </button>
      </div>
    </div>

    <div v-if="loading" class="rail-loading" aria-busy="true">
      <LoaderCircle class="spin" :size="18" />正在加载
    </div>
    <div v-else-if="items.length" ref="rail" class="poster-row" tabindex="0" @keydown="handleKeydown">
      <MediaCard
        v-for="(item, index) in items"
        :key="item.Id"
        :item="item"
        :show-progress="showProgress"
        :poster-mode="posterMode"
        :eager="index < 4"
        @select="$emit('select', $event)"
      />
    </div>
    <div v-else class="rail-empty">{{ emptyLabel }}</div>
  </section>
</template>
