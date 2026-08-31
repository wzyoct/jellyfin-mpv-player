import type { MediaSourceInfo } from './emby'

export function buildMpvHttpHeaders(source: MediaSourceInfo, token: string): string[] {
  const headers: Record<string, string> = {
    ...(source.RequiredHttpHeaders || {}),
    'X-MediaBrowser-Token': token,
  }
  return Object.entries(headers)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${value}`)
}
