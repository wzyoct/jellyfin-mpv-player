import { describe, expect, it } from 'vitest'
import { buildHexPlaylistUrl, buildM3u, formatPlaylistTitle, headerSignature, mapWithConcurrency } from './playbackPlaylist'

describe('playback playlist', () => {
  it('writes stable episode titles and an in-memory hex playlist', () => {
    const entries = [{ item: { itemId: '1', name: '试播\n集', type: 'Episode', seasonNumber: 1, episodeNumber: 2 }, url: 'http://server/video/1' }]
    expect(formatPlaylistTitle({ itemId: '1', name: '试播', type: 'Episode', seasonNumber: 1, episodeNumber: 2 })).toBe('S01E02 · 试播')
    expect(formatPlaylistTitle({ itemId: 'movie', name: '电影', type: 'Movie' })).toBe('电影')
    expect(buildM3u(entries)).toContain('#EXTINF:-1,S01E02 · 试播 集')
    const url = buildHexPlaylistUrl(entries)
    expect(url.startsWith('hex://')).toBe(true)
    expect(url).not.toContain('X-MediaBrowser-Token')
    expect(Buffer.from(url.slice(6), 'hex').toString('utf8')).toContain('#EXTM3U')
  })

  it('normalizes header signatures and bounds concurrent work', async () => {
    expect(headerSignature(['B: 2', 'A: 1'])).toBe(headerSignature(['A: 1', 'B: 2']))
    let active = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return value * 2
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('handles empty playlists and clamps invalid concurrency limits', async () => {
    expect(buildM3u([])).toBe('#EXTM3U\n')
    expect(buildHexPlaylistUrl([])).toBe(`hex://${Buffer.from('#EXTM3U\n').toString('hex')}`)
    await expect(mapWithConcurrency([], 0, async () => 1)).resolves.toEqual([])
    await expect(mapWithConcurrency([1, 2], -1, async (value) => value)).resolves.toEqual([1, 2])
  })
})
