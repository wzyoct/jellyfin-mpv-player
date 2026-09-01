import { describe, expect, it } from 'vitest'
import { buildEpisodeQueue, compareEpisodes } from './playbackQueue'
import type { EmbyItem } from './types'

function episode(id: string, season: number, number: number): EmbyItem {
  return { Id: id, Name: id, Type: 'Episode', ParentIndexNumber: season, IndexNumber: number }
}

describe('buildEpisodeQueue', () => {
  it('orders regular episodes across seasons from the selected episode', () => {
    const selected = episode('s1e2', 1, 2)
    const plan = buildEpisodeQueue([
      episode('s2e1', 2, 1),
      selected,
      episode('s1e1', 1, 1),
      episode('s2e2', 2, 2),
    ], selected)
    expect(plan.items.map((item) => item.Id)).toEqual(['s1e1', 's1e2', 's2e1', 's2e2'])
    expect(plan.startIndex).toBe(1)
  })

  it('does not mix season zero specials into regular seasons', () => {
    const selected = episode('s1e1', 1, 1)
    const plan = buildEpisodeQueue([
      episode('special', 0, 1),
      selected,
      episode('s2e1', 2, 1),
    ], selected)
    expect(plan.items.map((item) => item.Id)).toEqual(['s1e1', 's2e1'])
    expect(plan.startIndex).toBe(0)
  })

  it('keeps specials together when playback starts from season zero', () => {
    const selected = episode('special2', 0, 2)
    const plan = buildEpisodeQueue([
      episode('s1e1', 1, 1),
      episode('special1', 0, 1),
      selected,
    ], selected)
    expect(plan.items.map((item) => item.Id)).toEqual(['special1', 'special2'])
    expect(plan.startIndex).toBe(1)
  })

  it('starts at a middle episode while retaining earlier episodes for selection', () => {
    const selected = episode('s2e1', 2, 1)
    const plan = buildEpisodeQueue([
      episode('s1e1', 1, 1),
      selected,
      episode('s2e2', 2, 2),
      episode('s1e2', 1, 2),
    ], selected)
    expect(plan.items.map((item) => item.Id)).toEqual(['s1e1', 's1e2', 's2e1', 's2e2'])
    expect(plan.startIndex).toBe(2)
  })

  it('filters virtual episodes before building the native playlist', () => {
    const selected = episode('s1e1', 1, 1)
    const virtual = { ...episode('virtual', 1, 2), LocationType: 'Virtual' as const }
    const plan = buildEpisodeQueue([selected, virtual], selected)
    expect(plan.items.map((item) => item.Id)).toEqual(['s1e1'])
  })
})

describe('compareEpisodes', () => {
  it('orders missing episode numbers after numbered episodes and breaks ties by name', () => {
    const base = { Id: '1', Name: 'A', Type: 'Episode' as const, ParentIndexNumber: 1 }
    expect(compareEpisodes({ ...base, IndexNumber: 1 }, { ...base, IndexNumber: 2 })).toBeLessThan(0)
    expect(compareEpisodes({ ...base, Name: 'A' }, { ...base, Name: 'B' })).toBeLessThan(0)
    expect(compareEpisodes({ ...base, IndexNumber: undefined }, { ...base, IndexNumber: 2 })).toBeGreaterThan(0)
    expect(compareEpisodes({ ...base, ParentIndexNumber: 1 }, { ...base, ParentIndexNumber: 2 })).toBeLessThan(0)
  })
})
