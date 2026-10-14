import { describe, expect, it } from 'vitest'
import { defaultSettingValues } from '../../settings/index.js'
import { sglangSettings } from './settings.js'

/** Spec `sglang-runtime`, "Выбор карты и настройки провайдера sglang" (change add-sglang-runtime, task 2.1). */
describe('sglangSettings', () => {
  it('reads the shipped defaults as the adapter wants them: "not set" is null', () => {
    expect(sglangSettings(defaultSettingValues('sglang'))).toEqual({
      gpu_id: null,
      context_length: 8192,
      max_output_tokens: 4096,
      max_running_requests: 1,
      mem_fraction_static: null,
      max_total_tokens: null,
      cuda_graphs: 'auto',
      kv_cache_dtype: 'auto',
      load_timeout_seconds: null,
      enable_prefix_caching: true,
      chunked_prefill_size: null,
      dtype: 'auto',
      seed: null,
      generation: {},
    })
    // Nothing stored at all: one request at a time.
    expect(sglangSettings({}).max_running_requests).toBe(1)
  })

  it('reads every further option and the generation defaults, "" and 0 as not set', () => {
    expect(
      sglangSettings({
        gpu_id: 'GPU-2',
        max_running_requests: '2',
        mem_fraction_static: '0.7',
        max_total_tokens: 16384,
        cuda_graphs: 'off',
        kv_cache_dtype: 'fp8',
        load_timeout_seconds: 900,
        enable_prefix_caching: false,
        chunked_prefill_size: 2048,
        dtype: 'bfloat16',
        seed: 42,
        default_temperature: 0.6,
        default_top_p: '0.95',
        default_top_k: 20,
        default_min_p: '',
      })
    ).toEqual({
      gpu_id: 'GPU-2',
      context_length: 8192,
      max_output_tokens: 4096,
      max_running_requests: 2,
      mem_fraction_static: 0.7,
      max_total_tokens: 16384,
      cuda_graphs: 'off',
      kv_cache_dtype: 'fp8',
      load_timeout_seconds: 900,
      enable_prefix_caching: false,
      chunked_prefill_size: 2048,
      dtype: 'bfloat16',
      seed: 42,
      generation: { temperature: 0.6, top_p: 0.95, top_k: 20 },
    })
  })

  it('lets a load override a stored value and ignores keys that are not this provider’s', () => {
    const settings = sglangSettings(
      { context_length: 8192, max_num_seqs: 4, trust_remote_code: true },
      { context_length: 6144, api_key: 'x' }
    )
    expect(settings.context_length).toBe(6144)
    expect(settings).not.toHaveProperty('max_num_seqs')
    expect(settings).not.toHaveProperty('trust_remote_code')
    expect(settings).not.toHaveProperty('api_key')
  })

  // Scenario "Невалидная настройка": refused with INVALID_ARGUMENT before a container exists.
  it('Невалидная настройка: refuses zero parallel requests with INVALID_ARGUMENT', () => {
    expect(() => sglangSettings({ max_running_requests: 0 })).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message: 'sglang setting max_running_requests must be a whole number from 1 to 256.',
      })
    )
  })

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['a card that is not a UUID', { gpu_id: '0' }, /gpu_id must be an NVIDIA GPU or MIG UUID/],
    [
      'a memory share of 1',
      { mem_fraction_static: 1 },
      /mem_fraction_static must be a number above 0 and below 1/,
    ],
    ['a negative KV limit', { max_total_tokens: -1 }, /max_total_tokens must be a whole number/],
    ['an unknown CUDA graphs mode', { cuda_graphs: 'always' }, /cuda_graphs must be one of auto, on, off/],
    [
      'a KV precision SGLang is not given',
      { kv_cache_dtype: 'fp8_e5m2' },
      /kv_cache_dtype must be one of auto, fp8/,
    ],
    [
      'an output limit as long as the context',
      { max_output_tokens: 8192 },
      /must be less than the context length/,
    ],
    ['a default temperature out of range', { default_temperature: 3 }, /default_temperature must be/],
  ])('refuses %s', (_case, stored, message) => {
    expect(() => sglangSettings(stored)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(message) })
    )
  })
})
