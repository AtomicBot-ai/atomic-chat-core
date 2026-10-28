import { describe, expect, it } from 'vitest'
import { geniexChip, geniexHostPlatform } from './chip.js'

const X_ELITE = 'Snapdragon(R) X Elite - X1E80100 - Qualcomm(R) Oryon(TM) CPU'
const X2_ELITE = 'Snapdragon(R) X2 Elite X2E88100 - Qualcomm(R) Oryon(TM) CPU'
const X_PLUS = 'Snapdragon(R) X Plus - X1P64100 - Qualcomm(R) Oryon(TM) CPU'

describe('geniexChip (task 4.3, design D3)', () => {
  it('names the chip by the processor string: X1E is x-elite, X2E is x2-elite', () => {
    expect(geniexChip(X_ELITE)).toBe('x-elite')
    expect(geniexChip(X2_ELITE)).toBe('x2-elite')
    expect(geniexChip('Snapdragon X Elite X1E78100')).toBe('x-elite')
  })

  it('knows no other Snapdragon, and no other processor', () => {
    expect(geniexChip(X_PLUS)).toBeNull()
    expect(geniexChip('Snapdragon(R) 8cx Gen 3 @ 3.0 GHz')).toBeNull()
    expect(geniexChip('Apple M4 Max')).toBeNull()
    expect(geniexChip('13th Gen Intel(R) Core(TM) i7-13700H')).toBeNull()
    expect(geniexChip('')).toBeNull()
    // The letters alone, inside another word, are not a chip.
    expect(geniexChip('AMD Ryzen AI 9 HX1E')).toBeNull()
  })
})

describe('geniexHostPlatform', () => {
  it('registers on Windows arm64 with a Snapdragon X Elite or X2 Elite only', () => {
    expect(geniexHostPlatform({ platform: 'win32', arch: 'arm64', cpuName: X_ELITE })).toEqual({
      platform: 'win-arm64',
      chip: 'x-elite',
    })
    expect(geniexHostPlatform({ platform: 'win32', arch: 'arm64', cpuName: X2_ELITE })).toEqual({
      platform: 'win-arm64',
      chip: 'x2-elite',
    })
  })

  it('says why not: Windows x64, another arm64 processor, macOS, Linux', () => {
    expect(geniexHostPlatform({ platform: 'win32', arch: 'x64', cpuName: X_ELITE })).toEqual({
      platform: null,
      reason: 'GenieX runs on Windows arm64 only, not win32 x64.',
    })
    expect(geniexHostPlatform({ platform: 'win32', arch: 'arm64', cpuName: X_PLUS })).toEqual({
      platform: null,
      reason: `GenieX runs on Snapdragon X Elite and X2 Elite only; this processor is "${X_PLUS}".`,
    })
    expect(geniexHostPlatform({ platform: 'darwin', arch: 'arm64', cpuName: 'Apple M4' })).toMatchObject({
      platform: null,
      reason: 'GenieX runs on Windows arm64 only, not darwin arm64.',
    })
    expect(geniexHostPlatform({ platform: 'linux', arch: 'arm64', cpuName: X_ELITE }).platform).toBeNull()
  })
})
