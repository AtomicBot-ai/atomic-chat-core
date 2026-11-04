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
  it('clamps ctx to the trained context; a window on an architecture with no known pattern counts in full', () => {
    const est = estimateKvCache(meta(1, 1, 128, 1000), 5000)
    expect(est.size).toBe(1000 * est.per_token_size)
    // llama.cpp gives `llama` no sliding layers: the safe side is every layer at the full window.
    const swa = estimateKvCache(meta(1, 1, 128, 1000, { 'llama.attention.sliding_window': '100' }), undefined)
    expect(swa.size).toBe(1000 * swa.per_token_size)
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

  it('counts a sliding layer named by a per-layer pattern at its window, the attention layers only', () => {
    const m = lfm2('[0, 8, 8]', {
      'lfm2.block_count': '3',
      'lfm2.attention.sliding_window': '1024',
      'lfm2.attention.sliding_window_pattern': '[false, true, false]',
    })
    const est = estimateKvCache(m, 4096)
    const perLayer = 8 * 128 * 2
    expect(est.per_token_size).toBe(2 * perLayer)
    // Layer 1 slides: 1024 + 512 (one micro-batch) cells; layer 2 attends to all 4096.
    expect(est.size).toBe(4096 * perLayer + 1536 * perLayer)
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

/**
 * Sliding-window models as llama.cpp b12019 allocates them (`src/llama-kv-cache-iswa.cpp:73`): global
 * layers at the whole window, sliding ones at `pad256(n_swa × sequences + n_ubatch)`.
 */
describe('estimateKvCache — sliding-window layers', () => {
  // Gemma 3 12B: 48 blocks, 8 KV heads of 256, a 1024-token window, five sliding layers to one global.
  const gemma3 = (extra: Record<string, string> = {}) => ({
    'general.architecture': 'gemma3',
    'gemma3.block_count': '48',
    'gemma3.context_length': '131072',
    'gemma3.attention.head_count': '16',
    'gemma3.attention.head_count_kv': '8',
    'gemma3.attention.key_length': '256',
    'gemma3.attention.value_length': '256',
    'gemma3.attention.sliding_window': '1024',
    ...extra,
  })
  const LAYER = 8 * (256 + 256) * 2

  it('counts Gemma 3 by its built-in 5:1 pattern, not as the average of the two windows', () => {
    const est = estimateKvCache(gemma3(), 32_768)
    // 8 global layers × 32768 cells + 40 sliding layers × (1024 + 512) cells.
    expect(est.size).toBe(32_768 * 8 * LAYER + 1536 * 40 * LAYER)
    expect(est.per_token_size).toBe(48 * LAYER)
    const averaged = Math.floor((32_768 * 48 * LAYER + 1024 * 48 * LAYER) / 2)
    expect(est.size * 2.5).toBeLessThan(averaged)
  })

  it('gives each sliding layer a window per sequence of a unified cache, and one micro-batch', () => {
    const one = estimateKvCache(gemma3(), 32_768)
    const two = estimateKvCache(gemma3(), 32_768, 'f16', 'f16', { nSeq: 2 })
    expect(two.size - one.size).toBe(40 * LAYER * 1024)
    const smallBatch = estimateKvCache(gemma3(), 32_768, 'f16', 'f16', { nUbatch: 256 })
    expect(smallBatch.size).toBe(32_768 * 8 * LAYER + 1280 * 40 * LAYER)
    // Never more than the window itself.
    expect(estimateKvCache(gemma3(), 1024).size).toBe(1024 * 48 * LAYER)
  })

  it('reads the per-layer pattern, its own head sizes and the layers that share another’s KV (Gemma 4)', () => {
    const gemma4 = {
      'general.architecture': 'gemma4',
      'gemma4.block_count': '6',
      'gemma4.context_length': '131072',
      'gemma4.attention.head_count': '8',
      'gemma4.attention.head_count_kv': '[4, 4, 1, 4, 4, 1]',
      'gemma4.attention.key_length': '512',
      'gemma4.attention.value_length': '512',
      'gemma4.attention.key_length_swa': '256',
      'gemma4.attention.value_length_swa': '256',
      'gemma4.attention.sliding_window': '512',
      'gemma4.attention.sliding_window_pattern': '[true, true, false, true, true, false]',
      'gemma4.attention.shared_kv_layers': '3',
    }
    const est = estimateKvCache(gemma4, 8192)
    // Layers 0-2 hold KV: two sliding (4 heads of 256) at 512 + 512 cells, one global (1 head of 512).
    const sliding = 4 * (256 + 256) * 2
    const global = 1 * (512 + 512) * 2
    expect(est.size).toBe(8192 * global + 1024 * 2 * sliding)
  })

  it('takes the period from the GGUF when it names one', () => {
    const est = estimateKvCache(gemma3({ 'gemma3.attention.sliding_window_pattern': '2' }), 32_768)
    expect(est.size).toBe(32_768 * 24 * LAYER + 1536 * 24 * LAYER)
  })
})
