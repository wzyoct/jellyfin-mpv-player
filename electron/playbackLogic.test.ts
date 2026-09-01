import { describe, expect, it } from 'vitest'
import { isResumePositionReached, resolveResumeTicks } from './playbackLogic'
import type { EmbyItem } from '../src/types'

function episode(userData?: EmbyItem['UserData']): EmbyItem {
  return { Id: 'episode-1', Name: 'Episode', Type: 'Episode', UserData: userData }
}

describe('playback logic', () => {
  it('uses fresh server progress and resets played items', () => {
    expect(resolveResumeTicks(episode({ PlaybackPositionTicks: 600_000_000 }))).toBe(600_000_000)
    expect(resolveResumeTicks(episode({ PlaybackPositionTicks: 600_000_000, Played: true }))).toBe(0)
    expect(resolveResumeTicks(episode({ PlaybackPositionTicks: 600_000_000 }), 120_000_000)).toBe(120_000_000)
  })

  it('requires MPV to report the requested resume position within tolerance', () => {
    expect(isResumePositionReached(602, 600)).toBe(true)
    expect(isResumePositionReached(603, 600)).toBe(false)
    expect(isResumePositionReached(null, 600)).toBe(false)
  })

})
