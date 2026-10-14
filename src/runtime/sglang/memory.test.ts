import { describe, expect, it } from 'vitest'
import type { GpuFacts } from '../../contracts/index.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseRuntimeDescriptor } from '../environment/index.js'
import { checkCheckpoint, type CheckpointFile } from '../managed-models/index.js'
import {
  SGLANG_ENGINE_OVERHEAD_BYTES,
  SGLANG_FREE_MEMORY_MARGIN_BYTES,
  SGLANG_RUNTIME_RESERVE_BYTES,
  SGLANG_RUNTIME_RESERVE_NO_GRAPHS_BYTES,
  sglangCheckEngine,
  sglangKvCacheBytes,
  sglangLaunchPlan,
  sglangMemFractionStatic,
} from './memory.js'
import { sglangAdapter } from './adapter.js'
import { sglangSettings } from './settings.js'

/** Change `add-sglang-runtime`, task 2.3 (design D4; spec `sglang-runtime`, "Память SGLang задаёт core"). */
const GiB = 1024 ** 3
/** A CUDA context of a desktop card, as vLLM's measured one under WSL (0.87 GiB, 2026-10-06). */
const CUDA_CONTEXT = 0.9 * GiB
const SGLANG = parseRuntimeDescriptor(readRuntimeFixture('sglang.json'))
/** Qwen3-style dense shape: 28 layers, 8 KV heads of 128 → 2 × 28 × 8 × 128 × 2 bytes per token at bf16. */
const SHAPE = {
  num_hidden_layers: 28,
  num_attention_heads: 16,
  num_key_value_heads: 8,
  head_dim: 128,
  hidden_size: 2048,
}
const PER_TOKEN_BF16 = 2 * 28 * 8 * 128 * 2
const config = (extra: Record<string, unknown> = {}) => ({
  architectures: ['Qwen3ForCausalLM'],
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
const model = (extra: Record<string, unknown> = {}, weightBytesTotal = 4 * GiB) => ({
  weightBytesTotal,
  configJson: config(extra),
  hfQuantConfigJson: null,
})

/**
 * SGLang's own budget (`mem_cache/kv_cache_configurator.py::_profile_available_bytes`): of what it finds
 * free once its CUDA context exists, it keeps `1 − f` for activations and CUDA graphs.
 */
const sglangReserve = (freeBeforeContainer: number, share: number) =>
  (freeBeforeContainer - CUDA_CONTEXT) * (1 - share)

describe('the static memory share', () => {
  it('Карта частично занята рабочим столом: 8 GB with 1.5 GB taken — the share leaves SGLang close to 2 GiB for activations and graphs', () => {
    const plan = sglangLaunchPlan(sglangSettings({}), model(), card({ free_vram_bytes: 6.5 * GiB }), HOST)
    // f = 1 − R / F = 1 − 2 / 6.5
    expect(plan.memFractionStatic).toBe(0.6923)
    const reserve = sglangReserve(6.5 * GiB, plan.memFractionStatic)
    // A little under R: SGLang measures after its own CUDA context (design D4).
    expect(reserve).toBeGreaterThan(1.6 * GiB)
    expect(reserve).toBeLessThan(SGLANG_RUNTIME_RESERVE_BYTES)
    // SGLang's own default is sized from the card's total memory and would leave less on a busy card.
    expect(reserve).toBeGreaterThan(sglangReserve(6.5 * GiB, 1 - SGLANG_RUNTIME_RESERVE_BYTES / (8 * GiB)))
  })

  it('without CUDA graphs the reserve is smaller, so the share is larger', () => {
    const plan = sglangLaunchPlan(
      sglangSettings({ cuda_graphs: 'off' }),
      model(),
      card({ free_vram_bytes: 6.5 * GiB }),
      HOST
    )
    // Rounded down: the reserve never comes out below R.
    expect(plan.memFractionStatic).toBe(
      Math.floor((1 - SGLANG_RUNTIME_RESERVE_NO_GRAPHS_BYTES / (6.5 * GiB)) * 10_000) / 10_000
    )
    expect(SGLANG_RUNTIME_RESERVE_NO_GRAPHS_BYTES).toBeLessThan(SGLANG_RUNTIME_RESERVE_BYTES)
  })

  it('stays between 0.5 and 0.95', () => {
    expect(
      sglangMemFractionStatic(
        sglangSettings({}),
        card({ free_vram_bytes: 80 * GiB, total_vram_bytes: 80 * GiB }),
        HOST
      )
    ).toBe(0.95)
    expect(sglangMemFractionStatic(sglangSettings({}), card({ free_vram_bytes: 3 * GiB }), HOST)).toBe(0.5)
  })

  // Scenario "Доля задана вручную".
  it('Доля задана вручную: 0.7 in the settings is passed as it is, and auto does not apply', () => {
    const plan = sglangLaunchPlan(sglangSettings({ mem_fraction_static: 0.7 }), model(), card(), HOST)
    expect(plan.memFractionStatic).toBe(0.7)
    const argv = sglangAdapter.buildLaunch({
      modelId: 'm',
      settings: sglangSettings({ mem_fraction_static: 0.7 }),
      modelPath: '/atomic/model',
      engineCachePath: '/atomic/engine-cache',
      generationFilesPath: '/atomic/run',
      weightBytes: 4 * GiB,
      family: null,
      unifiedMemory: false,
      gpuTotalVramBytes: 8 * GiB,
      gpuComputeCapability: '8.9',
      plan,
    }).argv
    expect(argv[argv.indexOf('--mem-fraction-static') + 1]).toBe('0.7')
  })

  it('общая память GB10: SGLang’s static share never holds more than half of the host’s memory', () => {
    const host = { availableBytes: 100 * GiB, totalBytes: 120 * GiB }
    const gb10 = card({ total_vram_bytes: null, free_vram_bytes: null })
    const share = sglangMemFractionStatic(sglangSettings({}), gb10, host)
    // SGLang measures the host's available memory as free; its static share of that stays within half
    // of the host, less its reserve.
    expect(share * host.availableBytes).toBeLessThanOrEqual(host.totalBytes / 2)
    expect(share).toBe(0.58)
  })

  // Scenario "Гибридная модель".
  it('Гибридная модель: Qwen3.5 with no token limit set — no KV size from core, SGLang places KV and linear state itself', () => {
    const hybrid = {
      architectures: ['Qwen3_5ForConditionalGeneration'],
      layer_types: Array.from({ length: 24 }, (_, i) =>
        i % 4 === 3 ? 'full_attention' : 'linear_attention'
      ),
    }
    const plan = sglangLaunchPlan(sglangSettings({}), model(hybrid), card(), HOST)
    expect(Object.keys(plan).sort()).toEqual(['memFractionStatic', 'multimodal'])
    const argv = sglangAdapter.buildLaunch({
      modelId: 'Qwen/Qwen3.5-2B',
      settings: sglangSettings({}),
      modelPath: '/atomic/model',
      engineCachePath: '/atomic/engine-cache',
      generationFilesPath: '/atomic/run',
      weightBytes: 4 * GiB,
      family: null,
      unifiedMemory: false,
      gpuTotalVramBytes: 8 * GiB,
      gpuComputeCapability: '8.9',
      plan,
    }).argv
    expect(argv).not.toContain('--max-total-tokens')
  })

  it('marks a checkpoint with a vision or audio part as multimodal in the plan, a text-only one not', () => {
    const plan = (extra: Record<string, unknown>) =>
      sglangLaunchPlan(sglangSettings({}), model(extra), card(), HOST).multimodal
    expect(plan({})).toBe(false)
    expect(plan({ architectures: ['Qwen3_5ForConditionalGeneration'] })).toBe(true)
    expect(plan({ vision_config: { depth: 2 } })).toBe(true)
  })
})

describe('the KV cache the check counts', () => {
  it('is context × parallel requests tokens × the bytes per token of the model’s KV shape', () => {
    const settings = sglangSettings({
      max_output_tokens: 1024,
      context_length: 4096,
      max_running_requests: 2,
    })
    expect(sglangKvCacheBytes(model(), settings, card())).toEqual({
      bytes: 4096 * 2 * PER_TOKEN_BF16,
      basis: 'config',
    })
  })

  it('the KV token limit replaces the context; FP8 halves it, only on 8.9 and newer', () => {
    expect(sglangKvCacheBytes(model(), sglangSettings({ max_total_tokens: 2048 }), card()).bytes).toBe(
      2048 * PER_TOKEN_BF16
    )
    const fp8 = sglangSettings({ kv_cache_dtype: 'fp8' })
    expect(sglangKvCacheBytes(model(), fp8, card()).bytes).toBe((8192 * PER_TOKEN_BF16) / 2)
    expect(sglangKvCacheBytes(model(), fp8, card({ compute_capability: '8.6' })).bytes).toBe(
      8192 * PER_TOKEN_BF16
    )
  })

  it('counts only the attention layers of a hybrid model', () => {
    const hybrid = model({
      layer_types: Array.from({ length: 28 }, (_, i) =>
        i % 4 === 3 ? 'full_attention' : 'linear_attention'
      ),
    })
    const settings = sglangSettings({ context_length: 2048, max_output_tokens: 1024 })
    expect(sglangKvCacheBytes(hybrid, settings, card()).bytes).toBe(2048 * 2 * 7 * 8 * 128 * 2)
  })

  it('without the model’s shape: a quarter of the weights, at least 1 GiB', () => {
    const shapeless = {
      weightBytesTotal: 8 * GiB,
      configJson: { architectures: ['X'] },
      hfQuantConfigJson: null,
    }
    expect(sglangKvCacheBytes(shapeless, sglangSettings({}), card())).toEqual({
      bytes: 2 * GiB,
      basis: 'weight_fraction',
    })
    expect(
      sglangKvCacheBytes({ ...shapeless, weightBytesTotal: GiB }, sglangSettings({}), card()).bytes
    ).toBe(GiB)
  })
})

describe('the sglang check (same skeleton, SGLang’s memory rule)', () => {
  const settings = sglangSettings({ max_output_tokens: 1024, context_length: 4096, max_running_requests: 2 })
  const check = (files: CheckpointFile[], gpu: GpuFacts, host = HOST) =>
    checkCheckpoint(
      {
        repository: 'acme/model',
        revision: 'main',
        config_json: config(),
        hf_quant_config_json: null,
        files,
      },
      SGLANG,
      [gpu],
      host,
      sglangCheckEngine(settings)
    )

  it('fits when weights + KV + SGLang’s own overhead fit the free memory', () => {
    expect(check(weights(3 * GiB), card({ free_vram_bytes: 6.5 * GiB })).verdict).toEqual({ ok: true })
  })

  // Scenario "Модель не помещается".
  it('Модель не помещается: weights and KV over the free memory — MODEL_INCOMPATIBLE with needed and free bytes', () => {
    const verdict = check(weights(5 * GiB), card({ free_vram_bytes: 6.5 * GiB }))
    const needed =
      5 * GiB + 4096 * 2 * PER_TOKEN_BF16 + SGLANG_ENGINE_OVERHEAD_BYTES + SGLANG_FREE_MEMORY_MARGIN_BYTES
    expect(verdict.verdict).toMatchObject({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE', details: expect.stringContaining(`needed_bytes=${needed}`) },
    })
    if (!verdict.verdict.ok) expect(verdict.verdict.error.details).toContain(`free_bytes=${6.5 * GiB}`)
  })

  it('общая память GB10: counts only the half of the host’s memory the launch gives SGLang', () => {
    const gb10 = card({ total_vram_bytes: null, free_vram_bytes: null })
    const host = { availableBytes: 100 * GiB, totalBytes: 120 * GiB }
    expect(check(weights(50 * GiB), gb10, host).verdict).toEqual({ ok: true })
    // 70 GiB of weights fit the 100 GiB available, not the 60 GiB half of the host SGLang is given.
    expect(check(weights(70 * GiB), gb10, host).verdict).toMatchObject({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE' },
    })
  })

  it('a curated model is held to the sglang descriptor’s inventory_digest', () => {
    const curated = SGLANG.curated_models.find((entry) => entry.repository === 'Qwen/Qwen3.5-2B')
    expect(curated).toBeDefined()
    const verdict = checkCheckpoint(
      {
        repository: 'Qwen/Qwen3.5-2B',
        revision: curated?.revision ?? '',
        config_json: config(),
        hf_quant_config_json: null,
        files: weights(GiB),
      },
      SGLANG,
      [card()],
      HOST,
      sglangCheckEngine(sglangSettings({}))
    )
    expect(verdict.verdict).toMatchObject({ ok: false, error: { code: 'MANAGED_METADATA_INVALID' } })
  })
})
