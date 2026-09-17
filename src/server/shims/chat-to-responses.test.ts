import { describe, expect, it } from 'vitest'
import {
  COMPATIBILITY_INSTRUCTIONS,
  ChatChunkStreamConverter,
  chatMessageToResponsesItems,
  chatRequestToResponses,
  chatResponseFormatToText,
  chatToolChoiceToResponses,
  chatToolToResponses,
  mapUsageReverse,
  newChatCompletionId,
  normalizeFunctionSchema,
  responsesCallId,
} from './chat-to-responses.js'
import type { JsonObject, JsonValue } from './json.js'

const obj = (v: JsonValue): JsonObject => v as JsonObject

function feed(
  events: JsonValue[],
  model = 'requested',
  created = 1
): { conv: ChatChunkStreamConverter; chunks: JsonObject[] } {
  const conv = new ChatChunkStreamConverter(model, created)
  const chunks: JsonObject[] = []
  for (const event of events) chunks.push(...conv.onEvent(event).map(obj))
  return { conv, chunks }
}

const deltaOf = (chunk: JsonObject) => obj((chunk['choices'] as JsonObject[])[0]!['delta'] as JsonValue)
const finishOf = (chunk: JsonObject) => (chunk['choices'] as JsonObject[])[0]!['finish_reason']

describe('chatRequestToResponses', () => {
  it('hoists system and developer turns into instructions, after the compatibility preamble', () => {
    const out = obj(
      chatRequestToResponses(
        {
          model: 'gpt',
          messages: [
            { role: 'system', content: 'be terse' },
            { role: 'user', content: 'hi' },
            {
              role: 'developer',
              content: [
                { type: 'text', text: 'and ' },
                { type: 'text', text: 'precise' },
              ],
            },
            { role: 'system', content: '' },
          ],
        },
        'key'
      )
    )
    expect(out['instructions']).toBe(`${COMPATIBILITY_INSTRUCTIONS}\n\nbe terse\n\nand precise`)
    // Only the user turn is left in `input`; the hoisted turns do not appear twice.
    expect(out['input']).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })

  it('forces streaming on and storage off whatever the client asked, and drops knobs the endpoint rejects', () => {
    // The subscription endpoint only streams; a `stream: false` client is served by aggregating.
    const out = obj(
      chatRequestToResponses(
        { messages: [], stream: false, store: true, max_tokens: 10, temperature: 0.2, top_p: 0.5 },
        'session-1'
      )
    )
    expect(out['stream']).toBe(true)
    expect(out['store']).toBe(false)
    expect(out['prompt_cache_key']).toBe('session-1')
    for (const dropped of ['max_tokens', 'max_output_tokens', 'temperature', 'top_p'])
      expect(out).not.toHaveProperty(dropped)
    expect(out).not.toHaveProperty('model')
    expect(out['tool_choice']).toBe('auto')
  })

  it('forwards reasoning effort with an automatic summary, and only a non-empty string', () => {
    expect(obj(chatRequestToResponses({ reasoning_effort: 'high' }, 'k'))['reasoning']).toEqual({
      effort: 'high',
      summary: 'auto',
    })
    expect(obj(chatRequestToResponses({ reasoning_effort: '' }, 'k'))).not.toHaveProperty('reasoning')
    expect(obj(chatRequestToResponses({ reasoning_effort: 3 }, 'k'))).not.toHaveProperty('reasoning')
  })

  it('omits `tools` when every tool is a built-in the endpoint has no function shape for', () => {
    expect(obj(chatRequestToResponses({ tools: [{ type: 'web_search' }] }, 'k'))).not.toHaveProperty('tools')
  })
})

describe('chatMessageToResponsesItems', () => {
  it('numbers replayed assistant messages only when a message item is actually emitted', () => {
    const index = { value: 0 }
    const toolOnly = chatMessageToResponsesItems(
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{}' } }],
      },
      index
    )
    expect(toolOnly).toEqual([{ type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' }])
    expect(index.value).toBe(0)

    const both = chatMessageToResponsesItems({ role: 'assistant', content: 'done', tool_calls: [] }, index)
    expect(both).toEqual([
      {
        type: 'message',
        id: 'msg_atomic_0',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
        status: 'completed',
      },
    ])
    expect(index.value).toBe(1)
  })

  it('skips nameless tool calls and mints a call id when the client sent none', () => {
    const items = chatMessageToResponsesItems(
      { role: 'assistant', tool_calls: [{ function: { arguments: '{}' } }, { function: { name: 'g' } }] },
      { value: 0 }
    )
    expect(items).toHaveLength(1)
    expect(obj(items[0]!)['call_id']).toMatch(/^call_[0-9a-f]{32}$/)
    expect(obj(items[0]!)['arguments']).toBe('{}')
  })

  it('sends a non-string tool result as serde_json would print it: compact, keys sorted', () => {
    const [item] = chatMessageToResponsesItems(
      { role: 'tool', tool_call_id: 'call_9', content: { z: 1, a: [true, null] } },
      { value: 0 }
    )
    expect(item).toEqual({
      type: 'function_call_output',
      call_id: 'call_9',
      output: '{"a":[true,null],"z":1}',
    })
    // An explicit null is still "a value" to Rust and serialises; only a missing key is empty.
    expect(
      obj(chatMessageToResponsesItems({ role: 'tool', content: null }, { value: 0 })[0]!)['output']
    ).toBe('null')
    expect(obj(chatMessageToResponsesItems({ role: 'tool' }, { value: 0 })[0]!)).toMatchObject({
      call_id: '',
      output: '',
    })
  })

  it('moves a nested image url onto an input_image part and drops empty text', () => {
    const [item] = chatMessageToResponsesItems(
      {
        content: [
          { type: 'text', text: '' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        ],
      },
      { value: 0 }
    )
    expect(item).toEqual({
      role: 'user',
      content: [{ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AA' }],
    })
  })
})

describe('responsesCallId', () => {
  it('keeps an id of up to 64 bytes and truncates a longer one to exactly 64 with a digest tail', () => {
    expect(responsesCallId('x'.repeat(64))).toBe('x'.repeat(64))
    const a = responsesCallId(`call_${'a'.repeat(80)}`)
    const b = responsesCallId(`call_${'a'.repeat(79)}b`)
    expect(a).toHaveLength(64)
    expect(a.startsWith(`call_${'a'.repeat(26)}_`)).toBe(true)
    // Same 31-byte prefix, different tails: the digest is what keeps the two calls apart.
    expect(a).not.toBe(b)
    expect(responsesCallId(`call_${'a'.repeat(80)}`)).toBe(a)
  })

  it('counts UTF-8 bytes and never cuts through a character', () => {
    // 33 two-byte characters are 66 bytes and byte 31 is the middle of one. Rust panics here and the
    // request fails; the port backs the cut off to the character before, so the id stays valid
    // UTF-8, stays under the cap and stays distinct through its digest.
    const id = responsesCallId('é'.repeat(33))
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64)
    expect(id.startsWith(`${'é'.repeat(15)}_`)).toBe(true)
    expect(id).not.toBe(responsesCallId(`${'é'.repeat(32)}e`))
    // A cut that already lands on a boundary is unchanged: exactly 64 bytes, as Rust produces.
    expect(new TextEncoder().encode(responsesCallId(`${'a'.repeat(31)}${'é'.repeat(17)}`)).length).toBe(64)
  })
})

describe('tool definitions', () => {
  it('flattens a chat function tool and drops built-ins and tools without a name key', () => {
    expect(
      chatToolToResponses({ type: 'function', function: { name: 'search', description: 'd', strict: true } })
    ).toEqual({
      type: 'function',
      name: 'search',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      strict: true,
    })
    expect(chatToolToResponses({ type: 'web_search' })).toBeUndefined()
    expect(chatToolToResponses({ type: 'function', function: {} })).toBeUndefined()
  })

  it('gives every nested object schema a `properties` map, since the endpoint rejects one without', () => {
    expect(
      normalizeFunctionSchema({
        type: 'object',
        properties: { inner: { type: ['object', 'null'] }, flag: true },
        items: 'left alone',
        anyOf: [{ type: 'object' }, 7],
      })
    ).toEqual({
      type: 'object',
      properties: {
        inner: { type: ['object', 'null'], properties: {} },
        flag: { type: 'object', properties: {} },
      },
      items: 'left alone',
      anyOf: [
        { type: 'object', properties: {} },
        { type: 'object', properties: {} },
      ],
    })
  })

  it('flattens a named tool_choice and defaults anything unusable to auto', () => {
    expect(chatToolChoiceToResponses('none')).toBe('none')
    expect(chatToolChoiceToResponses({ type: 'function', function: { name: 's' } })).toEqual({
      type: 'function',
      name: 's',
    })
    expect(chatToolChoiceToResponses({ type: 'function' })).toEqual({ type: 'function' })
    expect(chatToolChoiceToResponses(null)).toBe('auto')
  })

  it('maps json_schema and json_object response formats and ignores the rest', () => {
    expect(
      chatResponseFormatToText({
        type: 'json_schema',
        json_schema: { name: 'n', schema: {}, description: 'x' },
      })
    ).toEqual({ type: 'json_schema', name: 'n', schema: {} })
    expect(chatResponseFormatToText({ type: 'json_schema' })).toBeUndefined()
    expect(chatResponseFormatToText({ type: 'json_object' })).toEqual({ type: 'json_object' })
    expect(chatResponseFormatToText({ type: 'text' })).toBeUndefined()
  })
})

describe('mapUsageReverse', () => {
  it('renames the counts, derives a missing total, and zeroes anything that is not a non-negative integer', () => {
    expect(mapUsageReverse({ input_tokens: 3, output_tokens: 2 })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    })
    expect(mapUsageReverse({ input_tokens: -1, output_tokens: '2', total_tokens: 1.5 })).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    })
  })
})

describe('ChatChunkStreamConverter', () => {
  it('mints a chatcmpl id shared by every chunk and sends the assistant role only once', () => {
    const { chunks } = feed([
      { type: 'response.output_text.delta', delta: 'a' },
      { type: 'response.reasoning_text.delta', delta: 'b' },
    ])
    expect(newChatCompletionId()).toMatch(/^chatcmpl-[0-9a-f]{32}$/)
    expect(chunks[0]!['id']).toMatch(/^chatcmpl-[0-9a-f]{32}$/)
    expect(chunks[1]!['id']).toBe(chunks[0]!['id'])
    expect(deltaOf(chunks[0]!)).toEqual({ role: 'assistant', content: 'a' })
    expect(deltaOf(chunks[1]!)).toEqual({ reasoning_content: 'b' })
  })

  it('prefers the model the upstream says it served', () => {
    const { chunks } = feed([
      { type: 'response.created', response: { model: 'served' } },
      { type: 'response.output_text.delta', delta: 'x' },
    ])
    expect(chunks[0]!['model']).toBe('served')
  })

  it('keys tool-call chunks by call position, not by the Responses item id', () => {
    const { chunks, conv } = feed([
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'a' },
      },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'b' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":1}' },
      // No item_id: falls back to the newest call.
      { type: 'response.function_call_arguments.delta', delta: '{}' },
      // A whole-call `done` for an item already streamed must not announce it again.
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', name: 'a', arguments: '{"q":1}' },
      },
      { type: 'response.completed', response: {} },
    ])
    expect(chunks).toHaveLength(5)
    expect(deltaOf(chunks[2]!)['tool_calls']).toEqual([{ index: 0, function: { arguments: '{"q":1}' } }])
    expect(deltaOf(chunks[3]!)['tool_calls']).toEqual([{ index: 1, function: { arguments: '{}' } }])
    expect(finishOf(chunks[4]!)).toBe('tool_calls')
    expect(conv.error()).toBeNull()
  })

  it('uses the item id as call id only when `call_id` is absent, not when it is null', () => {
    const { chunks } = feed([
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_a', name: 'a' } },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_b', call_id: null, name: 'b' },
      },
    ])
    const idOf = (c: JsonObject) => obj((deltaOf(c)['tool_calls'] as JsonValue[])[0]!)['id']
    expect(idOf(chunks[0]!)).toBe('fc_a')
    expect(idOf(chunks[1]!)).toMatch(/^call_[0-9a-f]{32}$/)
  })

  it('reports a capped reply as `length`, not `stop`, and attaches usage to the final chunk', () => {
    const { chunks } = feed([
      { type: 'response.output_text.delta', delta: 'half' },
      {
        type: 'response.incomplete',
        response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      },
    ])
    expect(finishOf(chunks[1]!)).toBe('length')
    expect(chunks[1]!['usage']).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
    expect(chunks[0]).not.toHaveProperty('usage')
  })

  it('records an upstream failure, ends with `stop`, and ignores everything after a terminal event', () => {
    const { chunks, conv } = feed([
      { type: 'response.failed', response: { error: { message: 'usage limit reached' } } },
      { type: 'response.output_text.delta', delta: 'late' },
    ])
    expect(chunks.map(finishOf)).toEqual(['stop'])
    expect(conv.error()).toBe('usage limit reached')
    expect(conv.finish()).toEqual([])
  })

  it('falls back to a generic failure message when the upstream gives none', () => {
    const { conv } = feed([{ type: 'error', error: { code: 'x' } }])
    expect(conv.error()).toBe('the ChatGPT backend reported a failure')
  })

  it('closes a dropped stream with one finish chunk from finish()', () => {
    const { conv } = feed([{ type: 'response.output_text.delta', delta: 'partial' }])
    const closing = conv.finish().map(obj)
    expect(closing.map(finishOf)).toEqual(['stop'])
    expect(conv.finish()).toEqual([])
  })

  it('aggregates text, reasoning and tool calls into one chat.completion for a non-streaming client', () => {
    const { conv } = feed(
      [
        { type: 'response.reasoning_summary_text.delta', delta: 'why' },
        { type: 'response.output_text.delta', delta: 'the ' },
        { type: 'response.output_text.delta', delta: 'answer' },
        {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 's' },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{}' },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } },
      ],
      'm',
      42
    )
    const completion = obj(conv.intoChatCompletion())
    expect(completion).toMatchObject({ object: 'chat.completion', created: 42, model: 'm' })
    expect(completion['choices']).toEqual([
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'the answer',
          reasoning_content: 'why',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 's', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ])
    expect(completion['usage']).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
  })

  it('aggregates an empty reply as null content with no usage key', () => {
    const completion = obj(new ChatChunkStreamConverter('m', 0).intoChatCompletion())
    expect(completion['choices']).toEqual([
      { index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' },
    ])
    expect(completion).not.toHaveProperty('usage')
  })
})
