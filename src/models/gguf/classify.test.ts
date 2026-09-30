import { describe, expect, it } from 'vitest'
import {
  classifyProjector,
  DECISION_GGUF_ARCHITECTURES,
  effectiveCtxSize,
  isDecisionGguf,
  NON_TEXT_GGUF_ARCHITECTURES,
  hasEmbeddedMtp,
  isEmbeddingGguf,
  isMtpCapable,
  matchesMtpLoadFailure,
} from './classify.js'

describe('matchesMtpLoadFailure', () => {
  it.each([
    ['failed to create MTP context', true],
    ["model doesn't contain MTP layers", true],
    ['model doesnt contain MTP layers', true],
    ['context type MTP requested but unavailable', true],
    ['out of memory', false],
    ['', false],
  ])('%j → %s', (t, e) => expect(matchesMtpLoadFailure(t)).toBe(e))
})

describe('hasEmbeddedMtp / isMtpCapable', () => {
  it('needs a qwen35 arch with nextn layers below block_count', () => {
    expect(
      hasEmbeddedMtp({
        'general.architecture': 'qwen35',
        'qwen35.block_count': '40',
        'qwen35.nextn_predict_layers': '1',
      })
    ).toBe(true)
    expect(
      hasEmbeddedMtp({
        'general.architecture': 'qwen35moe',
        'qwen35moe.block_count': '2',
        'qwen35moe.nextn_predict_layers': '2',
      })
    ).toBe(false)
    expect(
      hasEmbeddedMtp({
        'general.architecture': 'llama',
        'llama.block_count': '40',
        'llama.nextn_predict_layers': '1',
      })
    ).toBe(false)
    expect(hasEmbeddedMtp({ 'general.architecture': 'qwen35', 'qwen35.block_count': '40' })).toBe(false)
    expect(hasEmbeddedMtp(null)).toBe(false)
  })
  it('isMtpCapable is true with a draft path regardless of metadata', () => {
    expect(isMtpCapable(null, '/draft.gguf')).toBe(true)
    expect(isMtpCapable({ 'general.architecture': 'llama' }, '')).toBe(false)
  })
})

describe('isEmbeddingGguf', () => {
  it.each([
    [{ 'general.architecture': 'bert' }, true],
    [{ 'general.architecture': ' Nomic-BERT ' }, true],
    [{ 'general.architecture': 'qwen3', 'qwen3.pooling_type': '2' }, true],
    [{ 'general.architecture': 'qwen3', 'qwen3.pooling_type': '0' }, false],
    [{ 'general.architecture': 'qwen3', 'qwen3.classifier.output_labels': '[a, b]' }, true],
    [{ 'general.architecture': 'llama' }, false],
    [{}, false],
    [undefined, false],
  ])('%j → %s', (m, e) => expect(isEmbeddingGguf(m)).toBe(e))
})

describe('isDecisionGguf', () => {
  it.each([
    [{ 'general.architecture': 'laya' }, true],
    [{ 'general.architecture': ' LAYA ' }, true],
    // A stamped Arbiter / JevK5 stays a Qwen underneath; the decision spec's mirror key gives it away.
    [{ 'general.architecture': 'qwen35', 'decision.layout': 'semif-letters' }, true],
    [{ 'general.architecture': 'modern-bert', 'decision.layout': 'laya' }, true],
    [{ 'general.architecture': 'qwen35', 'decision.layout': '  ' }, false],
    // A reader that keeps typed values may hand the key over as a non-string.
    [{ 'general.architecture': 7, 'decision.layout': 1 }, true],
    [{ 'general.architecture': 'qwen35', 'decision.layout': null }, false],
    [{ 'general.architecture': 'qwen35' }, false],
    [{ 'general.architecture': 'bert' }, false],
    [{}, false],
    [null, false],
  ])('%j → %s', (m, e) => expect(isDecisionGguf(m)).toBe(e))

  it('keeps laya out of the non-text list, which would load it as an embedding model', () => {
    expect(DECISION_GGUF_ARCHITECTURES.has('laya')).toBe(true)
    expect(NON_TEXT_GGUF_ARCHITECTURES.has('laya')).toBe(false)
  })

  it('wins over the embedding rules', () => {
    expect(isEmbeddingGguf({ 'general.architecture': 'laya', 'laya.pooling_type': '1' })).toBe(false)
    expect(isEmbeddingGguf({ 'general.architecture': 'bert', 'decision.layout': 'laya' })).toBe(false)
    expect(
      isEmbeddingGguf({ 'general.architecture': 'qwen3', 'qwen3.pooling_type': '2', 'decision.layout': 'x' })
    ).toBe(false)
  })
})

describe('effectiveCtxSize', () => {
  it('clamps only when both sides are finite positive numbers', () => {
    expect(effectiveCtxSize(16384, 2048)).toBe(2048)
    expect(effectiveCtxSize(1024, 2048)).toBe(1024)
    expect(effectiveCtxSize(16384, undefined)).toBe(16384)
    expect(effectiveCtxSize(16384, 0)).toBe(16384)
    expect(effectiveCtxSize(undefined, 2048)).toBeUndefined()
    expect(effectiveCtxSize(NaN, 2048)).toBeNaN()
  })
})

describe('classifyProjector', () => {
  it('reads clip.* keys and falls back to vision', () => {
    expect(classifyProjector({ 'clip.has_vision_encoder': 'true' })).toEqual({ vision: true, audio: false })
    expect(classifyProjector({ 'clip.has_audio_encoder': 'TRUE' })).toEqual({ vision: false, audio: true })
    expect(
      classifyProjector({ 'clip.audio.projector_type': 'whisper', 'clip.vision.projector_type': 'x' })
    ).toEqual({
      vision: true,
      audio: true,
    })
    expect(classifyProjector({ 'general.architecture': 'clip' })).toEqual({ vision: true, audio: false })
    expect(classifyProjector(undefined)).toEqual({ vision: true, audio: false })
  })
})
