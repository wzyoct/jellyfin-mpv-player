import { describe, expect, it } from 'vitest'
import { buildMpvHttpHeaders } from './mpvHeaders'
import type { MediaSourceInfo } from './mediaServer'

describe('buildMpvHttpHeaders', () => {
  it('returns native header entries without exposing a combined CLI string', () => {
    const source = {
      Id: 'source-1',
      RequiredHttpHeaders: { 'X-Required': 'yes' },
    } as MediaSourceInfo

    expect(buildMpvHttpHeaders(source, 'secret-token')).toEqual([
      'X-Required: yes',
      'X-MediaBrowser-Token: secret-token',
    ])
  })

  it('filters nullish required header values while always adding the token header', () => {
    const source = {
      Id: 'source-2',
      RequiredHttpHeaders: { Keep: 'value', Empty: undefined, Missing: null },
    } as unknown as MediaSourceInfo

    expect(buildMpvHttpHeaders(source, '')).toEqual(['Keep: value', 'X-MediaBrowser-Token: '])
  })

  it('uses standard Authorization for Jellyfin media requests', () => {
    const source = {
      Id: 'source-jellyfin',
      RequiredHttpHeaders: { 'X-Emby-Authorization': 'legacy', 'X-MediaBrowser-Token': 'legacy' },
    } as MediaSourceInfo
    const headers = buildMpvHttpHeaders(source, 'secret-token', 'jellyfin', 'device-1')
    expect(headers).toHaveLength(1)
    expect(headers[0]).toContain('Authorization: MediaBrowser')
    expect(headers[0]).toContain('Token="secret-token"')
    expect(headers[0]).not.toContain('X-MediaBrowser-Token')
  })
})
