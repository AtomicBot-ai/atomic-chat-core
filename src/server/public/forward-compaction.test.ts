/**
 * History compaction on the public `/chat/completions` (`server/compaction`, hooked into `forward.ts`):
 * before a request is sent, and once after the engine refused it for its size, on a llama.cpp
 * session and on one that declares its routes. A fake engine counts words as tokens.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreEvents } from '../../contracts/index.js'
import { renderedPrompt, wordCount, words } from '../../../test/helpers/fake-engine-fetch.js'
import {
  closeAll,
  localSession,
  postJson,
  startPublic,
  startUpstream,
} from '../../../test/helpers/public-server.js'
import { HistoryCompactor } from '../compaction/index.js'
import type { LocalTarget } from './types.js'

afterEach(closeAll)

interface Engine {
  port: number
  /** Bodies of the chat requests that were answered as chats (not summaries). */
  chats: Array<Record<string, unknown>>
  summaries: string[]
  paths: string[]
}

/**
 * A local engine: llama.cpp's `/apply-template` + `/tokenize`, the chat `/tokenize`, and chat
 * completions that refuse a prompt over `limit` words with `overflow` — streamed or not.
 */
async function engine(
  options: { limit?: number; overflow?: (words: number) => object; finishLength?: boolean } = {}
) {
  const state: Engine = { port: 0, chats: [], summaries: [], paths: [] }
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const handler = (req: IncomingMessage, raw: string, res: ServerResponse) => {
    const path = req.url ?? ''
    state.paths.push(path)
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (path === '/apply-template') return json(res, 200, { prompt: renderedPrompt(body) })
    if (path === '/tokenize') {
      if (typeof body['content'] === 'string')
        return json(res, 200, { tokens: Array.from({ length: wordCount(body['content']) }, () => 1) })
      return json(res, 200, { count: wordCount(renderedPrompt(body)), max_model_len: 2000 })
    }
    const prompt = renderedPrompt(body)
    if (prompt.includes('<conversation>')) {
      state.summaries.push(prompt)
      return json(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'They set the project up.' } }],
      })
    }
    const size = wordCount(prompt)
    if (options.limit !== undefined && size > options.limit) {
      return json(res, 400, options.overflow?.(size) ?? { error: { message: 'too long' } })
    }
    state.chats.push(body)
    if (body['stream'] === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fine' } }] })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }
    const cut = options.finishLength && state.chats.length === 1
    json(res, 200, {
      choices: [{ message: { role: 'assistant', content: 'fine' }, finish_reason: cut ? 'length' : 'stop' }],
      usage: { prompt_tokens: size, completion_tokens: 1 },
    })
  }
  state.port = (await startUpstream(handler)).port
  return state
}

/** llama.cpp b12019's overflow, with the window it ran out of. */
const llamaOverflow = (window: number) => (size: number) => ({
  error: {
    code: 400,
    message: `request (${size} tokens) exceeds the available context size (${window} tokens), try increasing it`,
    type: 'exceed_context_size_error',
    n_prompt_tokens: size,
    n_ctx: window,
  },
})

/** Twenty turns of 100 words between a short system prompt and a last question: 2012 tokens in the fake. */
function history(turns = 20): Array<{ role: string; content: string }> {
  const out = [{ role: 'system', content: words(10, 'sys') }]
  for (let i = 0; i < turns; i++) {
    out.push(
      { role: 'user', content: words(50, `u${i}x`) },
      { role: 'assistant', content: words(50, `a${i}x`) }
    )
  }
  out.push({ role: 'user', content: 'and now?' })
  return out
}

function recorder() {
  const events: Array<CoreEvents['session:history-compacted']> = []
  const emit = <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => {
    if (name === 'session:history-compacted') events.push(payload as CoreEvents['session:history-compacted'])
  }
  return { events, emit }
}

describe('compaction before a request is sent', () => {
  it('summarizes the oldest turns of a chat over its window and says so', async () => {
    const upstream = await engine()
    const { events, emit } = recorder()
    const server = await startPublic({
      sessions: [localSession(upstream.port)],
      contextWindow: () => Promise.resolve(2000),
      emit,
    })
    const messages = history()
    const res = await postJson(server, '/chat/completions', { model: 'demo', messages, max_tokens: 100 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: 'fine' } }] })
    const summarized = Number(res.headers.get('x-atomic-compacted'))
    expect(summarized).toBeGreaterThan(0)

    expect(upstream.summaries.length).toBeGreaterThan(0)
    expect(upstream.chats).toHaveLength(1)
    const sent = upstream.chats[0]!['messages'] as Array<{ role: string; content: string }>
    expect(sent[0]?.role).toBe('system')
    expect(sent[0]?.content).toContain('They set the project up.')
    expect(sent.at(-1)).toEqual(messages.at(-1))
    expect(sent).toHaveLength(messages.length - summarized)
    expect(upstream.chats[0]).toMatchObject({ model: 'demo', max_tokens: 100 })
    expect(events).toEqual([
      expect.objectContaining({
        provider: 'llamacpp-upstream',
        modelId: 'demo',
        summarizedMessages: summarized,
        tokensBefore: 2012,
        cached: false,
        source: 'api',
      }),
    ])
    expect(events[0]!.tokensAfter).toBeLessThan(1000)
  })

  it('compacts a streamed chat the same way, before anything was sent', async () => {
    const upstream = await engine()
    const server = await startPublic({
      sessions: [localSession(upstream.port)],
      contextWindow: () => Promise.resolve(2000),
    })
    const res = await postJson(server, '/chat/completions', {
      model: 'demo',
      stream: true,
      messages: history(),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(Number(res.headers.get('x-atomic-compacted'))).toBeGreaterThan(0)
    expect(await res.text()).toContain('"fine"')
    expect((upstream.chats[0]!['messages'] as unknown[]).length).toBeLessThan(history().length)
  })

  it('answers a client that sends its whole history again from the summary it already has', async () => {
    const upstream = await engine()
    const { events, emit } = recorder()
    const server = await startPublic({
      sessions: [localSession(upstream.port)],
      contextWindow: () => Promise.resolve(2000),
      emit,
    })
    await postJson(server, '/chat/completions', { model: 'demo', messages: history() })
    const summaryCalls = upstream.summaries.length
    const again = await postJson(server, '/chat/completions', { model: 'demo', messages: history() })
    expect(again.status).toBe(200)
    expect(again.headers.get('x-atomic-compacted')).not.toBeNull()
    expect(upstream.summaries).toHaveLength(summaryCalls)
    expect(events.map((e) => e.cached)).toEqual([false, true])
    expect(upstream.chats[1]).toEqual(upstream.chats[0])
  })

  it('sends a request that fits, one with `x-atomic-compaction: off`, and any when the host turned it off, as they are', async () => {
    const upstream = await engine()
    const sessions = [localSession(upstream.port)]
    const server = await startPublic({ sessions, contextWindow: () => Promise.resolve(2000) })
    const off = await postJson(
      server,
      '/chat/completions',
      { model: 'demo', messages: history() },
      { headers: { 'content-type': 'application/json', 'x-atomic-compaction': 'off' } }
    )
    expect(off.headers.get('x-atomic-compacted')).toBeNull()
    const short = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'ok' },
    ]
    const small = await postJson(server, '/chat/completions', { model: 'demo', messages: short })
    expect(small.headers.get('x-atomic-compacted')).toBeNull()
    const disabled = await startPublic({
      sessions,
      contextWindow: () => Promise.resolve(2000),
      compaction: false,
    })
    const host = await postJson(disabled, '/chat/completions', { model: 'demo', messages: history() })
    expect(host.headers.get('x-atomic-compacted')).toBeNull()
    expect(upstream.summaries).toEqual([])
    expect(upstream.chats.map((c) => (c['messages'] as unknown[]).length)).toEqual([
      history().length,
      short.length,
      history().length,
    ])
    // A request that surely fits is never counted.
    expect(upstream.paths.filter((p) => p === '/apply-template')).toHaveLength(0)
  })

  it("uses the host's compactor and maximum, and its switch turns compaction off per request", async () => {
    const upstream = await engine()
    let enabled = false
    const asked: string[] = []
    const compactor = new HistoryCompactor()
    const server = await startPublic({
      sessions: [localSession(upstream.port)],
      contextWindow: () => Promise.resolve(2000),
      compaction: {
        compactor,
        enabled: () => enabled,
        maxWindow: (target) => {
          asked.push(target.modelId)
          return Promise.resolve(undefined)
        },
      },
    })
    const off = await postJson(server, '/chat/completions', { model: 'demo', messages: history() })
    expect(off.headers.get('x-atomic-compacted')).toBeNull()
    enabled = true
    const on = await postJson(server, '/chat/completions', { model: 'demo', messages: history() })
    expect(on.headers.get('x-atomic-compacted')).not.toBeNull()
    expect(asked).toEqual(['demo'])
    expect(compactor.cache.size).toBe(1)
  })

  it('leaves /v1/messages to the agent, which compacts its own conversation', async () => {
    const upstream = await engine()
    const server = await startPublic({
      sessions: [localSession(upstream.port)],
      contextWindow: () => Promise.resolve(2000),
    })
    const conversation = history().filter((m) => m.role !== 'system')
    await postJson(server, '/messages', { model: 'demo', max_tokens: 64, messages: conversation })
    expect(upstream.summaries).toEqual([])
    expect(upstream.paths).toEqual(['/v1/messages'])
  })
})

describe('compaction after an overflow', () => {
  it('grows a llama.cpp session first, and compacts and replays once when it does not grow', async () => {
    const upstream = await engine({ limit: 1800, overflow: llamaOverflow(2000) })
    const triggers: string[] = []
    const server = await startPublic({
      sessions: [localSession(upstream.port)],
      increaseCtx: (_provider, _model, trigger) => {
        triggers.push(trigger)
        return Promise.resolve({ ok: false, reason: 'at_max' })
      },
    })
    const res = await postJson(server, '/chat/completions', { model: 'demo', messages: history() })
    expect(res.status).toBe(200)
    expect(Number(res.headers.get('x-atomic-compacted'))).toBeGreaterThan(0)
    expect(triggers).toEqual(['error'])
    expect(upstream.chats).toHaveLength(1)
    expect(wordCount(renderedPrompt(upstream.chats[0]!))).toBeLessThan(1800)
  })

  it("answers the engine's first error when the compacted replay overflows as well", async () => {
    const upstream = await engine({ limit: 50, overflow: llamaOverflow(2000) })
    const server = await startPublic({ sessions: [localSession(upstream.port)] })
    const res = await postJson(server, '/chat/completions', { model: 'demo', messages: history() })
    expect(res.status).toBe(400)
    expect(res.headers.get('x-atomic-compacted')).toBeNull()
    expect(await res.json()).toMatchObject({ error: { n_prompt_tokens: 2012 } })
    expect(upstream.summaries.length).toBeGreaterThan(0)
  })

  it('answers the original overflow when compaction cannot help', async () => {
    const upstream = await engine({ limit: 10, overflow: llamaOverflow(2000) })
    const server = await startPublic({ sessions: [localSession(upstream.port)] })
    const res = await postJson(server, '/chat/completions', {
      model: 'demo',
      messages: [{ role: 'user', content: words(50) }],
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { type: 'exceed_context_size_error' } })
    expect(upstream.summaries).toEqual([])
  })

  it('compacts a declared session on its mapped context_length_exceeded, and never asks it to grow', async () => {
    const upstream = await engine({
      limit: 1800,
      overflow: (size) => ({
        object: 'error',
        message: `This model's maximum context length is 2000 tokens. However, you requested ${size} tokens.`,
        type: 'BadRequestError',
        code: 400,
      }),
    })
    const vllm: LocalTarget = localSession(upstream.port, {
      provider: 'vllm',
      modelId: 'qwen',
      policy: {
        routes: [
          { method: 'POST', path: '/v1/chat/completions' },
          { method: 'POST', path: '/tokenize' },
        ],
        tools: true,
        structuredOutput: true,
        mapError: (status, body) =>
          status === 400 && body.includes('maximum context length')
            ? { error: { message: body, type: 'invalid_request_error', code: 'context_length_exceeded' } }
            : null,
      },
    })
    const asked: string[] = []
    const server = await startPublic({
      sessions: [vllm],
      increaseCtx: (_p, _m, trigger) => {
        asked.push(trigger)
        return Promise.resolve({ ok: true })
      },
    })
    const res = await postJson(server, '/chat/completions', {
      model: 'qwen',
      stream: true,
      messages: history(),
    })
    expect(res.status).toBe(200)
    expect(Number(res.headers.get('x-atomic-compacted'))).toBeGreaterThan(0)
    expect(await res.text()).toContain('"fine"')
    expect(asked).toEqual([])
    // Counted by the chat /tokenize the session declares.
    expect(upstream.paths).toContain('/tokenize')
    expect(upstream.paths).not.toContain('/apply-template')
  })

  it('compacts a non-streamed answer cut off at the window once growing declined', async () => {
    const upstream = await engine({ finishLength: true })
    const server = await startPublic({ sessions: [localSession(upstream.port)] })
    const res = await postJson(server, '/chat/completions', { model: 'demo', messages: history() })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ choices: [{ finish_reason: 'stop' }] })
    expect(Number(res.headers.get('x-atomic-compacted'))).toBeGreaterThan(0)
    expect(upstream.chats).toHaveLength(2)
  })
})
