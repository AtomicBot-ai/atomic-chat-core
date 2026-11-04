import { describe, expect, it } from 'vitest'
import { DEFAULT_N_PREDICT } from '../../runtime/llamacpp/generation-limits.js'
import {
  anthropicPromptTooLong,
  bodyIndicatesOom,
  clientMaxTokens,
  computeErrorEnvelope,
  emptyMessagesRefusal,
  isComputeBackendError,
  isContextLimitError,
  isLlamaContextOverflow,
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

  it("knows MLX's KV-cache wordings, and a KV-cache message that says nothing of an overflow is not one", () => {
    expect(isContextLimitError(500, 'max-kv-size reached')).toBe(true)
    expect(isContextLimitError(500, 'Max KV size reached')).toBe(true)
    expect(isContextLimitError(500, 'KV cache exceeded')).toBe(true)
    expect(isContextLimitError(500, 'kv cache overflow')).toBe(true)
    expect(isContextLimitError(500, 'kv cache too small for this prompt')).toBe(true)
    expect(isContextLimitError(500, 'kv cache allocated')).toBe(false)
    // An error envelope that is not an object, or a type that is not a string, is read as text.
    expect(isContextLimitError(400, JSON.stringify({ error: 'upstream went away' }))).toBe(false)
    expect(isContextLimitError(400, JSON.stringify({ error: { type: 7 } }))).toBe(false)
  })
})

describe('anthropicPromptTooLong', () => {
  const upstream = (fields: Record<string, unknown>) =>
    JSON.stringify({ error: { code: 400, type: 'exceed_context_size_error', ...fields } })
  const message = (body: string | undefined) =>
    (JSON.parse(body ?? 'null') as { error: { message: string } } | null)?.error.message

  it("words llama.cpp's overflow as Anthropic's prompt-too-long, from its size fields", () => {
    const body = upstream({
      message: 'request (828 tokens) exceeds the available context size (128 tokens), try increasing it',
      n_prompt_tokens: 828,
      n_ctx: 128,
    })
    expect(JSON.parse(anthropicPromptTooLong(400, body) ?? 'null')).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 828 tokens > 128 maximum' },
    })
  })

  it('reads the sizes from the message when the fields are missing, unusable or a window of 0', () => {
    // A build that sends no size fields.
    expect(
      message(
        anthropicPromptTooLong(
          400,
          upstream({ message: 'request (900 tokens) exceeds the available context size (512 tokens)' })
        )
      )
    ).toBe('prompt is too long: 900 tokens > 512 maximum')
    // The other wording llama.cpp sends under the same error type.
    expect(
      message(
        anthropicPromptTooLong(
          400,
          upstream({ message: 'input (5000 tokens) is larger than the max context size (4096 tokens)' })
        )
      )
    ).toBe('prompt is too long: 5000 tokens > 4096 maximum')
    // A window of 0 is no window: the message decides.
    expect(
      message(
        anthropicPromptTooLong(
          400,
          upstream({
            message: 'request (70 tokens) exceeds the available context size (64 tokens)',
            n_prompt_tokens: 70,
            n_ctx: 0,
          })
        )
      )
    ).toBe('prompt is too long: 70 tokens > 64 maximum')
    // Plain text, not JSON at all.
    expect(
      message(anthropicPromptTooLong(400, 'request (9 tokens) exceeds the available context size (8 tokens)'))
    ).toBe('prompt is too long: 9 tokens > 8 maximum')
    // An `error` that is a string: the whole body is the message.
    expect(
      message(
        anthropicPromptTooLong(
          400,
          JSON.stringify({ error: 'request (33 tokens) exceeds the available context size (32 tokens)' })
        )
      )
    ).toBe('prompt is too long: 33 tokens > 32 maximum')
  })

  it('is undefined for another status, another error, or an overflow that does not state both sizes', () => {
    const overflow = 'request (9 tokens) exceeds the available context size (8 tokens)'
    expect(anthropicPromptTooLong(500, overflow)).toBeUndefined()
    expect(anthropicPromptTooLong(400, 'bad request')).toBeUndefined()
    expect(
      anthropicPromptTooLong(
        400,
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } })
      )
    ).toBeUndefined()
    expect(
      anthropicPromptTooLong(400, 'request (9 tokens) exceeds the available context size')
    ).toBeUndefined()
    expect(anthropicPromptTooLong(400, upstream({ message: 'too big' }))).toBeUndefined()
    // A message that is not a string falls back to the body, which names no sizes either.
    expect(anthropicPromptTooLong(400, upstream({ message: 42, n_prompt_tokens: 9 }))).toBeUndefined()
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

  it("does not take a stop at the engine's own --n-predict cap for a window cut-off", () => {
    const noCap = Buffer.from('{}')
    // Core starts llama.cpp with --n-predict DEFAULT_N_PREDICT: a client without max_tokens stops there.
    expect(isContextOverflowFinishLength(response(DEFAULT_N_PREDICT), noCap)).toBe(false)
    expect(isContextOverflowFinishLength(response(DEFAULT_N_PREDICT - 1), noCap)).toBe(false)
    // Well short of it, the window ran out.
    expect(isContextOverflowFinishLength(response(1200), noCap)).toBe(true)
    // A user's own cap, passed by the caller.
    expect(isContextOverflowFinishLength(response(4096), noCap, 4096)).toBe(false)
    expect(isContextOverflowFinishLength(response(4096), noCap, 8192)).toBe(true)
    // An engine started without a cap: any length stop is the window.
    expect(isContextOverflowFinishLength(response(DEFAULT_N_PREDICT), noCap, null)).toBe(true)
    // The client's cap still wins over the engine's.
    expect(isContextOverflowFinishLength(response(511), request(512))).toBe(false)
    expect(isContextOverflowFinishLength(response(500), request(512))).toBe(true)
  })

  it('finds no length stop in a response that is not an object or has no usable choices', () => {
    const noCap = Buffer.from('{}')
    expect(isContextOverflowFinishLength([], noCap)).toBe(false)
    expect(isContextOverflowFinishLength({ choices: 'length' }, noCap)).toBe(false)
    expect(isContextOverflowFinishLength({ choices: ['length', null] }, noCap)).toBe(false)
    // A usage that is not an object counts as no count at all.
    expect(isContextOverflowFinishLength({ choices: [{ finish_reason: 'length' }], usage: 7 }, noCap)).toBe(
      true
    )
  })
})

describe('clientMaxTokens', () => {
  it('takes the first positive cap of max_tokens, then max_completion_tokens', () => {
    expect(clientMaxTokens(Buffer.from(JSON.stringify({ max_tokens: 256, max_completion_tokens: 64 })))).toBe(
      256
    )
    expect(clientMaxTokens(Buffer.from(JSON.stringify({ max_tokens: 0, max_completion_tokens: 64 })))).toBe(
      64
    )
    expect(clientMaxTokens(Buffer.from(JSON.stringify({ max_tokens: -1, max_completion_tokens: 1.5 })))).toBe(
      undefined
    )
    expect(clientMaxTokens(Buffer.from('[16]'))).toBeUndefined()
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
    // Neither an overflow nor an OOM: a plain server error, even when `error` is not an envelope.
    expect(JSON.parse(structureBackendErrorBody('{"error":"segfault"}', false, false))).toEqual({
      error: { message: '{"error":"segfault"}', type: 'server_error', code: 'server_error' },
    })
  })
})

it('recognizes a specific llama context overflow without hiding unrelated context failures', () => {
  expect(isLlamaContextOverflow('{"error":{"type":"exceed_context_size_error"}}')).toBe(true)
  expect(isLlamaContextOverflow('request (12 tokens) exceeds the available context size')).toBe(true)
  expect(isLlamaContextOverflow('failed to initialize context size')).toBe(false)
})
