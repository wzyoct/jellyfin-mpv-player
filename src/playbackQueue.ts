import type { MediaItem } from './types'

export interface EpisodeQueuePlan {
  items: MediaItem[]
  startIndex: number
}

export function compareEpisodes(left: MediaItem, right: MediaItem): number {
  const season = (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0)
  if (season) return season
  const episode = (left.IndexNumber ?? Number.MAX_SAFE_INTEGER) - (right.IndexNumber ?? Number.MAX_SAFE_INTEGER)
  return episode || left.Name.localeCompare(right.Name)
}

export function buildEpisodeQueue(items: MediaItem[], selected: MediaItem): EpisodeQueuePlan {
  const ordered = items.filter((item) => item.LocationType?.toLowerCase() !== 'virtual').sort(compareEpisodes)
  const selectedSeason = selected.ParentIndexNumber ?? 0
  const candidates = selectedSeason === 0
    ? ordered.filter((item) => (item.ParentIndexNumber ?? 0) === 0)
    : ordered.filter((item) => (item.ParentIndexNumber ?? 0) > 0)
  const queue = candidates.some((item) => item.Id === selected.Id) ? candidates : [...candidates, selected].sort(compareEpisodes)
  const startIndex = Math.max(0, queue.findIndex((item) => item.Id === selected.Id))
  return { items: queue, startIndex }
}
