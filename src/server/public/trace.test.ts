import { afterEach, describe, expect, it } from 'vitest'
import type { ApiRequestEvent } from '../../contracts/index.js'
import { endpointFromPath } from './trace.js'
import {
  closeAll,
  localSession,
  postJson,
  remoteProvider,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'

afterEach(closeAll)

type Phase<P extends ApiRequestEvent['phase']> = Extract<ApiRequestEvent, { phase: P }>

async function observed(inspecting: boolean, sessions: Parameters<typeof startPublic>[0] = {}) {
  const events: ApiRequestEvent[] = []
  const server = await startPublic({
    ...sessions,
    emit: (name, payload) => {
      if (name === 'api:request') events.push(payload as ApiRequestEvent)
    },
    inspecting: () => inspecting,
  })
  const finished = async (count = 1): Promise<Array<Phase<'finished'>>> => {
    await expect.poll(() => events.filter((e) => e.phase === 'finished').length).toBeGreaterThanOrEqual(count)
    return events.filter((e): e is Phase<'finished'> => e.phase === 'finished')
  }
  return { server, events, finished }
}

const SSE = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }], usage: null })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }], usage: null })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
  'data: [DONE]\n\n',
]

describe('api:request analytics', () => {
  it('reports every product request with its outcome, but no previews while nobody watches', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('CUDA error: out of memory')
    })
    const { server, events, finished } = await observed(false, { sessions: [localSession(port)] })

    await postJson(server, '/chat/completions', {
      model: 'demo',
      messages: [{ role: 'user', content: 'secret prompt' }],
    })

    const [done] = await finished()
    expect(done?.observation).toMatchObject({
      endpoint: 'chat/completions',
      method: 'POST',
      model_id: 'demo',
      backend: 'llamacpp-upstream',
      provider: null,
      stream: false,
      status: 500,
      is_anthropic_fallback: false,
      error_kind: 'local_model_error',
      upstream_status: 500,
      oom_detected: true,
      ctx_overflow_detected: false,
    })
    expect(done?.finish).toBeNull()
    expect(events.map((e) => e.phase)).toEqual(['finished'])
    expect(JSON.stringify(events)).not.toContain('secret prompt')
  })

  it('keeps model polling, docs, preflight, scanners and hidden paths out of analytics', async () => {
    const { server, events } = await observed(true)
    const base = `http://127.0.0.1:${server.port}`
    await fetch(`${base}/v1/models`)
    await fetch(`${base}/openapi.json`)
    await fetch(`${base}/v1/nowhere`)
    await fetch(`${base}/v1/configs`)
    await fetch(`${base}/v1/models`, { method: 'OPTIONS' })
    const wrong = await fetch(`${base}/v1/chat/completions`)
    expect(wrong.status).toBe(405)

    await expect.poll(() => events.filter((e) => e.phase === 'finished').length).toBe(1)
    const only = events.find((e): e is Phase<'finished'> => e.phase === 'finished')
    expect(only?.observation).toMatchObject({
      endpoint: 'chat/completions',
      method: 'GET',
      error_kind: 'method_not_allowed',
      status: 405,
    })
  })

  it('labels refused requests, remote transport failures and the anthropic fallback', async () => {
    const { server, finished } = await observed(false, {
      remote: [remoteProvider({ baseUrl: 'http://127.0.0.1:9/v1' })],
    })
    await postJson(server, '/messages', { model: 'cloud-model', max_tokens: 5, messages: [] })
    await postJson(server, '/chat/completions', { model: 'ghost' })
    await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: 'POST', body: '{broken' })

    const events = await finished(3)
    expect(
      events.map((e) => [e.observation?.backend, e.observation?.provider, e.observation?.error_kind])
    ).toEqual([
      ['remote', 'cloud', 'remote_provider_error'],
      ['unknown', null, 'not_found'],
      ['unknown', null, 'bad_request'],
    ])
    expect(endpointFromPath('/elsewhere')).toBe('other')
  })
})

describe('api:request inspector', () => {
  it('announces with a prompt preview, streams progress-free telemetry and strips the usage trailer it asked for', async () => {
    let sentBody = ''
    const { port } = await startUpstream((_req, body, res) => {
      sentBody = body
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(SSE.join(''))
    })
    const { server, events, finished } = await observed(true, { sessions: [localSession(port)] })

    const answer = await postJson(server, '/chat/completions', {
      model: 'demo',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'tell me' }],
    })
    const text = await answer.text()

    expect(JSON.parse(sentBody)).toMatchObject({ stream_options: { include_usage: true } })
    expect(text).not.toContain('"choices":[]')
    expect(text).toContain('data: [DONE]')
    const [done] = await finished()
    const started = events.find((e): e is Phase<'started'> => e.phase === 'started')
    expect(started).toMatchObject({
      endpoint: 'chat/completions',
      model_id: 'demo',
      stream: true,
      message_count: 1,
      prompt_preview: 'tell me',
      prompt_chars: 7,
      client_max_tokens: 64,
    })
    expect(done?.seq).toBe(started?.seq)
    expect(done?.finish).toMatchObject({
      status: 200,
      aborted: false,
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
      tokens_estimated: false,
      finish_reason: 'stop',
      reply_preview: 'Hello',
      reply_chars: 5,
    })
    expect(done?.finish?.ttft_ms).not.toBeNull()
  })

  it('leaves the request body untouched when the client already chose, and for a remote provider', async () => {
    const bodies: string[] = []
    const { port } = await startUpstream((_req, body, res) => {
      bodies.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    })
    const { server, finished } = await observed(true, {
      sessions: [localSession(port)],
      remote: [remoteProvider({ baseUrl: `http://127.0.0.1:${port}/v1` })],
    })

    await (
      await postJson(server, '/chat/completions', {
        model: 'demo',
        stream: true,
        stream_options: { include_usage: false },
      })
    ).text()
    await (await postJson(server, '/chat/completions', { model: 'cloud-model', stream: true })).text()

    await finished(2)
    expect(bodies.map((b) => JSON.parse(b) as { stream_options?: unknown })).toEqual([
      { model: 'demo', stream: true, stream_options: { include_usage: false } },
      { model: 'cloud-model', stream: true },
    ])
  })

  it('reads telemetry from a whole local reply without a time to first token', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'whole' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      )
    })
    const { server, finished } = await observed(true, { sessions: [localSession(port)] })

    await (await postJson(server, '/chat/completions', { model: 'demo', messages: [] })).text()

    const [done] = await finished()
    expect(done?.finish).toMatchObject({ reply_preview: 'whole', ttft_ms: null, total_tokens: 2 })
  })

  it('sends progress for a long stream and marks a request the client abandoned', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const timer = setInterval(
        () => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`),
        50
      )
      res.on('close', () => clearInterval(timer))
    })
    const { server, events, finished } = await observed(true, { sessions: [localSession(port)] })
    const controller = new AbortController()

    const answer = await postJson(
      server,
      '/chat/completions',
      { model: 'demo', stream: true, messages: [] },
      { signal: controller.signal }
    )
    const reader = answer.body!.getReader()
    await expect
      .poll(
        async () => {
          await reader.read()
          return events.some((e) => e.phase === 'progress')
        },
        { timeout: 5000, interval: 50 }
      )
      .toBe(true)
    controller.abort()

    const [done] = await finished()
    expect(done?.finish).toMatchObject({ aborted: true, tokens_estimated: true })
    expect(events.find((e) => e.phase === 'progress')).toMatchObject({ reply_chars: expect.any(Number) })
  })

  it('translates /responses telemetry, and announces requests that never reach a body parse', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(SSE.join(''))
    })
    const { server, events, finished } = await observed(true, { sessions: [localSession(port)] })

    await (
      await postJson(server, '/responses', { model: 'demo', input: 'from responses', stream: true })
    ).text()
    await fetch(`http://127.0.0.1:${server.port}/v1/responses`)

    const [translated, refused] = await finished(2)
    expect(events.find((e): e is Phase<'started'> => e.phase === 'started')?.prompt_preview).toBe(
      'from responses'
    )
    expect(translated?.finish).toMatchObject({ reply_preview: 'Hello', completion_tokens: 2 })
    expect(refused?.finish).toMatchObject({ status: 405, error_kind: 'method_not_allowed' })
  })
})

describe('api:request edges', () => {
  it('reads telemetry from a whole remote document relayed as a stream, and from an SSE tail with no newline', async () => {
    const { port } = await startUpstream((req, _body, res) => {
      if (req.url?.includes('chat')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'remote whole' } }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`)
    })
    const { server, finished } = await observed(true, {
      sessions: [localSession(port)],
      remote: [remoteProvider({ baseUrl: `http://127.0.0.1:${port}/v1` })],
    })

    expect(
      await (await postJson(server, '/chat/completions', { model: 'cloud-model', messages: [] })).json()
    ).toEqual({
      choices: [{ message: { content: 'remote whole' } }],
    })
    const tail = await (await postJson(server, '/completions', { model: 'demo', stream: true })).text()

    const [remote, local] = await finished(2)
    expect(remote?.finish).toMatchObject({ reply_preview: 'remote whole', ttft_ms: null })
    expect(tail).toContain('"tail"')
    expect(local?.finish?.reply_preview).toBeNull()
  })

  it('closes a /responses stream the upstream ended without [DONE], and answers a non-JSON whole reply', async () => {
    const { port } = await startUpstream((_req, body, res) => {
      const stream = (JSON.parse(body) as { stream?: boolean }).stream
      if (!stream) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('not json')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'cut' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: not-json\n\n`
      )
    })
    const { server, finished } = await observed(true, { sessions: [localSession(port)] })

    const streamed = await (
      await postJson(server, '/responses', { model: 'demo', input: 'x', stream: true })
    ).text()
    const whole = await postJson(server, '/responses', { model: 'demo', input: 'x' })

    expect(streamed).toContain('response.completed')
    expect(whole.status).toBe(200)
    const [first] = await finished(2)
    expect(first?.finish).toMatchObject({ reply_preview: 'cut', prompt_tokens: 1 })
  })

  it('keeps the original /messages error when the fallback cannot be reached, and passes a non-JSON fallback body', async () => {
    let calls = 0
    const { port } = await startUpstream((req, _body, res) => {
      calls++
      if (req.url === '/v1/messages') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('no messages here')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('plain fallback')
    })
    const { server, finished } = await observed(false, {
      sessions: [localSession(port)],
      remote: [remoteProvider({ provider: 'gone', baseUrl: 'http://127.0.0.1:9', models: ['gone-model'] })],
    })

    const plain = await postJson(server, '/messages', { model: 'demo', max_tokens: 4, messages: [] })
    expect(await plain.text()).toBe('plain fallback')

    const unreachable = await postJson(server, '/messages', {
      model: 'gone-model',
      max_tokens: 4,
      messages: [],
    })
    expect(unreachable.status).toBe(502)
    const events = await finished(2)
    expect(events[0]?.observation).toMatchObject({ is_anthropic_fallback: true, error_kind: null })
    expect(events[1]?.observation).toMatchObject({ error_kind: 'remote_provider_error' })
    expect(calls).toBe(2)
  })

  it('returns the original overflow when the grown engine still fails, and labels a torn request body', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'the request exceeds the available context size' } }))
    })
    const { server, finished } = await observed(false, {
      sessions: [localSession(port)],
      increaseCtx: () => Promise.resolve({ ok: true, new_ctx_len: 8192 }),
    })

    const answer = await postJson(server, '/chat/completions', { model: 'demo', messages: [] })
    expect(answer.status).toBe(400)
    const [done] = await finished()
    expect(done?.observation).toMatchObject({ error_kind: 'local_model_error', ctx_overflow_detected: true })

    const { connect } = await import('node:net')
    await new Promise<void>((resolve) => {
      const socket = connect(server.port, '127.0.0.1', () => {
        socket.write(
          `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"model":`
        )
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 50)
      })
    })
  })
})
