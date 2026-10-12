import { describe, expect, it } from 'vitest'
import {
  TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_TOKENS_PER_BLOCK,
  TENSORRT_LLM_UNIFIED_KV_CONTEXTS,
  tensorrtLlmKvTokens,
  tensorrtLlmUnifiedKvMaxTokens,
  tensorrtLlmWholeBlockTokens,
} from './kv-cache.js'

describe('TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION', () => {
  it("is 0.8, not trtllm-serve's own 0.9: 0.9 ran an 8 GB card out of memory in the live run", () => {
    expect(TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION).toBe(0.8)
  })
})

describe('tensorrtLlmUnifiedKvMaxTokens', () => {
  it.each([
    [512, 1024],
    [8192, 16384],
    [1_048_576, 2_097_152],
  ])('context %i -> %i tokens: one full-context request plus a concurrent one', (context, tokens) => {
    expect(tensorrtLlmUnifiedKvMaxTokens(context)).toBe(tokens)
    expect(TENSORRT_LLM_UNIFIED_KV_CONTEXTS).toBe(2)
  })

  it('gives each of the two contexts whole blocks of its own', () => {
    expect(tensorrtLlmUnifiedKvMaxTokens(2096)).toBe(2 * 2112)
  })
})

describe('tensorrtLlmWholeBlockTokens', () => {
  it.each([
    [2096, 2112],
    [2048, 2048],
    [1, 32],
    [30000, 30016],
  ])(
    '%i tokens -> %i: the engine rounds max_tokens down to whole blocks, so ask for the block above',
    (tokens, rounded) => {
      expect(TENSORRT_LLM_TOKENS_PER_BLOCK).toBe(32)
      expect(tensorrtLlmWholeBlockTokens(tokens)).toBe(rounded)
    }
  )
})

describe('tensorrtLlmKvTokens', () => {
  it('counts whole blocks per sequence before multiplying: 2096 at batch 1 is 66 blocks, not 65', () => {
    expect(tensorrtLlmKvTokens(2096, 1)).toBe(2112)
  })

  it('two 2096-token sequences need 132 blocks, one more than 2 × 2096 tokens rounds to', () => {
    expect(tensorrtLlmKvTokens(2096, 2)).toBe(132 * 32)
  })

  it('leaves a block-aligned context exactly as it was', () => {
    expect(tensorrtLlmKvTokens(8192, 4)).toBe(32768)
  })
})
