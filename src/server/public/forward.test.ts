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

describe('a session that declares its routes (tensorrt-llm)', () => {
  const overflow = JSON.stringify({
    object: 'error',
    message: 'The sum of prompt length (9000), query length (0) should not exceed max_num_tokens (8192)',
    type: 'BadRequestError',
    param: null,
    code: 400,
  })
  const trt = (port: number, tools = false) =>
    localSession(port, {
      provider: 'tensorrt-llm',
      modelId: 'trt',
      policy: {
        routes: [
          { method: 'POST', path: '/v1/chat/completions' },
          { method: 'POST', path: '/v1/completions' },
          { method: 'GET', path: '/v1/models' },
        ],
        tools,
        structuredOutput: false,
        mapError: (status, body) =>
          status === 400 && body.includes('max_num_tokens (8192)')
            ? {
                error: {
                  message: 'maximum context length is 8192 tokens, your messages resulted in 9000 tokens',
                  type: 'invalid_request_error',
                  param: null,
                  code: 'context_length_exceeded',
                },
              }
            : null,
      },
    })

  it('answers /v1/embeddings with a clear error and never reaches the session', async () => {
    const seen: string[] = []
    const { port } = await startUpstream((req, _body, res) => {
      seen.push(req.url ?? '')
      res.end('{}')
    })
    const server = await startPublic({ sessions: [trt(port)] })
    const res = await postJson(server, '/embeddings', { model: 'trt', input: 'hi' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { message: "The model 'trt' does not support embeddings.", code: 'unsupported_endpoint' },
    })
    expect(seen).toEqual([])
  })

  it('refuses tools when the session has no tool parser, and forwards a plain chat', async () => {
    const seen: string[] = []
    const { port } = await startUpstream((req, _body, res) => {
      seen.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }))
    })
    const server = await startPublic({ sessions: [trt(port)] })
    const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }]
    expect((await postJson(server, '/chat/completions', { model: 'trt', tools })).status).toBe(400)
    expect(seen).toEqual([])
    expect((await postJson(server, '/chat/completions', { model: 'trt' })).status).toBe(200)
    expect(seen).toEqual(['/v1/chat/completions'])
  })

  it('maps a context overflow to context_length_exceeded and never asks for a larger context', async () => {
    const asked: string[] = []
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(overflow)
    })
    const server = await startPublic({
      sessions: [trt(port)],
      increaseCtx: (_p, _m, trigger) => {
        asked.push(trigger)
        return Promise.resolve({ ok: true, new_ctx_len: 16384 })
      },
    })
    const res = await postJson(server, '/chat/completions', { model: 'trt', stream: true })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'context_length_exceeded' } })
    expect(asked).toEqual([])
  })

  it('never grows the context for a reply cut off at the window, either', async () => {
    const asked: string[] = []
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] }))
    })
    const server = await startPublic({
      sessions: [trt(port)],
      increaseCtx: (_p, _m, trigger) => {
        asked.push(trigger)
        return Promise.resolve({ ok: true })
      },
    })
    expect((await postJson(server, '/chat/completions', { model: 'trt' })).status).toBe(200)
    expect(asked).toEqual([])
  })

  it('wraps any other engine error the generic way, still without a context increase', async () => {
    const asked: string[] = []
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('Compute error: out of memory')
    })
    const server = await startPublic({
      sessions: [trt(port)],
      increaseCtx: (_p, _m, trigger) => {
        asked.push(trigger)
        return Promise.resolve({ ok: true })
      },
    })
    const res = await postJson(server, '/chat/completions', { model: 'trt' })
    expect(res.status).toBe(500)
    expect(asked).toEqual([])
  })

  it('sends /v1/messages straight to chat completions, never to the undeclared route, and maps an overflow there too', async () => {
    const seen: string[] = []
    const { port } = await startUpstream((req, body, res) => {
      seen.push(req.url ?? '')
      if (body.includes('OVERFLOW')) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(overflow)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'c1',
          model: 'trt',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      )
    })
    const server = await startPublic({ sessions: [trt(port)] })
    const ok = await postJson(server, '/messages', {
      model: 'trt',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'hi' }] })
    const overflowed = await postJson(server, '/messages', {
      model: 'trt',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'OVERFLOW' }],
    })
    expect(overflowed.status).toBe(400)
    expect(await overflowed.json()).toMatchObject({ error: { code: 'context_length_exceeded' } })
    expect(seen).toEqual(['/v1/chat/completions', '/v1/chat/completions'])
  })

  it('answers a /v1/messages it cannot translate with a 400, and an unreachable session with a 503', async () => {
    const { port } = await startUpstream((_req, _body, res) => res.end('{}'))
    const server = await startPublic({ sessions: [trt(port)] })
    const untranslatable = await postJson(server, '/messages', { model: 'trt' })
    expect(untranslatable.status).toBe(400)
    expect(await untranslatable.json()).toMatchObject({ error: { type: 'invalid_request_error' } })

    const down = await startPublic({ sessions: [trt(await closedPort())] })
    const unreachable = await postJson(down, '/messages', {
      model: 'trt',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(unreachable.status).toBe(503)
  })

  it('answers /v1/responses for a tensorrt-llm model with a clear error', async () => {
    const { port } = await startUpstream((_req, _body, res) => res.end('{}'))
    const server = await startPublic({ sessions: [trt(port)] })
    const res = await postJson(server, '/responses', { model: 'trt', input: 'hi' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { message: "The model 'trt' does not support the Responses API." },
    })
  })
})
