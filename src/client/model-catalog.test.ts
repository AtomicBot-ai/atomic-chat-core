import { describe, expect, it } from 'vitest'
import baseline from './model-catalog-baseline.json' with { type: 'json' }
import {
  atomicModelRevision,
  parseAtomicModelCatalog,
  projectAtomicModelCollection,
} from './model-catalog.js'

describe('unified model catalog', () => {
  it('projects the bundled document and translates variant references into the historical wire fields', () => {
    const catalog = parseAtomicModelCatalog(baseline)
    for (const name of Object.keys(catalog.collections))
      expect(projectAtomicModelCollection(catalog, name).schema_version).toBe(1)
    const projected = projectAtomicModelCollection(catalog, 'recommended')
    expect((projected.recommendations as Record<string, unknown>[])[0]).toMatchObject({
      model_name: 'AtomicChat/Qwen3.5-4B-GGUF',
      quant: 'Q4_K_M',
    })
    const pinned = projectAtomicModelCollection(catalog, 'diffusion').families as {
      transformer: { revision: string }
      text_encoders: { revision: string }[]
    }[]
    const legacy = projectAtomicModelCollection(catalog, 'diffusion', false).families as typeof pinned
    expect(pinned[0]!.text_encoders[0]!.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(legacy[0]!.text_encoders[0]!.revision).toBeUndefined()
    expect(atomicModelRevision(catalog, 'AtomicChat/Qwen3.5-4B-GGUF')).toMatch(/^[0-9a-f]{40}$/)
    expect(atomicModelRevision(catalog, 'someone/unknown')).toBeUndefined()
  })
  it('keeps GenieX and the audio models already present in the released catalogs', () => {
    const catalog = parseAtomicModelCatalog(baseline)
    const geniex = projectAtomicModelCollection(catalog, 'geniex-models').models as Record<string, unknown>[]
    const audio = projectAtomicModelCollection(catalog, 'audio').models as Record<string, unknown>[]
    expect(geniex.map((model) => model.id)).toContain('qwen3-4b-qairt')
    expect(audio.find((model) => model.id === 'qwen3-tts-1.7b-customvoice')).toMatchObject({
      repo: 'audio-cpp/audio.cpp-gguf',
      revision: '874fcb41ececda20bcbc0782d6b4ea7f7d069ea8',
    })
  })

  it('rejects a missing source, model or variant instead of combining it with another snapshot', () => {
    const catalog = parseAtomicModelCatalog(structuredClone(baseline))
    catalog.collections['staff-picks']!.entries![0]!.variant = 'missing'
    expect(() => parseAtomicModelCatalog(catalog)).toThrow('Unknown catalog variant')
    catalog.collections['staff-picks']!.entries![0] = { model: 'missing', variant: 'default' }
    expect(() => parseAtomicModelCatalog(catalog)).toThrow('Unknown catalog model')
    const unpinned = structuredClone(baseline)
    Object.values(unpinned.models)[0]!.definition = { repo: 'o/r', revision: 'main' } as never
    expect(() => parseAtomicModelCatalog(unpinned)).toThrow('Missing immutable revision')
  })
})
