import { describe, expect, it } from 'vitest'
import {
  TENSORRT_LLM_CUDA_GRAPHS_MIN_VRAM_BYTES,
  TENSORRT_LLM_CUDA_GRAPHS_RESERVE_BYTES,
  tensorrtLlmCudaGraphsOn,
} from './cuda-graphs.js'

const GiB = 1024 ** 3

describe('tensorrtLlmCudaGraphsOn', () => {
  it('follows an explicit on or off whatever the card and its room', () => {
    expect(tensorrtLlmCudaGraphsOn('on', 8 * GiB, 0)).toBe(true)
    expect(tensorrtLlmCudaGraphsOn('off', 80 * GiB, 60 * GiB)).toBe(false)
  })

  it('under auto, needs a card of at least 12 GiB, or a unified-memory one', () => {
    expect(TENSORRT_LLM_CUDA_GRAPHS_MIN_VRAM_BYTES).toBe(12 * GiB)
    expect(tensorrtLlmCudaGraphsOn('auto', 8 * GiB)).toBe(false)
    expect(tensorrtLlmCudaGraphsOn('auto', 12 * GiB)).toBe(true)
    expect(tensorrtLlmCudaGraphsOn('auto', null)).toBe(true)
  })

  it('under auto, needs room for the graphs when the room is known: a big card holding a big model has the size but not the room', () => {
    expect(TENSORRT_LLM_CUDA_GRAPHS_RESERVE_BYTES).toBe(5 * GiB)
    expect(tensorrtLlmCudaGraphsOn('auto', 24 * GiB, 0.17 * GiB)).toBe(false)
    expect(tensorrtLlmCudaGraphsOn('auto', 24 * GiB, 5 * GiB)).toBe(true)
    expect(tensorrtLlmCudaGraphsOn('auto', null, 4 * GiB)).toBe(false)
  })
})
