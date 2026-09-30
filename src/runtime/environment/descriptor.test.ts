import { describe, expect, it } from 'vitest'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { AtomicCoreError } from '../../contracts/index.js'
import { parseRuntimeDescriptor, summarizeRuntimeDescriptor } from './descriptor.js'

/** Deep-clones the real fixture and applies a mutation, for one-field-at-a-time rejection tests. */
const broken = (mutate: (doc: Record<string, unknown>) => void): unknown => {
  const doc = JSON.parse(JSON.stringify(readRuntimeFixture('tensorrt-llm.json'))) as Record<string, unknown>
  mutate(doc)
  return doc
}

describe('parseRuntimeDescriptor', () => {
  it('accepts the published TensorRT-LLM descriptor verbatim (conf commit c21e520)', () => {
    const fixture = readRuntimeFixture('tensorrt-llm.json')
    const descriptor = parseRuntimeDescriptor(fixture)

    expect(descriptor.descriptor_id).toBe('tensorrt-llm-1.2.1-r1')
    expect(descriptor.engine_id).toBe('tensorrt-llm')
    expect(descriptor.minimum_driver_version).toBe('590.44.01')
    expect(descriptor.image['linux/amd64'].repository).toBe('nvcr.io/nvidia/tensorrt-llm/release')
    expect(descriptor.image['linux/arm64'].digest.startsWith('sha256:')).toBe(true)
    expect(descriptor.probe_image['linux/amd64'].repository).toBe('nvcr.io/nvidia/cuda')
    expect(descriptor.supported_architectures).toContain('LlamaForCausalLM')
    expect(descriptor.curated_models).toHaveLength(11)
    expect(descriptor.recipes).toHaveLength(1)
    expect(descriptor.recipes[0]?.recipe_id).toBe('linux.install-container-runtime')
    expect(descriptor.recipes[0]?.distributions.length).toBeGreaterThan(0)
  })

  it('reads a format only present via its exclusion list, keeping the excluded capabilities above the minimum', () => {
    const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))
    const fp8BlockScales = descriptor.quantization.find((q) => q.format === 'fp8_block_scales')

    expect(fp8BlockScales).toBeDefined()
    expect(fp8BlockScales?.min_compute_capability).toBe('9.0')
    expect(fp8BlockScales?.excluded_compute_capabilities).toEqual(['12.0', '12.1'])
  })

  it('reads model_families keyed by architecture, with a parser name or null', () => {
    const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))

    expect(descriptor.model_families['Qwen3ForCausalLM']).toEqual({
      tool_parser: 'qwen3',
      reasoning_parser: 'qwen3',
      structured_output: true,
    })
    expect(descriptor.model_families['LlamaForCausalLM']?.tool_parser).toBeNull()
  })

  it.each([
    [
      'a top-level field this build does not know',
      (doc: Record<string, unknown>) => (doc['entrypoint_digest'] = 'sha256:' + 'a'.repeat(64)),
    ],
    ['schema_version other than 1', (doc: Record<string, unknown>) => (doc['schema_version'] = 2)],
    ['download_bytes missing', (doc: Record<string, unknown>) => delete doc['download_bytes']],
    [
      'a minimum_core_version that is not a semver (major.minor.patch)',
      (doc: Record<string, unknown>) => (doc['minimum_core_version'] = '0.7'),
    ],
    [
      'a minimum_app_version that is not a semver',
      (doc: Record<string, unknown>) => (doc['minimum_app_version'] = 'v2.0.49'),
    ],
    [
      'an image repository containing a space',
      (doc: Record<string, unknown>) => {
        const image = doc['image'] as Record<string, Record<string, unknown>>
        image['linux/amd64'] = { ...image['linux/amd64'], repository: 'nvcr.io/nvidia repo/release' }
      },
    ],
    [
      'a descriptor_id that starts with a dash instead of a letter or digit (the id pattern)',
      (doc: Record<string, unknown>) => (doc['descriptor_id'] = '-tensorrt-llm-1.2.1-r1'),
    ],
    [
      'an adapter_id with uppercase letters (the id pattern)',
      (doc: Record<string, unknown>) => (doc['adapter_id'] = 'TensorRT-LLM'),
    ],
    [
      'a curated model revision that is not 40 hex characters',
      (doc: Record<string, unknown>) => {
        const curated = doc['curated_models'] as Array<Record<string, unknown>>
        curated[0] = { ...curated[0], revision: 'main' }
      },
    ],
    [
      'a curated model repository with no owner/name slash',
      (doc: Record<string, unknown>) => {
        const curated = doc['curated_models'] as Array<Record<string, unknown>>
        curated[0] = { ...curated[0], repository: 'just-a-name' }
      },
    ],
    [
      'a curated model vram_tier_bytes of 0 (the schema minimum is 1)',
      (doc: Record<string, unknown>) => {
        const curated = doc['curated_models'] as Array<Record<string, unknown>>
        curated[0] = { ...curated[0], vram_tier_bytes: 0 }
      },
    ],
    [
      'a recipe distribution id with an uppercase letter (the distribution id pattern)',
      (doc: Record<string, unknown>) => {
        const recipes = doc['recipes'] as Array<Record<string, unknown>>
        const distributions = recipes[0]?.['distributions'] as Array<Record<string, unknown>>
        distributions[0] = { ...distributions[0], id: 'Ubuntu' }
      },
    ],
    [
      'a recipe distribution version_id that is not digits and dots',
      (doc: Record<string, unknown>) => {
        const recipes = doc['recipes'] as Array<Record<string, unknown>>
        const distributions = recipes[0]?.['distributions'] as Array<Record<string, unknown>>
        distributions[0] = { ...distributions[0], version_id: '24.04-lts' }
      },
    ],
    [
      'a quantization format with an uppercase letter (the format pattern)',
      (doc: Record<string, unknown>) => {
        const quant = doc['quantization'] as Array<Record<string, unknown>>
        quant[0] = { ...quant[0], format: 'FP8' }
      },
    ],
  ])('rejects the descriptor when it has %s', (_label, mutate) => {
    expect(() => parseRuntimeDescriptor(broken(mutate))).toThrow(AtomicCoreError)
  })

  it('rejects an image pinned by tag instead of digest', () => {
    const doc = broken((d) => {
      const image = d['image'] as Record<string, Record<string, unknown>>
      image['linux/amd64'] = {
        ...image['linux/amd64'],
        repository: 'nvcr.io/nvidia/tensorrt-llm/release:1.2.1',
      }
    })
    expect(() => parseRuntimeDescriptor(doc)).toThrow(/not a bare image repository|not a sha256 digest/)
  })

  it('rejects an image map missing one of the two required platforms', () => {
    const doc = broken((d) => {
      const image = d['image'] as Record<string, unknown>
      delete image['linux/arm64']
    })
    expect(() => parseRuntimeDescriptor(doc)).toThrow(/linux\/arm64/)
  })

  it('rejects a recipe distribution carrying a command instead of a plain identity', () => {
    const doc = broken((d) => {
      const recipes = d['recipes'] as Array<Record<string, unknown>>
      const first = recipes[0] as Record<string, unknown>
      first['command'] = 'apt-get install -y docker-ce'
    })
    expect(() => parseRuntimeDescriptor(doc)).toThrow(AtomicCoreError)
  })

  it('rejects a quantization entry whose excluded compute capability is not above its own minimum', () => {
    const doc = broken((d) => {
      const quant = d['quantization'] as Array<Record<string, unknown>>
      const fp8 = quant.find((q) => q['format'] === 'fp8') as Record<string, unknown>
      fp8['excluded_compute_capabilities'] = ['8.9']
    })
    expect(() => parseRuntimeDescriptor(doc)).toThrow(/not above min_compute_capability/)
  })

  it("rejects a duplicate compute capability in one format's exclusion list", () => {
    const doc = broken((d) => {
      const quant = d['quantization'] as Array<Record<string, unknown>>
      const target = quant.find(
        (q) => (q['excluded_compute_capabilities'] as unknown[]).length > 0
      ) as Record<string, unknown>
      const excluded = target['excluded_compute_capabilities'] as string[]
      target['excluded_compute_capabilities'] = [...excluded, excluded[0]]
    })
    expect(() => parseRuntimeDescriptor(doc)).toThrow(/twice/)
  })

  it('rejects a model_families key that is not an HF architecture class name', () => {
    const doc = broken((d) => {
      const families = d['model_families'] as Record<string, unknown>
      families['not-an-architecture'] = {
        tool_parser: null,
        reasoning_parser: null,
        structured_output: false,
      }
    })
    expect(() => parseRuntimeDescriptor(doc)).toThrow(AtomicCoreError)
  })

  it('rejects a curated model whose inventory_digest is not a sha256 digest', () => {
    const doc = broken((d) => {
      const curated = d['curated_models'] as Array<Record<string, unknown>>
      const first = curated[0] as Record<string, unknown>
      first['inventory_digest'] = 'sha1:deadbeef'
    })
    expect(() => parseRuntimeDescriptor(doc)).toThrow(/sha256 digest/)
  })

  it('rejects two curated models pinning the same repository and revision', () => {
    const doc = broken((d) => {
      const curated = d['curated_models'] as Array<Record<string, unknown>>
      curated.push({ ...curated[0] })
    })
    expect(() => parseRuntimeDescriptor(doc)).toThrow(/twice/)
  })

  it('rejects null, a string and an array instead of a descriptor object', () => {
    expect(() => parseRuntimeDescriptor(null)).toThrow(AtomicCoreError)
    expect(() => parseRuntimeDescriptor('tensorrt-llm-1.2.1-r1')).toThrow(AtomicCoreError)
    expect(() => parseRuntimeDescriptor([])).toThrow(AtomicCoreError)
  })
})

describe('summarizeRuntimeDescriptor', () => {
  it('keeps exactly what a client shows before consent: id, engine, notices, curated models, architectures (task 2.22)', () => {
    const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))
    const summary = summarizeRuntimeDescriptor(descriptor)

    expect(Object.keys(summary).sort()).toEqual([
      'curated_models',
      'descriptor_id',
      'engine_id',
      'notices',
      'supported_architectures',
    ])
    expect(summary.descriptor_id).toBe('tensorrt-llm-1.2.1-r1')
    expect(summary.engine_id).toBe('tensorrt-llm')
    // Notices verbatim and in order: they are the NVIDIA terms the user reads before consenting.
    expect(summary.notices).toEqual(descriptor.notices)
    expect(summary.notices.length).toBeGreaterThan(0)
    expect(summary.curated_models).toEqual(descriptor.curated_models)
    expect(summary.curated_models).toHaveLength(11)
    expect(summary.supported_architectures).toEqual(descriptor.supported_architectures)

    // Copies: whoever serializes or edits the summary never reaches into the descriptor it came from.
    summary.notices.push('extra')
    summary.curated_models[0]!.note = 'edited'
    expect(descriptor.notices).not.toContain('extra')
    expect(descriptor.curated_models[0]?.note).not.toBe('edited')
  })
})
