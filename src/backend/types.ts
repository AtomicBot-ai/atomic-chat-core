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

import type { BackendVersion, DeviceInfo } from '../contracts/index.js'

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

/** Lives in `contracts/hardware.ts` now (every host injects it); re-exported so nothing here moves. */
export type { GpuProbeInfo } from '../contracts/index.js'

/**
 * Live in `contracts/backend-advisor.ts` now (the advisor routes carry them to the app, and `client/`
 * must import them without `node:*`); re-exported so nothing here moves.
 */
export type {
  BackendFeatures,
  BackendRecommendation,
  BackendVersion,
  IdealBackendResult,
  OptimalBackendCacheBase,
  OptimalBackendCacheRecord,
  SupportedFeatures,
  UpdateCheckResult,
} from '../contracts/index.js'

/** Rust `BestBackendResult`. */
export interface BestBackendResult {
  backend_string: string
  version: string
  backend_type: string
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

/** What a tier probe needs from its caller: the installed builds and a way to run `--list-devices`. */
export interface TierProbeDeps {
  listInstalled: () => Promise<BackendVersion[]>
  /** Spawn `<exe> --list-devices` for this installed build and parse it. */
  listDevices: (installed: BackendVersion) => Promise<DeviceInfo[]>
}
