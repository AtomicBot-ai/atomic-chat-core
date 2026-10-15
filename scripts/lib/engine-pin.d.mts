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
  /** Which conf file decided: the release list when this core reads it, else the legacy manifest. */
  source: 'list' | 'legacy' | 'none'
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
