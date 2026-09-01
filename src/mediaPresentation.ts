import type { MediaItem } from './types'

export interface MediaPresentation {
  title: string
  subtitle: string
  ariaLabel: string
}

function hasNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function seasonLabel(item: MediaItem): string {
  return hasNumber(item.ParentIndexNumber) && item.ParentIndexNumber > 0
    ? `第 ${item.ParentIndexNumber} 季`
    : ''
}

function episodeLabel(item: MediaItem): string {
  const episode = hasNumber(item.IndexNumber) && item.IndexNumber > 0
    ? `第 ${item.IndexNumber} 集`
    : '单集'
  return item.ParentIndexNumber === 0 ? `特别篇 · ${episode}` : episode
}

function episodeName(item: MediaItem): string {
  const name = item.Name.trim()
  const label = episodeLabel(item)
  if (!name || name === label || name === '特别篇' || /^第\s*[\d一二三四五六七八九十百千万]+\s*集$/.test(name)) return label
  return `${label} - ${name}`
}

function typeSubtitle(item: MediaItem): string {
  if (item.Type === 'Movie') return item.ProductionYear ? `${item.ProductionYear} · 电影` : '电影'
  if (item.Type === 'Series') return item.ProductionYear ? `${item.ProductionYear} · 剧集` : '剧集'
  if (item.Type === 'Season') return hasNumber(item.IndexNumber) ? `第 ${item.IndexNumber} 季` : '季度'
  if (item.Type === 'Episode') {
    return [item.SeriesName, seasonLabel(item)].filter(Boolean).join(' · ') || '剧集'
  }
  return item.Type
}

export function itemTypeLabel(item: MediaItem): string {
  if (item.Type === 'Movie') return '电影'
  if (item.Type === 'Series') return '剧集'
  if (item.Type === 'Season') return hasNumber(item.IndexNumber) ? `第 ${item.IndexNumber} 季` : '季度'
  if (item.Type === 'Episode') return [seasonLabel(item), episodeLabel(item)].filter(Boolean).join(' · ')
  return item.Type
}

export function contextualItemLabel(item: MediaItem): string {
  return item.Type === 'Episode'
    ? [item.SeriesName, itemTypeLabel(item)].filter(Boolean).join(' · ')
    : itemTypeLabel(item)
}

export function mediaPresentation(item: MediaItem): MediaPresentation {
  const title = item.Type === 'Episode' ? episodeName(item) : item.Name
  const subtitle = typeSubtitle(item)
  const context = item.Type === 'Episode'
    ? [item.SeriesName, seasonLabel(item), item.Name && item.Name !== title ? item.Name : ''].filter(Boolean).join(' · ')
    : item.Name
  return {
    title,
    subtitle,
    ariaLabel: `打开 ${context || title}`,
  }
}
