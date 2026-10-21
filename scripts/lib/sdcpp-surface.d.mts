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
  flags: Array<{ flag: string; severity?: Severity; source?: string; note?: string }>
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

export declare const SDCPP_CHECKS: ReadonlyArray<{ id: string; title: string }>
export declare const MIN_SD_HELP_OPTIONS: number
export declare function parseSdHelp(text: string): SdHelpOption[]
export declare function findSdOption(options: readonly SdHelpOption[], flag: string): SdHelpOption | undefined
export declare function checkSdHelp(contract: SdcppContract, options: readonly SdHelpOption[]): Finding[]
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
