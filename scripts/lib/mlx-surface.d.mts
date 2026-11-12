import type { Finding, Severity } from './llama-help.mjs'
import type { SurfaceInputs, SurfaceReport } from './engine-surface.mjs'
import type { ReleaseAssetInfo, ReleaseSpec, SdcppContract, SdcppMissing } from './sdcpp-surface.mjs'

/** The MLX engine contract as the scripts read it (test/fixtures/mlx/engine-contract.json). */
export interface MlxContract extends Omit<SdcppContract, 'probe' | 'version' | 'flags'> {
  /** How long an invocation may take: the frozen binary unpacks itself first. */
  invocation_timeout_ms?: number
  probe?: { argv: string[]; pattern: string; source?: string; note?: string }
  /** The names at the root of the unpacked archive. */
  archive?: { entries: string[]; source?: string; note?: string }
  flags: Array<{ flag: string; severity?: Severity; source?: string; note?: string; choices?: string[] }>
  env?: Array<{ name: string; value?: string; source: string; note?: string }>
}

export interface MlxHelp {
  /** argparse's `usage: mlx-server` line is there. */
  usage: boolean
  /** Every flag the usage block or an option line names, sorted. */
  flags: string[]
  /** For each flag argparse lists choices for, the choices, sorted. */
  choices: Record<string, string[]>
}

export declare const MLX_CHECKS: ReadonlyArray<{ id: string; title: string }>
export declare const MIN_MLX_HELP_FLAGS: number
export declare const MLX_RELEASE: ReleaseSpec
export declare function parseMlxHelp(text: string): MlxHelp
export declare function checkMlxHelp(contract: MlxContract, help: MlxHelp): Finding[]
export declare function diffMlxHelp(pin: MlxHelp, candidate: MlxHelp, contract: MlxContract): Finding[]
export declare function checkMlxProbe(
  contract: MlxContract,
  ran: { status: number | null; signal?: string; output?: string } | undefined
): Finding[]
export declare function checkMlxArchive(
  contract: MlxContract,
  entries: readonly string[] | undefined
): Finding[]
export declare function mlxAssetRe(pattern: string): RegExp
export declare function mlxDownloadBase(manifest: { upstream_repo: string }): string
export declare function mlxBackendArchives(
  contract: MlxContract,
  tag: string,
  assets: readonly string[]
): Record<string, string[]>
export declare function mlxCoreAssets(contract: MlxContract, tag: string, assets: readonly string[]): string[]
export declare function checkMlxAssets(
  contract: MlxContract,
  input: {
    candidate: { tag: string; assets: readonly string[] }
    pin: { tag: string; assets: readonly string[] } | null
  }
): Finding[]
export declare function mlxCompleteness(input: {
  contract: MlxContract
  tag: string
  assets: readonly ReleaseAssetInfo[]
  platforms?: readonly string[]
  /** conf's staging manifest at the run's commit; `null` when conf has none; absent off conf. */
  manifest?: unknown
  downloadBase?: string
}): { complete: boolean; missing: SdcppMissing[] }
export declare function mlxManifestUpstreamTagFor(docs: readonly unknown[], tag: string): string | null
export declare function buildMlxReport(
  contract: MlxContract,
  inputs: SurfaceInputs,
  options?: { now?: string; contractSha256?: string }
): SurfaceReport
