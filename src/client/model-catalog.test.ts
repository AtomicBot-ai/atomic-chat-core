import candidate from '../../test/fixtures/fastflowlm/qwen3-candidate.json' with { type: 'json' }
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

describe('FastFlowLM collection', () => {
  const name = 'fastflowlm-models'
  const id = candidate.definition.variant_id
  const document = (entry = structuredClone(candidate)) => ({
    ...structuredClone(baseline),
    models: {
      ...baseline.models,
      [id]: entry,
      future: { kind: 'future', format: 'future', variants: {}, definition: {} },
    },
    collections: {
      ...baseline.collections,
      [name]: { header: { schema_version: 1 }, entries: [{ model: id, variant: id }] },
    },
  })
  it('treats an older snapshot as an empty FLM collection', () => {
    expect(projectAtomicModelCollection(parseAtomicModelCatalog(baseline), name)).toEqual({
      schema_version: 1,
      models: [],
    })
  })
  it('projects the complete pinned staging plan and ignores an unrelated future kind', () => {
    expect(() => parseAtomicModelCatalog(document())).toThrow(/candidate/i)
    const catalog = parseAtomicModelCatalog(document(), { allowCandidates: true })
    expect(projectAtomicModelCollection(catalog, name, true, { allowCandidates: true })).toEqual({
      schema_version: 1,
      models: [candidate.definition],
    })
  })
  it('rejects case-colliding targets and unpinned or unknown file sources', () => {
    for (const mutate of [
      (d: typeof candidate.definition) => {
        d.files[1]!.path = d.files[0]!.path.toUpperCase()
      },
      (d: typeof candidate.definition) => {
        d.sources[0]!.revision = 'main'
      },
      (d: typeof candidate.definition) => {
        d.files[0]!.source = 'unknown'
      },
    ]) {
      const entry = structuredClone(candidate)
      mutate(entry.definition)
      expect(() => parseAtomicModelCatalog(document(entry), { allowCandidates: true })).toThrow()
    }
  })
})
