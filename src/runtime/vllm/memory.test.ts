import { describe, expect, it, vi } from 'vitest'
import type { GpuFacts } from '../../contracts/index.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseRuntimeDescriptor } from '../environment/index.js'
import type { DescriptorProviderResult } from '../environment/index.js'
import { checkCheckpoint, checkManagedModel, type CheckpointFile } from '../managed-models/index.js'
import { tensorrtLlmCheckEngine } from '../tensorrt-llm/compatibility.js'
import { TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION } from '../tensorrt-llm/kv-cache.js'
import {
  VLLM_ENGINE_OVERHEAD_BYTES,
  VLLM_FREE_MEMORY_MARGIN_BYTES,
  VLLM_START_CHECK_MARGIN_BYTES,
  vllmCheckEngine,
  vllmKvCacheBytes,
  vllmLaunchPlan,
} from './memory.js'
import { managedModelCheckOf } from '../managed-engines/index.js'
import { VLLM_ENGINE } from './engine.js'
import { vllmSettings } from './settings.js'

/** Change `add-vllm-runtime`, task 3.3 (design D9; spec `vllm-runtime`, "Память vLLM задаёт core"). */
const GiB = 1024 ** 3
/** vLLM's own CUDA context before its start check, measured on the Windows acceptance card (2026-10-06). */
const VLLM_CUDA_CONTEXT_MEASURED = 0.87 * GiB
const VLLM = parseRuntimeDescriptor(readRuntimeFixture('vllm.json'))
const TRT = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm-1.3.0rc29-r3.json'))
/** Qwen3-style dense shape: 28 layers, 8 KV heads of 128 → 2 × 28 × 8 × 128 × 2 bytes = 112 KiB per token at bf16. */
const SHAPE = {
  num_hidden_layers: 28,
  num_attention_heads: 16,
  num_key_value_heads: 8,
  head_dim: 128,
  hidden_size: 2048,
}
const PER_TOKEN_BF16 = 2 * 28 * 8 * 128 * 2
const config = (extra: Record<string, unknown> = {}) => ({
  architectures: ['LlamaForCausalLM'],
  dtype: 'bfloat16',
  ...SHAPE,
  ...extra,
})
const card = (over: Partial<GpuFacts> = {}): GpuFacts => ({
  gpu_id: 'GPU-4070',
  name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
  compute_capability: '8.9',
  total_vram_bytes: 8 * GiB,
  free_vram_bytes: 6.5 * GiB,
  driver_version: '580.95.05',
  ...over,
})
const HOST = { availableBytes: 32 * GiB, totalBytes: 64 * GiB }
const weights = (bytes: number): CheckpointFile[] => [
  { path: 'model.safetensors', size: bytes, sha256: 'aa' },
]

describe('the KV cache in bytes', () => {
  it('is context × concurrent requests tokens by default, × the bytes per token of the model’s KV shape', () => {
    const settings = vllmSettings({ max_output_tokens: 1024, context_length: 4096, max_num_seqs: 2 })
    expect(
      vllmKvCacheBytes({ configJson: config(), hfQuantConfigJson: null }, settings, card(), false)
    ).toEqual({
      bytes: 4096 * 2 * PER_TOKEN_BF16,
      basis: 'config',
    })
  })

  it('the KV cache size setting replaces the estimate; FP8 halves the estimate, only on 8.9 and newer', () => {
    const fixed = vllmSettings({ kv_cache_memory_gib: 1.5 })
    expect(
      vllmKvCacheBytes({ configJson: config(), hfQuantConfigJson: null }, fixed, card(), false).bytes
    ).toBe(1.5 * GiB)
    const fp8 = vllmSettings({ kv_cache_dtype: 'fp8' })
    expect(
      vllmKvCacheBytes({ configJson: config(), hfQuantConfigJson: null }, fp8, card(), false).bytes
    ).toBe((8192 * PER_TOKEN_BF16) / 2)
    expect(
      vllmKvCacheBytes(
        { configJson: config(), hfQuantConfigJson: null },
        fp8,
        card({ compute_capability: '8.6' }),
        false
      ).bytes
    ).toBe(8192 * PER_TOKEN_BF16)
  })

  it('on a card with the host’s memory it is two contexts, whatever the requests', () => {
    const settings = vllmSettings({ max_output_tokens: 1024, context_length: 4096, max_num_seqs: 8 })
    expect(
      vllmKvCacheBytes(
        { configJson: config(), hfQuantConfigJson: null },
        settings,
        card({ total_vram_bytes: null }),
        true
      ).bytes
    ).toBe(2 * 4096 * PER_TOKEN_BF16)
  })

  it('counts only the attention layers of a hybrid model', () => {
    const hybrid = config({
      layer_types: Array.from({ length: 28 }, (_, i) =>
        i % 4 === 3 ? 'full_attention' : 'linear_attention'
      ),
    })
    const settings = vllmSettings({ context_length: 2048, max_output_tokens: 1024 })
    expect(
      vllmKvCacheBytes({ configJson: hybrid, hfQuantConfigJson: null }, settings, card(), false).bytes
    ).toBe(2048 * 2 * 7 * 8 * 128 * 2)
  })
})

describe('the memory share and the launch plan', () => {
  /** vLLM V1's start check (`v1/worker/utils.py:request_memory`): free, measured after its own CUDA context, ≥ ⌈total × share⌉. */
  const startCheckPasses = (freeAtCheck: number, total: number, share: number) =>
    freeAtCheck >= Math.ceil(total * share)
  const model = { weightBytesTotal: 4.04 * 1e9, configJson: config(), hfQuantConfigJson: null }

  it('Карта частично занята рабочим столом: 8 GB with 1.5 GB taken — auto gives vLLM what is free less 1.5 GiB, and its start check passes', () => {
    const plan = vllmLaunchPlan(vllmSettings({}), model, card({ free_vram_bytes: 6.5 * GiB }), HOST)
    expect(plan.gpuMemoryUtilization).toBe(0.625)
    expect(plan.kvCacheMemoryBytes).toBeNull()
    expect(startCheckPasses(6.5 * GiB - VLLM_CUDA_CONTEXT_MEASURED, 8 * GiB, plan.gpuMemoryUtilization)).toBe(true)
  })

  it('the Windows acceptance card: 7.76 GiB free before the container, 6.89 GiB at vLLM’s check — the start check passes', () => {
    // RTX 4070 Laptop under WSL, 2026-10-06: with a 512 MiB margin the share was 0.9081 (7.26 GiB) and
    // vLLM refused every model, its own CUDA context having taken 0.87 GiB before it measured.
    const plan = vllmLaunchPlan(vllmSettings({}), model, card({ free_vram_bytes: 7.76 * GiB }), HOST)
    expect(plan.gpuMemoryUtilization).toBe(0.7825)
    expect(startCheckPasses(6.89 * GiB, 8 * GiB, plan.gpuMemoryUtilization)).toBe(true)
    expect(VLLM_START_CHECK_MARGIN_BYTES).toBeGreaterThan(VLLM_CUDA_CONTEXT_MEASURED)
  })

  it('the settings win over auto: a memory share and a KV cache size set by hand are passed as they are', () => {
    const plan = vllmLaunchPlan(
      vllmSettings({ gpu_memory_utilization: 0.6, kv_cache_memory_gib: 1 }),
      model,
      card({ free_vram_bytes: 7.76 * GiB }),
      HOST
    )
    expect(plan).toMatchObject({ gpuMemoryUtilization: 0.6, kvCacheMemoryBytes: GiB })
  })

  it('never more than 95% of the card, and half of the host’s memory on a card with the host’s memory', () => {
    const idle = vllmLaunchPlan(
      vllmSettings({}),
      { weightBytesTotal: GiB, configJson: config(), hfQuantConfigJson: null },
      card({ total_vram_bytes: 80 * GiB, free_vram_bytes: 80 * GiB }),
      HOST
    )
    expect(idle.gpuMemoryUtilization).toBe(0.95)
    const gb10 = vllmLaunchPlan(
      vllmSettings({}),
      { weightBytesTotal: GiB, configJson: config(), hfQuantConfigJson: null },
      card({ total_vram_bytes: null, free_vram_bytes: null }),
      { availableBytes: 100 * GiB, totalBytes: 120 * GiB }
    )
    expect(gb10.gpuMemoryUtilization).toBeCloseTo(0.5, 4)
  })
})

describe('the vllm check (same skeleton, vLLM’s memory rule)', () => {
  const check = (
    files: CheckpointFile[],
    gpu: GpuFacts,
    extra: Record<string, unknown> = {},
    settings = vllmSettings({ max_output_tokens: 1024, context_length: 4096, max_num_seqs: 2 })
  ) =>
    checkCheckpoint(
      {
        repository: 'acme/model',
        revision: 'main',
        config_json: config(extra),
        hf_quant_config_json: null,
        files,
      },
      VLLM,
      [gpu],
      HOST,
      vllmCheckEngine(settings)
    )

  it('fits when weights + KV + vLLM’s own overhead fit the free memory', () => {
    const verdict = check(weights(3 * GiB), card({ free_vram_bytes: 6.5 * GiB }))
    expect(verdict.verdict).toEqual({ ok: true })
  })

  it('Модель не помещается: weights and KV over the free memory — MODEL_INCOMPATIBLE with needed and free bytes', () => {
    const verdict = check(weights(5 * GiB), card({ free_vram_bytes: 6.5 * GiB }))
    const kv = 4096 * 2 * PER_TOKEN_BF16
    // The margin left free when vLLM's share is computed is part of what the card must hold.
    const needed = 5 * GiB + kv + VLLM_ENGINE_OVERHEAD_BYTES + VLLM_FREE_MEMORY_MARGIN_BYTES
    expect(verdict.verdict).toMatchObject({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE', details: expect.stringContaining(`needed_bytes=${needed}`) },
    })
    if (!verdict.verdict.ok) expect(verdict.verdict.error.details).toContain(`free_bytes=${6.5 * GiB}`)
  })

  it('Одна модель, два вердикта: an NVFP4 model on 8.9 — each engine by its own descriptor, in one shape', () => {
    const nvfp4 = {
      repository: 'nvidia/model-NVFP4',
      revision: 'main',
      config_json: config(),
      hf_quant_config_json: { quantization: { quant_algo: 'NVFP4' } },
      files: [...weights(2 * GiB), { path: 'hf_quant_config.json', size: 100, sha256: null }],
    }
    const gpu = card()
    const viaVllm = checkCheckpoint(
      nvfp4,
      VLLM,
      [gpu],
      HOST,
      vllmCheckEngine(vllmSettings({ max_output_tokens: 1024, context_length: 4096, max_num_seqs: 2 }))
    )
    const viaTrt = checkCheckpoint(
      nvfp4,
      TRT,
      [gpu],
      HOST,
      tensorrtLlmCheckEngine({
        contextLength: 4096,
        kvCacheFreeGpuMemoryFraction: TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION,
      })
    )
    expect(Object.keys(viaVllm).sort()).toEqual(Object.keys(viaTrt).sort())
    expect(viaVllm.quantization_format).toBe('nvfp4')
    expect(viaTrt.quantization_format).toBe('nvfp4')
    expect(viaVllm.verdict).toEqual({ ok: true })
    expect(viaTrt.verdict).toMatchObject({ ok: false, error: { code: 'MODEL_INCOMPATIBLE' } })
  })

  it('weights offloaded to the CPU (cpu_offload_gb) do not count against the card', () => {
    const settings = (offload: number) =>
      vllmSettings({
        max_output_tokens: 1024,
        context_length: 4096,
        max_num_seqs: 2,
        cpu_offload_gb: offload,
      })
    const run = (offload: number) =>
      checkCheckpoint(
        {
          repository: 'acme/model',
          revision: 'main',
          config_json: config(),
          hf_quant_config_json: null,
          files: weights(5 * GiB),
        },
        VLLM,
        [card({ free_vram_bytes: 6.5 * GiB })],
        HOST,
        vllmCheckEngine(settings(offload))
      )
    expect(run(0).verdict.ok).toBe(false)
    expect(run(2).verdict).toEqual({ ok: true })
  })

  it('on a card with the host’s memory it counts only the half of RAM the launch gives vLLM', () => {
    const gb10 = card({ total_vram_bytes: null, free_vram_bytes: null })
    const host = { availableBytes: 100 * GiB, totalBytes: 120 * GiB }
    const run = (bytes: number) =>
      checkCheckpoint(
        {
          repository: 'acme/model',
          revision: 'main',
          config_json: config(),
          hf_quant_config_json: null,
          files: weights(bytes),
        },
        VLLM,
        [gb10],
        host,
        vllmCheckEngine(vllmSettings({ max_output_tokens: 1024, context_length: 4096, max_num_seqs: 2 }))
      )
    expect(run(50 * GiB).verdict).toEqual({ ok: true })
    // 70 GiB of weights fit the 100 GiB available, not the 60 GiB half of the host vLLM is given.
    expect(run(70 * GiB).verdict).toMatchObject({ ok: false, error: { code: 'MODEL_INCOMPATIBLE' } })
  })

  it('marks a checkpoint with a vision or audio part as multimodal in the plan, a text-only one not', () => {
    const plan = (extra: Record<string, unknown>) =>
      vllmLaunchPlan(
        vllmSettings({}),
        { weightBytesTotal: GiB, configJson: config(extra), hfQuantConfigJson: null },
        card(),
        HOST
      )
    expect(plan({}).multimodal).toBe(false)
    expect(plan({ architectures: ['Qwen3_5ForConditionalGeneration'] }).multimodal).toBe(true)
    expect(plan({ vision_config: { depth: 2 } }).multimodal).toBe(true)
  })

  it('a curated model is held to the vllm descriptor’s inventory_digest', () => {
    const curated = VLLM.curated_models.find((model) => model.repository === 'Qwen/Qwen3.5-2B')
    const verdict = checkCheckpoint(
      {
        repository: 'Qwen/Qwen3.5-2B',
        revision: curated?.revision ?? '',
        config_json: config(),
        hf_quant_config_json: null,
        files: weights(GiB),
      },
      VLLM,
      [card()],
      HOST,
      vllmCheckEngine(vllmSettings({}))
    )
    expect(verdict.verdict).toMatchObject({ ok: false, error: { code: 'MANAGED_METADATA_INVALID' } })
  })

  it('Движок не установлен: the check reads vllm’s cached descriptor, never the network', async () => {
    const cachedForNewSetup = vi.fn(async (engineId: string): Promise<DescriptorProviderResult> =>
      engineId === 'vllm' ? { kind: 'available', descriptor: VLLM } : { kind: 'available', descriptor: TRT }
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const verdict = await checkManagedModel(
      managedModelCheckOf(VLLM_ENGINE),
      {
        repository: 'acme/model',
        revision: 'main',
        config_json: config(),
        hf_quant_config_json: null,
        files: weights(2 * GiB),
      },
      {
        installations: { list: async () => [] },
        descriptors: {
          forInstallation: async () => {
            throw new Error('nothing is installed')
          },
          cachedForNewSetup,
        },
        hostFacts: async () => ({ gpus: [card()], memory: HOST }),
        settings: () => ({ max_output_tokens: 1024, context_length: 4096, max_num_seqs: 2 }),
      }
    )
    expect(cachedForNewSetup).toHaveBeenCalledWith('vllm')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(verdict.verdict).toEqual({ ok: true })
    fetchSpy.mockRestore()
  })
})
