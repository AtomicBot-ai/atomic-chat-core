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

import type { GpuFacts, LinuxDockerInstallMethod, LinuxPackageFamily } from '../../contracts/index.js'
import {
  cdiEnabledByDefault,
  cdiListsNvidiaGpu,
  daemonJsonFeaturesCdi,
  daemonJsonNvidiaRuntimeEvidence,
  detectDockerInstallMethod,
  detectEngineVersion,
  PACMAN_PACKAGE_CANDIDATES,
  parseDockerInfo,
} from './linux-docker-facts.js'

export interface CommandOutput {
  /** Null when the binary is not on the machine at all. */
  code: number | null
  stdout: string
  stderr: string
}

export interface LinuxProbeDeps {
  /**
   * `env`, when given, is an *overlay* on the environment this call would otherwise inherit — never
   * a full replacement. Every other inherited variable (`PATH`, locale, ...) stays; a key mapped to
   * a string sets it, a key mapped to `undefined` strips it. Used to keep a stray `DOCKER_HOST`/
   * `DOCKER_CONTEXT`/`DOCKER_TLS_VERIFY`/`DOCKER_CERT_PATH` from steering the forced system-socket
   * `docker info` call anywhere else, without discarding the rest of the environment the command
   * would normally need (round 2, item 10 — the earlier wording here said "replaces", which is not
   * what a caller should implement: `hostExec` in `host-exec.ts` merges this onto `process.env`, or
   * onto its own configured base environment, rather than substituting it wholesale).
   */
  exec: (command: string, args: string[], env?: Record<string, string | undefined>) => Promise<CommandOutput>
  /**
   * The file's text. Contract (round 4, item D): resolve `null` **only** when the file does not
   * exist (`ENOENT`); **reject** on every other failure (`EACCES`, `EISDIR`, `EIO`, ...). This probe
   * relies on the difference for `/etc/docker/daemon.json`: `null` reads as "nothing configured
   * yet", a rejection as "exists but unreadable", which blocks rather than planning a runtime change
   * over a file nobody could read. An implementation that maps every error to `null` silently turns
   * a locked-down file into "not configured". This module ships no default implementation; the
   * caller that wires `probeLinux` to the real filesystem owns this contract.
   */
  readFile: (path: string) => Promise<string | null>
  /** For a socket, a directory, or a flag file such as `/run/ostree-booted`; never its contents. */
  pathExists: (path: string) => Promise<boolean>
  /**
   * Free space at one path, computed however the caller likes (`statfs`, a platform API, ...).
   * Always called with a path this probe has already confirmed exists (`freeDiskBytes` itself does
   * not need to walk up to find one) — see `nearestExistingAncestor` in `probeLinux`.
   */
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
  /** `VERSION_ID`, or `BUILD_ID` (Arch/Manjaro/EndeavourOS, Debian testing/sid) when there is no
   *  `VERSION_ID` at all, or `''` when the file has neither — which then matches no install recipe
   *  (item 1: a rolling-release host is never mistaken for one with no distribution at all). */
  version_id: string
  /** `ID_LIKE`, space-separated, lowercase. Empty when the file has none. */
  id_like: string[]
  family: LinuxPackageFamily
}

/** The account this probe ran as, from `id -nG` / `getent group docker` — diagnostic only. */
export interface DockerGroupFacts {
  /**
   * The account is listed in the `docker` group's members. `'unknown'` when `getent` itself could
   * not answer *and* this session's own groups (`id -nG`) do not already show it either — a probe
   * that cannot read `/etc/group` has not learned "not a member", so this must not be reported as a
   * confident `false` (round 2, item 9). `getent`'s own exit `2` ("no such key": the `docker` group
   * does not exist on this system at all) is different — that is a real, definitive answer, not a
   * failure to read anything, so it reports `false` rather than `'unknown'` (round 3, ruling 7).
   */
  configured: boolean | 'unknown'
  /** ...and this login session already carries it (`id -nG`); a group change needs a fresh login. */
  effective: boolean
}

export interface DockerFacts {
  cli: boolean
  daemon_reachable: boolean
  /** The daemon's own id, so a later check can tell it is still the same daemon. */
  engine_identity: string | null
  version: string | null
  install_method: LinuxDockerInstallMethod | null
  /**
   * The installed engine package's version (`dpkg-query`'s `${Version}`, `rpm -q`'s own
   * name-version-release string, or `pacman -Q docker`), independent of whether the daemon can be
   * reached — used only to decide whether Docker's CDI-on-by-default (28.2+) applies when
   * `daemon.json` does not say so explicitly (round 3, ruling 5). Null when no package database
   * confirms a version (including for `docker-desktop`/`snap`/`podman-docker`/rootless, which this
   * never looks at — only `docker-ce`/`docker.io`/`moby-engine`).
   */
  engine_version: string | null
  /** A runtime named `nvidia`, or an NVIDIA CDI spec: either can carry `--gpus`. Only meaningful
   *  when `daemon_reachable` — otherwise this is `false` because there was no answer, not because
   *  the runtime is missing; use `gpu_runtime_from_config` when the daemon could not be reached. */
  gpu_runtime: boolean
  /**
   * Read-only evidence the GPU runtime is configured that does not require reaching the daemon
   * (`/etc/docker/daemon.json`'s own `runtimes.nvidia`, or CDI counted as enabled — either
   * `daemon.json`'s explicit `features.cdi: true`, or Docker's own 28.2+ default when
   * `engine_version` is known and `daemon.json` does not say `false` (round 3, ruling 5) — next to a
   * listed NVIDIA CDI device, mirroring the live path's own `CDISpecDirs` requirement, round 2 item
   * 7) — the only signal available when `daemon_reachable` is false, so a plan never reconfigures a
   * runtime it has no real evidence about (item 3).
   */
  gpu_runtime_from_config: boolean
  /**
   * `/etc/docker/daemon.json` exists but this probe could not use it: reading it failed (`readFile`
   * rejected — `EACCES` on a `0600` file, a directory at that path, ...) or its contents did not
   * parse as JSON. `assessLinux` must not plan `nvidia-ctk runtime configure` in this state — it
   * would be writing next to a file it cannot even read back — and blocks with an instruction to fix
   * the file by hand instead (round 2 item 6; round 3 item 2; round 4 item C). Neither the runtime
   * entry nor the CDI setting is assumed behind an unreadable file (round 4, item A).
   */
  daemon_json_unreadable: boolean
  /** SELinux is enforcing for containers: mounts of our directories need the `:z` label (D15). */
  selinux: boolean
  docker_root_dir: string | null
  containers_running: number
  /** `systemctl is-active docker`. `'unknown'` only when the check itself could not run. */
  service_active: boolean | 'unknown'
  /** `docker info`'s own `ServerErrors`, surfaced for diagnostics (item 17). */
  server_errors: string[]
}

export interface LinuxFacts {
  /** `uname -m`, `arm64` normalised to `aarch64`. Null when the command did not answer with `0`. */
  architecture: string | null
  distribution: LinuxDistribution | null
  /** `/run/ostree-booted` exists: an rpm-ostree host (Silverblue, Kinoite, Bazzite, ...). */
  immutable_os: boolean
  /**
   * The host runs systemd: `/run/systemd/system` exists, the `sd_booted()` test. `false` on a
   * container whose PID 1 is not an init system; `'unknown'` when the check itself failed.
   */
  systemd: boolean | 'unknown'
  driver_version: string | null
  gpus: GpuFacts[]
  docker: DockerFacts
  /** Diagnostic only — never gates readiness (spec: access is `docker info` answering, not group
   *  membership). 2.6 reads this to tell "daemon active, this session just needs to relogin" apart
   *  from "the daemon is not reachable at all" (item 2). */
  docker_group: DockerGroupFacts
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
  if (id === undefined || id === '') return null
  // Arch, Manjaro and EndeavourOS ship no VERSION_ID at all (rolling release); Debian testing/sid
  // has none either. BUILD_ID is Arch's nearest equivalent; when even that is absent, '' matches no
  // install recipe (item 1) rather than making the whole distribution look unread.
  const versionId = fields.get('VERSION_ID') ?? fields.get('BUILD_ID') ?? ''
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
 * One memory cell in MiB, as bytes: a plain number (`nounits`) or one followed by ` MiB` (a query
 * without `nounits`). Anything else — `[N/A]`/`N/A` on a unified-memory card, `[Not Supported]`, an
 * empty cell — is `null`, never `0`: `Number('')` is `0`, and a zero read as a size would refuse
 * every model for "no memory" instead of taking the unified-memory branch (design D13), while a
 * `NaN` from `Number('32607 MiB')` would turn a discrete card into a unified-memory one.
 */
function mibCellBytes(cell: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(?:\s*MiB)?$/.exec(cell)
  return match === null ? null : Number(match[1]) * MIB
}

/**
 * `nvidia-smi --query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version
 * --format=csv,noheader,nounits`: one line per device, memory in MiB.
 *
 * A unified-memory card (GB10/DGX Spark) reports `[N/A]` for both memory columns instead of a
 * number (captured on a DGX Spark-class host, driver 595.71.05), so those fields come out `null`
 * rather than a wrong number — the model-compatibility check reads that as "compare against host
 * memory instead" (design D13). A header line (`uuid, name, ...`, from a query without `noheader`)
 * is not a card.
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
    if (cells.length < 6 || cells[0] === '' || cells[0] === 'uuid') continue
    driver = cells[5] as string
    gpus.push({
      gpu_id: cells[0] as string,
      name: cells[1] as string,
      compute_capability: cells[2] as string,
      total_vram_bytes: mibCellBytes(cells[3] as string),
      free_vram_bytes: mibCellBytes(cells[4] as string),
      driver_version: driver,
    })
  }
  return { driver_version: driver, gpus }
}

/**
 * Parses `docker` from `id -nG` (this session's groups) and `getent group docker` (its members).
 *
 * `effective` (this session's own groups) is always a real answer on its own. For `configured`:
 * `getent` exiting `2` ("no such key" — the `docker` group does not exist on this system at all) is
 * itself a real, definitive answer, so that reads as `false`, not `'unknown'` (round 3, ruling 7).
 * Any other failure (a different exit code, or the binary not being on the machine) proves nothing
 * either way, so it falls back to `'unknown'` unless `effective` already confirmed membership on its
 * own — this session already showing `docker` in `id -nG` needs no corroboration from `getent`
 * (round 2, item 9).
 */
export function parseDockerGroup(
  sessionGroups: CommandOutput | null,
  groupEntry: CommandOutput | null,
  user: string
): DockerGroupFacts {
  const effective =
    sessionGroups !== null && sessionGroups.code === 0 && sessionGroups.stdout.split(/\s+/).includes('docker')
  if (groupEntry !== null && groupEntry.code === 2) {
    return { configured: effective, effective }
  }
  if (groupEntry === null || groupEntry.code !== 0) {
    return { configured: effective ? true : 'unknown', effective }
  }
  const members = (groupEntry.stdout.split(':')[3] ?? '').trim().split(',').filter(Boolean)
  return { configured: effective || members.includes(user), effective }
}

/**
 * `systemctl is-active docker`: exits `0` and prints `active` only when the unit is really up.
 *
 * Known gap, documented rather than closed here (round 2 finding, "socket-activation note"): a host
 * where `docker.socket` is active but `docker.service` itself is only started on first connection
 * (`systemctl is-active docker` answering `inactive` right up until something dials the socket)
 * would read as not active here, even though a real connection would in fact start it. Closing this
 * needs a second `systemctl is-active docker.socket` call and a decision about how it interacts with
 * every branch that reads `service_active` (`assessLinux`'s access-only/relogin path and
 * `buildInstallPlan`'s `enable-docker-service`/`restart-docker` steps) — left for task 2.6 to decide
 * against the actual wiring rather than guessed at here.
 */
export function parseServiceActive(output: CommandOutput | null): boolean | 'unknown' {
  if (output === null || output.code === null) return 'unknown'
  return output.code === 0 && output.stdout.trim() === 'active'
}

const DOCKER_SOCKET = 'unix:///var/run/docker.sock'
// The forced-socket query must never be steered by a leftover remote/TLS context (item 17).
const STRIP_DOCKER_ENV = {
  DOCKER_HOST: undefined,
  DOCKER_CONTEXT: undefined,
  DOCKER_TLS_VERIFY: undefined,
  DOCKER_CERT_PATH: undefined,
}

/**
 * Walks a path up to the nearest existing ancestor (`/var/lib/docker` → `/var/lib` → `/var` → `/`),
 * so a free-space check on a not-yet-installed `DockerRootDir` lands somewhere real instead of
 * failing outright (item 7: a clean machine has no `/var/lib/docker` yet).
 */
export async function nearestExistingAncestor(
  pathExists: LinuxProbeDeps['pathExists'],
  path: string
): Promise<string> {
  const segments = path.split('/').filter(Boolean)
  for (let end = segments.length; end >= 0; end--) {
    const candidate = `/${segments.slice(0, end).join('/')}`
    if (await pathExists(candidate).catch(() => false)) return candidate
  }
  return '/'
}

/**
 * `readFile` collapses "does not exist" (`ENOENT`) and every other failure (`EACCES` on a `0600`
 * file, a directory where a file was expected, ...) into the same `null` when a caller blanket-
 * catches it — which is correct for `/etc/os-release` (never expected to be permission-restricted)
 * but wrong for `/etc/docker/daemon.json`, which a hardened host may deliberately lock down. This
 * distinguishes them: `{ text: null, unreadable: false }` only for a `readFile` that itself resolved
 * `null` (this repo's convention for "not there"); a `readFile` that *rejects* is a real read error,
 * reported as `{ text: null, unreadable: true }` rather than silently folded into "not configured"
 * (round 3, item 2).
 */
async function readDaemonJson(
  readFile: LinuxProbeDeps['readFile']
): Promise<{ text: string | null; unreadable: boolean }> {
  try {
    return { text: await readFile('/etc/docker/daemon.json'), unreadable: false }
  } catch {
    return { text: null, unreadable: true }
  }
}

/**
 * Read the machine. Every command here is read-only; none of them installs, starts, enables or
 * pulls anything.
 */
export async function probeLinux(deps: LinuxProbeDeps, options: LinuxProbeOptions): Promise<LinuxFacts> {
  const unknown: string[] = []
  const osRelease = await deps.readFile('/etc/os-release').catch(() => null)
  const distribution = parseOsRelease(osRelease)
  if (distribution === null) unknown.push('distribution')

  const [
    unameM,
    smi,
    dockerVersion,
    dockerInfo,
    ctk,
    cdiList,
    dpkgQuery,
    rpmQuery,
    pacmanQuery,
    snapList,
    immutableOs,
    systemd,
    sessionGroups,
    groupEntry,
    serviceActive,
    daemonJsonRead,
  ] = await Promise.all([
    deps.exec('uname', ['-m']),
    deps.exec('nvidia-smi', [
      '--query-gpu=uuid,name,compute_cap,memory.total,memory.free,driver_version',
      '--format=csv,noheader,nounits',
    ]),
    deps.exec('docker', ['--version']),
    // `-H` pins the query to the system socket as the current user, overriding both DOCKER_HOST
    // and an active DOCKER_CONTEXT; the explicit env override also strips it and TLS settings from
    // the child process rather than relying on the flag alone (spec: access is decided by calling
    // the daemon, never by a user context or group membership).
    deps.exec('docker', ['-H', DOCKER_SOCKET, 'info', '--format', '{{json .}}'], STRIP_DOCKER_ENV),
    deps.exec('nvidia-ctk', ['--version']),
    deps.exec('nvidia-ctk', ['cdi', 'list']),
    // `${Version}` (round 3, ruling 5) feeds `detectEngineVersion`; install-method detection itself
    // only ever reads the first two columns (`installedDpkgPackages`).
    deps.exec('dpkg-query', [
      '-W',
      '-f',
      '${db:Status-Abbrev} ${Package} ${Version}\n',
      'docker-ce',
      'docker.io',
      'moby-engine',
      'podman-docker',
      'docker-desktop',
    ]),
    deps.exec('rpm', ['-q', 'docker-ce', 'docker.io', 'moby-engine', 'podman-docker', 'docker-desktop']),
    // Read-only query; Arch's own `docker` package is not one `dpkg-query`/`rpm -q` ever see, and
    // this is also `engine_version`'s only source there (round 3, item 1/ruling 5). `docker-desktop`
    // is Docker Desktop's package name on Arch (round 4, item E).
    // Only on a pacman-family distribution: elsewhere a `pacman` on PATH can be something unrelated
    // entirely (Debian's /usr/games/pacman), and there is no Arch package to ask about (round 5, item 3).
    distribution?.family === 'pacman'
      ? deps.exec('pacman', ['-Q', ...PACMAN_PACKAGE_CANDIDATES])
      : Promise.resolve(null),
    deps.exec('snap', ['list', 'docker']),
    deps.pathExists('/run/ostree-booted').catch(() => false),
    deps.pathExists('/run/systemd/system').catch((): 'unknown' => 'unknown'),
    deps.exec('id', ['-nG']),
    deps.exec('getent', ['group', 'docker']),
    deps.exec('systemctl', ['is-active', 'docker']),
    readDaemonJson(deps.readFile),
  ])

  if (unameM.code !== 0) unknown.push('architecture')
  const architecture = unameM.code === 0 ? normalizeArchitecture(unameM.stdout) : null

  const nvidia = parseNvidiaSmi(smi)
  if (smi.code === null) unknown.push('nvidia-driver')

  const cli = dockerVersion.code === 0
  const info = parseDockerInfo(cli ? dockerInfo : null, cdiList)
  const serviceActiveParsed = parseServiceActive(serviceActive)

  const rootlessSocketPresent =
    options.xdgRuntimeDir !== null &&
    (await deps.pathExists(`${options.xdgRuntimeDir}/docker.sock`).catch(() => false))
  const installMethod = detectDockerInstallMethod(
    info,
    { dockerVersion, dpkgQuery, rpmQuery, pacmanQuery, snapList },
    rootlessSocketPresent,
    serviceActiveParsed
  )
  const engineVersion = detectEngineVersion(dpkgQuery, rpmQuery, pacmanQuery)

  const daemonJsonEvidence = daemonJsonNvidiaRuntimeEvidence(daemonJsonRead)
  const cdiEnabled = cdiEnabledByDefault(engineVersion, daemonJsonFeaturesCdi(daemonJsonRead))
  const gpuRuntimeFromConfig =
    daemonJsonEvidence === 'configured' || (cdiEnabled && cdiListsNvidiaGpu(cdiList))

  // Before anything is installed there is no DockerRootDir yet; check the nearest ancestor that
  // does exist instead of failing outright on a path that is not there yet (item 7).
  const diskCheckTarget = info.docker_root_dir ?? '/var/lib/docker'
  const diskCheckPath = await nearestExistingAncestor(deps.pathExists, diskCheckTarget)
  const disk = await deps.freeDiskBytes(diskCheckPath).catch(() => null)
  if (disk === null) unknown.push('free-disk')

  return {
    architecture,
    distribution,
    immutable_os: immutableOs,
    systemd,
    driver_version: nvidia.driver_version,
    gpus: nvidia.gpus,
    docker: {
      cli,
      daemon_reachable: info.daemon_reachable,
      engine_identity: info.engine_identity,
      version: info.version,
      install_method: installMethod,
      engine_version: engineVersion,
      gpu_runtime: info.gpu_runtime,
      gpu_runtime_from_config: gpuRuntimeFromConfig,
      daemon_json_unreadable: daemonJsonEvidence === 'unreadable',
      selinux: info.selinux,
      docker_root_dir: info.docker_root_dir,
      containers_running: info.containers_running,
      service_active: serviceActiveParsed,
      server_errors: info.server_errors,
    },
    docker_group: parseDockerGroup(sessionGroups, groupEntry, options.user),
    toolkit_installed: ctk.code === 0,
    free_disk_bytes: disk,
    unknown,
  }
}
