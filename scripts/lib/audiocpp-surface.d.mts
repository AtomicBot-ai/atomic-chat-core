import type { Finding, Severity } from './llama-help.mjs'
import type { SurfaceInputs, SurfaceReport } from './engine-surface.mjs'
import type { ReleaseAssetInfo, ReleaseSpec, SdcppContract, SdcppMissing } from './sdcpp-surface.mjs'

/** The audio.cpp engine contract as the scripts read it (test/fixtures/audiocpp/engine-contract.json). */
export interface AudiocppContract extends Omit<SdcppContract, 'probe' | 'version'> {
  probe?: { argv: string[]; marker: string; source?: string }
  version?: { pattern: string; commit_pattern?: string }
  routes?: Array<{ method: string; path: string; source?: string; severity?: Severity; note?: string }>
}

export interface AudioHelp {
  /** Every flag the usage block or an option line names, sorted. */
  flags: string[]
  /** The `Endpoints:` list, without queries. */
  routes: Array<{ method: string; path: string }>
}

export declare const AUDIOCPP_CHECKS: ReadonlyArray<{ id: string; title: string }>
export declare const MIN_AUDIO_HELP_FLAGS: number
export declare const MIN_AUDIO_HELP_ROUTES: number
export declare const AUDIOCPP_RELEASE: ReleaseSpec
export declare function parseAudioHelp(text: string): AudioHelp
export declare function checkAudioHelp(contract: AudiocppContract, help: AudioHelp): Finding[]
export declare function diffAudioHelp(
  pin: AudioHelp,
  candidate: AudioHelp,
  contract: AudiocppContract
): Finding[]
export declare function parseAudioVersionOutput(
  contract: AudiocppContract,
  output: string
): { version: string; commit: string | null } | undefined
export declare function checkAudioProbe(contract: AudiocppContract, output: string | undefined): Finding[]
export declare function checkAudioVersion(
  contract: AudiocppContract,
  input: { tag?: string | null; output: string; upstreamCommit?: string | null }
): Finding[]
export declare function audioAssetRe(pattern: string, upstreamTag: string): RegExp
export declare function audiocppBackendArchives(
  contract: AudiocppContract,
  tag: string,
  assets: readonly string[]
): Record<string, string[]>
export declare function audiocppCoreAssets(
  contract: AudiocppContract,
  tag: string,
  assets: readonly string[]
): string[]
export declare function checkAudioAssets(
  contract: AudiocppContract,
  input: {
    candidate: { tag: string; assets: readonly string[] }
    pin: { tag: string; assets: readonly string[] } | null
  }
): Finding[]
export declare function audiocppCompleteness(input: {
  contract: AudiocppContract
  tag: string
  assets: readonly ReleaseAssetInfo[]
  platforms?: readonly string[]
  /** conf's staging manifest at the run's commit; `null` when conf has none; absent off conf. */
  manifest?: unknown
  downloadBase?: string
}): { complete: boolean; missing: SdcppMissing[] }
export declare function buildAudiocppReport(
  contract: AudiocppContract,
  inputs: SurfaceInputs,
  options?: { now?: string; contractSha256?: string }
): SurfaceReport
