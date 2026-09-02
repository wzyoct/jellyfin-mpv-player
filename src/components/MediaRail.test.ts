// @vitest-environment happy-dom

import { nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MediaRail from './MediaRail.vue'
import type { MediaItem } from '../types'

const item = (id: string, position = 0): MediaItem => ({
  Id: id,
  Name: id,
  Type: 'Movie',
  UserData: { PlaybackPositionTicks: position },
})

async function settle(): Promise<void> {
  await nextTick()
  await nextTick()
  await flushPromises()
}

describe('MediaRail', () => {
  it('resets the scroll position when the first item changes', async () => {
    const items = ref([item('one'), item('two')])
    const wrapper = mount(MediaRail, {
      props: { title: '继续观看', items: items.value },
      global: { stubs: { MediaCard: { props: ['item'], template: '<button>{{ item.Name }}</button>' } } },
    })
    const rail = wrapper.get('.poster-row').element as HTMLElement
    Object.defineProperties(rail, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 100 },
      scrollLeft: { configurable: true, writable: true, value: 80 },
    })
    await wrapper.get('.poster-row').trigger('scroll')
    expect(wrapper.get('button[aria-label="向左浏览继续观看"]').attributes('disabled')).toBeUndefined()

    await wrapper.setProps({ items: [item('new-one'), item('two')] })
    await settle()

    expect(rail.scrollLeft).toBe(0)
    expect(wrapper.get('button[aria-label="向左浏览继续观看"]').attributes('disabled')).toBeDefined()
  })

  it('keeps the browsing position when only progress changes', async () => {
    const wrapper = mount(MediaRail, {
      props: { title: '继续观看', items: [item('one', 10), item('two')] },
      global: { stubs: { MediaCard: { props: ['item'], template: '<button>{{ item.Name }}</button>' } } },
    })
    const rail = wrapper.get('.poster-row').element as HTMLElement
    Object.defineProperties(rail, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 100 },
      scrollLeft: { configurable: true, writable: true, value: 55 },
    })
    await wrapper.get('.poster-row').trigger('scroll')
    await wrapper.setProps({ items: [item('one', 20), item('two')] })
    await settle()
    expect(rail.scrollLeft).toBe(55)
  })
})
