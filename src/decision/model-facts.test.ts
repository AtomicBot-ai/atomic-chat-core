import { describe, expect, it } from 'vitest'
import {
  decisionFactsOf,
  readDecisionModelFacts,
  UPSTREAM_DECISION_DEFAULT_CTX,
  upstreamCtxSize,
  WHOLE_PROMPT_DECISION_TYPES,
} from './model-facts.js'

describe('decisionFactsOf', () => {
  it('reads an upstream decision GGUF: its type and trained context', () => {
    expect(
      decisionFactsOf({
        'general.architecture': 'qwen35',
        'qwen35.decision.type': 'lev',
        'qwen35.context_length': '262144',
      })
    ).toEqual({ dialect: 'upstream', decisionType: 'lev', contextTrain: 262144 })
  })

  it('leaves the context out when the file has none', () => {
    expect(decisionFactsOf({ 'general.architecture': 'clef', 'clef.decision.type': 'CLEF' })).toEqual({
      dialect: 'upstream',
      decisionType: 'clef',
    })
  })

  it.each([
    // The fork's own GGUFs: the laya architecture, or a decision spec on any architecture.
    [{ 'general.architecture': 'laya' }],
    [{ 'general.architecture': 'qwen35', 'decision.layout': 'semif-letters' }],
    // Not a decision model at all, or nothing read: the fork's load error says what is wrong.
    [{ 'general.architecture': 'qwen35' }],
    [undefined],
  ])('keeps %j with the fork', (metadata) => {
    expect(decisionFactsOf(metadata)).toEqual({ dialect: 'turboquant' })
  })
})

describe('readDecisionModelFacts', () => {
  it('reads the header through the given reader', async () => {
    const read = async () => ({
      metadata: { 'general.architecture': 'modern-bert', 'modern-bert.decision.type': 'laya' },
    })
    expect(await readDecisionModelFacts('/m/julia.gguf', read)).toEqual({
      dialect: 'upstream',
      decisionType: 'laya',
    })
  })

  it('keeps a file it cannot read with the fork', async () => {
    const read = async () => {
      throw new Error('not a GGUF')
    }
    expect(await readDecisionModelFacts('/m/broken.gguf', read)).toEqual({ dialect: 'turboquant' })
    expect(await readDecisionModelFacts('/definitely/missing.gguf')).toEqual({ dialect: 'turboquant' })
  })
})

describe('upstreamCtxSize', () => {
  it('takes the setting, else the default, never past the trained context', () => {
    expect(upstreamCtxSize(0, undefined)).toBe(UPSTREAM_DECISION_DEFAULT_CTX)
    expect(upstreamCtxSize(0, 262144)).toBe(UPSTREAM_DECISION_DEFAULT_CTX)
    expect(upstreamCtxSize(16384, 262144)).toBe(16384)
    expect(upstreamCtxSize(16384, 8192)).toBe(8192)
    expect(upstreamCtxSize(0, 1024)).toBe(1024)
  })
})

describe('WHOLE_PROMPT_DECISION_TYPES', () => {
  it('lists the types upstream reads from the embeddings output', () => {
    expect([...WHOLE_PROMPT_DECISION_TYPES].sort()).toEqual(['clef', 'kev', 'laya'])
  })
})
