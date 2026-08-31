import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { consumeJsonLines, MpvIpc } from './mpvIpc'

describe('consumeJsonLines', () => {
  it('keeps incomplete JSON until the next chunk', () => {
    const first = consumeJsonLines('', '{"event":"property-change","name":"time-pos"')
    expect(first.messages).toEqual([])

    const second = consumeJsonLines(first.buffer, ',"data":12.5}\n')
    expect(second.buffer).toBe('')
    expect(second.messages).toEqual([{ event: 'property-change', name: 'time-pos', data: 12.5 }])
  })

  it('parses multiple responses and events in one chunk', () => {
    const parsed = consumeJsonLines('', [
      '{"request_id":1,"error":"success","data":12.5}',
      '{"event":"property-change","name":"pause","data":false}',
      '{"request_id":2,"error":"success"}',
    ].join('\n') + '\n')
    expect(parsed.messages).toEqual([
      { request_id: 1, error: 'success', data: 12.5 },
      { event: 'property-change', name: 'pause', data: false },
      { request_id: 2, error: 'success' },
    ])
  })

  it('ignores malformed lines without losing the following message', () => {
    const parsed = consumeJsonLines('', 'not-json\n{"event":"end-file"}\n')
    expect(parsed.messages).toEqual([{ event: 'end-file' }])
  })

  it('preserves MPV end-file reasons used by the playback session', () => {
    const parsed = consumeJsonLines('', [
      '{"event":"end-file","reason":"eof"}',
      '{"event":"end-file","reason":"quit"}',
      '{"event":"end-file","reason":"error","file_error":"not found"}',
    ].join('\n') + '\n')
    expect(parsed.messages.map((message) => message.reason)).toEqual(['eof', 'quit', 'error'])
    expect(parsed.messages[2].file_error).toBe('not found')
  })

  it('waits for a fake MPV file-loaded event after connecting', async () => {
    const pipeName = `\\\\.\\pipe\\ember-test-${randomUUID()}`
    const server = net.createServer((socket) => {
      setTimeout(() => socket.write('{"event":"file-loaded"}\n'), 25)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipeName, resolve)
    })

    const ipc = new MpvIpc(pipeName)
    try {
      await ipc.connectWithRetry()
      await expect(ipc.waitForEvent((message) => message.event === 'file-loaded', 1000)).resolves.toMatchObject({ event: 'file-loaded' })
    } finally {
      ipc.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('sends native boolean properties through set_property', async () => {
    const pipeName = `\\\\.\\pipe\\ember-property-${randomUUID()}`
    const received: unknown[][] = []
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const request = JSON.parse(line) as { command?: unknown[]; request_id?: number }
          if (request.command) received.push(request.command)
          socket.write(JSON.stringify({ request_id: request.request_id, error: 'success' }) + '\n')
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipeName, resolve)
    })

    const ipc = new MpvIpc(pipeName)
    try {
      await ipc.connectWithRetry()
      await ipc.setProperty('pause', true)
      await ipc.setProperty('http-header-fields', ['X-Required: yes', 'X-MediaBrowser-Token: secret'])
      expect(received).toEqual([
        ['set_property', 'pause', true],
        ['set_property', 'http-header-fields', ['X-Required: yes', 'X-MediaBrowser-Token: secret']],
      ])
    } finally {
      ipc.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('keeps MPV errors contextual while translating common messages', async () => {
    const pipeName = `\\\\.\\pipe\\ember-property-error-${randomUUID()}`
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString()) as { request_id?: number }
        socket.write(JSON.stringify({ request_id: request.request_id, error: 'invalid parameter' }) + '\n')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipeName, resolve)
    })

    const ipc = new MpvIpc(pipeName)
    try {
      await ipc.connectWithRetry()
      await expect(ipc.setProperty('pause', true)).rejects.toThrow('MPV IPC 命令 set_property pause 失败：参数无效')
    } finally {
      ipc.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
