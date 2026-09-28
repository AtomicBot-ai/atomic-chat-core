/**
 * What a Linux machine can already do, read without changing any of it.
 *
 * The answer this produces decides whether Atomic Chat asks for a password at all. A machine that
 * already runs containers on its GPU — which describes most people who would want this engine — is
 * adopted exactly as it is: no packages, no daemon restart, no prompt. Everything else is a list of
 * what would have to be added, shown before the system asks for authorization. Turning these facts
 * into that verdict is `assessLinux` in `./linux-plan.js`; this file only reads the machine.
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

import type {
  ErrorBody,
  GpuFacts,
  LinuxDockerInstallMethod,
  LinuxPackageFamily,
} from '../../contracts/index.js'
import { detectDockerInstallMethod, parseDockerInfo } from './linux-docker-facts.js'

export interface CommandOutput {
  /** Null when the binary is not on the machine at all. */
  code: number | null
  stdout: string
  stderr: string
}

export interface LinuxProbeDeps {
  exec: (command: string, args: string[]) => Promise<CommandOutput>
  readFile: (path: string) => Promise<string | null>
  /** For a socket, a directory, or a flag file such as `/run/ostree-booted`; never its contents. */
  pathExists: (path: string) => Promise<boolean>
  /** Free space at one path, computed however the caller likes (`statfs`, a platform API, ...). */
  freeDiskBytes: (path: string) => Promise<number | null>
}

export interface LinuxProbeOptions {
  /** The account core is running as. Used only to label a plan step, never to gate access (D2). */
  user: string
  /** `$XDG_RUNTIME_DIR`, supplied by the caller — never read from `process.env` here. Null when unset. */
  xdgRuntimeDir: string | null
}

export interface LinuxDistribution {
  id: string
  version_id: string
  /** `ID_LIKE`, space-separated, lowercase. Empty when the file has none. */
  id_like: string[]
  family: LinuxPackageFamily
}

export interface DockerFacts {
  cli: boolean
  daemon_reachable: boolean
  /** The daemon's own id, so a later check can tell it is still the same daemon. */
  engine_identity: string | null
  version: string | null
  install_method: LinuxDockerInstallMethod | null
  /** A runtime named `nvidia`, or an NVIDIA CDI spec: either can carry `--gpus`. */
  gpu_runtime: boolean
  /** SELinux is enforcing for containers: mounts of our directories need the `:z` label (D15). */
  selinux: boolean
  docker_root_dir: string | null
  containers_running: number
}

export interface LinuxFacts {
  /** `uname -m`, `arm64` normalised to `aarch64`. Null when the command could not run. */
  architecture: string | null
  distribution: LinuxDistribution | null
  /** `/run/ostree-booted` exists: an rpm-ostree host (Silverblue, Kinoite, Bazzite, ...). */
  immutable_os: boolean
  driver_version: string | null
  gpus: GpuFacts[]
  docker: DockerFacts
  toolkit_installed: boolean
  free_disk_bytes: number | null
  /** Named checks whose answer could not be read. Each one blocks, none is assumed. */
  unknown: string[]
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
  const versionId = fields.get('VERSION_ID')
  if (id === undefined || id === '' || versionId === undefined || versionId === '') return null
  const idLike = (fields.get('ID_LIKE') ?? '')
    .split(/\s+/)
    .map((entry) => entry.toLowerCase())
    .filter(Boolean)
  return {
    id: id.toLowerCase(),
    version_id: versionId,
    id_like: idLike,
    family: packageFamilyFor(id.toLowerCase(), idLike),
  }
}

const APT_FAMILY = new Set(['debian', 'ubuntu'])
const DNF_FAMILY = new Set(['fedora', 'rhel', 'centos', 'rocky', 'almalinux'])
const PACMAN_FAMILY = new Set(['arch', 'manjaro', 'endeavouros'])

/** `ID` first, `ID_LIKE` as a fallback for a derivative distribution (e.g. Linux Mint, Nobara). */
function packageFamilyFor(id: string, idLike: string[]): LinuxPackageFamily {
  if (APT_FAMILY.has(id) || idLike.some((entry) => APT_FAMILY.has(entry))) return 'apt'
  if (DNF_FAMILY.has(id) || idLike.some((entry) => DNF_FAMILY.has(entry))) return 'dnf'
  if (PACMAN_FAMILY.has(id) || idLike.some((entry) => PACMAN_FAMILY.has(entry))) return 'pacman'
  return 'other'
}

/** `uname -m`: normalise the one alias (`arm64`, common outside Linux) to the Linux spelling. */
export function normalizeArchitecture(raw: string): string {
  const trimmed = raw.trim()
  return trimmed === 'arm64' ? 'aarch64' : trimmed
}

const MIB = 1024 * 1024

/**
 * `nvidia-smi --query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version
 * --format=csv,noheader,nounits`: one line per device, memory in MiB.
 *
 * A unified-memory card (GB10/DGX Spark) reports `[N/A]` for both memory columns instead of a
 * number; `Number('[N/A]')` is `NaN`, so those fields come out `null` rather than a wrong number —
 * the model-compatibility check reads that as "compare against host memory instead" (design D13).
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

const DOCKER_SOCKET = 'unix:///var/run/docker.sock'

/**
 * Read the machine. Every command here is read-only; none of them installs, starts, enables or
 * pulls anything.
 */
export async function probeLinux(deps: LinuxProbeDeps, options: LinuxProbeOptions): Promise<LinuxFacts> {
  const unknown: string[] = []
  const osRelease = await deps.readFile('/etc/os-release').catch(() => null)
  const distribution = parseOsRelease(osRelease)
  if (distribution === null) unknown.push('distribution')

  const [unameM, smi, dockerVersion, dockerInfo, ctk, cdiList, dpkgQuery, rpmQuery, snapList, immutableOs] =
    await Promise.all([
      deps.exec('uname', ['-m']),
      deps.exec('nvidia-smi', [
        '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
        '--format=csv,noheader,nounits',
      ]),
      deps.exec('docker', ['--version']),
      // `-H` pins the query to the system socket as the current user, overriding both DOCKER_HOST
      // and an active DOCKER_CONTEXT (spec: access is decided by calling the daemon, never by a
      // user context or group membership).
      deps.exec('docker', ['-H', DOCKER_SOCKET, 'info', '--format', '{{json .}}']),
      deps.exec('nvidia-ctk', ['--version']),
      deps.exec('nvidia-ctk', ['cdi', 'list']),
      deps.exec('dpkg-query', [
        '-W',
        '-f',
        '${Package}\n',
        'docker-ce',
        'docker.io',
        'moby-engine',
        'podman-docker',
      ]),
      deps.exec('rpm', ['-q', 'docker-ce', 'docker.io', 'moby-engine', 'podman-docker']),
      deps.exec('snap', ['list', 'docker']),
      deps.pathExists('/run/ostree-booted').catch(() => false),
    ])

  if (unameM.code === null) unknown.push('architecture')
  const architecture = unameM.code === 0 ? normalizeArchitecture(unameM.stdout) : null

  const nvidia = parseNvidiaSmi(smi)
  if (smi.code === null) unknown.push('nvidia-driver')

  const cli = dockerVersion.code === 0
  const info = parseDockerInfo(cli ? dockerInfo : null, cdiList)

  const rootlessSocketPresent =
    options.xdgRuntimeDir !== null &&
    (await deps.pathExists(`${options.xdgRuntimeDir}/docker.sock`).catch(() => false))
  const installMethod = detectDockerInstallMethod(
    info,
    { dockerVersion, dpkgQuery, rpmQuery, snapList },
    rootlessSocketPresent
  )

  // Before anything is installed there is no DockerRootDir yet; check the default location a
  // fresh install would use instead, so a plan can still say whether there is room for it.
  const diskCheckPath = info.docker_root_dir ?? '/var/lib/docker'
  const disk = await deps.freeDiskBytes(diskCheckPath).catch(() => null)
  if (disk === null) unknown.push('free-disk')

  return {
    architecture,
    distribution,
    immutable_os: immutableOs,
    driver_version: nvidia.driver_version,
    gpus: nvidia.gpus,
    docker: {
      cli,
      daemon_reachable: info.daemon_reachable,
      engine_identity: info.engine_identity,
      version: info.version,
      install_method: installMethod,
      gpu_runtime: info.gpu_runtime,
      selinux: info.selinux,
      docker_root_dir: info.docker_root_dir,
      containers_running: info.containers_running,
    },
    toolkit_installed: ctk.code === 0,
    free_disk_bytes: disk,
    unknown,
  }
}

/** Shared with `windows-probe.ts` and `linux-plan.ts`: one `MANAGED_PREREQUISITE_BLOCKED` shape. */
export const prerequisiteBlocker = (message: string, details?: string): ErrorBody => ({
  code: 'MANAGED_PREREQUISITE_BLOCKED',
  message,
  ...(details === undefined ? {} : { details }),
})
