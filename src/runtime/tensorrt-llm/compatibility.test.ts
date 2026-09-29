import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, RuntimeDescriptor, Sha256Digest } from '../../contracts/index.js'
import { inventoryDigest } from '../environment/index.js'
import {
  checkModelCompatibility,
  isWeightFile,
  kvCacheReserveBytes,
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
  // Both cases below share the same real-world 80 GiB datacenter card (an H100 reports 81,559 MiB
  // free — conf README note), so the only variable is the checkpoint's own weight size: this is the
  // deterministic pair the KV reserve is supposed to distinguish, not a single case that can land
  // either way.
  const datacenterCard = () =>
    gpu({
      gpu_id: 'gpu-0',
      compute_capability: '9.0',
      total_vram_bytes: 85_899_345_920, // 80 GiB nominal
      free_vram_bytes: 85_532_850_176, // an H100 reports 81,559 MiB free (conf README note)
    })

  it('a 75 GB FP8 checkpoint on an 80 GB datacenter card fits once the KV reserve is added, with no consumer-card cap', () => {
    const descriptor = baseDescriptor()
    const selected = datacenterCard()
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'] },
      hf_quant_config_json: { quantization: { quant_algo: 'FP8' } },
      files: weightFiles(75_000_000_000),
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

    expect(result.quantization_format).toBe('fp8')
    expect(result.weight_bytes).toBe(75_000_000_000)
    expect(result.checked_gpu_id).toBe('gpu-0')
    // 75,000,000,000 + 10% reserve (7,500,000,000) = 82,500,000,000 < 85,532,850,176 free.
    expect(result.verdict).toEqual({ ok: true })
  })

  it('a 79 GB FP8 checkpoint on the same 80 GB datacenter card is a real, numbered shortage once the KV reserve is added', () => {
    const descriptor = baseDescriptor()
    const selected = datacenterCard()
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'] },
      hf_quant_config_json: { quantization: { quant_algo: 'FP8' } },
      files: weightFiles(79_000_000_000),
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

    expect(result.weight_bytes).toBe(79_000_000_000)
    // 79,000,000,000 + 10% reserve (7,900,000,000) = 86,900,000,000 > 85,532,850,176 free.
    expect(result.verdict).toEqual({
      ok: false,
      error: {
        code: 'MODEL_INCOMPATIBLE',
        message: 'The checkpoint plus the KV-cache reserve does not fit the selected GPU.',
        details:
          'weight_bytes=79000000000 kv_reserve_bytes=7900000000 needed_bytes=86900000000 free_bytes=85532850176',
      },
    })
  })

  it('the same 75 GB FP8 checkpoint that fits at the default 0.9 fraction becomes a real shortage at a lower configured fraction (more headroom requested)', () => {
    const descriptor = baseDescriptor()
    const selected = datacenterCard()
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'] },
      hf_quant_config_json: { quantization: { quant_algo: 'FP8' } },
      files: weightFiles(75_000_000_000),
    })

    const atDefault = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)
    expect(atDefault.verdict).toEqual({ ok: true })

    // 0.5 leaves half of post-weight memory unspent as headroom: reserve becomes 50% of weights
    // (37,500,000,000), so 75,000,000,000 + 37,500,000,000 = 112,500,000,000 > 85,532,850,176 free.
    const atLowerFraction = checkModelCompatibility(input, descriptor, [selected], 0, 0.5)
    expect(atLowerFraction.verdict.ok).toBe(false)
  })

  it("40 GB of weights: does not fit the selected card (22 GB free) but fits a second card (46 GB free), with the selected card's own numbers reported", () => {
    const descriptor = baseDescriptor()
    const selected = gpu({
      gpu_id: 'gpu-a',
      total_vram_bytes: 40_000_000_000,
      free_vram_bytes: 22_000_000_000,
    })
    const other = gpu({ gpu_id: 'gpu-b', total_vram_bytes: 46_000_000_000, free_vram_bytes: 46_000_000_000 })
    const input = baseInput({ files: weightFiles(40_000_000_000), gpu_id: 'gpu-a' })

    const result = checkModelCompatibility(input, descriptor, [selected, other], 0, 0.9)

    expect(result.checked_gpu_id).toBe('gpu-a')
    // 40,000,000,000 + 10% reserve (4,000,000,000) = 44,000,000,000 > 22,000,000,000 free on gpu-a.
    expect(result.verdict).toEqual({
      ok: false,
      error: {
        code: 'MODEL_INCOMPATIBLE',
        message: 'The checkpoint plus the KV-cache reserve does not fit the selected GPU.',
        details:
          'weight_bytes=40000000000 kv_reserve_bytes=4000000000 needed_bytes=44000000000 free_bytes=22000000000',
      },
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

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

    expect(result.quantization_format).toBe('fp8')
    expect(result.verdict).toEqual({ ok: true })
  })

  it('sm120 (12.0) with fp8_block_scales, an excluded compute capability above the format minimum — fits_other_gpus is still reported', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: '12.0' })
    // A second card whose CC (9.0) actually supports fp8_block_scales, with plenty of free memory.
    const other = gpu({
      gpu_id: 'gpu-1',
      compute_capability: '9.0',
      total_vram_bytes: 80_000_000_000,
      free_vram_bytes: 80_000_000_000,
    })
    const input = baseInput({
      config_json: {
        architectures: ['LlamaForCausalLM'],
        quantization_config: { quant_method: 'fp8', weight_block_size: [128, 128] },
      },
      gpu_id: 'gpu-0',
    })

    const result = checkModelCompatibility(input, descriptor, [selected, other], 0, 0.9)

    expect(result.quantization_format).toBe('fp8_block_scales')
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
      expect(result.verdict.error.message).toContain('not supported by this engine release')
      expect(result.verdict.error.details).toBe('format=fp8_block_scales compute_capability=12.0')
    }
    // Regression: fits_other_gpus must not be dropped just because the selected card failed on CC.
    expect(result.fits_other_gpus).toEqual(['gpu-1'])
  })

  it('NVFP4 on compute capability 8.9 is incompatible, reporting both the required and actual CC — fits_other_gpus is still reported', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: '8.9' })
    // A second card whose CC (10.0) actually supports NVFP4, with plenty of free memory.
    const other = gpu({
      gpu_id: 'gpu-1',
      compute_capability: '10.0',
      total_vram_bytes: 32_000_000_000,
      free_vram_bytes: 32_000_000_000,
    })
    const input = baseInput({
      config_json: {
        architectures: ['LlamaForCausalLM'],
        quantization_config: { quant_method: 'modelopt', quant_algo: 'NVFP4' },
      },
      gpu_id: 'gpu-0',
    })

    const result = checkModelCompatibility(input, descriptor, [selected, other], 0, 0.9)

    expect(result.quantization_format).toBe('nvfp4')
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.details).toBe('required=10.0 actual=8.9')
    }
    // Regression: fits_other_gpus was previously dropped on the min-CC failure branch.
    expect(result.fits_other_gpus).toEqual(['gpu-1'])
  })

  it('an unparseable compute capability is treated as incompatible, never as fail-open', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: 'unknown' })
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
      expect(result.verdict.error.details).toBe('required=8.0 actual=unknown')
    }
  })

  it('an unparseable compute capability on another card excludes it from fits_other_gpus too', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: '8.0' })
    const brokenReport = gpu({ gpu_id: 'gpu-1', compute_capability: 'unknown', total_vram_bytes: 999 })
    // Too small to fit regardless, so only the CC parsing bug could wrongly list it.
    const input = baseInput({ files: weightFiles(40_000_000_000) })

    const result = checkModelCompatibility(input, descriptor, [selected, brokenReport], 0, 0.9)

    expect(result.fits_other_gpus).toEqual([])
  })

  it('a checkpoint with no weight files at all is MODEL_INCOMPATIBLE, never a false ok', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({
      files: [
        { path: 'config.json', size: 1_024, sha256: null },
        { path: 'tokenizer.json', size: 17_000, sha256: null },
      ],
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

    expect(result.weight_bytes).toBe(0)
    expect(result.verdict).toEqual({
      ok: false,
      error: {
        code: 'MODEL_INCOMPATIBLE',
        message: 'No checkpoint weight files were found in the file listing.',
      },
    })
  })

  it('a format the naming rule does not recognise is rejected, naming what it saw', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({ config_json: { architectures: ['LlamaForCausalLM'], dtype: 'float32' } })

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

    expect(result.quantization_format).toBeNull()
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
      expect(result.verdict.error.message).toBe(
        'Unsupported quantization format: config.json dtype="float32".'
      )
    }
  })

  it('a format the naming rule recognises but this descriptor does not list is rejected by name', () => {
    // w4a16_awq is a real descriptor format (the published fixture lists it); this test descriptor
    // deliberately does not, so the naming rule succeeds but the descriptor lookup fails.
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'] },
      hf_quant_config_json: { quantization: { quant_algo: 'w4a16_awq' } },
    })

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

    expect(result.quantization_format).toBe('w4a16_awq')
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
      expect(result.verdict.error.details).toBe('w4a16_awq')
    }
  })

  it('the file listing names hf_quant_config.json but its content was not provided', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({
      hf_quant_config_json: null,
      files: [...weightFiles(4_000_000_000), { path: 'hf_quant_config.json', size: 200, sha256: null }],
    })

    expect(() => checkModelCompatibility(input, descriptor, [selected], 0, 0.9)).toThrow(AtomicCoreError)
    try {
      checkModelCompatibility(input, descriptor, [selected], 0, 0.9)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicCoreError)
      expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
    }
  })

  it('an unsupported architecture is rejected by name', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({ config_json: { architectures: ['GPT2LMHeadModel'], dtype: 'bfloat16' } })

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

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

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

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

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

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

    const fitsHost = checkModelCompatibility(input, descriptor, [selected], 20_000_000_000, 0.9)
    expect(fitsHost.unified_memory).toBe(true)
    expect(fitsHost.verdict).toEqual({ ok: true })

    const tooTightOnHost = checkModelCompatibility(input, descriptor, [selected], 1_000_000_000, 0.9)
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

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

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

    const result = checkModelCompatibility(input, descriptor, [selected], 0, 0.9)

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
    try {
      checkModelCompatibility(baseInput(), descriptor, [], 0, 0.9)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicCoreError)
      expect((error as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
    }
  })
})

describe('selectLaunchGpu', () => {
  const a = gpu({ gpu_id: 'a', total_vram_bytes: 24_000_000_000 })
  const b = gpu({ gpu_id: 'b', total_vram_bytes: 80_000_000_000 })
  const unified = gpu({ gpu_id: 'u', total_vram_bytes: null, free_vram_bytes: null })

  it('picks gpu_id when given and present on the host', () => {
    expect(selectLaunchGpu([a, b], 'a')?.gpu_id).toBe('a')
  })

  it('breaks a tie in total memory by keeping the earlier candidate, deterministically', () => {
    const tiedA = gpu({ gpu_id: 'tied-a', total_vram_bytes: 24_000_000_000 })
    const tiedB = gpu({ gpu_id: 'tied-b', total_vram_bytes: 24_000_000_000 })
    expect(selectLaunchGpu([tiedA, tiedB])?.gpu_id).toBe('tied-a')
    expect(selectLaunchGpu([tiedB, tiedA])?.gpu_id).toBe('tied-b')
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

describe('isWeightFile', () => {
  const file = (path: string, size: number): CheckpointFile => ({ path, size, sha256: null })

  it('is true only for a root-level, non-consolidated *.safetensors file, when a preferred shard sits next to it', () => {
    const files = [
      file('model-00001-of-00002.safetensors', 100),
      file('model-00002-of-00002.safetensors', 100),
      file('consolidated.safetensors', 200),
      file('config.json', 5),
    ]
    expect(isWeightFile('model-00001-of-00002.safetensors', files)).toBe(true)
    expect(isWeightFile('config.json', files)).toBe(false)
    expect(isWeightFile('consolidated.safetensors', files)).toBe(false)
  })

  it('a single model.safetensors is a weight file', () => {
    const files = [file('model.safetensors', 100), file('config.json', 5)]
    expect(isWeightFile('model.safetensors', files)).toBe(true)
  })

  it('pytorch_model.bin is never a weight file while a safetensors file is present', () => {
    const files = [file('model.safetensors', 100), file('pytorch_model.bin', 100)]
    expect(isWeightFile('pytorch_model.bin', files)).toBe(false)
  })

  it('a safetensors file inside a subdirectory is never a weight file', () => {
    const files = [file('variant/model.safetensors', 100), file('config.json', 5)]
    expect(isWeightFile('variant/model.safetensors', files)).toBe(false)
  })

  it('matches the extension case-insensitively', () => {
    const files = [file('model.SAFETENSORS', 100)]
    expect(isWeightFile('model.SAFETENSORS', files)).toBe(true)
  })

  it('regression: agrees with weightBytes for a consolidated-only repository (no HF shard naming)', () => {
    const files = [file('consolidated.safetensors', 5_000), file('params.json', 2)]
    expect(isWeightFile('consolidated.safetensors', files)).toBe(true)
    expect(weightBytes(files)).toBe(5_000)
  })
})

describe('weightBytes', () => {
  const file = (path: string, size: number): CheckpointFile => ({ path, size, sha256: null })

  it('sums ordinary sharded safetensors, ignoring non-weight files', () => {
    const files = [
      file('model-00001-of-00002.safetensors', 100),
      file('model-00002-of-00002.safetensors', 200),
      file('config.json', 5),
      file('tokenizer.json', 6),
    ]
    expect(weightBytes(files)).toBe(300)
  })

  it('sums a single-file model.safetensors checkpoint', () => {
    expect(weightBytes([file('model.safetensors', 4_000), file('config.json', 5)])).toBe(4_000)
  })

  it('regression: a Mistral-style repo with both standard shards and a redundant consolidated.safetensors is not double-counted', () => {
    const files = [
      file('model-00001-of-00003.safetensors', 1_000),
      file('model-00002-of-00003.safetensors', 1_000),
      file('model-00003-of-00003.safetensors', 1_000),
      file('consolidated.safetensors', 3_000), // the same weights again, in one file
      file('params.json', 2),
    ]
    expect(weightBytes(files)).toBe(3_000)
  })

  it('falls back to a consolidated*.safetensors file when it is the only safetensors present', () => {
    expect(weightBytes([file('consolidated.safetensors', 5_000), file('params.json', 2)])).toBe(5_000)
  })

  it('regression: a .bin/.pth-only checkpoint reports its real byte count, not 0', () => {
    const files = [
      file('pytorch_model-00001-of-00002.bin', 1_500),
      file('pytorch_model-00002-of-00002.bin', 1_500),
      file('config.json', 5),
    ]
    expect(weightBytes(files)).toBe(3_000)
  })

  it('sums a single legacy .pth checkpoint when there is no safetensors file at all', () => {
    expect(weightBytes([file('model.pth', 2_500), file('config.json', 5)])).toBe(2_500)
  })

  it('prefers safetensors over a legacy .bin sitting alongside it', () => {
    const files = [file('model.safetensors', 900), file('pytorch_model.bin', 900), file('config.json', 5)]
    expect(weightBytes(files)).toBe(900)
  })

  it('ignores a safetensors file inside a subdirectory (root-level files only)', () => {
    const files = [file('fp8-variant/model.safetensors', 4_000), file('config.json', 5)]
    expect(weightBytes(files)).toBe(0)
  })

  it('is 0 for a listing with no weight file at all', () => {
    expect(weightBytes([file('config.json', 5), file('tokenizer.json', 6)])).toBe(0)
    expect(weightBytes([])).toBe(0)
  })
})

describe('kvCacheReserveBytes', () => {
  it('is weight bytes times (1 - kv_cache_free_gpu_memory_fraction)', () => {
    expect(kvCacheReserveBytes(100_000_000_000, 0.9)).toBe(10_000_000_000)
    expect(kvCacheReserveBytes(100_000_000_000, 0.5)).toBe(50_000_000_000)
  })

  it('a higher configured fraction (more of what is left spent on KV) shrinks the reserve; a lower one grows it', () => {
    const low = kvCacheReserveBytes(100_000_000_000, 0.1) // TENSORRT_LLM_MIN_KV_CACHE_FREE_FRACTION
    const high = kvCacheReserveBytes(100_000_000_000, 0.95) // TENSORRT_LLM_MAX_KV_CACHE_FREE_FRACTION
    expect(high).toBeLessThan(low)
  })

  it('rounds up so a reserve is never under-counted', () => {
    expect(kvCacheReserveBytes(1, 0.9)).toBe(1)
  })
})
