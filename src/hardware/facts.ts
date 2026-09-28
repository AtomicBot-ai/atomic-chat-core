/**
 * The slice of the hardware description the backend selectors and the CPU preflight read, and the
 * precedence rule between the core's probe and an injected override.
 *
 * Pure: no `node:*` I/O. `HardwareService` produces `HardwareFacts`; `backend/` consumes them through
 * `HardwareFactsSource` so that module never depends on how the facts were measured.
 */

import type {
  GpuInfo,
  GpuProbeInfo,
  HardwareOverride,
  HardwareSource,
  OsType,
  SystemInfo,
} from '../contracts/index.js'

export interface HardwareFacts {
  /** `windows` | `linux` | `macos` | `unknown`. */
  osType: string
  /** Rust spelling: `x86_64`, `arm64` / `aarch64`, `x86`. */
  arch: string
  /**
   * CPU flags in the plugin's lowercase spelling, or `undefined` when the probe could not read them.
   * The no-AVX preflight fires only on a positive signal, so unknown must never read as "none".
   */
  cpuExtensions: string[] | undefined
  gpus: GpuProbeInfo[]
  source: HardwareSource
}

/** What the backend module asks for: the current facts, whatever measured them. */
export interface HardwareFactsSource {
  facts(): Promise<HardwareFacts>
}

/** Node's platform name in the spelling the selection policies and the app use. */
export function osTypeOf(platform: NodeJS.Platform | string): OsType {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  return 'unknown'
}

/** Node's `process.arch` in the Rust spelling the backend and CPU policies expect (`x64` → `x86_64`). */
export function rustArch(arch: string): string {
  if (arch === 'x64') return 'x86_64'
  if (arch === 'ia32') return 'x86'
  return arch
}

/**
 * Combine the probe with an override. The override replaces the probe wholesale for the GPUs and, when
 * it carries them, the CPU flags and the OS type — never merged (a half-probed, half-injected list
 * would be a third description of the machine matching neither side, see `override.ts`).
 */
export function factsOf(
  info: SystemInfo,
  arch: string,
  override: HardwareOverride | undefined
): HardwareFacts {
  if (!override) {
    return {
      osType: info.os_type,
      arch,
      cpuExtensions: info.cpu.extensions_known ? [...info.cpu.extensions] : undefined,
      gpus: info.gpus.map((gpu) => ({ ...gpu })),
      source: 'probe',
    }
  }
  return {
    osType: override.os_type ?? info.os_type,
    arch,
    cpuExtensions: override.cpu_extensions
      ? [...override.cpu_extensions]
      : info.cpu.extensions_known
        ? [...info.cpu.extensions]
        : undefined,
    gpus: override.gpus.map((gpu) => ({ ...gpu })),
    source: 'override',
  }
}

/**
 * Render an injected `GpuProbeInfo` as a full `GpuInfo`, so `GET /hardware/info` has one shape whether
 * the facts came from the probe or from an override. Missing fields get the plugin's empty values.
 */
export function gpuInfoFromProbe(gpu: GpuProbeInfo, index: number): GpuInfo {
  const extra = gpu as GpuProbeInfo & { name?: unknown; uuid?: unknown }
  return {
    name: typeof extra.name === 'string' ? extra.name : `GPU ${index}`,
    total_memory: typeof gpu.total_memory === 'number' ? gpu.total_memory : 0,
    vendor: typeof gpu.vendor === 'string' ? gpu.vendor : 'Unknown (vendor_id: 0)',
    uuid: typeof extra.uuid === 'string' ? extra.uuid : `override-${index}`,
    driver_version: gpu.driver_version ?? '',
    nvidia_info: gpu.nvidia_info
      ? {
          index: ((gpu.nvidia_info as { index?: unknown }).index as number) ?? index,
          compute_capability: gpu.nvidia_info.compute_capability ?? '',
        }
      : null,
    vulkan_info: gpu.vulkan_info
      ? {
          index: ((gpu.vulkan_info as { index?: unknown }).index as number) ?? index,
          device_type: gpu.vulkan_info.device_type ?? 'Unknown',
          api_version: gpu.vulkan_info.api_version ?? '',
          device_id: typeof gpu.vulkan_info.device_id === 'number' ? gpu.vulkan_info.device_id : 0,
        }
      : null,
  }
}

/** The `SystemInfo` served while an override stands: the probe's CPU/OS/memory, the override's GPUs. */
export function systemInfoWithOverride(info: SystemInfo, override: HardwareOverride): SystemInfo {
  return {
    ...info,
    ...(override.os_type ? { os_type: override.os_type as OsType } : {}),
    cpu: override.cpu_extensions
      ? { ...info.cpu, extensions: [...override.cpu_extensions], extensions_known: true }
      : { ...info.cpu },
    gpus: override.gpus.map((gpu, index) => gpuInfoFromProbe(gpu, index)),
  }
}
