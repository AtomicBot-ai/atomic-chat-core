import { afterEach, describe, expect, it } from 'vitest'
import { relayedHeaders, sendUpstream, readBody, readUpstreamText, withIdleTimeout } from './wire.js'
import { createServer as createHttpsServer, globalAgent } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tlsFixture } from '../../../test/helpers/proxy-servers.js'
import type { UpstreamResponse } from './wire.js'
import { closeAll, closedPort, startUpstream } from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('withIdleTimeout', () => {
  it('gives up on a source that stays silent past the timeout', async () => {
    async function* silentAfterOne() {
      yield 'first'
      await new Promise((r) => setTimeout(r, 1000))
      yield 'never'
    }
    const seen: string[] = []
    for await (const chunk of withIdleTimeout(silentAfterOne(), 30)) seen.push(chunk)
    expect(seen).toEqual(['first'])
  })
})

describe('sendUpstream', () => {
  it('sends the listed headers with Host and a length of its own', async () => {
    let seen: Record<string, unknown> = {}
    const { port } = await startUpstream((req, _body, res) => {
      seen = req.headers
      res.end('ok')
    })

    const response = await sendUpstream(`http://127.0.0.1:${port}/x`, {
      method: 'POST',
      headers: [
        ['Content-Length', '999'],
        ['X-Trace', 't'],
      ],
      body: 'abc',
      connectTimeoutMs: 1000,
    })
    response.body.resume()

    expect(seen).toMatchObject({ 'host': `127.0.0.1:${port}`, 'content-length': '3', 'x-trace': 't' })
  })

  it('keeps verified TLS requests and repeated cloud responses on their existing route', async () => {
    const previousCa = globalAgent.options.ca
    globalAgent.options.ca = tlsFixture('ca.pem')
    const server = createHttpsServer(
      { key: tlsFixture('server.key'), cert: tlsFixture('server.pem') },
      (req, res) => {
        req.resume()
        req.on('end', () => {
          res.setHeader('X-Upstream', 'tls')
          res.end('verified')
        })
      }
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      for (let turn = 0; turn < 2; turn++) {
        const response = await sendUpstream(`https://localhost:${port}/chat`, {
          method: 'POST',
          headers: [['X-Trace', String(turn)]],
          body: '{}',
          connectTimeoutMs: 1000,
        })
        expect(response.status).toBe(200)
        expect(
          response.headers.some(([name, value]) => name.toLowerCase() === 'x-upstream' && value === 'tls')
        ).toBe(true)
        expect((await readBody(response.body)).toString()).toBe('verified')
      }
      const refused = await closedPort()
      await expect(
        sendUpstream(`https://localhost:${refused}/x`, {
          method: 'GET',
          headers: [],
          connectTimeoutMs: 1000,
        })
      ).rejects.toThrow(/error sending request for url/)
    } finally {
      if (previousCa === undefined) delete globalAgent.options.ca
      else globalAgent.options.ca = previousCa
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('finishes a loopback response with no body or content type', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(204)
      res.end()
    })
    const response = await sendUpstream(`http://127.0.0.1:${port}/empty`, {
      method: 'GET',
      headers: [],
      connectTimeoutMs: 1000,
    })
    expect(response.status).toBe(204)
    expect(response.contentType).toBeUndefined()
    expect((await readBody(response.body)).length).toBe(0)
  })

  it('reports a truncated error response rather than leaving its reader pending', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(500, { 'Content-Length': '500' })
      res.end('partial')
    })
    const response = await sendUpstream(`http://127.0.0.1:${port}/broken`, {
      method: 'GET',
      headers: [],
      connectTimeoutMs: 1000,
    })
    expect(response.status).toBe(500)
    expect(await readUpstreamText(response)).toMatch(/^Failed to read error body:/)
    expect(response.body.destroyed).toBe(true)
  })

  it('reports a refused connection and a malformed URL as unreachable', async () => {
    const port = await closedPort()
    await expect(
      sendUpstream(`http://127.0.0.1:${port}/x`, { method: 'GET', headers: [], connectTimeoutMs: 1000 })
    ).rejects.toThrow(/error sending request for url/)
    await expect(
      sendUpstream('not a url', { method: 'GET', headers: [], connectTimeoutMs: 1000 })
    ).rejects.toThrow(/builder error/)
  })
})

describe('relayedHeaders', () => {
  it("drops the upstream's CORS, length and hop-by-hop headers and appends ours", () => {
    const upstream = {
      headers: [
        ['Content-Type', 'text/event-stream'],
        ['Access-Control-Allow-Origin', '*'],
        ['Content-Length', '10'],
        ['Transfer-Encoding', 'chunked'],
      ],
    } as unknown as UpstreamResponse

    expect(relayedHeaders(upstream, [['Vary', 'Origin']])).toEqual([
      ['Content-Type', 'text/event-stream'],
      ['Vary', 'Origin'],
    ])
  })
})
