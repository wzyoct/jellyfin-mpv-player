import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { JellyfinClient } from './jellyfinClient'
import { logger } from './logger'
import type { PlaybackLoadDiagnostic } from './playbackError'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

interface GatewayResource {
  upstreamUrl?: string
  requiredHeaders?: Record<string, string>
  resolve?: () => Promise<ResolvedPlaybackResource>
  resolved?: Promise<ResolvedPlaybackResource>
  diagnostic?: PlaybackLoadDiagnostic
}

export interface ResolvedPlaybackResource {
  upstreamUrl: string
  requiredHeaders?: Record<string, string>
}

class PlaybackGatewayTimeoutError extends Error {
  constructor() {
    super('媒体首包等待超时（60 秒）')
    this.name = 'PlaybackGatewayTimeoutError'
  }
}

export interface RegisterPlaybackResourceOptions {
  upstreamUrl?: string
  requiredHeaders?: Record<string, string>
  resolve?: () => Promise<ResolvedPlaybackResource>
}

function copyResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers[key] = value
  })
  return headers
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function requestHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  const range = request.headers.range
  const ifRange = request.headers['if-range']
  if (typeof range === 'string') headers.Range = range
  if (typeof ifRange === 'string') headers['If-Range'] = ifRange
  return headers
}

export class PlaybackGateway {
  private readonly resources = new Map<string, GatewayResource>()
  private readonly activeControllers = new Set<AbortController>()
  private server?: Server
  private port = 0

  constructor(private readonly client: JellyfinClient) {}

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.server
      if (!server) return reject(new Error('播放网关初始化失败'))
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('播放网关未返回有效端口'))
        this.port = address.port
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    logger.info('playback-gateway', 'started', { port: this.port })
  }

  register(options: RegisterPlaybackResourceOptions): string {
    if (!options.resolve && (!options.upstreamUrl || !isHttpUrl(options.upstreamUrl))) throw new Error('播放地址仅支持 HTTP 或 HTTPS')
    if (options.resolve && options.upstreamUrl && !isHttpUrl(options.upstreamUrl)) throw new Error('播放地址仅支持 HTTP 或 HTTPS')
    if (!this.server || !this.port) throw new Error('播放网关尚未启动')
    const id = randomUUID().replace(/-/g, '')
    this.resources.set(id, {
      upstreamUrl: options.upstreamUrl,
      requiredHeaders: { ...(options.requiredHeaders || {}) },
      resolve: options.resolve,
    })
    return `http://127.0.0.1:${this.port}/play/${id}`
  }

  async dispose(): Promise<void> {
    this.activeControllers.forEach((controller) => controller.abort())
    this.activeControllers.clear()
    this.resources.clear()
    const server = this.server
    this.server = undefined
    this.port = 0
    if (server) await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      server.close(finish)
      server.closeAllConnections?.()
      setTimeout(finish, 1000)
    })
  }

  getDiagnostic(playbackUrl: string): PlaybackLoadDiagnostic | undefined {
    const match = playbackUrl.match(/\/play\/([a-f0-9]+)$/i)
    const diagnostic = match ? this.resources.get(match[1])?.diagnostic : undefined
    return diagnostic ? { ...diagnostic } : undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }
    const match = request.url?.match(/^\/play\/([a-f0-9]+)$/i)
    const resource = match ? this.resources.get(match[1]) : undefined
    if (!resource) {
      response.writeHead(404)
      response.end()
      return
    }

    const controller = new AbortController()
    this.activeControllers.add(controller)
    request.once('aborted', () => controller.abort())
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    const previousDiagnostic = resource.diagnostic && { ...resource.diagnostic }
    const diagnostic: PlaybackLoadDiagnostic = {
      redirects: 0,
      rangeRequested: typeof request.headers.range === 'string',
      requiredHeaders: Object.keys(resource.requiredHeaders || {}).length > 0,
      phase: 'upstream',
      source: 'upstream',
    }
    resource.diagnostic = diagnostic
    try {
      const resolved = await this.resolveResource(resource)
      const requiredHeaders = { ...(resolved.requiredHeaders || {}) }
      let currentUrl = resolved.upstreamUrl
      if (!isHttpUrl(currentUrl)) throw new Error('播放地址仅支持 HTTP 或 HTTPS')
      diagnostic.requiredHeaders = Object.keys(requiredHeaders).length > 0
      let upstream = await this.fetch(currentUrl, request.method, requestHeaders(request), requiredHeaders, controller.signal, this.isServerOrigin(currentUrl))
      this.recordResponse(diagnostic, upstream, currentUrl)
      let redirects = 0
      const visited = new Set([currentUrl])
      while (isRedirect(upstream.status) && Object.keys(requiredHeaders).length && redirects < 10) {
        const location = upstream.headers.get('location')
        if (!location) break
        const resolved = new URL(location, currentUrl).toString()
        if (!isHttpUrl(resolved)) throw new Error('上游重定向地址不是 HTTP 或 HTTPS')
        if (visited.has(resolved)) throw new Error('上游重定向出现循环')
        visited.add(resolved)
        currentUrl = resolved
        redirects += 1
        diagnostic.redirects = redirects
        diagnostic.phase = 'redirect'
        upstream = await this.fetch(currentUrl, request.method, requestHeaders(request), requiredHeaders, controller.signal, this.isServerOrigin(currentUrl))
        this.recordResponse(diagnostic, upstream, currentUrl)
      }

      if (isRedirect(upstream.status) && Object.keys(requiredHeaders).length && redirects >= 10) {
        throw new Error('上游重定向超过 10 次限制')
      }
      if (isRedirect(upstream.status)) {
        const location = upstream.headers.get('location')
        const resolved = location ? new URL(location, currentUrl).toString() : ''
        if (!resolved || !isHttpUrl(resolved)) throw new Error('上游返回了无效的重定向地址')
        diagnostic.phase = 'redirect'
        diagnostic.source = 'redirect'
        response.writeHead(upstream.status, { Location: resolved, 'Cache-Control': 'no-store' })
        response.end()
        return
      }

      diagnostic.phase = 'response'
      const headers = copyResponseHeaders(upstream)
      diagnostic.contentType = upstream.headers.get('content-type') || undefined
      response.writeHead(upstream.status, headers)
      if (request.method === 'HEAD' || !upstream.body) {
        response.end()
        return
      }
      const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
      await new Promise<void>((resolve, reject) => {
        let firstByteTimedOut = false
        const firstByteTimer = setTimeout(() => {
          firstByteTimedOut = true
          controller.abort()
          stream.destroy(new PlaybackGatewayTimeoutError())
        }, 60_000)
        const onFirstByte = () => clearTimeout(firstByteTimer)
        stream.once('data', onFirstByte)
        stream.once('end', resolve)
        stream.once('close', () => {
          clearTimeout(firstByteTimer)
          resolve()
        })
        stream.once('error', (error) => {
          clearTimeout(firstByteTimer)
          if (!firstByteTimedOut && (controller.signal.aborted || isNormalCancellation(error))) {
            if (previousDiagnostic?.status && previousDiagnostic.status >= 200 && previousDiagnostic.status < 300) resource.diagnostic = previousDiagnostic
            resolve()
            return
          }
          diagnostic.phase = 'stream'
          diagnostic.source = 'gateway'
          diagnostic.status = 502
          logger.warn('playback-gateway', 'stream-failed', {
            status: 502,
            contentType: diagnostic.contentType,
            redirects: diagnostic.redirects,
            rangeRequested: diagnostic.rangeRequested,
            requiredHeaders: diagnostic.requiredHeaders,
            phase: diagnostic.phase,
            message: error instanceof Error ? error.message : String(error),
          })
          response.destroy()
          reject(error)
        })
        response.once('close', () => {
          if (!response.writableEnded) {
            controller.abort()
            stream.destroy()
          }
        })
        stream.pipe(response)
      })
    } catch (error) {
      if (!isGatewayTimeoutError(error) && (controller.signal.aborted || isNormalCancellation(error))) {
        if (previousDiagnostic?.status && previousDiagnostic.status >= 200 && previousDiagnostic.status < 300) resource.diagnostic = previousDiagnostic
        return
      }
      diagnostic.phase = 'gateway'
      diagnostic.source = 'gateway'
      diagnostic.status = 502
      logger.warn('playback-gateway', 'request-failed', {
        method: request.method,
        status: 502,
        contentType: diagnostic.contentType,
        redirects: diagnostic.redirects,
        rangeRequested: diagnostic.rangeRequested,
        requiredHeaders: diagnostic.requiredHeaders,
        phase: diagnostic.phase,
        message: error instanceof Error ? error.message : String(error),
      })
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('播放网关请求失败')
    } finally {
      this.activeControllers.delete(controller)
    }
  }

  private resolveResource(resource: GatewayResource): Promise<ResolvedPlaybackResource> {
    if (resource.upstreamUrl) return Promise.resolve({ upstreamUrl: resource.upstreamUrl, requiredHeaders: resource.requiredHeaders })
    if (!resource.resolve) return Promise.reject(new Error('播放资源解析器不可用'))
    if (!resource.resolved) {
      resource.resolved = resource.resolve().then((resolved) => {
        if (!resolved || !isHttpUrl(resolved.upstreamUrl)) throw new Error('播放地址仅支持 HTTP 或 HTTPS')
        return resolved
      }).catch((error) => {
        resource.resolved = undefined
        throw error
      })
    }
    return resource.resolved
  }

  private recordResponse(diagnostic: PlaybackLoadDiagnostic, response: Response, url: string): void {
    diagnostic.status = response.status
    diagnostic.contentType = response.headers.get('content-type') || undefined
    logger.info('playback-gateway', 'upstream-response', {
      status: response.status,
      contentType: diagnostic.contentType,
      redirects: diagnostic.redirects,
      rangeRequested: diagnostic.rangeRequested,
      requiredHeaders: diagnostic.requiredHeaders,
      serverOrigin: this.isServerOrigin(url),
    })
  }

  private async fetch(url: string, method: string, headers: Record<string, string>, requiredHeaders: Record<string, string>, signal: AbortSignal, includeAuthorization = true): Promise<Response> {
    const requestHeaders = new Headers(headers)
    requestHeaders.set('User-Agent', 'libmpv')
    Object.entries(requiredHeaders).forEach(([key, value]) => {
      if (!includeAuthorization && /^(?:authorization|cookie|x[-_]mediabrowser[-_]token)$/i.test(key)) return
      requestHeaders.set(key, value)
    })
    if (includeAuthorization) requestHeaders.set('Authorization', this.client.buildAuthorization())
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 60_000)
    try {
      return await fetch(url, { method, headers: requestHeaders, redirect: 'manual', signal: controller.signal })
    } catch (error) {
      if (timedOut) throw new PlaybackGatewayTimeoutError()
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private isServerOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.client.baseUrl).origin
    } catch {
      return false
    }
  }
}

function isNormalCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { name?: unknown; code?: unknown; message?: unknown }
  return value.name === 'AbortError' || value.code === 'ERR_STREAM_PREMATURE_CLOSE' || value.code === 'ECONNRESET' || (typeof value.message === 'string' && /aborted|premature close|socket hang up/i.test(value.message))
}

function isGatewayTimeoutError(error: unknown): boolean {
  return error instanceof PlaybackGatewayTimeoutError
}
