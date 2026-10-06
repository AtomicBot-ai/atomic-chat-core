import { describe, expect, it } from 'vitest'
import { canonicalizeSettingValues, defaultSettingValues } from '../../settings/index.js'
import { TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION } from './kv-cache.js'
import { tensorrtLlmSettings } from './settings.js'

const stored = () => canonicalizeSettingValues('tensorrt-llm', defaultSettingValues('tensorrt-llm'))

describe('tensorrtLlmSettings', () => {
  it('turns the stored defaults into the adapter settings: no card chosen, the estimated timeout', () => {
    expect(tensorrtLlmSettings(stored())).toEqual({
      gpu_id: null,
      context_length: 8192,
      max_output_tokens: 4096,
      kv_cache_free_gpu_memory_fraction: 0.8,
      max_batch_size: 1,
      kv_cache_max_tokens: null,
      cuda_graphs: 'auto',
      kv_cache_dtype: 'auto',
      load_timeout_seconds: null,
    })
  })

  it('stores the same KV fraction the adapter launches with when nothing is set, so the check and the launch agree', () => {
    // The settings store persists the schema JSON's default; the adapter falls back to its own
    // constant. Both must be one number (docs/decisions/2026-09-29-tensorrt-llm-kv-cache-fraction-0-8-and-oom-read-from-the-whole-log.md).
    expect(stored()['kv_cache_free_gpu_memory_fraction']).toBe(TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION)
    expect(tensorrtLlmSettings({}).kv_cache_free_gpu_memory_fraction).toBe(
      TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION
    )
  })

  it.each<[string, Record<string, unknown>, Partial<ReturnType<typeof tensorrtLlmSettings>>]>([
    ['a blank card', { gpu_id: '   ' }, { gpu_id: null }],
    ['a saved card', { gpu_id: 'GPU-0b6f4f4e-6c1c-3a54' }, { gpu_id: 'GPU-0b6f4f4e-6c1c-3a54' }],
    ['a timeout override', { load_timeout_seconds: 900 }, { load_timeout_seconds: 900 }],
    ['a zero timeout', { load_timeout_seconds: 0 }, { load_timeout_seconds: null }],
    ['a larger context', { context_length: 32768 }, { context_length: 32768 }],
    [
      'a zero KV token limit (the UI default, automatic)',
      { kv_cache_max_tokens: 0 },
      { kv_cache_max_tokens: null },
    ],
    ['a KV token limit', { kv_cache_max_tokens: 40000 }, { kv_cache_max_tokens: 40000 }],
    ['fewer parallel requests', { max_batch_size: 2 }, { max_batch_size: 2 }],
    ['CUDA graphs off', { cuda_graphs: 'off' }, { cuda_graphs: 'off' }],
    ['an FP8 KV cache', { kv_cache_dtype: 'fp8' }, { kv_cache_dtype: 'fp8' }],
  ])('maps %s', (_label, patch, expected) => {
    expect(tensorrtLlmSettings({ ...stored(), ...patch })).toMatchObject(expected)
  })

  it('lets per-load overrides win over the stored values, and ignores keys that are not its own', () => {
    const settings = tensorrtLlmSettings(stored(), { context_length: 16384, ctx_size: 4, foo: 'bar' })
    expect(settings.context_length).toBe(16384)
    expect(Object.keys(settings).sort()).toEqual([
      'context_length',
      'cuda_graphs',
      'gpu_id',
      'kv_cache_dtype',
      'kv_cache_free_gpu_memory_fraction',
      'kv_cache_max_tokens',
      'load_timeout_seconds',
      'max_batch_size',
      'max_output_tokens',
    ])
  })

  it.each<[string, Record<string, unknown>]>([
    ['a context that is not a number', { context_length: 'lots' }],
    ['an output limit as large as the context', { context_length: 4096, max_output_tokens: 4096 }],
    ['a KV fraction of all memory', { kv_cache_free_gpu_memory_fraction: 1 }],
    ['a card that is not a UUID', { gpu_id: '0' }],
    ['a negative timeout', { load_timeout_seconds: -5 }],
    ['zero parallel requests', { max_batch_size: 0 }],
    ['an unknown CUDA graphs mode', { cuda_graphs: 'sometimes' }],
  ])('refuses %s with INVALID_ARGUMENT, before any container exists', (_label, patch) => {
    expect(() => tensorrtLlmSettings({ ...stored(), ...patch })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    )
  })
})
