import { createServer, request as httpRequest } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { handlePublicRequest } from './index.js'
import type { PublicServer, PublicServerConfig, PublicServerDeps } from './index.js'
import { ChatRunRegistry, RUN_TTL_AFTER_FINISH_MS } from './run-registry.js'
import { matchRunPath, runCursor } from './runs.js'
import {
  closeAll,
  localSession,
  postJson,
  remoteProvider,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'
import { responsesStream, startStub } from '../../../test/helpers/chatgpt-stub.js'

afterEach(closeAll)

const RESUMABLE = { 'content-type': 'application/json', 'x-atomic-resumable': '1' }
const chunk = (n: number) =>
  `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: `t${n}` } }] })}\n\n`

/**
 * A chat engine that streams `count` chunks and `[DONE]`, holding after the first `holdAfter` until
 * `release()`; it records whether its client hung up before the end.
 */
async function engine(count: number, holdAfter = count, prelude = '') {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const state = {
    closedEarly: false,
    finished: false,
    bodies: [] as string[],
    headers: [] as Array<Record<string, unknown>>,
  }
  const { port } = await startUpstream((req, body, res) => {
    state.bodies.push(body)
    state.headers.push(req.headers)
    res.on('close', () => {
      if (!res.writableFinished) state.closedEarly = true
    })
    void (async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (prelude) res.write(prelude)
      for (let n = 1; n <= count; n++) {
        if (n === holdAfter + 1) await gate
        if (res.destroyed) return
        res.write(chunk(n))
      }
      res.end('data: [DONE]\n\n')
      state.finished = true
    })()
  })
  return { port, state, release }
}

/** An engine that streams until its client hangs up. */
async function endlessEngine() {
  const state = { closed: false }
  const { port } = await startUpstream((_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let n = 0
    const timer = setInterval(() => res.write(chunk(++n)), 5)
    res.on('close', () => {
      clearInterval(timer)
      state.closed = true
    })
  })
  return { port, state }
}

const readers = new WeakMap<Response, { reader: ReadableStreamDefaultReader<Uint8Array>; text: string }>()

/** Read a response body until `done` holds for everything read so far (or the body ends); returns all of it. */
async function readUntil(res: Response, done: (text: string) => boolean): Promise<string> {
  let state = readers.get(res)
  if (!state) readers.set(res, (state = { reader: res.body!.getReader(), text: '' }))
  const decoder = new TextDecoder()
  while (!done(state.text)) {
    const { value, done: end } = await state.reader.read()
    if (end) break
    state.text += decoder.decode(value, { stream: true })
  }
  return state.text
}

/** The complete events in a stream's text: their `id:` and `data:` values. */
function events(text: string): Array<{ id: number | undefined; data: string }> {
  return text
    .slice(0, text.lastIndexOf('\n\n') + 2)
    .split('\n\n')
    .filter((block) => block.split('\n').some((line) => line.startsWith('data:')))
    .map((block) => {
      const lines = block.split('\n')
      const id = lines.find((line) => line.startsWith('id: '))
      return {
        id: id === undefined ? undefined : Number(id.slice(4)),
        data: lines
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n'),
      }
    })
}

const contents = (text: string) =>
  events(text).map((e) =>
    e.data === '[DONE]' ? '[DONE]' : (JSON.parse(e.data).choices[0].delta.content as string)
  )

/**
 * The OpenAI Python SDK's SSE decoder (`openai/_streaming.py`: `_iter_chunks`, then `splitlines()` and
 * `SSEDecoder.decode` per line): it keeps the last `id` across events, so once one was seen every
 * blank line dispatches an event, empty data or not.
 */
function pythonSdkEvents(text: string): string[] {
  const chunks: string[] = []
  let pending = ''
  for (const line of text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []) {
    pending += line
    if (/(?:\r\r|\n\n|\r\n\r\n)$/.test(pending)) {
      chunks.push(pending)
      pending = ''
    }
  }
  if (pending) chunks.push(pending)
  const lines = chunks.flatMap((c) => {
    const split = c.split(/\r\n|\r|\n/)
    if (split[split.length - 1] === '') split.pop()
    return split
  })
  const out: string[] = []
  let event: string | null = null
  let data: string[] = []
  let lastId: string | null = null
  for (const line of lines) {
    if (line === '') {
      if (!event && data.length === 0 && !lastId) continue
      out.push(data.join('\n'))
      event = null
      data = []
      continue
    }
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') lastId = value
  }
  return out
}

const resume = (server: PublicServer, id: string, query = '', init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${server.port}/v1/atomic/runs/${id}/events${query}`, { method: 'POST', ...init })

const cancel = (server: PublicServer, id: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${server.port}/v1/atomic/runs/${id}/cancel`, { method: 'POST', ...init })

const chat = { model: 'demo', stream: true, messages: [{ role: 'user', content: 'hi' }] }

describe('a resumable chat stream', () => {
  it('carries the run id and an id on every event, [DONE] included, and the same events as a plain stream', async () => {
    const { port, state } = await engine(3)
    const server = await startPublic({ sessions: [localSession(port)] })

    const res = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    const text = await res.text()
    // The opt-in is this core's: an engine that is another core must not keep a run of its own.
    expect(state.headers[0]?.['x-atomic-resumable']).toBeUndefined()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-atomic-run-id')).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(text).toBe([1, 2, 3].map((n) => `id: ${n}\n${chunk(n)}`).join('') + 'id: 4\ndata: [DONE]\n\n')
    const plain = await (await postJson(server, '/chat/completions', chat)).text()
    expect(plain).toBe([1, 2, 3].map(chunk).join('') + 'data: [DONE]\n\n')
    expect(text.replace(/^id: \d+\n/gm, '')).toBe(plain)
  })

  it('keeps generating after the client hangs up, and a resume after N returns exactly the rest', async () => {
    const upstream = await engine(8, 3)
    const runs = new ChatRunRegistry()
    const server = await startPublic({ sessions: [localSession(upstream.port)], runs })
    const controller = new AbortController()

    const res = await postJson(server, '/chat/completions', chat, {
      headers: RESUMABLE,
      signal: controller.signal,
    })
    const id = res.headers.get('x-atomic-run-id')!
    const seen = events(await readUntil(res, (text) => events(text).length >= 3))
    expect(seen.map((e) => e.id)).toEqual([1, 2, 3])
    controller.abort()

    // The server has let the client go, and the engine is still answering.
    await expect.poll(() => runs.find(id, undefined)?.followers, { timeout: 2000 }).toBe(0)
    expect(upstream.state.closedEarly).toBe(false)
    upstream.release()
    await expect.poll(() => upstream.state.finished, { timeout: 2000 }).toBe(true)
    expect(upstream.state.closedEarly).toBe(false)

    const resumed = await resume(server, id, '?after=3')
    expect(resumed.status).toBe(200)
    expect(resumed.headers.get('content-type')).toBe('text/event-stream')
    expect(resumed.headers.get('x-atomic-run-id')).toBe(id)
    const rest = await resumed.text()
    expect(events(rest).map((e) => e.id)).toEqual([4, 5, 6, 7, 8, 9])
    expect(contents(rest)).toEqual(['t4', 't5', 't6', 't7', 't8', '[DONE]'])
  })

  it('takes the cursor from Last-Event-ID, and replays everything without one', async () => {
    const { port } = await engine(4)
    const server = await startPublic({ sessions: [localSession(port)] })
    const res = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    const id = res.headers.get('x-atomic-run-id')!
    const whole = await res.text()

    const fromHeader = await resume(server, id, '', { headers: { 'last-event-id': '3' } })
    expect(contents(await fromHeader.text())).toEqual(['t4', '[DONE]'])
    // The query wins over the header.
    const fromQuery = await resume(server, id, '?after=4', { headers: { 'last-event-id': '1' } })
    expect(contents(await fromQuery.text())).toEqual(['[DONE]'])
    expect(await (await resume(server, id)).text()).toBe(whole)
  })

  it('follows a run live for several readers at once', async () => {
    const upstream = await engine(5, 2)
    const server = await startPublic({ sessions: [localSession(upstream.port)] })
    const res = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    const id = res.headers.get('x-atomic-run-id')!
    await readUntil(res, (text) => events(text).length >= 2)

    const [a, b] = await Promise.all([resume(server, id, '?after=1'), resume(server, id, '?after=2')])
    upstream.release()
    const [textA, textB, original] = await Promise.all([a.text(), b.text(), readUntil(res, () => false)])
    expect(contents(textA)).toEqual(['t2', 't3', 't4', 't5', '[DONE]'])
    expect(contents(textB)).toEqual(['t3', 't4', 't5', '[DONE]'])
    expect(contents(original)).toEqual(['t1', 't2', 't3', 't4', 't5', '[DONE]'])
  })

  it('stops the engine on cancel and ends every follower without [DONE]', async () => {
    const upstream = await endlessEngine()
    const server = await startPublic({ sessions: [localSession(upstream.port)] })
    const res = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    const id = res.headers.get('x-atomic-run-id')!
    const head = await readUntil(res, (text) => events(text).length >= 1)

    const cancelled = await cancel(server, id)
    expect(cancelled.status).toBe(204)
    expect(await cancelled.text()).toBe('')
    await expect.poll(() => upstream.state.closed, { timeout: 2000 }).toBe(true)
    const tail = await readUntil(res, () => false)
    expect(tail.startsWith(head)).toBe(true)
    expect(contents(tail)).not.toContain('[DONE]')
    // Cancelling again, or reading what it had, still works until the run expires.
    expect((await cancel(server, id)).status).toBe(204)
    expect(contents(await (await resume(server, id)).text())).toEqual(contents(tail))
  })

  it('stops every run when the listener closes', async () => {
    const upstream = await endlessEngine()
    const server = await startPublic({ sessions: [localSession(upstream.port)] })
    const controller = new AbortController()
    const res = await postJson(server, '/chat/completions', chat, {
      headers: RESUMABLE,
      signal: controller.signal,
    })
    await readUntil(res, (text) => events(text).length >= 1)
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(upstream.state.closed).toBe(false)

    await server.close()
    await expect.poll(() => upstream.state.closed, { timeout: 2000 }).toBe(true)
  })

  it('drops the usage trailer the inspector asked for before numbering, so the ids have no gap', async () => {
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`
    let body = ''
    const { port } = await startUpstream((_req, received, res) => {
      body = received
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chunk(1) + chunk(2) + usage + 'data: [DONE]\n\n')
    })
    const server = await startPublic({
      sessions: [localSession(port)],
      emit: () => {},
      inspecting: () => true,
    })

    const text = await (await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })).text()
    expect(JSON.parse(body).stream_options).toEqual({ include_usage: true })
    expect(events(text).map((e) => e.id)).toEqual([1, 2, 3])
    expect(contents(text)).toEqual(['t1', 't2', '[DONE]'])
  })

  it('never lets the OpenAI Python SDK see an empty event: keep-alives lose their blank line, upstream ids go', async () => {
    const { port } = await engine(2, 2, ': keep-alive\n\nid: 900\nerror: {"x":1}\n\n')
    const server = await startPublic({ sessions: [localSession(port)] })

    const text = await (await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })).text()
    expect(text.startsWith(': keep-alive\nid: 1\n')).toBe(true)
    const dispatched = pythonSdkEvents(text)
    expect(dispatched).toHaveLength(3)
    for (const data of dispatched) expect(data === '[DONE]' || JSON.parse(data) !== null).toBe(true)
    // The decoder above is faithful: a blank line after an id dispatches an empty event.
    expect(pythonSdkEvents('id: 1\ndata: x\n\n: ping\n\n')).toEqual(['x', ''])
  })

  it('reads as an ordinary stream to an OpenAI-compatible SDK client', async () => {
    const { port } = await engine(4)
    const server = await startPublic({ sessions: [localSession(port)] })
    const provider = createOpenAICompatible({
      name: 'atomic',
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      headers: { 'X-Atomic-Resumable': '1' },
    })

    const result = streamText({ model: provider.chatModel('demo'), prompt: 'hi' })
    let text = ''
    for await (const part of result.textStream) text += part
    expect(text).toBe('t1t2t3t4')
  })

  it('writes events larger than the socket takes at once whole, waiting for it to drain', async () => {
    const big = 'x'.repeat(512 * 1024)
    const event = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: big } }] })}\n\n`
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(event + event + 'data: [DONE]\n\n')
    })
    const server = await startPublic({ sessions: [localSession(port)] })

    const res = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    expect(contents(await res.text())).toEqual([big, big, '[DONE]'])
  })

  it("answers with this core's run id only, whatever id the upstream sent", async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'X-Atomic-Run-Id': 'upstream-run' })
      res.end(chunk(1) + 'data: [DONE]\n\n')
    })
    const server = await startPublic({ sessions: [localSession(port)] })
    const res = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    expect(res.headers.get('x-atomic-run-id')).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(contents(await res.text())).toEqual(['t1', '[DONE]'])
  })

  it('is served for a remote provider through the same relay', async () => {
    const { port } = await engine(2)
    const server = await startPublic({
      remote: [remoteProvider({ baseUrl: `http://127.0.0.1:${port}/v1` })],
    })
    const res = await postJson(
      server,
      '/chat/completions',
      { ...chat, model: 'cloud-model' },
      { headers: RESUMABLE }
    )
    expect(res.headers.get('x-atomic-run-id')).not.toBeNull()
    expect(contents(await res.text())).toEqual(['t1', 't2', '[DONE]'])
  })
})

describe('what stays a plain stream', () => {
  it('without the header: no run id, no ids, and the engine stops when the client hangs up', async () => {
    const upstream = await endlessEngine()
    const runs = new ChatRunRegistry()
    const server = await startPublic({ sessions: [localSession(upstream.port)], runs })
    const controller = new AbortController()

    const res = await postJson(server, '/chat/completions', chat, { signal: controller.signal })
    expect(res.headers.get('x-atomic-run-id')).toBeNull()
    const text = await readUntil(res, (t) => events(t).length >= 2)
    expect(text).not.toMatch(/^id:/m)
    controller.abort()

    await expect.poll(() => upstream.state.closed, { timeout: 2000 }).toBe(true)
    expect(runs.size).toBe(0)
  })

  it('a header value other than 1, a non-streamed request, or a route other than chat completions', async () => {
    const { port } = await startUpstream((_req, body, res) => {
      const streamed = JSON.parse(body).stream === true
      res.writeHead(200, { 'content-type': streamed ? 'text/event-stream' : 'application/json' })
      res.end(streamed ? chunk(1) + 'data: [DONE]\n\n' : '{"choices":[]}')
    })
    const runs = new ChatRunRegistry()
    const server = await startPublic({ sessions: [localSession(port)], runs })

    const other = await postJson(server, '/chat/completions', chat, {
      headers: { ...RESUMABLE, 'x-atomic-resumable': 'yes' },
    })
    expect(other.headers.get('x-atomic-run-id')).toBeNull()
    expect(await other.text()).not.toMatch(/^id:/m)
    const whole = await postJson(
      server,
      '/chat/completions',
      { ...chat, stream: false },
      { headers: RESUMABLE }
    )
    expect(whole.headers.get('x-atomic-run-id')).toBeNull()
    expect(await whole.json()).toEqual({ choices: [] })
    const completions = await postJson(
      server,
      '/completions',
      { model: 'demo', prompt: 'hi', stream: true },
      {
        headers: RESUMABLE,
      }
    )
    expect(completions.headers.get('x-atomic-run-id')).toBeNull()
    await completions.text()
    expect(runs.size).toBe(0)
  })

  it('an engine that answers a stream request with a whole document', async () => {
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[]}')
    })
    const server = await startPublic({ sessions: [localSession(port)] })
    const res = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    expect(res.headers.get('x-atomic-run-id')).toBeNull()
    expect(await res.json()).toEqual({ choices: [] })
  })

  it('a request over the run cap, which streams as before and stops with its client', async () => {
    const busy = await endlessEngine()
    const runs = new ChatRunRegistry({ maxRuns: 1 })
    const server = await startPublic({ sessions: [localSession(busy.port)], runs })
    const first = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    expect(first.headers.get('x-atomic-run-id')).not.toBeNull()
    await readUntil(first, (text) => events(text).length >= 1)

    const controller = new AbortController()
    const second = await postJson(server, '/chat/completions', chat, {
      headers: RESUMABLE,
      signal: controller.signal,
    })
    expect(second.status).toBe(200)
    expect(second.headers.get('x-atomic-run-id')).toBeNull()
    expect(await readUntil(second, (text) => events(text).length >= 2)).not.toMatch(/^id:/m)
    expect(runs.size).toBe(1)
    controller.abort()
    await expect.poll(() => busy.state.closed, { timeout: 2000 }).toBe(true)
  })

  it('a ChatGPT subscription model, which ignores the header', async () => {
    const chatgpt = await startStub((_req, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesStream('from subscription'))
    })
    try {
      const server = await startPublic({
        remote: [remoteProvider({ provider: 'chatgpt', baseUrl: null, apiKey: null, models: ['gpt-5'] })],
        chatgpt: { baseUrl: chatgpt.url, accessToken: async () => ({ token: 't', accountId: null }) },
      })
      const res = await postJson(
        server,
        '/chat/completions',
        { ...chat, model: 'gpt-5' },
        { headers: RESUMABLE }
      )
      expect(res.headers.get('x-atomic-run-id')).toBeNull()
      const text = await res.text()
      expect(text).toMatch(/data: \[DONE\]\n\n$/)
      expect(text).not.toMatch(/^id:/m)
    } finally {
      await chatgpt.close()
    }
  })
})

describe('the run routes', () => {
  it('answer one 404 for an unknown id, an expired run and another key’s run', async () => {
    const { port } = await engine(2)
    const clock = { now: 0 }
    const runs = new ChatRunRegistry({ now: () => clock.now })
    const server = await startPublic(
      { sessions: [localSession(port)], runs, clientKeys: () => ['device-a-key', 'device-b-key'] },
      { apiKey: 'server-key' }
    )
    const as = (key: string) => ({ authorization: `Bearer ${key}` })
    const res = await postJson(server, '/chat/completions', chat, {
      headers: { ...RESUMABLE, ...as('device-a-key') },
    })
    const id = res.headers.get('x-atomic-run-id')!
    await res.text()

    const notFound = {
      error: {
        message: 'No resumable run with this id.',
        type: 'invalid_request_error',
        code: 'run_not_found',
      },
    }
    for (const [label, answer] of [
      ['another device', await resume(server, id, '', { headers: as('device-b-key') })],
      ['the server key', await resume(server, id, '', { headers: as('server-key') })],
      ['an unknown id', await resume(server, 'A'.repeat(32), '', { headers: as('device-a-key') })],
      ['cancel by another device', await cancel(server, id, { headers: as('device-b-key') })],
    ] as const) {
      expect(answer.status, label).toBe(404)
      expect(answer.headers.get('content-type'), label).toBe('application/json')
      expect(await answer.json(), label).toEqual(notFound)
    }
    // The owner reads it, with its key as either header.
    const owner = await resume(server, id, '', { headers: as('device-a-key') })
    expect(owner.status).toBe(200)
    expect(contents(await owner.text())).toEqual(['t1', 't2', '[DONE]'])
    const viaHeader = await resume(server, id, '?after=3', { headers: { 'x-api-key': 'device-a-key' } })
    expect(await viaHeader.text()).toBe('')
    // No key at all is the gate's 401, as on every inference route.
    expect((await resume(server, id)).status).toBe(401)

    clock.now += RUN_TTL_AFTER_FINISH_MS
    const expired = await resume(server, id, '', { headers: as('device-a-key') })
    expect(expired.status).toBe(404)
    expect(await expired.json()).toEqual(notFound)
  })

  it('answer 410 when the events after the cursor were dropped from the buffer', async () => {
    const upstream = await engine(20)
    const server = await startPublic({
      sessions: [localSession(upstream.port)],
      runs: new ChatRunRegistry({ maxBufferBytes: 400 }),
    })
    const res = await postJson(server, '/chat/completions', chat, { headers: RESUMABLE })
    const id = res.headers.get('x-atomic-run-id')!
    await res.text()

    const gone = await resume(server, id, '?after=1')
    expect(gone.status).toBe(410)
    expect(await gone.json()).toEqual({
      error: {
        message: 'The events after 1 are no longer buffered. Send the request again.',
        type: 'invalid_request_error',
        code: 'run_events_gone',
      },
    })
    expect(contents(await (await resume(server, id, '?after=19')).text())).toEqual(['t20', '[DONE]'])
  })

  it('answer 400 for a cursor that is not a non-negative integer', async () => {
    const server = await startPublic({})
    for (const query of ['?after=-1', '?after=1.5', '?after=', '?after=abc']) {
      const res = await resume(server, 'A'.repeat(32), query)
      expect(res.status, query).toBe(400)
      expect(await res.json(), query).toMatchObject({ error: { code: 'invalid_value', param: 'after' } })
    }
  })

  it('serve POST only: a GET is a 405, never a stream', async () => {
    const server = await startPublic({})
    for (const action of ['events', 'cancel']) {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/atomic/runs/${'A'.repeat(32)}/${action}`)
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
      expect(res.headers.get('content-type')).not.toBe('text/event-stream')
      expect(await res.text()).toBe('Method Not Allowed')
    }
  })

  it('pass the same Host gate and carry the same CORS headers as the inference routes', async () => {
    const server = await startPublic({}, { trustedHosts: ['lan.example'] })
    const untrusted = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: `/v1/atomic/runs/${'A'.repeat(32)}/events`,
        headers: { host: 'evil.example' },
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(untrusted).toBe(403)
    const res = await resume(server, 'A'.repeat(32), '', { headers: { origin: 'http://lan.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://lan.example')
  })

  it('answer 404, and a resumable request streams as a plain one, where no runs are kept', async () => {
    const { port } = await engine(1)
    const deps: PublicServerDeps = {
      findLocal: (_provider, id) => (id === 'demo' ? localSession(port) : undefined),
      listLocal: () => [localSession(port)],
      providers: () => new Map(),
      increaseCtx: () => Promise.resolve({ ok: false }),
    }
    const listener: PublicServerConfig = {
      host: '127.0.0.1',
      port: 0,
      prefix: '/v1',
      apiKey: '',
      trustedHosts: [],
      proxyTimeoutSecs: 600,
    }
    const bare = createServer((req, res) => void handlePublicRequest(req, res, listener, deps))
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${(bare.address() as AddressInfo).port}/v1`
      expect((await fetch(`${base}/atomic/runs/${'A'.repeat(32)}/cancel`, { method: 'POST' })).status).toBe(
        404
      )
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: RESUMABLE,
        body: JSON.stringify(chat),
      })
      expect(res.headers.get('x-atomic-run-id')).toBeNull()
      expect(await res.text()).toBe(chunk(1) + 'data: [DONE]\n\n')
    } finally {
      bare.closeAllConnections()
      await new Promise((resolve) => bare.close(resolve))
    }
  })
})

describe('matchRunPath', () => {
  it.each([
    ['/atomic/runs/abc_-9/events', { id: 'abc_-9', action: 'events' }],
    ['/atomic/runs/abc/cancel', { id: 'abc', action: 'cancel' }],
    ['/atomic/runs/abc', undefined],
    ['/atomic/runs/a/b/events', undefined],
    ['/atomic/runs//events', undefined],
    ['/atomic/runs/abc/events/', undefined],
  ])('%s', (path, expected) => {
    expect(matchRunPath(path)).toEqual(expected)
  })
})

describe('runCursor', () => {
  it.each([
    [undefined, undefined, 0],
    ['after=7', undefined, 7],
    ['after=007', undefined, 7],
    ['x=1', '5', 5],
    ['after=2', '5', 2],
    [undefined, ' 9 ', 9],
    ['after=-1', undefined, undefined],
    [undefined, 'abc', undefined],
    ['after=1e3', undefined, undefined],
    ['after=1234567890123456', undefined, undefined],
  ])('%s with Last-Event-ID %s → %s', (query, lastEventId, expected) => {
    expect(runCursor(query, lastEventId)).toBe(expected)
  })
})
