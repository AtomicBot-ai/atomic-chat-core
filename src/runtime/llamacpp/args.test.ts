import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { LlamacppConfig } from '../../contracts/index.js'
import {
  buildLlamaArgs,
  isTurboquantVersion,
  parseBuildNumber,
  parseExtraArgs,
  parseVersionBackend,
  planLlamaArgs,
  withLlamacppDefaults,
} from './args.js'

const base = (): LlamacppConfig =>
  withLlamacppDefaults({
    version_backend: 'v1.0/standard',
    auto_unload: false,
    timeout: 120,
    llamacpp_env: '',
    fit: false,
    fit_ctx: '',
    fit_target: '',
    chat_template: '',
    n_gpu_layers: 100,
    offload_mmproj: true,
    cpu_moe: false,
    n_cpu_moe: 0,
    override_tensor_buffer_t: '',
    ctx_size: 2048,
    threads: 0,
    threads_batch: 0,
    n_predict: 0,
    batch_size: 0,
    ubatch_size: 0,
    device: '',
    split_mode: 'layer',
    main_gpu: 0,
    flash_attn: 'auto',
    cont_batching: false,
    no_mmap: false,
    mlock: false,
    no_kv_offload: false,
    cache_type_k: 'f16',
    cache_type_v: 'f16',
    defrag_thold: 0.1,
    rope_scaling: 'none',
    rope_scale: 1.0,
    rope_freq_base: 0.0,
    rope_freq_scale: 1.0,
    ctx_shift: false,
  })

const input = {
  provider: 'llamacpp-upstream' as const,
  isEmbedding: false,
  modelId: 'm',
  modelPath: '/p',
  port: 8080,
}

describe('parseVersionBackend', () => {
  it.each([
    ['b6325/macos-arm64', 'b6325', 'macos-arm64'],
    [' b6325 / macos-arm64 ', 'b6325', 'macos-arm64'],
    ['﻿b6325/macos-arm64', 'b6325', 'macos-arm64'],
    ['b1/a/b', 'b1', 'a/b'],
  ])('%s → %s + %s', (raw, version, backend) => {
    expect(parseVersionBackend(raw)).toEqual({ version, backend })
  })
  it('throws INVALID_ARGUMENT without a slash', () => {
    expect(() => parseVersionBackend('b1234')).toThrowError(AtomicCoreError)
    try {
      parseVersionBackend('b1234')
    } catch (e) {
      expect((e as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
      expect((e as AtomicCoreError).details).toBe('Invalid version_backend format')
    }
  })
})

describe('parseBuildNumber / isTurboquantVersion', () => {
  it.each([
    ['b6325', 6325],
    ['b10018-1.3.0', 10018],
    ['v1.0', undefined],
    ['turboquant-abc', undefined],
    ['b', undefined],
    ['bx1', undefined],
  ])('parseBuildNumber(%s) = %s', (v, n) => expect(parseBuildNumber(v)).toBe(n))
  it.each([
    ['turboquant-macos-arm64-abc', true],
    ['b10018-1.3.0', true],
    ['b10018-1.3', false],
    ['b10018-1.3.0.1', false],
    ['b10018', false],
    ['bx-1.0.0', false],
    ['v1.0', false],
  ])('isTurboquantVersion(%s) = %s', (v, ok) => expect(isTurboquantVersion(v)).toBe(ok))
})

describe('parseExtraArgs', () => {
  it.each([
    ['', []],
    ['   ', []],
    ['--a b', ['--a', 'b']],
    ['--a "b c"', ['--a', 'b c']],
    ["--a 'b c'", ['--a', 'b c']],
    ['a\\ b', ['a b']],
    ['"a\\"b"', ['a"b']],
    ['"a\\\\b"', ['a\\b']],
    ['"a\\nb"', ['a\\nb']],
    ['""', ['']],
    ['\'x\'"y"', ['xy']],
    ['a\\b', ['a\\b']],
  ])('%j → %j', (raw, expected) => expect(parseExtraArgs(raw)).toEqual(expected))
  it('throws on an unterminated quote', () => {
    expect(() => parseExtraArgs('--a "b')).toThrow('unterminated " quote')
    expect(() => parseExtraArgs("'b")).toThrow("unterminated ' quote")
  })
})

describe('planLlamaArgs', () => {
  it('emits the basic required arguments in order', () => {
    expect(buildLlamaArgs(base(), input)).toEqual([
      '--no-webui',
      '--jinja',
      '-m',
      '/p',
      '-a',
      'm',
      '--port',
      '8080',
      '-ngl',
      '-1',
      '--parallel',
      '1',
      '-kvu',
      '--ctx-size',
      '2048',
      '--fit',
      'off',
    ])
  })

  it('records warnings for skipped gates and sanitised values', () => {
    const cfg = {
      ...base(),
      version_backend: 'b9179/macos-arm64',
      mtp: true,
      cache_type_k: 'turbo3',
      flash_attn: 'on' as const,
    }
    const plan = planLlamaArgs(cfg, input)
    expect(plan.warnings.some((w) => w.includes('predates upstream MTP merge'))).toBe(true)
    expect(plan.warnings.some((w) => w.includes("Cache type 'turbo3'"))).toBe(true)
    expect(plan.argv).toContain('q8_0')
  })

  it('allows turbo* cache types only for the llamacpp provider on a fork tag', () => {
    const cfg = {
      ...base(),
      version_backend: 'b10018-1.3.0/macos-arm64',
      flash_attn: 'on' as const,
      cache_type_k: 'turbo3',
    }
    expect(buildLlamaArgs(cfg, { ...input, provider: 'llamacpp' })).toContain('turbo3')
    expect(buildLlamaArgs(cfg, { ...input, provider: 'llamacpp-upstream' })).not.toContain('turbo3')
    expect(
      buildLlamaArgs({ ...cfg, version_backend: 'b10405/macos-arm64' }, { ...input, provider: 'llamacpp' })
    ).not.toContain('turbo3')
  })

  it('drops the whole extra_args string on an unterminated quote and warns', () => {
    const plan = planLlamaArgs({ ...base(), extra_args: '--x "y' }, input)
    expect(plan.argv.at(-1)).toBe('off')
    expect(plan.warnings.at(-1)).toContain('unterminated')
  })

  it('withLlamacppDefaults fills only the serde-default fields', () => {
    const cfg = base()
    expect(cfg.parallel).toBe(1)
    expect(cfg.concurrent_slots).toBe(8)
    expect(cfg.extra_args).toBe('')
    expect(cfg.ctx_size).toBe(2048)
  })
})
