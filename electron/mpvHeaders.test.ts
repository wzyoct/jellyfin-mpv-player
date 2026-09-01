import { describe, expect, it } from 'vitest'
import { buildMpvHttpHeaders } from './mpvHeaders'
import type { MediaSourceInfo } from './emby'

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
})
