import { afterEach, describe, expect, it } from 'vitest'
import { relayedHeaders, sendUpstream, withIdleTimeout } from './wire.js'
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
