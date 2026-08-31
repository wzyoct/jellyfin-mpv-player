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
  return Boolean(stream.IsExternal || stream.IsExternalUrl)
}

export function chooseDefaultSubtitle(streams: MediaStream[]): number | undefined {
  const subtitles = streams.filter((stream) => stream.Type === 'Subtitle' && typeof stream.Index === 'number')
  if (!subtitles.length) return undefined

  const byLanguage = (predicate: (stream: MediaStream) => boolean): MediaStream[] => [
    ...subtitles.filter((stream) => isExternalSubtitle(stream) && predicate(stream)),
    ...subtitles.filter((stream) => !isExternalSubtitle(stream) && predicate(stream)),
  ]
  const preferred = [
    ...byLanguage(isSimplifiedChineseSubtitle),
    ...byLanguage((stream) => isChineseSubtitle(stream) && !isSimplifiedChineseSubtitle(stream)),
    ...subtitles.filter((stream) => stream.IsDefault),
  ][0]
  return preferred?.Index
}
