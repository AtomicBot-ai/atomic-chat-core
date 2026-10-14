export declare const MIN_HELP_OPTIONS: number

export interface HelpOption {
  /** Every spelling, e.g. `['-c', '--ctx-size']`. */
  aliases: string[]
  /** The value hint after the aliases, e.g. `N`, `[on|off|auto]`, `{none,mean}`. */
  hint: string
  help: string
  /** Names from `(env: X)`. */
  env: string[]
  deprecated: boolean
}

export interface BuildRange {
  from: number | null
  until: number | null
}

export interface ContractLike {
  emitters?: ReadonlyArray<{ name: string; probe_gated: boolean }>
  flags: Array<{
    flag: string
    emitters: Partial<Record<string, BuildRange[]>>
    values?: Array<{ value: string; builds: BuildRange[]; probe_gated?: boolean }>
  }>
  env: Array<{ name: string; severity: 'break' | 'warn' }>
}

export type Severity = 'break' | 'warn' | 'info' | 'error'

export interface Finding {
  /** `check/subject`, stable across runs. */
  id: string
  check: string
  severity: Severity
  subject?: string
  message: string
  evidence?: unknown
}

export interface RequiredFlag {
  flag: string
  emitters: string[]
  /** Only emitters behind a `-h` probe emit it at this build. */
  probe_gated: boolean
  values: Array<{ value: string; probe_gated: boolean }>
}

export declare function parseLlamaHelp(text: string): HelpOption[]
export declare function findOption(options: readonly HelpOption[], flag: string): HelpOption | undefined
export declare function requiredAt(contract: ContractLike, build: number): RequiredFlag[]
export declare function hintChoices(hint: string): string[] | undefined
export declare function checkHelp(
  contract: ContractLike,
  build: number,
  options: readonly HelpOption[]
): Finding[]
export declare function diffHelp(
  pinOptions: readonly HelpOption[],
  candidateOptions: readonly HelpOption[],
  contract: ContractLike,
  candidateBuild: number
): Finding[]
