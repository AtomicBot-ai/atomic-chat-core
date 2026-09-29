import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { ManagedRequestRefusal } from './adapter.js'
import type { ManagedRoute } from './adapter.js'
import {
  bracketIfIpv6,
  generateGatewayKey,
  MANAGED_GATEWAY_ERROR_BODY_CAP_BYTES,
  MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES,
  readCappedBody,
  startManagedGateway,
} from './gateway.js'
import type { ManagedGateway } from './gateway.js'

/** A bare local HTTP server standing in for the container's engine port. */
interface FakeUpstream {
  port: number
  close: () => Promise<void>
}

/** Whether this host has `::1` configured on its loopback interface (some CI sandboxes do not). */
function ipv6LoopbackAvailable(): boolean {
  return Object.values(networkInterfaces())
    .flat()
    .some((info) => info?.internal === true && info.family === 'IPv6' && info.address === '::1')
}

function startFakeUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  bindHost = '127.0.0.1'
): Promise<FakeUpstream> {
  const server: Server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, bindHost, () => {
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
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}
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
    req.end(options.body)
  })
}

const gateways: ManagedGateway[] = []
const upstreams: FakeUpstream[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()))
  await Promise.all(upstreams.splice(0).map((u) => u.close()))
})

/** Every route these tests may send to by default (`send()`'s own default method+path plus its
 *  siblings) — method+path together, since findings-2.13-r3.md item 1 keys route matching on both. */
const DEFAULT_TEST_ROUTES: ManagedRoute[] = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/completions' },
  { method: 'GET', path: '/v1/models' },
]

/** Start a fake upstream plus a gateway pointed at it, tracked for teardown. */
async function setup(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  opts: {
    apiKey?: string
    allowedHosts?: string[]
    routes?: ManagedRoute[]
    rewritableRoutes?: ManagedRoute[]
    rewriteRequestBody?: (route: string, body: unknown) => unknown
    mapErrorResponse?: (route: string, status: number, body: string) => object | null
  } = {}
): Promise<{ gw: ManagedGateway; upstream: FakeUpstream; apiKey: string }> {
  const upstream = await startFakeUpstream(handler)
  upstreams.push(upstream)
  const apiKey = opts.apiKey ?? generateGatewayKey()
  const gw = await startManagedGateway({
    upstream: { host: '127.0.0.1', port: upstream.port },
    apiKey,
    allowedHosts: opts.allowedHosts ?? [],
    routes: opts.routes ?? DEFAULT_TEST_ROUTES,
    ...(opts.rewritableRoutes ? { rewritableRoutes: opts.rewritableRoutes } : {}),
    ...(opts.rewriteRequestBody ? { rewriteRequestBody: opts.rewriteRequestBody } : {}),
    ...(opts.mapErrorResponse ? { mapErrorResponse: opts.mapErrorResponse } : {}),
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
  it('binds on 127.0.0.1, on a random port distinct from the upstream', async () => {
    const { gw, upstream } = await setup((_req, res) => res.end('ok'))
    expect(gw.host).toBe('127.0.0.1')
    expect(gw.port).toBeGreaterThan(0)
    expect(gw.port).not.toBe(upstream.port)
  })

  it('rejects a non-loopback upstream host', async () => {
    await expect(
      startManagedGateway({
        upstream: { host: '0.0.0.0', port: 1 },
        apiKey: 'x',
        allowedHosts: [],
        routes: DEFAULT_TEST_ROUTES,
      })
    ).rejects.toThrow(/loopback/)
  })

  it('rejects an empty api key: it is the only auth in front of an engine that checks none', async () => {
    const upstream = await startFakeUpstream((_req, res) => res.end('should not happen'))
    upstreams.push(upstream)

    await expect(
      startManagedGateway({
        upstream: { host: '127.0.0.1', port: upstream.port },
        apiKey: '',
        allowedHosts: [],
        routes: DEFAULT_TEST_ROUTES,
      })
    ).rejects.toThrow(/api key/)
  })
})

describe('bracketIfIpv6', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
    ['::1', '[::1]'],
    ['[::1]', '[::1]'],
  ])('%s -> %s', (input, expected) => {
    expect(bracketIfIpv6(input)).toBe(expected)
  })

  it('produces an origin every accepted loopback spelling can build a valid URL from', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(() => new URL(`http://${bracketIfIpv6(host)}:9000/v1/chat/completions`)).not.toThrow()
    }
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
    let seenAuthHeaders: IncomingMessage['headers'] | undefined
    const { gw, apiKey } = await setup((req, res) => {
      seenAuthHeaders = req.headers
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello from the container')
    })

    const res = await send(gw.port, {
      method: 'POST',
      headers: { 'host': '127.0.0.1', 'authorization': `Bearer ${apiKey}`, 'x-api-key': apiKey },
    })

    expect(res.status).toBe(200)
    expect(res.body).toBe('hello from the container')
    // The gateway's own key is this listener's secret, not the container's: it must not leak through.
    expect(seenAuthHeaders?.authorization).toBeUndefined()
    expect(seenAuthHeaders?.['x-api-key']).toBeUndefined()
  })

  it.skipIf(!ipv6LoopbackAvailable())(
    'proxies successfully to an upstream given as bare `::1`, not only `127.0.0.1`',
    async () => {
      const upstream = await startFakeUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('hello over ipv6')
      }, '::1')
      upstreams.push(upstream)

      const apiKey = generateGatewayKey()
      const gw = await startManagedGateway({
        upstream: { host: '::1', port: upstream.port },
        apiKey,
        allowedHosts: [],
        routes: DEFAULT_TEST_ROUTES,
      })
      gateways.push(gw)

      const res = await send(gw.port, {
        method: 'POST',
        headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
      })

      expect(res.status).toBe(200)
      expect(res.body).toBe('hello over ipv6')
    }
  )

  it('rejects the previous generation key once the gateway has closed and a new one started', async () => {
    const upstream = await startFakeUpstream((_req, res) => res.end('ok'))
    upstreams.push(upstream)

    const oldKey = generateGatewayKey()
    const gw1 = await startManagedGateway({
      upstream: { host: '127.0.0.1', port: upstream.port },
      apiKey: oldKey,
      allowedHosts: [],
      routes: DEFAULT_TEST_ROUTES,
    })
    await gw1.close()

    const gw2 = await startManagedGateway({
      upstream: { host: '127.0.0.1', port: upstream.port },
      apiKey: generateGatewayKey(),
      allowedHosts: [],
      routes: DEFAULT_TEST_ROUTES,
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
          method: 'POST',
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
          method: 'POST',
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

  it('closes the upstream connection when the client disconnects before any bytes come back (long prefill)', async () => {
    let upstreamReqClosedEarly = false

    const { gw, apiKey } = await setup((req, res) => {
      // A container mid-prefill: no writeHead, no bytes, for far longer than this test waits.
      const timer = setTimeout(() => {
        res.writeHead(200)
        res.end('too late')
      }, 5000)
      req.on('close', () => {
        clearTimeout(timer)
        upstreamReqClosedEarly = true
      })
    })

    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: gw.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
      })
      req.on('error', () => resolve())
      req.on('socket', (socket) => {
        socket.on('connect', () => {
          req.end()
          // Give the request a moment to actually reach the fake upstream before tearing it down.
          setTimeout(() => {
            req.destroy()
            resolve()
          }, 50)
        })
      })
    })

    await expect.poll(() => upstreamReqClosedEarly, { timeout: 2000 }).toBe(true)
  })
})

describe('rewriteRequestBody (task 2.13 fix rounds 1-2, ADR 2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway)', () => {
  const CHAT: ManagedRoute[] = [{ method: 'POST', path: '/v1/chat/completions' }]

  it('rewrites a POST JSON body before it reaches the upstream, with Content-Length recomputed for the new size', async () => {
    let seenBody = ''
    let seenContentLength = ''
    const { gw, apiKey } = await setup(
      (req, res) => {
        seenContentLength = String(req.headers['content-length'] ?? '')
        req.on('data', (chunk: Buffer) => (seenBody += chunk.toString('utf8')))
        req.on('end', () => res.end('ok'))
      },
      {
        rewritableRoutes: CHAT,
        rewriteRequestBody: (route, body) => ({
          route,
          ...(body as Record<string, unknown>),
          rewritten: true,
        }),
      }
    )

    const requestBody = JSON.stringify({ max_tokens: 99999 })
    const res = await send(gw.port, {
      method: 'POST',
      headers: {
        'host': '127.0.0.1',
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'content-length': String(requestBody.length),
      },
      body: requestBody,
    })

    expect(res.status).toBe(200)
    const parsed = JSON.parse(seenBody) as Record<string, unknown>
    expect(parsed).toEqual({ route: '/v1/chat/completions', max_tokens: 99999, rewritten: true })
    // The rewritten body is a different size than the client's original; the upstream must see a
    // length matching what was actually sent, never the client's stale original.
    expect(Number(seenContentLength)).toBe(Buffer.byteLength(seenBody))
    expect(Number(seenContentLength)).not.toBe(requestBody.length)
  })

  it('answers 400 with an OpenAI-shaped JSON body, without reaching the upstream, when the POST body is not valid JSON', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      { rewritableRoutes: CHAT, rewriteRequestBody: (_route, body) => body }
    )

    const res = await send(gw.port, {
      method: 'POST',
      headers: { 'host': '127.0.0.1', 'authorization': `Bearer ${apiKey}`, 'content-length': '9' },
      body: 'not json!',
    })

    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(res.body)).toMatchObject({ error: { type: 'invalid_request_error' } })
    expect(reached).toBe(false)
  })

  it('answers 400 with the thrown message, OpenAI-shaped, when rewriteRequestBody rejects the value with a validation error (AtomicCoreError INVALID_ARGUMENT)', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      {
        rewritableRoutes: CHAT,
        rewriteRequestBody: () => {
          throw new AtomicCoreError('INVALID_ARGUMENT', 'max_tokens must be a positive integer.')
        },
      }
    )

    const requestBody = JSON.stringify({ max_tokens: 'lots' })
    const res = await send(gw.port, {
      method: 'POST',
      headers: {
        'host': '127.0.0.1',
        'authorization': `Bearer ${apiKey}`,
        'content-length': String(requestBody.length),
      },
      body: requestBody,
    })

    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: {
        message: 'max_tokens must be a positive integer.',
        type: 'invalid_request_error',
        code: 'invalid_request_error',
      },
    })
    expect(reached).toBe(false)
  })

  it('answers 500 with a generic message, never the thrown detail, when rewriteRequestBody throws anything other than a validation error (findings-2.13-r3.md item 3)', async () => {
    // The gateway deliberately logs this one to its own console (it has no injected logger); silence
    // and inspect it here instead of leaving it printed as unexplained stderr noise.
    const loggedErrors: unknown[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      loggedErrors.push(args)
    })

    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      {
        rewritableRoutes: CHAT,
        rewriteRequestBody: () => {
          throw new Error('a secret internal stack detail nobody outside this process should see')
        },
      }
    )

    const requestBody = JSON.stringify({ max_tokens: 10 })
    const res = await send(gw.port, {
      method: 'POST',
      headers: {
        'host': '127.0.0.1',
        'authorization': `Bearer ${apiKey}`,
        'content-length': String(requestBody.length),
      },
      body: requestBody,
    })

    expect(res.status).toBe(500)
    expect(res.body).not.toContain('secret internal stack detail')
    expect(JSON.parse(res.body)).toEqual({
      error: {
        message: 'The request could not be processed.',
        type: 'server_error',
        code: 'internal_error',
      },
    })
    expect(reached).toBe(false)
    expect(loggedErrors.length).toBeGreaterThan(0)
    consoleError.mockRestore()
  })

  it('answers 500, not 400, for an AtomicCoreError whose code is not INVALID_ARGUMENT — only that one code is treated as a client-facing validation error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      {
        rewritableRoutes: CHAT,
        rewriteRequestBody: () => {
          throw new AtomicCoreError('IO_ERROR', 'disk full while rewriting (should never surface like this)')
        },
      }
    )

    const requestBody = JSON.stringify({ max_tokens: 10 })
    const res = await send(gw.port, {
      method: 'POST',
      headers: {
        'host': '127.0.0.1',
        'authorization': `Bearer ${apiKey}`,
        'content-length': String(requestBody.length),
      },
      body: requestBody,
    })

    expect(res.status).toBe(500)
    expect(res.body).not.toContain('disk full')
    expect(reached).toBe(false)
    consoleError.mockRestore()
  })

  it('answers 413 with an OpenAI-shaped JSON body, without reaching the upstream or attempting to parse a body over the cap', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      { rewritableRoutes: CHAT, rewriteRequestBody: (_route, body) => body }
    )

    const oversized = 'x'.repeat(MANAGED_GATEWAY_REWRITE_BODY_CAP_BYTES + 1)
    const res = await send(gw.port, {
      method: 'POST',
      headers: {
        'host': '127.0.0.1',
        'authorization': `Bearer ${apiKey}`,
        'content-length': String(oversized.length),
      },
      body: oversized,
    })

    expect(res.status).toBe(413)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(res.body)).toMatchObject({ error: { type: 'invalid_request_error' } })
    expect(reached).toBe(false)
  })

  // An HTTP-level test of "the connection stays open forever while the server waits to finish
  // reading" is inherently racy — the OS itself resets a connection the server closes with unread
  // bytes still queued, so a client that keeps writing past that point may see the reset before (or
  // instead of) the buffered response, independent of anything this gateway does (confirmed against
  // a minimal reproduction outside this test file). `readAndRewriteBody`'s own test above already
  // covers the real HTTP path end to end for a body sent in one normal `.end()` call (413, upstream
  // never reached). This tests the algorithmic claim itself — reading stops as soon as the running
  // total crosses the cap, not once the whole body has been read — directly against `readCappedBody`
  // and a source that never ends, with no HTTP or sockets involved at all.
  it('readCappedBody stops pulling from its source the moment the cap is exceeded, never asking for another chunk (findings-2.13-r2.md item 2)', async () => {
    const chunkSize = 1024
    let chunksProduced = 0
    async function* neverEndingChunks(): AsyncGenerator<Buffer> {
      for (;;) {
        chunksProduced += 1
        yield Buffer.alloc(chunkSize, 'x')
      }
    }

    const cap = 10 * chunkSize
    const result = await readCappedBody(neverEndingChunks(), cap)

    expect(result).toBe('too-large')
    // Enough chunks to cross the cap, and not meaningfully more — proof the generator was never
    // asked to keep producing once the running total already exceeded it.
    const chunksNeededToCrossCap = Math.floor(cap / chunkSize) + 1
    expect(chunksProduced).toBe(chunksNeededToCrossCap)
  })

  it('leaves a GET request untouched even with a rewriter configured (GET /v1/models is declared, but never rewritable)', async () => {
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('untouched')
      },
      {
        routes: [{ method: 'GET', path: '/v1/models' }],
        // No rewritableRoutes at all: the callback below exists, but nothing is ever rewritten.
        rewriteRequestBody: () => ({ should: 'never be reached for GET' }),
      }
    )

    const res = await send(gw.port, {
      path: '/v1/models',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(200)
    expect(res.body).toBe('untouched')
  })

  it('proxies exactly as before when no rewriter is configured at all', async () => {
    let seenBody = ''
    const { gw, apiKey } = await setup((req, res) => {
      req.on('data', (chunk: Buffer) => (seenBody += chunk.toString('utf8')))
      req.on('end', () => res.end('ok'))
    })

    const requestBody = JSON.stringify({ max_tokens: 1 })
    const res = await send(gw.port, {
      method: 'POST',
      headers: {
        'host': '127.0.0.1',
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: requestBody,
    })

    expect(res.status).toBe(200)
    expect(seenBody).toBe(requestBody)
  })

  it('streams a declared-but-not-rewritable route through byte-for-byte, never parsing it as JSON even when it looks like JSON', async () => {
    let seenBody = ''
    const { gw, apiKey } = await setup(
      (req, res) => {
        req.on('data', (chunk: Buffer) => (seenBody += chunk.toString('utf8')))
        req.on('end', () => res.end('ok'))
      },
      {
        routes: [
          { method: 'POST', path: '/v1/chat/completions' },
          { method: 'POST', path: '/v1/models' },
        ],
        rewritableRoutes: CHAT, // deliberately does not include POST /v1/models
        rewriteRequestBody: () => ({ this: 'would prove the rewriter ran, which it must not' }),
      }
    )

    const requestBody = JSON.stringify({ max_tokens: 99999 })
    const res = await send(gw.port, {
      path: '/v1/models',
      method: 'POST',
      headers: {
        'host': '127.0.0.1',
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: requestBody,
    })

    expect(res.status).toBe(200)
    expect(seenBody).toBe(requestBody)
  })

  it('still streams the response through unaffected when a rewriter is configured for the request side', async () => {
    const CHUNK_COUNT = 50
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        let i = 0
        const writeNext = (): void => {
          if (i >= CHUNK_COUNT) {
            res.end()
            return
          }
          res.write(`data: {"n":${i}}\n\n`)
          i += 1
          setImmediate(writeNext)
        }
        writeNext()
      },
      { rewritableRoutes: CHAT, rewriteRequestBody: (_route, body) => body }
    )

    const requestBody = JSON.stringify({ messages: [] })
    let received = ''
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'host': '127.0.0.1',
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')))
          res.on('end', resolve)
        }
      )
      req.on('error', reject)
      req.end(requestBody)
    })

    expect(received).toContain('"n":0')
    expect(received).toContain(`"n":${CHUNK_COUNT - 1}`)
  })

  it('gives the upstream a Content-Length and no Transfer-Encoding, even for a client that sent the request chunked (findings-2.13-r2.md item 10)', async () => {
    let seenBody = ''
    let seenContentLength = ''
    let seenTransferEncoding: string | undefined
    const { gw, apiKey } = await setup(
      (req, res) => {
        seenContentLength = String(req.headers['content-length'] ?? '')
        seenTransferEncoding = req.headers['transfer-encoding']
        req.on('data', (chunk: Buffer) => (seenBody += chunk.toString('utf8')))
        req.on('end', () => res.end('ok'))
      },
      { rewritableRoutes: CHAT, rewriteRequestBody: (_route, body) => body }
    )

    const requestBody = JSON.stringify({ max_tokens: 10 })
    await new Promise<void>((resolve, reject) => {
      // No content-length header at all, and two separate writes: Node's http client falls back to
      // `Transfer-Encoding: chunked` for exactly this shape of request.
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
        },
        (res) => {
          res.on('data', () => {})
          res.on('end', resolve)
        }
      )
      req.on('error', reject)
      req.write(requestBody.slice(0, 5))
      req.end(requestBody.slice(5))
    })

    expect(seenTransferEncoding).toBeUndefined()
    expect(Number(seenContentLength)).toBe(Buffer.byteLength(seenBody))
    expect(seenBody).toBe(requestBody)
  })
})

describe('declared routes (task 2.13 fix round 2, findings-2.13-r2.md item 3)', () => {
  it('answers 404 with an OpenAI-shaped JSON body, and never reaches the upstream, for a route the adapter did not declare', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      { routes: [{ method: 'GET', path: '/v1/models' }] }
    )

    const res = await send(gw.port, {
      path: '/update_weights',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(res.body)).toMatchObject({ error: { type: 'invalid_request_error' } })
    expect(reached).toBe(false)
  })

  it('proxies a request to a route the adapter declared', async () => {
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('declared')
      },
      { routes: [{ method: 'GET', path: '/v1/models' }] }
    )

    const res = await send(gw.port, {
      path: '/v1/models',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(200)
    expect(res.body).toBe('declared')
  })

  it('answers 404, not a decoded match, for a path with an encoded slash — the classic path-confusion trick', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      { routes: [{ method: 'GET', path: '/v1/models' }] }
    )

    // Decodes to /v1/models, but must not be treated as equal to the literal /v1/models route.
    const res = await send(gw.port, {
      path: '/v1%2Fmodels',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(404)
    expect(reached).toBe(false)
  })

  it('matches a route on its decoded path (an unambiguous encoding still resolves)', async () => {
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('decoded-match')
      },
      { routes: [{ method: 'GET', path: '/v1/models' }] }
    )

    // %6d decodes to "m": /v1/%6dodels -> /v1/models, no slash involved, unambiguous.
    const res = await send(gw.port, {
      path: '/v1/%6dodels',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(200)
    expect(res.body).toBe('decoded-match')
  })
})

describe('method matching (task 2.13 fix round 3, findings-2.13-r3.md item 1)', () => {
  it('answers 405 with an Allow header, OpenAI-shaped, never reaching the upstream, for a wrong method on a declared path', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      { routes: [{ method: 'POST', path: '/v1/chat/completions' }] }
    )

    // send()'s default method is GET; the only declared route for this path is POST.
    const res = await send(gw.port, {
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('POST')
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(res.body)).toMatchObject({
      error: { type: 'invalid_request_error', code: 'method_not_allowed' },
    })
    expect(reached).toBe(false)
  })

  it('answers 405 for the opposite mismatch too: POST on a path only declared for GET', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      { routes: [{ method: 'GET', path: '/v1/models' }] }
    )

    const res = await send(gw.port, {
      path: '/v1/models',
      method: 'POST',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('GET')
    expect(reached).toBe(false)
  })

  it('answers 405, not 200, for HEAD on a path only declared for GET — HEAD is never implied', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      { routes: [{ method: 'GET', path: '/v1/models' }] }
    )

    const res = await send(gw.port, {
      path: '/v1/models',
      method: 'HEAD',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('GET')
    expect(reached).toBe(false)
  })

  it('answers 405 for DELETE on a path declared only for GET and POST, listing both in Allow', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      {
        routes: [
          { method: 'GET', path: '/v1/models' },
          { method: 'POST', path: '/v1/models' },
        ],
      }
    )

    const res = await send(gw.port, {
      path: '/v1/models',
      method: 'DELETE',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(405)
    expect(res.headers['allow']).toBe('GET, POST')
    expect(reached).toBe(false)
  })

  it('proxies a POST that matches a declared route exactly, on a path that also has a different declared method', async () => {
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('matched')
      },
      {
        routes: [
          { method: 'GET', path: '/v1/models' },
          { method: 'POST', path: '/v1/models' },
        ],
      }
    )

    const res = await send(gw.port, {
      path: '/v1/models',
      method: 'POST',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(200)
    expect(res.body).toBe('matched')
  })

  it('answers 404, not 405, when the path itself is not declared for any method', async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('should not happen')
      },
      { routes: [{ method: 'GET', path: '/v1/models' }] }
    )

    const res = await send(gw.port, {
      path: '/update_weights',
      method: 'POST',
      headers: { host: '127.0.0.1', authorization: `Bearer ${apiKey}` },
    })

    expect(res.status).toBe(404)
    expect(reached).toBe(false)
  })
})

describe('engine error answers (task 2.14 fix round 1, findings-2.14-r1.md item 1)', () => {
  const OVERFLOW = '{"object":"error","message":"prompt too long (9000 > 8192)","code":400}'
  const mapped = {
    error: { message: 'mapped', type: 'invalid_request_error', code: 'context_length_exceeded' },
  }
  const auth = (apiKey: string) => ({ host: '127.0.0.1', authorization: `Bearer ${apiKey}` })

  it('answers the mapped OpenAI error for a non-2xx answer on a declared POST route', async () => {
    const seen: Array<[string, number, string]> = []
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(OVERFLOW)
      },
      {
        mapErrorResponse: (route, status, body) => {
          seen.push([route, status, body])
          return mapped
        },
      }
    )
    const res = await send(gw.port, { method: 'POST', headers: auth(apiKey), body: '{}' })
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toBe('application/json')
    expect(JSON.parse(res.body)).toEqual(mapped)
    expect(seen).toEqual([['/v1/chat/completions', 400, OVERFLOW]])
  })

  it("relays the engine's own error, status and type when the mapper does not know it", async () => {
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(422, { 'content-type': 'application/json', 'x-engine': 'kept' })
        res.end('{"detail":"bad sampling"}')
      },
      { mapErrorResponse: () => null }
    )
    const res = await send(gw.port, { method: 'POST', headers: auth(apiKey), body: '{}' })
    expect(res.status).toBe(422)
    expect(res.headers['x-engine']).toBe('kept')
    expect(res.body).toBe('{"detail":"bad sampling"}')
  })

  it('never reads a 2xx answer: a stream still arrives chunk by chunk, before the engine ends it', async () => {
    let finish: (() => void) | undefined
    const called: number[] = []
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: first\n\n')
        finish = () => res.end('data: [DONE]\n\n')
      },
      { mapErrorResponse: (_r, status) => (called.push(status), mapped) }
    )
    const first = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gw.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: auth(apiKey),
        },
        (res) => res.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(first).toBe('data: first\n\n')
    finish?.()
    expect(called).toEqual([])
  })

  it('leaves a non-2xx answer on a GET route alone', async () => {
    const called: number[] = []
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(503)
        res.end('warming up')
      },
      { mapErrorResponse: (_r, status) => (called.push(status), mapped) }
    )
    const res = await send(gw.port, { path: '/v1/models', headers: auth(apiKey) })
    expect(res.status).toBe(503)
    expect(res.body).toBe('warming up')
    expect(called).toEqual([])
  })

  it('answers a generic OpenAI error, same status, for an error body past the cap instead of buffering it', async () => {
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(Buffer.alloc(MANAGED_GATEWAY_ERROR_BODY_CAP_BYTES + 1, 0x61))
      },
      { mapErrorResponse: () => mapped }
    )
    const res = await send(gw.port, { method: 'POST', headers: auth(apiKey), body: '{}' })
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'upstream_error' } })
  })

  it.each<[number, string]>([
    [400, 'invalid_request_error'],
    [500, 'server_error'],
  ])('labels an error body past the cap by its status: %i is %s (final review M-4)', async (status, type) => {
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.writeHead(status, { 'content-type': 'text/plain' })
        res.end(Buffer.alloc(MANAGED_GATEWAY_ERROR_BODY_CAP_BYTES + 1, 0x61))
      },
      { mapErrorResponse: () => mapped }
    )
    const res = await send(gw.port, { method: 'POST', headers: auth(apiKey), body: '{}' })
    expect(res.status).toBe(status)
    expect(res.headers['content-type']).toBe('application/json')
    expect(JSON.parse(res.body)).toMatchObject({ error: { type, code: 'upstream_error' } })
  })

  it('tears the engine connection down when the client leaves while an error body is still arriving (final review M-4)', async () => {
    let upstreamClosed!: () => void
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve))
    let headSent!: () => void
    const stalled = new Promise<void>((resolve) => (headSent = resolve))
    const { gw, apiKey } = await setup(
      (_req, res) => {
        res.on('close', () => upstreamClosed())
        res.writeHead(400, { 'content-type': 'application/json' })
        // Part of an error body, then nothing: an engine stalled mid-answer.
        res.write('{"object":"error","message":"')
        headSent()
      },
      { mapErrorResponse: () => mapped }
    )
    const client = httpRequest({
      host: '127.0.0.1',
      port: gw.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: auth(apiKey),
    })
    client.on('error', () => {})
    client.end('{}')
    await stalled
    client.destroy()
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      closed.then(() => 'closed' as const),
      new Promise<'held'>((resolve) => (timer = setTimeout(() => resolve('held'), 2_000))),
    ])
    clearTimeout(timer)
    expect(outcome).toBe('closed')
  })

  it("answers a ManagedRequestRefusal thrown by the rewriter as a 400 with the refusal's own code", async () => {
    let reached = false
    const { gw, apiKey } = await setup(
      (_req, res) => {
        reached = true
        res.end('{}')
      },
      {
        rewritableRoutes: [{ method: 'POST', path: '/v1/chat/completions' }],
        rewriteRequestBody: () => {
          throw new ManagedRequestRefusal(
            "The model 'm' does not support tool calling.",
            'unsupported_capability'
          )
        },
      }
    )
    const res = await send(gw.port, { method: 'POST', headers: auth(apiKey), body: '{"tools":[1]}' })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: {
        message: "The model 'm' does not support tool calling.",
        type: 'invalid_request_error',
        code: 'unsupported_capability',
      },
    })
    expect(reached).toBe(false)
  })
})
