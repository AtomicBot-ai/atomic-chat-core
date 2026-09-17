import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { listSubscriptionModels, serveSubscriptionChat } from './chatgpt.js'
import type { ChatGptBackend, ChatGptReply } from './chatgpt.js'
import { json, responsesStream, startStub } from '../../test/helpers/chatgpt-stub.js'
import type { Stub } from '../../test/helpers/chatgpt-stub.js'

let upstream: Stub
let tokens: string[]

beforeEach(async () => {
  upstream = await startStub((_req, res) => json(res, 500, {}))
  tokens = []
})
afterEach(async () => {
  await upstream.close()
})

function backend(over: Partial<ChatGptBackend> = {}): ChatGptBackend {
  return {
    baseUrl: upstream.url,
    accessToken: async (force) => {
      const token = force ? 'refreshed' : 'stale'
      tokens.push(token)
      return { token, accountId: 'acct_1' }
    },
    ...over,
  }
}

function recorder() {
  const out: { status?: number; body?: string; frames?: string[]; closed?: boolean } = {}
  const reply: ChatGptReply = {
    error: (status, message) => Object.assign(out, { status, body: message }),
    json: (body) => Object.assign(out, { status: 200, body }),
    stream: async (chunks) => {
      out.status = 200
      out.frames = []
      for await (const chunk of chunks) out.frames.push(chunk)
    },
  }
  return { out, reply }
}

const chat = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }

describe('serveSubscriptionChat', () => {
  it('aggregates the stream for a client that did not ask to stream', async () => {
    upstream.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesStream('hello'))
    })
    const { out, reply } = recorder()

    await serveSubscriptionChat(backend(), chat, false, reply)

    expect(out.status).toBe(200)
    expect(JSON.parse(out.body as string)).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    })
    expect(upstream.requests[0]).toMatchObject({ method: 'POST', path: '/responses' })
    expect(upstream.requests[0]?.headers).toMatchObject({
      'authorization': 'Bearer stale',
      'chatgpt-account-id': 'acct_1',
      'openai-beta': 'responses=experimental',
      'originator': 'atomic_chat',
    })
    const sessionId = upstream.requests[0]?.headers['session-id']
    expect(JSON.parse(upstream.requests[0]?.body ?? '{}')).toMatchObject({
      prompt_cache_key: sessionId,
      stream: true,
    })
  })

  it('streams chat chunks and always closes with a finish chunk and [DONE], even on a stream cut short', async () => {
    upstream.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // No trailing newline and no response.completed: the upstream simply stops.
      res.end(responsesStream('hi').split('event: response.completed')[0] + 'data: [DONE]')
    })
    const { out, reply } = recorder()

    await serveSubscriptionChat(backend(), chat, true, reply)

    expect(out.frames?.at(-1)).toBe('data: [DONE]\n\n')
    const chunks = (out.frames ?? []).slice(0, -1).map(
      (f) =>
        JSON.parse(f.slice('data: '.length)) as {
          choices: Array<{ delta: { content?: string }; finish_reason: string | null }>
        }
    )
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('hi')
    expect(chunks.at(-1)?.choices[0]?.finish_reason).not.toBeNull()
  })

  it('spends exactly one forced refresh on a 401, then reports what the upstream says verbatim', async () => {
    upstream.handle((_req, res) => json(res, 401, { detail: 'expired' }))
    const { out, reply } = recorder()

    await serveSubscriptionChat(backend(), chat, false, reply)

    expect(tokens).toEqual(['stale', 'refreshed'])
    expect([out.status, out.body]).toEqual([401, '{"detail":"expired"}'])
  })

  it('passes a quota error through, reports a converter error as 502, and a missing session as 401', async () => {
    upstream.handle((_req, res) => json(res, 429, { error: { message: 'usage limit' } }))
    const quota = recorder()
    await serveSubscriptionChat(backend(), chat, false, quota.reply)
    expect([quota.out.status, quota.out.body]).toEqual([429, '{"error":{"message":"usage limit"}}'])

    upstream.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'model overloaded' } } })}\n\n`
      )
    })
    const failed = recorder()
    await serveSubscriptionChat(backend(), chat, false, failed.reply)
    expect(failed.out.status).toBe(502)

    const signedOut = recorder()
    await serveSubscriptionChat(
      backend({
        accessToken: async () => {
          throw new AtomicCoreError('AUTH_REQUIRED', 'no ChatGPT subscription is connected')
        },
      }),
      chat,
      false,
      signedOut.reply
    )
    expect([signedOut.out.status, signedOut.out.body]).toEqual([401, 'no ChatGPT subscription is connected'])
  })

  it('reports an unreachable subscription as a gateway failure', async () => {
    const { out, reply } = recorder()
    await serveSubscriptionChat(backend({ baseUrl: 'http://127.0.0.1:9' }), chat, false, reply)
    expect(out.status).toBe(502)
    expect(out.body).toMatch(/^ChatGPT subscription request failed: /)
  })
})

describe('listSubscriptionModels', () => {
  it('asks with the client version, refreshes once on 401 and keeps the first of a repeated slug', async () => {
    let calls = 0
    upstream.handle((_req, res) => {
      calls++
      if (calls === 1) return json(res, 401, {})
      json(res, 200, {
        models: [{ slug: 'gpt-5', visibility: 'list' }, { slug: 'gpt-5', display_name: 'dupe' }, { nope: 1 }],
      })
    })

    const models = await listSubscriptionModels(backend())

    expect(models).toEqual([
      {
        id: 'gpt-5',
        display_name: 'gpt-5',
        context_length: null,
        vision: false,
        reasoning_efforts: [],
        listed: true,
      },
    ])
    expect(upstream.requests.at(-1)?.path).toBe('/models?client_version=0.156.0')
    expect(tokens).toEqual(['stale', 'refreshed'])
  })

  it('reports a refused list, an unreadable one, an absent list and an unreachable service', async () => {
    upstream.handle((_req, res) => json(res, 403, { detail: 'plan' }))
    await expect(listSubscriptionModels(backend())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'Could not list ChatGPT models (403): {"detail":"plan"}',
    })
    upstream.handle((_req, res) => res.end('<html>'))
    await expect(listSubscriptionModels(backend())).rejects.toMatchObject({
      message: expect.stringMatching(/^ChatGPT returned an unreadable model list/),
    })
    upstream.handle((_req, res) => json(res, 200, {}))
    expect(await listSubscriptionModels(backend())).toEqual([])
    await expect(listSubscriptionModels(backend({ baseUrl: 'http://127.0.0.1:9' }))).rejects.toMatchObject({
      message: expect.stringMatching(/^Could not reach ChatGPT: /),
    })
  })
})
