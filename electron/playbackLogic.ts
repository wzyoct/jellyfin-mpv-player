import type { MediaItem } from '../src/types'

export function resolveResumeTicks(item: MediaItem, explicitTicks?: number): number {
  if (explicitTicks !== undefined) return Math.max(0, explicitTicks)
  if (item.UserData?.Played) return 0
  return Math.max(0, item.UserData?.PlaybackPositionTicks || 0)
}

export function isResumePositionReached(actual: unknown, targetSeconds: number, toleranceSeconds = 2): actual is number {
  return typeof actual === 'number'
    && Number.isFinite(actual)
    && Number.isFinite(targetSeconds)
    && Math.abs(actual - Math.max(0, targetSeconds)) <= Math.max(0.5, toleranceSeconds)
}
