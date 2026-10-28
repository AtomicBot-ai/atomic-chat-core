import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  completionBody,
  notServed,
  OpenAiRequestError,
  parseCommonChatRequest,
  parseResponseFormat,
  parseThinking,
  readJsonBody,
  sendJson,
  sendOpenAiError,
  SSE_DONE,
  sseFramer,
  textOf,
} from './openai-sse.js'

const CAPS = { vision: false, reasoning: false }
const user = (extra: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: 'x' }],
  ...extra,
})

describe('parseCommonChatRequest (change add-geniex-runtime, task 5.4)', () => {
  it('reads what every host reads alike: sampling, limits, stop, usage, response format, thinking, tools', () => {
    expect(
      parseCommonChatRequest(
        user({
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.2,
          top_p: 0.9,
          top_k: 20.4,
          seed: 7,
          max_completion_tokens: 64,
          max_tokens: 99,
          stop: 'END',
          response_format: { type: 'json_object' },
          reasoning_effort: 'high',
          tools: [{ type: 'function', function: { name: 'w' } }],
        }),
        CAPS
      )
    ).toEqual({
      stream: true,
      includeUsage: true,
      sampler: { temperature: 0.2, topP: 0.9, topK: 20, seed: 7 },
      maxTokens: 64,
      stop: ['END'],
      responseFormat: { kind: 'json_schema', value: '{"type":"object"}' },
      thinking: true,
      tools: [{ type: 'function', function: { name: 'w' } }],
    })
    expect(
      parseCommonChatRequest(user({ tool_choice: 'none', tools: [{ type: 'function' }] }), CAPS).tools
    ).toBeNull()
    expect(parseCommonChatRequest(user({ stop: ['a', '', 'b'], max_tokens: 0.2 }), CAPS)).toMatchObject({
      stop: ['a', 'b'],
      maxTokens: 1,
    })
  })

  it.each([
    [user({ n: 2 }), /n: 1/],
    [user({ tool_choice: 'required' }), /tool_choice/],
    [{ messages: [] }, /messages/],
    [user({ temperature: 'hot' }), /temperature/],
    [user({ response_format: { type: 'xml' } }), /response_format/],
    [user({ response_format: 7 }), /object/],
  ])('refuses %j with a 400', (body, message) => {
    expect(() => parseCommonChatRequest(body as Record<string, unknown>, CAPS)).toThrow(message)
    try {
      parseCommonChatRequest(body as Record<string, unknown>, CAPS)
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAiRequestError)
      expect((error as OpenAiRequestError).status).toBe(400)
      expect((error as OpenAiRequestError).body.error.type).toBe('invalid_request_error')
    }
  })

  it('reads thinking from chat_template_kwargs first, then reasoning_effort, then the model default', () => {
    expect(
      parseThinking({ chat_template_kwargs: { enable_thinking: false } }, { vision: false, reasoning: true })
    ).toBe(false)
    expect(parseThinking({ reasoning_effort: 'none' }, { vision: false, reasoning: true })).toBe(false)
    expect(parseThinking({}, { vision: false, reasoning: true })).toBe(true)
    expect(parseResponseFormat({ type: 'text' })).toBeNull()
    expect(parseResponseFormat({ type: 'json_schema', json_schema: { schema: { type: 'object' } } })).toEqual(
      {
        kind: 'json_schema',
        value: '{"type":"object"}',
      }
    )
    expect(
      textOf(
        [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        'c'
      )
    ).toBe('ab')
    expect(() => textOf([{ type: 'image_url' }], 'c')).toThrow(/text parts only/)
  })
})

describe('SSE frames and the HTTP plumbing', () => {
  it('frames chunks under one id, the completion body alike, and names a route it does not serve', () => {
    const framer = sseFramer('chatcmpl-1', 1700, 'm')
    expect(framer.delta({ content: 'hi' })).toBe(
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'
    )
    expect(framer.frame({ choices: [], usage: { total_tokens: 1 } })).toContain('"usage":{"total_tokens":1}')
    expect(
      completionBody(framer, 'm', { role: 'assistant', content: 'x' }, 'stop', {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      })
    ).toEqual({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1700,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    expect(SSE_DONE).toBe('data: [DONE]\n\n')
    expect(notServed('POST', '/v1/embeddings', 'GenieX')).toMatchObject({
      status: 404,
      body: { error: { message: 'POST /v1/embeddings is not served by GenieX.', code: 'not_found' } },
    })
  })

  it('reads a JSON body, refusing what is not JSON with 400 and what is too large with 413', async () => {
    const seen: unknown[] = []
    const server = createServer((req, res) => {
      readJsonBody(req).then(
        (body) => {
          seen.push(body)
          sendJson(res, 200, { ok: true })
        },
        (error: OpenAiRequestError) => sendOpenAiError(res, error)
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    try {
      expect((await fetch(url, { method: 'POST', body: '{"a":1}' })).status).toBe(200)
      expect(seen).toEqual([{ a: 1 }])
      const bad = await fetch(url, { method: 'POST', body: '{' })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({ error: { message: 'The request body is not valid JSON.' } })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
