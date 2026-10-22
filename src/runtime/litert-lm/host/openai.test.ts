import { describe, expect, it } from 'vitest'
import { OpenAiRequestError, parseChatRequest, ReplyBuilder } from './openai.js'

const CAPS = { vision: true, reasoning: false }
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  },
]

describe('parseChatRequest', () => {
  it('turns OpenAI messages into the library conversation, the last one apart', () => {
    const parsed = parseChatRequest(
      {
        model: 'm',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'developer', content: [{ type: 'text', text: 'No emoji.' }] },
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temperature_c":18}' },
        ],
        tools: TOOLS,
        unknown_field: 1,
      },
      CAPS
    )
    expect(parsed.history).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
      { role: 'system', content: [{ type: 'text', text: 'No emoji.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
      },
    ])
    expect(parsed.next).toEqual([
      {
        role: 'tool',
        content: [{ type: 'tool_response', name: 'get_weather', response: { temperature_c: 18 } }],
      },
    ])
    expect(parsed.tools).toEqual(TOOLS)
    expect(parsed).toMatchObject({
      stream: false,
      includeUsage: false,
      stop: [],
      responseFormat: null,
      thinking: false,
    })
  })

  it('sends a run of tool results together, and keeps a plain-text tool result as text', () => {
    const parsed = parseChatRequest(
      {
        messages: [
          { role: 'user', content: 'Both cities' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'w', arguments: '{"city":"A"}' } },
              { id: 'b', type: 'function', function: { name: 'w', arguments: '{"city":"B"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'a', content: 'sunny' },
          { role: 'tool', tool_call_id: 'b', content: [{ type: 'text', text: 'rain' }] },
        ],
      },
      CAPS
    )
    expect(parsed.history).toHaveLength(2)
    expect(parsed.next).toEqual([
      { role: 'tool', content: [{ type: 'tool_response', name: 'w', response: 'sunny' }] },
      { role: 'tool', content: [{ type: 'tool_response', name: 'w', response: 'rain' }] },
    ])
  })

  it('reads an image as a data URL blob for a model with vision', () => {
    const parsed = parseChatRequest(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
              { type: 'text', text: 'Color?' },
            ],
          },
        ],
      },
      CAPS
    )
    expect(parsed.next).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', blob: 'iVBORw0KGgo=' },
          { type: 'text', text: 'Color?' },
        ],
      },
    ])
  })

  it('reads sampling, limits, stop, usage, response formats and thinking', () => {
    const parsed = parseChatRequest(
      {
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.2,
        top_p: 0.9,
        top_k: 20,
        seed: 7,
        max_completion_tokens: 64,
        max_tokens: 99,
        stop: 'END',
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'p', schema: { type: 'object', properties: { a: { type: 'integer' } } } },
        },
        reasoning_effort: 'high',
      },
      CAPS
    )
    expect(parsed).toMatchObject({
      stream: true,
      includeUsage: true,
      sampler: { temperature: 0.2, topP: 0.9, topK: 20, seed: 7 },
      maxTokens: 64,
      stop: ['END'],
      responseFormat: {
        kind: 'json_schema',
        value: '{"type":"object","properties":{"a":{"type":"integer"}}}',
      },
      thinking: true,
    })
    const plain = parseChatRequest(
      {
        messages: [{ role: 'user', content: 'x' }],
        response_format: { type: 'json_object' },
        stop: ['a', 'b'],
      },
      { vision: false, reasoning: true }
    )
    expect(plain).toMatchObject({
      responseFormat: { kind: 'json_schema', value: '{"type":"object"}' },
      stop: ['a', 'b'],
    })
    expect(plain.thinking).toBe(true)
    expect(
      parseChatRequest(
        { messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: false } },
        { vision: false, reasoning: true }
      ).thinking
    ).toBe(false)
    expect(
      parseChatRequest(
        { messages: [{ role: 'user', content: 'x' }], tool_choice: 'none', tools: TOOLS },
        CAPS
      ).tools
    ).toBeNull()
  })

  it.each([
    [{ messages: [{ role: 'user', content: 'x' }], n: 2 }, CAPS, /n/],
    [
      {
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
        ],
      },
      { vision: false, reasoning: false },
      /image/,
    ],
    [
      {
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }],
      },
      CAPS,
      /data URL/,
    ],
    [
      {
        messages: [{ role: 'user', content: 'x' }],
        tools: TOOLS,
        tool_choice: { type: 'function', function: { name: 'w' } },
      },
      CAPS,
      /tool_choice/,
    ],
    [
      { messages: [{ role: 'user', content: 'x' }], tools: TOOLS, tool_choice: 'required' },
      CAPS,
      /tool_choice/,
    ],
    [{ messages: [] }, CAPS, /messages/],
    [{ messages: [{ role: 'assistant', content: 'x' }] }, CAPS, /last message/],
    [{ messages: [{ role: 'wizard', content: 'x' }] }, CAPS, /role/],
    [{ messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] }, CAPS, /input_audio/],
    [
      { messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema' } },
      CAPS,
      /schema/,
    ],
    [{ messages: [{ role: 'user', content: 'x' }], temperature: 'hot' }, CAPS, /temperature/],
    ['nope', CAPS, /JSON object/],
  ])('refuses %j with a 400', (body, caps, message) => {
    let error: unknown
    try {
      parseChatRequest(body, caps)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(OpenAiRequestError)
    expect((error as OpenAiRequestError).status).toBe(400)
    expect((error as OpenAiRequestError).body.error.message).toMatch(message)
    expect((error as OpenAiRequestError).body.error.type).toBe('invalid_request_error')
  })
})

const chunk = (message: Record<string, unknown>) => JSON.stringify({ role: 'assistant', ...message })

describe('ReplyBuilder', () => {
  it('turns library chunks into content and reasoning deltas, and the whole reply', () => {
    const reply = new ReplyBuilder([])
    expect(reply.add(chunk({ channels: { thought: 'Hmm' } }))).toEqual([{ reasoning_content: 'Hmm' }])
    expect(reply.add(chunk({ content: [{ type: 'text', text: 'Hel' }] }))).toEqual([{ content: 'Hel' }])
    expect(reply.add(chunk({ content: [{ type: 'text', text: 'lo' }] }))).toEqual([{ content: 'lo' }])
    expect(reply.add('not json at all')).toEqual([{ content: 'not json at all' }])
    expect(reply.finish(null)).toBe('stop')
    expect(reply.message()).toEqual({
      role: 'assistant',
      content: 'Hellonot json at all',
      reasoning_content: 'Hmm',
    })
    expect(reply.completionChunks).toBe(4)
    expect(reply.history()).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hellonot json at all' }],
    })
  })

  it('reports a tool call as one tool_calls delta with string arguments, and finishes with tool_calls', () => {
    const reply = new ReplyBuilder([], () => 'call_x')
    expect(
      reply.add(
        chunk({
          tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
        })
      )
    ).toEqual([
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_x',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
    ])
    expect(reply.finish(null)).toBe('tool_calls')
    expect(reply.message()).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      ],
    })
    expect(reply.history()).toEqual({
      role: 'assistant',
      content: [],
      tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
    })
  })

  it('cuts the reply at a stop string, even across chunks, and says when to stop the library', () => {
    const reply = new ReplyBuilder(['END'])
    expect(reply.add(chunk({ content: [{ type: 'text', text: 'abc E' }] }))).toEqual([{ content: 'abc ' }])
    expect(reply.stopped).toBe(false)
    expect(reply.add(chunk({ content: [{ type: 'text', text: 'ND tail' }] }))).toEqual([])
    expect(reply.stopped).toBe(true)
    expect(reply.add(chunk({ content: [{ type: 'text', text: 'more' }] }))).toEqual([])
    expect(reply.finish('CANCELLED: Task cancelled')).toBe('stop')
    expect(reply.message().content).toBe('abc ')
  })

  it('gives back held text at the end, maps the token limit to length, and other errors to an error', () => {
    const held = new ReplyBuilder(['END'])
    held.add(chunk({ content: [{ type: 'text', text: 'x E' }] }))
    expect(held.flush()).toEqual([{ content: 'E' }])
    expect(held.finish(null)).toBe('stop')
    expect(new ReplyBuilder([]).finish('Max number of tokens reached.')).toBe('length')
    expect(() => new ReplyBuilder([]).finish('INTERNAL: GPU lost')).toThrow(/GPU lost/)
  })
})
