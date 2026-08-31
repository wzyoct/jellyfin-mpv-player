import { describe, expect, it } from 'vitest'
import { contextualItemLabel, itemTypeLabel, mediaPresentation } from './mediaPresentation'
import type { EmbyItem } from './types'

function item(overrides: Partial<EmbyItem>): EmbyItem {
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
      title: '第 1 集',
      subtitle: '一人之下 · 第 1 季',
      ariaLabel: '打开 一人之下 · 第 1 季 · 一人之下第1集',
    })
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
      title: '单集',
      subtitle: '测试剧',
      ariaLabel: '打开 测试剧 · 未编号单集',
    })
  })
})
