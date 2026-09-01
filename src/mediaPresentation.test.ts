import { describe, expect, it } from 'vitest'
import { contextualItemLabel, itemTypeLabel, mediaPresentation } from './mediaPresentation'
import type { MediaItem } from './types'

function item(overrides: Partial<MediaItem>): MediaItem {
  return { Id: 'item-1', Name: '默认名称', Type: 'Movie', ...overrides }
}

describe('mediaPresentation', () => {
  it('keeps movie names as the primary title', () => {
    expect(mediaPresentation(item({ Name: '沙丘2', ProductionYear: 2024 }))).toEqual({
      title: '沙丘2',
      subtitle: '2024 · 电影',
      ariaLabel: '打开 沙丘2',
    })
  })

  it('prioritizes episode number and keeps series context', () => {
    expect(mediaPresentation(item({
      Name: '一人之下第1集',
      Type: 'Episode',
      SeriesName: '一人之下',
      ParentIndexNumber: 1,
      IndexNumber: 1,
    }))).toEqual({
      title: '第 1 集 - 一人之下第1集',
      subtitle: '一人之下 · 第 1 季',
      ariaLabel: '打开 一人之下 · 第 1 季 · 一人之下第1集',
    })
  })

  it('puts the episode name after its season and episode label', () => {
    const episode = item({
      Name: '不平则鸣',
      Type: 'Episode',
      SeriesName: '剑来',
      ParentIndexNumber: 1,
      IndexNumber: 3,
    })
    expect(mediaPresentation(episode).title).toBe('第 3 集 - 不平则鸣')
    expect(mediaPresentation(episode).subtitle).toBe('剑来 · 第 1 季')
    expect(contextualItemLabel(episode)).toBe('剑来 · 第 1 季 · 第 3 集')
  })

  it('labels specials without inventing a season', () => {
    const special = item({ Type: 'Episode', Name: '特别篇', SeriesName: '测试剧', ParentIndexNumber: 0, IndexNumber: 2 })
    expect(mediaPresentation(special).title).toBe('特别篇 · 第 2 集')
    expect(mediaPresentation(special).subtitle).toBe('测试剧')
    expect(itemTypeLabel(special)).toBe('特别篇 · 第 2 集')
    expect(contextualItemLabel(special)).toBe('测试剧 · 特别篇 · 第 2 集')
  })

  it('uses explicit missing-data labels', () => {
    const episode = item({ Type: 'Episode', Name: '未编号单集', SeriesName: '测试剧' })
    expect(mediaPresentation(episode)).toEqual({
      title: '单集 - 未编号单集',
      subtitle: '测试剧',
      ariaLabel: '打开 测试剧 · 未编号单集',
    })
  })

  it('handles movies, series, seasons and unknown item types without metadata', () => {
    expect(mediaPresentation(item({ Type: 'Movie', Name: '无年份电影' })).subtitle).toBe('电影')
    expect(mediaPresentation(item({ Type: 'Series', Name: '剧集' })).subtitle).toBe('剧集')
    expect(mediaPresentation(item({ Type: 'Season', Name: '季度', IndexNumber: 2 })).subtitle).toBe('第 2 季')
    expect(mediaPresentation(item({ Type: 'Season', Name: '季度' })).subtitle).toBe('季度')
    expect(mediaPresentation(item({ Type: 'Documentary', Name: '纪录片' })).subtitle).toBe('Documentary')
    expect(itemTypeLabel(item({ Type: 'Documentary', Name: '纪录片' }))).toBe('Documentary')
  })

  it('does not duplicate an already normalized episode name', () => {
    const numbered = item({ Type: 'Episode', Name: '第 3 集', ParentIndexNumber: 1, IndexNumber: 3 })
    expect(mediaPresentation(numbered).title).toBe('第 3 集')
    const unnamed = item({ Type: 'Episode', Name: '   ', ParentIndexNumber: 0, IndexNumber: 0 })
    expect(mediaPresentation(unnamed).title).toBe('特别篇 · 单集')
  })
})
