// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PosterImage from './PosterImage.vue'
import type { MediaItem } from '../types'

const item = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  Id: 'item-1',
  Name: '测试媒体',
  Type: 'Movie',
  ImageTags: { Primary: 'primary-1' },
  ...overrides,
})

describe('PosterImage', () => {
  const originalIntersectionObserver = window.IntersectionObserver

  beforeEach(() => {
    window.mediaServer = {
      getImage: vi.fn(),
      getItem: vi.fn(),
    } as unknown as Window['mediaServer']
  })

  afterEach(() => {
    window.IntersectionObserver = originalIntersectionObserver
    vi.restoreAllMocks()
  })

  it('loads an eager poster and emits the loaded URL', async () => {
    const getImage = vi.mocked(window.mediaServer.getImage)
    getImage.mockResolvedValue('data:image/jpeg;base64,poster')
    const loaded = vi.fn()
    const wrapper = mount(PosterImage, { props: { item: item(), eager: true, onLoaded: loaded } })

    await flushPromises()

    expect(getImage).toHaveBeenCalledWith({ itemId: 'item-1', imageType: 'Primary', tag: 'primary-1', maxWidth: 480 })
    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,poster')
    expect(wrapper.get('img').attributes('alt')).toBe('测试媒体')
    expect(loaded).not.toHaveBeenCalled()
    await wrapper.get('img').trigger('load')
    expect(loaded).toHaveBeenCalledTimes(1)
    expect(loaded).toHaveBeenCalledWith('data:image/jpeg;base64,poster')
  })

  it('uses an explicit maximum width when provided', async () => {
    const getImage = vi.mocked(window.mediaServer.getImage)
    getImage.mockResolvedValue('data:image/jpeg;base64,wide')
    mount(PosterImage, { props: { item: item(), eager: true, maxWidth: 3840 } })

    await flushPromises()

    expect(getImage).toHaveBeenCalledWith({ itemId: 'item-1', imageType: 'Primary', tag: 'primary-1', maxWidth: 3840 })
  })

  it('falls back from a missing series poster to the season poster', async () => {
    const getImage = vi.mocked(window.mediaServer.getImage)
    getImage.mockImplementation(async (request) => {
      if (request.itemId === 'series-1') throw new Error('series poster unavailable')
      return `data:image/jpeg;base64,${request.itemId}`
    })
    const wrapper = mount(PosterImage, {
      props: {
        item: item({ Type: 'Episode' }),
        sources: [
          { itemId: 'series-1', imageType: 'Primary', tag: 'series-tag' },
          { itemId: 'season-1', imageType: 'Primary' },
        ],
        eager: true,
      },
    })

    await flushPromises()

    expect(getImage.mock.calls.map(([request]) => request.itemId)).toEqual(['series-1', 'season-1'])
    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,season-1')
  })

  it('tries the next backdrop candidate when an earlier image fails', async () => {
    const getImage = vi.mocked(window.mediaServer.getImage)
    const season = item({ Id: 'season-1', Name: '第一季', Type: 'Season', BackdropImageTags: ['season-backdrop'] })
    const loaded = vi.fn()
    getImage.mockImplementation(async (request) => {
      if (request.itemId === 'item-1') throw new Error('item image unavailable')
      if (request.itemId === 'season-1') return 'data:image/jpeg;base64,season'
      return `data:image/jpeg;base64,${request.itemId}`
    })
    const getItem = vi.mocked(window.mediaServer.getItem)
    getItem.mockResolvedValue(season)
    const wrapper = mount(PosterImage, {
      props: {
        item: item({ Type: 'Episode', SeasonId: 'season-1', BackdropImageTags: ['episode-backdrop'] }),
        variant: 'backdrop',
        eager: true,
        onLoaded: loaded,
      },
    })

    await flushPromises()

    expect(getImage.mock.calls.map(([request]) => request.itemId)).toEqual(['item-1', 'season-1'])
    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,season')
    await wrapper.get('img').trigger('load')
    expect(loaded).toHaveBeenCalled()
  })

  it('emits failed and renders a placeholder after all candidates fail', async () => {
    const getImage = vi.mocked(window.mediaServer.getImage)
    getImage.mockRejectedValue(new Error('missing'))
    const failed = vi.fn()
    const wrapper = mount(PosterImage, { props: { item: item(), eager: true, onFailed: failed } })

    await flushPromises()

    expect(failed).toHaveBeenCalledTimes(1)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
    expect(wrapper.classes()).not.toContain('is-loading')
  })

  it('falls back after a browser image error and tolerates missing ancestors', async () => {
    const getImage = vi.mocked(window.mediaServer.getImage)
    getImage.mockResolvedValueOnce('data:image/jpeg;base64,first').mockResolvedValueOnce('data:image/jpeg;base64,parent')
    const getItem = vi.mocked(window.mediaServer.getItem)
    getItem.mockRejectedValue(new Error('ancestor unavailable'))
    const wrapper = mount(PosterImage, {
      props: {
        item: item({
          Type: 'Episode',
          SeasonId: 'season-1',
          SeriesId: 'series-1',
          BackdropImageTags: ['episode-backdrop'],
          ParentBackdropItemId: 'parent-1',
          ParentBackdropImageTags: ['parent-backdrop'],
        }),
        variant: 'backdrop',
        eager: true,
      },
    })
    await flushPromises()
    await wrapper.get('img').trigger('error')
    await flushPromises()

    expect(getItem).toHaveBeenCalledWith('season-1')
    expect(getItem).toHaveBeenCalledWith('series-1')
    expect(getImage.mock.calls.map(([request]) => request.itemId)).toEqual(['item-1', 'parent-1'])
    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,parent')
  })

  it('starts lazy loading when an intersecting entry arrives', async () => {
    let callback: IntersectionObserverCallback | undefined
    class FakeIntersectionObserver {
      constructor(next: IntersectionObserverCallback) {
        callback = next
      }

      disconnect = vi.fn()
      observe = vi.fn()
    }
    window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
    const getImage = vi.mocked(window.mediaServer.getImage)
    getImage.mockResolvedValue('data:image/jpeg;base64,lazy')
    const wrapper = mount(PosterImage, { props: { item: item() } })

    expect(getImage).not.toHaveBeenCalled()
    callback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    await flushPromises()

    expect(getImage).toHaveBeenCalledTimes(1)
    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,lazy')
  })

  it('re-observes a lazy image when watched metadata changes', async () => {
    const observe = vi.fn()
    class FakeIntersectionObserver {
      constructor() {}
      disconnect = vi.fn()
      observe = observe
    }
    window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
    const wrapper = mount(PosterImage, { props: { item: item() } })
    await wrapper.setProps({ item: item({ ImageTags: { Primary: 'new-tag' } }) })
    await flushPromises()
    expect(observe).toHaveBeenCalledTimes(2)
  })

  it('restarts loading when eager mode changes after a list refresh', async () => {
    let callback: IntersectionObserverCallback | undefined
    const observe = vi.fn()
    class FakeIntersectionObserver {
      constructor(next: IntersectionObserverCallback) {
        callback = next
      }

      disconnect = vi.fn()
      observe = observe
    }
    window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
    const getImage = vi.mocked(window.mediaServer.getImage)
    getImage.mockResolvedValue('data:image/jpeg;base64,refreshed')
    const wrapper = mount(PosterImage, { props: { item: item(), eager: false } })

    expect(getImage).not.toHaveBeenCalled()
    await wrapper.setProps({ eager: true, item: item({ ImageTags: { Primary: 'refreshed-tag' } }) })
    await flushPromises()

    expect(callback).toBeDefined()
    expect(getImage).toHaveBeenCalledWith({ itemId: 'item-1', imageType: 'Primary', tag: 'refreshed-tag', maxWidth: 480 })
    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,refreshed')
  })

  it('ignores a stale image result after the item changes', async () => {
    let resolveFirst!: (value: string) => void
    const firstResult = new Promise<string>((resolve) => { resolveFirst = resolve })
    const getImage = vi.mocked(window.mediaServer.getImage)
    getImage.mockReturnValueOnce(firstResult).mockResolvedValueOnce('data:image/jpeg;base64,new')
    const wrapper = mount(PosterImage, { props: { item: item({ Id: 'old-item' }), eager: true } })

    await wrapper.setProps({ item: item({ Id: 'new-item', Name: '新媒体' }) })
    await flushPromises()
    resolveFirst('data:image/jpeg;base64,old')
    await flushPromises()

    expect(wrapper.get('img').attributes('src')).toBe('data:image/jpeg;base64,new')
    expect(getImage.mock.calls.map(([request]) => request.itemId)).toEqual(['old-item', 'new-item'])
  })
})
