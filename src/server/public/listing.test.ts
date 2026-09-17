import { afterEach, describe, expect, it } from 'vitest'
import { museCatalogEntry } from './listing.js'
import {
  closeAll,
  closedPort,
  localSession,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('museCatalogEntry', () => {
  it('advertises a larger context for remote models than for local ones', () => {
    const limit = (owner: string) =>
      (museCatalogEntry('m', owner) as { metadata: { 'muse-code': { limit: { context: number } } } })
        .metadata['muse-code'].limit.context
    expect(limit('remote')).toBe(200_000)
    expect(limit('llama.cpp')).toBe(32_768)
  })
})

describe('/metrics', () => {
  it('takes the model from X-Model when the query has none, but not when the query names an empty one', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok 1\n')
    })
    const server = await startPublic({ sessions: [localSession(port)] })
    const base = `http://127.0.0.1:${server.port}/v1/metrics`

    expect((await fetch(base, { headers: { 'x-model': 'demo' } })).status).toBe(200)
    expect((await fetch(`${base}?model=`, { headers: { 'x-model': 'demo' } })).status).toBe(400)
  })

  it('answers 502 when llama-server cannot be reached', async () => {
    const port = await closedPort()
    const server = await startPublic({ sessions: [localSession(port)] })

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/metrics?model=demo`)

    expect(res.status).toBe(502)
    expect(await res.text()).toMatch(/^Failed to fetch metrics from llama-server: /)
  })
})
