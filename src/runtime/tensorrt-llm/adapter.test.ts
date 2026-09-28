import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelFamilySupport } from '../../contracts/index.js'
import { MANAGED_TEXT_ADAPTER_CONTRACT_VERSION } from '../managed-text/index.js'
import type { ManagedLaunchContext } from '../managed-text/index.js'
import { readTensorrtLlmLogFixture } from '../../../test/helpers/tensorrt-llm-log-fixtures.js'
import {
  mapTensorrtLlmContextLengthError,
  TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH,
  TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  TENSORRT_LLM_MAX_CONTEXT_LENGTH,
  TENSORRT_LLM_MAX_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_MIN_CONTEXT_LENGTH,
  TENSORRT_LLM_MIN_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_MIN_LOAD_TIMEOUT_SECONDS,
  TENSORRT_LLM_READINESS_BASE_MS,
  TENSORRT_LLM_ROUTES,
  tensorrtLlmAdapter,
  type TensorrtLlmSettings,
} from './adapter.js'

const GiB = 1024 ** 3

function baseContext(overrides: Partial<ManagedLaunchContext<TensorrtLlmSettings>> = {}) {
  const settings = tensorrtLlmAdapter.validateSettings({})
  const context: ManagedLaunchContext<TensorrtLlmSettings> = {
    modelId: 'model-1',
    settings,
    modelPath: '/atomic/model',
    engineCachePath: '/atomic/engine-cache',
    weightBytes: 4 * GiB,
    family: null,
    ...overrides,
  }
  return context
}

function family(overrides: Partial<ModelFamilySupport> = {}): ModelFamilySupport {
  return { tool_parser: null, reasoning_parser: null, structured_output: false, ...overrides }
}

describe('tensorrtLlmAdapter shape', () => {
  it('matches the descriptor id and contract version, and its readiness probe is GET /health', () => {
    expect(tensorrtLlmAdapter.id).toBe('tensorrt-llm')
    expect(tensorrtLlmAdapter.contractVersion).toBe(MANAGED_TEXT_ADAPTER_CONTRACT_VERSION)
    expect(tensorrtLlmAdapter.readiness).toEqual({ path: '/health', expectedStatus: 200 })
  })

  it('declares only the OpenAI routes trtllm-serve actually implements', () => {
    expect(TENSORRT_LLM_ROUTES).toEqual(['/v1/chat/completions', '/v1/completions', '/v1/models'])
  })

  it('stays in starting-container until a marker matches, and none match an empty tail', () => {
    expect(tensorrtLlmAdapter.stageMarkers.length).toBeGreaterThan(0)
    for (const marker of tensorrtLlmAdapter.stageMarkers) {
      expect(marker.stage).toBe('initializing-engine')
      expect(marker.pattern.test('')).toBe(false)
    }
  })
})

describe('validateSettings', () => {
  const cases: Array<[string, unknown, Partial<TensorrtLlmSettings> | 'throws']> = [
    [
      'empty object fills every default',
      {},
      {
        gpu_id: null,
        context_length: TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH,
        max_output_tokens: TENSORRT_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
        kv_cache_free_gpu_memory_fraction: TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
        load_timeout_seconds: null,
      },
    ],
    ['undefined behaves like an empty object', undefined, { gpu_id: null }],
    [
      'a valid GPU-<uuid> gpu_id passes through',
      { gpu_id: 'GPU-11111111-2222-3333-4444-555555555555' },
      {
        gpu_id: 'GPU-11111111-2222-3333-4444-555555555555',
      },
    ],
    [
      'a valid MIG-<uuid> gpu_id passes through',
      { gpu_id: 'MIG-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      {
        gpu_id: 'MIG-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
    ],
    ['null gpu_id is explicitly allowed', { gpu_id: null }, { gpu_id: null }],
    [
      'a gpu_id missing the GPU-/MIG- prefix is rejected',
      { gpu_id: '11111111-2222-3333-4444-555555555555' },
      'throws',
    ],
    ['a numeric gpu_id is rejected', { gpu_id: 42 }, 'throws'],
    [
      'the minimum context length is accepted',
      { context_length: TENSORRT_LLM_MIN_CONTEXT_LENGTH },
      {
        context_length: TENSORRT_LLM_MIN_CONTEXT_LENGTH,
      },
    ],
    [
      'the maximum context length is accepted',
      { context_length: TENSORRT_LLM_MAX_CONTEXT_LENGTH },
      {
        context_length: TENSORRT_LLM_MAX_CONTEXT_LENGTH,
      },
    ],
    [
      'a context length below the minimum is rejected',
      { context_length: TENSORRT_LLM_MIN_CONTEXT_LENGTH - 1 },
      'throws',
    ],
    [
      'a context length above the maximum is rejected',
      { context_length: TENSORRT_LLM_MAX_CONTEXT_LENGTH + 1 },
      'throws',
    ],
    ['a fractional context length is rejected', { context_length: 4096.5 }, 'throws'],
    ['a zero max_output_tokens is rejected', { max_output_tokens: 0 }, 'throws'],
    ['a negative max_output_tokens is rejected', { max_output_tokens: -1 }, 'throws'],
    [
      'the minimum kv-cache fraction is accepted',
      { kv_cache_free_gpu_memory_fraction: TENSORRT_LLM_MIN_KV_CACHE_FREE_FRACTION },
      {
        kv_cache_free_gpu_memory_fraction: TENSORRT_LLM_MIN_KV_CACHE_FREE_FRACTION,
      },
    ],
    [
      'the maximum kv-cache fraction is accepted',
      { kv_cache_free_gpu_memory_fraction: TENSORRT_LLM_MAX_KV_CACHE_FREE_FRACTION },
      {
        kv_cache_free_gpu_memory_fraction: TENSORRT_LLM_MAX_KV_CACHE_FREE_FRACTION,
      },
    ],
    [
      'a kv-cache fraction below the minimum is rejected',
      { kv_cache_free_gpu_memory_fraction: 0.05 },
      'throws',
    ],
    [
      'a kv-cache fraction above the maximum is rejected',
      { kv_cache_free_gpu_memory_fraction: 0.99 },
      'throws',
    ],
    [
      'a kv-cache fraction of exactly 1 is rejected (not a fraction reserved for other users)',
      { kv_cache_free_gpu_memory_fraction: 1 },
      'throws',
    ],
    [
      'a positive load timeout override in seconds is accepted',
      { load_timeout_seconds: TENSORRT_LLM_MIN_LOAD_TIMEOUT_SECONDS },
      {
        load_timeout_seconds: TENSORRT_LLM_MIN_LOAD_TIMEOUT_SECONDS,
      },
    ],
    [
      'a null load timeout override is accepted (adapter computes it)',
      { load_timeout_seconds: null },
      {
        load_timeout_seconds: null,
      },
    ],
    ['a zero load timeout override is rejected', { load_timeout_seconds: 0 }, 'throws'],
    ['a non-integer load timeout override is rejected', { load_timeout_seconds: 12.5 }, 'throws'],
    ['a non-object settings value is rejected', 'nonsense', 'throws'],
    ['an array settings value is rejected', [], 'throws'],
  ]

  for (const [description, raw, expected] of cases) {
    it(description, () => {
      if (expected === 'throws') {
        expect(() => tensorrtLlmAdapter.validateSettings(raw)).toThrow(AtomicCoreError)
        try {
          tensorrtLlmAdapter.validateSettings(raw)
        } catch (error) {
          expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
        }
        return
      }
      expect(tensorrtLlmAdapter.validateSettings(raw)).toMatchObject(expected)
    })
  }
})

describe('buildLaunch', () => {
  it('builds the base argv with no parsers when the family names none', () => {
    const context = baseContext({ family: family() })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    expect(launch.engine.container_port).toBeGreaterThan(0)
    expect(launch.argv).toEqual([
      'trtllm-serve',
      'serve',
      '/atomic/model',
      '--host',
      '0.0.0.0',
      '--port',
      String(launch.engine.container_port),
      '--max_seq_len',
      String(TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH),
      '--max_num_tokens',
      String(TENSORRT_LLM_DEFAULT_MAX_OUTPUT_TOKENS),
      '--kv_cache_free_gpu_memory_fraction',
      String(TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION),
    ])
    expect(launch.argv).not.toContain('--tool_parser')
    expect(launch.argv).not.toContain('--reasoning_parser')
  })

  it('builds argv with no family entry at all (architecture missing from model_families)', () => {
    const context = baseContext({ family: null })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    expect(launch.argv).not.toContain('--tool_parser')
    expect(launch.argv).not.toContain('--reasoning_parser')
  })

  it('appends --tool_parser and --reasoning_parser only when the family names them', () => {
    const context = baseContext({ family: family({ tool_parser: 'qwen3', reasoning_parser: 'qwen3' }) })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    expect(launch.argv.slice(-4)).toEqual(['--tool_parser', 'qwen3', '--reasoning_parser', 'qwen3'])
  })

  it('appends only --tool_parser when the family names a tool parser but no reasoning parser', () => {
    const context = baseContext({ family: family({ tool_parser: 'qwen3_coder' }) })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    expect(launch.argv.slice(-2)).toEqual(['--tool_parser', 'qwen3_coder'])
    expect(launch.argv).not.toContain('--reasoning_parser')
  })

  it('reflects a non-default settings object in argv', () => {
    const settings = tensorrtLlmAdapter.validateSettings({
      context_length: 32768,
      max_output_tokens: 8192,
      kv_cache_free_gpu_memory_fraction: 0.75,
    })
    const context = baseContext({ settings })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    expect(launch.argv).toContain('32768')
    expect(launch.argv).toContain('8192')
    expect(launch.argv).toContain('0.75')
  })

  it('points the engine cache env vars at the mounted engine cache directory', () => {
    const context = baseContext({ engineCachePath: '/atomic/engine-cache' })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    for (const value of Object.values(launch.env ?? {})) {
      expect(value.startsWith('/atomic/engine-cache/')).toBe(true)
    }
    expect(Object.keys(launch.env ?? {}).length).toBeGreaterThan(0)
  })
})

describe('readinessTimeoutMs', () => {
  it('grows with weight size and always includes the base', () => {
    const settings = tensorrtLlmAdapter.validateSettings({})
    const small = tensorrtLlmAdapter.readinessTimeoutMs(1 * GiB, settings)
    const large = tensorrtLlmAdapter.readinessTimeoutMs(30 * GiB, settings)
    expect(small).toBeGreaterThanOrEqual(TENSORRT_LLM_READINESS_BASE_MS)
    expect(large).toBeGreaterThan(small)
  })

  it('gives a 30 GiB model comfortable headroom over the spec scenario of a 3-minute start', () => {
    const settings = tensorrtLlmAdapter.validateSettings({})
    const timeoutMs = tensorrtLlmAdapter.readinessTimeoutMs(30 * GiB, settings)
    expect(timeoutMs).toBeGreaterThan(3 * 60_000)
  })

  it('treats zero weight bytes as the base cost, never throwing or going negative', () => {
    const settings = tensorrtLlmAdapter.validateSettings({})
    expect(tensorrtLlmAdapter.readinessTimeoutMs(0, settings)).toBeGreaterThanOrEqual(
      TENSORRT_LLM_READINESS_BASE_MS
    )
  })
})

describe('capabilities', () => {
  it('turns on tools/reasoning only when the family names a parser, and structured_output per family', () => {
    const settings = tensorrtLlmAdapter.validateSettings({})
    expect(
      tensorrtLlmAdapter.capabilities({
        settings,
        family: family({ tool_parser: 'qwen3', reasoning_parser: 'qwen3', structured_output: true }),
      })
    ).toEqual({
      tools: true,
      reasoning: true,
      structured_output: true,
      vision: false,
      embeddings: false,
      responses: false,
    })
  })

  it('turns off tools and reasoning when the family names no parser, even if structured_output is true', () => {
    const settings = tensorrtLlmAdapter.validateSettings({})
    expect(
      tensorrtLlmAdapter.capabilities({ settings, family: family({ structured_output: true }) })
    ).toEqual({
      tools: false,
      reasoning: false,
      structured_output: true,
      vision: false,
      embeddings: false,
      responses: false,
    })
  })

  it('turns everything off when the architecture has no model_families entry at all', () => {
    const settings = tensorrtLlmAdapter.validateSettings({})
    expect(tensorrtLlmAdapter.capabilities({ settings, family: null })).toEqual({
      tools: false,
      reasoning: false,
      structured_output: false,
      vision: false,
      embeddings: false,
      responses: false,
    })
  })

  it('never advertises vision, embeddings or Responses API, regardless of family', () => {
    const settings = tensorrtLlmAdapter.validateSettings({})
    const result = tensorrtLlmAdapter.capabilities({
      settings,
      family: family({ tool_parser: 'x', reasoning_parser: 'y', structured_output: true }),
    })
    expect(result.vision).toBe(false)
    expect(result.embeddings).toBe(false)
    expect(result.responses).toBe(false)
  })
})

describe('classifyExit', () => {
  it('classifies a CUDA OOM during weight loading and extracts both numbers', () => {
    const tail = readTensorrtLlmLogFixture('oom-weight-load.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('out-of-memory')
    expect(result.numbers).toMatchObject({ requested_gib: 2.3, free_gib: 1.12 })
    expect(result.message).toMatch(/2\.3/)
  })

  it('classifies a CUDA OOM during KV-cache sizing, including a "0 bytes free" reading', () => {
    const tail = readTensorrtLlmLogFixture('oom-kv-cache-estimation.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('out-of-memory')
    expect(result.numbers).toMatchObject({ requested_gib: 135, free_gib: 0 })
  })

  it('classifies an unsupported architecture', () => {
    const tail = readTensorrtLlmLogFixture('unsupported-architecture.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('unsupported-model')
    expect(result.message).toMatch(/ExoticForCausalLM/)
  })

  it('classifies an unsupported quantization format', () => {
    const tail = readTensorrtLlmLogFixture('unsupported-quantization.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('unsupported-model')
  })

  it('falls back to "other" for a crash that matches neither pattern', () => {
    const tail = readTensorrtLlmLogFixture('other-startup-crash.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('other')
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('falls back to "other" for an empty log tail and a null exit code', () => {
    const result = tensorrtLlmAdapter.classifyExit('', null)
    expect(result.kind).toBe('other')
  })
})

describe('mapTensorrtLlmContextLengthError', () => {
  it('maps the pytorch-backend max_num_tokens overflow message to an OpenAI-shaped envelope', () => {
    const body = JSON.stringify({
      object: 'error',
      message:
        'The sum of prompt length (72417.0), query length (0) should not exceed max_num_tokens (69632)',
      type: 'BadRequestError',
      param: null,
      code: 400,
    })
    const mapped = mapTensorrtLlmContextLengthError(400, body)
    expect(mapped).toEqual({
      error: {
        message:
          "This model's maximum context length is 69632 tokens. However, your messages resulted in 72417 tokens. Please reduce the length of the messages.",
        type: 'invalid_request_error',
        param: null,
        code: 'context_length_exceeded',
      },
    })
  })

  it('maps the tensorrt-backend max_seq_len overflow message, folding in the output reservation', () => {
    const body = JSON.stringify({
      object: 'error',
      message:
        'The sum of prompt length (4000) and query length (0) max_tokens (2048) should not exceed max_seq_len (4096)',
      type: 'BadRequestError',
      param: null,
      code: 400,
    })
    const mapped = mapTensorrtLlmContextLengthError(400, body)
    expect(mapped?.error.code).toBe('context_length_exceeded')
    expect(mapped?.error.message).toContain('4096')
    expect(mapped?.error.message).toContain('6048')
  })

  it('accepts a raw unstructured body, not only the ErrorResponse JSON envelope', () => {
    const mapped = mapTensorrtLlmContextLengthError(
      400,
      'The sum of prompt length (100), query length (0) should not exceed max_num_tokens (80)'
    )
    expect(mapped?.error.code).toBe('context_length_exceeded')
  })

  it('returns null for a 400 that is not a context-length overflow', () => {
    expect(
      mapTensorrtLlmContextLengthError(400, JSON.stringify({ message: 'invalid temperature' }))
    ).toBeNull()
  })

  it('returns null for a non-400 status even with matching wording', () => {
    const body = 'The sum of prompt length (100), query length (0) should not exceed max_num_tokens (80)'
    expect(mapTensorrtLlmContextLengthError(500, body)).toBeNull()
  })

  it('returns null for malformed JSON that is not the known message shape', () => {
    expect(mapTensorrtLlmContextLengthError(400, '{not json')).toBeNull()
  })
})
