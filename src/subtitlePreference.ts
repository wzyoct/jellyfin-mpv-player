import type { MediaStream } from './types'

const chineseLanguageCodes = new Set([
  'zh',
  'zho',
  'chi',
  'cmn',
  'zh-cn',
  'zh-sg',
  'zh-tw',
  'zh-hk',
  'zh-hans',
  'zh-hant',
])

const simplifiedChineseLanguageCodes = new Set(['zh-cn', 'zh-sg', 'zh-hans'])

function normalized(value?: string): string {
  return value?.trim().toLowerCase().replace(/_/g, '-') || ''
}

export function isChineseSubtitle(stream: MediaStream): boolean {
  const language = normalized(stream.Language || stream.DisplayLanguage)
  if (chineseLanguageCodes.has(language)) return true
  const labels = [stream.DisplayTitle, stream.Title, stream.DisplayLanguage, stream.Language]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return /中文|简体|繁体|chinese|mandarin|\bchs\b|\bcht\b/.test(labels)
}

export function isSimplifiedChineseSubtitle(stream: MediaStream): boolean {
  const language = normalized(stream.Language || stream.DisplayLanguage)
  if (simplifiedChineseLanguageCodes.has(language)) return true
  const labels = [stream.DisplayTitle, stream.Title, stream.DisplayLanguage, stream.Language]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return /简体|\bchs\b|simplified/.test(labels)
}

export function isExternalSubtitle(stream: MediaStream): boolean {
  return Boolean(stream.IsExternal || stream.IsExternalUrl || normalized(stream.DeliveryMethod) === 'external')
}

export function isSelectableSubtitle(stream: MediaStream): boolean {
  return stream.Type === 'Subtitle' && normalized(stream.DeliveryMethod) !== 'encode' && typeof stream.Index === 'number'
}

export function chooseDefaultSubtitle(streams: MediaStream[]): number | undefined {
  const subtitles = streams.filter(isSelectableSubtitle)
  if (!subtitles.length) return undefined

  const external = subtitles.filter(isExternalSubtitle)
  const candidates = external.length ? external : subtitles
  const preferred = [
    ...candidates.filter(isSimplifiedChineseSubtitle),
    ...candidates.filter((stream) => isChineseSubtitle(stream) && !isSimplifiedChineseSubtitle(stream)),
    ...candidates.filter((stream) => stream.IsDefault),
    ...(external.length ? candidates : []),
  ][0]
  return preferred?.Index
}
