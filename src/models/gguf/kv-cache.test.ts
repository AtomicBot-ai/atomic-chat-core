import { describe, expect, it } from 'vitest'
import { estimateKvCache, ggufContextLength, KV_CACHE_ERRORS, kvCacheBitsPerElement } from './kv-cache.js'

const meta = (
  layers: number,
  heads: number,
  headDim: number,
  ctx: number,
  extra: Record<string, string> = {}
) => ({
  'general.architecture': 'llama',
  'llama.block_count': String(layers),
  'llama.attention.head_count': String(heads),
  'llama.attention.head_count_kv': String(heads),
  'llama.attention.key_length': String(headDim),
  'llama.attention.value_length': String(headDim),
  'llama.context_length': String(ctx),
  ...extra,
})

describe('kvCacheBitsPerElement', () => {
  it('unknown or absent reads as fp16, block quants carry scale bits', () => {
    expect(kvCacheBitsPerElement(undefined)).toBe(16)
    expect(kvCacheBitsPerElement('something-new')).toBe(16)
    expect(kvCacheBitsPerElement('F16')).toBe(16)
    expect(kvCacheBitsPerElement('q8_0')).toBe(8.5)
    expect(kvCacheBitsPerElement('q4_0')).toBe(4.5)
    expect(kvCacheBitsPerElement('turbo3')).toBe(3)
    expect(kvCacheBitsPerElement(' f32 ')).toBe(32)
  })
})

describe('estimateKvCache', () => {
  it('fp16 matches two bytes per element', () => {
    const est = estimateKvCache(meta(32, 8, 128, 4096), 4096)
    expect(est.per_token_size).toBe(32 * 8 * 256 * 2)
    expect(est.size).toBe(4096 * est.per_token_size)
  })
  it('turbo3 is three sixteenths of fp16', () => {
    const fp16 = estimateKvCache(meta(32, 8, 128, 4096), 4096)
    const turbo = estimateKvCache(meta(32, 8, 128, 4096), 4096, 'turbo3', 'turbo3')
    expect(turbo.per_token_size * 16).toBe(fp16.per_token_size * 3)
  })
  it('keys and values may differ', () => {
    expect(estimateKvCache(meta(1, 1, 128, 1), 1, 'f16', 'q8_0').per_token_size).toBe(392)
  })
  it('clamps ctx to the trained context and averages with a sliding window', () => {
    const est = estimateKvCache(meta(1, 1, 128, 1000), 5000)
    expect(est.size).toBe(1000 * est.per_token_size)
    const swa = estimateKvCache(meta(1, 1, 128, 1000, { 'llama.attention.sliding_window': '100' }), undefined)
    expect(swa.size).toBe(Math.floor((1000 * swa.per_token_size + 100 * swa.per_token_size) / 2))
  })
  it('falls back to embedding_length / head_count for head_dim', () => {
    const m = meta(2, 4, 0, 10, { 'llama.embedding_length': '512' })
    expect(estimateKvCache(m, 10).per_token_size).toBe(Math.ceil((2 * 4 * (128 * 16 + 128 * 16)) / 8))
  })
  it('uses head_count when head_count_kv is absent or zero', () => {
    const m = { ...meta(1, 3, 8, 10), 'llama.attention.head_count_kv': '0' }
    expect(estimateKvCache(m, 10).per_token_size).toBe(Math.ceil((1 * 3 * (8 * 16 + 8 * 16)) / 8))
  })
  it.each([
    [{}, KV_CACHE_ERRORS.architectureNotFound],
    [{ 'general.architecture': 'x' }, KV_CACHE_ERRORS.blockCountInvalid],
    [{ 'general.architecture': 'x', 'x.block_count': '0' }, KV_CACHE_ERRORS.blockCountInvalid],
    [{ 'general.architecture': 'x', 'x.block_count': '1' }, KV_CACHE_ERRORS.headCountInvalid],
    [
      { 'general.architecture': 'x', 'x.block_count': '1', 'x.attention.head_count': '1' },
      KV_CACHE_ERRORS.embeddingLengthInvalid,
    ],
    [
      {
        'general.architecture': 'x',
        'x.block_count': '1',
        'x.attention.head_count': '1',
        'x.attention.key_length': '8',
        'x.attention.value_length': '8',
      },
      KV_CACHE_ERRORS.contextLengthInvalid,
    ],
  ])('rejects %j with %s', (m, msg) => {
    expect(() => estimateKvCache(m, undefined)).toThrow(msg)
  })
})

describe('ggufContextLength', () => {
  it('reads the positive trained context or nothing', () => {
    expect(ggufContextLength(meta(1, 1, 1, 8192))).toBe(8192)
    expect(
      ggufContextLength({ 'general.architecture': 'llama', 'llama.context_length': '0' })
    ).toBeUndefined()
    expect(ggufContextLength({})).toBeUndefined()
  })
})

describe('estimateKvCache — per-layer head_count_kv', () => {
  // LiquidAI/LFM2.5-2.6B-GGUF: 30 blocks, attention in 8 of them with 8 KV heads of 64 (2048 / 32).
  const LFM25_KV_HEADS = [
    0, 0, 8, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 8, 0, 0, 8, 0, 0,
  ]
  const lfm2 = (headCountKv: string, extra: Record<string, string> = {}) => ({
    'general.architecture': 'lfm2',
    'lfm2.block_count': '30',
    'lfm2.context_length': '131072',
    'lfm2.embedding_length': '2048',
    'lfm2.attention.head_count': '32',
    'lfm2.attention.head_count_kv': headCountKv,
    ...extra,
  })

  it('counts only the layers that attend, as llama.cpp allocates them: 16 KiB a token for LFM2.5-2.6B', () => {
    const est = estimateKvCache(lfm2(`[${LFM25_KV_HEADS.join(', ')}]`), 131_072)
    expect(est.per_token_size).toBe(8 * 8 * (64 + 64) * 2)
    expect(est.per_token_size).toBe(16 * 1024)
    expect(est.size).toBe(2 * 2 ** 30)
  })

  it('gives each layer its own head count', () => {
    const m = { ...meta(3, 8, 128, 4096), 'llama.attention.head_count_kv': '[2, 4, 0]' }
    expect(estimateKvCache(m, 4096).per_token_size).toBe(6 * (128 + 128) * 2)
  })

  it('reads a uniform array exactly like the scalar it spells out', () => {
    const scalar = estimateKvCache({ ...meta(4, 32, 128, 8192), 'llama.attention.head_count_kv': '8' }, 8192)
    const array = estimateKvCache(
      { ...meta(4, 32, 128, 8192), 'llama.attention.head_count_kv': '[8, 8, 8, 8]' },
      8192
    )
    expect(array).toEqual(scalar)
  })

  it('keeps averaging a sliding window over the attention layers it counts', () => {
    const m = lfm2('[0, 8, 0]', { 'lfm2.block_count': '3', 'lfm2.attention.sliding_window': '1024' })
    const est = estimateKvCache(m, 4096)
    expect(est.per_token_size).toBe(8 * 128 * 2)
    expect(est.size).toBe(Math.floor((4096 * est.per_token_size + 1024 * est.per_token_size) / 2))
  })

  it.each([
    ['the reader’s placeholder', '<Array of type Int32 with 30 elements, data skipped>'],
    ['an array in which no layer has KV heads', '[0, 0, 0]'],
    ['a malformed array', '[8, x, 8]'],
    ['an empty array', '[]'],
  ])('falls back to every block with head_count heads for %s, as before', (_name, raw) => {
    expect(estimateKvCache(lfm2(raw), 4096).per_token_size).toBe(30 * 32 * (64 + 64) * 2)
  })
})
