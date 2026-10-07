import { describe, expect, it } from 'vitest'
import { AtomicCoreError, DEFAULT_EMBEDDING_SETTINGS } from '../contracts/index.js'
import { embeddingSettingsOf, parseEmbeddingSettingsPatch } from './embedding.js'

describe('embeddingSettingsOf', () => {
  it('fills defaults and keeps every usable value, coercing strings a hand edit left', () => {
    expect(embeddingSettingsOf(undefined)).toEqual(DEFAULT_EMBEDDING_SETTINGS)
    expect(
      embeddingSettingsOf({
        enabled: 'true',
        model_path: ' embedding/models/bge-m3/bge-m3-q8_0.gguf ',
        ctx_size: '8192',
        pooling: 'CLS',
        image_max_tokens: 280,
        unknown: 1,
      })
    ).toEqual({
      ...DEFAULT_EMBEDDING_SETTINGS,
      enabled: true,
      model_path: 'embedding/models/bge-m3/bge-m3-q8_0.gguf',
      ctx_size: 8192,
      pooling: 'cls',
      image_max_tokens: 280,
    })
  })

  it('keeps the default for a value it cannot use', () => {
    expect(
      embeddingSettingsOf({
        pooling: 'rank',
        ctx_size: -1,
        startup_timeout_secs: 0,
        enabled: 'yes',
        threads: 1.5,
      })
    ).toEqual(DEFAULT_EMBEDDING_SETTINGS)
    expect(embeddingSettingsOf([1, 2])).toEqual(DEFAULT_EMBEDDING_SETTINGS)
  })
})

describe('parseEmbeddingSettingsPatch', () => {
  it('passes known keys of the right type and skips undefined', () => {
    expect(
      parseEmbeddingSettingsPatch({ enabled: true, pooling: '', ctx_size: 4096, model_id: undefined })
    ).toEqual({
      enabled: true,
      pooling: '',
      ctx_size: 4096,
    })
  })

  it.each([
    [{ dims: 768 }, "Unknown embedding setting 'dims'"],
    [{ pooling: 'rank' }, "'pooling' must be one of '', mean, cls, last"],
    [{ ctx_size: 'big' }, "'ctx_size' must be an integer"],
    [{ enabled: 1 }, "'enabled' must be a boolean"],
    [null, 'must be a JSON object'],
    [['enabled'], 'must be a JSON object'],
  ])('refuses %j', (patch, message) => {
    expect(() => parseEmbeddingSettingsPatch(patch)).toThrow(AtomicCoreError)
    expect(() => parseEmbeddingSettingsPatch(patch)).toThrow(message)
  })
})
