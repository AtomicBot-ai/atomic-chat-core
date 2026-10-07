import { describe, expect, it } from 'vitest'
import {
  EMBEDDING_CONTENT_PARTS_MIN_BUILD,
  EMBEDDING_DEFAULT_CTX,
  EMBEDDING_GEMMA2_MIN_BUILD,
  embeddingCtxSize,
  embeddingFactsOf,
  embeddingMinBuild,
  embeddingPooling,
  notAnEmbeddingModel,
  readEmbeddingModelFacts,
} from './model-facts.js'

describe('embeddingFactsOf', () => {
  it('reads the headers of the catalog models', () => {
    // As read from the real files (unsloth/embeddinggemma-2-GGUF, Qwen/Qwen3-Embedding-0.6B-GGUF, ggml-org/bge-m3).
    expect(
      embeddingFactsOf({
        'general.architecture': 'gemma-embedding2',
        'gemma-embedding2.pooling_type': '1',
        'gemma-embedding2.context_length': '262144',
      })
    ).toEqual({
      arch: 'gemma-embedding2',
      embedding: true,
      decision: false,
      pooling: 'mean',
      contextTrain: 262144,
    })
    expect(
      embeddingFactsOf({
        'general.architecture': 'qwen3',
        'qwen3.pooling_type': '3',
        'qwen3.context_length': '32768',
      })
    ).toMatchObject({ arch: 'qwen3', embedding: true, pooling: 'last', contextTrain: 32768 })
    expect(embeddingFactsOf({ 'general.architecture': 'bert', 'bert.pooling_type': '2' })).toMatchObject({
      embedding: true,
      pooling: 'cls',
    })
  })

  it('tells chat, decision and reranker files apart', () => {
    expect(
      embeddingFactsOf({ 'general.architecture': 'llama', 'llama.context_length': '8192' })
    ).toMatchObject({
      embedding: false,
      decision: false,
    })
    expect(
      embeddingFactsOf({ 'general.architecture': 'modern-bert', 'modern-bert.decision.type': 'laya' })
    ).toMatchObject({ decision: true, embedding: false })
    expect(embeddingFactsOf({ 'general.architecture': 'bert', 'bert.pooling_type': '4' })).toMatchObject({
      pooling: 'rank',
    })
  })

  it('survives a header with nothing in it', () => {
    expect(embeddingFactsOf(undefined)).toEqual({ arch: '', embedding: false, decision: false })
    expect(embeddingFactsOf({ 'general.architecture': 'bert', 'bert.context_length': 'x' })).toEqual({
      arch: 'bert',
      embedding: true,
      decision: false,
    })
  })
})

describe('readEmbeddingModelFacts', () => {
  it('reads the header, and answers undefined for a file it cannot read', async () => {
    const read = async () => ({
      metadata: { 'general.architecture': 'nomic-bert', 'nomic-bert.pooling_type': '1' },
    })
    expect(await readEmbeddingModelFacts('/m.gguf', read)).toMatchObject({
      arch: 'nomic-bert',
      pooling: 'mean',
    })
    expect(
      await readEmbeddingModelFacts('/m.gguf', async () => {
        throw new Error('not a GGUF')
      })
    ).toBeUndefined()
  })
})

describe('notAnEmbeddingModel', () => {
  it.each([
    [{ arch: 'bert', embedding: true, decision: false, pooling: 'mean' as const }, undefined],
    [{ arch: 'modern-bert', embedding: false, decision: true }, 'decision model'],
    [{ arch: 'bert', embedding: true, decision: false, pooling: 'rank' as const }, 'reranker'],
    [{ arch: 'llama', embedding: false, decision: false }, 'text generation'],
  ])('%j → %s', (facts, says) => {
    const why = notAnEmbeddingModel(facts)
    if (says === undefined) expect(why).toBeUndefined()
    else expect(why).toContain(says)
  })
})

describe('embeddingMinBuild', () => {
  it.each([
    ['bert', false, 0],
    ['bert', true, EMBEDDING_CONTENT_PARTS_MIN_BUILD],
    ['gemma-embedding2', false, EMBEDDING_GEMMA2_MIN_BUILD],
    ['gemma-embedding2', true, EMBEDDING_GEMMA2_MIN_BUILD],
  ])('%s with projector %s → b%i', (arch, projector, build) =>
    expect(embeddingMinBuild(arch, projector)).toBe(build)
  )
})

describe('embeddingCtxSize', () => {
  it.each([
    [0, undefined, EMBEDDING_DEFAULT_CTX],
    [0, 512, 512],
    [4096, 262144, 4096],
    [8192, 2048, 2048],
    [-3, undefined, EMBEDDING_DEFAULT_CTX],
  ])('setting %i, trained %s → %i', (setting, trained, ctx) =>
    expect(embeddingCtxSize(setting, trained)).toBe(ctx)
  )
})

describe('embeddingPooling', () => {
  it.each([
    ['cls', 'mean', 'cls'],
    ['', 'last', undefined],
    ['', 'none', 'mean'],
    ['', undefined, 'mean'],
  ] as const)('setting %j, GGUF %s → %s', (setting, gguf, pooling) =>
    expect(embeddingPooling(setting, gguf === undefined ? {} : { pooling: gguf })).toBe(pooling)
  )
})
