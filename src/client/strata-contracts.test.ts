import { describe, expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/catalog.json' with { type: 'json' }
import baseline from './model-catalog-baseline.json' with { type: 'json' }
import { ENGINE_BUILD_IDS, ENGINE_IDS, ENGINE_KINDS } from '../contracts/index.js'
import { readStrataBlock } from '../models/index.js'
import { parseStrataDescriptor, projectStrataCollection } from './strata-contracts.js'
import { parseAtomicModelCatalog, projectAtomicModelCollection } from './model-catalog.js'

const entries = Object.values(fixture.models)
const descriptor = () => structuredClone(entries[0]!.definition)

describe('Strata contracts', () => {
  it('accepts the four-part engine versions supported by the bundle manifest', () => {
    const d = { ...descriptor(), engine_release: 'strata-0.1.59.1-r2' }
    expect(parseStrataDescriptor(d).engine_release).toBe(d.engine_release)
  })
  it('counts the separately declared DeepSeek Engram as the last GGUF shard', () => {
    const original = entries.find((entry) => entry.definition.family === 'deepseek41')!
    const deepseek = parseStrataDescriptor(original.definition)
    deepseek.variant_id = 'unsloth-ud-iq1-s-dspark'
    deepseek.compatible_variants = ['linux-x64-cuda13']
    const renamed = (path: string) => path.replace('-of-00004.gguf', '-of-00005.gguf')
    const weights = deepseek.inputs.weights.map(renamed)
    const engram = weights[0]!.replace('-00001-of-', '-00005-of-')
    deepseek.files = deepseek.files
      .filter((file) => file.role !== 'engram-metadata')
      .map((file) => ({
        ...file,
        path: file.role === 'weights' ? renamed(file.path) : file.role === 'engram' ? engram : file.path,
      }))
    deepseek.requirements.download_bytes = deepseek.files.reduce((size, file) => size + file.size, 0)
    deepseek.inputs = {
      ...deepseek.inputs,
      weights,
      tokenizer_from: weights[0]!,
      chat_template_from: weights[0]!,
      engram_metadata: weights[0]!,
      engram,
    }
    expect(parseStrataDescriptor(deepseek)).toEqual(deepseek)
    deepseek.inputs.engram_metadata = weights[1]!
    expect(() => parseStrataDescriptor(deepseek)).toThrow(/Engram/)
  })

  it('registers one engine-build provider and preserves the distinction between acquisition and readiness', () => {
    expect(ENGINE_BUILD_IDS).toContain('strata')
    expect(ENGINE_IDS).toContain('strata')
    expect(ENGINE_KINDS.strata).toBe('engine-build')
    const block = readStrataBlock({
      schema_version: 1,
      source_digest: 'a'.repeat(64),
      descriptor: descriptor(),
    })
    expect(block.descriptor.family).toBe('qwen38')
    expect(block).not.toHaveProperty('ready')
    expect(() => readStrataBlock({ ...block, source_digest: 'main' })).toThrow()
  })

  it.each(entries)(
    'reads the complete pinned $definition.family plan without upgrading its evidence',
    ({ definition }) => {
      const parsed = parseStrataDescriptor(definition)
      expect(parsed).toEqual(definition)
      expect(parsed.qualification.status).toBe('upstream-supported')
      expect(parsed).not.toBe(definition)
    }
  )

  it.each([
    ['mutable source', 'sources.0.revision', 'main'],
    ['missing hash', 'files.0.sha256', undefined],
    ['traversal', 'files.0.path', '../weights.gguf'],
    ['Windows device', 'files.0.path', 'NUL.gguf'],
    ['case alias', 'files.1.path', descriptor().files[0]!.path.toUpperCase()],
    ['file-directory collision', 'files.1.path', descriptor().files[0]!.path + '/shard.gguf'],
    ['missing shard', 'inputs.weights', [descriptor().inputs.weights[0]]],
    ['missing drafter', 'inputs.drafter', undefined],
    ['wrong role', 'files.0.role', 'vision'],
    ['wrong sum', 'requirements.download_bytes', 1],
    ['unknown recipe', 'preparation_recipe_id', 'execute-script'],
    ['unknown ABI', 'preparation_abi', 'strata-v2'],
    ['unknown evidence', 'qualification.status', 'tested'],
    ['unsafe source', 'sources.0.repo', '../weights'],
    ['unlisted source', 'files.0.source', 'other'],
    ['nonfinite context', 'context_length', Infinity],
    ['missing validator requirement', 'capability_requirements.structured_output', []],
    ['executable config', 'before_load', 'execute me'],
  ])('rejects %s', (_, path, value) => {
    const d = descriptor()
    const parts = String(path).split('.')
    const key = parts.pop()!
    let parent: unknown = d
    for (const part of parts) parent = (parent as Record<string, unknown>)[part]
    ;(parent as Record<string, unknown>)[key] = value
    expect(() => parseStrataDescriptor(d)).toThrow(/Strata/)
  })

  it.each([
    [1, 'macos-arm64-metal'],
    [1, 'linux-x64-sycl'],
    [1, 'linux-arm64-spark-cuda13'],
    [2, 'linux-x64-sycl'],
    [2, 'linux-x64-cuda12'],
  ])('rejects a forbidden family/backend pair %s/%s', (index, variant) => {
    const d = structuredClone(entries[index]!.definition)
    d.compatible_variants.push(variant)
    expect(() => parseStrataDescriptor(d)).toThrow(/Strata/)
  })

  it('reads old catalogs as an empty shelf, and new catalogs without changing existing projections', () => {
    const old = parseAtomicModelCatalog(baseline)
    expect(projectStrataCollection(old)).toEqual({ schema_version: 1, models: [] })
    const catalog = parseAtomicModelCatalog({
      ...baseline,
      models: { ...baseline.models, ...fixture.models },
      collections: { ...baseline.collections, 'strata-models': fixture.collection },
    })
    expect(projectAtomicModelCollection(catalog, 'strata-models').models).toEqual(
      entries.map((e) => e.definition)
    )
    expect(projectAtomicModelCollection(catalog, 'recommended')).toEqual(
      projectAtomicModelCollection(old, 'recommended')
    )
    catalog.collections['strata-models']!.entries![0]!.variant = 'missing'
    expect(() => projectStrataCollection(catalog)).toThrow(/Strata/)
  })
})
