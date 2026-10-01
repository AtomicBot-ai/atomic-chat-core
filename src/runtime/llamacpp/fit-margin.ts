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
