import { describe, expect, it } from 'vitest'
import { AnthropicStreamConverter, anthropicRequestToChat, chatResponseToAnthropic } from './anthropic.js'
import type { JsonValue } from './json.js'

const sse = (chunk: JsonValue): string => `data: ${JSON.stringify(chunk)}\n\n`
const textChunk = (content: string, finish: string | null = null): JsonValue => ({
  id: 'c1',
  model: 'm',
  choices: [{ delta: { content }, finish_reason: finish }],
})
const types = (events: JsonValue[]): string[] => events.map((e) => (e as { type: string }).type)

describe('anthropicRequestToChat', () => {
  it('turns a plain conversation into a chat request with the system prompt first', () => {
    expect(
      anthropicRequestToChat({
        model: 'm',
        system: 'be terse',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).toEqual({
      model: 'm',
      stream: false,
      // max_tokens is not forwarded: the Rust leaves it to the engine's own limit.
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    })
  })

  it('rejects a request without model or messages, or with a role-less message', () => {
    expect(anthropicRequestToChat({ messages: [] })).toBeNull()
    expect(anthropicRequestToChat({ model: 'm' })).toBeNull()
    expect(anthropicRequestToChat({ model: 'm', messages: [{ content: 'hi' }] })).toBeNull()
  })

  it('collapses every system and developer message into one leading system message', () => {
    // Strict chat templates refuse a second or non-leading system message.
    const chat = anthropicRequestToChat({
      model: 'm',
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'developer', content: [{ type: 'text', text: 'dev' }] },
      ],
    }) as { messages: JsonValue[] }
    expect(chat.messages).toEqual([
      { role: 'system', content: 'sys\n\ndev' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('serialises tool_use input as compact JSON with keys sorted at every depth', () => {
    // serde_json (without preserve_order) sorts keys; engines that cache prompts see identical bytes.
    const chat = anthropicRequestToChat({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'get', input: { z: 1, a: { y: 'é', b: [3] } } }],
        },
      ],
    }) as { messages: Array<{ content: JsonValue; tool_calls: Array<{ function: { arguments: string } }> }> }
    expect(chat.messages[0]?.content).toBeNull()
    expect(chat.messages[0]?.tool_calls[0]?.function.arguments).toBe('{"a":{"b":[3],"y":"é"},"z":1}')
  })

  it('puts tool results before the user text of the same turn', () => {
    const chat = anthropicRequestToChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'and then' },
            { type: 'tool_result', tool_use_id: 't1', content: { ok: true } },
            { type: 'tool_result', tool_use_id: 't2', content: null },
          ],
        },
      ],
    }) as { messages: JsonValue[] }
    expect(chat.messages).toEqual([
      { role: 'tool', tool_call_id: 't1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 't2', content: 'null' },
      { role: 'user', content: 'and then' },
    ])
  })

  it('turns a base64 image into a data URL part next to the text', () => {
    const chat = anthropicRequestToChat({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    }) as { messages: JsonValue[] }
    expect(chat.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ])
  })
})

describe('chatResponseToAnthropic', () => {
  it('maps text, tool calls and the finish reason', () => {
    expect(
      chatResponseToAnthropic({
        id: 'c',
        model: 'm',
        choices: [
          {
            message: {
              content: 'calling',
              tool_calls: [
                { id: 'call_1', function: { name: 'get', arguments: '{"a":1}' } },
                { id: 'call_2', function: { name: 'bad', arguments: 'not json' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    ).toEqual({
      id: 'c',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'call_1', name: 'get', input: { a: 1 } },
        // Broken arguments do not fail the response; the tool just gets an empty input.
        { type: 'tool_use', id: 'call_2', name: 'bad', input: {} },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  })
})

describe('AnthropicStreamConverter', () => {
  it('streams text and closes the message on [DONE] with a word count as output_tokens', () => {
    const conv = new AnthropicStreamConverter()
    const events = [
      ...conv.onNetworkChunk(sse(textChunk('hello '))),
      ...conv.onNetworkChunk(sse(textChunk('big world'))),
      ...conv.onNetworkChunk('data: [DONE]\n\n'),
    ]
    expect(types(events)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[5]).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    })
    expect(conv.done).toBe(true)
  })

  it('delivers a data line that arrives split across two network reads', () => {
    // The Rust split each read into lines on its own and dropped both halves of such a line.
    const conv = new AnthropicStreamConverter()
    const line = sse(textChunk('split'))
    const cut = 20
    expect(conv.onNetworkChunk(line.slice(0, cut))).toEqual([])
    const events = conv.onNetworkChunk(line.slice(cut))
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'split' },
    })
  })

  it('handles CRLF line endings, including a \\r\\n pair cut between reads', () => {
    const conv = new AnthropicStreamConverter()
    const line = `data: ${JSON.stringify(textChunk('x'))}\r`
    expect(conv.onNetworkChunk(line)).toEqual([])
    expect(types(conv.onNetworkChunk('\n\r\n'))).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
    ])
  })

  it('stops at a finish_reason and ignores everything after it, [DONE] included', () => {
    const conv = new AnthropicStreamConverter()
    const events = conv.onNetworkChunk(
      sse(textChunk('hi')) +
        sse({ choices: [{ delta: {}, finish_reason: 'length' }] }) +
        sse(textChunk('ignored'))
    )
    expect(types(events).slice(-2)).toEqual(['message_delta', 'message_stop'])
    expect((events.at(-2) as { delta: { stop_reason: string } }).delta.stop_reason).toBe('max_tokens')
    expect(conv.done).toBe(true)
    expect(conv.onNetworkChunk('data: [DONE]\n\n')).toEqual([])
  })

  it('emits no closing events when the upstream ends without [DONE] or a finish reason', () => {
    // Matches the Rust: a truncated stream is left truncated rather than dressed up as complete.
    const conv = new AnthropicStreamConverter()
    expect(types(conv.onNetworkChunk(sse(textChunk('partial'))))).not.toContain('message_stop')
    expect(conv.done).toBe(false)
  })

  it('ignores comments, other SSE fields, invalid JSON and chunks without a delta', () => {
    const conv = new AnthropicStreamConverter()
    const noise = ': keep-alive\n\nevent: ping\ndata: not json\n\n' + sse({ id: 'c', choices: [] })
    expect(conv.onNetworkChunk(noise)).toEqual([])
  })

  it('opens a tool_use block per tool call, closing the text block first', () => {
    const conv = new AnthropicStreamConverter()
    const events = conv.onNetworkChunk(
      sse(textChunk('let me check')) +
        sse({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get', arguments: '{"q":1}' } }],
              },
            },
          ],
        }) +
        'data: [DONE]\n\n'
    )
    expect(events.slice(3)).toEqual([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call_a', name: 'get', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ])
  })
})

describe('the end of the upstream body', () => {
  it('closes the message when the final [DONE] arrives without a newline', () => {
    // The buffering that keeps a split line from being lost would otherwise hold this line forever,
    // and the client would wait for a message_stop that never comes.
    const conv = new AnthropicStreamConverter()
    conv.onNetworkChunk(
      'data: {"id":"c","model":"m","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n'
    )
    conv.onNetworkChunk('data: [DONE]')

    const closing = conv.finish().map((e) => (e as { type: string }).type)

    expect(closing).toEqual(['content_block_stop', 'message_delta', 'message_stop'])
    expect(conv.done).toBe(true)
  })

  it('reports nothing for a body that simply stopped, rather than inventing an ending', () => {
    const conv = new AnthropicStreamConverter()
    conv.onNetworkChunk(
      'data: {"id":"c","model":"m","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
    )

    expect(conv.finish()).toEqual([])
    expect(conv.done).toBe(false)
  })
})
