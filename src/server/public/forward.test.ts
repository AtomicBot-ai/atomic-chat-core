import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ErrorReport } from '../../telemetry/index.js'
import { sseEvent } from './forward.js'
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

describe('streaming', () => {
  it('tears the upstream down when the client hangs up mid-stream', async () => {
    let upstreamClosed = false
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"n":1}\n\n')
      const timer = setInterval(() => res.write('data: {"n":2}\n\n'), 10)
      res.on('close', () => {
        clearInterval(timer)
        upstreamClosed = true
      })
    })
    const server = await startPublic({ sessions: [localSession(port)] })
    const controller = new AbortController()

    const res = await postJson(
      server,
      '/chat/completions',
      { model: 'demo', stream: true },
      { signal: controller.signal }
    )
    await res.body!.getReader().read()
    controller.abort()

    await expect.poll(() => upstreamClosed, { timeout: 2000 }).toBe(true)
  })
})

describe('compute failures', () => {
  it('asks only llama.cpp upstream for a same-context reload', async () => {
    const triggers: string[] = []
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Compute error' } }))
    })
    const server = await startPublic({
      sessions: [localSession(port), localSession(port, { provider: 'llamacpp', modelId: 'turbo' })],
      increaseCtx: (_p, _m, trigger) => {
        triggers.push(trigger)
        return Promise.resolve({ ok: true })
      },
    })

    expect((await postJson(server, '/chat/completions', { model: 'demo' })).status).toBe(400)
    expect((await postJson(server, '/chat/completions', { model: 'turbo' })).status).toBe(400)
    expect(triggers).toEqual(['compute_error_recovery'])
  })
})

describe('remote providers', () => {
  it('reports an unreachable provider as a gateway failure, not a retriable outage', async () => {
    const port = await closedPort()
    const server = await startPublic({ remote: [remoteProvider({ baseUrl: `http://127.0.0.1:${port}/v1` })] })

    const res = await postJson(server, '/chat/completions', { model: 'cloud-model' })

    expect(res.status).toBe(502)
    expect(res.headers.get('retry-after')).toBeNull()
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_unreachable')
  })

  it('answers 500 for a provider with no base URL', async () => {
    const server = await startPublic({ remote: [remoteProvider({ baseUrl: null })] })

    const res = await postJson(server, '/chat/completions', { model: 'cloud-model' })

    expect([res.status, await res.text()]).toEqual([500, 'Internal routing error'])
  })

  it('lets a provider header replace a client header of the same name, and the key win over both', async () => {
    let seen: IncomingMessage['headers'] = {}
    const { port } = await startUpstream((req, _body, res) => {
      seen = req.headers
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const server = await startPublic({
      remote: [
        remoteProvider({
          baseUrl: `http://127.0.0.1:${port}/v1`,
          customHeaders: [
            { header: 'X-Org', value: 'from-provider' },
            { header: 'Authorization', value: 'Basic nope' },
          ],
        }),
      ],
    })

    await postJson(
      server,
      '/chat/completions',
      { model: 'cloud-model' },
      { headers: { 'content-type': 'application/json', 'x-org': 'from-client' } }
    )

    expect(seen['x-org']).toBe('from-provider')
    expect(seen['authorization']).toBe('Bearer sk')
  })
})

describe('sseEvent', () => {
  it('names the frame after the event type, or `message` without one', () => {
    expect(sseEvent({ type: 'ping', b: 1, a: 2 })).toBe('event: ping\ndata: {"a":2,"b":1,"type":"ping"}\n\n')
    expect(sseEvent([1])).toBe('event: message\ndata: [1]\n\n')
  })
})

describe('error reports', () => {
  it('reports a failing local engine: compute failures as warnings, other 5xx as errors, 4xx never', async () => {
    const replies = [
      [500, { error: { message: 'Compute error: out of memory' } }],
      [503, { error: { message: 'Loading model' } }],
      [400, { error: { message: 'the request exceeds the available context size' } }],
    ] as const
    let next = 0
    const { port } = await startUpstream((_req, _body, res) => {
      const [status, body] = replies[next++]!
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    const captured: ErrorReport[] = []
    const server = await startPublic({
      sessions: [localSession(port, { provider: 'mlx' })],
      errors: { capture: (report) => captured.push(report) },
    })
    for (let i = 0; i < replies.length; i++) await postJson(server, '/chat/completions', { model: 'demo' })
    expect(captured.map((r) => [r.level, r.fingerprint])).toEqual([
      ['warning', ['inference-failure', 'mlx', 'oom']],
      ['error', ['inference-failure', 'mlx', '503']],
    ])
  })
})
