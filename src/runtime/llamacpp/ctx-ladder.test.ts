import { describe, expect, it } from 'vitest'
import { DEFAULT_CTX_LEN, computeNextCtxLen } from './ctx-ladder.js'

describe('computeNextCtxLen', () => {
  it('climbs the app’s steps: anything small to 8192, then 32768, then half again', () => {
    expect(computeNextCtxLen(512)).toBe(8192)
    expect(computeNextCtxLen(8191)).toBe(8192)
    expect(computeNextCtxLen(8192)).toBe(32768)
    expect(computeNextCtxLen(32767)).toBe(32768)
    expect(computeNextCtxLen(32768)).toBe(49152)
    expect(computeNextCtxLen(49152)).toBe(73728)
  })

  it('never goes past what the model was trained for', () => {
    expect(computeNextCtxLen(4096, 6000)).toBe(6000)
    expect(computeNextCtxLen(32768, 40000)).toBe(40000)
  })

  it('returns the cap itself once there is nowhere left to climb, so the caller can stop', () => {
    // The runtime reads `next <= current` as "at max"; without this the ladder would reload the
    // model at the same size and the next request would ask again.
    expect(computeNextCtxLen(8192, 8192)).toBe(8192)
    expect(computeNextCtxLen(40000, 8192)).toBe(8192)
  })

  it('ignores a cap that says nothing', () => {
    expect(computeNextCtxLen(4096, 0)).toBe(8192)
    expect(computeNextCtxLen(4096, -1)).toBe(8192)
    expect(computeNextCtxLen(4096, undefined)).toBe(8192)
  })

  it('rounds the 1.5x step, because a context size is a whole number of tokens', () => {
    expect(computeNextCtxLen(32769)).toBe(49154)
    expect(Number.isInteger(computeNextCtxLen(40001))).toBe(true)
  })

  it('has one default, the same one the app settled on', () => {
    expect(DEFAULT_CTX_LEN).toBe(16384)
  })
})
