import { describe, expect, it } from 'vitest'
import {
  bodyIndicatesOom,
  computeErrorEnvelope,
  isComputeBackendError,
  isContextLimitError,
  isContextOverflowFinishLength,
  structureBackendErrorBody,
} from './errors.js'

describe('isContextLimitError', () => {
  it('classifies overflows only on the statuses engines use for them', () => {
    expect(isContextLimitError(500, 'kv cache exceeded max_kv_size')).toBe(true)
    expect(isContextLimitError(400, 'prompt is too long for the current context length')).toBe(true)
    expect(isContextLimitError(502, 'context length exceeded')).toBe(false)
    expect(isContextLimitError(400, 'bad request')).toBe(false)
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
