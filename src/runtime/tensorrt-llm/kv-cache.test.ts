import { describe, expect, it } from 'vitest'
import {
  TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
  TENSORRT_LLM_UNIFIED_KV_CONTEXTS,
  tensorrtLlmUnifiedKvMaxTokens,
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
})
