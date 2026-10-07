import { describe, expect, it, vi } from 'vitest'
import type { GpuFacts, RuntimeDescriptor } from '../../contracts/index.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseRuntimeDescriptor } from '../environment/index.js'
import type { DescriptorProviderResult, InstallationRecord } from '../environment/index.js'
import {
  checkManagedModel,
  descriptorForCheck,
  type ManagedModelCheckEngine,
  type ModelCheckDeps,
} from './check.js'

/**
 * The check route every managed engine shares (change `add-vllm-runtime`, task 2.3; spec
 * `managed-model-store`, "Проверка совместимости одинакова по форме для всех managed-движков"). A
 * test engine stands in for the second one: its own descriptor, its own settings, its own rule.
 */
const GIB = 1024 ** 3
const TRT = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm-1.3.0rc29-r3.json'))
const SECOND: RuntimeDescriptor = {
  ...TRT,
  engine_id: 'test-engine',
  descriptor_id: 'test-engine-1-r1',
  quantization: [{ format: 'gptq_w4a16', min_compute_capability: '8.0', excluded_compute_capabilities: [] }],
  curated_models: [],
}
const card = (gpuId: string, freeGib: number): GpuFacts => ({
  gpu_id: gpuId,
  name: 'Test GPU',
  compute_capability: '8.9',
  total_vram_bytes: 24 * GIB,
  free_vram_bytes: freeGib * GIB,
  driver_version: '580.95.05',
})
const installed = (engineId: string, descriptorId: string): InstallationRecord => ({
  schema_version: 1,
  installation: {
    installation_id: engineId,
    engine_id: engineId,
    environment_id: 'default',
    active_descriptor_id: descriptorId,
    candidate_descriptor_id: null,
    availability: 'supported',
    status: 'ready',
  },
  image: TRT.image['linux/amd64'],
  platform: 'linux/amd64',
  installed_at: '2026-10-06T00:00:00.000Z',
})
const available = (descriptor: RuntimeDescriptor): DescriptorProviderResult => ({
  kind: 'available',
  descriptor,
})

/** Its card comes from `card` in its settings; its rule needs the weights plus `extra_gib`. */
const TEST_ENGINE: ManagedModelCheckEngine = {
  engineId: 'test-engine',
  gpuIdOf: (settings) => (typeof settings['card'] === 'string' ? settings['card'] : null),
  checkEngineOf: (settings) => ({
    engineId: 'test-engine',
    checkpointProblems: () => null,
    memoryNeed: (_gpu, checkpoint) => {
      const neededBytes = checkpoint.weightBytesTotal + Number(settings['extra_gib'] ?? 0) * GIB
      return { neededBytes, details: `needed_bytes=${neededBytes}` }
    },
  }),
}

const body = {
  repository: 'acme/model',
  revision: 'main',
  config_json: {
    architectures: ['LlamaForCausalLM'],
    quantization_config: { quant_method: 'gptq', bits: 4, sym: true },
  },
  hf_quant_config_json: null,
  files: [{ path: 'model.safetensors', size: 4 * GIB, sha256: 'aa' }],
}

describe('descriptorForCheck', () => {
  it('reads the ready installation of that engine only, else that engine’s own cached descriptor', async () => {
    const cachedForNewSetup = vi.fn(async (engineId: string) =>
      available(engineId === 'test-engine' ? SECOND : TRT)
    )
    const forInstallation = vi.fn(async () => available(TRT))
    const deps = {
      installations: { list: async () => [installed('tensorrt-llm', TRT.descriptor_id)] },
      descriptors: { forInstallation, cachedForNewSetup },
    }

    expect(await descriptorForCheck('test-engine', deps)).toBe(SECOND)
    expect(cachedForNewSetup).toHaveBeenCalledWith('test-engine')
    expect(forInstallation).not.toHaveBeenCalled()
    expect(await descriptorForCheck('tensorrt-llm', deps)).toBe(TRT)
    expect(forInstallation).toHaveBeenCalledWith(TRT.descriptor_id)
  })
})

describe('checkManagedModel', () => {
  const deps = (settings: Record<string, unknown>): ModelCheckDeps => ({
    installations: { list: async () => [installed('test-engine', SECOND.descriptor_id)] },
    descriptors: {
      forInstallation: async () => available(SECOND),
      cachedForNewSetup: async () => available(SECOND),
    },
    hostFacts: async () => ({
      gpus: [card('GPU-a', 20), card('GPU-b', 6)],
      memory: { availableBytes: 0, totalBytes: 0 },
    }),
    settings: () => settings,
  })

  it('checks by the engine’s descriptor on the card saved in its settings, with its own memory rule', async () => {
    const fits = await checkManagedModel(TEST_ENGINE, body, deps({ card: 'GPU-b', extra_gib: 1 }))
    expect(fits.checked_gpu_id).toBe('GPU-b')
    expect(fits.quantization_format).toBe('gptq_w4a16')
    expect(fits.verdict).toEqual({ ok: true })

    const refused = await checkManagedModel(TEST_ENGINE, body, deps({ card: 'GPU-b', extra_gib: 3 }))
    expect(refused.verdict).toMatchObject({ ok: false, error: { code: 'MODEL_INCOMPATIBLE' } })
    expect(refused.fits_other_gpus).toEqual(['GPU-a'])
  })

  it('a gpu_id in the request wins over the saved card; no saved card picks the most free memory', async () => {
    expect(
      (await checkManagedModel(TEST_ENGINE, { ...body, gpu_id: 'GPU-a' }, deps({ card: 'GPU-b' })))
        .checked_gpu_id
    ).toBe('GPU-a')
    expect((await checkManagedModel(TEST_ENGINE, body, deps({}))).checked_gpu_id).toBe('GPU-a')
  })

  it('refuses a body that is not a check request before resolving anything', async () => {
    await expect(
      checkManagedModel(TEST_ENGINE, { repository: 'acme/model' }, deps({}))
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })
})
