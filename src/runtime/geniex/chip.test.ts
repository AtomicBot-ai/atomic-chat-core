import { describe, expect, it } from 'vitest'
import { geniexChip, geniexHostPlatform } from './chip.js'

const X_ELITE = 'Snapdragon(R) X Elite - X1E80100 - Qualcomm(R) Oryon(TM) CPU'
const X2_ELITE = 'Snapdragon(R) X2 Elite X2E88100 - Qualcomm(R) Oryon(TM) CPU'
const X_PLUS = 'Snapdragon(R) X Plus - X1P64100 - Qualcomm(R) Oryon(TM) CPU'
const X_PLAIN = 'Snapdragon(R) X - X1-26-100 - Qualcomm(R) Oryon(TM) CPU'
const X2_PLUS = 'Snapdragon(R) X2 Plus X2P76100 - Qualcomm(R) Oryon(TM) CPU'

describe('geniexChip (task 4.3, design D3)', () => {
  it('names the chip by the processor string: X1E is x-elite, X2E is x2-elite', () => {
    expect(geniexChip(X_ELITE)).toBe('x-elite')
    expect(geniexChip(X2_ELITE)).toBe('x2-elite')
    expect(geniexChip('Snapdragon X Elite X1E78100')).toBe('x-elite')
  })

  it('names the smaller parts of each generation by their Hexagon: X Plus and X are x-elite, X2 Plus is x2-elite', () => {
    expect(geniexChip(X_PLUS)).toBe('x-elite')
    expect(geniexChip(X_PLAIN)).toBe('x-elite')
    expect(geniexChip('Snapdragon X Plus X1P42100')).toBe('x-elite')
    expect(geniexChip(X2_PLUS)).toBe('x2-elite')
  })

  it('knows no other Snapdragon, and no other processor', () => {
    expect(geniexChip('Snapdragon(R) 8cx Gen 3 @ 3.0 GHz')).toBeNull()
    expect(geniexChip('Apple M4 Max')).toBeNull()
    expect(geniexChip('13th Gen Intel(R) Core(TM) i7-13700H')).toBeNull()
    expect(geniexChip('')).toBeNull()
    // The letters alone, inside another word, are not a chip.
    expect(geniexChip('AMD Ryzen AI 9 HX1E')).toBeNull()
    expect(geniexChip('Something X1 Pro')).toBeNull()
    expect(geniexChip('Model X1-A')).toBeNull()
  })
})

describe('geniexHostPlatform', () => {
  it('registers on Windows arm64 with a Snapdragon X of either generation', () => {
    expect(geniexHostPlatform({ platform: 'win32', arch: 'arm64', cpuName: X_ELITE })).toEqual({
      platform: 'win-arm64',
      chip: 'x-elite',
    })
    expect(geniexHostPlatform({ platform: 'win32', arch: 'arm64', cpuName: X_PLUS })).toEqual({
      platform: 'win-arm64',
      chip: 'x-elite',
    })
    expect(geniexHostPlatform({ platform: 'win32', arch: 'arm64', cpuName: X2_ELITE })).toEqual({
      platform: 'win-arm64',
      chip: 'x2-elite',
    })
  })

  it('says why not: Windows x64, another arm64 processor, macOS, Linux', () => {
    const CX = 'Snapdragon(R) 8cx Gen 3 @ 3.0 GHz'
    expect(geniexHostPlatform({ platform: 'win32', arch: 'x64', cpuName: X_ELITE })).toEqual({
      platform: null,
      reason: 'GenieX runs on Windows arm64 only, not win32 x64.',
    })
    expect(geniexHostPlatform({ platform: 'win32', arch: 'arm64', cpuName: CX })).toEqual({
      platform: null,
      reason: `GenieX runs on Snapdragon X (X Elite, X Plus, X, X2 Elite, X2 Plus) only; this processor is "${CX}".`,
    })
    expect(geniexHostPlatform({ platform: 'darwin', arch: 'arm64', cpuName: 'Apple M4' })).toMatchObject({
      platform: null,
      reason: 'GenieX runs on Windows arm64 only, not darwin arm64.',
    })
    expect(geniexHostPlatform({ platform: 'linux', arch: 'arm64', cpuName: X_ELITE }).platform).toBeNull()
  })
})
