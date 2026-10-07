import { describe, expect, it } from 'vitest'
import { vllmSettings } from './settings.js'

/** Spec `vllm-runtime`, "Выбор карты и настройки провайдера vllm" (change add-vllm-runtime, task 3.1). */
describe('vllmSettings', () => {
  it('reads the stored defaults as the adapter wants them: "not set" is null', () => {
    expect(
      vllmSettings({
        gpu_id: '',
        context_length: 8192,
        max_output_tokens: 4096,
        max_num_seqs: 1,
        kv_cache_memory_gib: 0,
        gpu_memory_utilization: 0,
        cuda_graphs: 'auto',
        kv_cache_dtype: 'auto',
        load_timeout_seconds: 0,
      })
    ).toEqual({
      gpu_id: null,
      context_length: 8192,
      max_output_tokens: 4096,
      max_num_seqs: 1,
      kv_cache_memory_gib: null,
      gpu_memory_utilization: null,
      cuda_graphs: 'auto',
      kv_cache_dtype: 'auto',
      load_timeout_seconds: null,
      max_num_batched_tokens: null,
      enable_prefix_caching: true,
      cpu_offload_gb: 0,
      dtype: 'auto',
      seed: null,
      async_scheduling: false,
      generation: {},
    })
    // Nothing stored at all: one request at a time.
    expect(vllmSettings({}).max_num_seqs).toBe(1)
  })

  it('reads every further option, the generation defaults as vLLM names them, "" and 0 as not set', () => {
    expect(
      vllmSettings({
        max_num_batched_tokens: 2048,
        enable_prefix_caching: false,
        cpu_offload_gb: 1.5,
        dtype: 'float16',
        seed: 42,
        async_scheduling: true,
        default_temperature: 0.6,
        default_top_p: '0.95',
        default_top_k: 20,
        default_min_p: 0,
        default_repetition_penalty: '',
      })
    ).toMatchObject({
      max_num_batched_tokens: 2048,
      enable_prefix_caching: false,
      cpu_offload_gb: 1.5,
      dtype: 'float16',
      seed: 42,
      async_scheduling: true,
      generation: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
    })
  })

  it('lets a load override a stored value and ignores keys that are not this provider’s', () => {
    expect(
      vllmSettings(
        { context_length: 8192, kv_cache_free_gpu_memory_fraction: 0.5 },
        { context_length: 16384 }
      )
    ).toMatchObject({ context_length: 16384 })
    expect(vllmSettings({ trust_remote_code: true, enable_log_requests: true })).not.toHaveProperty(
      'trust_remote_code'
    )
  })

  it.each([
    ['Невалидная настройка: zero concurrent requests', { max_num_seqs: 0 }],
    ['a context below 512 tokens', { context_length: 100 }],
    ['an output cap not below the context', { context_length: 4096, max_output_tokens: 4096 }],
    ['an unknown CUDA graphs mode', { cuda_graphs: 'sometimes' }],
    ['an unknown KV cache precision', { kv_cache_dtype: 'int4' }],
    ['a card that is not an NVIDIA UUID', { gpu_id: 'card 1' }],
    ['a load timeout above an hour', { load_timeout_seconds: 7200 }],
    ['a negative CPU offload', { cpu_offload_gb: -1 }],
    ['an unknown weight precision', { dtype: 'float8' }],
    ['a temperature above 2', { default_temperature: 3 }],
    ['a top_p of 0', { default_top_p: 0 }],
    ['a repetition penalty of 0', { default_repetition_penalty: 0 }],
    ['prefix caching that is not a yes or a no', { enable_prefix_caching: 'maybe' }],
  ])('refuses %s with INVALID_ARGUMENT', (_label, stored) => {
    expect(() => vllmSettings(stored)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })

  it('a KV cache size and a memory share, when set, are kept; out of range is INVALID_ARGUMENT', () => {
    const set = vllmSettings({ kv_cache_memory_gib: 1.5, gpu_memory_utilization: 0.6 })
    expect(set.kv_cache_memory_gib).toBe(1.5)
    expect(set.gpu_memory_utilization).toBe(0.6)
    expect(() => vllmSettings({ gpu_memory_utilization: 1.2 })).toThrow(/gpu_memory_utilization/)
    expect(() => vllmSettings({ kv_cache_memory_gib: -1 })).toThrow(/kv_cache_memory_gib/)
  })
})
