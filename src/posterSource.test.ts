import { describe, expect, it } from 'vitest'
import { resolveBackdropSources, resolvePosterSource } from './posterSource'
import type { EmbyItem } from './types'

describe('resolvePosterSource', () => {
  it('uses the movie primary image by default', () => {
    const movie: EmbyItem = {
      Id: 'movie-1',
      Name: 'Movie',
      Type: 'Movie',
      ImageTags: { Primary: 'movie-tag' },
    }

    expect(resolvePosterSource(movie)).toEqual({ itemId: 'movie-1', imageType: 'Primary', tag: 'movie-tag' })
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

    expect(resolvePosterSource(episode, 'series')).toEqual({ itemId: 'series-1', imageType: 'Primary', tag: 'series-tag' })
  })

  it('keeps the episode image when series metadata is unavailable', () => {
    const episode: EmbyItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      ImageTags: { Primary: 'episode-tag' },
    }

    expect(resolvePosterSource(episode, 'series')).toEqual({ itemId: 'episode-1', imageType: 'Primary', tag: 'episode-tag' })
  })

  it('orders episode backdrop, season backdrop, series backdrop, then series poster', () => {
    const episode: EmbyItem = {
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
    const season: EmbyItem = {
      Id: 'season-1',
      Name: 'Season 1',
      Type: 'Season',
      BackdropImageTags: ['season-backdrop'],
    }
    const series: EmbyItem = {
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
    const series: EmbyItem = {
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
    const episode: EmbyItem = {
      Id: 'episode-1',
      Name: 'Episode',
      Type: 'Episode',
      SeriesId: 'series-1',
      SeasonId: 'season-1',
      ImageTags: { Primary: 'episode-primary' },
    }
    const season: EmbyItem = { Id: 'season-1', Name: 'Season 1', Type: 'Season' }
    const series: EmbyItem = { Id: 'series-1', Name: 'Series', Type: 'Series', ImageTags: { Primary: 'series-primary' } }

    expect(resolveBackdropSources(episode, [season, series])).toEqual([
      { itemId: 'episode-1', imageType: 'Backdrop', tag: undefined },
      { itemId: 'season-1', imageType: 'Backdrop', tag: undefined },
      { itemId: 'series-1', imageType: 'Backdrop', tag: undefined },
      { itemId: 'series-1', imageType: 'Primary', tag: 'series-primary' },
    ])
  })
})
