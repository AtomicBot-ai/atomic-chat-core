import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, RuntimeDescriptor, Sha256Digest } from '../../contracts/index.js'
import type { CheckpointFile, HostMemory } from './compatibility.js'
import { verifyModelFilesAndCompatibility } from './prelaunch.js'

const digest = (hex: string): Sha256Digest => `sha256:${hex}`
/** The host's memory with `MemAvailable` = `bytes` (none of these cards is unified-memory, so it never matters). */
const memAvailable = (bytes: number): HostMemory => ({ availableBytes: bytes, totalBytes: bytes })

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
    supported_architectures: ['LlamaForCausalLM'],
    quantization: [{ format: 'bf16', min_compute_capability: '8.0', excluded_compute_capabilities: [] }],
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
    driver_version: '581.42',
    ...overrides,
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trt-prelaunch-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const WEIGHT_BYTES = 100
const files: CheckpointFile[] = [{ path: 'model.safetensors', size: WEIGHT_BYTES, sha256: 'a'.repeat(64) }]

async function writeCheckpoint(
  configJson: unknown = { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' }
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(WEIGHT_BYTES, 1))
  await writeFile(join(dir, 'config.json'), JSON.stringify(configJson))
}

const model = () => ({ dir, repository: 'acme/model', revision: 'deadbeef', files })
const gpus = [gpu({ gpu_id: 'gpu-0' })]
const memory = { contextLength: 8192, kvCacheFreeGpuMemoryFraction: 0.9 }
const options = { gpuId: 'gpu-0', memory }

describe('verifyModelFilesAndCompatibility', () => {
  it('passes and returns the resolved checkpoint when every file matches and config.json checks out', async () => {
    await writeCheckpoint()
    const resolved = await verifyModelFilesAndCompatibility(
      model(),
      baseDescriptor(),
      gpus,
      memAvailable(0),
      options
    )
    expect(resolved.architectures).toEqual(['LlamaForCausalLM'])
    expect(resolved.quantizationFormat).toBe('bf16')
    expect(resolved.weightBytesTotal).toBe(WEIGHT_BYTES)
  })

  it("never checks the selected card's free memory (task 2.16w round 1, finding 1, Critical): a starved card still passes", async () => {
    await writeCheckpoint()
    const starved = [gpu({ gpu_id: 'gpu-0', free_vram_bytes: 0 })]
    const resolved = await verifyModelFilesAndCompatibility(
      model(),
      baseDescriptor(),
      starved,
      memAvailable(0),
      options
    )
    expect(resolved.weightBytesTotal).toBe(WEIGHT_BYTES)
  })

  it('refuses with MODEL_FILE_NOT_FOUND, naming the file, when a shard was deleted after download', async () => {
    await writeCheckpoint()
    await rm(join(dir, 'model.safetensors'))
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      message: expect.stringContaining('model.safetensors') as unknown as string,
    })
  })

  it('refuses with MODEL_FILE_CORRUPT when a file on disk does not match the size model.yml recorded', async () => {
    await writeCheckpoint()
    await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(WEIGHT_BYTES - 1, 1))
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MODEL_FILE_CORRUPT',
    })
  })

  it('checks file presence before ever reading config.json', async () => {
    // No files at all: model.safetensors is missing, and so is config.json — the file-presence
    // error must win, naming the checkpoint file, not a generic "config.json missing" error.
    await mkdir(dir, { recursive: true })
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      message: expect.stringContaining('model.safetensors') as unknown as string,
    })
  })

  it('refuses with MODEL_FILE_NOT_FOUND when config.json itself is missing', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(WEIGHT_BYTES, 1))
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      message: expect.stringContaining('config.json') as unknown as string,
    })
  })

  it('refuses with MANAGED_METADATA_INVALID when config.json exists but is not valid JSON', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(WEIGHT_BYTES, 1))
    await writeFile(join(dir, 'config.json'), '{not json')
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
      message: expect.stringContaining('config.json') as unknown as string,
    })
  })

  it('refuses with MANAGED_METADATA_INVALID when config.json parses but is not a JSON object', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(WEIGHT_BYTES, 1))
    await writeFile(join(dir, 'config.json'), '[1, 2, 3]')
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
      message: expect.stringContaining('config.json') as unknown as string,
    })
  })

  it('re-checks compatibility against config.json as it is on disk now, not as model.yml recorded it', async () => {
    // On disk the architecture no longer matches the descriptor's supported list.
    await writeCheckpoint({ architectures: ['SomeOtherForCausalLM'] })
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MODEL_INCOMPATIBLE',
    })
  })

  it('re-checks against the current card: a compute capability the format no longer supports refuses the load', async () => {
    await writeCheckpoint()
    const tooOld = [gpu({ gpu_id: 'gpu-0', compute_capability: '7.5' })]
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), tooOld, memAvailable(0), options)
    ).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' })
  })

  it('reads hf_quant_config.json whenever it exists on disk, even when model.yml does not list it (finding 4)', async () => {
    await writeCheckpoint({ architectures: ['LlamaForCausalLM'] }) // no dtype: format must come from hf_quant_config.json
    await writeFile(
      join(dir, 'hf_quant_config.json'),
      JSON.stringify({ quantization: { quant_algo: 'FP8' } })
    )
    // model.yml's own files list does NOT mention hf_quant_config.json at all.
    const fp8Descriptor = baseDescriptor({
      quantization: [{ format: 'fp8', min_compute_capability: '8.0', excluded_compute_capabilities: [] }],
    })
    const resolved = await verifyModelFilesAndCompatibility(
      model(),
      fp8Descriptor,
      gpus,
      memAvailable(0),
      options
    )
    expect(resolved.quantizationFormat).toBe('fp8')
  })

  it('reads a present, listed hf_quant_config.json and folds it into the compatibility re-check', async () => {
    await writeCheckpoint({ architectures: ['LlamaForCausalLM'] }) // no dtype: format comes from hf_quant_config.json
    const hfQuantConfigText = JSON.stringify({ quantization: { quant_algo: 'FP8' } })
    await writeFile(join(dir, 'hf_quant_config.json'), hfQuantConfigText)
    const withHfQuantConfig = {
      ...model(),
      files: [
        ...files,
        { path: 'hf_quant_config.json', size: Buffer.byteLength(hfQuantConfigText), sha256: null },
      ],
    }
    const fp8Descriptor = baseDescriptor({
      quantization: [{ format: 'fp8', min_compute_capability: '8.0', excluded_compute_capabilities: [] }],
    })
    const resolved = await verifyModelFilesAndCompatibility(
      withHfQuantConfig,
      fp8Descriptor,
      gpus,
      memAvailable(0),
      options
    )
    expect(resolved.quantizationFormat).toBe('fp8')
  })

  it('refuses with MODEL_FILE_NOT_FOUND when model.yml lists hf_quant_config.json but it is missing on disk', async () => {
    await writeCheckpoint()
    const withHfQuantConfig = {
      ...model(),
      files: [...files, { path: 'hf_quant_config.json', size: 10, sha256: null }],
    }
    // The checkpoint file-presence loop only walks model.yml's own list, which now includes
    // hf_quant_config.json at a declared size, so it fails there first, still by name.
    await expect(
      verifyModelFilesAndCompatibility(withHfQuantConfig, baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      message: expect.stringContaining('hf_quant_config.json') as unknown as string,
    })
  })

  it('refuses a file.path that would climb out of the model directory', async () => {
    await writeCheckpoint()
    const escaping = { ...model(), files: [{ path: '../../etc/passwd', size: 1, sha256: null }] }
    await expect(
      verifyModelFilesAndCompatibility(escaping, baseDescriptor(), gpus, memAvailable(0), options)
    ).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
  })

  it('creates no container: it only ever throws or returns the resolved checkpoint, never touches Docker', async () => {
    await writeCheckpoint()
    await expect(
      verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
    ).resolves.toBeDefined()
  })

  it('is an AtomicCoreError with the code both a missing file and an incompatible checkpoint would carry over HTTP', async () => {
    await writeCheckpoint({ architectures: ['SomeOtherForCausalLM'] })
    try {
      await verifyModelFilesAndCompatibility(model(), baseDescriptor(), gpus, memAvailable(0), options)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicCoreError)
    }
  })
})
