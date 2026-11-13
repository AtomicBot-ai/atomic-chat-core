import type { Finding, Severity } from './llama-help.mjs'
import type { Invocation, SurfaceInputs, SurfaceReport } from './engine-surface.mjs'

/** The sd.cpp engine contract as the scripts read it (test/fixtures/sdcpp/engine-contract.json). */
export interface SdcppContract {
  schema?: string
  schema_version?: number
  engine?: string
  invocations?: Array<{
    bin: string
    argv: string[]
    source: string
    expect?: string
    severity?: Severity
    optional?: boolean
  }>
  probe?: { bins: string[]; argv: string[]; markers: string[] }
  version?: { pattern: string }
  flags: Array<{
    flag: string
    severity?: Severity
    source?: string
    note?: string
    /** Emitted only to builds from this one on. */
    from_build?: number
    /** Emitted only to builds before this one, and to a tag that names no build. */
    below_build?: number
  }>
  strings?: Array<{
    id: string
    text: string
    channel?: string
    source?: string | null
    upstream_text?: string | null
    severity_if_lost?: Severity
  }>
  assets?: {
    core_backends: Array<{
      platform: string
      backend: string
      cpu: boolean
      required: boolean
      companion?: boolean
      asset: string
    }>
  }
  upstream?: {
    repo?: string
    branch?: string
    watched_paths: Array<{ path: string; why: string }>
    release_note_keywords: Array<{ pattern: string; severity: 'warn' | 'info' }>
  }
}

export interface SdHelpOption {
  aliases: string[]
  hint: string
  help: string
  deprecated: boolean
}

export interface ReleaseAssetInfo {
  name: string
  size?: number
  digest?: string | null
}

export type SdcppMissing =
  | { kind: 'tag'; tag: string }
  | { kind: 'core'; platform: string; backend: string }
  | { kind: 'ambiguous'; backend: string; names: string[] }
  | { kind: 'digest'; backend: string; name: string }
  | { kind: 'manifest'; reason: string }
  | { kind: 'manifest-asset'; backend: string; name?: string; reason: string }

/**
 * What differs between the engines whose builds are a ggml project's release, one archive per backend
 * id cut from an upstream tag (sd.cpp, audio.cpp), and MLX's one archive.
 */
export interface ReleaseSpec {
  /** `sd.cpp`, `audio.cpp`: the project in messages. */
  project: string
  /** `upstream_tag` is `null` when the tag does not name it (MLX's `mlxvlm-macos-arm64-<hex>`). */
  tagParts: (tag: string) => { upstream_tag: string | null; atomic_rev: string | null } | null
  /** The archive a contract pattern names for the build of `tag`. */
  assetRe: (pattern: string, tag: string) => RegExp
  /** The part of an archive's name that says which build it is, without the tag. */
  archiveKind: (name: string, tag: string) => string
  parseManifest: (value: unknown) => {
    tag_name: string
    download_base?: string
    assets: Array<{ backend: string; name: string; sha256?: string; size?: number }>
  } | null
}

export declare const SDCPP_RELEASE: ReleaseSpec
export declare function escapeRegExp(s: string): string
export declare const SDCPP_CHECKS: ReadonlyArray<{ id: string; title: string }>
export declare const MIN_SD_HELP_OPTIONS: number
export declare function parseSdHelp(text: string): SdHelpOption[]
export declare function findSdOption(options: readonly SdHelpOption[], flag: string): SdHelpOption | undefined
/** `master-<build>-<rest>` → the build number; any other tag → undefined. */
export declare function sdcppBuildOf(tag: string | undefined): number | undefined
/** The contract's flags core emits to `build` (undefined: older than every bound). */
export declare function sdFlagsForBuild(
  contract: SdcppContract,
  build: number | undefined
): SdcppContract['flags']
export declare function checkSdHelp(
  contract: SdcppContract,
  options: readonly SdHelpOption[],
  tag?: string
): Finding[]
export declare function diffSdHelp(
  pinOptions: readonly SdHelpOption[],
  candidateOptions: readonly SdHelpOption[],
  contract: SdcppContract
): Finding[]
export declare function notInArchive(ran: Invocation): boolean
export declare function checkSdInvocations(
  contract: SdcppContract,
  invocations: readonly Invocation[]
): Finding[]
export declare function checkSdProbe(
  contract: SdcppContract,
  texts: Readonly<Record<string, string | undefined>>
): Finding[]
export declare function parseSdVersion(
  contract: SdcppContract,
  output: string
): { version: string; commit: string } | undefined
export declare function checkSdVersion(
  contract: SdcppContract,
  input: { tag?: string | null; output: string }
): Finding[]
export declare function sdAssetRe(pattern: string, sha7: string): RegExp
export declare function releaseBackendArchives(
  contract: SdcppContract,
  tag: string,
  assets: readonly string[],
  release: ReleaseSpec
): Record<string, string[]>
export declare function releaseCoreAssets(
  contract: SdcppContract,
  tag: string,
  assets: readonly string[],
  release: ReleaseSpec
): string[]
export declare function checkReleaseAssets(
  contract: SdcppContract,
  input: {
    candidate: { tag: string; assets: readonly string[] }
    pin: { tag: string; assets: readonly string[] } | null
  },
  release: ReleaseSpec
): Finding[]
export declare function releaseCompleteness(
  input: {
    contract: SdcppContract
    tag: string
    assets: readonly ReleaseAssetInfo[]
    platforms?: readonly string[]
    manifest?: unknown
    downloadBase?: string
  },
  release: ReleaseSpec
): { complete: boolean; missing: SdcppMissing[] }
export declare function releaseReport(
  contract: SdcppContract,
  inputs: SurfaceInputs,
  own: {
    findings: Finding[]
    skipped: Record<string, string>
    checks: ReadonlyArray<{ id: string; title: string }>
    hints: Readonly<Record<string, string>>
  },
  options?: { now?: string; contractSha256?: string }
): SurfaceReport
export declare function sdcppBackendArchives(
  contract: SdcppContract,
  tag: string,
  assets: readonly string[]
): Record<string, string[]>
export declare function sdcppCoreAssets(
  contract: SdcppContract,
  tag: string,
  assets: readonly string[]
): string[]
export declare function checkSdAssets(
  contract: SdcppContract,
  input: {
    candidate: { tag: string; assets: readonly string[] }
    pin: { tag: string; assets: readonly string[] } | null
  }
): Finding[]
export declare function sdcppCompleteness(input: {
  contract: SdcppContract
  tag: string
  assets: readonly ReleaseAssetInfo[]
  platforms?: readonly string[]
  /** conf's staging manifest at the run's commit; `null` when conf has none; absent off conf. */
  manifest?: unknown
  downloadBase?: string
}): { complete: boolean; missing: SdcppMissing[] }
export declare function buildSdcppReport(
  contract: SdcppContract,
  inputs: SurfaceInputs,
  options?: { now?: string; contractSha256?: string }
): SurfaceReport
