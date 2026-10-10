import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeGeneration, probeReadiness } from './readiness.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const probe = { path: '/health', expectedStatus: 200 }

describe('probeReadiness', () => {
  it('is ready only on the expected status at the probe path under the target', async () => {
    const seen: string[] = []
    const base = await serve((req, res) => {
      seen.push(req.url ?? '')
      res.statusCode = 200
      res.end('ok')
    })
    expect(await probeReadiness(fetch, { base_url: base }, probe, 2_000)).toBe('ready')
    expect(seen).toEqual(['/health'])
  })

  it('is not ready on any other status', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 503
      res.end('loading')
    })
    expect(await probeReadiness(fetch, { base_url: base }, probe, 2_000)).toBe('not-ready')
  })

  it('never follows a redirect: the target it points at is not the engine core validated', async () => {
    let elsewhereHit = false
    const elsewhere = await serve((_req, res) => {
      elsewhereHit = true
      res.statusCode = 200
      res.end('ok')
    })
    const base = await serve((_req, res) => {
      res.statusCode = 302
      res.setHeader('location', `${elsewhere}/health`)
      res.end()
    })
    expect(await probeReadiness(fetch, { base_url: base }, probe, 2_000)).toBe('redirect')
    expect(elsewhereHit).toBe(false)
  })

  it('is not ready when nothing listens yet', async () => {
    const base = await serve((_req, res) => res.end())
    const port = new URL(base).port
    await new Promise<void>((r) => servers.pop()!.close(() => r()))
    expect(await probeReadiness(fetch, { base_url: `http://127.0.0.1:${port}` }, probe, 2_000)).toBe(
      'not-ready'
    )
  })

  it('is not ready when the engine accepts but never answers within the probe timeout', async () => {
    const base = await serve(() => {
      /* never answers */
    })
    expect(await probeReadiness(fetch, { base_url: base }, probe, 100)).toBe('not-ready')
  })

  it('asks fetch not to follow redirects and to give up at the timeout', async () => {
    let init: RequestInit | undefined
    const fakeFetch = (async (_url: string, i?: RequestInit) => {
      init = i
      return new Response('', { status: 200 })
    }) as typeof fetch
    await probeReadiness(fakeFetch, { base_url: 'http://127.0.0.1:1' }, probe, 1_000)
    expect(init?.redirect).toBe('manual')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('probeGeneration', () => {
  const generation = {
    modelsPath: '/v1/models',
    path: '/v1/chat/completions',
    body: { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 },
  }
  /** An engine whose model list answers `models` and whose chat answers `chat`. */
  const engine = (models: () => Response, chat: () => Response = () => Response.json({ choices: [] })) =>
    (async (url: string | URL | Request) =>
      String(url).endsWith('/v1/models') ? models() : chat()) as typeof fetch
  const target = { base_url: 'http://engine.invalid' }
  const list = (data: unknown) => () => Response.json({ object: 'list', data })

  it('is ok when the engine generates', async () => {
    expect(await probeGeneration(engine(list([{ id: 'm' }])), target, generation, 1_000)).toEqual({
      kind: 'ok',
    })
  })

  it('is ok for a 2xx body that is not JSON at all', async () => {
    const outcome = await probeGeneration(
      engine(list([{ id: 'm' }]), () => new Response('H', { status: 200 })),
      target,
      generation,
      1_000
    )
    expect(outcome).toEqual({ kind: 'ok' })
  })

  it.each([
    ['a list that is not an object', () => Response.json('nope')],
    ['a list with no data array', () => Response.json({ object: 'list' })],
    ['an empty list', list([])],
    ['an entry with an empty id', list([{ id: '' }])],
    ['an entry with no id', list([{}])],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a refused model list', () => new Response('no', { status: 503 })],
  ])('is unanswered, with no request sent, for %s', async (_label, models) => {
    let chats = 0
    const outcome = await probeGeneration(
      engine(models, () => {
        chats++
        return Response.json({})
      }),
      target,
      generation,
      1_000
    )
    expect(outcome.kind).toBe('unanswered')
    expect(chats).toBe(0)
  })

  it('is unanswered when the connection fails', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    expect(await probeGeneration(refused, target, generation, 1_000)).toEqual({
      kind: 'unanswered',
      reason: 'TypeError: fetch failed',
    })
  })

  it('is refused with the status and at most 2000 characters of the body', async () => {
    const outcome = await probeGeneration(
      engine(list([{ id: 'm' }]), () => new Response('x'.repeat(5_000), { status: 500 })),
      target,
      generation,
      1_000
    )
    expect(outcome).toEqual({ kind: 'refused', status: 500, body: 'x'.repeat(2_000) })
  })

  it('gives up after its timeout, as unanswered, against a real server that never answers', async () => {
    const base = await serve(() => {})
    const outcome = await probeGeneration(fetch, { base_url: base }, generation, 50)
    expect(outcome.kind).toBe('unanswered')
  })
})
