import type { ReleaseAssetInfo, ReleaseSpec, SdcppContract } from './sdcpp-surface.mjs'

export interface SdcppManifestDoc {
  updated_at?: string
  upstream_repo: string
  tag_name: string
  download_base: string
  assets: Array<{ backend: string; name: string; sha256?: string; size?: number; companion?: true }>
}

/** One file pinned by its sha256 (a GGUF), or a folder of files under `url`, each pinned (an MLX model). */
export type LiveModel =
  | { id: string; url: string; sha256: string; bytes?: number; files?: undefined }
  | {
      id: string
      /** Ends with `/`: each file is `url` + its `path`. */
      url: string
      sha256?: undefined
      files: ReadonlyArray<{ path: string; sha256: string; bytes?: number }>
    }

/** A release spec with what the fetch needs of the engine's archive. */
export interface ReleaseFixturesSpec extends ReleaseSpec {
  /** The server binary, without `.exe`. */
  server: string
  /** The binaries beside it to mark runnable. */
  executables: readonly string[]
  /** The env the engine folder is printed as. */
  engineEnv: string
  /** What to capture of the server: a file under `out` per argv. */
  captures?: ReadonlyArray<{ file: string; argv: readonly string[] }>
  /** The argv that prints the version (`--version` when absent); `null`: the server has none. */
  versionArgv?: readonly string[] | null
  /** How long a capture may run (60 s when absent). */
  captureTimeoutMs?: number
  /** The manifest the install test reads, when it is not conf's ggml manifest. */
  installManifest?: (input: {
    contract: SdcppContract
    tag: string
    repo: string
    assets: readonly ReleaseAssetInfo[]
    updatedAt?: string
  }) => unknown
}

export interface FetchReleaseFixturesInput {
  out: string
  tag: string
  repo: string
  config: { live_models?: LiveModel[] }
  contract: SdcppContract
  modelsDir: string
  skipModel: boolean
  token?: string
  platform: string
}

export declare function releaseHostArchive<A extends ReleaseAssetInfo>(
  contract: SdcppContract,
  tag: string,
  assets: readonly A[],
  platform: string,
  release: ReleaseSpec
): { backend: string; asset: A }
export declare function releaseInstallManifest(
  input: {
    contract: SdcppContract
    tag: string
    repo: string
    assets: readonly ReleaseAssetInfo[]
    updatedAt?: string
  },
  release: ReleaseSpec
): SdcppManifestDoc
export declare function fetchReleaseFixtures(
  input: FetchReleaseFixturesInput,
  engine: ReleaseFixturesSpec
): Promise<void>
export declare function sdcppHostArchive<A extends ReleaseAssetInfo>(
  contract: SdcppContract,
  tag: string,
  assets: readonly A[],
  platform: string
): { backend: string; asset: A }
export declare function sdcppInstallManifest(input: {
  contract: SdcppContract
  tag: string
  repo: string
  assets: readonly ReleaseAssetInfo[]
  updatedAt?: string
}): SdcppManifestDoc
export declare function liveModelPath(modelsDir: string, model: LiveModel): string
export declare function liveModelFiles(
  modelsDir: string,
  model: LiveModel
): Array<{ url: string; path: string; sha256: string }>
export declare function fetchSdcppFixtures(input: FetchReleaseFixturesInput): Promise<void>
