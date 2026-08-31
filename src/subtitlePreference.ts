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

export function isExternalSubtitle(stream: MediaStream): boolean {
  return Boolean(stream.IsExternal || stream.IsExternalUrl)
}

function preferredFrom(candidates: MediaStream[]): MediaStream | undefined {
  return candidates.find((stream) => isChineseSubtitle(stream) && stream.IsDefault)
    || candidates.find(isChineseSubtitle)
    || candidates.find((stream) => stream.IsDefault)
    || candidates[0]
}

export function chooseDefaultSubtitle(streams: MediaStream[]): number | undefined {
  const subtitles = streams.filter((stream) => stream.Type === 'Subtitle' && typeof stream.Index === 'number')
  if (!subtitles.length) return undefined

  const external = subtitles.filter(isExternalSubtitle)
  const preferred = external.length ? preferredFrom(external) : preferredFrom(subtitles.filter(isChineseSubtitle))
  return preferred?.Index
}
