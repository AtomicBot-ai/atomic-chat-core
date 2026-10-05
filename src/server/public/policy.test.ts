import { describe, expect, it } from 'vitest'
import type { JsonValue } from '../shims/index.js'
import { policyRefusal } from './policy.js'
import type { LocalTargetPolicy } from './types.js'

const policy = (tools: boolean): LocalTargetPolicy => ({
  routes: [
    { method: 'POST', path: '/v1/chat/completions' },
    { method: 'POST', path: '/v1/completions' },
    { method: 'GET', path: '/v1/models' },
  ],
  tools,
  structuredOutput: false,
  mapError: () => null,
})

const errorOf = (refusal: ReturnType<typeof policyRefusal>) =>
  (JSON.parse(refusal?.body ?? '{}') as { error: { message: string; code: string; type: string } }).error

describe('policyRefusal', () => {
  it.each([
    ['/embeddings', 'embeddings'],
    ['/responses', 'the Responses API'],
    ['/messages/count_tokens', 'token counting'],
  ])('refuses %s, which the session does not declare, naming what is missing', (path, what) => {
    const refusal = policyRefusal(policy(true), path, 'trt', { model: 'trt' })
    expect(refusal?.status).toBe(400)
    expect(errorOf(refusal)).toEqual({
      message: `The model 'trt' does not support ${what}.`,
      type: 'invalid_request_error',
      code: 'unsupported_endpoint',
    })
  })

  it.each(['/chat/completions', '/completions', '/messages'])(
    'lets %s through (messages go out as chat)',
    (path) => {
      expect(policyRefusal(policy(false), path, 'trt', { model: 'trt' })).toBeUndefined()
    }
  )

  it('refuses tools to a session with no tool parser, and allows an empty tools list', () => {
    const refusal = policyRefusal(policy(false), '/chat/completions', 'trt', {
      model: 'trt',
      tools: [{ type: 'function', function: { name: 'f' } }],
    })
    expect(refusal?.status).toBe(400)
    expect(errorOf(refusal)).toMatchObject({
      message: "The model 'trt' does not support tool calling.",
      code: 'unsupported_capability',
    })
    expect(
      policyRefusal(policy(false), '/chat/completions', 'trt', { model: 'trt', tools: [] })
    ).toBeUndefined()
    expect(
      policyRefusal(policy(true), '/chat/completions', 'trt', { model: 'trt', tools: [{ type: 'function' }] })
    ).toBeUndefined()
  })

  it('refuses a path it has no mapping for by its own name, and never reads tools from a non-object body', () => {
    expect(errorOf(policyRefusal(policy(false), '/audio/speech', 'trt', {})).message).toBe(
      "The model 'trt' does not support /audio/speech."
    )
    expect(policyRefusal(policy(false), '/chat/completions', 'trt', [{ tools: [1] }])).toBeUndefined()
  })

  it('refuses a tool_choice and a JSON response_format too, worded like the session port', () => {
    expect(
      errorOf(policyRefusal(policy(false), '/chat/completions', 'trt', { tool_choice: 'auto' }))
    ).toMatchObject({
      message: "The model 'trt' does not support tool calling.",
    })
    expect(
      errorOf(
        policyRefusal(policy(true), '/chat/completions', 'trt', { response_format: { type: 'json_schema' } })
      )
    ).toEqual({
      message: "The model 'trt' does not support structured output.",
      type: 'invalid_request_error',
      code: 'unsupported_capability',
    })
    expect(
      policyRefusal(policy(false), '/chat/completions', 'trt', {
        tool_choice: 'none',
        response_format: { type: 'text' },
      })
    ).toBeUndefined()
  })

  it.each<[string, { [key: string]: JsonValue }]>([
    ['json_object', { type: 'json_object' }],
    ['json (TensorRT-LLM)', { type: 'json', schema: {} }],
    ['regex', { type: 'regex', regex: '[a-z]+' }],
    ['ebnf', { type: 'ebnf', ebnf: 'root ::= "a"' }],
    ['structural_tag', { type: 'structural_tag', structures: [] }],
    ['a type this core does not know', { type: 'grammar' }],
    ['a format with no type', {}],
  ])(
    'refuses response_format %s to a family without structured output (final review I-2)',
    (_label, format) => {
      const refusal = policyRefusal(policy(true), '/chat/completions', 'trt', { response_format: format })
      expect(errorOf(refusal)).toMatchObject({ code: 'unsupported_capability' })
      expect(
        policyRefusal({ ...policy(true), structuredOutput: true }, '/chat/completions', 'trt', {
          response_format: format,
        })
      ).toBeUndefined()
    }
  )

  it('refuses tools on the Anthropic route too', () => {
    expect(
      policyRefusal(policy(false), '/messages', 'trt', { model: 'trt', tools: [{ name: 'get_weather' }] })
        ?.status
    ).toBe(400)
  })
})
