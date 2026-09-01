import { describe, expect, it } from 'vitest'
import { formatPlaybackLoadError, type PlaybackLoadDiagnostic } from './playbackError'

const diagnostic: PlaybackLoadDiagnostic = {
  status: 403,
  contentType: 'text/plain',
  redirects: 1,
  rangeRequested: true,
  requiredHeaders: true,
  phase: 'response',
  source: 'upstream',
}

describe('playback load errors', () => {
  it('maps an observed upstream status to a Chinese error with the media name', () => {
    expect(formatPlaybackLoadError('钢铁侠', 'loading failed', diagnostic, 'error')).toBe('《钢铁侠》加载失败：媒体服务器返回 HTTP 403')
  })

  it('explains a failed redirected resource without leaking the raw MPV message', () => {
    expect(formatPlaybackLoadError('第一集', 'loading failed', {
      ...diagnostic,
      status: 302,
      phase: 'redirect',
      source: 'redirect',
    }, 'error')).toBe('《第一集》加载失败：重定向后的媒体地址无法加载')
  })

  it('preserves a useful non-generic MPV error', () => {
    expect(formatPlaybackLoadError('本地媒体', 'unsupported codec', undefined, 'error')).toBe('《本地媒体》加载失败：unsupported codec')
  })
})
