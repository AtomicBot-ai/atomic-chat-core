import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvents } from '../contracts/index.js'
import { PublicServer, stoppedState, upstreamPath } from './public.js'
import type { ForwardTarget, PublicServerDeps, PublicServerOptions } from './public.js'

/** A stand-in backend: records what it received and can stream forever until the caller gives up. */
interface Upstream {
  url: string
  received: Array<{ path: string; auth: string | undefined; body: string }>
  aborted: number
  close: () => Promise<void>
}

async function startUpstream(): Promise<Upstream> {
  const received: Upstream['received'] = []
  let aborted = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ path: req.url ?? '', auth: req.headers.authorization, body })
      const parsed = body ? (JSON.parse(body) as { stream?: boolean; fail?: boolean }) : {}
      if (parsed.fail) {
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'backend exploded' } }))
      }
      if (!parsed.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }] }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n')
      const timer = setInterval(() => res.write('data: {"choices":[{"delta":{"content":"more"}}]}\n\n'), 20)
      res.on('close', () => {
        clearInterval(timer)
        if (!res.writableEnded) aborted++
      })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    received,
    get aborted() {
      return aborted
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      }),
  } as Upstream
}

let upstream: Upstream
const servers: PublicServer[] = []
let events: Array<{ name: string; payload: unknown }> = []

beforeEach(async () => {
  upstream = await startUpstream()
  events = []
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  await upstream.close()
})

async function start(
  options: PublicServerOptions = {},
  deps: Partial<PublicServerDeps> = {}
): Promise<PublicServer> {
  const target: ForwardTarget = { baseUrl: upstream.url, apiKey: 'session-key' }
  const server = await PublicServer.start(
    {
      listModels: () => [{ id: 'demo' }],
      resolveTarget: (model) => (model === 'demo' ? target : undefined),
      emit: (name, payload) => events.push({ name, payload: payload as CoreEvents[typeof name] }),
      ...deps,
    },
    { port: 0, ...options }
  )
  servers.push(server)
  return server
}

describe('routes', () => {
  it('answers the liveness probe the CLI uses, without an API key', async () => {
    const server = await start({ apiKey: 'secret' })
    const res = await fetch(`http://127.0.0.1:${server.port}/`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('lists loaded models in OpenAI shape', async () => {
    const server = await start()
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`)
    expect(await res.json()).toEqual({
      object: 'list',
      data: [{ id: 'demo', object: 'model', created: 0, owned_by: 'atomic-chat' }],
    })
  })

  it('404s an unknown path and a path outside the prefix', async () => {
    const server = await start({ prefix: '/api' })
    expect((await fetch(`http://127.0.0.1:${server.port}/api/nope`, { method: 'POST' })).status).toBe(400)
    expect((await fetch(`http://127.0.0.1:${server.port}/v1/models`)).status).toBe(404)
    const res = await fetch(`http://127.0.0.1:${server.port}/api/models`)
    expect(res.status).toBe(200)
    expect(server.url.endsWith('/api')).toBe(true)
  })
})

describe('api key gate', () => {
  it('accepts the key as Bearer or X-Api-Key and rejects anything else', async () => {
    const server = await start({ apiKey: 'secret' })
    const base = `http://127.0.0.1:${server.port}/v1/models`
    expect((await fetch(base)).status).toBe(401)
    expect((await fetch(base, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(base, { headers: { authorization: 'Bearer secret' } })).status).toBe(200)
    expect((await fetch(base, { headers: { 'x-api-key': 'secret' } })).status).toBe(200)
  })

  it('is open when no key is configured', async () => {
    const server = await start()
    expect((await fetch(`http://127.0.0.1:${server.port}/v1/models`)).status).toBe(200)
  })
})

describe('forwarding', () => {
  it('sends the body upstream with the session key and returns the answer', async () => {
    const server = await start()
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as object).toMatchObject({ id: 'chatcmpl-1' })
    // llama-server speaks the OpenAI paths under /v1 whatever prefix this server exposes.
    expect(upstream.received[0]).toMatchObject({ path: '/v1/chat/completions', auth: 'Bearer session-key' })
    expect(JSON.parse(upstream.received[0]?.body ?? '{}')).toMatchObject({ model: 'demo' })
    expect(events.map((e) => e.name)).toEqual(['api:request', 'api:request'])
    expect(events[1]?.payload).toMatchObject({
      phase: 'finished',
      status: 200,
      endpoint: '/chat/completions',
    })
  })

  it('streams SSE chunks through as they arrive', async () => {
    const server = await start()
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'demo', stream: true }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"content":"one"')
    await reader.cancel()
  })

  it('aborts the backend request when the client hangs up mid-stream', async () => {
    const server = await start()
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'demo', stream: true }),
      signal: controller.signal,
    })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    controller.abort()
    await waitFor(() => upstream.aborted > 0)
    expect(upstream.aborted).toBeGreaterThan(0)
  })

  it('reports a model that is not loaded and a request with no model at all', async () => {
    const server = await start()
    const notLoaded = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'ghost' }),
    })
    expect(notLoaded.status).toBe(404)
    expect((await notLoaded.json()) as object).toMatchObject({ error: { code: 'MODEL_NOT_LOADED' } })

    const noModel = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    })
    expect(noModel.status).toBe(400)
  })

  it('passes an upstream failure through with its status', async () => {
    const server = await start()
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'demo', fail: true }),
    })
    expect(res.status).toBe(500)
    expect((await res.json()) as object).toMatchObject({ error: { message: 'backend exploded' } })
  })

  it('reports a backend that cannot be reached as a gateway failure', async () => {
    const server = await start({}, { resolveTarget: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: '' }) })
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'demo' }),
    })
    expect(res.status).toBe(502)
    expect((await res.json()) as object).toMatchObject({ error: { code: 'IO_ERROR' } })
  })
})

describe('upstreamPath', () => {
  it('adds the /v1 the backend expects, and never doubles it', () => {
    expect(upstreamPath('/chat/completions')).toBe('/v1/chat/completions')
    expect(upstreamPath('/v1/chat/completions')).toBe('/v1/chat/completions')
    expect(upstreamPath('/embeddings')).toBe('/v1/embeddings')
  })
})

describe('host gate and CORS', () => {
  it('refuses an untrusted Host and accepts a configured one', async () => {
    const server = await start({ trustedHosts: ['app.internal'] })
    expect(await rawStatus(server.port, '/v1/models', { host: 'evil.example.com' })).toBe(403)
    expect(await rawStatus(server.port, '/v1/models', { host: 'app.internal' })).toBe(200)
    const open = await start({ trustedHosts: ['*'] })
    expect(await rawStatus(open.port, '/v1/models', { host: 'anything.example.com' })).toBe(200)
  })

  it('adds CORS headers and answers preflight only when enabled', async () => {
    const off = await start()
    expect(
      (await fetch(`http://127.0.0.1:${off.port}/v1/models`)).headers.get('access-control-allow-origin')
    ).toBeNull()
    const on = await start({ corsEnabled: true })
    const res = await fetch(`http://127.0.0.1:${on.port}/v1/models`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const preflight = await fetch(`http://127.0.0.1:${on.port}/v1/chat/completions`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
  })
})

describe('lifecycle', () => {
  it('reports its state and a stopped state that remembers where it was', async () => {
    const server = await start({ apiKey: 'secret', prefix: '/v1' })
    const state = server.state()
    expect(state).toMatchObject({ running: true, host: '127.0.0.1', prefix: '/v1', requires_api_key: true })
    expect(state.pid).toBe(process.pid)
    expect(stoppedState(state)).toMatchObject({ running: false, port: state.port, pid: null })
    expect(stoppedState()).toMatchObject({ running: false, port: 1337, prefix: '/v1' })
  })

  it('refuses to bind a port that is already taken', async () => {
    const first = await start()
    await expect(start({ port: first.port })).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: expect.stringContaining('already in use') as unknown as string,
    })
  })
})

function rawStatus(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    void import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}
