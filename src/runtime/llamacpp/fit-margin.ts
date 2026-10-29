/**
 * How much memory `--fit` leaves to the rest of a unified-memory Mac.
 *
 * With fit on and no `--ctx-size`, llama.cpp starts from the model's trained context and shrinks it
 * only until everything fits the GPU's free memory minus a margin (`--fit-target`, 1024 MiB by
 * default). On Apple silicon that free memory is Metal's `recommendedMaxWorkingSetSize` — about
 * three quarters of RAM on current macOS (18186 MiB of 24 GiB on an M4 Pro) — and it is the same RAM
 * the system and every other app live in. A 3B model with a 256K trained context and dense
 * attention took ~10 GB of an 18 GB Mac for its KV cache, and the machine swapped.
 *
 * The margin is the only lever fit leaves: an explicit `--ctx-size` switches its context fitting off
 * altogether. So on unified memory the core widens the margin until llama.cpp is left with half of
 * RAM, and llama.cpp still picks the window inside that budget with its own, exact accounting. The
 * budget never drops below what the weights and the minimum context need: past that point a wider
 * margin would not shrink the context any further, it would push layers onto the CPU.
 *
 * Below 16 GiB half of RAM is still too much: on an 8 GiB Mac it is 4 GiB for one chat model, and
 * the other 4 GiB must hold macOS, the app, and the embedding and decision servers — each its own
 * process, so invisible to fit, whose free memory is per process. Metal's buffers are wired, so the
 * rest of the system is what pages out. A 2.6B hybrid model filled those 4 GiB with a 128K window
 * and the whole UI stalled for 30 s per action. There the core also caps the window itself
 * (`smallUnifiedMemoryCtxCeiling`), with an explicit `--ctx-size` that leaves fit placing layers.
 */

import type { DeviceInfo } from '../../contracts/index.js'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

/** llama.cpp's own `--fit-target` default; the args builder omits the flag at this value. */
export const DEFAULT_FIT_TARGET_MIB = 1024

/** llama.cpp's own `--fit-ctx` default: the smallest window fit may settle on. */
export const DEFAULT_FIT_CTX = 4096

/** The share of RAM llama.cpp may fill on unified memory when the model itself needs less. */
export const UNIFIED_MEMORY_LLAMA_SHARE = 0.5

/** Headroom for compute buffers beside the weights and the minimum context. */
export const FIT_COMPUTE_RESERVE_BYTES = GiB

export interface UnifiedMemoryFitInput {
  /** Physical RAM, shared by the CPU and the GPU. */
  totalMemoryBytes: number
  /** What fit will measure as free on the GPU: the Metal device's `free` in `--list-devices`. */
  gpuFreeBytes: number
  /** Everything fit places on the GPU as weights: every shard, plus a draft model when there is one. */
  weightsBytes: number
  /** The KV cache at the smallest window fit may choose (`--fit-ctx`, times the slots); 0 when unknown. */
  minContextKvBytes: number
}

/**
 * The Metal device of a `--list-devices` answer, the one fit sizes against on Apple silicon;
 * `undefined` when the build lists none (a CPU-only build, or a probe that printed nothing).
 */
export function metalDevice(devices: readonly DeviceInfo[]): DeviceInfo | undefined {
  return devices.find((device) => /^MTL\d*$/.test(device.id) && device.free > 0)
}

/**
 * The `--fit-target` (MiB) that leaves llama.cpp half of RAM on a unified-memory Mac, or `undefined`
 * when llama.cpp's default margin already leaves at least that much — a model whose weights and
 * minimum context need more than half of RAM loads exactly as it did before.
 */
export function unifiedMemoryFitTargetMiB(input: UnifiedMemoryFitInput): number | undefined {
  if (!(input.totalMemoryBytes > 0) || !(input.gpuFreeBytes > 0)) return undefined
  const modelNeeds =
    Math.max(0, input.weightsBytes) + Math.max(0, input.minContextKvBytes) + FIT_COMPUTE_RESERVE_BYTES
  const budget = Math.max(input.totalMemoryBytes * UNIFIED_MEMORY_LLAMA_SHARE, modelNeeds)
  const marginMiB = Math.floor((input.gpuFreeBytes - budget) / MiB)
  return marginMiB > DEFAULT_FIT_TARGET_MIB ? marginMiB : undefined
}

/** Unified memory below this much RAM gets its fitted window capped (`smallUnifiedMemoryCtxCeiling`). */
export const SMALL_UNIFIED_MEMORY_BYTES = 16 * GiB

/**
 * The widest window fit may pick on such a Mac: room for an agent's ~20K-token prompt (Atomic
 * Agent's, QA 2.2.29 B09), and a step of the app's context ladder. The budget still narrows a dense
 * model below it.
 */
export const SMALL_UNIFIED_MEMORY_CTX_CAP = 32_768

/** A narrowed ceiling is a whole number of these, as the windows fit picks itself are. */
export const FIT_CTX_ALIGN = 256

export interface SmallUnifiedMemoryCtxInput {
  /** Physical RAM, shared by the CPU and the GPU. */
  totalMemoryBytes: number
  /** What fit may fill: the Metal device's free memory less the margin fit is given. */
  budgetBytes: number
  /** Everything fit places on the GPU as weights. */
  weightsBytes: number
  /** The model's trained context; `undefined` when its GGUF does not say. */
  trainedCtx: number | undefined
  /** `--fit-ctx`: the smallest window fit may settle on. */
  minCtx: number
  /** The KV cache at `ctx` tokens per slot, across every slot; `undefined` when it cannot be estimated. */
  kvBytesAt: (ctx: number) => number | undefined
}

/**
 * The window (tokens per slot) the core caps fit at on a unified-memory Mac with less than 16 GiB of
 * RAM, or `undefined` to leave the window to llama.cpp: 32768 tokens, narrowed in steps of 256
 * tokens until the weights, the KV cache and the compute reserve fit the same budget the margin
 * leaves llama.cpp. The KV estimate counts the attention layers a per-layer `head_count_kv` names,
 * but averages a sliding window and counts every block of a hybrid that marks its attention layers
 * some other way, so those are narrowed more than they need to be — the safe side, because under an
 * explicit window llama.cpp fits layers, not the context. Nothing is capped when the KV cache cannot
 * be estimated, when the model was trained for no wider a window than the ceiling and it fits, or
 * when not even the fit floor fits the budget: fit then shrinks to the floor and moves layers,
 * exactly as before.
 */
export function smallUnifiedMemoryCtxCeiling(input: SmallUnifiedMemoryCtxInput): number | undefined {
  if (!(input.totalMemoryBytes > 0) || input.totalMemoryBytes >= SMALL_UNIFIED_MEMORY_BYTES) return undefined
  const trained = input.trainedCtx
  if (trained === undefined || !(trained > 0)) return undefined
  const room = input.budgetBytes - Math.max(0, input.weightsBytes) - FIT_COMPUTE_RESERVE_BYTES
  if (!(room > 0)) return undefined
  const floor = Math.max(1, input.minCtx)
  let ctx = Math.min(SMALL_UNIFIED_MEMORY_CTX_CAP, trained)
  while (ctx >= floor) {
    const kv = input.kvBytesAt(ctx)
    if (kv === undefined) return undefined
    if (kv <= room) return ctx < trained ? ctx : undefined
    ctx -= ctx % FIT_CTX_ALIGN === 0 ? FIT_CTX_ALIGN : ctx % FIT_CTX_ALIGN
  }
  return undefined
}
