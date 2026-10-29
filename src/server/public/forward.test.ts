import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { ErrorReport } from '../../telemetry/index.js'
import { sseEvent } from './forward.js'
import type { LocalTarget } from './types.js'
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

describe('refusals before the engine', () => {
  it("answers a model nothing serves with OpenAI's model_not_found envelope on every model route", async () => {
    const server = await startPublic({ sessions: [localSession(await closedPort())] })

    for (const path of ['/chat/completions', '/messages', '/completions', '/embeddings']) {
      const res = await postJson(server, path, {
        model: 'ghost',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type'), path).toBe('application/json')
      expect(await res.json(), path).toEqual({
        error: {
          message: "No running session found for model 'ghost'",
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      })
    }
  })

  it('refuses an empty conversation with a 400 and never asks the local engine', async () => {
    let calls = 0
    const { port } = await startUpstream((_req, _body, res) => {
      calls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"unsolicited"}}]}')
    })
    const server = await startPublic({ sessions: [localSession(port)] })

    for (const path of ['/chat/completions', '/messages']) {
      const res = await postJson(server, path, { model: 'demo', max_tokens: 8, messages: [] })
      expect(res.status, path).toBe(400)
      expect(res.headers.get('content-type'), path).toBe('application/json')
      expect(await res.json(), path).toMatchObject({
        error: { type: 'invalid_request_error', param: 'messages', code: 'empty_array' },
      })
    }
    expect(calls).toBe(0)

    const ok = await postJson(server, '/chat/completions', {
      model: 'demo',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(ok.status).toBe(200)
    expect(calls).toBe(1)
  })

  it('refuses a chat role OpenAI does not define on every local engine, and passes the roles clients send', async () => {
    const seen: string[] = []
    const { port } = await startUpstream((_req, body, res) => {
      seen.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"VALIDATION_TEST"}}]}')
    })
    const server = await startPublic({
      sessions: [
        localSession(port),
        localSession(port, { provider: 'mlx', modelId: 'mlx-model', apiKey: '' }),
        localSession(port, { provider: 'vllm', modelId: 'vllm-model' }),
      ],
    })

    for (const model of ['demo', 'mlx-model', 'vllm-model']) {
      const res = await postJson(server, '/chat/completions', {
        model,
        max_tokens: 64,
        messages: [{ role: 'not-a-real-role', content: 'Reply exactly VALIDATION_TEST.' }],
      })
      expect(res.status, model).toBe(400)
      expect(res.headers.get('content-type'), model).toBe('application/json')
      expect(await res.json(), model).toEqual({
        error: {
          message:
            "Invalid value for 'messages[0].role': 'not-a-real-role'. Supported values are: 'system', 'developer', 'user', 'assistant' and 'tool'.",
          type: 'invalid_request_error',
          param: 'messages[0].role',
          code: 'invalid_value',
        },
      })
    }
    const missing = await postJson(server, '/chat/completions', {
      model: 'demo',
      messages: [{ content: 'x' }],
    })
    expect(await missing.json()).toMatchObject({
      error: { param: 'messages[0].role', code: 'missing_required_parameter' },
    })
    expect(seen).toEqual([])

    const conversation = [
      { role: 'system', content: 'Be brief.' },
      { role: 'developer', content: 'Use tools.' },
      { role: 'user', content: [{ type: 'text', text: 'What is 6 x 7?' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mul', arguments: '{"a":6,"b":7}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '42' },
    ]
    const ok = await postJson(server, '/chat/completions', { model: 'demo', messages: conversation })
    expect(ok.status).toBe(200)
    expect(seen.map((body) => JSON.parse(body).messages)).toEqual([conversation])
  })

  it('refuses a mixed embeddings input to a local session and passes the OpenAI forms', async () => {
    const seen: unknown[] = []
    const { port } = await startUpstream((_req, body, res) => {
      seen.push(JSON.parse(body).input)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"object":"list","data":[]}')
    })
    const server = await startPublic({
      sessions: [localSession(port, { modelId: 'nomic-embed-text-v1.5', isEmbedding: true })],
    })
    const embed = (input: unknown) =>
      postJson(server, '/embeddings', { model: 'nomic-embed-text-v1.5', input })

    for (const input of [['test', 7], ['alpha', 7, 'omega'], [[1, 2], ['x']], [1, 2.5], 7]) {
      const res = await embed(input)
      expect(res.status, JSON.stringify(input)).toBe(400)
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(await res.json()).toMatchObject({ error: { type: 'invalid_request_error', param: 'input' } })
    }
    expect(seen).toEqual([])

    const valid = ['alpha', ['alpha', 'omega'], [101, 7], [[101, 7], [0]]]
    for (const input of valid) expect((await embed(input)).status, JSON.stringify(input)).toBe(200)
    expect(seen).toEqual(valid)
  })

  it('leaves the roles and the input to a remote provider, which validates its own requests', async () => {
    const seen: string[] = []
    const { port } = await startUpstream((req, _body, res) => {
      seen.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const server = await startPublic({ remote: [remoteProvider({ baseUrl: `http://127.0.0.1:${port}/v1` })] })

    const chat = await postJson(server, '/chat/completions', {
      model: 'cloud-model',
      messages: [{ role: 'not-a-real-role', content: 'x' }],
    })
    const embeddings = await postJson(server, '/embeddings', { model: 'cloud-model', input: ['alpha', 7] })
    expect([chat.status, embeddings.status]).toEqual([200, 200])
    expect(seen).toEqual(['/v1/chat/completions', '/v1/embeddings'])
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

  it('answers an engine error it does not map as JSON, on chat and on the Anthropic fallback (final review M-4)', async () => {
    // What the session gateway answers once it has already mapped the engine's error itself.
    const alreadyMapped = JSON.stringify({
      error: {
        message: 'too long',
        type: 'invalid_request_error',
        param: null,
        code: 'context_length_exceeded',
      },
    })
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(alreadyMapped)
    })
    const server = await startPublic({ sessions: [trt(port)] })
    const chat = await postJson(server, '/chat/completions', { model: 'trt' })
    expect(chat.status).toBe(400)
    expect(chat.headers.get('content-type')).toContain('application/json')
    expect(await chat.json()).toMatchObject({ error: { code: 'context_length_exceeded' } })
    const messages = await postJson(server, '/messages', {
      model: 'trt',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(messages.status).toBe(400)
    expect(messages.headers.get('content-type')).toContain('application/json')
    expect(await messages.json()).toMatchObject({ error: { code: 'context_length_exceeded' } })
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

  // Every managed provider declares its routes and has no Responses API (change add-sglang-runtime,
  // D1: the lookup reads MANAGED_PROVIDER_IDS, not a chain of provider names).
  it.each(['tensorrt-llm', 'vllm', 'sglang'] as const)(
    'answers /v1/responses for a %s model with a clear error',
    async (provider) => {
      const { port } = await startUpstream((_req, _body, res) => res.end('{}'))
      const session = trt(port)
      const server = await startPublic({ sessions: [{ ...session, provider }] })
      const res = await postJson(server, '/responses', { model: 'trt', input: 'hi' })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        error: { message: "The model 'trt' does not support the Responses API." },
      })
    }
  )
})

describe('the provider the app selected for a model id', () => {
  /** A local engine and a remote provider that both serve `demo`, each counting its calls. */
  async function collision(
    selection: Array<[string, string]> | undefined,
    {
      localLoaded = true,
      localProvider = 'llamacpp-upstream',
    }: { localLoaded?: boolean; localProvider?: LocalTarget['provider'] } = {}
  ) {
    const calls = { local: 0, remote: 0 }
    const local = await startUpstream((_req, _body, res) => {
      calls.local++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"from":"local"}')
    })
    const remote = await startUpstream((_req, _body, res) => {
      calls.remote++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"from":"remote"}')
    })
    const server = await startPublic({
      sessions: [
        localSession(local.port, { provider: localProvider, ...(localLoaded ? {} : { modelId: 'other' }) }),
      ],
      remote: [
        remoteProvider({
          provider: 'custom',
          baseUrl: `http://127.0.0.1:${remote.port}/v1`,
          models: ['demo'],
        }),
      ],
      ...(selection ? { selection: () => new Map(selection) } : {}),
    })
    return { server, calls }
  }
  const chat = { model: 'demo', messages: [{ role: 'user', content: 'hi' }] }

  it('sends the id to the remote provider without a selection, as before', async () => {
    const { server, calls } = await collision(undefined)
    expect(await (await postJson(server, '/chat/completions', chat)).json()).toEqual({ from: 'remote' })
    expect(calls).toEqual({ local: 0, remote: 1 })
  })

  it('sends the id to the selected local engine although a remote provider lists it', async () => {
    const { server, calls } = await collision([['demo', 'llamacpp-upstream']])
    expect(await (await postJson(server, '/chat/completions', chat)).json()).toEqual({ from: 'local' })
    expect(calls).toEqual({ local: 1, remote: 0 })
  })

  it('keeps a model selected on one local engine local when another engine holds it', async () => {
    // The app named llama.cpp upstream; TurboQuant (`llamacpp`) has the session.
    const { server, calls } = await collision([['demo', 'llamacpp-upstream']], { localProvider: 'llamacpp' })

    expect(await (await postJson(server, '/chat/completions', chat)).json()).toEqual({ from: 'local' })
    expect((await postJson(server, '/responses', { model: 'demo', input: 'hi' })).status).toBe(200)
    expect(calls).toEqual({ local: 2, remote: 0 })
    const { data } = (await (await fetch(`http://127.0.0.1:${server.port}/v1/models`)).json()) as {
      data: Array<{ id: string; owned_by: string }>
    }
    expect(data.filter((m) => m.id === 'demo').map((m) => m.owned_by)).toEqual(['llama.cpp'])
  })

  it('sends /responses for the id to the selected local engine too', async () => {
    const { server, calls } = await collision([['demo', 'llamacpp-upstream']])
    expect((await postJson(server, '/responses', { model: 'demo', input: 'hi' })).status).toBe(200)
    expect(calls).toEqual({ local: 1, remote: 0 })
  })

  it('sends the id to the selected remote provider while the local engine has it loaded', async () => {
    const { server, calls } = await collision([['demo', 'custom']])
    expect(await (await postJson(server, '/chat/completions', chat)).json()).toEqual({ from: 'remote' })
    expect(calls).toEqual({ local: 0, remote: 1 })
  })

  it('answers 503 naming the model and the selected engine when it has no session, and asks nobody', async () => {
    const { server, calls } = await collision([['demo', 'llamacpp-upstream']], { localLoaded: false })

    for (const path of ['/chat/completions', '/messages', '/responses']) {
      const res = await postJson(server, path, { ...chat, input: 'hi' })
      expect(res.status, path).toBe(503)
      expect(res.headers.get('content-type'), path).toBe('application/json')
      const body = (await res.json()) as { error: { message: string; code: string; type: string } }
      expect(body.error, path).toMatchObject({ code: 'selected_provider_unavailable', type: 'server_error' })
      expect(body.error.message, path).toContain("model 'demo'")
      expect(body.error.message, path).toContain('llamacpp-upstream')
    }
    expect(calls).toEqual({ local: 0, remote: 0 })
  })

  it('lists the id once in /v1/models, owned by the backend its requests go to', async () => {
    const owners = async (selection: Array<[string, string]> | undefined, loaded = true) => {
      const { server } = await collision(selection, { localLoaded: loaded })
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`)
      const { data } = (await res.json()) as { data: Array<{ id: string; owned_by: string }> }
      return data.filter((m) => m.id === 'demo').map((m) => m.owned_by)
    }

    expect(await owners(undefined)).toEqual(['remote'])
    expect(await owners([['demo', 'llamacpp-upstream']])).toEqual(['llama.cpp-upstream'])
    expect(await owners([['demo', 'custom']])).toEqual(['remote'])
    // Selected but not loaded: nothing serves it, so nothing lists it.
    expect(await owners([['demo', 'llamacpp-upstream']], false)).toEqual([])
  })
})
