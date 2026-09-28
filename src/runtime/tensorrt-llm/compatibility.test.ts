import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, RuntimeDescriptor, Sha256Digest } from '../../contracts/index.js'
import { inventoryDigest } from '../environment/index.js'
import {
  checkModelCompatibility,
  isWeightFile,
  kvCacheReserveBytes,
  KV_CACHE_RESERVE_FRACTION_OF_WEIGHTS,
  selectLaunchGpu,
  weightBytes,
  type CheckpointFile,
  type ModelCheckInput,
} from './compatibility.js'

const digest = (hex: string): Sha256Digest => `sha256:${hex}`

/**
 * A minimal descriptor built directly against `RuntimeDescriptor`, not the full published fixture:
 * these are unit tests of `compatibility.ts`'s own logic (architecture/format/CC/memory/curated),
 * not of `parseRuntimeDescriptor` (covered by `descriptor.test.ts` against the real fixture). The
 * quantization matrix mirrors the real one closely enough to exercise every rule: `fp8_block_scales`
 * needs 9.0 but is excluded again on `12.0`/`12.1` (design D17, matching the published descriptor).
 */
function baseDescriptor(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
  const image = { repository: 'nvcr.io/nvidia/tensorrt-llm/release', digest: digest('a'.repeat(64)) }
  return {
    schema_version: 1,
    descriptor_id: 'tensorrt-llm-1.2.1-r1',
    engine_id: 'tensorrt-llm',
    adapter_id: 'tensorrt-llm',
    adapter_contract_version: 1,
    image: { 'linux/amd64': image, 'linux/arm64': image },
    probe_image: { 'linux/amd64': image, 'linux/arm64': image },
    minimum_core_version: '0.7.0',
    minimum_app_version: '2.0.49',
    minimum_driver_version: '590.44.01',
    minimum_compute_capability: '8.0',
    supported_architectures: ['LlamaForCausalLM', 'Qwen3ForCausalLM'],
    quantization: [
      { format: 'bf16', min_compute_capability: '8.0', excluded_compute_capabilities: [] },
      { format: 'fp16', min_compute_capability: '8.0', excluded_compute_capabilities: [] },
      { format: 'fp8', min_compute_capability: '8.9', excluded_compute_capabilities: [] },
      {
        format: 'fp8_block_scales',
        min_compute_capability: '9.0',
        excluded_compute_capabilities: ['12.0', '12.1'],
      },
      { format: 'nvfp4', min_compute_capability: '10.0', excluded_compute_capabilities: [] },
      { format: 'mxfp4', min_compute_capability: '10.0', excluded_compute_capabilities: [] },
    ],
    model_families: {},
    curated_models: [],
    recipes: [],
    download_bytes: 0,
    required_disk_bytes: 0,
    notices: [],
    exclusions: [],
    ...overrides,
  }
}

function gpu(overrides: Partial<GpuFacts> & Pick<GpuFacts, 'gpu_id'>): GpuFacts {
  return {
    name: 'Test GPU',
    compute_capability: '8.9',
    total_vram_bytes: 24_000_000_000,
    free_vram_bytes: 24_000_000_000,
    driver_version: '590.44.01',
    ...overrides,
  }
}

/** Mirrors `compatibility.ts`'s own `toInventoryFile`: `exactOptionalPropertyTypes` needs `sha256` omitted, not `undefined`. */
function toInventoryFile(file: CheckpointFile): { path: string; bytes: number; sha256?: string } {
  return file.sha256 === null
    ? { path: file.path, bytes: file.size }
    : { path: file.path, bytes: file.size, sha256: file.sha256 }
}

/** A safetensors shard listing summing to `bytes`, split across two files so both count. */
function weightFiles(totalBytes: number): CheckpointFile[] {
  const half = Math.floor(totalBytes / 2)
  return [
    { path: 'model-00001-of-00002.safetensors', size: half, sha256: 'aa' },
    { path: 'model-00002-of-00002.safetensors', size: totalBytes - half, sha256: 'bb' },
    { path: 'config.json', size: 1_024, sha256: null },
    { path: 'tokenizer.json', size: 17_000, sha256: null },
  ]
}

function baseInput(overrides: Partial<ModelCheckInput> = {}): ModelCheckInput {
  return {
    repository: 'acme/test-model',
    revision: 'deadbeef',
    config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
    hf_quant_config_json: null,
    files: weightFiles(10_000_000_000),
    ...overrides,
  }
}

describe('checkModelCompatibility', () => {
  it('a 75 GB FP8 checkpoint on an 80 GB datacenter card accounts for the KV reserve and reports numbers, with no consumer-card cap', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({
      gpu_id: 'gpu-0',
      compute_capability: '9.0',
      total_vram_bytes: 85_899_345_920, // 80 GiB nominal
      free_vram_bytes: 85_532_850_176, // an H100 reports 81,559 MiB free (conf README note)
    })
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'] },
      hf_quant_config_json: { quantization: { quant_algo: 'FP8' } },
      files: weightFiles(75_000_000_000),
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.quantization_format).toBe('fp8')
    expect(result.weight_bytes).toBe(75_000_000_000)
    expect(result.checked_gpu_id).toBe('gpu-0')
    // Whichever way the reserve tips the verdict, the numbers must be there — never a hardcoded cap.
    if (!result.verdict.ok) {
      expect(result.verdict.error.details).toContain('weight_bytes=75000000000')
    } else {
      expect(result.verdict).toEqual({ ok: true })
    }
  })

  it('40 GB of weights: does not fit the selected card (22 GB free) but fits a second card (46 GB free)', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({
      gpu_id: 'gpu-a',
      total_vram_bytes: 40_000_000_000,
      free_vram_bytes: 22_000_000_000,
    })
    const other = gpu({ gpu_id: 'gpu-b', total_vram_bytes: 46_000_000_000, free_vram_bytes: 46_000_000_000 })
    const input = baseInput({ files: weightFiles(40_000_000_000), gpu_id: 'gpu-a' })

    const result = checkModelCompatibility(input, descriptor, [selected, other], 0)

    expect(result.checked_gpu_id).toBe('gpu-a')
    expect(result.verdict).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'MODEL_INCOMPATIBLE' }),
    })
    expect(result.fits_other_gpus).toEqual(['gpu-b'])
  })

  it('a ModelOpt FP8 checkpoint declared only in hf_quant_config.json reports fp8, not bf16', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: '8.9' })
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
      hf_quant_config_json: { quantization: { quant_algo: 'FP8' } },
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.quantization_format).toBe('fp8')
    expect(result.verdict).toEqual({ ok: true })
  })

  it('sm120 (12.0) with fp8_block_scales, an excluded compute capability above the format minimum', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: '12.0' })
    const input = baseInput({
      config_json: {
        architectures: ['LlamaForCausalLM'],
        quantization_config: { quant_method: 'fp8', weight_block_size: [128, 128] },
      },
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.quantization_format).toBe('fp8_block_scales')
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
      expect(result.verdict.error.message).toContain('not supported by this engine release')
      expect(result.verdict.error.details).toBe('format=fp8_block_scales compute_capability=12.0')
    }
  })

  it('NVFP4 on compute capability 8.9 is incompatible, reporting both the required and actual CC', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: '8.9' })
    const input = baseInput({
      config_json: {
        architectures: ['LlamaForCausalLM'],
        quantization_config: { quant_method: 'modelopt', quant_algo: 'NVFP4' },
      },
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.quantization_format).toBe('nvfp4')
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.details).toBe('required=10.0 actual=8.9')
    }
  })

  it('an unsupported architecture is rejected by name', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({ config_json: { architectures: ['GPT2LMHeadModel'], dtype: 'bfloat16' } })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
      expect(result.verdict.error.message).toContain('GPT2LMHeadModel')
    }
    expect(result.fits_other_gpus).toEqual([])
  })

  it('GGUF is always rejected, with a hint that llama.cpp is the provider for GGUF', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({
      files: [
        { path: 'model.Q4_K_M.gguf', size: 5_000_000_000, sha256: null },
        { path: 'config.json', size: 1_024, sha256: null },
      ],
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.quantization_format).toBeNull()
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
      expect(result.verdict.error.message).toContain('llama.cpp')
    }
  })

  it('a GGUF-only listing is rejected the same way', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({ files: [{ path: 'model.gguf', size: 5_000_000_000, sha256: null }] })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.verdict.ok).toBe(false)
  })

  it('unified memory: a card with no VRAM of its own is compared against host MemAvailable and flagged', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({
      gpu_id: 'gb10',
      compute_capability: '10.0',
      total_vram_bytes: null,
      free_vram_bytes: null,
    })
    const input = baseInput({ files: weightFiles(4_000_000_000) })

    const fitsHost = checkModelCompatibility(input, descriptor, [selected], 20_000_000_000)
    expect(fitsHost.unified_memory).toBe(true)
    expect(fitsHost.verdict).toEqual({ ok: true })

    const tooTightOnHost = checkModelCompatibility(input, descriptor, [selected], 1_000_000_000)
    expect(tooTightOnHost.unified_memory).toBe(true)
    expect(tooTightOnHost.verdict.ok).toBe(false)
    if (!tooTightOnHost.verdict.ok) {
      expect(tooTightOnHost.verdict.error.details).toContain('free_bytes=1000000000')
    }
  })

  it('a curated repository/revision match with a matching inventory_digest is marked curated', () => {
    const files = weightFiles(4_000_000_000)
    const curatedDigest = inventoryDigest(files.map(toInventoryFile))
    const descriptor = baseDescriptor({
      curated_models: [
        {
          repository: 'acme/curated-model',
          revision: 'c0ffee',
          inventory_digest: curatedDigest,
          vram_tier_bytes: 8_000_000_000,
          note: 'test fixture',
        },
      ],
    })
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({ repository: 'acme/curated-model', revision: 'c0ffee', files })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.curated).toBe(true)
    expect(result.verdict).toEqual({ ok: true })
  })

  it('a curated repository/revision match whose files hash to a different digest is MANAGED_METADATA_INVALID, not downloaded', () => {
    const pinnedFiles = weightFiles(4_000_000_000)
    const curatedDigest = inventoryDigest(pinnedFiles.map(toInventoryFile))
    const descriptor = baseDescriptor({
      curated_models: [
        {
          repository: 'acme/curated-model',
          revision: 'c0ffee',
          inventory_digest: curatedDigest,
          vram_tier_bytes: 8_000_000_000,
          note: 'test fixture',
        },
      ],
    })
    const selected = gpu({ gpu_id: 'gpu-0' })
    // The repository was rewritten on the same revision: same paths, different bytes.
    const rewrittenFiles = weightFiles(5_000_000_000)
    const input = baseInput({ repository: 'acme/curated-model', revision: 'c0ffee', files: rewrittenFiles })

    const result = checkModelCompatibility(input, descriptor, [selected], 0)

    expect(result.curated).toBe(false)
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MANAGED_METADATA_INVALID')
      expect(result.verdict.error.details).toContain(`expected=${curatedDigest}`)
      expect(result.verdict.error.details).toContain('actual=sha256:')
    }
  })

  it('throws INVALID_ARGUMENT when the host has no GPU at all', () => {
    const descriptor = baseDescriptor()
    expect(() => checkModelCompatibility(baseInput(), descriptor, [], 0)).toThrow(AtomicCoreError)
  })
})

describe('selectLaunchGpu', () => {
  const a = gpu({ gpu_id: 'a', total_vram_bytes: 24_000_000_000 })
  const b = gpu({ gpu_id: 'b', total_vram_bytes: 80_000_000_000 })
  const unified = gpu({ gpu_id: 'u', total_vram_bytes: null, free_vram_bytes: null })

  it('picks gpu_id when given and present on the host', () => {
    expect(selectLaunchGpu([a, b], 'a')?.gpu_id).toBe('a')
  })

  it('falls back to the most total memory when gpu_id is omitted', () => {
    expect(selectLaunchGpu([a, b])?.gpu_id).toBe('b')
  })

  it('falls back to the most total memory when gpu_id is given but not found on the host', () => {
    expect(selectLaunchGpu([a, b], 'missing')?.gpu_id).toBe('b')
  })

  it('returns null when the host has no GPU', () => {
    expect(selectLaunchGpu([])).toBeNull()
  })

  it('a unified-memory card ranks like a 0-byte card, not an infinite one', () => {
    expect(selectLaunchGpu([unified, a])?.gpu_id).toBe('a')
  })

  it('a lone unified-memory card is still selected as the only candidate', () => {
    expect(selectLaunchGpu([unified])?.gpu_id).toBe('u')
  })
})

describe('isWeightFile / weightBytes', () => {
  it('counts only *.safetensors files, sharded or single', () => {
    const files: CheckpointFile[] = [
      { path: 'model-00001-of-00002.safetensors', size: 100, sha256: null },
      { path: 'model-00002-of-00002.safetensors', size: 200, sha256: null },
      { path: 'config.json', size: 5, sha256: null },
      { path: 'tokenizer.json', size: 6, sha256: null },
      { path: 'pytorch_model.bin', size: 999, sha256: null },
    ]
    expect(files.map((f) => isWeightFile(f.path))).toEqual([true, true, false, false, false])
    expect(weightBytes(files)).toBe(300)
  })

  it('matches the extension case-insensitively', () => {
    expect(isWeightFile('model.SAFETENSORS')).toBe(true)
  })
})

describe('kvCacheReserveBytes', () => {
  it('is a fixed, documented fraction of weight bytes', () => {
    expect(KV_CACHE_RESERVE_FRACTION_OF_WEIGHTS).toBeGreaterThan(0)
    expect(kvCacheReserveBytes(100_000_000_000)).toBe(100_000_000_000 * KV_CACHE_RESERVE_FRACTION_OF_WEIGHTS)
  })

  it('rounds up so a reserve is never under-counted', () => {
    expect(kvCacheReserveBytes(1)).toBe(1)
  })
})
