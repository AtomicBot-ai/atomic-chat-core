/**
 * What a `tensorrt-llm` load asks the machine right before it starts a container (task 2.14): which
 * NVIDIA cards there are — `nvidia-smi`, the same query and parser the host assessment uses, so a
 * saved `gpu_id` names a card the same way everywhere (`GPU-<uuid>`) — and whether Docker runs with
 * SELinux, read from `docker info` over the system socket through the core's one executor (design
 * D15: our mounts then carry `:z`). Asked per load rather than cached: a card can disappear between
 * two loads, and the spec wants that noticed ("Выбранная карта исчезла").
 */
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

export interface TensorrtLlmHostFacts {
  gpus: GpuFacts[]
  selinux: boolean
}

export interface ProbeTensorrtLlmHostDeps {
  exec: HostExec
  docker: DockerExec
  /** `nvidia-smi` by name on a real host; the test host's own stand-in otherwise. */
  nvidiaSmi: string
}

/** A `docker info` that does not answer reads as "no SELinux": the container create fails on its own then. */
export async function probeTensorrtLlmHost(deps: ProbeTensorrtLlmHostDeps): Promise<TensorrtLlmHostFacts> {
  const [smi, info] = await Promise.all([
    deps.exec(deps.nvidiaSmi, NVIDIA_SMI_GPU_QUERY),
    deps.docker(withSystemSocket(['info', '--format', '{{json .}}'])).catch(() => null),
  ])
  return { gpus: parseNvidiaSmi(smi).gpus, selinux: parseDockerInfo(info, null).selinux }
}
