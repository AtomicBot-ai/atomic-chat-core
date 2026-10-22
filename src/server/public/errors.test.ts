import { describe, expect, it } from 'vitest'
import {
  bodyIndicatesOom,
  computeErrorEnvelope,
  emptyMessagesRefusal,
  isComputeBackendError,
  isContextLimitError,
  isContextOverflowFinishLength,
  modelNotFoundJson,
  selectedProviderUnavailableJson,
  structureBackendErrorBody,
} from './errors.js'

describe('modelNotFoundJson', () => {
  it("is OpenAI's model_not_found envelope that keeps the proxy's wording as the message", () => {
    expect(JSON.parse(modelNotFoundJson('ghost'))).toEqual({
      error: {
        message: "No running session found for model 'ghost'",
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    })
  })
})

describe('selectedProviderUnavailableJson', () => {
  it('names the model and the selected provider in a server_error envelope', () => {
    const body = JSON.parse(selectedProviderUnavailableJson('qwen', 'llamacpp-upstream')) as {
      error: Record<string, string>
    }
    expect(body.error).toMatchObject({
      type: 'server_error',
      code: 'selected_provider_unavailable',
      param: 'model',
    })
    expect(body.error['message']).toMatch(/^No running session found for model 'qwen' in any local engine\./)
    expect(body.error['message']).toContain('served by llamacpp-upstream')
  })
})

describe('emptyMessagesRefusal', () => {
  it('refuses an empty messages array and nothing else', () => {
    expect(JSON.parse(emptyMessagesRefusal({ model: 'm', messages: [] }) ?? 'null')).toMatchObject({
      error: { type: 'invalid_request_error', param: 'messages', code: 'empty_array' },
    })
    expect(emptyMessagesRefusal({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })).toBeUndefined()
    // A body without `messages` (a legacy prompt, a malformed request) is the engine's to judge.
    expect(emptyMessagesRefusal({ model: 'm' })).toBeUndefined()
    expect(emptyMessagesRefusal({ model: 'm', messages: 'hi' })).toBeUndefined()
    expect(emptyMessagesRefusal([])).toBeUndefined()
  })
})

describe('isContextLimitError', () => {
  it('classifies overflows only on the statuses engines use for them', () => {
    expect(isContextLimitError(500, 'kv cache exceeded max_kv_size')).toBe(true)
    expect(isContextLimitError(400, 'prompt is too long for the current context length')).toBe(true)
    expect(isContextLimitError(502, 'context length exceeded')).toBe(false)
    expect(isContextLimitError(400, 'bad request')).toBe(false)
  })

  it("knows llama.cpp's own overflow by its wording and by its error type, not only by the words it shares", () => {
    // What b11642 answers (test/live/llamacpp-contract.test.ts).
    const upstream = JSON.stringify({
      error: {
        code: 400,
        message: 'request (828 tokens) exceeds the available context size (128 tokens), try increasing it',
        type: 'exceed_context_size_error',
        n_prompt_tokens: 828,
        n_ctx: 128,
      },
    })
    expect(isContextLimitError(400, upstream)).toBe(true)
    expect(isContextLimitError(400, 'request (9 tokens) exceeds the available context size')).toBe(true)
    // The type alone is enough, whatever the message says.
    expect(
      isContextLimitError(
        400,
        JSON.stringify({ error: { message: 'too big', type: 'exceed_context_size_error' } })
      )
    ).toBe(true)
    expect(
      isContextLimitError(400, 'the request exceeds the available context size, try increasing it')
    ).toBe(true)
    expect(
      isContextLimitError(400, JSON.stringify({ error: { message: 'bad', type: 'invalid_request_error' } }))
    ).toBe(false)
  })
})

describe('compute failures', () => {
  it('recognises a poisoned backend only on a 500', () => {
    expect(isComputeBackendError(500, '{"error":{"message":"Compute error"}}')).toBe(true)
    expect(isComputeBackendError(400, 'Compute error')).toBe(false)
  })

  it('words the envelope by whether the engine named an out-of-memory cause', () => {
    expect(bodyIndicatesOom('CUDA_ERROR_OUT_OF_MEMORY')).toBe(true)
    expect(JSON.parse(computeErrorEnvelope(true))).toMatchObject({
      error: { code: 'insufficient_memory', message: expect.stringMatching(/^The model ran out of memory/) },
    })
    expect(JSON.parse(computeErrorEnvelope(false))).toMatchObject({
      error: { message: expect.stringMatching(/^The model failed during computation/) },
    })
  })
})

describe('isContextOverflowFinishLength', () => {
  const response = (completion?: number) => ({
    choices: [{ finish_reason: 'length' }],
    ...(completion !== undefined ? { usage: { completion_tokens: completion } } : {}),
  })
  const request = (cap: number) => Buffer.from(JSON.stringify({ max_completion_tokens: cap }))

  it('counts a length stop as a window cut-off only when the client cap was not the reason', () => {
    expect(isContextOverflowFinishLength(response(10), request(100))).toBe(true)
    expect(isContextOverflowFinishLength(response(99), request(100))).toBe(false)
    expect(isContextOverflowFinishLength(response(), request(100))).toBe(false)
    expect(isContextOverflowFinishLength(response(), Buffer.from('not json'))).toBe(true)
    expect(isContextOverflowFinishLength({ choices: [{ finish_reason: 'stop' }] }, Buffer.from('{}'))).toBe(
      false
    )
  })
})

describe('structureBackendErrorBody', () => {
  it('wraps an unstructured engine error with a typed code and leaves an envelope alone', () => {
    expect(JSON.parse(structureBackendErrorBody('context size exceeded', false, true))).toEqual({
      error: {
        message: 'context size exceeded',
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    })
    expect(JSON.parse(structureBackendErrorBody('{"detail":"oom"}', true, false))).toMatchObject({
      error: { code: 'insufficient_memory', type: 'server_error' },
    })
    expect(structureBackendErrorBody('{"error":{"message":"x"}}', false, false)).toBe(
      '{"error":{"message":"x"}}'
    )
  })
})
