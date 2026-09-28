import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { generateGatewayKey, startManagedGateway } from './gateway.js'
import type { ManagedGateway } from './gateway.js'

/** A bare local HTTP server standing in for the container's engine port. */
interface FakeUpstream {
  port: number
  close: () => Promise<void>
}

function startFakeUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<FakeUpstream> {
  const server: Server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.()
            server.close(() => r())
          }),
      })
    })
  })
}

interface RawResponse {
  status: number
  headers: IncomingMessage['headers']
  body: string
}

/** A plain request via `node:http`, not `fetch`: a foreign `Host` header cannot be set through `fetch`. */
function send(
  port: number,
  options: { path?: string; method?: string; headers?: Record<string, string> } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/v1/chat/completions',
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const gateways: ManagedGateway[] = []
const upstreams: FakeUpstream[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()))
  await Promise.all(upstreams.splice(0).map((u) => u.close()))
})

/** Start a fake upstream plus a gateway pointed at it, tracked for teardown. */
async function setup(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  opts: { apiKey?: string; allowedHosts?: string[] } = {}
): Promise<{ gw: ManagedGateway; upstream: FakeUpstream; apiKey: string }> {
  const upstream = await startFakeUpstream(handler)
  upstreams.push(upstream)
  const apiKey = opts.apiKey ?? generateGatewayKey()
  const gw = await startManagedGateway({
    upstream: { host: '127.0.0.1', port: upstream.port },
    apiKey,
    allowedHosts: opts.allowedHosts ?? [],
  })
  gateways.push(gw)
  return { gw, upstream, apiKey }
}

describe('generateGatewayKey', () => {
  it('returns a long, URL-safe, unpredictable key each time', () => {
    const a = generateGatewayKey()
    const b = generateGatewayKey()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(32)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('startManagedGateway', () => {
  it('binds 127.0.0.1 on a random port distinct from the upstream', async () => {
    const { gw, upstream } = await setup((_req, res) => res.end('ok'))
    expect(gw.port).toBeGreaterThan(0)
    expect(gw.port).not.toBe(upstream.port)
  })

  it('rejects a non-loopback upstream host', async () => {
    await expect(
      startManagedGateway({ upstream: { host: '0.0.0.0', port: 1 }, apiKey: 'x', allowedHosts: [] })
    ).rejects.toThrow(/loopback/)
  })
})

describe('authentication', () => {
  it('answers 401 and never reaches the container when no key is sent', async () => {
    let reached = false
    const { gw } = await setup((_req, res) => {
      reached = true
      res.end('should not happen')
    })

    const res = await send(gw.port, { headers: { host: '127.0.0.1' } })

    expect(res.status).toBe(401)
    expect(reached).toBe(false)
  })

  it('answers 403 for a foreign Host even with the correct key, and never reaches the container', async () => {
    let reached = false
    const { gw, apiKey } = await setup((_req, res) => {
      reached = true
      res.end('should not happen')
    })

    const res = await send(gw.port, {
      headers: { host: 'evil.example', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(403)
    expect(reached).toBe(false)
  })

  it('passes an authorized request from an allowed Host through to the container', async () => {
    const { gw, apiKey } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello from the container')
    })

    const res = await send(gw.port, {
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(200)
    expect(res.body).toBe('hello from the container')
  })

  it('rejects the previous generation key once the gateway has closed and a new one started', async () => {
    const upstream = await startFakeUpstream((_req, res) => res.end('ok'))
    upstreams.push(upstream)

    const oldKey = generateGatewayKey()
    const gw1 = await startManagedGateway({
      upstream: { host: '127.0.0.1', port: upstream.port },
      apiKey: oldKey,
      allowedHosts: [],
    })
    await gw1.close()

    const gw2 = await startManagedGateway({
      upstream: { host: '127.0.0.1', port: upstream.port },
      apiKey: generateGatewayKey(),
      allowedHosts: [],
    })
    gateways.push(gw2)

    const res = await send(gw2.port, {
      headers: { host: '127.0.0.1', authorization: `Bearer ${oldKey}` },
    })

    expect(res.status).toBe(401)
  })
})

describe('streaming', () => {
  it('streams 1000+ SSE chunks through as they arrive, not only once the upstream finishes', async () => {
    const CHUNK_COUNT = 1200
    let upstreamFinishedWriting = false

    const { gw, apiKey } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const writeNext = (): void => {
        if (i >= CHUNK_COUNT) {
          upstreamFinishedWriting = true
          res.end()
          return
        }
        res.write(`data: {"n":${i}}\n\n`)
        i += 1
        setImmediate(writeNext)
      }
      writeNext()
    })

    let sawDataBeforeUpstreamFinished = false
    let dataEvents = 0
    let received = ''
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/v1/chat/completions',
          headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
        },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            dataEvents += 1
            if (!upstreamFinishedWriting) sawDataBeforeUpstreamFinished = true
            received += chunk.toString('utf8')
          })
          res.on('end', resolve)
        }
      )
      req.on('error', reject)
      req.end()
    })

    expect(sawDataBeforeUpstreamFinished).toBe(true)
    expect(dataEvents).toBeGreaterThan(1)
    expect(received).toContain('"n":0')
    expect(received).toContain(`"n":${CHUNK_COUNT - 1}`)
  })

  it('closes the upstream connection when the client disconnects mid-stream', async () => {
    let upstreamSawEarlyClose = false
    let upstreamFinishedNormally = false

    const { gw, apiKey } = await setup((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const timer = setInterval(() => res.write('data: ping\n\n'), 5)
      req.on('close', () => {
        clearInterval(timer)
        if (!upstreamFinishedNormally) upstreamSawEarlyClose = true
      })
      res.on('finish', () => {
        upstreamFinishedNormally = true
      })
    })

    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/v1/chat/completions',
          headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
        },
        (res) => {
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        }
      )
      req.on('error', () => resolve())
      req.end()
    })

    await expect.poll(() => upstreamSawEarlyClose, { timeout: 2000 }).toBe(true)
  })
})
