/**
 * Hardware facts the core knows about the machine it runs on (PLAN.md §2 decision 10, revised by the
 * 2026-09-27 ADR "the core probes hardware with shell tools").
 *
 * The core measures the machine itself, with the tools every host already has: `nvidia-smi` for NVIDIA
 * driver version and compute capability, sysfs / PowerShell CIM + registry for the other PCI GPUs and
 * their VRAM, `/proc/cpuinfo` / `sysctl` / `IsProcessorFeaturePresent` for the CPU flags, the Vulkan
 * loader's ICD registrations (and `vulkaninfo` when installed) for Vulkan. No NVML, no native addon.
 *
 * `PUT /hardware/override` remains as a seam: an injected description replaces the probe wholesale for
 * as long as it stands (tests, headless hosts with better numbers). The desktop app no longer injects.
 *
 * Browser-safe: types only, shared with every host and client.
 */

/**
 * The slice of the hardware probe's `GpuInfo` the backend selectors read. `hardware/` must produce
 * at least these fields (its full `GpuInfo` is a superset). Rust `backend.rs::GpuInfo` requires only
 * `driver_version`; everything else is `#[serde(default)]`.
 */
export interface GpuProbeInfo {
  driver_version?: string
  /** `"NVIDIA" | "AMD" | "Intel" | "Unknown (vendor_id: N)"` as `tauri-plugin-hardware` spells it. */
  vendor?: string | null
  /** MiB. */
  total_memory?: number
  nvidia_info?: {
    /** NVML `"major.minor"`, e.g. `"7.5"`; empty when NVML did not report it. */
    compute_capability?: string
  } | null
  vulkan_info?: {
    api_version?: string
    /** PCI device id — the only gfx signal on Windows. */
    device_id?: number | null
    /** `"DiscreteGpu" | "IntegratedGpu" | …` */
    device_type?: string
  } | null
}

/** The override in force, as the snapshot reports it. */
export interface HardwareOverride {
  /** What the host's enumeration found. Replaces the core's probe wholesale. */
  gpus: GpuProbeInfo[]
  /** CPU instruction-set flags (`avx`, `avx2`, `avx512`), lowercase as the feature check expects. */
  cpu_extensions?: string[]
  /** `linux` | `windows` | `macos` — the host's own idea of the OS, for cross-checking. */
  os_type?: string
  /** Who injected it, for the log and for the snapshot. */
  source?: string
  /** Milliseconds since the epoch, from the core's clock. */
  received_at: number
}

/** The body of `PUT /hardware/override`, validated by the core before it is applied. */
export interface HardwareOverrideInput {
  gpus?: unknown
  cpu_extensions?: unknown
  os_type?: unknown
  source?: unknown
}

// ---------------------------------------------------------------------------------------------
// The full description the core serves (`GET /hardware/info`). Same shape as the app's
// `tauri-plugin-hardware` `SystemInfo`, plus two fields the plugin never emitted (`extensions_known`,
// `device_type: 'Unknown'`), see docs/contracts.md.
// ---------------------------------------------------------------------------------------------

/** `os_type` as the probe reports it; `unknown` for a platform the core has no probe for. */
export type OsType = 'windows' | 'linux' | 'macos' | 'unknown'

export interface CpuInfo {
  name: string
  /** Physical cores; falls back to the logical count when the OS does not say. */
  core_count: number
  /** Rust spelling: `x86_64`, `aarch64` / `arm64`, `x86`. */
  arch: string
  /**
   * Instruction-set flags in the plugin's spelling (`avx`, `avx2`, `avx512_f`, `sse4_1`, …), lowercase.
   * Empty on non-x86 hosts.
   */
  extensions: string[]
  /**
   * `false` when the probe could not read the flags (no PowerShell, an unreadable `/proc/cpuinfo`);
   * `extensions` is then `[]` and the no-AVX preflight stays silent rather than blocking on ignorance.
   */
  extensions_known: boolean
}

export interface NvidiaGpuInfo {
  index: number
  /** NVML / `nvidia-smi` `"major.minor"`; `''` when the tool could not report it (treated as unknown). */
  compute_capability: string
}

export interface VulkanGpuInfo {
  index: number
  /**
   * `"DiscreteGpu" | "IntegratedGpu" | "VirtualGpu" | "Other"` when a Vulkan enumeration said so;
   * `"Unknown"` when only the loader/ICD registration is known and the vendor gives no hint.
   */
  device_type: string
  /** `"x.y.z"`; `''` when not enumerated. */
  api_version: string
  /** PCI device id — the only gfx signal on Windows. */
  device_id: number
}

export interface GpuInfo {
  name: string
  /** MiB. */
  total_memory: number
  /** `"NVIDIA" | "AMD" | "Intel" | "Unknown (vendor_id: N)"`. */
  vendor: string
  /** NVIDIA: the NVML uuid without `GPU-`; others: an opaque stable id (PCI bus id / PNP instance). */
  uuid: string
  /** NVIDIA: the system driver (`"581.42"`); others: the OS driver string or `''`. */
  driver_version: string
  nvidia_info: NvidiaGpuInfo | null
  vulkan_info: VulkanGpuInfo | null
}

export interface SystemInfo {
  cpu: CpuInfo
  os_type: OsType
  os_name: string
  /** MiB. */
  total_memory: number
  gpus: GpuInfo[]
}

/** Where the facts came from: the core's own probe, or an injected override that replaces it. */
export type HardwareSource = 'probe' | 'override'

/** Body of `GET /hardware/info` and `POST /hardware/refresh`. */
export interface HardwareInfoResponse {
  info: SystemInfo
  source: HardwareSource
  /** Milliseconds since the epoch, from the core's clock, of the probe `info` is based on. */
  probed_at: number
  /** What the probe could not read, one line each; empty when everything answered. */
  warnings: string[]
}
