/**
 * Backend advisor contracts: the shapes `backend/` shares with the app (moved here from
 * `backend/types.ts` so `client/` can import them without pulling `node:fs`), and the wire envelopes
 * of the three advisor routes (`POST /backends/:provider/{catalog,recommendation,updates}`, see the
 * 2026-09-27 ADR "the core advises on backends, the app decides").
 *
 * Envelopes are snake_case like every other control-API body. The optimal record itself stays
 * camelCase: the app persists it verbatim under its `localStorage` key and an older app must still
 * read what a newer core wrote.
 *
 * Browser-safe: types only.
 */

/** The two llama.cpp providers the advisor answers for. */
export type LlamacppProviderId = 'llamacpp-upstream' | 'llamacpp'

/**
 * One backend build. Rust `BackendInfo { version, backend, #[serde(default)] order: u32 }`: `order`
 * is the directory mtime in seconds for a build found on disk and 0 (or absent) for a manifest entry.
 */
export interface BackendVersion {
  version: string
  backend: string
  order?: number
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

/** Rust `UpdateCheckResult`; `target_backend` serialises as `null` when no update is offered. */
export interface UpdateCheckResult {
  update_needed: boolean
  new_version: string
  target_backend: string | null
}

/**
 * Outcome of `detectIdealBackendType` (ATO-161): a better GPU backend exists, CPU genuinely is the
 * best this hardware can do, or detection could not complete and the current backend must stay.
 */
export type IdealBackendResult =
  { kind: 'gpu'; backend: string } | { kind: 'cpu-optimal' } | { kind: 'detection-failed' }

export interface OptimalBackendCacheBase {
  schemaVersion: 1
  provider: LlamacppProviderId
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

/**
 * The app's proxy policy for one network operation (Rust `ProxyConfig` of `download_files`). Sent
 * in request bodies, never persisted by the core and never echoed back. `downloads/` re-exports it;
 * `validateProxyConfig` there holds the rules.
 */
export interface ProxyConfig {
  url: string
  username?: string | null
  password?: string | null
  no_proxy?: string[] | null
  ignore_ssl?: boolean | null
}

// ---------------------------------------------------------------------------------------------
// POST /atomic/v1/backends/:provider/catalog
// ---------------------------------------------------------------------------------------------

export interface BackendCatalogRequest {
  /** Drop the session cache (upstream manifest / fork release index) before answering. */
  force?: boolean
  /** The app's version, for the fork's `min_app_version` gate; `null` or absent = any. */
  app_version?: string | null
  /** The provider's `version_backend`; only the macOS static variants depend on it. */
  current_backend?: string
  proxy?: ProxyConfig | null
}

/** One release of the TurboQuant fork, for the dropdown's release notes (fork only). */
export interface BackendCatalogRelease {
  tag: string
  title?: string
  highlights?: string[]
  min_app_version?: string
  variants: Array<{ id: string; asset?: string; size?: number }>
}

/** Where the remote half of the catalog came from. */
export type BackendCatalogSource =
  | 'live'
  | 'session-cache'
  | 'bundled-baseline'
  | 'index'
  | 'redirect'
  | 'legacy-manifest'
  | 'disk-cache'
  | 'none'

export interface BackendCatalogResponse {
  provider: LlamacppProviderId
  os_type: string
  arch_suffix: 'x64' | 'arm64'
  /** `probe` or `override`: which hardware description gated the catalog. */
  hardware_source: string
  features: SupportedFeatures
  /** Backend ids this host can run (`determine_supported_backends`). */
  supported_backends: string[]
  /** The remote catalog for this OS + arch, before the hardware gate. */
  remote: BackendVersion[]
  /** Every pack on disk, `order` = install mtime. */
  installed: BackendVersion[]
  /** Remote + installed, hardware-gated, merged and sorted newest first. */
  available: BackendVersion[]
  /** `determineBestBackend(available)`, `null` for an empty catalog. */
  recommended: string | null
  /** The best *installed* build among `available` — the app's disk-recovery pick. */
  recommended_installed: string | null
  /** Newest `<tag>/<id>` per normalised backend type present in `available`. */
  latest_by_type: Record<string, string>
  /** Ids behind the static "Latest <variant>" dropdown entries (upstream only; fork `[]`). */
  static_variants: string[]
  source: BackendCatalogSource
  /** Fork only: the stable releases with their notes. */
  releases?: BackendCatalogRelease[]
}

// ---------------------------------------------------------------------------------------------
// POST /atomic/v1/backends/:provider/recommendation
// ---------------------------------------------------------------------------------------------

export type BackendRecommendationMode = 'refresh' | 'recheck'

export interface BackendRecommendationRequest {
  /** `refresh`: the silent startup pass. `recheck`: the user asked; forces a catalog refresh and emits. */
  mode: BackendRecommendationMode
  current_backend?: string
  app_version?: string | null
  proxy?: ProxyConfig | null
  /** Defaults to `mode === 'recheck'`. */
  force?: boolean
  /** The host already knows it has no GPU: skip detection and record `cpu-optimal`. */
  assume_no_gpu?: boolean
}

/**
 * Why the recommendation did or did not surface. `detection_failed` is an ordinary outcome, not an
 * error: the store is left untouched and the app keeps its current backend.
 */
export type BackendRecommendationOutcome =
  'mac' | 'detection_failed' | 'cpu_optimal' | 'already_optimal' | 'no_catalog_entry' | 'recommend'

export interface BackendRecommendationResponse {
  provider: LlamacppProviderId
  mode: BackendRecommendationMode
  outcome: BackendRecommendationOutcome
  /** What detection concluded; `null` on macOS. */
  detection: IdealBackendResult | null
  /** The record this pass built; `null` when nothing was built (macOS, detection failed). */
  record: OptimalBackendCacheRecord | null
  /** The store after this pass: its revision and what it holds now. */
  revision: number
  optimal: OptimalBackendCacheRecord | null
  /** Non-null only for `outcome: 'recommend'`. */
  recommendation: BackendRecommendation | null
  elapsed_ms: number
}

// ---------------------------------------------------------------------------------------------
// POST /atomic/v1/backends/:provider/updates
// ---------------------------------------------------------------------------------------------

export interface BackendUpdateCheckRequest {
  /** The provider's `version_backend`; defaults to what the core's settings hold. */
  current?: string
  force?: boolean
  app_version?: string | null
  proxy?: ProxyConfig | null
}

/** What `current` looked like: a `<tag>/<id>`, a parked `latest/<id>` sentinel, or nothing usable. */
export type BackendCurrentKind = 'concrete' | 'sentinel' | 'missing'

export interface BackendUpdateCheckResponse extends UpdateCheckResult {
  provider: LlamacppProviderId
  current: string
  current_kind: BackendCurrentKind
  /** Whether `target_backend` stays in the current backend's family (a tag bump never switches types). */
  same_family: boolean
  /** The target the app may offer: `target_backend` when an update is needed and the family holds. */
  offer: string | null
}
