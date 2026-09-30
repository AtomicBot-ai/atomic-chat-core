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
  /** The full `nvidia-container-toolkit` package. */
  toolkit: boolean
  /** Only `nvidia-container-toolkit-base`: `nvidia-ctk` answers, the package query does not (task 2.23, F-5). */
  toolkit_base?: boolean
  /** A generated NVIDIA CDI spec (`nvidia-ctk cdi list` names a device); defaults to `docker.gpu_runtime`. */
  cdi?: boolean
  /** `/proc/net/route` text the test host serves (task 2.23, F-4); none when omitted. */
  proc_net_route?: string
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
