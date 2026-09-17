/**
 * Shapes shared between the backend module and the app.
 *
 * Ported from: `tauri-plugin-llamacpp-upstream/guest-js/types.ts` (`BackendVersion`, `BackendFeatures`),
 * `tauri-plugin-llamacpp-upstream/src/backend.rs` (`BackendInfo`, `SystemFeatures`, `SupportedFeatures`,
 * `GpuInfo`, the `*Result` structs) and `extensions/llamacpp-upstream-extension/src/{backend,index}.ts`
 * (manifest, installed packs, dropdown options, the optimal-backend cache record).
 *
 * Field names are snake_case where the app serialises them (Rust structs, the cache record) so a
 * value produced here can be handed to the app unchanged.
 */

import type { DeviceInfo } from '../contracts/index.js'

/**
 * One backend build. Rust `BackendInfo { version, backend, #[serde(default)] order: u32 }`: `order`
 * is the directory mtime in seconds for a build found on disk and 0 (or absent) for a manifest entry.
 */
export interface BackendVersion {
  version: string
  backend: string
  order?: number
}

/** `os_type` as the hardware probe reports it (`tauri-plugin-hardware`). */
export type BackendOsType = 'windows' | 'linux' | 'macos'

/** Architecture suffix used in backend ids (`win-cpu-x64`, `macos-arm64`). */
export type ArchSuffix = 'x64' | 'arm64'

/** One entry of the `version_backend` dropdown. */
export interface BackendOption {
  value: string
  name: string
}

/** A build sitting in `<data>/<provider>/backends/<version>/<backend>`, for the packs dialog. */
export interface InstalledBackendPack {
  version: string
  backend: string
  path: string
  active: boolean
}

export interface UpstreamManifestAsset {
  name: string
  /** Present only on assets the atomic-chat-conf mirror actually hosts. */
  sha256?: string
  size?: number
}

/** `atomic-chat-conf/backends/manifest.json`: a GitHub-release shape (`tag_name`, `assets[].name`). */
export interface UpstreamManifest {
  tag_name: string
  /** Absent for tags that were never mirrored; downloads then fall back to the ggml-org CDN. */
  download_base?: string
  assets: UpstreamManifestAsset[]
}

/** Where a backend archive is fetched from, and what it must hash to. */
export interface BackendArchiveSource {
  url: string
  sha256?: string
  size?: number
}

/**
 * Rust `SystemFeatures` (input of `determine_supported_backends`) and the guest-js
 * `BackendFeatures`. `cuda11` is accepted for wire compatibility but never expands into a backend.
 */
export interface BackendFeatures {
  cuda11: boolean
  cuda12: boolean
  cuda13: boolean
  vulkan: boolean
  rocm: boolean
}

/** Rust `SupportedFeatures` (output of `get_supported_features`). */
export interface SupportedFeatures extends BackendFeatures {
  avx: boolean
  avx2: boolean
  avx512: boolean
}

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

/** Rust `BestBackendResult`. */
export interface BestBackendResult {
  backend_string: string
  version: string
  backend_type: string
}

/** Rust `UpdateCheckResult`; `target_backend` serialises as `null` when no update is offered. */
export interface UpdateCheckResult {
  update_needed: boolean
  new_version: string
  target_backend: string | null
}

/** Rust `SettingUpdateResult`. */
export interface SettingUpdateResult {
  backend_type_updated: boolean
  effective_backend_type: string | null
  needs_backend_installation: boolean
  version: string | null
  backend: string | null
}

/** Verdict of the `--list-devices` health probe for one GPU tier (`tierEnumeratesDevices`). */
export type TierHealth = 'works' | 'unverified' | 'broken'

/**
 * Outcome of `detectIdealBackendType` (ATO-161): a better GPU backend exists, CPU genuinely is the
 * best this hardware can do, or detection could not complete and the current backend must stay.
 */
export type IdealBackendResult =
  { kind: 'gpu'; backend: string } | { kind: 'cpu-optimal' } | { kind: 'detection-failed' }

interface OptimalBackendCacheBase {
  schemaVersion: 1
  provider: 'llamacpp-upstream' | 'llamacpp'
  detectedAt: number
  currentBackend: string
  recommendedCategory: string
}

/** Persisted under `OPTIMAL_BACKEND_CACHE_KEY` (app: `localStorage`; core: `<data>/atomic-core/`). */
export type OptimalBackendCacheRecord =
  | (OptimalBackendCacheBase & {
      detectionKind: 'gpu'
      idealBackendId: string
      recommendedBackend?: string
    })
  | (OptimalBackendCacheBase & { detectionKind: 'cpu-optimal' })

/** Payload of `AppEvent.onBetterBackendDetected` and of `llama_cpp_better_backend_recommendation`. */
export interface BackendRecommendation {
  currentBackend: string
  recommendedBackend: string
  recommendedCategory: string
  provider: string
  version: string
  backendId: string
}

/** What a tier probe needs from its caller: the installed builds and a way to run `--list-devices`. */
export interface TierProbeDeps {
  listInstalled: () => Promise<BackendVersion[]>
  /** Spawn `<exe> --list-devices` for this installed build and parse it. */
  listDevices: (installed: BackendVersion) => Promise<DeviceInfo[]>
}
