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
