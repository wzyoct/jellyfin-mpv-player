import { describe, expect, it } from 'vitest'
import { chooseDefaultSubtitle, isChineseSubtitle, isExternalSubtitle, isSelectableSubtitle, isSimplifiedChineseSubtitle } from './subtitlePreference'
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

  it('prefers the first external subtitle over embedded Chinese subtitles', () => {
    expect(chooseDefaultSubtitle([
      subtitle(2, { Language: 'zh-Hans', IsExternal: false }),
      subtitle(3, { Language: 'en', IsExternal: true }),
    ])).toBe(3)
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
    ])).toBe(9)
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

  it('returns undefined when no suitable subtitle is available', () => {
    expect(chooseDefaultSubtitle([{ Type: 'Audio', Index: 0 }])).toBeUndefined()
    expect(chooseDefaultSubtitle([subtitle(6, { Language: 'ja' })])).toBeUndefined()
  })

  it('recognizes language codes, labels and external subtitle flags', () => {
    expect(isChineseSubtitle(subtitle(1, { Language: 'zh_TW' }))).toBe(true)
    expect(isChineseSubtitle(subtitle(2, { DisplayTitle: 'Mandarin' }))).toBe(true)
    expect(isChineseSubtitle(subtitle(3, { Language: 'en', Title: 'English' }))).toBe(false)
    expect(isSimplifiedChineseSubtitle(subtitle(4, { Language: 'zh_SG' }))).toBe(true)
    expect(isSimplifiedChineseSubtitle(subtitle(5, { Title: 'Simplified' }))).toBe(true)
    expect(isSimplifiedChineseSubtitle(subtitle(6, { Language: 'zh-TW', Title: '繁体' }))).toBe(false)
    expect(isExternalSubtitle(subtitle(7, { IsExternalUrl: true }))).toBe(true)
    expect(isExternalSubtitle(subtitle(8, { DeliveryMethod: 'External' }))).toBe(true)
    expect(isExternalSubtitle(subtitle(8))).toBe(false)
    expect(isSelectableSubtitle(subtitle(9, { DeliveryMethod: 'Encode' }))).toBe(false)
    expect(isSelectableSubtitle(subtitle(10, { DeliveryMethod: 'External' }))).toBe(true)
  })
})
