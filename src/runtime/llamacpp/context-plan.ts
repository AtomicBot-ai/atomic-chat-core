/**
 * The window a model gets by default on this device (`ContextPlan`, `src/contracts/context.ts`): the
 * largest that fits, never above the window it was trained for.
 *
 * Every engine whose window the core chooses used to start from a fixed number — 32K with fit off and
 * on MLX, llama.cpp's own 4096-token floor under fit on a discrete GPU (fit shrinks the window to it
 * to keep every layer on the card) — while a chat that outgrows its window is now compacted, so a
 * window larger than the device can hold only fails the load, and one smaller than it can hold costs
 * the user context for nothing. The plan tries windows from the trained one down, in steps of 256
 * tokens as fit's own windows are, and keeps the first the device's memory rule passes:
 *
 * - unified memory (Apple silicon): the weights, the KV cache and the compute reserve within the same
 *   half of RAM fit leaves llama.cpp (ADR 2026-09-29), and below 16 GiB never above the 32K ceiling
 *   that protects 8 GB Macs (ADR 2026-10-29);
 * - a discrete GPU: the weights, the KV cache and the reserve within the card's free memory less fit's
 *   margin, where the window may push at most {@link GPU_OFFLOAD_WEIGHT_SHARE} of the weights off the
 *   card into system RAM, and never more than free RAM holds;
 * - CPU only: the weights, the KV cache and the reserve within half of RAM (and free RAM).
 *
 * Nothing goes below the caller's floor — the window a load gets when not even that fits, which is
 * what it got before (fit's 4096 floor, the previous 32K/16K default) — so the plan never gives
 * anyone a narrower window than before. `recommendedCtx` is `maxCtx`: the owner wants the maximum by
 * default; the two fields stay apart so a future cap can differ.
 *
 * Pure: the device facts, the weights and the KV estimate are the caller's.
 */

import type {
  ContextPlan,
  DeviceInfo,
  GpuProbeInfo,
  LlamacppConfig,
  LocalProviderId,
} from '../../contracts/index.js'
import { hasSharedGpuMemory } from '../../hardware/index.js'
import { estimateKvCache, ggufContextLength, isIntegratedGpu } from '../../models/index.js'
import type { KvCacheLayout } from '../../models/index.js'
import { withLlamacppDefaults } from './args.js'
import type { LlamacppConfigInput } from './args.js'
import { DEFAULT_CTX_LEN } from './ctx-ladder.js'
import {
  DEFAULT_FIT_CTX,
  DEFAULT_FIT_TARGET_MIB,
  FIT_COMPUTE_RESERVE_BYTES,
  FIT_CTX_ALIGN,
  PREVIOUS_DEFAULT_CTX,
  SMALL_UNIFIED_MEMORY_BYTES,
  SMALL_UNIFIED_MEMORY_CTX_CAP,
  UNIFIED_MEMORY_LLAMA_SHARE,
} from './fit-margin.js'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

/**
 * The share of a model's weights its window may push off a discrete GPU into system RAM — the one
 * tunable of the plan. Fit keeps the planned window and moves layers (MoE experts first) to the CPU
 * to make room. Token generation is bound by memory bandwidth, so every byte that leaves the card
 * runs at system RAM's speed: a quarter of a dense model's weights on dual-channel DDR5 makes a token
 * about twice as slow as on a mid-range card, an MoE model loses less. A quarter buys an 8 GB card
 * with an 8B Q4 model ~15K tokens instead of ~5K with every layer on the card, and changes nothing
 * for a model whose trained window already fits beside the weights.
 */
export const GPU_OFFLOAD_WEIGHT_SHARE = 0.25

/** Free system RAM left to the system and the app when the plan moves layers off the GPU. */
export const OFFLOAD_RAM_RESERVE_BYTES = 2 * GiB

/** The memory a plan is sized against. */
export type ContextPlanDevice =
  | {
      kind: 'unified'
      /** Physical RAM, shared by the CPU and the GPU. */
      totalMemoryBytes: number
      /**
       * What llama.cpp may fill: under fit, Metal's free memory less the margin it is given. Absent:
       * half of RAM (`UNIFIED_MEMORY_LLAMA_SHARE`), the budget fit's margin leaves.
       */
      budgetBytes?: number
    }
  | {
      kind: 'gpu'
      /** The free memory of the card the model goes on (`--list-devices`), before fit's margin. */
      freeVramBytes: number
      /** Free system RAM, which bounds what may leave the card; absent, only the share bounds it. */
      freeSystemBytes?: number
    }
  | { kind: 'cpu'; totalMemoryBytes: number; freeSystemBytes?: number }

export interface ContextWindowInput {
  device: ContextPlanDevice
  /** Everything the engine holds as weights: every shard, plus a draft model when there is one. */
  weightsBytes: number
  /** The window the model was trained for; `undefined` gives no plan. */
  trainedCtx: number | undefined
  /** The KV cache at a window of `ctx` tokens; `undefined` when it cannot be estimated (no plan). */
  kvBytesAt: (ctx: number) => number | undefined
  /** Passed through to the plan. */
  kvBytesPerToken?: number
  /** The window granted even when it does not fit (never above the trained one). Default 4096. */
  floorCtx?: number
  /** GPU: the share of the weights the window may push off the card. Default {@link GPU_OFFLOAD_WEIGHT_SHARE}. */
  offloadShare?: number
  /** GPU: memory left free on the card, as fit's `--fit-target`. Default 1024 MiB. */
  marginBytes?: number
}

/** Whether a window fits, or `undefined` when its KV cache cannot be estimated. */
type Fits = (ctx: number) => boolean | undefined

function memoryRule(input: ContextWindowInput, floor: number): Fits | undefined {
  const weights = Math.max(0, input.weightsBytes)
  const kvAt = input.kvBytesAt
  const { device } = input
  if (device.kind === 'unified' || device.kind === 'cpu') {
    let budget =
      device.kind === 'unified' && device.budgetBytes !== undefined
        ? device.budgetBytes
        : device.totalMemoryBytes * UNIFIED_MEMORY_LLAMA_SHARE
    if (device.kind === 'cpu' && device.freeSystemBytes !== undefined)
      budget = Math.min(budget, device.freeSystemBytes - OFFLOAD_RAM_RESERVE_BYTES)
    const room = budget - weights - FIT_COMPUTE_RESERVE_BYTES
    return (ctx) => {
      const kv = kvAt(ctx)
      return kv === undefined ? undefined : kv <= room
    }
  }
  const vram = device.freeVramBytes - (input.marginBytes ?? DEFAULT_FIT_TARGET_MIB * MiB)
  const share = Math.min(1, Math.max(0, input.offloadShare ?? GPU_OFFLOAD_WEIGHT_SHARE))
  const ram =
    device.freeSystemBytes === undefined
      ? Infinity
      : Math.max(0, device.freeSystemBytes - OFFLOAD_RAM_RESERVE_BYTES)
  const offloaded = (ctx: number): number | undefined => {
    const kv = kvAt(ctx)
    return kv === undefined ? undefined : Math.max(0, weights + kv + FIT_COMPUTE_RESERVE_BYTES - vram)
  }
  // What must leave the card at the floor anyway (a model larger than the card) is not the window's
  // doing: the share bounds what the window adds on top of it.
  const baseline = offloaded(floor)
  if (baseline === undefined) return undefined
  return (ctx) => {
    const off = offloaded(ctx)
    return off === undefined ? undefined : off <= ram && off - baseline <= share * weights
  }
}

/** The largest window in `[floor, top]` that fits: `top` itself, else a multiple of 256 below it. */
function largestFitting(floor: number, top: number, fits: Fits): number | undefined {
  if (top <= floor) return floor
  const atTop = fits(top)
  if (atTop === undefined) return undefined
  if (atTop) return top
  let lo = Math.ceil(floor / FIT_CTX_ALIGN)
  let hi = Math.ceil(top / FIT_CTX_ALIGN) - 1
  let best = floor
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const ok = fits(mid * FIT_CTX_ALIGN)
    if (ok === undefined) return undefined
    if (ok) {
      best = Math.max(best, mid * FIT_CTX_ALIGN)
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

/**
 * The window a model gets by default on `device`, and the largest it can hold there: the trained
 * window when it fits, else the largest multiple of 256 below it that does, never below the floor.
 * `undefined` when the trained window is unknown or the KV cache cannot be estimated — the caller
 * keeps its previous default then.
 */
export function planContextWindow(input: ContextWindowInput): ContextPlan | undefined {
  const trained = input.trainedCtx
  if (trained === undefined || !(trained > 0)) return undefined
  const floor = Math.min(trained, Math.max(1, Math.floor(input.floorCtx ?? DEFAULT_FIT_CTX)))
  const { device } = input
  const small = device.kind === 'unified' && device.totalMemoryBytes < SMALL_UNIFIED_MEMORY_BYTES
  const top = small ? Math.min(trained, SMALL_UNIFIED_MEMORY_CTX_CAP) : trained
  const fits = memoryRule(input, floor)
  if (!fits || fits(floor) === undefined) return undefined
  const largest = largestFitting(floor, top, fits)
  if (largest === undefined) return undefined
  const maxCtx = Math.max(floor, largest)
  return {
    recommendedCtx: maxCtx,
    maxCtx,
    trainedCtx: trained,
    ...(input.kvBytesPerToken !== undefined && input.kvBytesPerToken > 0
      ? { kvBytesPerToken: input.kvBytesPerToken }
      : {}),
    basis: device.kind,
  }
}

/** The llama.cpp settings a GGUF plan reads. */
export type ContextPlanConfig = Pick<
  LlamacppConfig,
  'cache_type_k' | 'cache_type_v' | 'ubatch_size' | 'parallel' | 'concurrent_mode' | 'concurrent_slots'
>

/**
 * How llama.cpp lays the KV cache out for these settings: the sequences it sizes the cache for —
 * concurrent mode's slots, else `--parallel` (0 leaves it to llama.cpp, whose auto is 4 slots,
 * `tools/server/server.cpp:126-130`) — and the micro-batch. With one unified pool (`-kvu`, always
 * sent) the slots no longer multiply the cache; only each sliding-window layer keeps a window per
 * sequence.
 */
export function llamaKvLayout(cfg: ContextPlanConfig): KvCacheLayout {
  const nSeq = cfg.concurrent_mode ? Math.max(cfg.concurrent_slots, 2) : cfg.parallel > 0 ? cfg.parallel : 4
  return { nSeq, ...(cfg.ubatch_size > 0 ? { nUbatch: cfg.ubatch_size } : {}) }
}

/** The unified KV cache at a pool of `ctx` cells, every slot included; `undefined` when the GGUF cannot tell. */
export function ggufKvBytesAt(
  meta: Record<string, string> | undefined,
  cfg: ContextPlanConfig
): (ctx: number) => number | undefined {
  const layout = llamaKvLayout(cfg)
  return (ctx) => {
    if (!meta) return undefined
    try {
      return estimateKvCache(meta, ctx, cfg.cache_type_k, cfg.cache_type_v, layout).size
    } catch {
      return undefined
    }
  }
}

export interface GgufContextPlanInput {
  meta: Record<string, string> | undefined
  weightsBytes: number
  config: ContextPlanConfig
  device: ContextPlanDevice
  floorCtx?: number
  offloadShare?: number
  marginBytes?: number
}

/**
 * What one more token of window costs in KV cache: the slope of the estimate over the upper half of
 * the trained window, where a sliding-window layer's cells no longer grow — so a Gemma 3 counts only
 * its global layers, as a longer window really costs it. A window too short for that: the average.
 */
export function marginalKvBytesPerToken(
  kvBytesAt: (ctx: number) => number | undefined,
  trainedCtx: number
): number | undefined {
  const half = Math.floor(trainedCtx / 2)
  const top = kvBytesAt(trainedCtx)
  if (top === undefined) return undefined
  if (half < DEFAULT_FIT_CTX) return Math.ceil(top / trainedCtx)
  const low = kvBytesAt(half)
  return low === undefined ? undefined : Math.ceil((top - low) / (trainedCtx - half))
}

/** {@link planContextWindow} for a GGUF: its trained window and its KV cache as llama.cpp lays it out. */
export function planGgufContextWindow(input: GgufContextPlanInput): ContextPlan | undefined {
  const { meta, config } = input
  if (!meta) return undefined
  const trainedCtx = ggufContextLength(meta)
  const kvBytesAt = ggufKvBytesAt(meta, config)
  const kvBytesPerToken =
    trainedCtx === undefined ? undefined : marginalKvBytesPerToken(kvBytesAt, trainedCtx)
  return planContextWindow({
    device: input.device,
    weightsBytes: input.weightsBytes,
    trainedCtx,
    kvBytesAt,
    ...(kvBytesPerToken !== undefined ? { kvBytesPerToken } : {}),
    ...(input.floorCtx !== undefined ? { floorCtx: input.floorCtx } : {}),
    ...(input.offloadShare !== undefined ? { offloadShare: input.offloadShare } : {}),
    ...(input.marginBytes !== undefined ? { marginBytes: input.marginBytes } : {}),
  })
}

export interface ContextDeviceFacts {
  /** Apple silicon: the RAM the GPU shares with the system. */
  unifiedMemory?: { totalMemoryBytes: number } | undefined
  /** The GPUs the build about to load lists (`--list-devices`, MiB), or stands in for them. */
  devices?: readonly DeviceInfo[] | undefined
  /** The `device` setting: `''` lets llama.cpp choose, `none` is the CPU, else device ids. */
  deviceSetting?: string
  /** Physical and free system RAM. */
  system?: { totalMemoryBytes: number; freeMemoryBytes?: number } | undefined
}

/**
 * The memory a plan is sized against: unified memory on Apple silicon; else the listed GPU with the
 * most free memory (of those the `device` setting names) — on a machine with several cards that is
 * the safe side, since under fit the plan is only the floor llama.cpp keeps; else system RAM.
 * `undefined` when nothing is known.
 */
export function contextPlanDevice(facts: ContextDeviceFacts): ContextPlanDevice | undefined {
  const names = String(facts.deviceSetting ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
  const system = facts.system
  const cpu = (): ContextPlanDevice | undefined =>
    system && system.totalMemoryBytes > 0
      ? {
          kind: 'cpu',
          totalMemoryBytes: system.totalMemoryBytes,
          ...(system.freeMemoryBytes !== undefined ? { freeSystemBytes: system.freeMemoryBytes } : {}),
        }
      : undefined
  if (names.includes('none')) return cpu()
  if (facts.unifiedMemory && facts.unifiedMemory.totalMemoryBytes > 0)
    return { kind: 'unified', totalMemoryBytes: facts.unifiedMemory.totalMemoryBytes }
  const gpus = (facts.devices ?? []).filter(
    (device) => device.free > 0 && (names.length === 0 || names.includes(device.id.toLowerCase()))
  )
  if (gpus.length > 0) {
    const freeMiB = Math.max(...gpus.map((device) => device.free))
    return {
      kind: 'gpu',
      freeVramBytes: freeMiB * MiB,
      ...(system?.freeMemoryBytes !== undefined ? { freeSystemBytes: system.freeMemoryBytes } : {}),
    }
  }
  return cpu()
}

/**
 * The hardware probe's discrete GPUs as `--list-devices` would list them, for a plan made before any
 * build is chosen (model capabilities): their whole memory stands in for the free memory, which only
 * a build's own listing knows. Integrated GPUs and shared memory are left out: they are system RAM.
 */
export function probedContextDevices(gpus: readonly GpuProbeInfo[]): DeviceInfo[] {
  return gpus
    .filter((gpu) => !isIntegratedGpu(gpu) && !hasSharedGpuMemory(gpu))
    .map((gpu, index) => ({
      id: `GPU${index}`,
      name: gpu.name ?? `GPU ${index}`,
      mem: Math.max(0, gpu.total_memory ?? 0),
      free: Math.max(0, gpu.total_memory ?? 0),
    }))
    .filter((device) => device.free > 0)
}

/**
 * The floor of a fit-off load's plan: the window it got before — DEFAULT_CTX_LEN, or the trained
 * window when smaller; on a unified-memory Mac below 16 GiB the previous 16K default
 * (`smallMemoryDefaultCtx`), which the plan then widens up to the 32K ceiling as memory allows.
 */
export function previousDefaultCtx(trainedCtx: number | undefined, device: ContextPlanDevice): number {
  const capped =
    trainedCtx !== undefined && trainedCtx > 0 ? Math.min(trainedCtx, DEFAULT_CTX_LEN) : DEFAULT_CTX_LEN
  return device.kind === 'unified' && device.totalMemoryBytes < SMALL_UNIFIED_MEMORY_BYTES
    ? Math.min(PREVIOUS_DEFAULT_CTX, capped)
    : capped
}

/** `fit_ctx` holds no window of the user's own: empty, 0, or llama.cpp's 4096 default (the schema's). */
export function isDefaultFitCtx(value: unknown): boolean {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim()
  return text === '' || text === '0' || text === String(DEFAULT_FIT_CTX)
}

/** The llama.cpp settings a capabilities plan reads, as the provider stores them. */
export type ContextPlanSettings = ContextPlanConfig &
  Pick<LlamacppConfig, 'fit' | 'fit_ctx' | 'fit_target' | 'device'>

export interface GgufContextPlannerDeps {
  /** The provider's settings, as a load reads them (defaults included). */
  settings: () => Promise<ContextPlanSettings>
  unifiedMemory: () => Promise<{ totalMemoryBytes: number } | undefined>
  systemMemory: () => Promise<{ totalMemoryBytes: number; freeMemoryBytes?: number } | undefined>
  /** The hardware probe's GPUs. */
  gpus: () => Promise<readonly GpuProbeInfo[]>
}

/**
 * The plan of a GGUF that is not loaded (`GET /models/:provider/*modelId/capabilities`): the same
 * rule a load applies, on the hardware probe's facts instead of a build's `--list-devices` — so on a
 * discrete GPU the card's whole memory stands in for its free memory. Fit on sizes against fit's
 * floor and lets the window move layers off a GPU; fit off keeps every layer on it and never goes
 * below the previous default. A probe that fails gives no plan.
 */
export async function planUnloadedGgufContext(
  model: { metadata: Record<string, string>; weightsBytes: number },
  deps: GgufContextPlannerDeps
): Promise<ContextPlan | undefined> {
  try {
    const [cfg, unifiedMemory, system, gpus] = await Promise.all([
      deps.settings(),
      deps.unifiedMemory(),
      deps.systemMemory(),
      deps.gpus(),
    ])
    const device = contextPlanDevice({
      unifiedMemory,
      devices: probedContextDevices(gpus),
      deviceSetting: cfg.device,
      system,
    })
    if (!device) return undefined
    const trained = ggufContextLength(model.metadata)
    const fitCtx = parseInt(String(cfg.fit_ctx ?? '').trim(), 10)
    const fitFloor = isDefaultFitCtx(cfg.fit_ctx) || !(fitCtx > 0) ? DEFAULT_FIT_CTX : fitCtx
    const fitTarget = parseInt(String(cfg.fit_target ?? '').trim(), 10)
    return planGgufContextWindow({
      meta: model.metadata,
      weightsBytes: model.weightsBytes,
      config: cfg,
      device,
      floorCtx: cfg.fit ? fitFloor : previousDefaultCtx(trained, device),
      offloadShare: cfg.fit ? GPU_OFFLOAD_WEIGHT_SHARE : 0,
      ...(cfg.fit && fitTarget > 0 ? { marginBytes: fitTarget * MiB } : {}),
    })
  } catch {
    return undefined
  }
}

const LLAMACPP_PROVIDERS: ReadonlySet<string> = new Set(['llamacpp-upstream', 'llamacpp', 'atomic-prism'])

export interface GgufContextPlannerFactoryDeps extends Omit<GgufContextPlannerDeps, 'settings'> {
  /** A provider's stored settings, defaults included. */
  settings: (provider: LocalProviderId) => Record<string, unknown>
}

/**
 * The capabilities service's planner (`CapabilitiesDeps.planContext`): {@link planUnloadedGgufContext}
 * with the provider's settings for the llama.cpp providers, no plan for any other.
 */
export function ggufContextPlanner(
  deps: GgufContextPlannerFactoryDeps
): (
  provider: LocalProviderId,
  model: { metadata: Record<string, string>; weightsBytes: number }
) => Promise<ContextPlan | undefined> {
  return async (provider, model) => {
    if (!LLAMACPP_PROVIDERS.has(provider)) return undefined
    return planUnloadedGgufContext(model, {
      settings: async () => withLlamacppDefaults(deps.settings(provider) as unknown as LlamacppConfigInput),
      unifiedMemory: deps.unifiedMemory,
      systemMemory: deps.systemMemory,
      gpus: deps.gpus,
    })
  }
}
