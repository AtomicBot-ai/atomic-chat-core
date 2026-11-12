export declare const ANY_CORE_VERSION: string
export declare const UPSTREAM_RELEASES_SCHEMA_VERSION: number

export interface PinPlatform {
  /** `linux-x64`, `windows-arm64`, … */
  platform: string
  os: 'linux' | 'macos' | 'windows'
  arch: 'x64' | 'arm64'
  /** The CPU backend id core installs there. */
  backend: string
}

export declare const PIN_PLATFORMS: readonly PinPlatform[]

export interface PinReleaseAsset {
  name: string
  sha256?: string
  size?: number
  validation: 'candidate' | 'approved'
}

export interface PinRelease {
  tag: string
  min_core_version: string
  withdrawn?: { reason: string }
  assets: PinReleaseAsset[]
}

export interface PinCatalog {
  schema_version: 1
  download_base?: string
  releases: PinRelease[]
}

export interface PinBackendVersion {
  version: string
  backend: string
  order: number
}

export declare function upstreamTagBuild(tag: string): number | null
export declare function compareVersions(v1: string, v2: string): -1 | 0 | 1
export declare function parseUpstreamReleases(value: unknown): PinCatalog | null
export declare function upstreamCatalogFromLegacyManifest(value: unknown): PinCatalog | null
export declare function parseManifestForPlatform(
  release: { tag_name: string; assets?: ReadonlyArray<{ name: string }> },
  osType: string,
  archSuffix: string
): PinBackendVersion[]
export declare function upstreamReleaseOffered(release: PinRelease, options: { coreVersion: string }): boolean
export declare function upstreamRemoteBackends(
  catalog: PinCatalog,
  options: { coreVersion: string; allowCandidates: boolean },
  osType: string,
  archSuffix: string
): PinBackendVersion[]

export interface Pins {
  /**
   * Which conf file decided: the release list when this core reads it, else the legacy manifest;
   * the PrismML manifest for `atomic-prism`, conf's sd.cpp, audio.cpp and MLX manifests for theirs.
   */
  source:
    'list' | 'legacy' | 'prism-manifest' | 'sdcpp-manifest' | 'audiocpp-manifest' | 'mlx-manifest' | 'none'
  core_version: string
  per_platform: Record<string, { backend: string; tag: string | null }>
  list: { readable: boolean; per_platform: Record<string, string | null> | null }
  legacy: { tag: string | null }
}

export declare function resolvePins(input: {
  releases: unknown
  manifest: unknown
  coreVersion: string
}): Pins

export declare const PRISM_MANIFEST_SCHEMA_VERSION: number
export declare const PRISM_PIN_PLATFORMS: readonly PinPlatform[]
export declare function prismTagBuild(tag: string): number | null
export declare function engineTagBuild(tag: string): number | null

export interface PrismPinAsset {
  backend: string
  name: string
  size: number
  sha256: string
  validation: 'candidate' | 'approved'
  companion?: true
  companion_backend?: string
}

export interface PrismPinRelease {
  tag: string
  commit: string
  min_core_version: string
  withdrawn?: { reason: string }
  assets: PrismPinAsset[]
}

export interface PrismPinManifest {
  schema_version: 1
  releases: PrismPinRelease[]
}

export declare function parsePrismManifest(value: unknown): PrismPinManifest | null
export declare function prismCatalogToBackends(
  manifest: PrismPinManifest,
  options: { coreVersion: string; allowCandidates: boolean }
): Array<{ version: string; backend: string }>
export declare function resolvePrismPins(input: { manifest: unknown; coreVersion: string }): Pins

export declare const SDCPP_PIN_PLATFORMS: readonly PinPlatform[]

export interface SdcppTagParts {
  build: number
  /** The upstream commit the tag names. */
  sha7: string
  /** `master-<build>-<sha7>`: the tag without the fork's `-a<rev>`. */
  upstream_tag: string
  /** The Atomic fork's rev of a conf mirror tag; `null` on a bare upstream tag. */
  atomic_rev: string | null
}

export declare function sdcppTagParts(tag: string): SdcppTagParts | null
export declare function sdcppTagBuild(tag: string): number | null

export interface SdcppPinManifest {
  updated_at?: string
  tag_name: string
  upstream_repo?: string
  download_base?: string
  assets: Array<{ backend: string; name: string; sha256?: string; size?: number; companion?: true }>
}

export declare function parseSdcppPinManifest(value: unknown): SdcppPinManifest | null
export declare function resolveSdcppPins(input: { manifest: unknown; coreVersion: string }): Pins

export declare const AUDIOCPP_PIN_PLATFORMS: readonly PinPlatform[]

export interface AudiocppTagParts {
  /** `X.Y.Z`: what `audiocpp_server --version` prints. */
  version: string
  /** `vX.Y.Z`: the tag without the fork's `-a<rev>`, upstream's and the one the archives are named by. */
  upstream_tag: string
  /** The Atomic fork's rev of a rebuild; `null` on a bare upstream tag. */
  atomic_rev: string | null
}

export declare function audiocppTagParts(tag: string): AudiocppTagParts | null

/** conf's audio.cpp manifest: an sd.cpp manifest with audio.cpp's tags. */
export type AudiocppPinManifest = SdcppPinManifest

export declare function parseAudiocppPinManifest(value: unknown): AudiocppPinManifest | null
export declare function resolveAudiocppPins(input: { manifest: unknown; coreVersion: string }): Pins

export declare const MLX_PIN_PLATFORMS: readonly PinPlatform[]
/** `mlxvlm-macos-arm64-<hex>`: the tags released cores install by name. */
export declare const MLX_TAG_RE: RegExp

export interface MlxTagParts {
  /** `X.Y.Z` of a fork release named by its upstream tag; `null` on `mlxvlm-macos-arm64-<hex>`. */
  version: string | null
  /** `vX.Y.Z`, the Neywa-Labs/mlx-vlm tag; `null` when the tag does not say (a conf manifest may). */
  upstream_tag: string | null
  /** The fork commit an `mlxvlm-macos-arm64-<hex>` build was made at; `null` on `vX.Y.Z`. */
  atomic_rev: string | null
}

export declare function mlxTagParts(tag: string): MlxTagParts | null

export interface MlxPinManifest {
  upstream_repo: string
  tag_name: string
  published_at: string
  assets: Array<{ backend: string; name: string; sha256?: string; size?: number }>
}

export declare function parseMlxPinManifest(value: unknown): MlxPinManifest | null
export declare function mlxManifestUpstreamTag(value: unknown): string | null
export declare function resolveMlxPins(input: {
  manifest: unknown
  coreVersion: string
}): Pins & { repo: string | null; upstream_tag: string | null }
