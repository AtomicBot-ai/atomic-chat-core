import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { tlsFixture } from '../../test/helpers/proxy-servers.js'
import { PublicServer } from '../server/public/index.js'
import {
  PROBE_BODY_CAP,
  PROBE_MARKER,
  PublicProber,
  bodyIsOurs,
  probeOnce,
  resolveEdgeAddresses,
} from './probe.js'

const servers: Array<{ close: () => Promise<unknown> | void }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const OURS = JSON.stringify({ openapi: '3.0.0', info: { title: PROBE_MARKER } })

/** Serves `body` with `status` on every path; returns the base URL. */
async function stub(status: number, body: string | (() => string)): Promise<string> {
  const server: Server = createServer((_req, res) => {
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(typeof body === 'string' ? body : body())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push({ close: () => new Promise((resolve) => server.close(resolve)) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// The tests of the app's `remote_access/probe.rs`.
describe('bodyIsOurs', () => {
  it.each([
    ['this server', OURS, true],
    ['another OpenAPI document', JSON.stringify({ info: { title: 'Somebody Else' } }), false],
    ['a document with no title', JSON.stringify({ info: {} }), false],
    ['JSON that is not an object', 'null', false],
    ["Cloudflare's error page", '<html>error code: 1033</html>', false],
    ['nothing', '', false],
  ])('%s → %s', (_what, body, expected) => expect(bodyIsOurs(body)).toBe(expected))
})

describe('probeOnce', () => {
  it('recognises this server, with or without a trailing slash on the base URL', async () => {
    const base = await stub(200, OURS)
    expect(await probeOnce(fetch, base, 2000)).toBe('ours')
    expect(await probeOnce(fetch, `${base}/`, 2000)).toBe('ours')
  })

  it('treats any other answer as foreign: an error status, another body, an oversized one', async () => {
    expect(await probeOnce(fetch, await stub(530, 'error code: 1033'), 2000)).toBe('foreign')
    expect(await probeOnce(fetch, await stub(200, '<html>captive portal</html>'), 2000)).toBe('foreign')
    const huge = `{"info":{"title":"${PROBE_MARKER}"},"pad":"${'x'.repeat(PROBE_BODY_CAP)}"}`
    expect(await probeOnce(fetch, await stub(200, huge), 2000)).toBe('foreign')
  })

  it('reports no answer at all as unreachable: a refused port, a server that never answers, an abort', async () => {
    expect(await probeOnce(fetch, 'http://127.0.0.1:9', 2000)).toBe('unreachable')
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    servers.push({
      close: () => {
        silent.closeAllConnections()
        return new Promise((resolve) => silent.close(resolve))
      },
    })
    const base = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`
    expect(await probeOnce(fetch, base, 150)).toBe('unreachable')
    expect(await probeOnce(fetch, await stub(200, OURS), 2000, AbortSignal.abort())).toBe('unreachable')
  })

  it("matches the document the core's public server really serves", async () => {
    const server = await PublicServer.start(
      {
        findLocal: () => undefined,
        listLocal: () => [],
        providers: () => new Map(),
        increaseCtx: async () => ({ ok: false }),
      },
      { port: 0, apiKey: 'a-key-the-probe-does-not-have', trustedHosts: [] }
    )
    servers.push(server)
    // No key and no trusted host: the probe path answers anyway, which is why it was chosen.
    expect(await probeOnce(fetch, `http://127.0.0.1:${server.port}`, 2000)).toBe('ours')
  })
})

describe('resolveEdgeAddresses', () => {
  it('keeps at most two distinct addresses, IPv4 first', async () => {
    const resolved = await resolveEdgeAddresses(async () => [
      { address: '2606:4700::1', family: 6 },
      { address: '104.16.0.1', family: 4 },
      { address: '104.16.0.1', family: 4 },
      { address: '104.16.0.2', family: 4 },
    ])
    expect(resolved).toEqual([
      { host: '104.16.0.1', port: 443 },
      { host: '104.16.0.2', port: 443 },
    ])
  })

  it('never throws with the real resolver, online or not, and never answers more than two addresses', async () => {
    const resolved = await resolveEdgeAddresses()
    expect(resolved.length).toBeLessThanOrEqual(2)
    for (const address of resolved) expect(address).toEqual({ host: expect.any(String), port: 443 })
  })

  it('answers nothing when the edge does not resolve', async () => {
    expect(
      await resolveEdgeAddresses(async () => {
        throw new Error('ENOTFOUND')
      })
    ).toEqual([])
  })
})

describe('PublicProber', () => {
  const TUNNEL = 'https://calm-river-demo.trycloudflare.com'
  const fast = { edgeWaitMaxMs: 400, edgeRetryDelayMs: 10, hostnameRetryDelayMs: 10, attemptTimeoutMs: 300 }

  /** A TLS server with the tunnel-name certificate, standing in for Cloudflare's edge. */
  async function startEdge(answer: () => { status: number; body: string }) {
    const seen: Array<string | undefined> = []
    const edge = createTlsServer(
      { key: tlsFixture('tunnel.key'), cert: tlsFixture('tunnel.pem') },
      (req, res) => {
        seen.push(req.headers.host)
        const { status, body } = answer()
        res.writeHead(status, { 'content-type': 'application/json' }).end(body)
      }
    )
    await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve))
    servers.push({ close: () => new Promise((resolve) => edge.close(resolve)) })
    return { address: { host: '127.0.0.1', port: (edge.address() as AddressInfo).port }, seen }
  }

  it('reaches the tunnel through the edge by its name, before that name resolves anywhere', async () => {
    const edge = await startEdge(() => ({ status: 200, body: OURS }))
    const prober = new PublicProber({
      edgeAddresses: async () => [edge.address],
      ca: tlsFixture('tunnel.pem'),
      timings: fast,
    })
    expect(await prober.verify(TUNNEL, 2000)).toBe(true)
    expect(edge.seen).toEqual(['calm-river-demo.trycloudflare.com'])
  })

  it("keeps asking while the edge answers with Cloudflare's own page, until the tunnel is there", async () => {
    let calls = 0
    const edge = await startEdge(() =>
      ++calls < 3 ? { status: 530, body: 'error code: 1033' } : { status: 200, body: OURS }
    )
    const prober = new PublicProber({
      edgeAddresses: async () => [edge.address],
      ca: tlsFixture('tunnel.pem'),
      timings: fast,
    })
    expect(await prober.verify(TUNNEL, 2000)).toBe(true)
    expect(calls).toBe(3)
  })

  it('gives up on an edge that never answers after two rounds, then on the hostname when the budget ends', async () => {
    const attempts: string[] = []
    const prober = new PublicProber({
      edgeAddresses: async () => [{ host: '127.0.0.1', port: 9 }],
      fetchFor: (policy) => async () => {
        attempts.push(policy.connectTo ? 'edge' : 'hostname')
        throw new Error('ECONNREFUSED')
      },
      timings: fast,
    })
    const started = Date.now()
    expect(await prober.verify(TUNNEL, 120)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(attempts.filter((kind) => kind === 'edge')).toHaveLength(2)
    expect(attempts.filter((kind) => kind === 'hostname').length).toBeGreaterThan(0)
  })

  it('falls back to the hostname when the edge cannot be resolved at all', async () => {
    const attempts: string[] = []
    const base = await stub(200, OURS)
    const prober = new PublicProber({
      edgeAddresses: async () => [],
      fetchFor: (policy) => (_input, init) => {
        attempts.push(policy.connectTo ? 'edge' : 'hostname')
        return fetch(`${base}/openapi.json`, init)
      },
      timings: fast,
    })
    expect(await prober.verify(TUNNEL, 2000)).toBe(true)
    expect(attempts).toEqual(['hostname'])
  })

  it('never reports a foreign server as reachable, however long it keeps answering', async () => {
    const edge = await startEdge(() => ({
      status: 200,
      body: JSON.stringify({ info: { title: 'Somebody Else' } }),
    }))
    const prober = new PublicProber({
      edgeAddresses: async () => [edge.address],
      fetchFor: (policy) =>
        policy.connectTo
          ? // The edge keeps answering as somebody else; the hostname does not exist.
            async (input, init) =>
              (await import('../downloads/index.js')).createPolicyFetch(policy)(input, init)
          : async () => {
              throw new Error('ENOTFOUND')
            },
      ca: tlsFixture('tunnel.pem'),
      timings: fast,
    })
    expect(await prober.verify(TUNNEL, 500)).toBe(false)
    expect(edge.seen.length).toBeGreaterThan(1)
  })

  it('stops waiting between rounds the moment it is told to', async () => {
    const stop = new AbortController()
    const prober = new PublicProber({
      edgeAddresses: async () => [{ host: '127.0.0.1', port: 9 }],
      fetchFor: () => async () => {
        // Something answers, but not this server: the prober would wait and ask again.
        setTimeout(() => stop.abort(), 20)
        return new Response('error code: 1033', { status: 530 })
      },
      timings: { ...fast, edgeRetryDelayMs: 60_000 },
    })
    const started = Date.now()
    expect(await prober.verify(TUNNEL, 120_000, stop.signal)).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('resolves the edge by itself when nobody stands in for it', async () => {
    // No network is needed for the answer to be `false`: with or without an edge to reach, a refused
    // loopback port is never this server.
    const prober = new PublicProber({
      fetchFor: () => async () => {
        throw new Error('ECONNREFUSED')
      },
      timings: fast,
    })
    expect(await prober.verify(TUNNEL, 100)).toBe(false)
  })

  it('stops at once when it is told to, and refuses something that is not a URL', async () => {
    const prober = new PublicProber({
      edgeAddresses: async () => [{ host: '127.0.0.1', port: 9 }],
      timings: fast,
    })
    expect(await prober.verify(TUNNEL, 60_000, AbortSignal.abort())).toBe(false)
    expect(await prober.verify('not a url', 1000)).toBe(false)
  })
})
