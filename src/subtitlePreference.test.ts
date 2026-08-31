import { describe, expect, it } from 'vitest'
import { chooseDefaultSubtitle } from './subtitlePreference'
import type { MediaStream } from './types'

function subtitle(index: number, options: Partial<MediaStream> = {}): MediaStream {
  return { Type: 'Subtitle', Index: index, ...options }
}

describe('chooseDefaultSubtitle', () => {
  it('always prioritizes simplified Chinese, with external tracks first', () => {
    expect(chooseDefaultSubtitle([
      subtitle(0, { Language: 'en', IsDefault: true }),
      subtitle(1, { Language: 'zh-CN', IsExternal: true }),
    ])).toBe(1)
  })

  it('prefers embedded simplified Chinese over external non-Chinese subtitles', () => {
    expect(chooseDefaultSubtitle([
      subtitle(2, { Language: 'zh-Hans', IsExternal: false }),
      subtitle(3, { Language: 'en', IsExternal: true }),
    ])).toBe(2)
  })

  it('prefers other Chinese before a non-Chinese default', () => {
    expect(chooseDefaultSubtitle([
      subtitle(4, { Language: 'en', IsDefault: true }),
      subtitle(5, { Language: 'zh' }),
    ])).toBe(5)
  })

  it('prefers simplified Chinese over traditional Chinese', () => {
    expect(chooseDefaultSubtitle([
      subtitle(9, { Language: 'zh-Hant', IsExternal: true }),
      subtitle(10, { Language: 'zh-CN' }),
    ])).toBe(10)
  })

  it('falls back to the server default when no Chinese subtitle exists', () => {
    expect(chooseDefaultSubtitle([
      subtitle(7, { Language: 'en' }),
      subtitle(8, { Language: 'ja', IsDefault: true }),
    ])).toBe(8)
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
