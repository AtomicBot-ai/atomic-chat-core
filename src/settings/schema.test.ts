import { describe, expect, it } from 'vitest'
import type { LocalProviderId } from '../contracts/index.js'
import {
  CANONICAL_VALUE_TYPES,
  LOCAL_PROVIDER_IDS,
  canonicalizeSettingValue,
  canonicalizeSettingValues,
  defaultSettingValues,
  settingsSchema,
} from './schema.js'

const UPSTREAM_KEYS = [
  'version_backend',
  'mtp',
  'dflash',
  'dflash_block_size',
  'concurrent_mode',
  'concurrent_slots',
  'expose_metrics',
  'parallel',
  'cont_batching',
  'llamacpp_env',
  'reasoning_preserve',
  'extra_args',
  'timeout',
  'fit',
  'fit_target',
  'fit_ctx',
  'threads',
  'threads_batch',
  'ctx_shift',
  'n_predict',
  'ubatch_size',
  'device',
  'split_mode',
  'main_gpu',
  'flash_attn',
  'no_mmap',
  'mlock',
  'cache_type_k',
  'cache_type_v',
  'defrag_thold',
  'rope_scaling',
  'rope_scale',
  'rope_freq_base',
  'rope_freq_scale',
]

describe('settingsSchema', () => {
  it.each<[LocalProviderId, number]>([
    ['llamacpp-upstream', 34],
    ['llamacpp', 31],
    ['mlx', 11],
    ['foundation-models', 0],
  ])('%s has %i descriptors (PLAN.md §8.1)', (provider, count) => {
    expect(settingsSchema(provider)).toHaveLength(count)
  })

  it('keeps the app key order for the upstream provider and drops the three DFlash/MTP keys for turboquant', () => {
    expect(settingsSchema('llamacpp-upstream').map((d) => d.key)).toEqual(UPSTREAM_KEYS)
    expect(settingsSchema('llamacpp').map((d) => d.key)).toEqual(
      UPSTREAM_KEYS.filter((k) => !['mtp', 'dflash', 'dflash_block_size'].includes(k))
    )
  })

  it('returns a deep copy so callers may mutate options/value', () => {
    const first = settingsSchema('llamacpp-upstream')
    first[0]!.controllerProps['options'] = [{ value: 'x', name: 'x' }]
    first[0]!.controllerProps.value = 'x'
    expect(settingsSchema('llamacpp-upstream')[0]!.controllerProps).toEqual({
      value: 'none',
      options: [],
      recommended: '',
    })
  })

  it('every descriptor carries a known controllerType and a value', () => {
    for (const provider of LOCAL_PROVIDER_IDS) {
      for (const d of settingsSchema(provider)) {
        expect(['checkbox', 'input', 'dropdown', 'slider']).toContain(d.controllerType)
        expect(d.controllerProps).toHaveProperty('value')
        expect(typeof d.title).toBe('string')
        expect(typeof d.description).toBe('string')
      }
    }
  })
})

describe('defaultSettingValues', () => {
  it('returns controllerProps.value verbatim — including the string "1800" timeout and numeric fit_ctx', () => {
    const upstream = defaultSettingValues('llamacpp-upstream')
    expect(upstream).toMatchObject({
      version_backend: 'none',
      mtp: false,
      dflash: false,
      dflash_block_size: 16,
      timeout: '1800',
      fit: true,
      fit_target: '1024',
      fit_ctx: 4096,
      threads: -1,
      cache_type_k: 'f16',
      cache_type_v: 'f16',
      defrag_thold: 0.1,
      rope_scale: 1.0,
    })
    expect(Object.keys(upstream)).toEqual(UPSTREAM_KEYS)
    expect(defaultSettingValues('llamacpp')).toMatchObject({ cache_type_k: 'turbo3', cache_type_v: 'turbo3' })
    expect(defaultSettingValues('llamacpp')).not.toHaveProperty('mtp')
    expect(defaultSettingValues('mlx')).toEqual({
      version_backend: 'detecting...',
      dflash_enabled: false,
      block_size: 16,
      mtp_enabled: false,
      mtp_block_size: 4,
      eagle3_enabled: false,
      eagle3_block_size: 0,
      kv_quant_scheme: 'off',
      kv_bits: 3.5,
      timeout: 600,
      auto_unload: true,
    })
    expect(defaultSettingValues('foundation-models')).toEqual({})
  })

  it('returns a fresh object each call', () => {
    const a = defaultSettingValues('mlx')
    a['timeout'] = 1
    expect(defaultSettingValues('mlx')['timeout']).toBe(600)
  })
})

describe('canonicalizeSettingValue', () => {
  it.each<['boolean' | 'number' | 'string', unknown, unknown]>([
    ['boolean', true, true],
    ['boolean', 'true', true],
    ['boolean', ' FALSE ', false],
    ['boolean', '1', true],
    ['boolean', 0, false],
    ['boolean', 'maybe', 'maybe'],
    ['boolean', 2, 2],
    ['number', 12, 12],
    ['number', '1800', 1800],
    ['number', ' 3.5 ', 3.5],
    ['number', '-1', -1],
    ['number', '', ''],
    ['number', 'abc', 'abc'],
    ['number', true, 1],
    ['number', null, null],
    ['string', 'x', 'x'],
    ['string', 4096, '4096'],
    ['string', false, 'false'],
    ['string', null, null],
  ])('%s: %j -> %j', (type, input, expected) => {
    expect(canonicalizeSettingValue(type, input)).toBe(expected)
  })
})

describe('canonicalizeSettingValues', () => {
  it('coerces stringly UI values to the Rust LlamacppConfig types and keeps fit_ctx/fit_target strings', () => {
    expect(
      canonicalizeSettingValues('llamacpp-upstream', {
        timeout: '1800',
        fit: 'false',
        mtp: 'true',
        threads: '-1',
        defrag_thold: '0.1',
        fit_ctx: 4096,
        fit_target: '1024',
        ctx_size: '8192',
        n_gpu_layers: '100',
        flash_attn: 'auto',
        extra_args: '',
      })
    ).toEqual({
      timeout: 1800,
      fit: false,
      mtp: true,
      threads: -1,
      defrag_thold: 0.1,
      fit_ctx: '4096',
      fit_target: '1024',
      ctx_size: 8192,
      n_gpu_layers: 100,
      flash_attn: 'auto',
      extra_args: '',
    })
  })

  it('passes unknown keys through untouched and never mutates the input', () => {
    const input = { my_custom: '1', timeout: '5' }
    const out = canonicalizeSettingValues('llamacpp', input)
    expect(out).toEqual({ my_custom: '1', timeout: 5 })
    expect(input).toEqual({ my_custom: '1', timeout: '5' })
  })

  it('applies the MLX table (kv_bits "3.5" was the ATO-466 bug)', () => {
    expect(
      canonicalizeSettingValues('mlx', { kv_bits: '3.5', block_size: '16', dflash_enabled: 'true' })
    ).toEqual({
      kv_bits: 3.5,
      block_size: 16,
      dflash_enabled: true,
    })
    expect(canonicalizeSettingValues('foundation-models', { timeout: '300', other: 'x' })).toEqual({
      timeout: 300,
      other: 'x',
    })
  })

  it('canonicalized defaults have the wire type of every key in the table', () => {
    for (const provider of LOCAL_PROVIDER_IDS) {
      const canonical = canonicalizeSettingValues(provider, defaultSettingValues(provider))
      for (const [key, value] of Object.entries(canonical)) {
        const type = CANONICAL_VALUE_TYPES[provider][key]
        expect(type, `${provider}.${key} must be in the type table`).toBeDefined()
        expect(typeof value, `${provider}.${key}`).toBe(type)
      }
    }
    expect(
      canonicalizeSettingValues('llamacpp-upstream', defaultSettingValues('llamacpp-upstream'))
    ).toMatchObject({
      timeout: 1800,
      fit_ctx: '4096',
      fit_target: '1024',
    })
  })
})
