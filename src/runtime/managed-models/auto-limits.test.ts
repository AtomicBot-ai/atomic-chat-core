import { describe, expect, it } from 'vitest'
import { autoLimitCandidates, checkpointMaxContext, fitAutoLimits } from './auto-limits.js'

const auto = { contextAuto: true, sequencesAuto: true, context: 0, sequences: 0, maxOutputTokens: 4096 }

describe('autoLimitCandidates', () => {
  it('prefers the window: 64K with two requests, then 32K with two, 32K alone, down to the old 8K alone', () => {
    expect(autoLimitCandidates({ ...auto, trainedContext: undefined })).toEqual([
      [65_536, 2],
      [32_768, 2],
      [32_768, 1],
      [16_384, 2],
      [16_384, 1],
      [8192, 2],
      [8192, 1],
    ])
  })

  it('stays within the trained context, and above the output cap', () => {
    expect(autoLimitCandidates({ ...auto, trainedContext: 20_000 }).map(([c]) => c)).toEqual([
      16_384, 16_384, 8192, 8192,
    ])
    expect(autoLimitCandidates({ ...auto, trainedContext: 2048 })).toEqual([
      [2048, 2],
      [2048, 1],
    ])
    expect(
      autoLimitCandidates({ ...auto, maxOutputTokens: 16_384, trainedContext: undefined }).map(([c]) => c)
    ).toEqual([65_536, 32_768, 32_768])
  })

  it('keeps a pinned half as it is', () => {
    expect(
      autoLimitCandidates({ ...auto, contextAuto: false, context: 12_000, trainedContext: 4096 })
    ).toEqual([
      [12_000, 2],
      [12_000, 1],
    ])
    expect(
      autoLimitCandidates({ ...auto, sequencesAuto: false, sequences: 4, trainedContext: undefined })
    ).toEqual([
      [65_536, 4],
      [32_768, 4],
      [16_384, 4],
      [8192, 4],
    ])
  })
})

describe('fitAutoLimits', () => {
  it('takes the first pair the memory rule passes, else the smallest', () => {
    const upTo = (tokens: number) => (context: number, sequences: number) => context * sequences <= tokens
    expect(fitAutoLimits({ ...auto, trainedContext: undefined, fits: upTo(200_000) })).toEqual({
      context: 65_536,
      sequences: 2,
    })
    expect(fitAutoLimits({ ...auto, trainedContext: undefined, fits: upTo(40_000) })).toEqual({
      context: 32_768,
      sequences: 1,
    })
    expect(fitAutoLimits({ ...auto, trainedContext: undefined, fits: () => false })).toEqual({
      context: 8192,
      sequences: 1,
    })
  })
})

describe('checkpointMaxContext', () => {
  it("reads the smallest of vLLM's keys, from the text config of a multimodal checkpoint", () => {
    expect(checkpointMaxContext({ max_position_embeddings: 40_960 })).toBe(40_960)
    expect(checkpointMaxContext({ max_position_embeddings: 131_072, seq_length: 32_768 })).toBe(32_768)
    expect(checkpointMaxContext({ text_config: { max_position_embeddings: 262_144 } })).toBe(262_144)
    expect(checkpointMaxContext({ architectures: ['X'] })).toBeUndefined()
    expect(checkpointMaxContext({ max_position_embeddings: '4096' })).toBeUndefined()
  })
})
