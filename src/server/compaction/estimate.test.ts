import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MEDIA_PART_TOKENS,
  MESSAGE_TEMPLATE_OVERHEAD_TOKENS,
  TEMPLATE_BOUND_PER_MESSAGE,
  TEMPLATE_BOUND_TOKENS,
  TOOL_TEMPLATE_OVERHEAD_TOKENS,
  answerReserve,
  estimateMessageTokens,
  estimatePromptTokens,
  estimateTextTokens,
  estimateToolsTokens,
  mediaPartCount,
  messageText,
  promptTokenBound,
  requestedOutputTokens,
  textOnlyMessages,
} from './estimate.js'

const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }

describe('estimateTextTokens', () => {
  it.each([
    ['', 0],
    ['hello', 2], // ceil(5 / 3.6)
    ['a b c d e', 7], // words win: ceil(5 × 1.4)
    ['{"k":"vvvvvvvvvvvvvvvvvv"}', 8], // dense JSON: characters win, ceil(26 / 3.6)
    ['   ', 1], // characters only, no words
  ])('%j → %i', (text, expected) => {
    expect(estimateTextTokens(text)).toBe(expected)
  })
})

describe('messageText and media parts', () => {
  it('reads string content, text parts, tool calls and returned reasoning, never media', () => {
    expect(messageText({ role: 'user', content: 'hi' })).toBe('hi')
    expect(
      messageText({
        role: 'user',
        content: [{ type: 'text', text: 'look' }, image, { type: 'input_text', text: 'x' }],
      })
    ).toBe('look\nx')
    expect(
      messageText({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
        reasoning_content: 'because',
      })
    ).toBe('{"name":"f","arguments":"{\\"a\\":1}"}\nbecause')
    expect(
      mediaPartCount({ role: 'user', content: [image, { type: 'input_audio' }, { type: 'text', text: 't' }] })
    ).toBe(2)
    expect(mediaPartCount({ role: 'user', content: 'plain' })).toBe(0)
  })

  it('counts a message with its wrapper and a media part at its fixed price', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'hello' })).toBe(
      2 + MESSAGE_TEMPLATE_OVERHEAD_TOKENS
    )
    expect(estimateMessageTokens({ role: 'user', content: [image] })).toBe(
      MESSAGE_TEMPLATE_OVERHEAD_TOKENS + MEDIA_PART_TOKENS
    )
  })
})

describe('estimateToolsTokens and estimatePromptTokens', () => {
  const tool = { type: 'function', function: { name: 'get', parameters: { type: 'object' } } }
  it('prices each tool schema with its template wrapper, and adds them to the messages', () => {
    const one = estimateTextTokens(JSON.stringify(tool)) + TOOL_TEMPLATE_OVERHEAD_TOKENS
    expect(estimateToolsTokens(undefined)).toBe(0)
    expect(estimateToolsTokens([tool, tool])).toBe(2 * one)
    expect(estimatePromptTokens({ messages: [{ role: 'user', content: 'hello' }], tools: [tool] })).toBe(
      2 + MESSAGE_TEMPLATE_OVERHEAD_TOKENS + one
    )
  })
})

describe('textOnlyMessages', () => {
  it('drops media parts and leaves every other message as it was', () => {
    const plain = { role: 'user', content: 'hi' }
    const out = textOnlyMessages([
      plain,
      { role: 'user', content: [{ type: 'text', text: 'see' }, image], name: 'n' },
      { role: 'user', content: [image] },
    ])
    expect(out[0]).toBe(plain)
    expect(out[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'see' }], name: 'n' })
    expect(out[2]).toEqual({ role: 'user', content: '' })
  })
})

describe('promptTokenBound', () => {
  it('is the JSON byte length plus the template allowance, and unknown with media', () => {
    const messages = [{ role: 'user', content: 'héllo' }]
    const bytes = Buffer.byteLength(JSON.stringify({ messages, tools: [] }))
    expect(promptTokenBound({ messages })).toBe(bytes + TEMPLATE_BOUND_TOKENS + TEMPLATE_BOUND_PER_MESSAGE)
    expect(promptTokenBound({ messages: [{ role: 'user', content: [image] }] })).toBeUndefined()
  })

  it('never undercounts what a word-per-token engine would count', () => {
    const text = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ')
    expect(promptTokenBound({ messages: [{ role: 'user', content: text }] })).toBeGreaterThan(500)
  })
})

describe('requestedOutputTokens and answerReserve', () => {
  it.each([
    [{}, undefined, undefined, DEFAULT_OUTPUT_RESERVE_TOKENS],
    [{ max_tokens: 300 }, 300, undefined, 300],
    [{ max_completion_tokens: 200, max_tokens: 300 }, 200, undefined, 200],
    [{ max_tokens: 0 }, undefined, undefined, DEFAULT_OUTPUT_RESERVE_TOKENS],
    [{ max_tokens: 1.5 }, undefined, undefined, DEFAULT_OUTPUT_RESERVE_TOKENS],
    // An agent's whole output limit against its window: a quarter of the window at most.
    [{ max_tokens: 32000 }, 32000, 32768, 8192],
    [{}, undefined, 2048, 512],
  ] as const)('%j (window %s)', (body, requested, window, reserve) => {
    expect(requestedOutputTokens(body)).toBe(requested)
    expect(answerReserve(body, window)).toBe(reserve)
  })
})
