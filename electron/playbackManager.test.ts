import { describe, expect, it, vi } from 'vitest'
import type { PlaybackEvent } from '../src/types'
import { PlaybackManager, PlaybackOperationQueue, type PlaybackManagerOptions } from './playbackManager'

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

function options(): PlaybackManagerOptions {
  return {
    getClient: () => null,
    getOptionalClient: () => null,
    resolveMpvPath: () => 'mpv.exe',
    validateMpvPath: () => ({ valid: false, path: 'mpv.exe', message: 'MPV 不可用' }),
    emit: vi.fn<(event: PlaybackEvent) => void>(),
  }
}

describe('PlaybackOperationQueue', () => {
  it('serializes operations and continues after a rejected operation', async () => {
    const queue = new PlaybackOperationQueue()
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = queue.enqueue(async () => {
      calls.push('first')
      await firstGate
      return 'first-result'
    })
    const second = queue.enqueue(async () => {
      calls.push('second')
      return 'second-result'
    })
    await flushMicrotasks()
    await flushMicrotasks()
    expect(calls).toEqual(['first'])

    releaseFirst()
    await expect(first).resolves.toBe('first-result')
    await expect(second).resolves.toBe('second-result')
    expect(calls).toEqual(['first', 'second'])

    const rejected = queue.enqueue(async () => {
      calls.push('rejected')
      throw new Error('operation failed')
    })
    await expect(rejected).rejects.toThrow('operation failed')
    await expect(queue.enqueue(async () => {
      calls.push('after-failure')
      return 'ok'
    })).resolves.toBe('ok')
    expect(calls).toEqual(['first', 'second', 'rejected', 'after-failure'])
  })
})

describe('PlaybackManager', () => {
  it('exposes a stable idle snapshot and handles stale lifecycle calls', async () => {
    const manager = new PlaybackManager(options())

    expect(manager.snapshot()).toMatchObject({ phase: 'idle', revision: 0, currentIndex: -1 })
    expect(manager.hasActiveSession()).toBe(false)
    await expect(manager.stop('quit')).resolves.toBeUndefined()
    await expect(manager.command({ sessionId: 'stale', command: 'pause' })).resolves.toMatchObject({ phase: 'idle' })
    expect(manager.hasActiveSession()).toBe(false)
  })
})
