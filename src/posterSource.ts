import type { EmbyItem } from './types'

export type PosterMode = 'item' | 'series'

export interface PosterSource {
  itemId: string
  imageType: 'Primary' | 'Backdrop' | 'Thumb'
  tag?: string
}

function addSource(sources: PosterSource[], source: PosterSource): void {
  if (!source.tag) return
  if (sources.some((candidate) => candidate.itemId === source.itemId && candidate.imageType === source.imageType && candidate.tag === source.tag)) return
  sources.push(source)
}

export function resolvePosterSource(item: EmbyItem, mode: PosterMode = 'item'): PosterSource {
  if (mode === 'series' && item.Type === 'Episode' && item.SeriesId) {
    return {
      itemId: item.SeriesId,
      imageType: 'Primary',
      tag: item.SeriesPrimaryImageTag,
    }
  }

  return {
    itemId: item.Id,
    imageType: 'Primary',
    tag: item.ImageTags?.Primary,
  }
}

export function resolveBackdropSources(item: EmbyItem, ancestors: EmbyItem[] = []): PosterSource[] {
  const sources: PosterSource[] = []
  addSource(sources, { itemId: item.Id, imageType: 'Backdrop', tag: item.BackdropImageTags?.[0] })

  const season = ancestors.find((ancestor) => ancestor.Type === 'Season')
  if (season) addSource(sources, { itemId: season.Id, imageType: 'Backdrop', tag: season.BackdropImageTags?.[0] })

  addSource(sources, {
    itemId: item.ParentBackdropItemId || '',
    imageType: 'Backdrop',
    tag: item.ParentBackdropImageTags?.[0],
  })

  const series = ancestors.find((ancestor) => ancestor.Type === 'Series')
  if (series) addSource(sources, { itemId: series.Id, imageType: 'Backdrop', tag: series.BackdropImageTags?.[0] })

  const primaryOwner = series || (item.Type === 'Series' ? item : undefined)
  addSource(sources, {
    itemId: primaryOwner?.Id || item.Id,
    imageType: 'Primary',
    tag: primaryOwner?.ImageTags?.Primary || item.SeriesPrimaryImageTag || item.ImageTags?.Primary,
  })
  return sources
}
