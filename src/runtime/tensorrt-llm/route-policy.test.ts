import { describe, expect, it } from 'vitest'
import { TENSORRT_LLM_ROUTES } from './adapter.js'
import { tensorrtLlmRoutePolicy } from './route-policy.js'

const caps = (tools: boolean) => ({
  tools,
  reasoning: false,
  structured_output: false,
  vision: false,
  embeddings: false,
  responses: false,
})

describe('tensorrtLlmRoutePolicy', () => {
  it('declares exactly the adapter routes and follows the tools capability', () => {
    expect(tensorrtLlmRoutePolicy(caps(true))).toMatchObject({ routes: TENSORRT_LLM_ROUTES, tools: true })
    expect(tensorrtLlmRoutePolicy(caps(false)).tools).toBe(false)
  })

  it('leaves tools to the engine when nothing says what the session can do (an external session)', () => {
    expect(tensorrtLlmRoutePolicy(null).tools).toBe(true)
  })

  it("maps trtllm-serve's context overflow to context_length_exceeded with both numbers, and nothing else", () => {
    const { mapError } = tensorrtLlmRoutePolicy(null)
    const overflow = JSON.stringify({
      object: 'error',
      message: 'The sum of prompt length (9000.0), query length (0) should not exceed max_num_tokens (8192)',
      type: 'BadRequestError',
      param: null,
      code: 400,
    })
    expect(mapError(400, overflow)).toMatchObject({
      error: { code: 'context_length_exceeded', message: expect.stringContaining('8192') },
    })
    expect(JSON.stringify(mapError(400, overflow))).toContain('9000')
    expect(mapError(400, '{"message":"temperature must be positive"}')).toBeNull()
    expect(mapError(500, overflow)).toBeNull()
  })
})
