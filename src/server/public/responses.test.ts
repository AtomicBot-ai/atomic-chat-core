import { afterEach, describe, expect, it } from 'vitest'
import {
  closeAll,
  closedPort,
  localSession,
  postJson,
  remoteProvider,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('/responses', () => {
  it('passes MLX through to its own /v1/responses', async () => {
    const paths: string[] = []
    const { port } = await startUpstream((req, _body, res) => {
      paths.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"id":"resp_mlx"}')
    })
    const server = await startPublic({ sessions: [localSession(port, { provider: 'mlx', apiKey: '' })] })

    const res = await postJson(server, '/responses', { model: 'demo', input: 'hi' })

    expect(await res.json()).toEqual({ id: 'resp_mlx' })
    expect(paths).toEqual(['/v1/responses'])
  })

  it('answers 500 for a provider with no base URL, and 502 when the engine cannot be reached', async () => {
    const port = await closedPort()
    const server = await startPublic({
      remote: [remoteProvider({ baseUrl: null })],
      sessions: [localSession(port)],
    })

    const remote = await postJson(server, '/responses', { model: 'cloud-model' })
    const local = await postJson(server, '/responses', { model: 'demo', input: 'hi' })

    expect([remote.status, await remote.text()]).toEqual([500, 'Provider has no base_url'])
    expect(local.status).toBe(502)
    expect(await local.text()).toMatch(/^Proxy request to model failed: /)
  })

  it('passes an engine error through with its status', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('loading model')
    })
    const server = await startPublic({ sessions: [localSession(port)] })

    const res = await postJson(server, '/responses', { model: 'demo', input: 'hi' })

    expect([res.status, await res.text()]).toEqual([503, 'loading model'])
  })
})
