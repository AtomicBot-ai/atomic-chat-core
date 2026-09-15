/**
 * "Will this model fit?" — port of `gguf/commands.rs` (`memory_budget`, `is_model_supported`).
 * Pure over numbers; reading the file size and the hardware facts is the caller's job.
 */

import { saturatingSub } from '../../util/index.js'

export type ModelSupportStatus = 'RED' | 'YELLOW' | 'GREEN'

/**
 * Headroom left to the OS, the app and llama.cpp's own allocations on top of weights + KV cache:
 * ~2.13 GiB per memory pool. Inherited, not measured (see the Rust comment).
 */
export const RESERVE_BYTES = 2_288_490_189

export interface GpuMemory {
  total_bytes: number
  /** Memory carved out of system RAM (an integrated GPU) rather than its own pool. */
  integrated: boolean
}

export interface MemoryBudget {
  /** Fits here → runs entirely on the GPU. */
  usable_vram: number
  /** Fits here → runs at all, spilling to system RAM. */
  usable_total: number
}

/** Vulkan's `IntegratedGpu` is the only trusted signal; anything else counts as discrete. */
export function isIntegratedGpu(gpu: { vulkan_info?: { device_type?: string } | null }): boolean {
  return gpu.vulkan_info?.device_type?.toLowerCase() === 'integratedgpu'
}

/**
 * Integrated graphics shares system RAM, so adding it to RAM would count it twice (the 16 GB
 * laptop that was told a 17 GB model fits). Only discrete GPUs add memory of their own. With no
 * GPU enumerated (Apple Silicon) RAM *is* the VRAM: one pool.
 */
export function memoryBudget(totalRamBytes: number, gpus: GpuMemory[]): MemoryBudget {
  if (gpus.length === 0) {
    const usable = saturatingSub(totalRamBytes, RESERVE_BYTES)
    return { usable_vram: usable, usable_total: usable }
  }
  const totalVram = gpus.reduce((n, g) => n + g.total_bytes, 0)
  const discreteVram = gpus.filter((g) => !g.integrated).reduce((n, g) => n + g.total_bytes, 0)
  return {
    usable_vram: saturatingSub(totalVram, RESERVE_BYTES),
    usable_total: saturatingSub(totalRamBytes, RESERVE_BYTES) + saturatingSub(discreteVram, RESERVE_BYTES),
  }
}

/** RED = cannot run at all; GREEN = fits in VRAM; YELLOW = runs with CPU/GPU spill. */
export function modelSupportStatus(requiredBytes: number, budget: MemoryBudget): ModelSupportStatus {
  if (requiredBytes > budget.usable_total) return 'RED'
  if (requiredBytes <= budget.usable_vram) return 'GREEN'
  return 'YELLOW'
}

export interface SystemMemoryFacts {
  /** MiB, as the hardware probe reports it. */
  total_memory: number
  gpus: Array<{ total_memory: number; vulkan_info?: { device_type?: string } | null }>
}

/** `is_model_supported` after the file size and KV estimate are known. */
export function isModelSupported(
  modelSizeBytes: number,
  kvCacheBytes: number,
  system: SystemMemoryFacts
): ModelSupportStatus {
  const gpus = system.gpus.map((g) => ({
    total_bytes: g.total_memory * 1024 * 1024,
    integrated: isIntegratedGpu(g),
  }))
  return modelSupportStatus(
    modelSizeBytes + kvCacheBytes,
    memoryBudget(system.total_memory * 1024 * 1024, gpus)
  )
}
