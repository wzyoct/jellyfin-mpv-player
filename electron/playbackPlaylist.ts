import type { PlaybackQueueItem } from '../src/types'

export interface PlaylistEntrySource {
  item: PlaybackQueueItem
  url: string
}

export function formatPlaylistTitle(item: PlaybackQueueItem): string {
  if (item.type !== 'Episode') return item.name.replace(/[\r\n]+/g, ' ').trim()
  const season = item.seasonNumber ?? 0
  const episode = item.episodeNumber
  const prefix = episode === undefined ? `S${String(season).padStart(2, '0')}` : `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
  return `${prefix} · ${item.name}`.replace(/[\r\n]+/g, ' ').trim()
}

export function buildM3u(entries: PlaylistEntrySource[]): string {
  const lines = ['#EXTM3U']
  for (const entry of entries) {
    lines.push(`#EXTINF:-1,${formatPlaylistTitle(entry.item)}`, entry.url)
  }
  return `${lines.join('\n')}\n`
}

export function buildHexPlaylistUrl(entries: PlaylistEntrySource[]): string {
  return `hex://${Buffer.from(buildM3u(entries), 'utf8').toString('hex')}`
}

export function headerSignature(headers: string[]): string {
  return headers.map((header) => header.trim()).filter(Boolean).sort((left, right) => left.localeCompare(right)).join('\n')
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const run = async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => run()))
  return results
}
