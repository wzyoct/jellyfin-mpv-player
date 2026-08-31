import { describe, expect, it } from 'vitest'
import { chooseDefaultSubtitle } from './subtitlePreference'
import type { MediaStream } from './types'

function subtitle(index: number, options: Partial<MediaStream> = {}): MediaStream {
  return { Type: 'Subtitle', Index: index, ...options }
}

describe('chooseDefaultSubtitle', () => {
  it('prefers an external Chinese subtitle over an internal default subtitle', () => {
    expect(chooseDefaultSubtitle([
      subtitle(0, { Language: 'en', IsDefault: true }),
      subtitle(1, { Language: 'zh-CN', IsExternal: true }),
    ])).toBe(1)
  })

  it('keeps external priority when only the external subtitle is not Chinese', () => {
    expect(chooseDefaultSubtitle([
      subtitle(2, { Language: 'zh', IsExternal: false }),
      subtitle(3, { Language: 'en', IsExternal: true }),
    ])).toBe(3)
  })

  it('prefers Chinese when there is no external subtitle', () => {
    expect(chooseDefaultSubtitle([
      subtitle(4, { Language: 'en', IsDefault: true }),
      subtitle(5, { DisplayTitle: '简体中文' }),
    ])).toBe(5)
  })

  it('supports a stream index of zero', () => {
    expect(chooseDefaultSubtitle([
      subtitle(0, { Language: 'zh-Hans', IsExternal: true }),
    ])).toBe(0)
  })

  it('returns undefined when no subtitle is available', () => {
    expect(chooseDefaultSubtitle([{ Type: 'Audio', Index: 0 }])).toBeUndefined()
    expect(chooseDefaultSubtitle([subtitle(6, { Language: 'ja' })])).toBeUndefined()
  })
})
