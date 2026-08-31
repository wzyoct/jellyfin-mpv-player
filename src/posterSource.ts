import type { EmbyItem } from './types'

export type PosterMode = 'item' | 'series'

export interface PosterSource {
  itemId: string
  tag?: string
}

export function resolvePosterSource(item: EmbyItem, mode: PosterMode = 'item'): PosterSource {
  if (mode === 'series' && item.Type === 'Episode' && item.SeriesId) {
    return {
      itemId: item.SeriesId,
      tag: item.SeriesPrimaryImageTag,
    }
  }

  return {
    itemId: item.Id,
    tag: item.ImageTags?.Primary,
  }
}
