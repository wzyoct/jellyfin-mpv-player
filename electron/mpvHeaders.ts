import { buildMediaServerAuthorization } from './mediaServer'
import type { MediaSourceInfo, MediaServerKind } from '../src/types'

export function buildMpvHttpHeaders(source: MediaSourceInfo, token: string, kind: MediaServerKind = 'emby', deviceId = 'ember-player'): string[] {
  const headers: Record<string, string> = { ...(source.RequiredHttpHeaders || {}) }
  if (kind === 'jellyfin') {
    for (const key of Object.keys(headers)) {
      if (/^(?:x[-_]emby[-_]|x[-_]mediabrowser[-_]token$)/i.test(key)) delete headers[key]
    }
    headers.Authorization = buildMediaServerAuthorization(kind, token, deviceId)
  } else headers['X-MediaBrowser-Token'] = token
  return Object.entries(headers)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${value}`)
}
