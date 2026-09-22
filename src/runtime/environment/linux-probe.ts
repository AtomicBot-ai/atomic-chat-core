/**
 * What a Linux machine can already do, read without changing any of it.
 *
 * The answer this produces decides whether Atomic Chat asks for a password at all. A machine that
 * already runs containers on its GPU — which describes most people who would want this engine — is
 * adopted exactly as it is: no packages, no daemon restart, no prompt. Everything else is a list of
 * what would have to be added, shown before the system asks for authorization.
 *
 * Nothing here runs a container or writes a file. The one check that would — starting a container
 * with a GPU attached — pulls an image, so it belongs to provisioning and is reported as `not-run`
 * until somebody has run it.
 *
 * A fact that could not be read is not a fact. Every probe that fails lands in `unknown`, and an
 * unknown prerequisite blocks the setup instead of being assumed present: guessing wrong here means
 * asking for a password to install something that is already there, or claiming a machine is ready
 * and failing halfway through a sixteen-gigabyte download.
 */

import type { ErrorBody, GpuFacts, ManagedAvailability } from '../../contracts/index.js'

export interface CommandOutput {
  /** Null when the binary is not on the machine at all. */
  code: number | null
  stdout: string
  stderr: string
}

export interface LinuxProbeDeps {
  exec: (command: string, args: string[]) => Promise<CommandOutput>
  readFile: (path: string) => Promise<string | null>
  freeDiskBytes: () => Promise<number | null>
}

export interface LinuxDistribution {
  id: string
  version: string
}

export interface DockerFacts {
  cli: boolean
  daemon_reachable: boolean
  /** The daemon's own id, so a later check can tell it is still the same daemon. */
  engine_identity: string | null
  version: string | null
  /** A runtime named `nvidia`, or a CDI spec directory: either can carry `--gpus`. */
  gpu_runtime: boolean
}

export interface DockerGroupFacts {
  /** The account is listed in the group. */
  configured: boolean
  /** ...and this session already has it. Group changes only count from the next sign-in. */
  effective: boolean
}

export interface LinuxFacts {
  distribution: LinuxDistribution | null
  driver_version: string | null
  gpus: GpuFacts[]
  docker: DockerFacts
  docker_group: DockerGroupFacts
  toolkit_installed: boolean
  free_disk_bytes: number | null
  /** Named checks whose answer could not be read. Each one blocks, none is assumed. */
  unknown: string[]
}

/** What an install would have to add. Ordered as the plan presents it to the user. */
export type LinuxPrerequisite =
  'nvidia-driver' | 'docker-engine' | 'nvidia-container-toolkit' | 'docker-group'

export interface LinuxAssessment {
  availability: ManagedAvailability
  /** The machine is usable as it stands: nothing to install, nothing to authorize. */
  adopts_existing_engine: boolean
  /** The account is in the group but this session is not, so it takes a sign-out to count. */
  needs_relogin: boolean
  missing: LinuxPrerequisite[]
  blockers: ErrorBody[]
}

export interface LinuxAssessmentOptions {
  /** Distributions whose installer recipe has been qualified, lowercase ids. */
  supportedDistributions: { id: string; versions: string[] }[]
  requiredDiskBytes: number | null
}

/** `/etc/os-release` is `KEY=value`, values optionally quoted. */
export function parseOsRelease(text: string | null): LinuxDistribution | null {
  if (text === null) return null
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (match === null) continue
    const value = (match[2] as string)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1')
    fields.set(match[1] as string, value)
  }
  const id = fields.get('ID')
  const version = fields.get('VERSION_ID')
  if (id === undefined || id === '' || version === undefined || version === '') return null
  return { id: id.toLowerCase(), version }
}

const MIB = 1024 * 1024

/**
 * `nvidia-smi --query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version
 * --format=csv,noheader,nounits`: one line per device, memory in MiB.
 */
export function parseNvidiaSmi(output: CommandOutput | null): {
  driver_version: string | null
  gpus: GpuFacts[]
} {
  if (output === null || output.code !== 0) return { driver_version: null, gpus: [] }
  const gpus: GpuFacts[] = []
  let driver: string | null = null
  for (const line of output.stdout.split('\n')) {
    const cells = line.split(',').map((cell) => cell.trim())
    if (cells.length < 6 || cells[0] === '') continue
    const total = Number(cells[3])
    const free = Number(cells[4])
    driver = cells[5] as string
    gpus.push({
      gpu_id: cells[0] as string,
      name: cells[1] as string,
      compute_capability: cells[2] as string,
      total_vram_bytes: Number.isFinite(total) ? total * MIB : null,
      free_vram_bytes: Number.isFinite(free) ? free * MIB : null,
      driver_version: driver,
    })
  }
  return { driver_version: driver, gpus }
}

/** `docker info --format {{json .}}`. Absent or unparseable means the daemon did not answer. */
export function parseDockerInfo(output: CommandOutput | null): Omit<DockerFacts, 'cli'> {
  const absent = {
    daemon_reachable: false,
    engine_identity: null,
    version: null,
    gpu_runtime: false,
  }
  if (output === null || output.code !== 0) return absent
  try {
    const info = JSON.parse(output.stdout) as {
      ID?: unknown
      ServerVersion?: unknown
      Runtimes?: Record<string, unknown>
      CDISpecDirs?: unknown[]
    }
    const runtimes = Object.keys(info.Runtimes ?? {})
    return {
      daemon_reachable: true,
      engine_identity: typeof info.ID === 'string' ? info.ID : null,
      version: typeof info.ServerVersion === 'string' ? info.ServerVersion : null,
      // Either road to `--gpus`: the toolkit's own runtime, or a CDI spec directory.
      gpu_runtime: runtimes.includes('nvidia') || (info.CDISpecDirs ?? []).length > 0,
    }
  } catch {
    return absent
  }
}

/** `id -nG` is this session's groups; `getent group docker` is what the account is signed up for. */
export function parseDockerGroup(
  sessionGroups: CommandOutput | null,
  groupEntry: CommandOutput | null,
  user: string
): DockerGroupFacts {
  const effective =
    sessionGroups !== null && sessionGroups.code === 0 && sessionGroups.stdout.split(/\s+/).includes('docker')
  const members =
    groupEntry !== null && groupEntry.code === 0
      ? (groupEntry.stdout.split(':')[3] ?? '').trim().split(',').filter(Boolean)
      : []
  return { configured: effective || members.includes(user), effective }
}

/** Read the machine. Every command here is read-only; none of them installs or starts anything. */
export async function probeLinux(deps: LinuxProbeDeps, user: string): Promise<LinuxFacts> {
  const unknown: string[] = []
  const osRelease = await deps.readFile('/etc/os-release').catch(() => null)
  const distribution = parseOsRelease(osRelease)
  if (distribution === null) unknown.push('distribution')

  const [smi, dockerVersion, dockerInfo, groups, groupEntry, ctk, disk] = await Promise.all([
    deps.exec('nvidia-smi', [
      '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
      '--format=csv,noheader,nounits',
    ]),
    deps.exec('docker', ['--version']),
    deps.exec('docker', ['info', '--format', '{{json .}}']),
    deps.exec('id', ['-nG']),
    deps.exec('getent', ['group', 'docker']),
    deps.exec('nvidia-ctk', ['--version']),
    deps.freeDiskBytes().catch(() => null),
  ])

  const nvidia = parseNvidiaSmi(smi)
  if (smi.code === null) unknown.push('nvidia-driver')
  if (groups.code === null) unknown.push('docker-group')
  if (disk === null) unknown.push('free-disk')

  const cli = dockerVersion.code === 0
  return {
    distribution,
    driver_version: nvidia.driver_version,
    gpus: nvidia.gpus,
    docker: { cli, ...parseDockerInfo(cli ? dockerInfo : null) },
    docker_group: parseDockerGroup(groups, groupEntry, user),
    toolkit_installed: ctk.code === 0,
    free_disk_bytes: disk,
    unknown,
  }
}

const blocker = (message: string, details?: string): ErrorBody => ({
  code: 'MANAGED_PREREQUISITE_BLOCKED',
  message,
  ...(details === undefined ? {} : { details }),
})

/** Turn the facts into a verdict: usable now, installable, or not on this machine. */
export function assessLinux(facts: LinuxFacts, options: LinuxAssessmentOptions): LinuxAssessment {
  const blockers: ErrorBody[] = []
  const missing: LinuxPrerequisite[] = []

  for (const name of facts.unknown) {
    blockers.push(blocker(`Could not determine ${name} on this system.`, name))
  }

  // No GPU and no driver is not something an installer can fix.
  if (facts.driver_version === null && !facts.unknown.includes('nvidia-driver')) {
    missing.push('nvidia-driver')
    blockers.push(blocker('No NVIDIA driver was found. Install the driver for your card, then try again.'))
  } else if (facts.gpus.length === 0 && facts.driver_version !== null) {
    blockers.push(blocker('The NVIDIA driver is installed but reports no usable GPU.'))
  }

  const supported =
    facts.distribution !== null &&
    options.supportedDistributions.some(
      (entry) => entry.id === facts.distribution?.id && entry.versions.includes(facts.distribution.version)
    )
  if (facts.distribution !== null && !supported) {
    blockers.push(
      blocker(
        'Setting the runtime up automatically is only qualified on some distributions so far.',
        `${facts.distribution.id} ${facts.distribution.version}`
      )
    )
  }

  if (!facts.docker.cli || !facts.docker.daemon_reachable) missing.push('docker-engine')
  if (!facts.toolkit_installed || !facts.docker.gpu_runtime) missing.push('nvidia-container-toolkit')
  if (!facts.docker_group.configured) missing.push('docker-group')

  if (
    options.requiredDiskBytes !== null &&
    facts.free_disk_bytes !== null &&
    facts.free_disk_bytes < options.requiredDiskBytes
  ) {
    blockers.push(
      blocker(
        'There is not enough free disk space for the runtime image.',
        `free=${facts.free_disk_bytes} required=${options.requiredDiskBytes}`
      )
    )
  }

  // The account is signed up for the group but this login session predates it.
  const needs_relogin = facts.docker_group.configured && !facts.docker_group.effective

  const adopts = blockers.length === 0 && missing.length === 0 && facts.docker_group.effective
  const availability: ManagedAvailability =
    blockers.length > 0 ? 'prerequisite-blocked' : adopts ? 'supported' : 'setup-required'

  return { availability, adopts_existing_engine: adopts, needs_relogin, missing, blockers }
}
