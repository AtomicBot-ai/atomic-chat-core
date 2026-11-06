/** Dedicated and measured shared GPU capacity, in MiB; shared RAM is never additive. */
import type { GpuProbeInfo } from '../contracts/index.js'

export function hasSharedGpuMemory(gpu: GpuProbeInfo): boolean {
  return gpu.vendor === 'AMD' && Number.isFinite(gpu.shared_memory) && (gpu.shared_memory ?? 0) > 0
}

/** Capacity only, not a free-memory promise. The native engine still validates actual allocations. */
export function gpuMemoryMiB(gpu: GpuProbeInfo): number {
  const dedicated = Number.isFinite(gpu.total_memory) ? Math.max(0, gpu.total_memory ?? 0) : 0
  return Math.max(dedicated, hasSharedGpuMemory(gpu) ? gpu.shared_memory! : 0)
}
