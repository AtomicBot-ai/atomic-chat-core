import { describe, expect, it } from 'vitest'
import { embeddingInputRefusal, messageRolesRefusal, responsesRolesRefusal } from './validate.js'

const parsed = (body: string | undefined) => (body === undefined ? undefined : JSON.parse(body))

describe('messageRolesRefusal', () => {
  it.each([
    [[{ role: 'system', content: 's' }]],
    [[{ role: 'developer', content: 'd' }]],
    [[{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]],
    [[{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' }] }]],
    [[{ role: 'tool', tool_call_id: 'c1', content: '42' }]],
  ])('passes the OpenAI roles the app and agents send: %j', (messages) => {
    expect(messageRolesRefusal({ model: 'm', messages })).toBeUndefined()
  })

  it('leaves a body without a messages array to the engine', () => {
    expect(messageRolesRefusal({ model: 'm' })).toBeUndefined()
    expect(messageRolesRefusal({ model: 'm', messages: 'hi' })).toBeUndefined()
    expect(messageRolesRefusal({ model: 'm', messages: [] })).toBeUndefined()
    expect(messageRolesRefusal([])).toBeUndefined()
  })

  it.each([
    [
      [{ role: 'not-a-real-role', content: 'Reply exactly VALIDATION_TEST.' }],
      'messages[0].role',
      'invalid_value',
      "Invalid value for 'messages[0].role': 'not-a-real-role'. Supported values are: 'system', 'developer', 'user', 'assistant' and 'tool'.",
    ],
    [
      [
        { role: 'user', content: 'hi' },
        { role: 'function', name: 'f', content: 'legacy' },
      ],
      'messages[1].role',
      'invalid_value',
      expect.stringContaining("'function'"),
    ],
    [
      [{ role: 'User', content: 'hi' }],
      'messages[0].role',
      'invalid_value',
      expect.stringContaining("'User'"),
    ],
    [[{ role: 7, content: 'hi' }], 'messages[0].role', 'invalid_value', expect.stringContaining(': 7.')],
    [
      [{ role: null, content: 'hi' }],
      'messages[0].role',
      'invalid_value',
      expect.stringContaining(': null.'),
    ],
    [
      [{ content: 'hi' }],
      'messages[0].role',
      'missing_required_parameter',
      "Missing required parameter: 'messages[0].role'.",
    ],
    [
      [{ role: 'user', content: 'hi' }, 'hi'],
      'messages[1]',
      'invalid_type',
      "Invalid type for 'messages[1]': expected an object, but got a string instead.",
    ],
  ])('refuses %j at %s', (messages, param, code, message) => {
    expect(parsed(messageRolesRefusal({ model: 'm', messages }))).toEqual({
      error: { message, type: 'invalid_request_error', param, code },
    })
  })
})

describe('responsesRolesRefusal', () => {
  it('passes the Responses roles, typed items, and the input forms without roles', () => {
    expect(responsesRolesRefusal({ model: 'm', input: 'hi' })).toBeUndefined()
    expect(responsesRolesRefusal({ model: 'm' })).toBeUndefined()
    expect(
      responsesRolesRefusal({
        model: 'm',
        input: [
          { role: 'developer', content: 'd' },
          { type: 'message', role: 'system', content: 's' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] },
          { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: '42' },
          { type: 'reasoning', summary: [] },
          // No role: the translation's `user`, as before.
          { content: 'hi' },
        ],
      })
    ).toBeUndefined()
  })

  it.each([
    [[{ role: 'not-a-real-role', content: 'x' }], 'input[0].role', "'not-a-real-role'"],
    [
      [
        { role: 'user', content: 'x' },
        { type: 'message', role: 'tool', content: 'x' },
      ],
      'input[1].role',
      "'tool'",
    ],
    [[{ type: 'message', role: 3, content: 'x' }], 'input[0].role', ': 3.'],
  ])('refuses %j at %s', (input, param, says) => {
    expect(parsed(responsesRolesRefusal({ model: 'm', input }))).toEqual({
      error: {
        message: expect.stringContaining(says),
        type: 'invalid_request_error',
        param,
        code: 'invalid_value',
      },
    })
    expect(responsesRolesRefusal({ model: 'm', input })).toContain(
      "Supported values are: 'user', 'assistant', 'system' and 'developer'."
    )
  })
})

describe('embeddingInputRefusal', () => {
  it.each([
    ['a string', 'hello'],
    ['an array of strings', ['alpha', 'omega']],
    ['an array of token ids', [101, 7, 0]],
    ['an array of token id arrays', [[101, 7], [0], [5, 6, 7]]],
    ['an input item', { content: [{ type: 'text', text: 'shoes' }] }],
    ['input items beside strings', ['caption', { content: [] }, { prompt_string: 'x', multimodal_data: [] }]],
    // Emptiness is the engine's to judge, as it always was.
    ['an empty string', ''],
    ['an empty array', []],
    ['an empty token array', [[]]],
  ])('passes %s', (_name, input) => {
    expect(embeddingInputRefusal({ model: 'm', input })).toBeUndefined()
  })

  it('leaves a body without an input to the route', () => {
    expect(embeddingInputRefusal({ model: 'm' })).toBeUndefined()
    expect(embeddingInputRefusal('x')).toBeUndefined()
  })

  it.each([
    [['test', 7], 'invalid_type', 'input[1] is a number, but input[0] is a string.'],
    [['alpha', 7, 'omega'], 'invalid_type', 'input[1] is a number, but input[0] is a string.'],
    [[7, 'alpha'], 'invalid_type', 'input[1] is a string, but input[0] is a number.'],
    [['alpha', [1, 2]], 'invalid_type', 'input[1] is an array, but input[0] is a string.'],
    [[[1, 2], 3], 'invalid_type', 'input[1] is a number, but input[0] is an array.'],
    [[{ content: [] }, 7], 'invalid_type', 'input[1] is a number, but input[0] is an object.'],
    [['alpha', null], 'invalid_type', 'input[1] is null, but input[0] is a string.'],
    [[true, false], 'invalid_type', 'input[0] is a boolean.'],
    [[null], 'invalid_type', 'input[0] is null.'],
    [[1, 2.5], 'invalid_value', 'input[1] is 2.5, not a token id (a non-negative integer).'],
    [[-1], 'invalid_value', 'input[0] is -1, not a token id (a non-negative integer).'],
    [
      [
        [1, 2],
        [3, 'x'],
      ],
      'invalid_type',
      'input[1][1] is a string, not a token id.',
    ],
    [[[1, [2]]], 'invalid_type', 'input[0][1] is an array, not a token id.'],
    [[[0.5]], 'invalid_value', 'input[0][0] is 0.5, not a token id (a non-negative integer).'],
    [7, 'invalid_type', "Invalid type for 'input': expected a string or an array, but got a number instead."],
    [
      true,
      'invalid_type',
      "Invalid type for 'input': expected a string or an array, but got a boolean instead.",
    ],
    [null, 'invalid_type', "Invalid type for 'input': expected a string or an array, but got null instead."],
  ])('refuses %j (%s)', (input, code, says) => {
    expect(parsed(embeddingInputRefusal({ model: 'm', input }))).toEqual({
      error: { message: expect.stringContaining(says), type: 'invalid_request_error', param: 'input', code },
    })
  })

  it('says which forms the field takes when the elements are mixed', () => {
    expect(parsed(embeddingInputRefusal({ model: 'm', input: ['alpha', 7, 'omega'] }))).toEqual({
      error: {
        message:
          "Invalid 'input': input[1] is a number, but input[0] is a string. Send a string, an array of strings, an array of token ids (integers) or an array of token id arrays, without mixing them.",
        type: 'invalid_request_error',
        param: 'input',
        code: 'invalid_type',
      },
    })
  })
})
