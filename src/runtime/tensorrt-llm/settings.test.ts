import { describe, expect, it } from 'vitest'
import { canonicalizeSettingValues, defaultSettingValues } from '../../settings/index.js'
import { tensorrtLlmSettings } from './settings.js'

const stored = () => canonicalizeSettingValues('tensorrt-llm', defaultSettingValues('tensorrt-llm'))

describe('tensorrtLlmSettings', () => {
  it('turns the stored defaults into the adapter settings: no card chosen, the estimated timeout', () => {
    expect(tensorrtLlmSettings(stored())).toEqual({
      gpu_id: null,
      context_length: 8192,
      max_output_tokens: 4096,
      kv_cache_free_gpu_memory_fraction: 0.9,
      load_timeout_seconds: null,
    })
  })

  it.each<[string, Record<string, unknown>, Partial<ReturnType<typeof tensorrtLlmSettings>>]>([
    ['a blank card', { gpu_id: '   ' }, { gpu_id: null }],
    ['a saved card', { gpu_id: 'GPU-0b6f4f4e-6c1c-3a54' }, { gpu_id: 'GPU-0b6f4f4e-6c1c-3a54' }],
    ['a timeout override', { load_timeout_seconds: 900 }, { load_timeout_seconds: 900 }],
    ['a zero timeout', { load_timeout_seconds: 0 }, { load_timeout_seconds: null }],
    ['a larger context', { context_length: 32768 }, { context_length: 32768 }],
  ])('maps %s', (_label, patch, expected) => {
    expect(tensorrtLlmSettings({ ...stored(), ...patch })).toMatchObject(expected)
  })

  it('lets per-load overrides win over the stored values, and ignores keys that are not its own', () => {
    const settings = tensorrtLlmSettings(stored(), { context_length: 16384, ctx_size: 4, foo: 'bar' })
    expect(settings.context_length).toBe(16384)
    expect(Object.keys(settings).sort()).toEqual([
      'context_length',
      'gpu_id',
      'kv_cache_free_gpu_memory_fraction',
      'load_timeout_seconds',
      'max_output_tokens',
    ])
  })

  it.each<[string, Record<string, unknown>]>([
    ['a context that is not a number', { context_length: 'lots' }],
    ['an output limit as large as the context', { context_length: 4096, max_output_tokens: 4096 }],
    ['a KV fraction of all memory', { kv_cache_free_gpu_memory_fraction: 1 }],
    ['a card that is not a UUID', { gpu_id: '0' }],
    ['a negative timeout', { load_timeout_seconds: -5 }],
  ])('refuses %s with INVALID_ARGUMENT, before any container exists', (_label, patch) => {
    expect(() => tensorrtLlmSettings({ ...stored(), ...patch })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    )
  })
})
