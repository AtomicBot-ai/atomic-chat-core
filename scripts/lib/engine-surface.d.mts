import type { ContractLike, Finding, Severity } from './llama-help.mjs'

export declare const SURFACE_REPORT_SCHEMA: 'atomic-engine-surface-report'
export declare const SURFACE_INPUTS_SCHEMA: 'atomic-engine-surface-inputs'
export declare const CHECKS: ReadonlyArray<{ id: string; title: string }>

export interface MirrorWhitelistEntry {
  platform: string
  /** Regex source after `llama-<tag>-bin-`. */
  pattern: string
  required: boolean
}

export declare const MIRROR_WHITELIST: readonly MirrorWhitelistEntry[]

/** The engine contract as the surface diff reads it: the `-h` part plus assets, upstream, strings. */
export interface SurfaceContract extends ContractLike {
  schema?: string
  schema_version?: number
  engine?: string
  invocations?: Array<{ argv: string[]; source: string; expect?: string }>
  assets?: { core_backends: Array<{ platform: string; backend: string; cpu: boolean; asset: string }> }
  upstream?: {
    repo?: string
    watched_paths: Array<{ path: string; why: string }>
    release_note_keywords: Array<{ pattern: string; severity: 'warn' | 'info' }>
  }
  /** What core matches in llama-server's output (PR5). */
  strings?: Array<{
    id: string
    text: string
    /** `regex` is matched case-insensitively; anything else is a case-insensitive substring. */
    match?: string
    channel?: string
    source?: string | null
    /** How the text reads in upstream's sources (a printf format); `null`: not llama.cpp's own text. */
    upstream_text?: string | null
    severity_if_lost?: Severity
    live_expectation?: string
  }>
}

export interface Invocation {
  argv: string[]
  /** Exit code, `null` when the process died or did not start. */
  status: number | null
  signal?: string | null
  error?: string
  output?: string
}

export interface SurfaceSide {
  tag?: string | null
  build?: number | null
  commit?: string | null
  repo?: string | null
  /** `release`: downloaded from `repo`; `bin`: a local binary. */
  source: 'release' | 'bin'
  /** Where `-h` and the invocations ran, e.g. `linux-x64`. */
  platform?: string | null
  binary?: { name?: string; path?: string; sha256?: string; digest_verified?: boolean | null } | null
  release?: { published_at?: string | null; commit?: string | null } | null
  help_text?: string
  version_output?: string
  invocations?: Invocation[]
  /** The release's archive names; absent for a local binary. */
  assets?: string[] | null
  assets_error?: string
  capture_error?: string
}

export interface UpstreamCommit {
  sha: string
  subject: string
  /** Paths the commit touched; absent when only a range-wide file list is known. */
  files?: string[]
}

export type SurfaceUpstream =
  | {
      available: true
      method: 'git' | 'compare-api'
      base: string
      head: string
      truncated?: boolean
      total_commits?: number
      commits: UpstreamCommit[]
      watched: Array<{ path: string; exists: boolean; additions: number; deletions: number }>
      strings?: Record<string, { pin: number | null; candidate: number }>
    }
  | { available: false; reason: string }

export interface SurfaceInputs {
  schema?: string
  schema_version?: number
  core?: { version: string; sha: string | null } | null
  conf?: { ref: string | null; sha: string | null; dir?: string } | null
  candidate: SurfaceSide
  pin?: SurfaceSide | null
  pin_resolution?: unknown
  /** `entries: null`: conf does not mirror this engine (PrismML), so no mirror check runs. */
  whitelist?: { source: string; entries: MirrorWhitelistEntry[] | null } | null
  upstream?: SurfaceUpstream
}

export interface SurfaceCheck {
  id: string
  title: string
  status: 'pass' | 'warn' | 'break' | 'error' | 'skipped'
  counts: Record<Severity, number>
  skipped?: string
}

export interface SurfaceFinding extends Finding {
  hint?: string
}

export interface SurfaceReport {
  schema: 'atomic-engine-surface-report'
  schema_version: 1
  generated_at: string | null
  engine: string | undefined
  inputs: {
    contract: { schema: string | undefined; schema_version: number | undefined; sha256: string | null }
    core: SurfaceInputs['core'] | null
    conf: SurfaceInputs['conf'] | null
    candidate: Record<string, unknown> | null
    pin: Record<string, unknown> | null
    pin_resolution: unknown
    mirror_whitelist: { source: string } | null
    upstream: Record<string, unknown>
    same_as_pin: boolean
  }
  status: 'pass' | 'warn' | 'break' | 'error'
  counts: Record<Severity, number>
  checks: SurfaceCheck[]
  findings: SurfaceFinding[]
}

export declare function parseMirrorWhitelist(source: string): MirrorWhitelistEntry[] | undefined
export declare function parseBinaryVersion(output: string): number | undefined
export declare function versionCommit(output: string): string | undefined
export declare function checkAssets(
  contract: SurfaceContract,
  input: {
    candidate: { tag: string; assets: readonly string[] }
    pin: { tag: string; assets: readonly string[] } | null
    whitelist: readonly MirrorWhitelistEntry[] | null | undefined
  }
): Finding[]
export declare function candidateCompleteness(
  contract: SurfaceContract,
  whitelist: readonly MirrorWhitelistEntry[] | null,
  tag: string,
  assets: readonly string[],
  platforms?: readonly string[]
): {
  complete: boolean
  missing: Array<{ kind: 'mirror'; pattern: string } | { kind: 'core'; platform: string; backend: string }>
}
export declare function checkVersion(input: { tag?: string | null; output: string }): Finding[]
export declare function checkInvocations(
  contract: SurfaceContract,
  invocations: readonly Invocation[]
): Finding[]
export declare function checkReleaseNotes(
  contract: SurfaceContract,
  upstream: Extract<SurfaceUpstream, { available: true }>
): Finding[]
export declare function checkWatched(
  contract: SurfaceContract,
  upstream: Extract<SurfaceUpstream, { available: true }>
): Finding[]
export declare function countStrings(
  contract: SurfaceContract,
  files: Readonly<Record<string, string>>
): Record<string, number>
export declare function checkStrings(
  contract: SurfaceContract,
  upstream: Extract<SurfaceUpstream, { available: true }>
): Finding[] | undefined
export declare function buildReport(
  contract: SurfaceContract,
  inputs: SurfaceInputs,
  options?: { now?: string; contractSha256?: string }
): SurfaceReport
export declare function renderMarkdown(report: SurfaceReport): string
export declare function parseGitLog(text: string): Array<Required<UpstreamCommit>>
export declare function parseNumstat(
  text: string
): Array<{ path: string; additions: number; deletions: number }>
