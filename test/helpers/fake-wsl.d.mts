/** Types for `fake-wsl.mjs` (change `add-tensorrt-llm-windows`): WSL on a Windows machine as one JSON state. */
import type { FakeLinuxHostState } from './fake-linux-host.mjs'

export interface FakeWslDistribution {
  name: string
  state: string
  version: number
  is_default: boolean
}

/** One distribution's inside: the Linux host fake plus what only a WSL guest has. */
export interface FakeWslGuest {
  /** Absolute guest path → contents, for `cat` and `test -e`. */
  files?: Record<string, string>
  /** Directories `test -e` finds (`/run/systemd/system`, …). */
  dirs?: string[]
  /** `df --output=avail -B1`; unreadable when absent. */
  free_disk_bytes?: number | null
  /** `nvidia-smi --version`'s NVML version; `nvidia-smi` is missing when absent. */
  nvml_version?: string | null
  /** The user `-d <name> --exec` runs as without `-u`. */
  default_user?: string
  /** `/etc/passwd`, as far as `getent passwd` and `useradd` need it. */
  users?: { name: string; uid: number }[]
  /** An Engine API pull answers with this error line. */
  pull_error?: string
  /** Ports something listens on inside the guest (a test listener, an engine). */
  listening?: number[]
  /** What `du -s -b` answers per guest path. */
  du_bytes?: Record<string, number>
  host?: Partial<FakeLinuxHostState>
}

export interface FakeWslState {
  /** False: only the inbox stub, which answers nothing but "not installed". */
  installed?: boolean
  /** `wsl --version`'s package version, four parts. */
  wsl_version?: string
  /** False: `--status` fails, no VM can start (a component off). */
  ready?: boolean
  distributions?: FakeWslDistribution[]
  guests?: Record<string, FakeWslGuest>
  /** What a freshly imported distribution's guest looks like. */
  import_guest?: FakeWslGuest
  /** `--import` (and/or `--install --from-file`) fails. */
  import_fails?: ('import' | 'install')[]
  /** An import takes the default even though the user has one (real WSL does only when there is none). */
  import_takes_default?: boolean
  /** Distributions `--terminate` stopped, in order. */
  terminated?: string[]
}

export interface FakeWslAnswer {
  code: number
  stdout: Buffer
  stderr: Buffer
  next?: FakeWslState
  hold?: boolean
  stream?: string[]
  shutdown?: boolean
}

export function answerWsl(
  state: FakeWslState,
  argv: string[],
  input?: Buffer | string,
  utf8?: boolean
): FakeWslAnswer
