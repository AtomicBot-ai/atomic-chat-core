import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIT_CTX,
  DEFAULT_FIT_TARGET_MIB,
  FIT_COMPUTE_RESERVE_BYTES,
  UNIFIED_MEMORY_LLAMA_SHARE,
  metalDevice,
  unifiedMemoryFitTargetMiB,
} from './fit-margin.js'

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
