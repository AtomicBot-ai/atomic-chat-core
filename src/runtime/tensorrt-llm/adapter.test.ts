import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelFamilySupport } from '../../contracts/index.js'
import { MANAGED_TEXT_ADAPTER_CONTRACT_VERSION } from '../managed-text/index.js'
import type { ManagedLaunchContext } from '../managed-text/index.js'
import { readTensorrtLlmLogFixture } from '../../../test/helpers/tensorrt-llm-log-fixtures.js'
import {
  mapTensorrtLlmContextLengthError,
  tensorrtLlmRewriteRequestBody,
  TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH,
  TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  TENSORRT_LLM_MAX_CONTEXT_LENGTH,
  TENSORRT_LLM_MAX_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_MIN_CONTEXT_LENGTH,
  TENSORRT_LLM_MIN_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_MIN_LOAD_TIMEOUT_SECONDS,
  TENSORRT_LLM_READINESS_BASE_MS,
  TENSORRT_LLM_REWRITABLE_ROUTES,
  TENSORRT_LLM_ROUTES,
  tensorrtLlmAdapter,
  type TensorrtLlmSettings,
} from './adapter.js'

const GiB = 1024 ** 3

/** The value right after `flag` in an argv array, or `undefined` if `flag` is not present. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

function baseContext(overrides: Partial<ManagedLaunchContext<TensorrtLlmSettings>> = {}) {
  const settings = tensorrtLlmAdapter.validateSettings({})
  const context: ManagedLaunchContext<TensorrtLlmSettings> = {
    modelId: 'model-1',
    settings,
    modelPath: '/atomic/model',
    engineCachePath: '/atomic/engine-cache',
    generationFilesPath: '/atomic/heartbeat',
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

  it('declares only the OpenAI method+path routes trtllm-serve actually implements', () => {
    expect(TENSORRT_LLM_ROUTES).toEqual([
      { method: 'POST', path: '/v1/chat/completions' },
      { method: 'POST', path: '/v1/completions' },
      { method: 'GET', path: '/v1/models' },
    ])
    expect(tensorrtLlmAdapter.routes).toBe(TENSORRT_LLM_ROUTES)
  })

  it('declares only the two POST routes as rewritable, a subset of routes (findings-2.13-r2.md item 3, method+path since findings-2.13-r3.md item 1)', () => {
    expect(TENSORRT_LLM_REWRITABLE_ROUTES).toEqual([
      { method: 'POST', path: '/v1/chat/completions' },
      { method: 'POST', path: '/v1/completions' },
    ])
    expect(tensorrtLlmAdapter.rewritableRoutes).toBe(TENSORRT_LLM_REWRITABLE_ROUTES)
    for (const route of TENSORRT_LLM_REWRITABLE_ROUTES) {
      expect(TENSORRT_LLM_ROUTES).toContainEqual(route)
    }
  })

  it('stays in starting-container until a marker matches, and none match an empty tail', () => {
    expect(tensorrtLlmAdapter.stageMarkers.length).toBeGreaterThan(0)
    for (const marker of tensorrtLlmAdapter.stageMarkers) {
      expect(marker.stage).toBe('initializing-engine')
      expect(marker.pattern.test('')).toBe(false)
    }
  })

  // Each real line as `weight_loader.py`/`model_engine.py` (pinned tag v1.2.1) actually renders it,
  // not paraphrased — findings-2.13-r2.md item 7.
  it.each([
    [
      'weight_loader.py:59, HfWeightLoader.load_weights (safetensors)',
      'Loading safetensors weights in parallel: 100%|##########| 4/4 [00:12<00:00,  3.05s/it]',
    ],
    [
      'weight_loader.py:68, HfWeightLoader.load_weights (bin/pth)',
      'Loading bin weights in parallel: 100%|##########| 2/2 [00:04<00:00,  2.01s/it]',
    ],
    ['weight_loader.py:51, prefetch', 'Prefetching 4.10GB checkpoint files.'],
    [
      'model_engine.py:716, _capture_generation_cuda_graphs',
      'Creating CUDA graph instances for 8 batch sizes.',
    ],
  ])('a stage marker matches the real %s line', (_case, line) => {
    expect(tensorrtLlmAdapter.stageMarkers.some((marker) => marker.pattern.test(line))).toBe(true)
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
      'the minimum context length is accepted (with a compatible max_output_tokens)',
      { context_length: TENSORRT_LLM_MIN_CONTEXT_LENGTH, max_output_tokens: 1 },
      {
        context_length: TENSORRT_LLM_MIN_CONTEXT_LENGTH,
        max_output_tokens: 1,
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
      'max_output_tokens equal to context_length is rejected (no room left for any prompt; cross-field rule, findings-2.13-r1.md item 1)',
      { context_length: 4096, max_output_tokens: 4096 },
      'throws',
    ],
    [
      'max_output_tokens one below context_length is accepted',
      { context_length: 4096, max_output_tokens: 4095 },
      { context_length: 4096, max_output_tokens: 4095 },
    ],
    [
      'max_output_tokens greater than context_length is rejected, even though each is individually in bounds',
      { context_length: 2048, max_output_tokens: 4096 },
      'throws',
    ],
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
      // --max_num_tokens caps the pytorch backend's PROMPT alone (llmapi/llm.py's
      // _check_arguments, adapter.ts file header), never the output, so it always tracks
      // context_length here, never max_output_tokens (findings-2.13-r1.md item 1's ruling).
      String(TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH),
      '--kv_cache_free_gpu_memory_fraction',
      String(TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION),
    ])
    expect(launch.argv).not.toContain('--tool_parser')
    expect(launch.argv).not.toContain('--reasoning_parser')
  })

  it('sets --max_num_tokens to context_length, never to max_output_tokens, when the two differ', () => {
    const settings = tensorrtLlmAdapter.validateSettings({ context_length: 16384, max_output_tokens: 256 })
    const context = baseContext({ settings })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    expect(flagValue(launch.argv, '--max_seq_len')).toBe('16384')
    expect(flagValue(launch.argv, '--max_num_tokens')).toBe('16384')
    expect(launch.argv).not.toContain('256')
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
    expect(flagValue(launch.argv, '--tool_parser')).toBe('qwen3')
    expect(flagValue(launch.argv, '--reasoning_parser')).toBe('qwen3')
  })

  it('appends only --tool_parser when the family names a tool parser but no reasoning parser', () => {
    const context = baseContext({ family: family({ tool_parser: 'qwen3_coder' }) })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    expect(flagValue(launch.argv, '--tool_parser')).toBe('qwen3_coder')
    expect(launch.argv).not.toContain('--reasoning_parser')
  })

  it('reflects a non-default settings object in argv, by flag/value pair rather than loose membership', () => {
    const settings = tensorrtLlmAdapter.validateSettings({
      context_length: 32768,
      max_output_tokens: 8192,
      kv_cache_free_gpu_memory_fraction: 0.75,
    })
    const context = baseContext({ settings })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    expect(flagValue(launch.argv, '--max_seq_len')).toBe('32768')
    expect(flagValue(launch.argv, '--max_num_tokens')).toBe('32768')
    expect(flagValue(launch.argv, '--kv_cache_free_gpu_memory_fraction')).toBe('0.75')
  })

  it('enables guided decoding (xgrammar) through --extra_llm_api_options when the family declares structured output (final review I-2)', () => {
    const launch = tensorrtLlmAdapter.buildLaunch(
      baseContext({ family: family({ structured_output: true }) })
    )
    expect(flagValue(launch.argv, '--extra_llm_api_options')).toBe('/atomic/heartbeat/llm-api-options.yaml')
    expect(launch.files).toEqual({ 'llm-api-options.yaml': 'guided_decoding_backend: xgrammar\n' })
  })

  it('writes no LLM API options file for a family without structured output, or no family at all', () => {
    for (const f of [family(), null]) {
      const launch = tensorrtLlmAdapter.buildLaunch(baseContext({ family: f }))
      expect(launch.argv).not.toContain('--extra_llm_api_options')
      expect(launch.files).toBeUndefined()
    }
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

  it('honors settings.load_timeout_seconds outright, bypassing the weight-based estimate entirely (findings-2.13-r1.md item 4: validated but previously never read back)', () => {
    const settings = tensorrtLlmAdapter.validateSettings({ load_timeout_seconds: 45 })
    // A 500 GiB weight would otherwise dominate the computed estimate by orders of magnitude.
    expect(tensorrtLlmAdapter.readinessTimeoutMs(500 * GiB, settings)).toBe(45_000)
  })

  it('falls back to the weight-based estimate when load_timeout_seconds is null', () => {
    const withNull = tensorrtLlmAdapter.validateSettings({ load_timeout_seconds: null })
    const withoutField = tensorrtLlmAdapter.validateSettings({})
    expect(tensorrtLlmAdapter.readinessTimeoutMs(4 * GiB, withNull)).toBe(
      tensorrtLlmAdapter.readinessTimeoutMs(4 * GiB, withoutField)
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

  it('classifies a CUDA OOM reported in KiB on both sides', () => {
    const tail = readTensorrtLlmLogFixture('oom-small-allocation-kib.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('out-of-memory')
    expect(result.numbers?.['requested_gib']).toBeCloseTo(768 / (1024 * 1024), 9)
    expect(result.numbers?.['free_gib']).toBeCloseTo(512 / (1024 * 1024), 9)
  })

  it('classifies the executor\'s own C++ CUDA runtime OOM, with no "Tried to allocate" numbers to extract', () => {
    const tail = readTensorrtLlmLogFixture('oom-cpp-runtime.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('out-of-memory')
    expect(result.numbers).toBeUndefined()
    expect(result.message).toMatch(/unknown amount/)
  })

  it('classifies an unsupported architecture (pytorch backend wording)', () => {
    const tail = readTensorrtLlmLogFixture('unsupported-architecture.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('unsupported-model')
    expect(result.message).toMatch(/ExoticForCausalLM/)
  })

  it('classifies an unsupported quantization format (the real quant_mode raise, not the "quant algo" warning)', () => {
    const tail = readTensorrtLlmLogFixture('unsupported-quantization.log')
    const result = tensorrtLlmAdapter.classifyExit(tail, 1)
    expect(result.kind).toBe('unsupported-model')
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('does not misclassify plain "Unsupported quant algo" warning text as an exit (never raised as an exception, so never a log tail on its own)', () => {
    const result = tensorrtLlmAdapter.classifyExit('Unsupported quant algo: FP8_QDQ, falling back', 1)
    expect(result.kind).toBe('other')
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

  it('maps the pytorch-backend _deduce_max_tokens overflow (base_worker.py) — the case that actually fires now that --max_num_tokens tracks context_length', () => {
    const body = JSON.stringify({
      object: 'error',
      message:
        '`default_max_tokens` (-152) must be greater than 0, `default_max_tokens` (-152) = ' +
        'max_seq_len (8192) - `splited_prompt_len` (8000) - `query_token_len` (344)',
      type: 'BadRequestError',
      param: null,
      code: 400,
    })
    const mapped = mapTensorrtLlmContextLengthError(400, body)
    expect(mapped).toEqual({
      error: {
        message:
          "This model's maximum context length is 8192 tokens. However, your messages resulted in " +
          '8344 tokens. Please reduce the length of the messages.',
        type: 'invalid_request_error',
        param: null,
        code: 'context_length_exceeded',
      },
    })
  })

  it('no longer matches the legacy tensorrt-backend "max_tokens ... should not exceed max_seq_len" wording (findings-2.13-r1.md item 9: unreachable, this adapter never passes --backend, so it was dropped, not just documented)', () => {
    const body =
      'The sum of prompt length (4000) and query length (0) max_tokens (2048) should not exceed max_seq_len (4096)'
    expect(mapTensorrtLlmContextLengthError(400, body)).toBeNull()
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

describe('rewriteRequestBody (output-length enforcement, findings-2.13-r1.md item 1, corrected by findings-2.13-r2.md item 1)', () => {
  const settings = tensorrtLlmAdapter.validateSettings({ max_output_tokens: 512 })

  it('is wired onto the adapter object, not only exported standalone', () => {
    expect(tensorrtLlmAdapter.rewriteRequestBody).toBe(tensorrtLlmRewriteRequestBody)
  })

  it('fills max_tokens with the setting when the field is absent, on /v1/completions', () => {
    expect(tensorrtLlmRewriteRequestBody('/v1/completions', { prompt: 'hi' }, settings)).toEqual({
      prompt: 'hi',
      max_tokens: 512,
    })
  })

  it('clamps a higher client-requested max_tokens down to the setting, on /v1/completions', () => {
    const result = tensorrtLlmRewriteRequestBody(
      '/v1/completions',
      { prompt: 'hi', max_tokens: 4096 },
      settings
    )
    expect(result).toMatchObject({ max_tokens: 512 })
  })

  it('leaves a lower client-requested max_tokens untouched, on /v1/completions', () => {
    const result = tensorrtLlmRewriteRequestBody(
      '/v1/completions',
      { prompt: 'hi', max_tokens: 100 },
      settings
    )
    expect(result).toMatchObject({ max_tokens: 100 })
  })

  it('throws for a present but invalid max_tokens on /v1/completions, rather than silently substituting the cap', () => {
    for (const bad of [0, -5, 'lots', 1.5]) {
      expect(() => tensorrtLlmRewriteRequestBody('/v1/completions', { max_tokens: bad }, settings)).toThrow(
        /max_tokens/
      )
    }
  })

  it('throws an AtomicCoreError INVALID_ARGUMENT specifically, not a plain Error, so the gateway knows this is safe to surface to the client (findings-2.13-r3.md item 3)', () => {
    try {
      tensorrtLlmRewriteRequestBody('/v1/completions', { max_tokens: 0 }, settings)
      expect.unreachable('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicCoreError)
      expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
    }
  })

  it('treats null max_tokens as absent (not invalid), on /v1/completions', () => {
    expect(tensorrtLlmRewriteRequestBody('/v1/completions', { max_tokens: null }, settings)).toMatchObject({
      max_tokens: 512,
    })
  })

  describe('/v1/chat/completions — exactly one of the two keys (TRT-LLM 1.2.1 extra="forbid" + a single aliased field, findings-2.13-r2.md item 1)', () => {
    it('writes max_tokens, not max_completion_tokens, when the client sent neither', () => {
      const result = tensorrtLlmRewriteRequestBody(
        '/v1/chat/completions',
        { messages: [] },
        settings
      ) as Record<string, unknown>
      expect(result).toMatchObject({ max_tokens: 512 })
      expect('max_completion_tokens' in result).toBe(false)
    })

    it('writes max_tokens, capped, when the client sent only max_tokens', () => {
      const result = tensorrtLlmRewriteRequestBody(
        '/v1/chat/completions',
        { messages: [], max_tokens: 9999 },
        settings
      ) as Record<string, unknown>
      expect(result).toMatchObject({ max_tokens: 512 })
      expect('max_completion_tokens' in result).toBe(false)
    })

    it('writes max_completion_tokens, capped, when the client sent only max_completion_tokens', () => {
      const result = tensorrtLlmRewriteRequestBody(
        '/v1/chat/completions',
        { messages: [], max_completion_tokens: 9999 },
        settings
      ) as Record<string, unknown>
      expect(result).toMatchObject({ max_completion_tokens: 512 })
      expect('max_tokens' in result).toBe(false)
    })

    it('writes exactly one key — max_completion_tokens — never both, when the client sent both', () => {
      const result = tensorrtLlmRewriteRequestBody(
        '/v1/chat/completions',
        { messages: [], max_tokens: 9999, max_completion_tokens: 100 },
        settings
      ) as Record<string, unknown>
      // The lower of the two, still capped, wins — under max_completion_tokens (item 1's ruling).
      expect(result).toMatchObject({ max_completion_tokens: 100 })
      expect('max_tokens' in result).toBe(false)
    })

    it('picks the lower of the two client values, both still capped, when both are sent', () => {
      const result = tensorrtLlmRewriteRequestBody(
        '/v1/chat/completions',
        { messages: [], max_tokens: 50, max_completion_tokens: 9999 },
        settings
      )
      expect(result).toMatchObject({ max_completion_tokens: 50 })
    })

    it('throws for a present but invalid value in either field, rather than silently substituting the cap', () => {
      for (const body of [
        { max_tokens: 0 },
        { max_tokens: -1 },
        { max_tokens: 'lots' },
        { max_completion_tokens: 0 },
        { max_completion_tokens: 'lots' },
      ]) {
        expect(() => tensorrtLlmRewriteRequestBody('/v1/chat/completions', body, settings)).toThrow()
      }
    })

    it('treats null in either field as absent, not invalid', () => {
      const result = tensorrtLlmRewriteRequestBody(
        '/v1/chat/completions',
        { max_tokens: null, max_completion_tokens: null },
        settings
      )
      expect(result).toMatchObject({ max_tokens: 512 })
    })

    it('never produces a body with both keys present, for any input', () => {
      const cases: unknown[] = [
        {},
        { max_tokens: 10 },
        { max_completion_tokens: 10 },
        { max_tokens: 10, max_completion_tokens: 20 },
      ]
      for (const body of cases) {
        const result = tensorrtLlmRewriteRequestBody('/v1/chat/completions', body, settings) as Record<
          string,
          unknown
        >
        const keys = ['max_tokens', 'max_completion_tokens'].filter((k) => k in result)
        expect(keys.length).toBe(1)
      }
    })
  })

  it('leaves a route it does not own (e.g. /v1/models) completely unchanged, same reference', () => {
    const body = { anything: 'unchanged' }
    expect(tensorrtLlmRewriteRequestBody('/v1/models', body, settings)).toBe(body)
  })

  it('leaves a non-plain-object body unchanged rather than guessing at its shape', () => {
    expect(tensorrtLlmRewriteRequestBody('/v1/completions', 'not an object', settings)).toBe('not an object')
    expect(tensorrtLlmRewriteRequestBody('/v1/completions', null, settings)).toBe(null)
    expect(tensorrtLlmRewriteRequestBody('/v1/completions', [1, 2], settings)).toEqual([1, 2])
  })
})

describe('rewriteRequestBody: an OpenAI json_schema wrapper is unwrapped to the bare schema trtllm-serve 1.2.1 expects', () => {
  const settings = tensorrtLlmAdapter.validateSettings({ max_output_tokens: 512 })
  const schema = {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
    additionalProperties: false,
  }
  const formatOf = (route: string, body: Record<string, unknown>) =>
    (tensorrtLlmRewriteRequestBody(route, body, settings) as Record<string, unknown>)['response_format']

  it.each<[string, string, unknown, unknown]>([
    [
      'the OpenAI wrapper, name/strict/description dropped',
      '/v1/chat/completions',
      { type: 'json_schema', json_schema: { name: 'r', strict: true, description: 'd', schema } },
      { type: 'json_schema', json_schema: schema },
    ],
    [
      'the OpenAI wrapper with only a schema',
      '/v1/chat/completions',
      { type: 'json_schema', json_schema: { schema } },
      { type: 'json_schema', json_schema: schema },
    ],
    [
      'the OpenAI wrapper on /v1/completions (its CompletionRequest takes the same ResponseFormat)',
      '/v1/completions',
      { type: 'json_schema', json_schema: { name: 'r', schema } },
      { type: 'json_schema', json_schema: schema },
    ],
    [
      'a bare schema, already what the engine reads',
      '/v1/chat/completions',
      { type: 'json_schema', json_schema: schema },
      { type: 'json_schema', json_schema: schema },
    ],
    [
      'a bare schema that has a schema-valued but non-object key and no name or strict',
      '/v1/chat/completions',
      { type: 'json_schema', json_schema: { type: 'object', schema: true } },
      { type: 'json_schema', json_schema: { type: 'object', schema: true } },
    ],
    [
      "TensorRT-LLM's own json type",
      '/v1/chat/completions',
      { type: 'json', schema },
      { type: 'json', schema },
    ],
    ['json_object', '/v1/chat/completions', { type: 'json_object' }, { type: 'json_object' }],
    ['text', '/v1/chat/completions', { type: 'text' }, { type: 'text' }],
  ])('forwards %s', (_label, route, format, expected) => {
    expect(formatOf(route, { model: 'm', response_format: format })).toEqual(expected)
  })

  it('leaves a body without response_format without one', () => {
    const result = tensorrtLlmRewriteRequestBody('/v1/chat/completions', { model: 'm' }, settings)
    expect('response_format' in (result as Record<string, unknown>)).toBe(false)
  })

  it('does not mutate the client body it was given', () => {
    const format = { type: 'json_schema', json_schema: { name: 'r', schema } }
    tensorrtLlmRewriteRequestBody('/v1/chat/completions', { response_format: format }, settings)
    expect(format.json_schema).toEqual({ name: 'r', schema })
  })

  it.each<[string, unknown]>([
    ['missing', { type: 'json_schema' }],
    ['null', { type: 'json_schema', json_schema: null }],
    ['a string', { type: 'json_schema', json_schema: 'schema' }],
    ['an array', { type: 'json_schema', json_schema: [schema] }],
  ])(
    'refuses a json_schema format whose json_schema is %s with an INVALID_ARGUMENT the gateway surfaces',
    (_label, format) => {
      for (const route of ['/v1/chat/completions', '/v1/completions']) {
        try {
          tensorrtLlmRewriteRequestBody(route, { response_format: format }, settings)
          expect.unreachable('expected a throw')
        } catch (error) {
          expect(error).toBeInstanceOf(AtomicCoreError)
          expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
          expect((error as AtomicCoreError).message).toBe(
            "response_format.json_schema must be an object when response_format.type is 'json_schema'."
          )
        }
      }
    }
  )

  it.each<[string, unknown]>([
    ['name alone', { name: 'r' }],
    ['strict alone', { strict: true }],
    ['name and strict', { name: 'r', strict: true }],
    ['name with a boolean schema', { name: 'r', schema: true }],
    ['name with a string schema', { name: 'r', schema: '{}' }],
    ['strict with a null schema', { strict: false, schema: null }],
    ['name with an array schema', { name: 'r', schema: [schema] }],
  ])(
    'refuses an OpenAI-shaped wrapper (%s) with no object schema instead of building a grammar from name/strict',
    (_label, wrapper) => {
      for (const route of ['/v1/chat/completions', '/v1/completions']) {
        try {
          tensorrtLlmRewriteRequestBody(
            route,
            { response_format: { type: 'json_schema', json_schema: wrapper } },
            settings
          )
          expect.unreachable('expected a throw')
        } catch (error) {
          expect(error).toBeInstanceOf(AtomicCoreError)
          expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
          expect((error as AtomicCoreError).message).toBe(
            'response_format.json_schema.schema must be an object when response_format.json_schema carries name or strict.'
          )
        }
      }
    }
  )

  it('refuses an unsupported structured-output request before looking at its shape', () => {
    const caps = {
      tools: false,
      reasoning: false,
      structured_output: false,
      vision: false,
      embeddings: false,
      responses: false,
    }
    expect(() =>
      tensorrtLlmRewriteRequestBody(
        '/v1/chat/completions',
        { response_format: { type: 'json_schema' } },
        settings,
        caps
      )
    ).toThrow(/does not support structured output/)
  })
})

describe('tensorrtLlmAdapter: the session port refuses what the model cannot do (findings-2.14-r1.md item 1)', () => {
  const settings = tensorrtLlmAdapter.validateSettings({})
  const caps = (over: Partial<Record<'tools' | 'structured_output', boolean>> = {}) => ({
    tools: false,
    reasoning: false,
    structured_output: false,
    vision: false,
    embeddings: false,
    responses: false,
    ...over,
  })
  const rewrite =
    (body: unknown, capabilities = caps(), route = '/v1/chat/completions') =>
    () =>
      tensorrtLlmAdapter.rewriteRequestBody!(route, body, settings, capabilities)
  const refusal = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      return error as { openaiCode?: string; message: string }
    }
    throw new Error('expected a refusal')
  }

  it.each<[string, Record<string, unknown>, string]>([
    ['a tools list', { tools: [{ type: 'function', function: { name: 'f' } }] }, 'tool calling'],
    ['a tool_choice', { tool_choice: 'required' }, 'tool calling'],
    [
      'a JSON schema',
      { response_format: { type: 'json_schema', json_schema: { name: 's' } } },
      'structured output',
    ],
    ['a JSON object format', { response_format: { type: 'json_object' } }, 'structured output'],
    // TensorRT-LLM's own guided-decoding types, and anything else but text (final review I-2).
    ['a TensorRT-LLM json format', { response_format: { type: 'json', schema: {} } }, 'structured output'],
    ['a regex format', { response_format: { type: 'regex', regex: 'a+' } }, 'structured output'],
    ['an ebnf format', { response_format: { type: 'ebnf', ebnf: 'root ::= "a"' } }, 'structured output'],
    ['a structural_tag format', { response_format: { type: 'structural_tag' } }, 'structured output'],
    ['an unknown format type', { response_format: { type: 'grammar' } }, 'structured output'],
    ['a format with no type', { response_format: {} }, 'structured output'],
  ])('refuses %s with unsupported_capability, worded like :1337', (_label, extra, what) => {
    const error = refusal(rewrite({ model: 'llama-3', ...extra }))
    expect(error.openaiCode).toBe('unsupported_capability')
    expect(error.message).toBe(`The model 'llama-3' does not support ${what}.`)
  })

  it('lets through what the model can do, and what asks for nothing optional', () => {
    const tools = { model: 'm', tools: [{ type: 'function' }], tool_choice: 'auto' }
    expect(rewrite(tools, caps({ tools: true }))()).toMatchObject({ tools: tools.tools })
    const json = { model: 'm', response_format: { type: 'json_object' } }
    expect(rewrite(json, caps({ structured_output: true }))()).toMatchObject({
      response_format: json.response_format,
    })
    expect(
      rewrite({ model: 'm', tools: [], tool_choice: 'none', response_format: { type: 'text' } })()
    ).toMatchObject({
      max_tokens: 4096,
    })
    expect(rewrite({ model: 'm' }, caps(), '/v1/completions')()).toMatchObject({ max_tokens: 4096 })
  })

  it('names the model generically when the body does not say which', () => {
    expect(refusal(rewrite({ tools: [1] })).message).toBe('This model does not support tool calling.')
  })

  it("maps trtllm-serve's overflow on the session port, and leaves every other error to the engine's own wording", () => {
    const overflow = JSON.stringify({
      object: 'error',
      message: 'The sum of prompt length (9000), query length (0) should not exceed max_num_tokens (8192)',
      type: 'BadRequestError',
      param: null,
      code: 400,
    })
    expect(tensorrtLlmAdapter.mapErrorResponse!('/v1/chat/completions', 400, overflow)).toMatchObject({
      error: { code: 'context_length_exceeded' },
    })
    expect(tensorrtLlmAdapter.mapErrorResponse!('/v1/chat/completions', 400, '{"message":"x"}')).toBeNull()
  })

  it('restarts only for settings the container was started with: context and KV fraction', () => {
    const key = (raw: Record<string, unknown>) =>
      JSON.stringify(tensorrtLlmAdapter.restartKey!(tensorrtLlmAdapter.validateSettings(raw)))
    const base = key({})
    expect(key({ max_output_tokens: 1024 })).toBe(base)
    expect(key({ load_timeout_seconds: 900 })).toBe(base)
    expect(key({ context_length: 16384 })).not.toBe(base)
    expect(key({ kv_cache_free_gpu_memory_fraction: 0.5 })).not.toBe(base)
  })
})
