import { describe, expect, it } from 'vitest'
import { resolvePosterSource } from './posterSource'
import type { EmbyItem } from './types'

describe('resolvePosterSource', () => {
  it('uses the movie primary image by default', () => {
    const movie: EmbyItem = {
      Id: 'movie-1',
      Name: 'Movie',
      Type: 'Movie',
      ImageTags: { Primary: 'movie-tag' },
    }

    expect(resolvePosterSource(movie)).toEqual({ itemId: 'movie-1', tag: 'movie-tag' })
  })

  it('uses the series primary image for an episode in series mode', () => {
    const episode: EmbyItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      SeriesId: 'series-1',
      SeriesPrimaryImageTag: 'series-tag',
      ImageTags: { Primary: 'episode-tag' },
    }

    expect(resolvePosterSource(episode, 'series')).toEqual({ itemId: 'series-1', tag: 'series-tag' })
  })

  it('keeps the episode image when series metadata is unavailable', () => {
    const episode: EmbyItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      ImageTags: { Primary: 'episode-tag' },
    }

    expect(resolvePosterSource(episode, 'series')).toEqual({ itemId: 'episode-1', tag: 'episode-tag' })
  })
})
