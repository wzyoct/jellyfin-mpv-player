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
  upstreamUrl: string
  requiredHeaders: Record<string, string>
  diagnostic?: PlaybackLoadDiagnostic
}

export interface RegisterPlaybackResourceOptions {
  upstreamUrl: string
  requiredHeaders?: Record<string, string>
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
    if (!isHttpUrl(options.upstreamUrl)) throw new Error('播放地址仅支持 HTTP 或 HTTPS')
    if (!this.server || !this.port) throw new Error('播放网关尚未启动')
    const id = randomUUID().replace(/-/g, '')
    this.resources.set(id, {
      upstreamUrl: options.upstreamUrl,
      requiredHeaders: { ...(options.requiredHeaders || {}) },
    })
    return `http://127.0.0.1:${this.port}/play/${id}`
  }

  async dispose(): Promise<void> {
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
    request.once('aborted', () => controller.abort())
    const diagnostic: PlaybackLoadDiagnostic = {
      redirects: 0,
      rangeRequested: typeof request.headers.range === 'string',
      requiredHeaders: Object.keys(resource.requiredHeaders).length > 0,
      phase: 'upstream',
      source: 'upstream',
    }
    resource.diagnostic = diagnostic
    try {
      let currentUrl = resource.upstreamUrl
      let upstream = await this.fetch(currentUrl, request.method, requestHeaders(request), resource.requiredHeaders, controller.signal, this.isServerOrigin(currentUrl))
      this.recordResponse(diagnostic, upstream, currentUrl)
      let redirects = 0
      while (isRedirect(upstream.status) && resource.requiredHeaders && Object.keys(resource.requiredHeaders).length && redirects < 3) {
        const location = upstream.headers.get('location')
        if (!location) break
        const resolved = new URL(location, currentUrl).toString()
        if (!isHttpUrl(resolved)) throw new Error('上游重定向地址不是 HTTP 或 HTTPS')
        currentUrl = resolved
        redirects += 1
        diagnostic.redirects = redirects
        diagnostic.phase = 'redirect'
        upstream = await this.fetch(currentUrl, request.method, requestHeaders(request), resource.requiredHeaders, controller.signal, this.isServerOrigin(currentUrl))
        this.recordResponse(diagnostic, upstream, currentUrl)
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
      stream.once('error', (error) => {
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
      })
      stream.pipe(response)
    } catch (error) {
      if (controller.signal.aborted) return
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
    }
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

  private fetch(url: string, method: string, headers: Record<string, string>, requiredHeaders: Record<string, string>, signal: AbortSignal, includeAuthorization = true): Promise<Response> {
    const requestHeaders = new Headers(headers)
    requestHeaders.set('User-Agent', 'libmpv')
    Object.entries(requiredHeaders).forEach(([key, value]) => {
      if (!includeAuthorization && /^(?:authorization|cookie|x[-_]mediabrowser[-_]token)$/i.test(key)) return
      requestHeaders.set(key, value)
    })
    if (includeAuthorization) requestHeaders.set('Authorization', this.client.buildAuthorization())
    return fetch(url, { method, headers: requestHeaders, redirect: 'manual', signal })
  }

  private isServerOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.client.baseUrl).origin
    } catch {
      return false
    }
  }
}
