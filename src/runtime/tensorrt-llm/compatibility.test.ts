import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, RuntimeDescriptor, Sha256Digest } from '../../contracts/index.js'
import { inventoryDigest, parseNvidiaSmi, parseRuntimeDescriptor } from '../environment/index.js'
import {
  filesFromHfSiblings,
  hfListingFixtureName,
  readHfListingFixture,
  type HfListing,
} from '../../../test/helpers/hf-listing-fixtures.js'
import { readLinuxProbeFixture } from '../../../test/helpers/linux-probe-fixtures.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseMemAvailableBytes } from './host-facts.js'
import type { JsonObject } from './quant-format.js'
import {
  checkModelCompatibility,
  checkModelCompatibilityFiles,
  checkModelMemory,
  kvCacheBytes,
  kvCacheReserveBytes,
  selectLaunchGpu,
  weightBytes,
  type CheckpointFile,
  type HostMemory,
  type ModelCheckInput,
} from './compatibility.js'
import { TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION } from './kv-cache.js'

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

/** The host's memory with `MemAvailable` = `bytes`; `MemTotal` only ranks cards, it never sizes a check. */
const memAvailable = (bytes: number): HostMemory => ({ availableBytes: bytes, totalBytes: bytes })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

    expect(result.weight_bytes).toBe(79_000_000_000)
    // No KV-cache shape in config.json: falls back to the weight-proportional rule.
    // 79,000,000,000 + 10% reserve (7,900,000,000) = 86,900,000,000 > 85,532,850,176 free.
    expect(result.kv_reserve_basis).toBe('weight_fraction')
    expect(result.verdict).toEqual({
      ok: false,
      error: {
        code: 'MODEL_INCOMPATIBLE',
        message: 'The checkpoint plus the KV-cache reserve does not fit the selected GPU.',
        details:
          'weight_bytes=79000000000 kv_reserve_bytes=7900000000 kv_reserve_basis=weight_fraction needed_bytes=86900000000 free_bytes=85532850176',
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

    const atDefault = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })
    expect(atDefault.verdict).toEqual({ ok: true })

    // 0.5 leaves half of post-weight memory unspent as headroom: reserve becomes 50% of weights
    // (37,500,000,000), so 75,000,000,000 + 37,500,000,000 = 112,500,000,000 > 85,532,850,176 free.
    const atLowerFraction = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.5,
    })
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

    const result = checkModelCompatibility(input, descriptor, [selected, other], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

    expect(result.checked_gpu_id).toBe('gpu-a')
    // 40,000,000,000 + 10% reserve (4,000,000,000) = 44,000,000,000 > 22,000,000,000 free on gpu-a.
    expect(result.verdict).toEqual({
      ok: false,
      error: {
        code: 'MODEL_INCOMPATIBLE',
        message: 'The checkpoint plus the KV-cache reserve does not fit the selected GPU.',
        details:
          'weight_bytes=40000000000 kv_reserve_bytes=4000000000 kv_reserve_basis=weight_fraction needed_bytes=44000000000 free_bytes=22000000000',
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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected, other], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected, other], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected, brokenReport], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    expect(() =>
      checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
        contextLength: 8192,
        kvCacheFreeGpuMemoryFraction: 0.9,
      })
    ).toThrow(AtomicCoreError)
    try {
      checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
        contextLength: 8192,
        kvCacheFreeGpuMemoryFraction: 0.9,
      })
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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

    expect(result.verdict.ok).toBe(false)
  })

  it('unified memory: a card with no VRAM of its own is compared against host MemAvailable and flagged', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({
      gpu_id: 'gb10',
      compute_capability: '12.1',
      total_vram_bytes: null,
      free_vram_bytes: null,
    })
    const input = baseInput({ files: weightFiles(4_000_000_000) })

    const fitsHost = checkModelCompatibility(input, descriptor, [selected], memAvailable(20_000_000_000), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })
    expect(fitsHost.unified_memory).toBe(true)
    expect(fitsHost.verdict).toEqual({ ok: true })

    const tooTightOnHost = checkModelCompatibility(
      input,
      descriptor,
      [selected],
      memAvailable(1_000_000_000),
      {
        contextLength: 8192,
        kvCacheFreeGpuMemoryFraction: 0.9,
      }
    )
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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

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

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

    expect(result.curated).toBe(false)
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) {
      expect(result.verdict.error.code).toBe('MANAGED_METADATA_INVALID')
      expect(result.verdict.error.details).toContain(`expected=${curatedDigest}`)
      expect(result.verdict.error.details).toContain('actual=sha256:')
    }
  })

  it('throws MANAGED_PREREQUISITE_BLOCKED when the host has no GPU at all (an absent/failing nvidia-smi is a missing prerequisite, not a bad request)', () => {
    const descriptor = baseDescriptor()
    try {
      checkModelCompatibility(baseInput(), descriptor, [], memAvailable(0), {
        contextLength: 8192,
        kvCacheFreeGpuMemoryFraction: 0.9,
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicCoreError)
      expect((error as AtomicCoreError).code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    }
  })
})

describe('selectLaunchGpu', () => {
  const GiB = 1024 ** 3
  const card = (gpu_id: string, totalGiB: number | null, freeGiB: number | null): GpuFacts =>
    gpu({
      gpu_id,
      total_vram_bytes: totalGiB === null ? null : totalGiB * GiB,
      free_vram_bytes: freeGiB === null ? null : freeGiB * GiB,
    })
  const NO_HOST_MEMORY: HostMemory = { availableBytes: 0, totalBytes: 0 }
  const host = (availableGiB: number, totalGiB: number): HostMemory => ({
    availableBytes: availableGiB * GiB,
    totalBytes: totalGiB * GiB,
  })

  // Spec "Выбор карты и настройки провайдера" / design D12b: the most FREE memory, ties by the most
  // TOTAL memory, a full tie by the order nvidia-smi lists the cards in (its index).
  const cases: Array<{
    name: string
    gpus: GpuFacts[]
    host?: HostMemory
    gpuId?: string
    expected: string | null
  }> = [
    {
      name: 'spec scenario: two 24 GB cards, the desktop one with 19 GB free, the other 23.5 GB free',
      gpus: [card('desktop', 24, 19), card('idle', 24, 23.5)],
      expected: 'idle',
    },
    {
      name: 'the most free memory wins over the most total memory',
      gpus: [card('big-busy', 80, 10), card('small-idle', 24, 23)],
      expected: 'small-idle',
    },
    {
      name: 'equal free memory: the most total memory wins',
      gpus: [card('small', 24, 20), card('big', 48, 20)],
      expected: 'big',
    },
    {
      name: 'equal free memory, listed the other way round: still the most total memory',
      gpus: [card('big', 48, 20), card('small', 24, 20)],
      expected: 'big',
    },
    {
      name: 'a full tie resolves to the card nvidia-smi lists first',
      gpus: [card('first', 24, 20), card('second', 24, 20)],
      expected: 'first',
    },
    {
      name: 'a full tie, listed the other way round: again the first listed',
      gpus: [card('second', 24, 20), card('first', 24, 20)],
      expected: 'second',
    },
    { name: 'a single card is selected', gpus: [card('only', 24, 1)], expected: 'only' },
    { name: 'no card at all: null', gpus: [], expected: null },
    {
      name: 'a discrete card whose free memory is unreported ranks as 0 free',
      gpus: [card('unreported', 80, null), card('reported', 24, 1)],
      expected: 'reported',
    },
    {
      name: 'a unified-memory card ranks by MemAvailable: more than a discrete card has free',
      gpus: [card('discrete', 24, 20), card('unified', null, null)],
      host: host(100, 120),
      expected: 'unified',
    },
    {
      name: 'a unified-memory card ranks by MemAvailable: less than a discrete card has free',
      gpus: [card('unified', null, null), card('discrete', 24, 20)],
      host: host(10, 120),
      expected: 'discrete',
    },
    {
      name: 'a unified-memory card tied on free memory ranks by MemTotal',
      gpus: [card('discrete', 24, 20), card('unified', null, null)],
      host: host(20, 120),
      expected: 'unified',
    },
    {
      name: 'a unified-memory card on a host whose /proc/meminfo could not be read ranks as 0',
      gpus: [card('unified', null, null), card('discrete', 24, 1)],
      expected: 'discrete',
    },
    {
      name: 'a lone unified-memory card is selected even with no host memory figures',
      gpus: [card('unified', null, null)],
      expected: 'unified',
    },
    {
      name: 'gpu_id present on the host wins over the rule',
      gpus: [card('desktop', 24, 19), card('idle', 24, 23.5)],
      gpuId: 'desktop',
      expected: 'desktop',
    },
    {
      name: 'gpu_id no longer on the host falls back to the rule',
      gpus: [card('desktop', 24, 19), card('idle', 24, 23.5)],
      gpuId: 'gone',
      expected: 'idle',
    },
  ]

  it.each(cases)('$name', ({ gpus, host: hostMemory, gpuId, expected }) => {
    expect(selectLaunchGpu(gpus, hostMemory ?? NO_HOST_MEMORY, gpuId)?.gpu_id ?? null).toBe(expected)
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

// Llama-3-8B's own real shape (GQA: 8 KV heads out of 32 query heads, head_dim 128 — standard
// 4096/32) and a 70B-class shape, for the KV-formula tests below (task 2.16w round 1, finding 6).
const LLAMA_3_8B_SHAPE = {
  num_hidden_layers: 32,
  num_attention_heads: 32,
  num_key_value_heads: 8,
  hidden_size: 4096,
}
const SEVENTY_B_SHAPE = {
  num_hidden_layers: 80,
  num_attention_heads: 64,
  num_key_value_heads: 8,
  hidden_size: 8192,
}

describe('kvCacheBytes', () => {
  it('is 2 x layers x kv_heads x head_dim x dtype_bytes x context_length, bf16 (2 bytes) by default', () => {
    // 2 * 32 * 8 * 128 * 2 * 8192 = 1,073,741,824
    expect(kvCacheBytes({ ...LLAMA_3_8B_SHAPE, dtype: 'bfloat16' }, null, 8192)).toBe(1_073_741_824)
  })

  it('uses head_dim directly when config.json spells it out, instead of deriving it', () => {
    const shape = { num_hidden_layers: 1, num_attention_heads: 1, num_key_value_heads: 1, head_dim: 64 }
    // 2 * 1 * 1 * 64 * 2 * 1 = 256
    expect(kvCacheBytes(shape, null, 1)).toBe(256)
  })

  it('falls back num_key_value_heads to num_attention_heads (plain multi-head attention, no GQA field)', () => {
    const shape = { num_hidden_layers: 1, num_attention_heads: 4, head_dim: 64 }
    // 2 * 1 * 4 * 64 * 2 * 1 = 1024
    expect(kvCacheBytes(shape, null, 1)).toBe(1_024)
  })

  it('is 1 byte per KV element when kv_cache_quant_algo is FP8', () => {
    const withFp8Kv = {
      ...LLAMA_3_8B_SHAPE,
      quantization_config: { quant_method: 'fp8', kv_cache_quant_algo: 'FP8' },
    }
    // Half of the bf16 case above: 536,870,912
    expect(kvCacheBytes(withFp8Kv, null, 8192)).toBe(536_870_912)
  })

  it('is undefined when config.json lacks num_hidden_layers, or every head/dim fallback', () => {
    expect(kvCacheBytes({ num_attention_heads: 32, hidden_size: 4096 }, null, 8192)).toBeUndefined()
    expect(kvCacheBytes({ num_hidden_layers: 32 }, null, 8192)).toBeUndefined()
  })

  it('treats a zero or negative field as absent, never as a zero-sized (and so free) KV cache', () => {
    expect(kvCacheBytes({ ...LLAMA_3_8B_SHAPE, num_hidden_layers: 0 }, null, 8192)).toBeUndefined()
    expect(kvCacheBytes({ ...LLAMA_3_8B_SHAPE, num_hidden_layers: -1 }, null, 8192)).toBeUndefined()
  })
})

describe('kvCacheReserveBytes', () => {
  it('is KV_bytes / kv_cache_free_gpu_memory_fraction when config.json has a real KV-cache shape ("config" basis)', () => {
    // kvCacheBytes = 1,073,741,824 (see above); / 0.9 = 1,193,046,471.1 -> ceil.
    const { reserveBytes, basis } = kvCacheReserveBytes(
      16_000_000_000,
      { ...LLAMA_3_8B_SHAPE, dtype: 'bfloat16' },
      null,
      8192,
      0.9,
      false
    )
    expect(basis).toBe('config')
    expect(reserveBytes).toBe(1_193_046_472)
  })

  it('falls back to weights x (1 - fraction) when config.json lacks a KV-cache shape ("weight_fraction" basis)', () => {
    const { reserveBytes, basis } = kvCacheReserveBytes(100_000_000_000, {}, null, 8192, 0.9, false)
    expect(basis).toBe('weight_fraction')
    expect(reserveBytes).toBe(10_000_000_000)
  })

  it('a higher configured fraction shrinks the fallback reserve; a lower one grows it', () => {
    const low = kvCacheReserveBytes(100_000_000_000, {}, null, 8192, 0.1, false).reserveBytes // MIN fraction
    const high = kvCacheReserveBytes(100_000_000_000, {}, null, 8192, 0.95, false).reserveBytes // MAX fraction
    expect(high).toBeLessThan(low)
  })

  it('a higher configured fraction shrinks the config-basis reserve too (more of what is left spent on KV)', () => {
    const low = kvCacheReserveBytes(16_000_000_000, LLAMA_3_8B_SHAPE, null, 8192, 0.1, false).reserveBytes
    const high = kvCacheReserveBytes(16_000_000_000, LLAMA_3_8B_SHAPE, null, 8192, 0.95, false).reserveBytes
    expect(high).toBeLessThan(low)
  })

  it('rounds up so a reserve is never under-counted, on both bases', () => {
    expect(kvCacheReserveBytes(1, {}, null, 8192, 0.9, false).reserveBytes).toBe(1)
    expect(
      kvCacheReserveBytes(1, LLAMA_3_8B_SHAPE, null, 1, 0.9999999, false).reserveBytes
    ).toBeGreaterThanOrEqual(1)
  })

  it('on a unified-memory card is the KV for two full contexts, never divided by the fraction (the launch bounds it by tokens)', () => {
    const shape = { ...LLAMA_3_8B_SHAPE, dtype: 'bfloat16' }
    const expected = kvCacheBytes(shape, null, 2 * 8192) as number
    for (const fraction of [0.1, 0.8, 0.95]) {
      expect(kvCacheReserveBytes(16_000_000_000, shape, null, 8192, fraction, true)).toEqual({
        reserveBytes: expected,
        basis: 'config',
      })
    }
    expect(expected).toBe(2_147_483_648)
  })

  it('on a unified-memory card without a KV shape falls back exactly as a discrete card does', () => {
    expect(kvCacheReserveBytes(100_000_000_000, {}, null, 8192, 0.8, true)).toEqual(
      kvCacheReserveBytes(100_000_000_000, {}, null, 8192, 0.8, false)
    )
  })
})

describe('the 2026-09-29 VM run: Qwen3-1.7B bf16 on an RTX 4070 Laptop (7.70 GiB visible), context 4096', () => {
  // Qwen3-1.7B's config.json: 28 layers, 8 KV heads, head_dim 128, bf16 KV cache. KV_bytes at 4096
  // tokens = 2 x 28 x 8 x 128 x 2 x 4096 = 469,762,048. Weights: the Hugging Face listing's ~4.06 GB.
  const QWEN3_1_7B_SHAPE = {
    num_hidden_layers: 28,
    num_attention_heads: 16,
    num_key_value_heads: 8,
    head_dim: 128,
    hidden_size: 2048,
  }
  const WEIGHTS = 4_063_866_880
  const card = gpu({
    gpu_id: 'gpu-0',
    compute_capability: '8.9',
    total_vram_bytes: 8_267_812_045, // 7.70 GiB, what the guest saw
    free_vram_bytes: 8_267_812_045,
  })

  it.each<[string, number, number]>([
    // The default the launch now passes, and the reserve the check sizes with it.
    [
      'the default fraction (0.8, launched and checked alike)',
      TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
      587_202_560,
    ],
    // What the core launched with in the live run: the load ran out of memory on this card.
    ['the old 0.9', 0.9, 521_957_832],
  ])('%s', (_label, fraction, reserve) => {
    expect(kvCacheReserveBytes(WEIGHTS, QWEN3_1_7B_SHAPE, null, 4096, fraction, false)).toEqual({
      reserveBytes: reserve,
      basis: 'config',
    })
    // The check says "fits" at both fractions: it sizes the KV cache the model needs, not the
    // engine's own non-KV allocations, which is why the launch fraction itself had to leave more room.
    const result = checkModelCompatibility(
      baseInput({
        config_json: { architectures: ['Qwen3ForCausalLM'], dtype: 'bfloat16', ...QWEN3_1_7B_SHAPE },
        files: weightFiles(WEIGHTS),
      }),
      baseDescriptor(),
      [card],
      memAvailable(0),
      { contextLength: 4096, kvCacheFreeGpuMemoryFraction: fraction }
    )
    expect(result.verdict).toEqual({ ok: true })
  })

  it('the weight-fraction fallback follows the same default: 20% of the weights at 0.8', () => {
    expect(
      kvCacheReserveBytes(WEIGHTS, {}, null, 4096, TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION, false)
    ).toEqual({
      reserveBytes: Math.ceil(WEIGHTS * (1 - 0.8)),
      basis: 'weight_fraction',
    })
  })
})

describe('checkModelCompatibility: the real KV-cache formula (finding 6)', () => {
  it('a 75 GB FP8 checkpoint (70B-class shape) still fits an 80 GB datacenter card at the default context length', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({
      gpu_id: 'gpu-0',
      compute_capability: '9.0',
      total_vram_bytes: 85_899_345_920,
      free_vram_bytes: 85_532_850_176, // an H100 reports 81,559 MiB free (conf README note)
    })
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'], ...SEVENTY_B_SHAPE },
      hf_quant_config_json: { quantization: { quant_algo: 'FP8' } },
      files: weightFiles(75_000_000_000),
    })

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

    expect(result.kv_reserve_basis).toBe('config')
    expect(result.verdict).toEqual({ ok: true })
  })

  it('an 8B bf16 checkpoint at a 128k context is refused on a 24 GB card, even though the weights alone would fit', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: '8.9', free_vram_bytes: 24_000_000_000 })
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16', ...LLAMA_3_8B_SHAPE },
      files: weightFiles(16_000_000_000), // ~8B params at bf16 (2 bytes/param)
    })

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 131_072,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

    expect(result.kv_reserve_basis).toBe('config')
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) expect(result.verdict.error.code).toBe('MODEL_INCOMPATIBLE')
  })

  it('the same 8B checkpoint at a short context comfortably fits the same 24 GB card', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0', compute_capability: '8.9', free_vram_bytes: 24_000_000_000 })
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16', ...LLAMA_3_8B_SHAPE },
      files: weightFiles(16_000_000_000),
    })

    const result = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), {
      contextLength: 8192,
      kvCacheFreeGpuMemoryFraction: 0.9,
    })

    expect(result.verdict).toEqual({ ok: true })
  })
})

describe('checkModelCompatibilityFiles / checkModelMemory: the pre-launch split (finding 1, Critical)', () => {
  const memory = { contextLength: 8192, kvCacheFreeGpuMemoryFraction: 0.9 }

  it("checkModelCompatibilityFiles passes without ever looking at the selected card's free memory", () => {
    const descriptor = baseDescriptor()
    // A card reporting 0 free memory: if the files-only check consulted it at all, this would fail.
    const starved = gpu({ gpu_id: 'gpu-0', free_vram_bytes: 0 })
    const input = baseInput({ files: weightFiles(75_000_000_000) })

    const result = checkModelCompatibilityFiles(input, descriptor, [starved], memAvailable(0), memory)

    expect(result.ok).toBe(true)
  })

  it('checkModelCompatibilityFiles still fails architecture/format/CC checks the same way the combined check does', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({ config_json: { architectures: ['GPT2LMHeadModel'], dtype: 'bfloat16' } })

    const result = checkModelCompatibilityFiles(input, descriptor, [selected], memAvailable(0), memory)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.verdict.verdict.ok).toBe(false)
      if (!result.verdict.verdict.ok)
        expect(result.verdict.verdict.error.message).toContain('GPT2LMHeadModel')
    }
  })

  it("checkModelMemory alone re-reads the selected card's free memory from whatever gpus[] it is given, resolving switching a single-GPU host from one model to another", () => {
    const descriptor = baseDescriptor()
    const input = baseInput({
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
      files: weightFiles(20_000_000_000),
    })

    // A stale snapshot, taken while a previous model still holds the card: not enough free memory.
    const staleGpu = gpu({ gpu_id: 'gpu-0', free_vram_bytes: 1_000_000_000 })
    const filesResult = checkModelCompatibilityFiles(input, descriptor, [staleGpu], memAvailable(0), memory)
    expect(filesResult.ok).toBe(true)
    if (!filesResult.ok) throw new Error('unreachable')

    const staleMemory = checkModelMemory(
      filesResult.resolved,
      descriptor,
      [staleGpu],
      memAvailable(0),
      memory
    )
    expect(staleMemory.verdict.ok).toBe(false)

    // The previous model was stopped: a fresh probe of the same card reports it free now.
    const freedGpu = gpu({ gpu_id: 'gpu-0', free_vram_bytes: 24_000_000_000 })
    const freshMemory = checkModelMemory(
      filesResult.resolved,
      descriptor,
      [freedGpu],
      memAvailable(0),
      memory
    )
    expect(freshMemory.verdict).toEqual({ ok: true })
  })

  it('checkModelCompatibility (the combined /check route call) equals checkModelCompatibilityFiles then checkModelMemory on the same snapshot', () => {
    const descriptor = baseDescriptor()
    const selected = gpu({ gpu_id: 'gpu-0' })
    const input = baseInput({ files: weightFiles(75_000_000_000) })

    const combined = checkModelCompatibility(input, descriptor, [selected], memAvailable(0), memory)
    const files = checkModelCompatibilityFiles(input, descriptor, [selected], memAvailable(0), memory)
    expect(files.ok).toBe(true)
    if (!files.ok) throw new Error('unreachable')
    const split = checkModelMemory(files.resolved, descriptor, [selected], memAvailable(0), memory)

    expect(combined).toEqual(split)
  })
})

/**
 * The three hardware targets that are not live-tested (GB10/DGX Spark, GH200, RTX 5090), walked
 * through the published descriptor (`test/fixtures/runtimes/tensorrt-llm.json`) and the curated
 * repositories' real Hugging Face listings. Card data: GB10 captured on a DGX Spark-class host
 * (`nvidia-smi` with core's own query, `/proc/meminfo`'s head); GH200 and RTX 5090 documented, not
 * captured. `config.json` shapes and `hf_quant_config.json` bodies are the repositories' published
 * values, documented, not captured; the KV cache is sized at 2 bytes (no `kv_cache_quant_algo`), the
 * conservative case.
 */
describe('target hosts: format rules and the curated tier model, on the published descriptor', () => {
  const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))
  const cardFrom = (fixture: string): GpuFacts => {
    const { gpus } = parseNvidiaSmi({ code: 0, stdout: readLinuxProbeFixture(fixture), stderr: '' })
    return gpus[0] as GpuFacts
  }
  const GB10 = cardFrom('nvidia-smi/gb10-driver595-captured.csv')
  const GH200 = cardFrom('nvidia-smi/gh200-documented.csv')
  const RTX5090 = cardFrom('nvidia-smi/rtx5090-documented.csv')
  const GB10_MEM_AVAILABLE = parseMemAvailableBytes(
    readLinuxProbeFixture('meminfo/gb10-captured-head.txt')
  ) as number
  /** A discrete card's check never reads host memory; a large value proves it. */
  const DISCRETE_HOST_MEM = 400 * 1024 ** 3
  const sizing = {
    contextLength: 8192,
    kvCacheFreeGpuMemoryFraction: TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
  }

  const formatInput = (format: string): ModelCheckInput =>
    format === 'bf16'
      ? baseInput({ files: weightFiles(1_000_000_000) })
      : baseInput({
          config_json: { architectures: ['LlamaForCausalLM'] },
          hf_quant_config_json: { quantization: { quant_algo: format.toUpperCase() } },
          files: [...weightFiles(1_000_000_000), { path: 'hf_quant_config.json', size: 200, sha256: null }],
        })

  // [format, GB10 12.1, GH200 9.0, RTX 5090 12.0]
  it.each<[string, boolean, boolean, boolean]>([
    ['bf16', true, true, true],
    ['fp16', true, true, true],
    ['w4a16_awq', false, true, false],
    ['fp8', true, true, true],
    ['w4a8_awq', false, true, false],
    ['fp8_block_scales', false, true, false],
    ['fp8_per_channel_per_token', false, true, false],
    ['nvfp4', true, false, true],
    ['mxfp4', true, false, true],
  ])('%s: GB10 %s, GH200 %s, RTX 5090 %s', (format, gb10, gh200, rtx5090) => {
    for (const [card, expected, hostMem] of [
      [GB10, gb10, GB10_MEM_AVAILABLE],
      [GH200, gh200, DISCRETE_HOST_MEM],
      [RTX5090, rtx5090, DISCRETE_HOST_MEM],
    ] as const) {
      const verdict = checkModelCompatibility(
        formatInput(format),
        descriptor,
        [card],
        memAvailable(hostMem),
        sizing
      ).verdict
      expect({ card: card.name, ok: verdict.ok }).toEqual({ card: card.name, ok: expected })
      if (!verdict.ok) expect(verdict.error.code).toBe('MODEL_INCOMPATIBLE')
    }
  })

  const curatedInput = (
    repository: string,
    config: JsonObject,
    hfQuantConfig: JsonObject | null
  ): ModelCheckInput => {
    const listing = readHfListingFixture(hfListingFixtureName(repository)) as HfListing
    return {
      repository,
      revision: listing.sha,
      config_json: config,
      hf_quant_config_json: hfQuantConfig,
      files: filesFromHfSiblings(listing.siblings).map((file) => ({
        path: file.path,
        size: file.bytes,
        sha256: file.sha256 ?? null,
      })),
    }
  }
  const LLAMA_70B_NVFP4 = curatedInput(
    'nvidia/Llama-3.3-70B-Instruct-NVFP4',
    {
      architectures: ['LlamaForCausalLM'],
      num_hidden_layers: 80,
      num_attention_heads: 64,
      num_key_value_heads: 8,
      hidden_size: 8192,
      torch_dtype: 'bfloat16',
    },
    { quantization: { quant_algo: 'NVFP4', group_size: 16, exclude_modules: ['lm_head'] } }
  )
  const NEMOTRON_NANO_FP8 = curatedInput(
    'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8',
    {
      architectures: ['NemotronHForCausalLM'],
      num_hidden_layers: 52,
      num_attention_heads: 32,
      num_key_value_heads: 2,
      head_dim: 128,
      hidden_size: 2688,
      torch_dtype: 'bfloat16',
    },
    { quantization: { quant_algo: 'FP8' } }
  )
  const QWEN3_32B_NVFP4 = curatedInput(
    'nvidia/Qwen3-32B-NVFP4',
    {
      architectures: ['Qwen3ForCausalLM'],
      num_hidden_layers: 64,
      num_attention_heads: 64,
      num_key_value_heads: 8,
      head_dim: 128,
      hidden_size: 5120,
      torch_dtype: 'bfloat16',
    },
    { quantization: { quant_algo: 'NVFP4', group_size: 16, exclude_modules: ['lm_head'] } }
  )

  it('GB10: its tier model (80 GB tier, NVFP4) is curated, checked against MemAvailable, and fits', () => {
    const result = checkModelCompatibility(
      LLAMA_70B_NVFP4,
      descriptor,
      [GB10],
      memAvailable(GB10_MEM_AVAILABLE),
      sizing
    )
    expect(result).toMatchObject({
      curated: true,
      unified_memory: true,
      quantization_format: 'nvfp4',
      checked_gpu_id: 'GPU-d991dc71-7825-0bf8-3339-cb2e7ead6a32',
      kv_reserve_basis: 'config',
      verdict: { ok: true },
    })
  })

  it('GB10: with less MemAvailable than the weights, the same model is refused with the host numbers', () => {
    const result = checkModelCompatibility(
      LLAMA_70B_NVFP4,
      descriptor,
      [GB10],
      memAvailable(30 * 1024 ** 3),
      sizing
    )
    expect(result.verdict.ok).toBe(false)
    if (!result.verdict.ok) expect(result.verdict.error.details).toContain(`free_bytes=${30 * 1024 ** 3}`)
  })

  it('GH200: the 80 GB tier (NVFP4) is refused on 9.0, its 48 GB tier model (FP8) fits in HBM', () => {
    const nvfp4 = checkModelCompatibility(
      LLAMA_70B_NVFP4,
      descriptor,
      [GH200],
      memAvailable(DISCRETE_HOST_MEM),
      sizing
    )
    expect(nvfp4.verdict.ok).toBe(false)
    if (!nvfp4.verdict.ok) expect(nvfp4.verdict.error.details).toBe('required=10.0 actual=9.0')
    const fp8 = checkModelCompatibility(
      NEMOTRON_NANO_FP8,
      descriptor,
      [GH200],
      memAvailable(DISCRETE_HOST_MEM),
      sizing
    )
    expect(fp8).toMatchObject({
      curated: true,
      unified_memory: false,
      quantization_format: 'fp8',
      verdict: { ok: true },
    })
  })

  it('RTX 5090: its tier model (32 GB tier, NVFP4) is curated and fits its 32 GB', () => {
    const result = checkModelCompatibility(
      QWEN3_32B_NVFP4,
      descriptor,
      [RTX5090],
      memAvailable(DISCRETE_HOST_MEM),
      sizing
    )
    expect(result).toMatchObject({
      curated: true,
      unified_memory: false,
      quantization_format: 'nvfp4',
      verdict: { ok: true },
    })
  })
})

describe('checkModelMemory on a unified-memory card: the same bound the launch writes (weights + KV for two contexts)', () => {
  const descriptor = baseDescriptor()
  const shape = { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16', ...LLAMA_3_8B_SHAPE }
  const weights = 16_000_000_000
  const kv = kvCacheBytes(shape, null, 2 * 8192) as number
  const memory = {
    contextLength: 8192,
    kvCacheFreeGpuMemoryFraction: TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
  }
  const gb10 = gpu({
    gpu_id: 'GPU-gb10',
    compute_capability: '12.1',
    total_vram_bytes: null,
    free_vram_bytes: null,
  })
  const input = baseInput({ config_json: shape, files: weightFiles(weights) })

  it('fits at exactly weights + KV(2 x context) of MemAvailable, and is refused one byte below', () => {
    const files = checkModelCompatibilityFiles(input, descriptor, [gb10], memAvailable(0), memory)
    if (!files.ok) throw new Error('expected the files check to pass')
    expect(
      checkModelMemory(files.resolved, descriptor, [gb10], memAvailable(weights + kv), memory).verdict
    ).toEqual({
      ok: true,
    })
    const short = checkModelMemory(files.resolved, descriptor, [gb10], memAvailable(weights + kv - 1), memory)
    expect(short.verdict.ok).toBe(false)
    if (!short.verdict.ok) {
      expect(short.verdict.error.details).toBe(
        `weight_bytes=${weights} kv_reserve_bytes=${kv} kv_reserve_basis=config kv_max_tokens=16384 ` +
          `needed_bytes=${weights + kv} free_bytes=${weights + kv - 1}`
      )
    }
  })

  it('reports a unified-memory card among the other cards by its own rule, a discrete one by the fraction', () => {
    const tooSmall = gpu({
      gpu_id: 'GPU-small',
      total_vram_bytes: 8_000_000_000,
      free_vram_bytes: 8_000_000_000,
    })
    const pinned = baseInput({ config_json: shape, files: weightFiles(weights), gpu_id: 'GPU-small' })
    const fits = checkModelCompatibility(
      pinned,
      descriptor,
      [tooSmall, gb10],
      memAvailable(weights + kv),
      memory
    )
    expect(fits.checked_gpu_id).toBe('GPU-small')
    expect(fits.fits_other_gpus).toEqual(['GPU-gb10'])
    const short = checkModelCompatibility(
      pinned,
      descriptor,
      [tooSmall, gb10],
      memAvailable(weights + kv - 1),
      memory
    )
    expect(short.fits_other_gpus).toEqual([])
  })
})
