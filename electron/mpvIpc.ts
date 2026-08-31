import net from 'node:net'

export interface MpvIpcMessage {
  request_id?: number
  event?: string
  id?: number
  name?: string
  data?: unknown
  error?: string
  reason?: string
  file_error?: string
  playlist_entry_id?: number
}

export interface ParsedJsonLines {
  buffer: string
  messages: MpvIpcMessage[]
}

export function consumeJsonLines(buffer: string, chunk: string): ParsedJsonLines {
  const received = `${buffer}${chunk}`
  const lines = received.split('\n')
  const nextBuffer = lines.pop() || ''
  const messages: MpvIpcMessage[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const message = JSON.parse(line) as MpvIpcMessage
      if (message && typeof message === 'object') messages.push(message)
    } catch {
      // Keep malformed lines out of the session state; MPV sends newline-delimited JSON.
    }
  }
  return { buffer: nextBuffer, messages }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class MpvIpc {
  private socket: net.Socket | null = null
  private buffer = ''
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly eventListeners = new Set<(message: MpvIpcMessage) => void>()

  constructor(private readonly pipeName: string) {}

  onEvent(listener: (message: MpvIpcMessage) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  waitForEvent(predicate: (message: MpvIpcMessage) => boolean, timeoutMs = 15_000): Promise<MpvIpcMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        removeListener()
        reject(new Error('MPV 未在规定时间内完成媒体加载'))
      }, timeoutMs)
      const listener = (message: MpvIpcMessage) => {
        if (!predicate(message)) return
        clearTimeout(timer)
        removeListener()
        resolve(message)
      }
      const removeListener = () => this.eventListeners.delete(listener)
      this.eventListeners.add(listener)
    })
  }

  async connectWithRetry(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError = new Error('无法连接 MPV IPC')
    while (Date.now() < deadline) {
      try {
        await this.connectOnce(Math.min(1200, Math.max(300, deadline - Date.now())))
        return
      } catch (error) {
        lastError = error instanceof Error ? error : lastError
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    }
    throw lastError
  }

  async send(command: unknown[], timeoutMs = 1600): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed) throw new Error('MPV IPC 未连接')
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`MPV IPC 请求超时（${String(command[0])}）`))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }

  async getProperty(name: string, timeoutMs = 800): Promise<unknown> {
    return this.send(['get_property', name], timeoutMs)
  }

  async observeProperty(id: number, name: string): Promise<void> {
    await this.send(['observe_property', id, name])
  }

  close(): void {
    this.rejectPending(new Error('MPV IPC 已关闭'))
    for (const listener of [...this.eventListeners]) listener({ event: 'ipc-closed' })
    this.socket?.destroy()
    this.socket = null
    this.buffer = ''
  }

  private connectOnce(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const socket = net.createConnection(this.pipeName)
      const timer = setTimeout(() => finish(new Error('MPV IPC 连接超时')), timeoutMs)
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          socket.destroy()
          reject(error)
        } else {
          this.socket = socket
          resolve()
        }
      }

      socket.on('data', (chunk) => {
        const parsed = consumeJsonLines(this.buffer, chunk.toString())
        this.buffer = parsed.buffer
        for (const message of parsed.messages) this.handleMessage(message)
      })
      socket.once('connect', () => finish())
      socket.once('error', (error) => {
        if (!settled) finish(error)
      })
      socket.once('close', () => {
        if (this.socket === socket) {
          this.socket = null
          this.rejectPending(new Error('MPV IPC 连接已断开'))
          for (const listener of this.eventListeners) listener({ event: 'ipc-closed' })
        }
        if (!settled) finish(new Error('MPV IPC 连接已关闭'))
      })
    })
  }

  private handleMessage(message: MpvIpcMessage): void {
    if (typeof message.request_id === 'number') {
      const pending = this.pending.get(message.request_id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.request_id)
      if (message.error && message.error !== 'success') pending.reject(new Error(`MPV IPC：${message.error}`))
      else pending.resolve(message.data)
      return
    }
    for (const listener of this.eventListeners) listener(message)
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(requestId)
    }
  }
}
