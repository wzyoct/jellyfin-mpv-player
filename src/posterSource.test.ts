import { describe, expect, it } from 'vitest'
import { resolveBackdropSources, resolvePosterSource, resolvePosterSources } from './posterSource'
import type { MediaItem } from './types'

describe('resolvePosterSource', () => {
  it('uses the movie primary image by default', () => {
    const movie: MediaItem = {
      Id: 'movie-1',
      Name: 'Movie',
      Type: 'Movie',
      ImageTags: { Primary: 'movie-tag' },
    }

    expect(resolvePosterSource(movie)).toEqual({ itemId: 'movie-1', imageType: 'Primary', tag: 'movie-tag' })
  })

  it('uses the series primary image for an episode in series mode', () => {
    const episode: MediaItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      SeriesId: 'series-1',
      SeriesPrimaryImageTag: 'series-tag',
      ImageTags: { Primary: 'episode-tag' },
    }

    expect(resolvePosterSource(episode, 'series')).toEqual({ itemId: 'series-1', imageType: 'Primary', tag: 'series-tag' })
  })

  it('orders series poster fallbacks before the episode thumbnail', () => {
    const episode: MediaItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      SeriesId: 'series-1',
      SeasonId: 'season-1',
      SeriesPrimaryImageTag: 'series-tag',
      ImageTags: { Primary: 'episode-tag' },
      ParentThumbItemId: 'series-1',
      ParentThumbImageTag: 'thumb-tag',
    }

    expect(resolvePosterSources(episode, 'series')).toEqual([
      { itemId: 'series-1', imageType: 'Primary', tag: 'series-tag' },
      { itemId: 'season-1', imageType: 'Primary' },
      { itemId: 'episode-1', imageType: 'Primary', tag: 'episode-tag' },
      { itemId: 'series-1', imageType: 'Thumb', tag: 'thumb-tag' },
    ])
  })

  it('deduplicates a parent thumbnail that points to the series', () => {
    const episode: MediaItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      SeriesId: 'series-1',
      ParentThumbItemId: 'series-1',
    }

    expect(resolvePosterSources(episode, 'series')).toEqual([
      { itemId: 'series-1', imageType: 'Primary' },
      { itemId: 'episode-1', imageType: 'Primary' },
      { itemId: 'series-1', imageType: 'Thumb' },
    ])
  })

  it('keeps the episode image when series metadata is unavailable', () => {
    const episode: MediaItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      ImageTags: { Primary: 'episode-tag' },
    }

    expect(resolvePosterSource(episode, 'series')).toEqual({ itemId: 'episode-1', imageType: 'Primary', tag: 'episode-tag' })
  })

  it('orders episode backdrop, season backdrop, series backdrop, then series poster', () => {
    const episode: MediaItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      SeriesId: 'series-1',
      SeasonId: 'season-1',
      BackdropImageTags: ['episode-backdrop'],
      ParentBackdropItemId: 'series-1',
      ParentBackdropImageTags: ['inherited-series-backdrop'],
      SeriesPrimaryImageTag: 'series-poster',
    }
    const season: MediaItem = {
      Id: 'season-1',
      Name: 'Season 1',
      Type: 'Season',
      BackdropImageTags: ['season-backdrop'],
    }
    const series: MediaItem = {
      Id: 'series-1',
      Name: 'Series',
      Type: 'Series',
      BackdropImageTags: ['series-backdrop'],
      ImageTags: { Primary: 'series-primary' },
    }

    expect(resolveBackdropSources(episode, [season, series])).toEqual([
      { itemId: 'episode-1', imageType: 'Backdrop', tag: 'episode-backdrop' },
      { itemId: 'season-1', imageType: 'Backdrop', tag: 'season-backdrop' },
      { itemId: 'series-1', imageType: 'Backdrop', tag: 'inherited-series-backdrop' },
      { itemId: 'series-1', imageType: 'Backdrop', tag: 'series-backdrop' },
      { itemId: 'series-1', imageType: 'Primary', tag: 'series-primary' },
    ])
  })

  it('uses the series poster when all backdrop candidates are missing', () => {
    const series: MediaItem = {
      Id: 'series-1',
      Name: 'Series',
      Type: 'Series',
      ImageTags: { Primary: 'series-primary' },
    }

    expect(resolveBackdropSources(series)).toEqual([
      { itemId: 'series-1', imageType: 'Backdrop', tag: undefined },
      { itemId: 'series-1', imageType: 'Primary', tag: 'series-primary' },
    ])
  })

  it('keeps known image owners even when Emby omits image tags', () => {
    const episode: MediaItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      SeriesId: 'series-1',
      SeasonId: 'season-1',
      ImageTags: { Primary: 'episode-primary' },
    }
    const season: MediaItem = { Id: 'season-1', Name: 'Season 1', Type: 'Season' }
    const series: MediaItem = { Id: 'series-1', Name: 'Series', Type: 'Series', ImageTags: { Primary: 'series-primary' } }

    expect(resolveBackdropSources(episode, [season, series])).toEqual([
      { itemId: 'episode-1', imageType: 'Backdrop', tag: undefined },
      { itemId: 'season-1', imageType: 'Backdrop', tag: undefined },
      { itemId: 'series-1', imageType: 'Backdrop', tag: undefined },
      { itemId: 'series-1', imageType: 'Primary', tag: 'series-primary' },
    ])
  })
})
