import { describe, expect, it } from 'vitest'
import {
  GPU_OFFLOAD_WEIGHT_SHARE,
  contextPlanDevice,
  ggufContextPlanner,
  ggufKvBytesAt,
  isDefaultFitCtx,
  llamaKvLayout,
  marginalKvBytesPerToken,
  planContextWindow,
  planGgufContextWindow,
  planUnloadedGgufContext,
  previousDefaultCtx,
  probedContextDevices,
} from './context-plan.js'
import type { ContextPlanDevice, GgufContextPlannerDeps } from './context-plan.js'

const MiB = 2 ** 20
const GiB = 2 ** 30
const CONFIG = {
  cache_type_k: 'f16',
  cache_type_v: 'f16',
  ubatch_size: 0,
  parallel: 2,
  concurrent_mode: false,
  concurrent_slots: 8,
}

// The GGUF headers of four catalog-shaped models, as the core's reader renders them.
const MODELS = {
  // bartowski/Llama-3.2-1B-Instruct-GGUF Q4_K_M: 16 blocks × 8 KV heads of 64, 32 KiB a token.
  'Llama-3.2-1B Q4_K_M': {
    weights: 807_694_464,
    meta: {
      'general.architecture': 'llama',
      'llama.block_count': '16',
      'llama.context_length': '131072',
      'llama.attention.head_count': '32',
      'llama.attention.head_count_kv': '8',
      'llama.attention.key_length': '64',
      'llama.attention.value_length': '64',
    },
  },
  // bartowski/Meta-Llama-3.1-8B-Instruct-GGUF Q4_K_M: dense, 32 blocks × 8 KV heads of 128, 128 KiB.
  'Llama-3.1-8B Q4_K_M': {
    weights: 4_920_734_016,
    meta: {
      'general.architecture': 'llama',
      'llama.block_count': '32',
      'llama.context_length': '131072',
      'llama.attention.head_count': '32',
      'llama.attention.head_count_kv': '8',
      'llama.attention.key_length': '128',
      'llama.attention.value_length': '128',
    },
  },
  // unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF Q4_K_M: MoE, 48 blocks × 4 KV heads of 128, 96 KiB.
  'Qwen3-30B-A3B Q4_K_M': {
    weights: 18_556_686_208,
    meta: {
      'general.architecture': 'qwen3moe',
      'qwen3moe.block_count': '48',
      'qwen3moe.context_length': '262144',
      'qwen3moe.attention.head_count': '32',
      'qwen3moe.attention.head_count_kv': '4',
      'qwen3moe.attention.key_length': '128',
      'qwen3moe.attention.value_length': '128',
    },
  },
  // google/gemma-3-12b-it Q4_K_M: 48 blocks, 5 sliding (1024 tokens) to 1 global, 8 KV heads of 256.
  'Gemma-3-12B Q4_K_M': {
    weights: 7_300_574_976,
    meta: {
      'general.architecture': 'gemma3',
      'gemma3.block_count': '48',
      'gemma3.context_length': '131072',
      'gemma3.attention.head_count': '16',
      'gemma3.attention.head_count_kv': '8',
      'gemma3.attention.key_length': '256',
      'gemma3.attention.value_length': '256',
      'gemma3.attention.sliding_window': '1024',
    },
  },
} as const

type ModelName = keyof typeof MODELS

// Free memory as a desktop with a display attached reports it; 32 GiB of RAM, 24 GiB of it free.
const DEVICES: Record<string, ContextPlanDevice> = {
  'Mac 8 GB': { kind: 'unified', totalMemoryBytes: 8 * GiB },
  'Mac 16 GB': { kind: 'unified', totalMemoryBytes: 16 * GiB },
  'Mac 36 GB': { kind: 'unified', totalMemoryBytes: 36 * GiB },
  'Mac 64 GB': { kind: 'unified', totalMemoryBytes: 64 * GiB },
  'RTX 8 GB': { kind: 'gpu', freeVramBytes: 7800 * MiB, freeSystemBytes: 24 * GiB },
  'RTX 12 GB': { kind: 'gpu', freeVramBytes: 11_900 * MiB, freeSystemBytes: 24 * GiB },
  'RTX 24 GB': { kind: 'gpu', freeVramBytes: 24_100 * MiB, freeSystemBytes: 24 * GiB },
  'CPU 16 GB': { kind: 'cpu', totalMemoryBytes: 16 * GiB, freeSystemBytes: 10 * GiB },
}

const fitOn = (model: ModelName, device: string) =>
  planGgufContextWindow({
    meta: MODELS[model].meta,
    weightsBytes: MODELS[model].weights,
    config: CONFIG,
    device: DEVICES[device]!,
  })

const fitOff = (model: ModelName, device: string) => {
  const meta: Record<string, string> = MODELS[model].meta
  const trained = Number(meta[`${meta['general.architecture']}.context_length`])
  return planGgufContextWindow({
    meta,
    weightsBytes: MODELS[model].weights,
    config: CONFIG,
    device: DEVICES[device]!,
    floorCtx: previousDefaultCtx(trained, DEVICES[device]!),
    offloadShare: 0,
  })
}

describe('planGgufContextWindow — the window each device holds for each model', () => {
  // [model, device, fit on (fit's 4096 floor, a quarter of the weights may leave a GPU), fit off
  // (every layer stays, never below the previous default)]
  it.each([
    ['Llama-3.2-1B Q4_K_M', 'Mac 8 GB', 32_768, 32_768],
    ['Llama-3.2-1B Q4_K_M', 'Mac 16 GB', 131_072, 131_072],
    ['Llama-3.2-1B Q4_K_M', 'RTX 8 GB', 131_072, 131_072],
    ['Llama-3.2-1B Q4_K_M', 'CPU 16 GB', 131_072, 131_072],
    ['Llama-3.1-8B Q4_K_M', 'Mac 8 GB', 4096, 16_384],
    ['Llama-3.1-8B Q4_K_M', 'Mac 16 GB', 19_712, 32_768],
    ['Llama-3.1-8B Q4_K_M', 'Mac 36 GB', 101_632, 101_632],
    ['Llama-3.1-8B Q4_K_M', 'Mac 64 GB', 131_072, 131_072],
    ['Llama-3.1-8B Q4_K_M', 'RTX 8 GB', 17_664, 32_768],
    ['Llama-3.1-8B Q4_K_M', 'RTX 12 GB', 50_432, 41_216],
    ['Llama-3.1-8B Q4_K_M', 'RTX 24 GB', 131_072, 131_072],
    ['Llama-3.1-8B Q4_K_M', 'CPU 16 GB', 19_712, 32_768],
    ['Qwen3-30B-A3B Q4_K_M', 'Mac 36 GB', 4096, 32_768],
    ['Qwen3-30B-A3B Q4_K_M', 'Mac 64 GB', 149_760, 149_760],
    ['Qwen3-30B-A3B Q4_K_M', 'RTX 8 GB', 51_200, 32_768],
    ['Qwen3-30B-A3B Q4_K_M', 'RTX 12 GB', 51_200, 32_768],
    ['Qwen3-30B-A3B Q4_K_M', 'RTX 24 GB', 93_440, 46_336],
    ['Qwen3-30B-A3B Q4_K_M', 'CPU 16 GB', 4096, 32_768],
    ['Gemma-3-12B Q4_K_M', 'Mac 16 GB', 4096, 32_768],
    ['Gemma-3-12B Q4_K_M', 'Mac 36 GB', 131_072, 131_072],
    ['Gemma-3-12B Q4_K_M', 'RTX 8 GB', 31_744, 32_768],
    ['Gemma-3-12B Q4_K_M', 'RTX 12 GB', 61_184, 33_280],
    ['Gemma-3-12B Q4_K_M', 'RTX 24 GB', 131_072, 131_072],
  ] as const)('%s on a %s: %i with fit, %i without', (model, device, on, off) => {
    expect(fitOn(model, device)?.maxCtx).toBe(on)
    expect(fitOff(model, device)?.maxCtx).toBe(off)
  })

  it('works the 8B numbers through: 12 GB card, 16 GB and 36 GB Mac', () => {
    // RTX 12 GB: 11900 − 1024 MiB margin; 4693 MiB of weights, 1024 of reserve; a quarter of the
    // weights (1173 MiB) may leave: 6332 MiB of KV at 128 KiB is 50656 tokens → 50432.
    expect(fitOn('Llama-3.1-8B Q4_K_M', 'RTX 12 GB')).toEqual({
      recommendedCtx: 50_432,
      maxCtx: 50_432,
      trainedCtx: 131_072,
      kvBytesPerToken: 131_072,
      basis: 'gpu',
    })
    // Mac 16 GB: half of RAM, 8192 − 4693 − 1024 MiB = 2475 MiB of KV → 19712 (fit off keeps 32K).
    expect(fitOn('Llama-3.1-8B Q4_K_M', 'Mac 16 GB')?.basis).toBe('unified')
    // Mac 36 GB: 18432 − 4693 − 1024 MiB = 12715 MiB → 101720 tokens → 101632.
    expect(fitOff('Llama-3.1-8B Q4_K_M', 'Mac 36 GB')?.recommendedCtx).toBe(101_632)
  })

  it('reports what one more token costs: a sliding-window model only its global layers', () => {
    expect(fitOn('Llama-3.2-1B Q4_K_M', 'RTX 8 GB')?.kvBytesPerToken).toBe(32_768)
    expect(fitOn('Qwen3-30B-A3B Q4_K_M', 'RTX 8 GB')?.kvBytesPerToken).toBe(98_304)
    // 8 global layers × 8 heads × 512 × 2 bytes; the 40 sliding ones stop growing at their window.
    expect(fitOn('Gemma-3-12B Q4_K_M', 'RTX 8 GB')?.kvBytesPerToken).toBe(65_536)
    expect(fitOn('Gemma-3-12B Q4_K_M', 'CPU 16 GB')?.basis).toBe('cpu')
  })

  it('gives no plan for a GGUF it cannot read', () => {
    const plan = (meta: Record<string, string> | undefined) =>
      planGgufContextWindow({ meta, weightsBytes: 1, config: CONFIG, device: DEVICES['Mac 36 GB']! })
    expect(plan(undefined)).toBeUndefined()
    expect(plan({ 'general.architecture': 'llama' })).toBeUndefined()
    expect(plan({ 'general.architecture': 'llama', 'llama.context_length': '8192' })).toBeUndefined()
  })
})

describe('planContextWindow', () => {
  const kv = (perToken: number) => (ctx: number) => ctx * perToken
  const gpu = (freeVramBytes: number, freeSystemBytes?: number): ContextPlanDevice => ({
    kind: 'gpu',
    freeVramBytes,
    ...(freeSystemBytes !== undefined ? { freeSystemBytes } : {}),
  })

  it('takes the trained window when it fits, else the largest multiple of 256 below it', () => {
    const plan = (trainedCtx: number) =>
      planContextWindow({ device: gpu(4 * GiB), weightsBytes: 0, trainedCtx, kvBytesAt: kv(MiB / 8) })
    // 4 GiB − 1 GiB margin − 1 GiB reserve = 2 GiB of KV at 128 KiB: 16384 tokens.
    expect(plan(10_000)?.maxCtx).toBe(10_000)
    expect(plan(40_000)?.maxCtx).toBe(16_384)
    expect(plan(40_000)?.recommendedCtx).toBe(16_384)
  })

  it('never goes below the floor, nor above the trained window', () => {
    const tight = { device: gpu(GiB), weightsBytes: 0, trainedCtx: 65_536, kvBytesAt: kv(MiB) }
    expect(planContextWindow(tight)?.maxCtx).toBe(4096)
    expect(planContextWindow({ ...tight, floorCtx: 32_768 })?.maxCtx).toBe(32_768)
    expect(planContextWindow({ ...tight, trainedCtx: 2048 })?.maxCtx).toBe(2048)
    // A floor that is not a multiple of 256 stays the floor when nothing above it fits.
    expect(planContextWindow({ ...tight, floorCtx: 5000 })?.maxCtx).toBe(5000)
  })

  it('caps unified memory below 16 GiB at 32K, and sizes it by half of RAM or a budget given', () => {
    const mac = (totalMemoryBytes: number, budgetBytes?: number) =>
      planContextWindow({
        device: { kind: 'unified', totalMemoryBytes, ...(budgetBytes !== undefined ? { budgetBytes } : {}) },
        weightsBytes: GiB,
        trainedCtx: 262_144,
        kvBytesAt: kv(16 * 1024),
      })
    expect(mac(8 * GiB)?.maxCtx).toBe(32_768)
    // 16 GiB: 8 − 1 − 1 GiB = 6 GiB at 16 KiB, 393216 tokens: the trained 262144.
    expect(mac(16 * GiB)?.maxCtx).toBe(262_144)
    // Fit's budget (Metal free less the margin) instead of half of RAM: 3 − 1 − 1 GiB → 65536.
    expect(mac(16 * GiB, 3 * GiB)?.maxCtx).toBe(65_536)
  })

  it('lets a window push at most the share of the weights off a GPU, and no more than free RAM holds', () => {
    // 10 GiB card less 1 GiB margin: 8 GiB of weights and 1 GiB of reserve leave nothing for KV.
    const base = { device: gpu(10 * GiB), weightsBytes: 8 * GiB, trainedCtx: 1_048_576, kvBytesAt: kv(1024) }
    // A quarter of 8 GiB is 2 GiB of KV at 1 KiB a token: 2097152 tokens, past the trained window.
    expect(planContextWindow(base)?.maxCtx).toBe(1_048_576)
    // A sixteenth: 512 MiB beyond the 4 MiB the floor's KV already takes.
    expect(planContextWindow({ ...base, offloadShare: 0.0625 })?.maxCtx).toBe(528_384)
    // Every layer on the card: the 4096 floor.
    expect(planContextWindow({ ...base, offloadShare: 0 })?.maxCtx).toBe(4096)
    // Free RAM 2.5 GiB less the 2 GiB the system keeps: 512 MiB may leave.
    expect(planContextWindow({ ...base, device: gpu(10 * GiB, 2.5 * GiB) })?.maxCtx).toBe(524_288)
    // A margin of the user's own narrows the card.
    expect(
      planContextWindow({ ...base, offloadShare: 0, weightsBytes: 6 * GiB, marginBytes: 2 * GiB })?.maxCtx
    ).toBe(1_048_576)
    expect(GPU_OFFLOAD_WEIGHT_SHARE).toBe(0.25)
  })

  it('counts only what the window adds for a model that does not fit the card at the floor', () => {
    // 20 GiB of weights on a 9 GiB card: 12 GiB leave at the floor anyway, the window may add 5 more.
    const plan = planContextWindow({
      device: gpu(9 * GiB, 64 * GiB),
      weightsBytes: 20 * GiB,
      trainedCtx: 8_388_608,
      kvBytesAt: kv(1024),
    })
    expect(plan?.maxCtx).toBe(5 * 1024 * 1024 + 4096)
  })

  it('sizes a CPU by half of RAM and by free RAM less the reserve', () => {
    const cpu = (freeSystemBytes?: number) =>
      planContextWindow({
        device: {
          kind: 'cpu',
          totalMemoryBytes: 16 * GiB,
          ...(freeSystemBytes !== undefined ? { freeSystemBytes } : {}),
        },
        weightsBytes: 4 * GiB,
        trainedCtx: 1_048_576,
        kvBytesAt: kv(1024),
      })
    // 8 − 4 − 1 GiB = 3 GiB of KV at 1 KiB.
    expect(cpu()?.maxCtx).toBe(1_048_576)
    expect(cpu(7 * GiB)?.maxCtx).toBe(4096)
    expect(cpu(8 * GiB)?.maxCtx).toBe(1_048_576)
  })

  it('gives no plan without a trained window or a KV estimate', () => {
    const device = gpu(8 * GiB)
    expect(planContextWindow({ device, weightsBytes: 0, trainedCtx: undefined, kvBytesAt: kv(1) })).toBe(
      undefined
    )
    expect(planContextWindow({ device, weightsBytes: 0, trainedCtx: 0, kvBytesAt: kv(1) })).toBeUndefined()
    expect(
      planContextWindow({ device, weightsBytes: 0, trainedCtx: 8192, kvBytesAt: () => undefined })
    ).toBeUndefined()
    // An estimate that fails above the floor.
    expect(
      planContextWindow({
        device: gpu(GiB),
        weightsBytes: 0,
        trainedCtx: 65_536,
        kvBytesAt: (ctx) => (ctx <= 4096 ? 0 : undefined),
      })
    ).toBeUndefined()
    expect(
      planContextWindow({
        device: gpu(4 * GiB),
        weightsBytes: 0,
        trainedCtx: 65_536,
        kvBytesAt: (ctx) => (ctx <= 4096 ? 0 : ctx === 65_536 ? 64 * GiB : undefined),
      })
    ).toBeUndefined()
  })

  it('passes a KV cost per token through, and leaves out one that says nothing', () => {
    const plan = (kvBytesPerToken: number) =>
      planContextWindow({
        device: gpu(8 * GiB),
        weightsBytes: 0,
        trainedCtx: 8192,
        kvBytesAt: kv(1),
        kvBytesPerToken,
      })
    expect(plan(512)?.kvBytesPerToken).toBe(512)
    expect(plan(0)).not.toHaveProperty('kvBytesPerToken')
  })
})

describe('llamaKvLayout / ggufKvBytesAt / marginalKvBytesPerToken', () => {
  it('sizes the cache for concurrent mode, --parallel or llama.cpp’s four slots, and the micro-batch', () => {
    expect(llamaKvLayout(CONFIG)).toEqual({ nSeq: 2 })
    expect(llamaKvLayout({ ...CONFIG, parallel: 0, ubatch_size: 256 })).toEqual({ nSeq: 4, nUbatch: 256 })
    expect(llamaKvLayout({ ...CONFIG, concurrent_mode: true, concurrent_slots: 1 })).toEqual({ nSeq: 2 })
  })

  it('estimates the pool, or nothing for a header it cannot read', () => {
    const meta = MODELS['Llama-3.1-8B Q4_K_M'].meta
    expect(ggufKvBytesAt(meta, CONFIG)(4096)).toBe(4096 * 131_072)
    expect(ggufKvBytesAt(meta, { ...CONFIG, cache_type_k: 'q8_0', cache_type_v: 'q8_0' })(4096)).toBe(
      4096 * 69_632
    )
    expect(ggufKvBytesAt(undefined, CONFIG)(4096)).toBeUndefined()
    expect(ggufKvBytesAt({ 'general.architecture': 'x' }, CONFIG)(4096)).toBeUndefined()
  })

  it('takes the slope over the upper half of the window, or the average for a short one', () => {
    const swa = (ctx: number) => 1000 + ctx * 10
    expect(marginalKvBytesPerToken(swa, 65_536)).toBe(10)
    expect(marginalKvBytesPerToken(swa, 4096)).toBe(11)
    expect(marginalKvBytesPerToken(() => undefined, 65_536)).toBeUndefined()
    expect(marginalKvBytesPerToken((ctx) => (ctx > 40_000 ? 1 : undefined), 65_536)).toBeUndefined()
  })
})

describe('contextPlanDevice', () => {
  const SYSTEM = { totalMemoryBytes: 32 * GiB, freeMemoryBytes: 20 * GiB }
  const CUDA = [
    { id: 'CUDA0', name: 'RTX 3060', mem: 12_288, free: 11_000 },
    { id: 'CUDA1', name: 'RTX 4090', mem: 24_564, free: 23_000 },
  ]

  it('sizes Apple silicon by its RAM', () => {
    expect(contextPlanDevice({ unifiedMemory: { totalMemoryBytes: 16 * GiB }, devices: CUDA })).toEqual({
      kind: 'unified',
      totalMemoryBytes: 16 * GiB,
    })
  })

  it('takes the listed GPU with the most free memory, of those the device setting names', () => {
    expect(contextPlanDevice({ devices: CUDA, system: SYSTEM })).toEqual({
      kind: 'gpu',
      freeVramBytes: 23_000 * MiB,
      freeSystemBytes: 20 * GiB,
    })
    expect(contextPlanDevice({ devices: CUDA, deviceSetting: 'cuda0' })).toEqual({
      kind: 'gpu',
      freeVramBytes: 11_000 * MiB,
    })
  })

  it('falls back to system RAM for a CPU build, a `none` device, or a device it does not list', () => {
    const cpu = { kind: 'cpu', totalMemoryBytes: 32 * GiB, freeSystemBytes: 20 * GiB }
    expect(contextPlanDevice({ devices: [], system: SYSTEM })).toEqual(cpu)
    expect(contextPlanDevice({ devices: CUDA, deviceSetting: 'none', system: SYSTEM })).toEqual(cpu)
    expect(
      contextPlanDevice({
        unifiedMemory: { totalMemoryBytes: 8 * GiB },
        deviceSetting: 'none',
        system: SYSTEM,
      })
    ).toEqual(cpu)
    expect(contextPlanDevice({ devices: CUDA, deviceSetting: 'Vulkan0', system: SYSTEM })).toEqual(cpu)
    expect(
      contextPlanDevice({
        devices: [{ id: 'BLAS', name: 'Accelerate', mem: 0, free: 0 }],
        system: { totalMemoryBytes: GiB },
      })
    ).toEqual({ kind: 'cpu', totalMemoryBytes: GiB })
  })

  it('knows nothing without memory facts', () => {
    expect(contextPlanDevice({})).toBeUndefined()
    expect(contextPlanDevice({ system: { totalMemoryBytes: 0 } })).toBeUndefined()
    expect(contextPlanDevice({ unifiedMemory: { totalMemoryBytes: 0 } })).toBeUndefined()
  })
})

describe('probedContextDevices', () => {
  it('keeps discrete GPUs, their whole memory standing in for the free memory', () => {
    expect(
      probedContextDevices([
        { name: 'RTX 4070', vendor: 'NVIDIA', total_memory: 12_282 },
        {
          name: 'Radeon 780M',
          vendor: 'AMD',
          total_memory: 512,
          vulkan_info: { device_type: 'IntegratedGpu' },
        },
        { name: 'Strix Halo', vendor: 'AMD', total_memory: 512, shared_memory: 65_536 },
        { vendor: 'Intel', total_memory: 0 },
        { vendor: 'Unknown (vendor_id: 0)' },
      ])
    ).toEqual([{ id: 'GPU0', name: 'RTX 4070', mem: 12_282, free: 12_282 }])
  })
})

describe('previousDefaultCtx / isDefaultFitCtx', () => {
  it('is the default before the plan: 32K, the trained window when smaller, 16K on a small Mac', () => {
    const gpu: ContextPlanDevice = { kind: 'gpu', freeVramBytes: GiB }
    expect(previousDefaultCtx(131_072, gpu)).toBe(32_768)
    expect(previousDefaultCtx(8192, gpu)).toBe(8192)
    expect(previousDefaultCtx(undefined, gpu)).toBe(32_768)
    expect(previousDefaultCtx(131_072, { kind: 'unified', totalMemoryBytes: 8 * GiB })).toBe(16_384)
    expect(previousDefaultCtx(8192, { kind: 'unified', totalMemoryBytes: 8 * GiB })).toBe(8192)
    expect(previousDefaultCtx(131_072, { kind: 'unified', totalMemoryBytes: 16 * GiB })).toBe(32_768)
  })

  it.each([
    ['', true],
    ['  ', true],
    [undefined, true],
    [0, true],
    ['0', true],
    [4096, true],
    ['4096', true],
    ['8192', false],
    [16_384, false],
  ])('fit_ctx %j is the default: %s', (value, expected) => {
    expect(isDefaultFitCtx(value)).toBe(expected)
  })
})

describe('planUnloadedGgufContext', () => {
  const model = {
    metadata: MODELS['Llama-3.1-8B Q4_K_M'].meta,
    weightsBytes: MODELS['Llama-3.1-8B Q4_K_M'].weights,
  }
  const settings = { ...CONFIG, fit: true, fit_ctx: '4096', fit_target: '', device: '' }
  const planner = (over: Partial<GgufContextPlannerDeps> = {}): GgufContextPlannerDeps => ({
    settings: async () => settings,
    unifiedMemory: async () => undefined,
    systemMemory: async () => ({ totalMemoryBytes: 32 * GiB, freeMemoryBytes: 24 * GiB }),
    gpus: async () => [{ name: 'RTX 3060', vendor: 'NVIDIA', total_memory: 12_288 }],
    ...over,
  })

  it('plans on the probed card with fit, every layer on it without, and RAM on Apple silicon', async () => {
    // 12288 MiB stands in for the free memory: 53760 tokens, a little more than a load measures.
    expect(await planUnloadedGgufContext(model, planner())).toMatchObject({ maxCtx: 53_760, basis: 'gpu' })
    expect(
      await planUnloadedGgufContext(model, planner({ settings: async () => ({ ...settings, fit: false }) }))
    ).toMatchObject({ maxCtx: 44_288, basis: 'gpu' })
    expect(
      await planUnloadedGgufContext(
        model,
        planner({ settings: async () => ({ ...settings, fit_ctx: '65536', fit_target: '2048' }) })
      )
      // The user's floor and margin: what leaves the card at 65536 is not the window's doing, a quarter
      // of the weights more may leave above it.
    ).toMatchObject({ maxCtx: 74_752 })
    expect(
      await planUnloadedGgufContext(
        model,
        planner({ unifiedMemory: async () => ({ totalMemoryBytes: 36 * GiB }) })
      )
    ).toMatchObject({ maxCtx: 101_632, basis: 'unified' })
  })

  it('gives no plan when nothing is known, or a probe fails', async () => {
    expect(
      await planUnloadedGgufContext(
        model,
        planner({ gpus: async () => [], systemMemory: async () => undefined })
      )
    ).toBeUndefined()
    expect(
      await planUnloadedGgufContext(
        model,
        planner({
          gpus: async () => {
            throw new Error('probe failed')
          },
        })
      )
    ).toBeUndefined()
  })
})

describe('ggufContextPlanner', () => {
  const model = {
    metadata: MODELS['Llama-3.1-8B Q4_K_M'].meta,
    weightsBytes: MODELS['Llama-3.1-8B Q4_K_M'].weights,
  }
  const planner = (stored: Record<string, unknown>) =>
    ggufContextPlanner({
      settings: () => stored,
      unifiedMemory: async () => undefined,
      systemMemory: async () => ({ totalMemoryBytes: 32 * GiB, freeMemoryBytes: 24 * GiB }),
      gpus: async () => [{ name: 'RTX 3060', vendor: 'NVIDIA', total_memory: 12_288 }],
    })

  it('plans for the llama.cpp providers with their stored settings, and for no other', async () => {
    const stored = { ...CONFIG, fit: true, fit_ctx: 4096, fit_target: '', device: '' }
    for (const provider of ['llamacpp-upstream', 'llamacpp', 'atomic-prism'] as const)
      expect(await planner(stored)(provider, model)).toMatchObject({ maxCtx: 53_760, basis: 'gpu' })
    expect(await planner(stored)('mlx', model)).toBeUndefined()
    expect(await planner(stored)('geniex', model)).toBeUndefined()
    // Settings missing a serde-default key read as the app’s Rust would fill them in: one slot.
    const { parallel: _unused, ...withoutParallel } = stored
    expect(await planner({ ...withoutParallel, fit: false })('llamacpp-upstream', model)).toMatchObject({
      maxCtx: 44_288,
    })
  })
})
