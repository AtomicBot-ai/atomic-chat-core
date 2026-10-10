import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ModelFamilySupport } from '../../contracts/index.js'
import { MANAGED_TEXT_ADAPTER_CONTRACT_VERSION } from '../managed-text/index.js'
import type { ManagedLaunchContext } from '../managed-text/index.js'
import { readTensorrtLlmLogFixture } from '../../../test/helpers/tensorrt-llm-log-fixtures.js'
import {
  mapTensorrtLlmContextLengthError,
  tensorrtLlmReasoningIntoContent,
  tensorrtLlmRewriteRequestBody,
  tensorrtLlmRewriteResponseFor,
  TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH,
  TENSORRT_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  TENSORRT_LLM_MAX_CONTEXT_LENGTH,
  TENSORRT_LLM_MAX_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_MIN_CONTEXT_LENGTH,
  TENSORRT_LLM_MIN_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_MIN_LOAD_TIMEOUT_SECONDS,
  TENSORRT_LLM_MAX_BATCH_SIZE,
  TENSORRT_LLM_READINESS_BASE_MS,
  TENSORRT_LLM_REWRITABLE_ROUTES,
  TENSORRT_LLM_ROUTES,
  tensorrtLlmAdapter,
  type TensorrtLlmSettings,
} from './adapter.js'
import { TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION } from './kv-cache.js'

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
    unifiedMemory: false,
    // A 24 GB Ada card: CUDA graphs stay on under `cuda_graphs: auto` and FP8 KV is allowed, so a
    // test of another key sees only that key in the option file.
    gpuTotalVramBytes: 24 * GiB,
    gpuComputeCapability: '8.9',
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
    [
      '1.3.0rc29 model_engine.py:2709, _capture_generation_cuda_graphs',
      'Running CUDA graph capture for 8 batch sizes.',
    ],
  ])('a stage marker matches the real %s line', (_case, line) => {
    expect(tensorrtLlmAdapter.stageMarkers.some((marker) => marker.pattern.test(line))).toBe(true)
  })
})

describe('the default KV-cache fraction in the launch', () => {
  it('passes 0.8 (TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION) when nothing is stored', () => {
    const launch = tensorrtLlmAdapter.buildLaunch(baseContext())
    expect(flagValue(launch.argv, '--kv_cache_free_gpu_memory_fraction')).toBe('0.8')
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
        max_batch_size: TENSORRT_LLM_MAX_BATCH_SIZE,
        kv_cache_max_tokens: null,
        cuda_graphs: 'auto',
        kv_cache_dtype: 'auto',
        load_timeout_seconds: null,
      },
    ],
    ['max_batch_size at its upper bound', { max_batch_size: 256 }, { max_batch_size: 256 }],
    ['max_batch_size 0 throws', { max_batch_size: 0 }, 'throws'],
    ['max_batch_size above 256 throws', { max_batch_size: 257 }, 'throws'],
    ['kv_cache_max_tokens passes through', { kv_cache_max_tokens: 32768 }, { kv_cache_max_tokens: 32768 }],
    [
      'kv_cache_max_tokens 0 throws (the settings layer maps the UI 0 to null)',
      { kv_cache_max_tokens: 0 },
      'throws',
    ],
    ['cuda_graphs off passes through', { cuda_graphs: 'off' }, { cuda_graphs: 'off' }],
    ['an empty cuda_graphs falls back to auto', { cuda_graphs: '' }, { cuda_graphs: 'auto' }],
    ['an unknown cuda_graphs throws', { cuda_graphs: 'always' }, 'throws'],
    ['kv_cache_dtype fp8 passes through', { kv_cache_dtype: 'fp8' }, { kv_cache_dtype: 'fp8' }],
    ['an unknown kv_cache_dtype throws', { kv_cache_dtype: 'int8' }, 'throws'],
    ['undefined behaves like an empty object', undefined, { gpu_id: null }],
    [
      'a valid GPU-<uuid> gpu_id passes through',
      { gpu_id: 'GPU-11111111-2222-3333-4444-555555555555' },
      {
        gpu_id: 'GPU-11111111-2222-3333-4444-555555555555',
      },
    ],
    [
      'the GB10 gpu_id nvidia-smi printed on a DGX Spark-class host (captured) passes through',
      { gpu_id: 'GPU-d991dc71-7825-0bf8-3339-cb2e7ead6a32' },
      { gpu_id: 'GPU-d991dc71-7825-0bf8-3339-cb2e7ead6a32' },
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
      // A desktop's concurrency, not trtllm-serve's 2048: hybrid (Mamba) models reserve their
      // recurrent state per sequence up front (adapter.ts, TENSORRT_LLM_MAX_BATCH_SIZE).
      '--max_batch_size',
      '1',
      '--kv_cache_free_gpu_memory_fraction',
      String(TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION),
      // Always present: the KV cache is always bounded in tokens (see the KV tests below).
      '--extra_llm_api_options',
      '/atomic/heartbeat/llm-api-options.yaml',
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
    expect(parseYaml(launch.files?.['llm-api-options.yaml'] ?? '')).toEqual({
      guided_decoding_backend: 'xgrammar',
      kv_cache_config: { max_tokens: TENSORRT_LLM_DEFAULT_CONTEXT_LENGTH * TENSORRT_LLM_MAX_BATCH_SIZE },
    })
  })

  it('leaves guided decoding out for a family without structured output, or no family at all', () => {
    for (const f of [family(), null]) {
      const launch = tensorrtLlmAdapter.buildLaunch(baseContext({ family: f }))
      expect(launch.files).toEqual({ 'llm-api-options.yaml': 'kv_cache_config:\n  max_tokens: 8192\n' })
    }
  })

  it('bounds the KV cache to two full contexts on a unified-memory card, merged with guided decoding, keeping the fraction flag', () => {
    const settings = tensorrtLlmAdapter.validateSettings({ context_length: 8192 })
    const launch = tensorrtLlmAdapter.buildLaunch(
      baseContext({ settings, unifiedMemory: true, family: family({ structured_output: true }) })
    )
    expect(flagValue(launch.argv, '--extra_llm_api_options')).toBe('/atomic/heartbeat/llm-api-options.yaml')
    expect(flagValue(launch.argv, '--kv_cache_free_gpu_memory_fraction')).toBe(
      String(TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION)
    )
    const yaml = launch.files?.['llm-api-options.yaml'] ?? ''
    expect(yaml).toBe('guided_decoding_backend: xgrammar\nkv_cache_config:\n  max_tokens: 16384\n')
    expect(parseYaml(yaml)).toEqual({
      guided_decoding_backend: 'xgrammar',
      kv_cache_config: { max_tokens: 16384 },
    })
  })

  it('writes the option file with only the KV bound on a unified-memory card whose family has no structured output', () => {
    for (const f of [family(), null]) {
      const settings = tensorrtLlmAdapter.validateSettings({ context_length: 4096, max_output_tokens: 1024 })
      const launch = tensorrtLlmAdapter.buildLaunch(baseContext({ settings, unifiedMemory: true, family: f }))
      expect(flagValue(launch.argv, '--extra_llm_api_options')).toBe('/atomic/heartbeat/llm-api-options.yaml')
      expect(launch.files).toEqual({ 'llm-api-options.yaml': 'kv_cache_config:\n  max_tokens: 8192\n' })
    }
  })

  it('bounds the KV cache on a discrete card to every sequence the batch admits at full context: hybrid (Mamba) models refuse to start without a token quota', () => {
    const settings = tensorrtLlmAdapter.validateSettings({
      context_length: 4096,
      max_output_tokens: 1024,
      max_batch_size: 4,
    })
    const launch = tensorrtLlmAdapter.buildLaunch(baseContext({ settings, unifiedMemory: false }))
    expect(flagValue(launch.argv, '--max_batch_size')).toBe('4')
    // The fraction stays: the engine takes the smaller of the two bounds.
    expect(flagValue(launch.argv, '--kv_cache_free_gpu_memory_fraction')).toBe(
      String(TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION)
    )
    expect(launch.files).toEqual({ 'llm-api-options.yaml': 'kv_cache_config:\n  max_tokens: 16384\n' })
  })

  it('lets an explicit kv_cache_max_tokens win over both the discrete and the unified-memory default, in whole blocks', () => {
    for (const unifiedMemory of [false, true]) {
      const settings = tensorrtLlmAdapter.validateSettings({ kv_cache_max_tokens: 30000 })
      const launch = tensorrtLlmAdapter.buildLaunch(baseContext({ settings, unifiedMemory }))
      expect(launch.files).toEqual({ 'llm-api-options.yaml': 'kv_cache_config:\n  max_tokens: 30016\n' })
    }
  })

  it('asks for whole KV blocks: a 2096-token context gets 2112 tokens, not the 2080 the engine would round 2096 down to', () => {
    // RTX 5090 Laptop, 2026-10-09: max_tokens 2096 became 65 blocks, "max sequence length=2080", and
    // the readiness check refused every model as out of memory with 17 GiB free.
    const settings = tensorrtLlmAdapter.validateSettings({ context_length: 2096, max_output_tokens: 1024 })
    const launch = tensorrtLlmAdapter.buildLaunch(baseContext({ settings }))
    expect(flagValue(launch.argv, '--max_seq_len')).toBe('2096')
    expect(launch.files).toEqual({ 'llm-api-options.yaml': 'kv_cache_config:\n  max_tokens: 2112\n' })
  })

  it('gives each sequence of the batch whole blocks of its own', () => {
    const settings = tensorrtLlmAdapter.validateSettings({
      context_length: 2096,
      max_output_tokens: 1024,
      max_batch_size: 2,
    })
    const launch = tensorrtLlmAdapter.buildLaunch(baseContext({ settings }))
    expect(launch.files).toEqual({ 'llm-api-options.yaml': 'kv_cache_config:\n  max_tokens: 4224\n' })
  })

  it('turns CUDA graphs off under auto on a card below 12 GiB, and keeps them when the card reports no size (unified memory)', () => {
    const options = (context: ManagedLaunchContext<TensorrtLlmSettings>) =>
      parseYaml(tensorrtLlmAdapter.buildLaunch(context).files?.['llm-api-options.yaml'] ?? '') as Record<
        string,
        unknown
      >
    expect(options(baseContext({ gpuTotalVramBytes: 8 * GiB }))).toHaveProperty('cuda_graph_config', null)
    expect(options(baseContext({ gpuTotalVramBytes: null }))).not.toHaveProperty('cuda_graph_config')
    const { gpuTotalVramBytes: _absent, ...noSize } = baseContext()
    expect(options(noSize)).not.toHaveProperty('cuda_graph_config')
  })

  it('keeps CUDA graphs under auto on a 12 GiB card, and follows an explicit on/off whatever the card', () => {
    const graphsOff = (cuda_graphs: string, gpuTotalVramBytes: number) => {
      const settings = tensorrtLlmAdapter.validateSettings({ cuda_graphs })
      const yaml = tensorrtLlmAdapter.buildLaunch(baseContext({ settings, gpuTotalVramBytes })).files?.[
        'llm-api-options.yaml'
      ]
      return 'cuda_graph_config' in (parseYaml(yaml ?? '') as Record<string, unknown>)
    }
    expect(graphsOff('auto', 12 * GiB)).toBe(false)
    expect(graphsOff('on', 8 * GiB)).toBe(false)
    expect(graphsOff('off', 24 * GiB)).toBe(true)
  })

  it("follows the launch plan's CUDA graphs over the card's size: a 24 GiB card with no room for them leaves them off", () => {
    const graphsOff = (plan: unknown) =>
      'cuda_graph_config' in
      (parseYaml(
        tensorrtLlmAdapter.buildLaunch(baseContext({ gpuTotalVramBytes: 24 * GiB, plan })).files?.[
          'llm-api-options.yaml'
        ] ?? ''
      ) as Record<string, unknown>)
    expect(graphsOff({ cudaGraphs: false })).toBe(true)
    expect(graphsOff({ cudaGraphs: true })).toBe(false)
    // Another engine's plan, or none, is not this one's: the card's size decides.
    expect(graphsOff({ gpuMemoryUtilization: 0.9 })).toBe(false)
    expect(graphsOff(undefined)).toBe(false)
  })

  it('writes an FP8 KV cache only on compute capability 8.9 or newer, and never under auto', () => {
    const dtype = (kv_cache_dtype: string, gpuComputeCapability: string | null) => {
      const settings = tensorrtLlmAdapter.validateSettings({ kv_cache_dtype })
      const yaml = tensorrtLlmAdapter.buildLaunch(baseContext({ settings, gpuComputeCapability })).files?.[
        'llm-api-options.yaml'
      ]
      return (parseYaml(yaml ?? '') as { kv_cache_config: { dtype?: string } }).kv_cache_config.dtype
    }
    expect(dtype('fp8', '8.9')).toBe('fp8')
    expect(dtype('fp8', '12.0')).toBe('fp8')
    expect(dtype('fp8', '8.6')).toBeUndefined()
    expect(dtype('fp8', null)).toBeUndefined()
    expect(dtype('auto', '12.0')).toBeUndefined()
  })

  it('restarts the container when any launch-shaping setting changes, never for the output cap or load timeout', () => {
    const key = (raw: Record<string, unknown>) =>
      JSON.stringify(tensorrtLlmAdapter.restartKey?.(tensorrtLlmAdapter.validateSettings(raw)))
    const base = key({})
    for (const changed of [
      { max_batch_size: 4 },
      { kv_cache_max_tokens: 4096 },
      { cuda_graphs: 'off' },
      { kv_cache_dtype: 'fp8' },
    ]) {
      expect(key(changed)).not.toBe(base)
    }
    expect(key({ max_output_tokens: 128, load_timeout_seconds: 60 })).toBe(base)
  })

  it('points the engine cache env vars at the mounted engine cache directory', () => {
    const context = baseContext({ engineCachePath: '/atomic/engine-cache' })
    const launch = tensorrtLlmAdapter.buildLaunch(context)
    const { TRTLLM_NO_USAGE_STATS: _telemetry, ...caches } = launch.env ?? {}
    for (const value of Object.values(caches)) {
      expect(value.startsWith('/atomic/engine-cache/')).toBe(true)
    }
    expect(Object.keys(caches).length).toBeGreaterThan(0)
  })

  it('turns off the usage telemetry trtllm-serve sends to NVIDIA by default from 1.3', () => {
    expect(tensorrtLlmAdapter.buildLaunch(baseContext()).env?.['TRTLLM_NO_USAGE_STATS']).toBe('1')
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

  it('gives a small model several minutes: Qwen3.5-2B on an RTX Spark was still starting after 128 s', () => {
    const settings = tensorrtLlmAdapter.validateSettings({})
    expect(tensorrtLlmAdapter.readinessTimeoutMs(4.2 * GiB, settings)).toBeGreaterThanOrEqual(5 * 60_000)
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

  it('keeps no excerpt for a log it did not classify as out of memory', () => {
    expect(
      tensorrtLlmAdapter.classifyExit(readTensorrtLlmLogFixture('other-startup-crash.log'), 1).excerpt
    ).toBeUndefined()
  })
})

describe('classifyExit: the out-of-memory line anywhere in the log, not only at its end (2026-09-29 VM run)', () => {
  /** A worker traceback long enough to push everything above it out of any tail, ending the way the
   *  live run's log did. Frames are illustrative; the last line is what the run printed. */
  const traceback = (frames: number): string[] => [
    'Traceback (most recent call last):',
    ...Array.from({ length: frames }, (_, i) => [
      `  File "/usr/local/lib/python3.12/dist-packages/tensorrt_llm/executor/worker.py", line ${100 + i}, in worker_main`,
      '    raise error',
    ]).flat(),
    'RuntimeError: Executor worker returned error',
  ]
  const budget = [
    '[TRT-LLM] [E] Executor creation failed due to insufficient GPU memory.',
    '_no_capture_init_kv_cache: 3.50 / 0.35',
    '_no_capture_init_extra_resources: 0.34 / 0.10',
  ]

  it.each<[string, string[], Record<string, number> | undefined]>([
    [
      "torch's allocator wording with numbers",
      [
        'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 48.00 MiB. GPU 0 has a total capacity of 7.70 GiB of which 42.69 MiB is free.',
      ],
      { requested_gib: 48 / 1024, free_gib: 42.69 / 1024 },
    ],
    [
      'torch.AcceleratorError (CUDA error: out of memory)',
      ['torch.AcceleratorError: CUDA error: out of memory'],
      undefined,
    ],
    ["the executor's own explanation and budget table", budget, undefined],
    ['the wording the live run reported alongside them', ['The GPU ran out of memory.'], undefined],
  ])(
    '%s, above a 300-frame traceback, is out-of-memory with the line in the excerpt',
    (_label, oomLines, numbers) => {
      const log = [
        '[TRT-LLM] [I] Loading safetensors weights in parallel',
        ...oomLines,
        ...traceback(300),
      ].join('\n')
      const result = tensorrtLlmAdapter.classifyExit(log, 1)
      expect(result.kind).toBe('out-of-memory')
      expect(result.numbers).toEqual(numbers)
      expect(result.excerpt).toContain(oomLines[0])
      expect(result.excerpt).not.toContain('Executor worker returned error')
      expect(result.excerpt).not.toContain('worker.py')
    }
  )

  it('the excerpt is every out-of-memory line once, in log order, capped in count and width', () => {
    const repeated = Array.from(
      { length: 20 },
      (_, i) => `rank ${i}: torch.AcceleratorError: CUDA error: out of memory`
    )
    const wide = `CUDA out of memory. ${'x'.repeat(5_000)}`
    const log = [wide, ...repeated, ...repeated, ...traceback(10)].join('\n')
    const lines = (tensorrtLlmAdapter.classifyExit(log, 1).excerpt ?? '').split('\n')
    expect(lines.length).toBeLessThanOrEqual(8)
    expect(lines[0]?.startsWith('CUDA out of memory.')).toBe(true)
    expect(lines.every((line) => line.length <= 500)).toBe(true)
    expect(new Set(lines).size).toBe(lines.length)
    expect(lines[1]).toBe('rank 0: torch.AcceleratorError: CUDA error: out of memory')
  })
})

describe('classifyExit: review minors on the whole-log classification', () => {
  it('takes the numbers from the last allocation failure, the one the excerpt ends on, not an earlier one', () => {
    const log = [
      'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.00 GiB. GPU 0 has a total capacity of 7.70 GiB of which 3.00 GiB is free.',
      'retrying with a smaller batch',
      'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 48.00 MiB. GPU 0 has a total capacity of 7.70 GiB of which 42.69 MiB is free.',
      'RuntimeError: Executor worker returned error',
    ].join('\n')
    const result = tensorrtLlmAdapter.classifyExit(log, 1)
    expect(result.kind).toBe('out-of-memory')
    expect(result.numbers).toEqual({ requested_gib: 48 / 1024, free_gib: 42.69 / 1024 })
  })

  it.each<[string, string[], Record<string, number>]>([
    [
      'a later failure without a "free" clause: both from the last failure that reports both, never 64 MiB paired with 3 GiB',
      [
        'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.00 GiB. GPU 0 has a total capacity of 7.70 GiB of which 3.00 GiB is free.',
        'RuntimeError: CUDA out of memory. Tried to allocate 64.00 MiB',
      ],
      { requested_gib: 1, free_gib: 3 },
    ],
    [
      'no failure reports both: the last request alone',
      [
        'RuntimeError: CUDA out of memory. Tried to allocate 1.00 GiB',
        'RuntimeError: CUDA out of memory. Tried to allocate 64.00 MiB',
      ],
      { requested_gib: 64 / 1024 },
    ],
    [
      'the last complete failure wins over an earlier complete one',
      [
        'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.00 GiB. GPU 0 has a total capacity of 7.70 GiB of which 3.00 GiB is free.',
        'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 48.00 MiB. GPU 0 has a total capacity of 7.70 GiB of which 42.69 MiB is free.',
      ],
      { requested_gib: 48 / 1024, free_gib: 42.69 / 1024 },
    ],
    [
      'a later "free" line with no request (another rank) never pairs with an earlier request',
      [
        'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 1.00 GiB. GPU 0 has a total capacity of 7.70 GiB of which 3.00 GiB is free.',
        'rank 1: GPU 1 has a total capacity of 7.70 GiB of which 10.00 MiB is free.',
      ],
      { requested_gib: 1, free_gib: 3 },
    ],
  ])('pairs the numbers from one failure: %s', (_label, lines, numbers) => {
    const result = tensorrtLlmAdapter.classifyExit(
      [...lines, 'RuntimeError: Executor worker returned error'].join('\n'),
      1
    )
    expect(result.kind).toBe('out-of-memory')
    expect(result.numbers).toEqual(numbers)
  })

  it.each([
    'Available memory: 3.5 GB',
    '[TRT-LLM] [W] insufficient GPU memory for CUDA graphs, capturing fewer batch sizes',
    'Memory usage when loading weights: 3.21 GiB',
    '[MemUsageChange] Allocated 1.10 GiB for max tokens in paged KV cache (35840).',
    'free_gpu_memory_fraction=0.8, out of 7.70 GiB total',
  ])('keeps %j, a line that only mentions memory, as other', (line) => {
    expect(
      tensorrtLlmAdapter.classifyExit(`${line}\nRuntimeError: Executor worker returned error\n`, 1).kind
    ).toBe('other')
  })

  it('names an unsupported architecture even when an out-of-memory line appears earlier in the log', () => {
    const log = [
      '[TRT-LLM] [W] CUDA out of memory. Tried to allocate 20.00 MiB (handled, retrying)',
      'ValueError: Unknown architecture for AutoModelForCausalLM: ExoticForCausalLM',
    ].join('\n')
    const result = tensorrtLlmAdapter.classifyExit(log, 1)
    expect(result.kind).toBe('unsupported-model')
    expect(result.message).toMatch(/ExoticForCausalLM/)
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

  it('maps the 1.3.0rc29 prompt-length overflow message (llm.py:1578), which no longer carries a query length', () => {
    const body = JSON.stringify({
      object: 'error',
      message: 'The prompt length (72417.0) should not exceed max_num_tokens (69632)',
      type: 'BadRequestError',
      param: null,
      code: 400,
    })
    const mapped = mapTensorrtLlmContextLengthError(400, body)
    expect(mapped?.error.code).toBe('context_length_exceeded')
    expect(mapped?.error.message).toContain('maximum context length is 69632 tokens')
    expect(mapped?.error.message).toContain('resulted in 72417 tokens')
  })

  it('maps the 1.3.0rc29 _deduce_max_tokens overflow (base_worker.py:456), which no longer carries query_token_len', () => {
    const body =
      '`default_max_tokens` (-152) must be greater than 0, `default_max_tokens` (-152) = ' +
      'max_seq_len (8192) - `splited_prompt_len` (8344)'
    const mapped = mapTensorrtLlmContextLengthError(400, body)
    expect(mapped?.error.message).toContain('maximum context length is 8192 tokens')
    expect(mapped?.error.message).toContain('resulted in 8344 tokens')
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

describe('rewriteResponseFor: a reasoning-at-start parser with thinking off (qwen3_5)', () => {
  const qwen35 = family({ reasoning_parser: 'qwen3_5' })

  it('moves the answer the parser filed as reasoning back into content, in a whole reply and a stream delta', () => {
    const rewrite = tensorrtLlmRewriteResponseFor('/v1/chat/completions', { messages: [] }, qwen35)
    expect(rewrite).toBe(tensorrtLlmReasoningIntoContent)
    expect(
      rewrite?.({
        choices: [
          { message: { content: null, reasoning_content: 'Hello!' } },
          { delta: { content: 'A', reasoning_content: 'B' } },
        ],
      })
    ).toEqual({
      choices: [
        { message: { content: 'Hello!', reasoning_content: null } },
        { delta: { content: 'AB', reasoning_content: null } },
      ],
    })
  })

  it('leaves the reply alone when the request turned thinking on, at either place it can say so', () => {
    for (const body of [{ chat_template_kwargs: { enable_thinking: true } }, { enable_thinking: true }]) {
      expect(tensorrtLlmRewriteResponseFor('/v1/chat/completions', body, qwen35)).toBeNull()
    }
  })

  it('never rewrites another parser, another route, or a model with no family', () => {
    expect(
      tensorrtLlmRewriteResponseFor('/v1/chat/completions', {}, family({ reasoning_parser: 'qwen3' }))
    ).toBeNull()
    expect(tensorrtLlmRewriteResponseFor('/v1/completions', {}, qwen35)).toBeNull()
    expect(tensorrtLlmRewriteResponseFor('/v1/chat/completions', {}, null)).toBeNull()
  })

  it('keeps choices that carry no reasoning, and a body with no choices, as they are', () => {
    const untouched = { choices: [{ message: { content: 'hi', reasoning_content: '' } }, null] }
    expect(tensorrtLlmReasoningIntoContent(structuredClone(untouched))).toEqual(untouched)
    expect(tensorrtLlmReasoningIntoContent({ error: 'x' })).toEqual({ error: 'x' })
  })
})

describe('classifyReady: a ready engine that cannot hold one sequence of its context (Windows acceptance, 2026-10-03)', () => {
  const at = (context_length: number) =>
    tensorrtLlmAdapter.validateSettings({ context_length, max_output_tokens: 1024 })
  const profiling =
    '[TRT-LLM] [I] [batchmgr][RANK 0] Max KV cache blocks per sequence: 128 [window size=4096], tokens per block=32, primary blocks=129, secondary blocks=0, max sequence length=4096'
  const final =
    '[TRT-LLM] [I] [batchmgr][RANK 0] Max KV cache blocks per sequence: 7 [window size=224], tokens per block=32, primary blocks=7, secondary blocks=0, max sequence length=224'

  it('refuses as out of memory, with both numbers, when the final allocation holds less than the context', () => {
    const verdict = tensorrtLlmAdapter.classifyReady!(
      `${profiling}\nsomething\n${final}\nINFO: Application startup complete.`,
      at(4096)
    )
    expect(verdict).toMatchObject({
      kind: 'out-of-memory',
      numbers: { kv_capacity_tokens: 224, context_length: 4096 },
      excerpt: final,
    })
    expect(verdict?.message).toContain('224')
    expect(verdict?.message).toContain('4096')
  })

  it('is fit when the last capacity line holds the whole context', () => {
    expect(tensorrtLlmAdapter.classifyReady!(`${final}\n${profiling}`, at(4096))).toBeNull()
  })

  it('is fit when the log carries no capacity line at all (another engine build)', () => {
    expect(tensorrtLlmAdapter.classifyReady!('INFO: Application startup complete.', at(4096))).toBeNull()
  })
})

describe('the further LLM API options and sampling defaults the settings set (owner, change add-vllm-runtime)', () => {
  const optionsOf = (stored: Record<string, unknown>) =>
    parseYaml(
      tensorrtLlmAdapter.buildLaunch(baseContext({ settings: tensorrtLlmAdapter.validateSettings(stored) }))
        .files?.['llm-api-options.yaml'] ?? ''
    ) as Record<string, unknown>

  it('writes nothing for an option left at the engine default', () => {
    const plain = optionsOf({})
    expect(plain).not.toHaveProperty('dtype')
    expect(plain).not.toHaveProperty('disable_overlap_scheduler')
    expect(plain).not.toHaveProperty('scheduler_config')
    expect(plain['kv_cache_config']).not.toHaveProperty('enable_block_reuse')
  })

  it('writes each option the person changed, under the LLM API name', () => {
    expect(
      optionsOf({
        enable_prefix_caching: false,
        overlap_scheduler: false,
        capacity_scheduler_policy: 'max_utilization',
        dtype: 'float16',
      })
    ).toMatchObject({
      kv_cache_config: { enable_block_reuse: false },
      disable_overlap_scheduler: true,
      scheduler_config: { capacity_scheduler_policy: 'MAX_UTILIZATION' },
      dtype: 'float16',
    })
  })

  it('refuses an unknown value with INVALID_ARGUMENT', () => {
    for (const raw of [
      { capacity_scheduler_policy: 'static' },
      { dtype: 'float8' },
      { overlap_scheduler: 'maybe' },
      { default_temperature: 5 },
    ]) {
      expect(() => tensorrtLlmAdapter.validateSettings(raw), JSON.stringify(raw)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' })
      )
    }
  })

  it('restarts the engine for a changed option, not for a sampling default the gateway applies', () => {
    const key = (raw: Record<string, unknown>) =>
      JSON.stringify(tensorrtLlmAdapter.restartKey?.(tensorrtLlmAdapter.validateSettings(raw)))
    for (const changed of [
      { enable_prefix_caching: false },
      { overlap_scheduler: false },
      { capacity_scheduler_policy: 'max_utilization' },
      { dtype: 'bfloat16' },
    ]) {
      expect(key(changed), JSON.stringify(changed)).not.toBe(key({}))
    }
    expect(key({ default_temperature: 0.3 })).toBe(key({}))
  })

  it('writes the sampling defaults into a request that sets none, and leaves the request’s own alone', () => {
    const settings = tensorrtLlmAdapter.validateSettings({ default_temperature: '0.6', default_top_k: 20 })
    expect(
      tensorrtLlmRewriteRequestBody('/v1/chat/completions', { messages: [], temperature: 1 }, settings)
    ).toMatchObject({ temperature: 1, top_k: 20 })
    expect(tensorrtLlmRewriteRequestBody('/v1/completions', { prompt: 'hi' }, settings)).toMatchObject({
      temperature: 0.6,
      top_k: 20,
    })
    const none = tensorrtLlmRewriteRequestBody(
      '/v1/completions',
      { prompt: 'hi' },
      tensorrtLlmAdapter.validateSettings({})
    )
    expect(none).not.toHaveProperty('temperature')
  })
})

describe('tensorrtLlmAdapter.generationProbe', () => {
  it('asks the OpenAI model list for the name and one non-streamed token of chat', () => {
    expect(tensorrtLlmAdapter.generationProbe).toEqual({
      modelsPath: '/v1/models',
      path: '/v1/chat/completions',
      body: { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false },
    })
  })
})
