/** Types for `fake-linux-host.mjs` (task 2.6): a Linux machine as one JSON state. */
export interface FakeLinuxHostState {
  arch?: string
  /** Account name the fake group answers for; the real login name when omitted. */
  user?: string
  driver: string | null
  /** Memory in MiB, or `'[N/A]'` as a unified-memory card (GB10) prints it. */
  gpus?: { uuid: string; name: string; cc: string; total_mib: number | '[N/A]'; free_mib: number | '[N/A]' }[]
  docker: {
    installed: boolean
    reachable: boolean
    service_active: boolean
    gpu_runtime: boolean
    containers_running?: number
    selinux?: boolean
    root_dir?: string
  }
  toolkit: boolean
  group?: { configured: boolean; effective: boolean }
  gpu_visible_in_container: boolean
  /** `repository@sha256:…` references Docker holds. */
  images?: string[]
  containers?: { id: string; image: string; running?: boolean }[]
  /** How many `docker stop` calls fail before one is confirmed. */
  stop_refusals?: number
}

export interface FakeAnswer {
  code: number
  stdout: string
  stderr: string
  next?: FakeLinuxHostState
}

export function answer(state: FakeLinuxHostState, command: string, args: string[]): FakeAnswer
