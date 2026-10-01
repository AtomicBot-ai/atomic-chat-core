import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, RuntimeDescriptor, RuntimeInstallation, Sha256Digest } from '../../contracts/index.js'
import type { DescriptorProviderResult, InstallationRecord } from '../environment/index.js'
import { canonicalizeSettingValues, defaultSettingValues } from '../../settings/index.js'
import { checkTensorrtLlmModel, parseModelCheckInput } from './check.js'
import type { ModelCheckDeps } from './check.js'

const digest = (hex: string): Sha256Digest => `sha256:${hex}`
const NO_HOST_MEMORY = { availableBytes: 0, totalBytes: 0 }

function descriptor(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
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
    supported_architectures: ['LlamaForCausalLM'],
    quantization: [{ format: 'bf16', min_compute_capability: '8.0', excluded_compute_capabilities: [] }],
    model_families: {},
    curated_models: [],
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
    driver_version: '581.42',
    ...overrides,
  }
}

function installation(overrides: Partial<RuntimeInstallation> = {}): RuntimeInstallation {
  return {
    installation_id: 'trt-1',
    engine_id: 'tensorrt-llm',
    environment_id: 'default',
    active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
    candidate_descriptor_id: null,
    availability: 'supported',
    status: 'ready',
    ...overrides,
  }
}

function record(installationOverrides: Partial<RuntimeInstallation> = {}): InstallationRecord {
  return {
    schema_version: 1,
    installation: installation(installationOverrides),
    image: { repository: 'nvcr.io/nvidia/tensorrt-llm/release', digest: digest('a'.repeat(64)) },
    platform: 'linux/amd64',
    installed_at: '2026-09-29T00:00:00.000Z',
  }
}

const AVAILABLE = (d: RuntimeDescriptor): DescriptorProviderResult => ({ kind: 'available', descriptor: d })
const UNSUPPORTED: DescriptorProviderResult = {
  kind: 'unsupported',
  error: new AtomicCoreError(
    'MANAGED_METADATA_INVALID',
    'No TensorRT-LLM runtime descriptor has been cached yet.'
  ),
}

function deps(overrides: Partial<ModelCheckDeps> = {}): ModelCheckDeps {
  return {
    installations: { list: async () => [record()] },
    descriptors: {
      forInstallation: async () => AVAILABLE(descriptor()),
      cachedForNewSetup: async () => UNSUPPORTED,
    },
    hostFacts: async () => ({ gpus: [gpu({ gpu_id: 'gpu-0' })], memory: NO_HOST_MEMORY }),
    settings: () => ({}),
    ...overrides,
  }
}

const files = () => [
  { path: 'model.safetensors', size: 1_000_000_000, sha256: 'a'.repeat(64) },
  { path: 'config.json', size: 100, sha256: null },
]

const body = (overrides: Record<string, unknown> = {}) => ({
  repository: 'acme/model',
  revision: 'deadbeef',
  config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
  hf_quant_config_json: null,
  files: files(),
  ...overrides,
})

describe('checkTensorrtLlmModel', () => {
  it("checks against the ready installation's pinned descriptor, over forInstallation, never cachedForNewSetup", async () => {
    const forInstallation = vi.fn(async () => AVAILABLE(descriptor()))
    const cachedForNewSetup = vi.fn(async () => UNSUPPORTED)
    const result = await checkTensorrtLlmModel(
      body(),
      deps({ descriptors: { forInstallation, cachedForNewSetup } })
    )
    expect(result.verdict).toEqual({ ok: true })
    expect(forInstallation).toHaveBeenCalledWith('tensorrt-llm-1.2.1-r1')
    expect(cachedForNewSetup).not.toHaveBeenCalled()
  })

  it('falls back to the latest cached descriptor when the engine is not installed', async () => {
    const cachedForNewSetup = vi.fn(async () => AVAILABLE(descriptor()))
    const result = await checkTensorrtLlmModel(
      body(),
      deps({
        installations: { list: async () => [] },
        descriptors: { forInstallation: async () => UNSUPPORTED, cachedForNewSetup },
      })
    )
    expect(result.verdict).toEqual({ ok: true })
    expect(cachedForNewSetup).toHaveBeenCalledOnce()
  })

  it('falls back to the cached descriptor when the installation exists but is not ready', async () => {
    const cachedForNewSetup = vi.fn(async () => AVAILABLE(descriptor()))
    const result = await checkTensorrtLlmModel(
      body(),
      deps({
        installations: { list: async () => [record({ status: 'installing' })] },
        descriptors: { forInstallation: async () => UNSUPPORTED, cachedForNewSetup },
      })
    )
    expect(result.verdict).toEqual({ ok: true })
    expect(cachedForNewSetup).toHaveBeenCalledOnce()
  })

  it("throws the descriptor provider's own error when nothing is installed and nothing was ever cached", async () => {
    await expect(
      checkTensorrtLlmModel(body(), deps({ installations: { list: async () => [] } }))
    ).rejects.toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
  })

  it('never touches the network: global fetch is never called, only the injected deps (finding 9)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const hostFacts = vi.fn(async () => ({ gpus: [gpu({ gpu_id: 'gpu-0' })], memory: NO_HOST_MEMORY }))
    try {
      const result = await checkTensorrtLlmModel(body(), deps({ hostFacts }))
      expect(result.verdict).toEqual({ ok: true })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(hostFacts).toHaveBeenCalledOnce()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('checks the stored gpu_id when the request names none, not the default card (finding 3)', async () => {
    const SMALL_ID = 'GPU-00000000-0000-0000-0000-000000000001'
    const LARGE_ID = 'GPU-00000000-0000-0000-0000-000000000002'
    const small = gpu({ gpu_id: SMALL_ID, total_vram_bytes: 8_000_000_000, free_vram_bytes: 8_000_000_000 })
    const large = gpu({ gpu_id: LARGE_ID, total_vram_bytes: 40_000_000_000, free_vram_bytes: 40_000_000_000 })
    const hostFacts = async () => ({ gpus: [small, large], memory: NO_HOST_MEMORY })

    // No gpu_id anywhere: falls back to "most free memory" (the large card), same as a load with nothing saved.
    const noSetting = await checkTensorrtLlmModel(body(), deps({ hostFacts, settings: () => ({}) }))
    expect(noSetting.checked_gpu_id).toBe(LARGE_ID)

    // A stored gpu_id, no gpu_id in the request: checks the card a real load would actually pick.
    const withSetting = await checkTensorrtLlmModel(
      body(),
      deps({ hostFacts, settings: () => ({ gpu_id: SMALL_ID }) })
    )
    expect(withSetting.checked_gpu_id).toBe(SMALL_ID)

    // The request's own gpu_id still wins over the stored setting.
    const withBoth = await checkTensorrtLlmModel(
      body({ gpu_id: LARGE_ID }),
      deps({ hostFacts, settings: () => ({ gpu_id: SMALL_ID }) })
    )
    expect(withBoth.checked_gpu_id).toBe(LARGE_ID)
  })

  it('without any gpu_id checks the card with the most free memory, not the biggest one (design D12b)', async () => {
    const GiB = 1024 ** 3
    const DESKTOP_ID = 'GPU-00000000-0000-0000-0000-000000000003'
    const IDLE_ID = 'GPU-00000000-0000-0000-0000-000000000004'
    // Two 24 GB cards: the first holds the desktop and a browser (19 GB free), the second 23.5 GB free.
    const desktop = gpu({ gpu_id: DESKTOP_ID, total_vram_bytes: 24 * GiB, free_vram_bytes: 19 * GiB })
    const idle = gpu({ gpu_id: IDLE_ID, total_vram_bytes: 24 * GiB, free_vram_bytes: 23.5 * GiB })
    const hostFacts = async () => ({ gpus: [desktop, idle], memory: NO_HOST_MEMORY })

    expect((await checkTensorrtLlmModel(body(), deps({ hostFacts }))).checked_gpu_id).toBe(IDLE_ID)
    // A stored card that is gone: the same rule, as the load's substitution uses.
    const gone = await checkTensorrtLlmModel(
      body(),
      deps({ hostFacts, settings: () => ({ gpu_id: 'GPU-00000000-0000-0000-0000-000000000009' }) })
    )
    expect(gone.checked_gpu_id).toBe(IDLE_ID)
  })

  it('nvidia-smi absent/failing (no candidate GPU at all) answers MANAGED_PREREQUISITE_BLOCKED, not INVALID_ARGUMENT (finding 11)', async () => {
    await expect(
      checkTensorrtLlmModel(body(), deps({ hostFacts: async () => ({ gpus: [], memory: NO_HOST_MEMORY }) }))
    ).rejects.toMatchObject({ code: 'MANAGED_PREREQUISITE_BLOCKED' })
  })

  it('reads the kv_cache_free_gpu_memory_fraction from stored settings and passes it to the pure check', async () => {
    // 70 GB weights with no KV shape in config.json (the weights x (1 - fraction) fallback), an 80 GB
    // card: ok at the default 0.8 fraction (70 + 14 GB), a shortage at a much lower one (70 + 35 GB).
    const bigModelBody = body({
      hf_quant_config_json: { quantization: { quant_algo: 'FP8' } },
      files: [
        { path: 'model-00001-of-00002.safetensors', size: 35_000_000_000, sha256: 'a'.repeat(64) },
        { path: 'model-00002-of-00002.safetensors', size: 35_000_000_000, sha256: 'b'.repeat(64) },
      ],
    })
    const datacenterDescriptor = descriptor({
      supported_architectures: ['LlamaForCausalLM'],
      quantization: [{ format: 'fp8', min_compute_capability: '8.9', excluded_compute_capabilities: [] }],
    })
    const datacenterGpu = gpu({
      gpu_id: 'gpu-0',
      compute_capability: '9.0',
      total_vram_bytes: 85_899_345_920,
      free_vram_bytes: 85_532_850_176,
    })
    const commonDeps = {
      installations: { list: async () => [record()] },
      descriptors: {
        forInstallation: async () => AVAILABLE(datacenterDescriptor),
        cachedForNewSetup: async () => UNSUPPORTED,
      },
      hostFacts: async () => ({ gpus: [datacenterGpu], memory: NO_HOST_MEMORY }),
    }

    const atDefault = await checkTensorrtLlmModel(bigModelBody, deps({ ...commonDeps, settings: () => ({}) }))
    expect(atDefault.verdict).toEqual({ ok: true })

    const atLowerFraction = await checkTensorrtLlmModel(
      bigModelBody,
      deps({ ...commonDeps, settings: () => ({ kv_cache_free_gpu_memory_fraction: 0.5 }) })
    )
    expect(atLowerFraction.verdict.ok).toBe(false)
  })
})

describe('checkTensorrtLlmModel: the stored default fraction is the one the launch passes', () => {
  // A Qwen3-1.7B-shaped checkpoint (28 layers, 8 KV heads, head_dim 128, bf16 KV) at the stored
  // default context of 8192: KV_bytes = 2 x 28 x 8 x 128 x 2 x 8192 = 939,524,096. At the default
  // fraction 0.8 the reserve is exactly 1,174,405,120, so weights + reserve = 2,174,405,120 bytes; at
  // the old 0.9 it would be 1,043,915,663 and a card 1 byte short of the 0.8 figure would still pass.
  const NEEDED_AT_DEFAULT = 1_000_000_000 + 1_174_405_120
  const qwen3Body = body({
    config_json: {
      architectures: ['LlamaForCausalLM'],
      dtype: 'bfloat16',
      num_hidden_layers: 28,
      num_attention_heads: 16,
      num_key_value_heads: 8,
      head_dim: 128,
      hidden_size: 2048,
    },
  })
  const storedDefaults = () => canonicalizeSettingValues('tensorrt-llm', defaultSettingValues('tensorrt-llm'))

  it.each<[string, number, boolean]>([
    ['fits with exactly weights + KV / 0.8 free', NEEDED_AT_DEFAULT, true],
    ['is a shortage one byte below that', NEEDED_AT_DEFAULT - 1, false],
  ])('%s', async (_label, freeBytes, ok) => {
    const result = await checkTensorrtLlmModel(
      qwen3Body,
      deps({
        settings: storedDefaults,
        hostFacts: async () => ({
          gpus: [gpu({ gpu_id: 'gpu-0', free_vram_bytes: freeBytes })],
          memory: NO_HOST_MEMORY,
        }),
      })
    )
    expect(result.kv_reserve_basis).toBe('config')
    expect(result.verdict.ok).toBe(ok)
  })
})

describe('parseModelCheckInput', () => {
  it('parses a well-formed request', () => {
    expect(parseModelCheckInput(body())).toEqual({
      repository: 'acme/model',
      revision: 'deadbeef',
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
      hf_quant_config_json: null,
      files: files(),
    })
  })

  it('carries gpu_id through only when it was given', () => {
    expect(parseModelCheckInput(body({ gpu_id: 'GPU-abc' }))).toMatchObject({ gpu_id: 'GPU-abc' })
    expect(parseModelCheckInput(body())).not.toHaveProperty('gpu_id')
  })

  it('accepts hf_quant_config_json as an object', () => {
    expect(
      parseModelCheckInput(body({ hf_quant_config_json: { quantization: { quant_algo: 'FP8' } } }))
        .hf_quant_config_json
    ).toEqual({ quantization: { quant_algo: 'FP8' } })
  })

  it.each<[unknown, string]>([
    [{}, 'not an object'],
    [{ ...body(), repository: '' }, 'empty repository'],
    [{ ...body(), repository: 42 }, 'non-string repository'],
    [{ ...body(), revision: undefined }, 'missing revision'],
    [{ ...body(), config_json: 'nope' }, 'config_json not an object'],
    [{ ...body(), config_json: null }, 'config_json null'],
    [{ ...body(), hf_quant_config_json: 'nope' }, 'hf_quant_config_json neither null nor object'],
    [{ ...body(), files: 'nope' }, 'files not an array'],
    [{ ...body(), files: [{ size: 1 }] }, 'file missing path'],
    [{ ...body(), files: [{ path: 'a', size: '1' }] }, 'file size not a number'],
    [{ ...body(), files: [{ path: 'a', size: -1 }] }, 'file size negative'],
    [{ ...body(), files: [{ path: 'a', size: 1, sha256: 42 }] }, 'file sha256 not string or null'],
    [{ ...body(), gpu_id: 42 }, 'gpu_id not a string'],
    [{ ...body(), extra_field: true }, 'unknown top-level field'],
  ])('rejects %#: %s', (input) => {
    expect(() => parseModelCheckInput(input)).toThrow(AtomicCoreError)
  })
})

describe('checkTensorrtLlmModel on Windows — spec "Памяти VM меньше, чем весов"', () => {
  const GB = 1_000_000_000

  it('warns with both numbers and the WSL memory setting, and does not refuse the model', async () => {
    const result = await checkTensorrtLlmModel(
      body({ files: [{ path: 'model.safetensors', size: 20 * GB, sha256: 'a'.repeat(64) }] }),
      deps({
        hostFacts: async () => ({
          gpus: [gpu({ gpu_id: 'gpu-0', total_vram_bytes: 48 * 1024 ** 3, free_vram_bytes: 47 * 1024 ** 3 })],
          memory: { availableBytes: 14 * GB, totalBytes: 16 * GB },
        }),
        wslVm: async () => ({ memory_setting: '16GB' }),
      })
    )
    expect(result.verdict).toEqual({ ok: true })
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'wsl-vm-memory',
        params: { vm_memory_bytes: String(16 * GB), weight_bytes: String(20 * GB), wslconfig_memory: '16GB' },
      }),
    ])
    expect(result.warnings?.[0]?.message).toMatch(/\.wslconfig/)
  })

  it('no warning when the VM has room, and none at all off Windows', async () => {
    const roomy = await checkTensorrtLlmModel(
      body(),
      deps({
        hostFacts: async () => ({
          gpus: [gpu({ gpu_id: 'gpu-0' })],
          memory: { availableBytes: 60 * GB, totalBytes: 64 * GB },
        }),
        wslVm: async () => ({ memory_setting: null }),
      })
    )
    expect(roomy.warnings).toBeUndefined()
    const linux = await checkTensorrtLlmModel(
      body({ files: [{ path: 'model.safetensors', size: 20 * GB, sha256: 'a'.repeat(64) }] }),
      deps({
        hostFacts: async () => ({
          gpus: [gpu({ gpu_id: 'gpu-0', total_vram_bytes: 48 * 1024 ** 3, free_vram_bytes: 47 * 1024 ** 3 })],
          memory: { availableBytes: 1, totalBytes: 2 },
        }),
      })
    )
    expect(linux.warnings).toBeUndefined()
  })
})

describe('checkTensorrtLlmModel on Windows — no warning to give', () => {
  it('none for a model the check refused, and none when the VM memory could not be read', async () => {
    const big = body({
      files: [{ path: 'model.safetensors', size: 900_000_000_000, sha256: 'a'.repeat(64) }],
    })
    const refused = await checkTensorrtLlmModel(
      big,
      deps({
        hostFacts: async () => ({
          gpus: [gpu({ gpu_id: 'gpu-0' })],
          memory: { availableBytes: 1, totalBytes: 2 },
        }),
        wslVm: async () => ({ memory_setting: null }),
      })
    )
    expect(refused.verdict.ok).toBe(false)
    expect(refused.warnings).toBeUndefined()
    const unread = await checkTensorrtLlmModel(
      body(),
      deps({
        hostFacts: async () => ({
          gpus: [gpu({ gpu_id: 'gpu-0' })],
          memory: { availableBytes: 0, totalBytes: 0 },
        }),
        wslVm: async () => ({ memory_setting: null }),
      })
    )
    expect(unread.warnings).toBeUndefined()
  })

  it('says so when .wslconfig does not set the VM memory', async () => {
    const GB = 1_000_000_000
    const result = await checkTensorrtLlmModel(
      body({ files: [{ path: 'model.safetensors', size: 20 * GB, sha256: 'a'.repeat(64) }] }),
      deps({
        hostFacts: async () => ({
          gpus: [gpu({ gpu_id: 'gpu-0', total_vram_bytes: 48 * 1024 ** 3, free_vram_bytes: 47 * 1024 ** 3 })],
          memory: { availableBytes: 14 * GB, totalBytes: 16 * GB },
        }),
        wslVm: async () => ({ memory_setting: null }),
      })
    )
    expect(result.warnings?.[0]?.message).toMatch(/half of this computer’s memory/)
    expect(result.warnings?.[0]?.params?.['wslconfig_memory']).toBe('')
  })
})
