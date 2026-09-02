import { describe, expect, it } from 'vitest'
import { normalizeResumeItems } from './resumeItems'
import type { MediaItem } from './types'

function item(id: string, type: MediaItem['Type'], options: Partial<MediaItem> = {}): MediaItem {
  return { Id: id, Name: id, Type: type, ...options }
}

describe('resume items', () => {
  it('sorts by recent playback and keeps the newest episode per series', () => {
    const items = [
      item('episode-1', 'Episode', { SeriesId: 'series-1', UserData: { LastPlayedDate: '2026-09-01T10:00:00Z' } }),
      item('movie-1', 'Movie', { UserData: { LastPlayedDate: '2026-09-02T10:00:00Z' } }),
      item('episode-2', 'Episode', { SeriesId: 'series-1', UserData: { LastPlayedDate: '2026-09-03T10:00:00Z' } }),
      item('movie-2', 'Movie', { UserData: { LastPlayedDate: '2026-09-02T09:00:00Z' } }),
    ]
    expect(normalizeResumeItems(items).map((entry) => entry.Id)).toEqual(['episode-2', 'movie-1', 'movie-2'])
    expect(items.map((entry) => entry.Id)).toEqual(['episode-1', 'movie-1', 'episode-2', 'movie-2'])
  })

  it('preserves server order for invalid, missing, or equal timestamps', () => {
    const items = [
      item('invalid', 'Movie', { UserData: { LastPlayedDate: 'invalid' } }),
      item('missing', 'Movie'),
      item('same-a', 'Movie', { UserData: { LastPlayedDate: '2026-09-01' } }),
      item('same-b', 'Movie', { UserData: { LastPlayedDate: '2026-09-01' } }),
    ]
    expect(normalizeResumeItems(items).map((entry) => entry.Id)).toEqual(['invalid', 'missing', 'same-a', 'same-b'])
  })

  it('does not merge episodes without a series id', () => {
    expect(normalizeResumeItems([
      item('episode-a', 'Episode'),
      item('episode-b', 'Episode'),
    ]).map((entry) => entry.Id)).toEqual(['episode-a', 'episode-b'])
  })
})
