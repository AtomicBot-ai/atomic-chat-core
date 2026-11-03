import { describe, expect, it } from 'vitest'
import { DEFAULT_N_PREDICT, promptCacheRamMiB, resolveNPredict } from './generation-limits.js'

const GiB = 2 ** 30

describe('resolveNPredict', () => {
  it('is 16384 when automatic, never above the window the load runs with', () => {
    expect(resolveNPredict(0, undefined)).toBe(DEFAULT_N_PREDICT)
    expect(resolveNPredict(0, 65_536)).toBe(16_384)
    expect(resolveNPredict(0, 4096)).toBe(4096)
  })

  it("keeps the user's own cap, and -1 or any negative as no limit", () => {
    expect(resolveNPredict(2048, 4096)).toBe(2048)
    expect(resolveNPredict(100_000, 4096)).toBe(100_000)
    expect(resolveNPredict(-1, 4096)).toBe(-1)
    expect(resolveNPredict(-5, undefined)).toBe(-1)
    expect(resolveNPredict(Number.NaN, undefined)).toBe(-1)
  })
})

describe('promptCacheRamMiB', () => {
  it("narrows llama.cpp's 8 GiB host prompt cache up to 16 GiB of RAM, and only there", () => {
    expect(promptCacheRamMiB(8 * GiB)).toBe(1024)
    expect(promptCacheRamMiB(4 * GiB)).toBe(1024)
    expect(promptCacheRamMiB(12 * GiB)).toBe(2048)
    expect(promptCacheRamMiB(16 * GiB)).toBe(2048)
    expect(promptCacheRamMiB(16 * GiB + 1)).toBeUndefined()
    expect(promptCacheRamMiB(64 * GiB)).toBeUndefined()
    expect(promptCacheRamMiB(undefined)).toBeUndefined()
    expect(promptCacheRamMiB(0)).toBeUndefined()
  })
})
