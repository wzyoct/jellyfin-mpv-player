import type { EmbyItem } from '../src/types'

export function resolveResumeTicks(item: EmbyItem, explicitTicks?: number): number {
  if (explicitTicks !== undefined) return Math.max(0, explicitTicks)
  if (item.UserData?.Played) return 0
  return Math.max(0, item.UserData?.PlaybackPositionTicks || 0)
}

export function shouldAdvanceAfterEnd(input: {
  reason: string
  stopAfterCurrent: boolean
  currentIndex: number
  queueLength: number
  transitioning: boolean
}): boolean {
  return input.reason === 'eof'
    && !input.stopAfterCurrent
    && !input.transitioning
    && input.currentIndex + 1 < input.queueLength
}
