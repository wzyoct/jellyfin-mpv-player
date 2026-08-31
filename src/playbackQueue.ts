import type { EmbyItem } from './types'

export function compareEpisodes(left: EmbyItem, right: EmbyItem): number {
  const season = (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0)
  if (season) return season
  const episode = (left.IndexNumber ?? Number.MAX_SAFE_INTEGER) - (right.IndexNumber ?? Number.MAX_SAFE_INTEGER)
  return episode || left.Name.localeCompare(right.Name)
}

export function buildEpisodeQueue(items: EmbyItem[], selected: EmbyItem): EmbyItem[] {
  const ordered = [...items].sort(compareEpisodes)
  const selectedSeason = selected.ParentIndexNumber ?? 0
  const candidates = selectedSeason === 0
    ? ordered.filter((item) => (item.ParentIndexNumber ?? 0) === 0)
    : ordered.filter((item) => (item.ParentIndexNumber ?? 0) > 0)
  const startIndex = candidates.findIndex((item) => item.Id === selected.Id)
  return startIndex < 0 ? [selected] : [selected, ...candidates.slice(startIndex + 1)]
}
