import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { JellyfinClient } from './jellyfinClient'
import { PlaybackGateway } from './playbackGateway'

const identity = { name: 'Jellyfin Server', version: '10.11.11' }
const servers: Server[] = []

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; url: string; requests: Array<{ headers: Record<string, string | string[] | undefined>; url?: string }> }> {
  const requests: Array<{ headers: Record<string, string | string[] | undefined>; url?: string }> = []
  const server = createServer((request, response) => {
    requests.push({ headers: request.headers, url: request.url })
    response.setHeader('Connection', 'close')
    handler(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return { server, url: `http://127.0.0.1:${address.port}`, requests }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('PlaybackGateway', () => {
  it('keeps Jellyfin authorization on the upstream request and strips it across 302', async () => {
    const final = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '5' })
      response.end('hello')
    })
    const source = await listen((request, response) => {
      response.writeHead(302, { Location: `${final.url}/movie.mp4` })
      response.end()
    })
    const client = new JellyfinClient(source.url, 'secret-token', 'user-1', identity)
    const gateway = new PlaybackGateway(client)
    await gateway.start()
    const url = gateway.register({ upstreamUrl: `${source.url}/stream?Static=true` })
    const response = await fetch(url)
    expect(await response.text()).toBe('hello')
    expect(source.requests[0].headers.authorization).toContain('Token="secret-token"')
    expect(final.requests[0].headers.authorization).toBeUndefined()
    await gateway.dispose()
  })

  it('proxies ranged responses and required headers without exposing the upstream token', async () => {
    const source = await listen((request, response) => {
      response.writeHead(206, { 'content-type': 'text/plain', 'content-range': 'bytes 0-2/5', 'content-length': '3' })
      response.end('hel')
    })
    const client = new JellyfinClient(source.url, 'secret-token', 'user-1', identity)
    const gateway = new PlaybackGateway(client)
    await gateway.start()
    const url = gateway.register({ upstreamUrl: `${source.url}/subtitle.ass`, requiredHeaders: { Referer: 'https://alist.example' } })
    const response = await fetch(url, { headers: { Range: 'bytes=0-2' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-2/5')
    expect(await response.text()).toBe('hel')
    expect(source.requests[0].headers.referer).toBe('https://alist.example')
    expect(source.requests[0].headers.range).toBe('bytes=0-2')
    await gateway.dispose()
  })

  it('rejects non-http resources and unknown capabilities', async () => {
    const source = await listen((_request, response) => response.end())
    const client = new JellyfinClient(source.url, 'token', 'user-1', identity)
    const gateway = new PlaybackGateway(client)
    await gateway.start()
    expect(() => gateway.register({ upstreamUrl: 'file:///secret.mp4' })).toThrow('仅支持 HTTP 或 HTTPS')
    const response = await fetch(`http://127.0.0.1:${(gateway as any).port}/play/unknown`)
    expect(response.status).toBe(404)
    await gateway.dispose()
  })
})
