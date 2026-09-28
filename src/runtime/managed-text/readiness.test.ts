import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeReadiness } from './readiness.js'

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
