import { describe, expect, it } from 'vitest'
import { buildEpisodeQueue } from './playbackQueue'
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
