import { describe, expect, it } from 'vitest'
import {
  asksForStructuredOutput,
  asksForTools,
  reasoningIntoContent,
  thinkingRequested,
} from './request-rules.js'

describe('the shared request rules (change add-vllm-runtime)', () => {
  it('asks for tools with a non-empty list or a tool_choice other than none', () => {
    expect(asksForTools({ tools: [{}] })).toBe(true)
    expect(asksForTools({ tool_choice: 'auto' })).toBe(true)
    expect(asksForTools({ tools: [], tool_choice: 'none' })).toBe(false)
    expect(asksForTools({ tool_choice: null })).toBe(false)
  })

  it('asks for structured output with any response_format but text', () => {
    expect(asksForStructuredOutput({ response_format: { type: 'json_schema' } })).toBe(true)
    expect(asksForStructuredOutput({ response_format: { type: 'text' } })).toBe(false)
    expect(asksForStructuredOutput({ response_format: [] })).toBe(false)
    expect(asksForStructuredOutput({})).toBe(false)
  })

  it('reads thinking from chat_template_kwargs or the top level, only when true', () => {
    expect(thinkingRequested({ chat_template_kwargs: { enable_thinking: true } })).toBe(true)
    expect(thinkingRequested({ enable_thinking: true })).toBe(true)
    expect(thinkingRequested({ chat_template_kwargs: { enable_thinking: false } })).toBe(false)
    expect(thinkingRequested(null)).toBe(false)
  })

  it('moves either reasoning spelling into content, in messages and stream deltas', () => {
    expect(
      reasoningIntoContent({
        choices: [
          { message: { content: 'a', reasoning_content: 'b' } },
          { delta: { reasoning: 'c' } },
          null,
          { delta: null },
        ],
      })
    ).toEqual({
      choices: [
        { message: { content: 'ab', reasoning_content: null } },
        { delta: { content: 'c', reasoning: null } },
        null,
        { delta: null },
      ],
    })
    expect(reasoningIntoContent({ object: 'x' })).toEqual({ object: 'x' })
  })
})
