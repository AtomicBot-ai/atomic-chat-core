export declare const RESULTS_SCHEMA: 'atomic-engine-candidate-results'
export declare const RESOLVE_SCHEMA: 'atomic-engine-candidate-resolve'
export declare const CELL_SCHEMA: 'atomic-engine-candidate-cell'
export declare const CANDIDATE_ID_RE: RegExp

export interface EngineCandidateConfig {
  engine: string
  contract: string
  default_repo: string
  platforms: Array<{ platform: string; runner: string }>
  live_files: string[]
  required_live_tests: Array<{ file: string; name: string }>
  core_suites: string[]
  protected_paths: string[]
  not_verified: string[]
}

/** The subset of a Vitest JSON report this reads. */
export interface VitestReport {
  testResults?: Array<{
    name?: string
    assertionResults?: Array<{
      fullName?: string
      title?: string
      ancestorTitles?: string[]
      status?: string
    }>
  }>
}

export interface TestOutcome {
  file: string
  name: string
  status: 'passed' | 'failed' | 'skipped'
}

export interface Counts {
  passed: number
  failed: number
  skipped: number
}

export interface LiveCell {
  schema?: string
  kind: 'live'
  platform: string
  os?: string
  role: 'pin' | 'candidate'
  tag: string | null
  repo?: string | null
  status: 'pass' | 'fail' | 'incomplete' | 'missing' | 'same-as-pin' | 'no-pin' | 'not-run'
  asset?: { name: string; sha256: string; digest_verified?: boolean | null } | null
  model?: { sha256: string; verified?: boolean } | null
  version_output?: string | null
  tests?: Counts
  failed_tests?: string[]
  missing_required?: string[]
  /** From the live contract probe's observed.json, when it ran. */
  observed?: { breaks: string[]; drift: DriftEntry[] }
  error?: string
}

export interface DriftEntry {
  kind: string
  id: string
  verdict: 'lost' | 'appeared'
  severity: string
}

export interface CoreCell {
  schema?: string
  kind: 'core'
  platform: string
  os?: string
  status: 'pass' | 'fail' | 'incomplete' | 'missing' | 'not-requested'
  steps?: Record<string, string>
  tests?: Counts
  failed_tests?: string[]
}

export type Cell = LiveCell | CoreCell

export interface ResolveResult {
  schema: 'atomic-engine-candidate-resolve'
  schema_version: 1
  engine: string
  candidate_id: string
  suites: 'all' | 'live'
  core: { ref: string | null; sha: string | null; version: string; protected_changes: string[] | null }
  conf: { ref: string | null; sha: string | null }
  candidate: {
    repo: string | null
    tag: string | null
    source: 'release' | 'bin'
    commit?: string | null
    published_at?: string | null
    complete: boolean
    missing: unknown[]
    /** The release's archives core installs, by name. */
    core_assets: string[]
  }
  pin: {
    source: string
    tag: string | null
    repo: string | null
    per_platform: Record<string, { backend?: string; tag: string | null }>
    list?: unknown
    legacy?: unknown
  }
  platforms: Array<{ platform: string; runner: string }>
  live_matrix: Array<{ platform: string; os: string; role: 'pin' | 'candidate'; tag: string; repo: string }>
  errors: string[]
}

export interface Reason {
  status: 'fail' | 'incomplete'
  code: string
  message: string
  detail?: unknown
}

export interface Results {
  schema: 'atomic-engine-candidate-results'
  schema_version: 1
  generated_at: string | null
  engine: string | null
  run: Record<string, unknown> | null
  core: ResolveResult['core'] | null
  conf: ResolveResult['conf'] | null
  candidate: ResolveResult['candidate'] | null
  pin: ResolveResult['pin'] | null
  status: 'pass' | 'fail' | 'incomplete'
  reasons: Reason[]
  surface: { status: string; counts?: Record<string, number>; same_as_pin?: boolean }
  cells: Cell[]
  verdict: {
    candidate_regressions: Array<{ platform: string; test: string }>
    core_failures: Array<{ platform: string; test: string }>
    candidate_failures: Array<{ platform: string; test: string }>
    pin_failures: Array<{ platform: string; test: string }>
    drift: Array<{ platform: string } & DriftEntry>
    verified_assets: Array<{
      platform: string
      name: string
      sha256: string
      digest_verified: boolean | null
    }>
    unverified_assets: string[]
    coverage: { verified: string[]; not_verified: string[] }
  }
}

export declare function vitestOutcomes(report: VitestReport | undefined): TestOutcome[]
export declare function liveCell(input: {
  platform: string
  os?: string
  role: 'pin' | 'candidate'
  tag: string | null
  repo?: string | null
  fixture?: {
    asset?: LiveCell['asset']
    model?: { sha256: string; verified?: boolean } | null
    version_output?: string
  } | null
  vitest?: VitestReport
  required: ReadonlyArray<{ name: string }>
  /** The live probe's observed.json (`atomic-engine-observed`); anything else is ignored. */
  observed?: unknown
  error?: string
}): LiveCell
export declare function coreCell(input: {
  platform: string
  os?: string
  steps: Record<string, string>
  vitest?: VitestReport[]
  expected: readonly string[]
}): CoreCell
export declare function buildResults(input: {
  run?: Record<string, unknown> | null
  config?: Pick<EngineCandidateConfig, 'engine' | 'not_verified'> | null
  resolve?: ResolveResult
  surface?: {
    status: string
    counts?: Record<string, number>
    findings: Array<{ id: string; severity: string }>
    inputs?: { same_as_pin?: boolean }
  }
  cells: readonly Cell[]
  platforms: readonly string[]
  now?: string
}): Results
export declare function renderResultsMarkdown(results: Results): string
