import { describe, expect, it } from 'vitest'
import { isResumePositionReached, resolveResumeTicks, shouldAdvanceAfterEnd } from './playbackLogic'
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

  it('advances only on a natural end outside a transition', () => {
    const input = { stopAfterCurrent: false, currentIndex: 0, queueLength: 2, transitioning: false }
    expect(shouldAdvanceAfterEnd({ ...input, reason: 'eof' })).toBe(true)
    expect(shouldAdvanceAfterEnd({ ...input, reason: 'quit' })).toBe(false)
    expect(shouldAdvanceAfterEnd({ ...input, reason: 'eof', transitioning: true })).toBe(false)
    expect(shouldAdvanceAfterEnd({ ...input, reason: 'eof', stopAfterCurrent: true })).toBe(false)
    expect(shouldAdvanceAfterEnd({ ...input, reason: 'eof', currentIndex: 1 })).toBe(false)
  })
})
