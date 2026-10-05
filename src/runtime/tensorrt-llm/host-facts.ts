/**
 * What a `tensorrt-llm` load asks the machine right before it starts a container (task 2.14), plus
 * what the compatibility check (task 2.16) needs on its own: which NVIDIA cards there are —
 * `nvidia-smi`, the same query and parser the host assessment uses, so a saved `gpu_id` names a card
 * the same way everywhere (`GPU-<uuid>`) — `/proc/meminfo`'s `MemAvailable` and `MemTotal` (design
 * D13: a unified-memory card's free memory and size, for `checkModelCompatibility` and for
 * `selectLaunchGpu`'s ranking, design D12b), and, for a load only, whether Docker runs with
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
import type { HostMemory } from './compatibility.js'

/** `linux-probe.ts`'s own `nvidia-smi` query: UUID, name, compute capability, memory, driver. */
export const NVIDIA_SMI_GPU_QUERY = [
  '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
  '--format=csv,noheader,nounits',
]

export const PROC_MEMINFO_PATH = '/proc/meminfo'
const MEM_AVAILABLE_LINE = /^MemAvailable:\s*(\d+)\s*kB\s*$/m
const MEM_TOTAL_LINE = /^MemTotal:\s*(\d+)\s*kB\s*$/m

function parseMeminfoLine(meminfo: string, line: RegExp): number | null {
  const match = line.exec(meminfo)
  if (match === null) return null
  const kib = Number.parseInt(match[1] as string, 10)
  return Number.isFinite(kib) ? kib * 1024 : null
}

/** `/proc/meminfo`'s `MemAvailable` line, in bytes; `null` when the text has no such line, or it does not parse. */
export function parseMemAvailableBytes(meminfo: string): number | null {
  return parseMeminfoLine(meminfo, MEM_AVAILABLE_LINE)
}

/** `/proc/meminfo`'s `MemTotal` line, in bytes; `null` when the text has no such line, or it does not parse. */
export function parseMemTotalBytes(meminfo: string): number | null {
  return parseMeminfoLine(meminfo, MEM_TOTAL_LINE)
}

export interface ReadHostMemoryDeps {
  /** `null` for ENOENT or any other read failure — `LinuxProbeDeps.readFile`'s own convention. */
  readFile: (path: string) => Promise<string | null>
}

/**
 * `MemAvailable` and `MemTotal`, a unified-memory card's free memory and size (design D13): each `0`,
 * never a guess, when `/proc/meminfo` cannot be read or that line does not parse. `0` is the safe
 * direction here — unlike SELinux below, an unreadable `/proc/meminfo` only ever makes a
 * unified-memory card under-report (its check fails short, it ranks last for the default card),
 * never over-report, so this never needs to fail the whole probe the way an unanswered
 * `docker info` does.
 */
export async function readHostMemory(deps: ReadHostMemoryDeps): Promise<HostMemory> {
  const text = await deps.readFile(PROC_MEMINFO_PATH)
  if (text === null) return { availableBytes: 0, totalBytes: 0 }
  return { availableBytes: parseMemAvailableBytes(text) ?? 0, totalBytes: parseMemTotalBytes(text) ?? 0 }
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
  memory: HostMemory
}

export interface ProbeTensorrtLlmHostDeps extends ProbeTensorrtLlmGpusDeps, ReadHostMemoryDeps {
  docker: DockerExec
}

/**
 * A `docker info` that does not answer, or answers without a daemon behind it, refuses the load
 * (findings-2.14-r1.md item 2): whether our mounts need the shared `:z` label is then unknown, and
 * guessing "no SELinux" would start a container that cannot read its own weights on an enforcing host.
 */
export async function probeTensorrtLlmHost(deps: ProbeTensorrtLlmHostDeps): Promise<TensorrtLlmHostFacts> {
  const [gpus, info, memory] = await Promise.all([
    probeTensorrtLlmGpus(deps),
    deps.docker(withSystemSocket(['info', '--format', '{{json .}}'])).catch(() => null),
    readHostMemory(deps),
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
  return { gpus, selinux: docker.selinux, memory }
}

export interface ProbeTensorrtLlmGpusAndMemoryDeps extends ProbeTensorrtLlmGpusDeps, ReadHostMemoryDeps {}

/**
 * What `POST /models/tensorrt-llm/check` needs from the machine (task 2.16): the cards and
 * the host's memory, never Docker (see the file banner).
 */
export async function probeTensorrtLlmGpusAndMemory(
  deps: ProbeTensorrtLlmGpusAndMemoryDeps
): Promise<{ gpus: GpuFacts[]; memory: HostMemory }> {
  const [gpus, memory] = await Promise.all([probeTensorrtLlmGpus(deps), readHostMemory(deps)])
  return { gpus, memory }
}
