import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

class FakeSocket extends EventEmitter {
  destroyed = false
  writeError?: Error
  lastWrite = ''

  write(value: string, callback?: (error?: Error) => void): boolean {
    this.lastWrite = value
    callback?.(this.writeError)
    return !this.writeError
  }

  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
}

vi.mock('node:net', () => ({ default: { createConnection: mocks.createConnection } }))
vi.mock('./logger', () => ({ logger: mocks.logger }))

describe('MpvIpc socket lifecycle', () => {
  let socket: FakeSocket
  let MpvIpc: typeof import('./mpvIpc').MpvIpc

  beforeEach(async () => {
    vi.useFakeTimers()
    socket = new FakeSocket()
    mocks.createConnection.mockReset()
    mocks.createConnection.mockImplementation(() => {
      queueMicrotask(() => socket.emit('connect'))
      return socket
    })
    ;({ MpvIpc } = await import('./mpvIpc'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
  })

  it('connects, resolves responses and notifies/removes event listeners', async () => {
    const ipc = new MpvIpc('fake-pipe')
    const event = vi.fn()
    const remove = ipc.onEvent(event)
    await ipc.connectWithRetry(1000)

    const pending = ipc.getProperty('time-pos', 100)
    const request = JSON.parse(socket.lastWrite) as { request_id: number }
    socket.emit('data', JSON.stringify({ request_id: request.request_id, error: 'success', data: 12.5 }) + '\n')
    await expect(pending).resolves.toBe(12.5)

    const observed = ipc.observeProperty(1, 'pause')
    const observeRequest = JSON.parse(socket.lastWrite) as { request_id: number }
    socket.emit('data', JSON.stringify({ request_id: observeRequest.request_id, error: 'success' }) + '\n')
    await expect(observed).resolves.toBeUndefined()

    socket.emit('data', '{"event":"property-change","name":"pause","data":false}\n')
    expect(event).toHaveBeenCalledWith({ event: 'property-change', name: 'pause', data: false })
    remove()
    socket.emit('data', '{"event":"file-loaded"}\n')
    expect(event).toHaveBeenCalledTimes(1)
  })

  it('rejects sends before connection and after request timeouts', async () => {
    const disconnected = new MpvIpc('fake-pipe')
    await expect(disconnected.send(['pause'])).rejects.toThrow('MPV IPC 未连接')

    const ipc = new MpvIpc('fake-pipe')
    await ipc.connectWithRetry(1000)
    const pending = ipc.send(['set_property', 'pause', true], 50)
    const rejection = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    await expect(rejection).resolves.toMatchObject({ message: 'MPV IPC 请求超时（set_property）' })
  })

  it('rejects a write failure and translates property errors', async () => {
    const ipc = new MpvIpc('fake-pipe')
    await ipc.connectWithRetry(1000)
    socket.writeError = new Error('broken pipe')
    await expect(ipc.send(['set_property', 'pause', true])).rejects.toThrow('broken pipe')

    socket.writeError = undefined
    const pending = ipc.getProperty('duration', 100)
    const request = JSON.parse(socket.lastWrite) as { request_id: number }
    socket.emit('data', JSON.stringify({ request_id: request.request_id, error: 'property unavailable' }) + '\n')
    await expect(pending).rejects.toThrow('MPV IPC 命令 get_property duration 失败：属性不可用')
  })

  it('rejects pending calls and emits ipc-closed when closed', async () => {
    const ipc = new MpvIpc('fake-pipe')
    const events: unknown[] = []
    ipc.onEvent((message) => events.push(message))
    await ipc.connectWithRetry(1000)
    const pending = ipc.send(['get_property', 'duration'], 1000)
    const rejection = pending.catch((error: unknown) => error)
    ipc.close()
    await expect(rejection).resolves.toMatchObject({ message: 'MPV IPC 已关闭' })
    expect(events[0]).toEqual({ event: 'ipc-closed' })
    await expect(ipc.getProperty('duration')).rejects.toThrow('MPV IPC 未连接')
  })

  it('times out while waiting for a matching event', async () => {
    const ipc = new MpvIpc('fake-pipe')
    await ipc.connectWithRetry(1000)
    const pending = ipc.waitForEvent((message) => message.event === 'file-loaded', 60)
    const rejection = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(60)
    await expect(rejection).resolves.toMatchObject({ message: 'MPV 未在规定时间内完成媒体加载' })
  })

  it('retries after socket errors until the connection deadline', async () => {
    mocks.createConnection.mockImplementation(() => {
      const failed = new FakeSocket()
      queueMicrotask(() => failed.emit('error', new Error('pipe unavailable')))
      return failed
    })
    const ipc = new MpvIpc('fake-pipe')
    const pending = ipc.connectWithRetry(350)
    const rejection = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(500)
    await expect(rejection).resolves.toMatchObject({ message: 'pipe unavailable' })
  })

  it('reports a connection timeout when the socket never connects', async () => {
    mocks.createConnection.mockImplementation(() => new FakeSocket())
    const ipc = new MpvIpc('fake-pipe')
    const pending = ipc.connectWithRetry(350)
    const rejection = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(500)
    await expect(rejection).resolves.toMatchObject({ message: 'MPV IPC 连接超时' })
  })
})
