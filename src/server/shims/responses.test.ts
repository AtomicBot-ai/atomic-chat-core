import { describe, expect, it } from 'vitest'
import type { JsonObject, JsonValue } from './json.js'
import {
  ResponsesStreamConverter,
  chatResponseToResponses,
  flattenContentToText,
  mergeSystemMessages,
  newResponseId,
  responsesRequestToChat,
} from './responses.js'

const obj = (v: JsonValue): JsonObject => v as JsonObject
const messagesOf = (body: JsonValue): JsonValue[] =>
  obj(responsesRequestToChat(body))['messages'] as JsonValue[]

describe('responsesRequestToChat', () => {
  it('folds instructions, developer and late system messages into one leading system message', () => {
    // Strict chat templates (Qwen3 GGUFs) reject a system message anywhere but first, or more than one.
    const messages = messagesOf({
      instructions: 'policy',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
        { type: 'message', role: 'system', content: '' },
        { type: 'message', role: 'assistant', content: 'hello' },
      ],
    })
    expect(messages).toEqual([
      { role: 'system', content: 'policy\n\nrules' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('replays a tool call and its output as an assistant tool_calls message and a tool message', () => {
    const messages = messagesOf({
      input: [
        { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call_1' },
        { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
        { type: 'reasoning', summary: [] },
      ],
    })
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
    ])
  })

  it('falls back to `id` only when `call_id` is absent, not when it is present but null', () => {
    // Mirrors Rust's `get("call_id").or_else(|| get("id"))`: a present null short-circuits the fallback.
    const messages = messagesOf({
      input: [
        { type: 'function_call', id: 'fc_x' },
        { type: 'function_call', id: 'fc_y', call_id: null },
      ],
    })
    const ids = messages.map((m) => ((obj(m)['tool_calls'] as JsonValue[])[0] as JsonObject)['id'])
    expect(ids).toEqual(['fc_x', ''])
  })

  it('serialises a non-string tool output the way serde_json does: sorted keys, Rust float layout', () => {
    // The backend sees this text verbatim, so it has to be byte-identical to what the Rust proxy sent.
    const contents = messagesOf({
      input: [
        { type: 'function_call_output', output: { b: 1, a: [true, null], Z: 'x' } },
        { type: 'function_call_output', output: 1e21 },
        { type: 'function_call_output', output: 1e-7 },
        { type: 'function_call_output', output: 0.001 },
        { type: 'function_call_output', output: -0 },
        { type: 'function_call_output', output: null },
      ],
    }).map((m) => obj(m)['content'])
    expect(contents).toEqual(['{"Z":"x","a":[true,null],"b":1}', '1e21', '1e-7', '0.001', '-0.0', 'null'])
  })

  it('flattens function tools, drops built-in and nameless ones, and omits `tools` when none survive', () => {
    const chat = obj(
      responsesRequestToChat({
        input: 'x',
        tools: [
          { type: 'function', name: 'shell', parameters: { type: 'object' }, strict: true },
          { type: 'web_search' },
          { type: 'function', description: 'no name' },
        ],
      })
    )
    expect(chat['tools']).toEqual([
      { type: 'function', function: { name: 'shell', parameters: { type: 'object' } } },
    ])
    expect('tools' in obj(responsesRequestToChat({ input: 'x', tools: [{ type: 'web_search' }] }))).toBe(
      false
    )
  })

  it('wraps a named tool_choice, passes strings and nameless objects through, and turns null into "auto"', () => {
    const choice = (tc: JsonValue) =>
      obj(responsesRequestToChat({ input: 'x', tool_choice: tc }))['tool_choice']
    expect(choice({ type: 'function', name: 'shell' })).toEqual({
      type: 'function',
      function: { name: 'shell' },
    })
    expect(choice('none')).toBe('none')
    expect(choice({ type: 'allowed_tools' })).toEqual({ type: 'allowed_tools' })
    expect(choice(null)).toBe('auto')
  })

  it('renames the knobs, requests streamed usage only for stream: true, and maps text.format', () => {
    const chat = obj(
      responsesRequestToChat({
        model: 'm',
        input: 'x',
        stream: true,
        max_output_tokens: 10,
        store: false,
        text: { format: { type: 'json_schema', name: 'answer' } },
      })
    )
    expect(chat).toEqual({
      messages: [{ role: 'user', content: 'x' }],
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 10,
      response_format: { type: 'json_schema', json_schema: { name: 'answer' } },
    })
    expect('stream_options' in obj(responsesRequestToChat({ input: 'x', stream: false }))).toBe(false)
  })

  it('does not share nested objects with the request it was built from', () => {
    const body = { input: 'x', tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }] }
    const chat = obj(responsesRequestToChat(body))
    const fn = obj(obj((chat['tools'] as JsonValue[])[0] as JsonValue)['function'] as JsonValue)
    obj(fn['parameters'] as JsonValue)['type'] = 'mutated'
    expect(body.tools[0]?.parameters.type).toBe('object')
  })
})

describe('mergeSystemMessages / flattenContentToText', () => {
  it('returns the messages untouched when there is no system text to merge', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'system', content: [] },
    ]
    expect(mergeSystemMessages(msgs)).toEqual([{ role: 'user', content: 'a' }])
  })

  it('concatenates the string text of every part regardless of part type', () => {
    expect(
      flattenContentToText([{ type: 'input_text', text: 'a' }, { type: 'input_image' }, { text: 'b' }, 'c'])
    ).toBe('ab')
    expect(flattenContentToText(undefined)).toBe('')
    expect(flattenContentToText(42)).toBe('')
  })
})

describe('chatResponseToResponses', () => {
  it('puts the text message before function calls and mints msg_/fc_ ids of 32 hex digits', () => {
    const res = obj(
      chatResponseToResponses(
        {
          choices: [
            {
              message: {
                content: 'calling',
                tool_calls: [{ id: 'call_a', function: { name: 'a', arguments: '{}' } }],
              },
            },
          ],
        },
        'resp_1',
        'fallback'
      )
    )
    const output = res['output'] as JsonObject[]
    expect(output.map((o) => o['type'])).toEqual(['message', 'function_call'])
    expect(output[0]?.['id']).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(output[1]?.['id']).toMatch(/^fc_[0-9a-f]{32}$/)
    expect(res['model']).toBe('fallback')
    expect(res['created_at']).toBe(0)
  })

  it('leaves usage null only when absent; a present null usage becomes an all-zero block', () => {
    // Rust maps `Some(Value::Null)` through map_usage, which reads every counter as 0.
    expect(obj(chatResponseToResponses({}, 'r', 'm'))['usage']).toBeNull()
    expect(obj(chatResponseToResponses({ usage: null }, 'r', 'm'))['usage']).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    })
  })

  it('reads only non-negative integer counters and derives total_tokens when it is missing', () => {
    const usage = obj(
      chatResponseToResponses({ usage: { prompt_tokens: 3, completion_tokens: 2.5 } }, 'r', 'm')
    )['usage']
    expect(usage).toMatchObject({ input_tokens: 3, output_tokens: 0, total_tokens: 3 })
  })
})

describe('ResponsesStreamConverter', () => {
  const run = (chunks: JsonValue[], usage?: JsonValue) => {
    const conv = new ResponsesStreamConverter('resp_1', 'model')
    const events = [conv.createdEvent(), ...chunks.flatMap((c) => conv.onChunk(c))]
    events.push(...(usage === undefined ? conv.finish() : conv.finish(usage)))
    return events.map(obj)
  }

  it('emits the text lifecycle in order with sequence numbers contiguous from 0', () => {
    const events = run([
      { choices: [{ delta: { content: 'He' } }] },
      { choices: [{ delta: { content: 'llo' } }] },
    ])
    expect(events.map((e) => e['type'])).toEqual([
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    expect(events.map((e) => e['sequence_number'])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(events[5]?.['text']).toBe('Hello')
  })

  it('announces a tool call on its first delta, before its name or id may be known', () => {
    // Codex keys items by the added event, so it is sent immediately; the final call_id and name
    // arrive in output_item.done.
    const events = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: ':1}' } }] } },
        ],
      },
    ])
    const added = obj(events[1]?.['item'] as JsonValue)
    expect(added).toMatchObject({ call_id: '', name: '', arguments: '' })
    const done = events.find((e) => e['type'] === 'response.output_item.done')
    expect(done?.['item']).toMatchObject({ call_id: 'call_1', name: 'f', arguments: '{"a":1}' })
  })

  it('closes the message before tools, but orders the completed output by first appearance', () => {
    const events = run([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f' } }] } }] },
      { choices: [{ delta: { content: 'after' } }] },
    ])
    const doneTypes = events
      .filter((e) => e['type'] === 'response.output_item.done')
      .map((e) => obj(e['item'] as JsonValue)['type'])
    expect(doneTypes).toEqual(['message', 'function_call'])
    const completed = obj(events.at(-1)?.['response'] as JsonValue)
    expect((completed['output'] as JsonObject[]).map((o) => o['type'])).toEqual(['function_call', 'message'])
  })

  it('ignores chunks it cannot use and passes usage through only via finish', () => {
    const events = run(
      [{ choices: [] }, { choices: [{ finish_reason: 'stop' }] }, { error: { message: 'boom' } }],
      { prompt_tokens: 1, completion_tokens: 2 }
    )
    expect(events.map((e) => e['type'])).toEqual(['response.created', 'response.completed'])
    expect(obj(events[1]?.['response'] as JsonValue)['usage']).toMatchObject({ total_tokens: 3 })
  })

  it('forgets tool calls after finish, so a second finish re-closes only the message', () => {
    const conv = new ResponsesStreamConverter('r', 'm')
    conv.onChunk({
      choices: [{ delta: { content: 'x', tool_calls: [{ index: 0, function: { name: 'f' } }] } }],
    })
    conv.finish()
    const again = conv.finish().map((e) => obj(e)['type'])
    expect(again).toEqual([
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
  })
})

describe('newResponseId', () => {
  it('is resp_ followed by 32 hex digits and unique per call', () => {
    const a = newResponseId()
    expect(a).toMatch(/^resp_[0-9a-f]{32}$/)
    expect(newResponseId()).not.toBe(a)
  })
})
