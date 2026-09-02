import type { MediaItem } from './types'

function resumeGroupKey(item: MediaItem): string {
  return item.Type === 'Episode' && item.SeriesId ? `series:${item.SeriesId}` : `item:${item.Id}`
}

function playedAt(item: MediaItem): number | undefined {
  const value = item.UserData?.LastPlayedDate
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

export function normalizeResumeItems(items: MediaItem[]): MediaItem[] {
  const sorted = items
    .map((item, index) => ({ item, index, timestamp: playedAt(item) }))
    .sort((left, right) => {
      if (left.timestamp === undefined || right.timestamp === undefined || left.timestamp === right.timestamp) return left.index - right.index
      return right.timestamp - left.timestamp
    })
  const seen = new Set<string>()
  return sorted.filter(({ item }) => {
    const key = resumeGroupKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(({ item }) => item)
}

export function promoteResumeItem(items: MediaItem[], item: MediaItem): MediaItem[] {
  const index = items.findIndex((candidate) => resumeGroupKey(candidate) === resumeGroupKey(item))
  if (index <= 0) return items
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)]
}
