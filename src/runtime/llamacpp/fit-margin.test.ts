import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIT_CTX,
  DEFAULT_FIT_TARGET_MIB,
  FIT_COMPUTE_RESERVE_BYTES,
  FIT_CTX_ALIGN,
  SMALL_UNIFIED_MEMORY_CTX_CAP,
  UNIFIED_MEMORY_LLAMA_SHARE,
  metalDevice,
  smallUnifiedMemoryCtxCeiling,
  unifiedMemoryFitTargetMiB,
} from './fit-margin.js'
import type { SmallUnifiedMemoryCtxInput } from './fit-margin.js'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

// owao/Nanbeige4.2-3B-GGUF IQ4_XS as llama.cpp b10809 loads it: 2288.67 MiB on Metal, and a KV
// buffer of 14608 MiB at 84992 tokens (176 KiB per token, fp16).
const NANBEIGE_WEIGHTS = 2_403_808_096
const NANBEIGE_MIN_KV = DEFAULT_FIT_CTX * 176 * 1024
// `MTL0: Apple M4 Pro (18186 MiB, 18185 MiB free)` on a 24 GiB Mac running macOS 26.
const M4_PRO_24_FREE = 18185 * MiB

describe('metalDevice', () => {
  it('picks the Metal device out of an Apple silicon build’s list', () => {
    const devices = [
      { id: 'MTL0', name: 'Apple M4 Pro', mem: 18186, free: 18185 },
      { id: 'BLAS', name: 'Accelerate', mem: 0, free: 0 },
    ]
    expect(metalDevice(devices)).toEqual(devices[0])
  })

  it.each([
    ['no devices at all', []],
    ['only CUDA and Vulkan', [{ id: 'CUDA0', name: 'RTX 4090', mem: 24564, free: 23875 }]],
    ['a Metal device that reports nothing free', [{ id: 'MTL0', name: 'Apple M1', mem: 0, free: 0 }]],
    ['an id that only starts like Metal', [{ id: 'MTLX', name: 'odd', mem: 100, free: 100 }]],
  ])('finds none in %s', (_name, devices) => {
    expect(metalDevice(devices)).toBeUndefined()
  })
})

describe('unifiedMemoryFitTargetMiB', () => {
  it('leaves llama.cpp half of a 24 GiB Mac for a small model instead of the whole working set', () => {
    const margin = unifiedMemoryFitTargetMiB({
      totalMemoryBytes: 24 * GiB,
      gpuFreeBytes: M4_PRO_24_FREE,
      weightsBytes: NANBEIGE_WEIGHTS,
      minContextKvBytes: NANBEIGE_MIN_KV,
    })
    expect(margin).toBe(18185 - 12 * 1024)
    expect(M4_PRO_24_FREE - margin! * MiB).toBe(24 * GiB * UNIFIED_MEMORY_LLAMA_SHARE)
  })

  it.each([
    // RAM, Metal free, weights, min-context KV, expected margin (MiB) — budget = max(RAM/2, needs)
    ['18 GiB, small model: half of RAM', 18 * GiB, 13_640 * MiB, 2.25 * GiB, 0.7 * GiB, 13_640 - 9 * 1024],
    ['64 GiB, small model: half of RAM', 64 * GiB, 49_152 * MiB, 3 * GiB, 0.5 * GiB, 49_152 - 32 * 1024],
    ['8 GiB, small model: half of RAM', 8 * GiB, 5_461 * MiB, 1 * GiB, 0.25 * GiB, 5_461 - 4 * 1024],
    [
      '18 GiB, 8.5 GiB model: the budget grows to hold it',
      18 * GiB,
      13_640 * MiB,
      8.5 * GiB,
      0.5 * GiB,
      13_640 - 10 * 1024,
    ],
  ])('%s', (_name, ram, free, weights, kv, expected) => {
    expect(
      unifiedMemoryFitTargetMiB({
        totalMemoryBytes: ram,
        gpuFreeBytes: free,
        weightsBytes: weights,
        minContextKvBytes: kv,
      })
    ).toBe(expected)
  })

  it('keeps llama.cpp’s default when the model needs more than half of RAM, so no layer leaves the GPU', () => {
    expect(
      unifiedMemoryFitTargetMiB({
        totalMemoryBytes: 18 * GiB,
        gpuFreeBytes: 13_640 * MiB,
        weightsBytes: 12 * GiB,
        minContextKvBytes: 0.5 * GiB,
      })
    ).toBeUndefined()
  })

  it('keeps the default when the widened margin would not beat it', () => {
    // 8 GiB: 5461 MiB free, needs 3 GiB + 0.69 GiB + 1 GiB → 657 MiB left, under the 1024 default.
    expect(
      unifiedMemoryFitTargetMiB({
        totalMemoryBytes: 8 * GiB,
        gpuFreeBytes: 5_461 * MiB,
        weightsBytes: 3 * GiB,
        minContextKvBytes: NANBEIGE_MIN_KV,
      })
    ).toBeUndefined()
  })

  it('reserves room for compute buffers beside the weights and the minimum context', () => {
    // Needs = weights + KV + reserve lands exactly on half of 24 GiB: the margin is unchanged.
    const weights = 12 * GiB - FIT_COMPUTE_RESERVE_BYTES - GiB
    const at = (w: number) =>
      unifiedMemoryFitTargetMiB({
        totalMemoryBytes: 24 * GiB,
        gpuFreeBytes: M4_PRO_24_FREE,
        weightsBytes: w,
        minContextKvBytes: GiB,
      })
    expect(at(weights)).toBe(18185 - 12 * 1024)
    // One more GiB of weights moves the budget up by one GiB.
    expect(at(weights + GiB)).toBe(18185 - 13 * 1024)
  })

  it.each([
    ['RAM is unknown', 0, M4_PRO_24_FREE],
    ['the GPU reports nothing free', 24 * GiB, 0],
  ])('stays out of the way when %s', (_name, ram, free) => {
    expect(
      unifiedMemoryFitTargetMiB({
        totalMemoryBytes: ram,
        gpuFreeBytes: free,
        weightsBytes: 1,
        minContextKvBytes: 0,
      })
    ).toBeUndefined()
  })

  it('only ever answers a margin wider than llama.cpp’s default, which the args builder would drop', () => {
    for (const ram of [8, 16, 18, 24, 32, 36, 64, 128])
      for (const weights of [0.5, 2, 4, 8, 16, 32, 64]) {
        const margin = unifiedMemoryFitTargetMiB({
          totalMemoryBytes: ram * GiB,
          gpuFreeBytes: ram * 0.75 * GiB,
          weightsBytes: weights * GiB,
          minContextKvBytes: NANBEIGE_MIN_KV,
        })
        if (margin !== undefined) expect(margin).toBeGreaterThan(DEFAULT_FIT_TARGET_MIB)
      }
  })
})

describe('smallUnifiedMemoryCtxCeiling', () => {
  // LiquidAI/LFM2.5-2.6B-GGUF Q4_K_M, the catalog's pick for 8 GB Macs: 1674455040 bytes, a 131072
  // trained context, 30 blocks of which 8 attend (8 KV heads of 64): the core's estimate reads its
  // per-layer `head_count_kv` and gets llama.cpp's 16 KiB of fp16 KV per token.
  const LFM25_WEIGHTS = 1_674_455_040
  const LFM25_KV_ESTIMATE = (ctx: number) => ctx * 16 * 1024
  // `MTL0: Apple M3 (5461 MiB, 5461 MiB free)` on an 8 GiB Mac; the margin leaves llama.cpp 4096 MiB.
  const EIGHT_GIB_BUDGET = 4096 * MiB

  const lfm25 = (over: Partial<SmallUnifiedMemoryCtxInput> = {}): SmallUnifiedMemoryCtxInput => ({
    totalMemoryBytes: 8 * GiB,
    budgetBytes: EIGHT_GIB_BUDGET,
    weightsBytes: LFM25_WEIGHTS,
    trainedCtx: 131_072,
    minCtx: DEFAULT_FIT_CTX,
    kvBytesAt: LFM25_KV_ESTIMATE,
    ...over,
  })

  it('caps LFM2.5 2.6B on an 8 GiB Mac at 32768 tokens where fit would take all 128K', () => {
    // 4096 − 1597 − 1024 MiB leave 1475 MiB; 32768 tokens at 16 KiB need 512 MiB of it. llama.cpp
    // then holds 512 MiB of KV cache instead of the 2048 MiB of 131072 tokens.
    expect(SMALL_UNIFIED_MEMORY_CTX_CAP).toBe(32_768)
    expect(smallUnifiedMemoryCtxCeiling(lfm25())).toBe(SMALL_UNIFIED_MEMORY_CTX_CAP)
  })

  it('narrows a model whose estimate counts every block to what that estimate fits', () => {
    // LFM2.5-2.6B as an estimate blind to its per-layer heads counted it: 30 blocks × 32 heads,
    // 240 KiB a token. 1475 MiB hold 6293 of those, so 6144 by whole 256s.
    expect(smallUnifiedMemoryCtxCeiling(lfm25({ kvBytesAt: (ctx) => ctx * 240 * 1024 }))).toBe(6144)
  })

  it('gives a model with a small KV cache the whole ceiling', () => {
    // A 0.7 GiB model at 12 KiB per token fits 32768 tokens with room to spare.
    expect(
      smallUnifiedMemoryCtxCeiling(
        lfm25({ weightsBytes: 0.7 * GiB, trainedCtx: 131_072, kvBytesAt: (ctx) => ctx * 12 * 1024 })
      )
    ).toBe(SMALL_UNIFIED_MEMORY_CTX_CAP)
  })

  it('narrows a dense model to what the budget holds with the compute reserve', () => {
    // meta-llama/Llama-3.2-3B Q4_K_M: 2019377696 bytes, 112 KiB of KV per token.
    expect(
      smallUnifiedMemoryCtxCeiling(
        lfm25({ weightsBytes: 2_019_377_696, kvBytesAt: (ctx) => ctx * 112 * 1024 })
      )
    ).toBe(10_240)
  })

  it.each([16, 18, 24, 64, 128])('leaves a %i GiB Mac to fit', (ram) => {
    expect(smallUnifiedMemoryCtxCeiling(lfm25({ totalMemoryBytes: ram * GiB }))).toBeUndefined()
  })

  it.each([
    ['RAM is unknown', { totalMemoryBytes: 0 }],
    ['the trained context is unknown', { trainedCtx: undefined }],
    ['the KV cache cannot be estimated', { kvBytesAt: () => undefined }],
    ['the weights fill the budget', { weightsBytes: 3.5 * GiB }],
    // Phi-3.5-mini: 2.2 GiB of weights and no GQA, 384 KiB per token — not even 4096 tokens fit.
    [
      'not even the fit floor fits',
      { weightsBytes: 2.2 * GiB, kvBytesAt: (ctx: number) => ctx * 384 * 1024 },
    ],
    ['the user’s floor is above the ceiling', { minCtx: 65_536 }],
  ])('caps nothing when %s', (_name, over) => {
    expect(smallUnifiedMemoryCtxCeiling(lfm25(over as Partial<SmallUnifiedMemoryCtxInput>))).toBeUndefined()
  })

  it('caps nothing for a model trained for no more than fits, since fit can pick no wider', () => {
    expect(smallUnifiedMemoryCtxCeiling(lfm25({ trainedCtx: 4096 }))).toBeUndefined()
    expect(
      smallUnifiedMemoryCtxCeiling(lfm25({ trainedCtx: 10_000, kvBytesAt: (ctx) => ctx * 12 * 1024 }))
    ).toBeUndefined()
  })

  it('narrows a short trained window that does not fit, first onto the 256 grid', () => {
    const asked: number[] = []
    const ceiling = smallUnifiedMemoryCtxCeiling(
      lfm25({
        trainedCtx: 10_000,
        kvBytesAt: (ctx) => {
          asked.push(ctx)
          return ctx <= 9_000 ? 0 : 2 * GiB
        },
      })
    )
    expect(asked.slice(0, 3)).toEqual([10_000, 9_984, 9_728])
    expect(ceiling).toBe(8_960)
  })

  it('only ever answers a whole number of 256s between the fit floor and the ceiling', () => {
    for (const ram of [4, 8, 12])
      for (const weights of [0.25, 0.5, 1, 2, 3])
        for (const kib of [6, 16, 64, 112, 144, 240, 384]) {
          const ceiling = smallUnifiedMemoryCtxCeiling(
            lfm25({
              totalMemoryBytes: ram * GiB,
              budgetBytes: (ram * GiB) / 2,
              weightsBytes: weights * GiB,
              kvBytesAt: (ctx) => ctx * kib * 1024,
            })
          )
          if (ceiling === undefined) continue
          expect(ceiling % FIT_CTX_ALIGN).toBe(0)
          expect(ceiling).toBeGreaterThanOrEqual(DEFAULT_FIT_CTX)
          expect(ceiling).toBeLessThanOrEqual(SMALL_UNIFIED_MEMORY_CTX_CAP)
          expect(weights * GiB + ceiling * kib * 1024 + FIT_COMPUTE_RESERVE_BYTES).toBeLessThanOrEqual(
            (ram * GiB) / 2
          )
        }
  })
})
