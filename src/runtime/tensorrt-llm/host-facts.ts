/**
 * What a `tensorrt-llm` load asks the machine right before it starts a container (task 2.14), plus
 * what the compatibility check (task 2.16) needs on its own: which NVIDIA cards there are —
 * `nvidia-smi`, the same query and parser the host assessment uses, so a saved `gpu_id` names a card
 * the same way everywhere (`GPU-<uuid>`) — `/proc/meminfo`'s `MemAvailable` (design D13, the
 * unified-memory branch of `checkModelCompatibility`), and, for a load only, whether Docker runs with
 * SELinux, read from `docker info` over the system socket through the core's one executor (design
 * D15: our mounts then carry `:z`). Everything here is asked fresh rather than cached: a card can
 * disappear between two loads, and the spec wants that noticed ("Выбранная карта исчезла").
 *
 * `probeTensorrtLlmGpusAndMemory` (the check route, `check.ts`) deliberately never asks Docker
 * anything: a compatibility question has to answer the same whether or not the engine is even
 * installed yet, so unlike `probeTensorrtLlmHost` (the load path, which genuinely cannot start a
 * container without knowing SELinux) it must never fail closed on `docker info`.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts } from '../../contracts/index.js'
import { withSystemSocket } from '../container/index.js'
import type { DockerExec } from '../container/index.js'
import { parseDockerInfo, parseNvidiaSmi } from '../environment/index.js'
import type { HostExec } from '../environment/index.js'

/** `linux-probe.ts`'s own `nvidia-smi` query: UUID, name, compute capability, memory, driver. */
export const NVIDIA_SMI_GPU_QUERY = [
  '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
  '--format=csv,noheader,nounits',
]

export const PROC_MEMINFO_PATH = '/proc/meminfo'
const MEM_AVAILABLE_LINE = /^MemAvailable:\s*(\d+)\s*kB\s*$/m

/** `/proc/meminfo`'s `MemAvailable` line, in bytes; `null` when the text has no such line, or it does not parse. */
export function parseMemAvailableBytes(meminfo: string): number | null {
  const match = MEM_AVAILABLE_LINE.exec(meminfo)
  if (match === null) return null
  const kib = Number.parseInt(match[1] as string, 10)
  return Number.isFinite(kib) ? kib * 1024 : null
}

export interface ReadMemAvailableDeps {
  /** `null` for ENOENT or any other read failure — `LinuxProbeDeps.readFile`'s own convention. */
  readFile: (path: string) => Promise<string | null>
}

/**
 * `MemAvailable`, for the unified-memory branch of `checkModelCompatibility`: `0`, never a guess,
 * when `/proc/meminfo` cannot be read or does not parse. `0` is the safe direction here — unlike
 * SELinux below, an unreadable `/proc/meminfo` only ever makes a unified-memory card's check
 * under-report free memory, never over-report it, so this never needs to fail the whole probe the
 * way an unanswered `docker info` does.
 */
export async function readMemAvailableBytes(deps: ReadMemAvailableDeps): Promise<number> {
  const text = await deps.readFile(PROC_MEMINFO_PATH)
  return text === null ? 0 : (parseMemAvailableBytes(text) ?? 0)
}

export interface ProbeTensorrtLlmGpusDeps {
  exec: HostExec
  /** `nvidia-smi` by name on a real host; the test host's own stand-in otherwise. */
  nvidiaSmi: string
}

/** Just the cards: the query and parser `probeTensorrtLlmHost` and the check route both share. */
export async function probeTensorrtLlmGpus(deps: ProbeTensorrtLlmGpusDeps): Promise<GpuFacts[]> {
  return parseNvidiaSmi(await deps.exec(deps.nvidiaSmi, NVIDIA_SMI_GPU_QUERY)).gpus
}

export interface TensorrtLlmHostFacts {
  gpus: GpuFacts[]
  selinux: boolean
  memAvailableBytes: number
}

export interface ProbeTensorrtLlmHostDeps extends ProbeTensorrtLlmGpusDeps, ReadMemAvailableDeps {
  docker: DockerExec
}

/**
 * A `docker info` that does not answer, or answers without a daemon behind it, refuses the load
 * (findings-2.14-r1.md item 2): whether our mounts need the shared `:z` label is then unknown, and
 * guessing "no SELinux" would start a container that cannot read its own weights on an enforcing host.
 */
export async function probeTensorrtLlmHost(deps: ProbeTensorrtLlmHostDeps): Promise<TensorrtLlmHostFacts> {
  const [gpus, info, memAvailableBytes] = await Promise.all([
    probeTensorrtLlmGpus(deps),
    deps.docker(withSystemSocket(['info', '--format', '{{json .}}'])).catch(() => null),
    readMemAvailableBytes(deps),
  ])
  const docker = parseDockerInfo(info, null)
  if (!docker.daemon_reachable) {
    throw new AtomicCoreError(
      'MANAGED_PREREQUISITE_BLOCKED',
      'Docker did not answer `docker info`, so whether SELinux needs our mounts relabelled is unknown; ' +
        'the model is not loaded. Check that the Docker daemon is running.',
      [info?.stderr, ...docker.server_errors].filter((line) => line !== undefined && line !== '').join('; ')
    )
  }
  return { gpus, selinux: docker.selinux, memAvailableBytes }
}

export interface ProbeTensorrtLlmGpusAndMemoryDeps extends ProbeTensorrtLlmGpusDeps, ReadMemAvailableDeps {}

/**
 * What `POST /models/tensorrt-llm/check` needs from the machine (task 2.16): the cards and
 * `MemAvailable`, never Docker (see the file banner).
 */
export async function probeTensorrtLlmGpusAndMemory(
  deps: ProbeTensorrtLlmGpusAndMemoryDeps
): Promise<{ gpus: GpuFacts[]; memAvailableBytes: number }> {
  const [gpus, memAvailableBytes] = await Promise.all([
    probeTensorrtLlmGpus(deps),
    readMemAvailableBytes(deps),
  ])
  return { gpus, memAvailableBytes }
}
