/**
 * Hardware facts a host injects into the core (`PUT /hardware/override`, PLAN.md §2 decision 10).
 *
 * The core probes hardware with shell tools, which is not enough for an NVIDIA driver's exact
 * version or a GPU's compute capability — the numbers the CUDA tier is chosen from. The desktop app
 * measures them with NVML/Vulkan; a headless host measures them with `nvidia-smi` and friends. Both
 * hand the core the same shape, and the core prefers it over its own probe.
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
