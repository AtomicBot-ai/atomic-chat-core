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
        max_num_seqs: 8,
        kv_cache_max_tokens: 0,
        cuda_graphs: 'auto',
        kv_cache_dtype: 'auto',
        load_timeout_seconds: 0,
      })
    ).toEqual({
      gpu_id: null,
      context_length: 8192,
      max_output_tokens: 4096,
      max_num_seqs: 8,
      kv_cache_max_tokens: null,
      cuda_graphs: 'auto',
      kv_cache_dtype: 'auto',
      load_timeout_seconds: null,
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
  ])('refuses %s with INVALID_ARGUMENT', (_label, stored) => {
    expect(() => vllmSettings(stored)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })
})
