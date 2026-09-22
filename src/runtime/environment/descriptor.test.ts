import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import { parseRuntimeDescriptor, type AdapterCatalog } from './descriptor.js'

/** The production registry has one compiled adapter; tests inject whatever they need to prove. */
const catalog: AdapterCatalog = {
  contractVersion: (id) => (id === 'tensorrt-llm-pytorch' ? 1 : undefined),
}

const IMAGE_DIGEST = `sha256:${'f7'.repeat(32)}`
const ENTRYPOINT_DIGEST = `sha256:${'ab'.repeat(32)}`
const RECIPE_DIGEST = `sha256:${'cd'.repeat(32)}`
const INVENTORY_DIGEST = `sha256:${'ef'.repeat(32)}`

const valid = (): Record<string, unknown> => ({
  schema_version: 1,
  descriptor_id: 'trtllm-1.3.0rc27',
  engine_id: 'tensorrt-llm',
  adapter_id: 'tensorrt-llm-pytorch',
  adapter_contract_version: 1,
  image: {
    repository: 'nvcr.io/nvidia/tensorrt-llm/release',
    digest: IMAGE_DIGEST,
    platform: 'linux/amd64',
  },
  entrypoint_digest: ENTRYPOINT_DIGEST,
  minimum_core_version: '0.4.0',
  minimum_app_version: '0.4.0',
  minimum_compute_capability: '8.0',
  supported_architectures: ['LlamaForCausalLM', 'Qwen2ForCausalLM'],
  quantization: [
    { format: 'FP8', min_compute_capability: '8.9' },
    { format: 'NVFP4', min_compute_capability: '12.0' },
  ],
  recipes: [{ executor: 'linux-docker', recipe_id: 'ubuntu-24.04-docker-ce', digest: RECIPE_DIGEST }],
  curated_models: [
    {
      repository: 'nvidia/Llama-3.1-8B-Instruct-FP8',
      revision: 'main',
      inventory_digest: INVENTORY_DIGEST,
      vram_tier_bytes: 12_884_901_888,
      note: 'Measured on RTX 4070.',
    },
  ],
  download_bytes: 17_222_444_000,
  required_disk_bytes: 60_000_000_000,
  notices: ['NVIDIA container terms apply.'],
  exclusions: ['NVFP4 needs compute capability 12.0.'],
})

const codeOf = (input: unknown): string => {
  try {
    parseRuntimeDescriptor(input, catalog)
  } catch (error) {
    if (error instanceof AtomicCoreError) return error.code
    throw error
  }
  throw new Error('expected a throw')
}

/** `valid()` with one field replaced, so each case differs from the accepted one in one way. */
const withField = (field: string, value: unknown): Record<string, unknown> => ({
  ...valid(),
  [field]: value,
})

describe('parseRuntimeDescriptor', () => {
  it('accepts a well-formed descriptor and returns its values unchanged', () => {
    const parsed = parseRuntimeDescriptor(valid(), catalog)

    expect(parsed.descriptor_id).toBe('trtllm-1.3.0rc27')
    expect(parsed.image).toEqual({
      repository: 'nvcr.io/nvidia/tensorrt-llm/release',
      digest: IMAGE_DIGEST,
      platform: 'linux/amd64',
    })
    expect(parsed.supported_architectures).toEqual(['LlamaForCausalLM', 'Qwen2ForCausalLM'])
    expect(parsed.quantization).toEqual([
      { format: 'FP8', min_compute_capability: '8.9' },
      { format: 'NVFP4', min_compute_capability: '12.0' },
    ])
    expect(parsed.curated_models[0]?.vram_tier_bytes).toBe(12_884_901_888)
    expect(parsed.download_bytes).toBe(17_222_444_000)
  })

  it('accepts absent sizes as unknown rather than demanding a number nobody measured', () => {
    const parsed = parseRuntimeDescriptor(
      { ...valid(), download_bytes: null, required_disk_bytes: null },
      catalog
    )
    expect(parsed.download_bytes).toBeNull()
    expect(parsed.required_disk_bytes).toBeNull()
  })

  it('refuses an image named by a tag, and keeps accepting a registry port', () => {
    // A tag can be repointed by whoever owns the registry; a qualification result is about bytes.
    expect(
      codeOf(
        withField('image', {
          repository: 'nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc27',
          digest: IMAGE_DIGEST,
          platform: 'linux/amd64',
        })
      )
    ).toBe('MANAGED_METADATA_INVALID')
    expect(
      codeOf(
        withField('image', {
          repository: 'nvcr.io/nvidia/tensorrt-llm/release@sha256:abc',
          digest: IMAGE_DIGEST,
          platform: 'linux/amd64',
        })
      )
    ).toBe('MANAGED_METADATA_INVALID')
    // `localhost:5000/team/engine` is a host and port, not a tag.
    const ported = parseRuntimeDescriptor(
      withField('image', {
        repository: 'localhost:5000/team/engine',
        digest: IMAGE_DIGEST,
        platform: 'linux/amd64',
      }),
      catalog
    )
    expect(ported.image.repository).toBe('localhost:5000/team/engine')
  })

  it('refuses a digest that is not a full lowercase sha256, wherever it appears', () => {
    for (const bad of [
      'sha256:abc',
      'sha512:' + 'a'.repeat(64),
      'SHA256:' + 'a'.repeat(64),
      `sha256:${'A'.repeat(64)}`,
      'a'.repeat(64),
    ]) {
      expect(codeOf(withField('image', { repository: 'r/e', digest: bad, platform: 'linux/amd64' }))).toBe(
        'MANAGED_METADATA_INVALID'
      )
      expect(codeOf(withField('entrypoint_digest', bad))).toBe('MANAGED_METADATA_INVALID')
    }
  })

  it('refuses a schema this build does not know, instead of reading the fields it recognises', () => {
    expect(codeOf(withField('schema_version', 2))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(withField('schema_version', '1'))).toBe('MANAGED_METADATA_INVALID')
    // A field this build would ignore might be the exclusion that matters; the version is how a
    // newer catalog announces itself.
    expect(codeOf({ ...valid(), future_field: true })).toBe('MANAGED_METADATA_INVALID')
  })

  it('refuses an adapter that is not compiled in, and one that speaks another contract version', () => {
    expect(codeOf(withField('adapter_id', 'vllm-openai'))).toBe('MANAGED_ADAPTER_UNAVAILABLE')
    expect(codeOf({ ...valid(), adapter_id: 'tensorrt-llm-pytorch', adapter_contract_version: 2 })).toBe(
      'MANAGED_METADATA_INVALID'
    )
    const mismatched: AdapterCatalog = { contractVersion: () => 2 }
    expect(() => parseRuntimeDescriptor(valid(), mismatched)).toThrow(/implements contract version 2/)
  })

  it('refuses two recipes for one executor and two recipes with one id', () => {
    const second = { executor: 'wsl-docker', recipe_id: 'win11-wsl', digest: RECIPE_DIGEST }
    // Two host recipes for the same executor would leave the choice to chance.
    expect(
      codeOf(
        withField('recipes', [
          { executor: 'linux-docker', recipe_id: 'a', digest: RECIPE_DIGEST },
          { executor: 'linux-docker', recipe_id: 'b', digest: RECIPE_DIGEST },
        ])
      )
    ).toBe('MANAGED_METADATA_INVALID')
    expect(
      codeOf(
        withField('recipes', [
          { executor: 'linux-docker', recipe_id: 'a', digest: RECIPE_DIGEST },
          { executor: 'wsl-docker', recipe_id: 'a', digest: RECIPE_DIGEST },
        ])
      )
    ).toBe('MANAGED_METADATA_INVALID')
    // One per executor is the normal case: the same image on Linux and inside WSL.
    const both = parseRuntimeDescriptor(
      withField('recipes', [
        { executor: 'linux-docker', recipe_id: 'ubuntu-24.04-docker-ce', digest: RECIPE_DIGEST },
        second,
      ]),
      catalog
    )
    expect(both.recipes).toHaveLength(2)
  })

  it('refuses a repeated architecture, quantization format or model revision', () => {
    expect(codeOf(withField('supported_architectures', ['LlamaForCausalLM', 'LlamaForCausalLM']))).toBe(
      'MANAGED_METADATA_INVALID'
    )
    expect(
      codeOf(
        withField('quantization', [
          { format: 'FP8', min_compute_capability: '8.9' },
          { format: 'FP8', min_compute_capability: '9.0' },
        ])
      )
    ).toBe('MANAGED_METADATA_INVALID')
    const model = valid()['curated_models'] as unknown[]
    expect(codeOf(withField('curated_models', [model[0], model[0]]))).toBe('MANAGED_METADATA_INVALID')
    // The same repository at another revision is a different model, and allowed.
    const twoRevisions = parseRuntimeDescriptor(
      withField('curated_models', [
        model[0],
        { ...(model[0] as Record<string, unknown>), revision: 'refs/pr/1' },
      ]),
      catalog
    )
    expect(twoRevisions.curated_models).toHaveLength(2)
  })

  it('refuses an empty architecture list, since a release that loads nothing cannot be offered', () => {
    expect(codeOf(withField('supported_architectures', []))).toBe('MANAGED_METADATA_INVALID')
    expect(codeOf(withField('supported_architectures', ''))).toBe('MANAGED_METADATA_INVALID')
  })

  it('refuses a compute capability that is not major.minor', () => {
    for (const bad of ['8', '8.9.1', 'sm89', '08.9', '8.', '', 'Ada', 8.9]) {
      expect(codeOf(withField('minimum_compute_capability', bad))).toBe('MANAGED_METADATA_INVALID')
      expect(codeOf(withField('quantization', [{ format: 'FP8', min_compute_capability: bad }]))).toBe(
        'MANAGED_METADATA_INVALID'
      )
    }
    // Two-digit majors are ordinary: Blackwell is 12.0.
    expect(
      parseRuntimeDescriptor(withField('minimum_compute_capability', '12.0'), catalog)
        .minimum_compute_capability
    ).toBe('12.0')
  })

  it('refuses a byte count that is negative, fractional or past exact integer arithmetic', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '12']) {
      expect(codeOf(withField('download_bytes', bad))).toBe('MANAGED_METADATA_INVALID')
    }
    const model = valid()['curated_models'] as Record<string, unknown>[]
    expect(codeOf(withField('curated_models', [{ ...model[0], vram_tier_bytes: -1 }]))).toBe(
      'MANAGED_METADATA_INVALID'
    )
  })

  it('refuses a platform other than the one the image was built for', () => {
    expect(
      codeOf(
        withField('image', {
          repository: 'r/e',
          digest: IMAGE_DIGEST,
          platform: 'linux/arm64',
        })
      )
    ).toBe('MANAGED_METADATA_INVALID')
  })

  it('refuses something that is not a descriptor at all', () => {
    for (const bad of [null, 'descriptor', 42, [], undefined]) {
      expect(codeOf(bad)).toBe('MANAGED_METADATA_INVALID')
    }
  })
})
