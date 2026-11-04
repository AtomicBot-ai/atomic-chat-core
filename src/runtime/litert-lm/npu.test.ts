import { describe, expect, it } from 'vitest'
import { liteRtNpuGeneration } from './npu.js'

describe('liteRtNpuGeneration', () => {
  it.each([
    // Lunar Lake: Core Ultra 200V.
    ['Intel(R) Core(TM) Ultra 7 258V', 'intel-lnl'],
    ['Intel(R) Core(TM) Ultra 5 226V', 'intel-lnl'],
    ['Intel(R) Core(TM) Ultra 9 288V', 'intel-lnl'],
    // Panther Lake: Core Ultra series 3, with and without the X.
    ['Intel(R) Core(TM) Ultra X9 388H', 'intel-ptl'],
    ['Intel(R) Core(TM) Ultra 7 365', 'intel-ptl'],
    ['Intel(R) Core(TM) Ultra 5 325', 'intel-ptl'],
    // Arrow Lake and Meteor Lake have an NPU LiteRT-LM has no files for.
    ['Intel(R) Core(TM) Ultra 9 285H', null],
    ['Intel(R) Core(TM) Ultra 7 265K', null],
    ['Intel(R) Core(TM) Ultra 7 155H', null],
    ['Intel(R) Core(TM) i7-13700H', null],
    ['AMD Ryzen AI 9 HX 370 w/ Radeon 890M', null],
    ['Apple M4 Max', null],
    ['', null],
  ])('%j → %j', (cpu, generation) => {
    expect(liteRtNpuGeneration(cpu)).toBe(generation)
  })
})
