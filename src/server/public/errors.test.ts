import { describe, expect, it } from 'vitest'
import { SGLANG_CONTEXT_OVERFLOW_BODIES } from '../../../test/helpers/sglang-log-fixtures.js'
import { VLLM_CONTEXT_OVERFLOW_BODIES } from '../../../test/helpers/vllm-log-fixtures.js'
import { DEFAULT_N_PREDICT } from '../../runtime/llamacpp/generation-limits.js'
import {
  anthropicPromptTooLong,
  bodyIndicatesOom,
  clientMaxTokens,
  computeErrorEnvelope,
  contextLengthExceededError,
  contextOverflowSizes,
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

  it('knows a body some layer already mapped to context_length_exceeded, by error.code or a top-level code', () => {
    const mapped = (code: unknown) => JSON.stringify({ error: { message: 'no room', code } })
    expect(isContextLimitError(400, mapped('context_length_exceeded'))).toBe(true)
    expect(
      isContextLimitError(400, JSON.stringify({ message: 'no room', code: 'context_length_exceeded' }))
    ).toBe(true)
    expect(isContextLimitError(400, mapped('invalid_value'))).toBe(false)
    // vLLM and llama.cpp send the HTTP status as a numeric code.
    expect(isContextLimitError(400, mapped(400))).toBe(false)
    expect(isContextLimitError(502, mapped('context_length_exceeded'))).toBe(false)
  })

  it.each([
    ['vLLM', VLLM_CONTEXT_OVERFLOW_BODIES.inputs],
    ['SGLang', SGLANG_CONTEXT_OVERFLOW_BODIES.input],
    // Neither wording says "context": only the engine's own words give it away.
    [
      'TensorRT-LLM',
      '{"object":"error","message":"The prompt length (9000.0) should not exceed max_num_tokens (8192)"}',
    ],
    ['FastFlowLM, prefill', '{"error":{"message":"Max length reached!","type":"model_error","code":400}}'],
    [
      'FastFlowLM, backend limit',
      `{"error":{"message":"Request exceeds the 4096-token limit of backend 'npu': rendered prompt has 5000 tokens","type":"model_error","code":400}}`,
    ],
  ])("knows %s's own overflow wording", (_, body) => {
    expect(isContextLimitError(400, body)).toBe(true)
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

  it('is undefined for a status engines never use for an overflow, and for any other error', () => {
    const overflow = 'request (9 tokens) exceeds the available context size (8 tokens)'
    expect(anthropicPromptTooLong(502, overflow)).toBeUndefined()
    expect(anthropicPromptTooLong(400, 'bad request')).toBeUndefined()
    expect(
      anthropicPromptTooLong(
        400,
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } })
      )
    ).toBeUndefined()
    // FastFlowLM's full queue (the session gateway's 503) is not an overflow.
    expect(
      anthropicPromptTooLong(
        503,
        JSON.stringify({
          error: { message: 'The model generation queue is full.', type: 'server_error', code: 'queue_full' },
        })
      )
    ).toBeUndefined()
    // Words an overflow shares with an out-of-memory failure are the OOM.
    expect(anthropicPromptTooLong(500, 'failed to allocate the context: out of memory')).toBeUndefined()
    // A server error that only names the context's size is a failure to set it up, not an overflow;
    // a client error that does is one.
    expect(anthropicPromptTooLong(503, 'failed to initialize context size')).toBeUndefined()
    expect(anthropicPromptTooLong(400, 'prompt is longer than the context length')).toBeDefined()
    expect(anthropicPromptTooLong(500, 'context window exceeded')).toBeDefined()
  })

  it('still says prompt is too long when the overflow states no sizes', () => {
    const noSizes = "prompt is too long: the request does not fit the model's context window"
    for (const body of [
      'request (9 tokens) exceeds the available context size',
      upstream({ message: 'too big' }),
      // A message that is not a string falls back to the body, which names no sizes either.
      upstream({ message: 42, n_prompt_tokens: 9 }),
      // FastFlowLM's prefill refusal (pinned f37cdd29, rest_handler.cpp).
      '{"error":{"message":"Max length reached!","type":"model_error","code":400}}',
      // A host's own 400 (GenieX, spike S4) and the heuristic (MLX).
      JSON.stringify({
        error: {
          message: 'GenieX: llm_generate: Input prompt too long',
          type: 'invalid_request_error',
          param: 'messages',
          code: 'context_length_exceeded',
        },
      }),
      'max_kv_size reached',
    ]) {
      expect(message(anthropicPromptTooLong(400, body))).toBe(noSizes)
    }
    // MLX answers its KV-cache overflow with a 500; the client is told 400 either way.
    expect(message(anthropicPromptTooLong(500, 'max_kv_size reached'))).toBe(noSizes)
  })

  it.each([
    ['vLLM, the input alone', VLLM_CONTEXT_OVERFLOW_BODIES.inputs, 9000, 8192],
    ['vLLM, input and output', VLLM_CONTEXT_OVERFLOW_BODIES.total, 9100, 8192],
    ['vLLM, a max_tokens the room left cannot hold', VLLM_CONTEXT_OVERFLOW_BODIES.maxTokens, 9096, 8192],
    ['SGLang, the input alone', SGLANG_CONTEXT_OVERFLOW_BODIES.input, 9000, 8192],
    ['SGLang, input and output', SGLANG_CONTEXT_OVERFLOW_BODIES.total, 9100, 8192],
    [
      'TensorRT-LLM 1.2.1',
      JSON.stringify({
        object: 'error',
        message:
          'The sum of prompt length (72417.0), query length (0) should not exceed max_num_tokens (69632)',
        code: 400,
      }),
      72417,
      69632,
    ],
    [
      'TensorRT-LLM 1.3.0rc29',
      JSON.stringify({ message: 'The prompt length (72417.0) should not exceed max_num_tokens (69632)' }),
      72417,
      69632,
    ],
    [
      'FastFlowLM, the prompt over the backend limit',
      JSON.stringify({
        error: {
          message: "Request exceeds the 4096-token limit of backend 'npu': rendered prompt has 5000 tokens",
          type: 'model_error',
          code: 400,
          session_cleared: false,
        },
      }),
      5000,
      4096,
    ],
    [
      'FastFlowLM, the prompt and the requested output',
      JSON.stringify({
        error: {
          message:
            "Request exceeds the 4096-token limit of backend 'npu': rendered prompt has 3000 tokens and requested output has 2000 tokens",
          type: 'model_error',
          code: 400,
        },
      }),
      5000,
      4096,
    ],
    [
      "the vLLM and SGLang adapters' mapped body",
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 8192 tokens, but the request has 9000 tokens. Shorten the conversation or the requested output.",
          type: 'invalid_request_error',
          param: 'messages',
          code: 'context_length_exceeded',
        },
      }),
      9000,
      8192,
    ],
    [
      "the TensorRT-LLM adapter's mapped body (OpenAI's wording)",
      JSON.stringify({
        error: {
          message:
            "This model's maximum context length is 69632 tokens. However, your messages resulted in 72417 tokens. Please reduce the length of the messages.",
          type: 'invalid_request_error',
          param: null,
          code: 'context_length_exceeded',
        },
      }),
      72417,
      69632,
    ],
  ])("words %s as Anthropic's prompt-too-long with both sizes", (_, body, prompt, window) => {
    expect(message(anthropicPromptTooLong(400, body))).toBe(
      `prompt is too long: ${prompt} tokens > ${window} maximum`
    )
  })
})

describe('contextOverflowSizes', () => {
  it("prefers llama.cpp's size fields, then reads any wording that states both sizes", () => {
    expect(
      contextOverflowSizes(
        JSON.stringify({ error: { message: 'request (1 tokens) exceeds', n_prompt_tokens: 828, n_ctx: 128 } })
      )
    ).toEqual({ prompt: 828, window: 128 })
    expect(contextOverflowSizes(VLLM_CONTEXT_OVERFLOW_BODIES.inputs)).toEqual({ prompt: 9000, window: 8192 })
    // Plain text, and a message under a top-level `message`.
    expect(contextOverflowSizes('The prompt length (10) should not exceed max_num_tokens (8)')).toEqual({
      prompt: 10,
      window: 8,
    })
  })

  it('is undefined for a body that states no sizes or a window of 0', () => {
    expect(contextOverflowSizes('Max length reached!')).toBeUndefined()
    expect(contextOverflowSizes('{"error":"segfault"}')).toBeUndefined()
    expect(
      contextOverflowSizes('request (9 tokens) exceeds the available context size (0 tokens)')
    ).toBeUndefined()
  })
})

describe('contextLengthExceededError', () => {
  it("maps an overflow with sizes to OpenAI's own wording and context_length_exceeded", () => {
    expect(contextLengthExceededError(400, SGLANG_CONTEXT_OVERFLOW_BODIES.input)).toEqual({
      error: {
        message:
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.",
        type: 'invalid_request_error',
        param: 'messages',
        code: 'context_length_exceeded',
      },
    })
  })

  it("keeps the engine's message when the overflow states no sizes", () => {
    expect(
      contextLengthExceededError(
        400,
        '{"error":{"message":"Max length reached!","type":"model_error","code":400}}'
      )
    ).toMatchObject({ error: { message: 'Max length reached!', code: 'context_length_exceeded' } })
    expect(contextLengthExceededError(500, 'context window exceeded')).toMatchObject({
      error: { message: 'context window exceeded', type: 'invalid_request_error' },
    })
  })

  it('is null for any other error, an OOM that shares the words, or a status engines do not overflow with', () => {
    expect(contextLengthExceededError(400, 'bad request')).toBeNull()
    expect(contextLengthExceededError(500, 'CUDA_ERROR_OUT_OF_MEMORY while creating the context')).toBeNull()
    expect(contextLengthExceededError(502, 'context length exceeded')).toBeNull()
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
