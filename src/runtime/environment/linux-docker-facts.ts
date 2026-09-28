/**
 * What `docker info` and the distribution's package database say about this machine's Docker
 * install, read without running or changing anything.
 *
 * `docker info` alone cannot say *how* Docker got here: a `docker-ce` package and a `moby-engine`
 * package expose the same daemon shape over the same socket. That distinction matters because the
 * install plan must never lay `docker-ce` over a `moby-engine` or `docker.io` install (design D2:
 * they conflict at the package-manager level) and must never touch a snap, rootless, Docker
 * Desktop or Podman-shim install at all. So install-method detection also reads the package
 * database (`dpkg-query`/`rpm -q`, both read-only queries) and `docker --version`'s own banner,
 * which is all `podman-docker`'s `docker` shim actually prints differently.
 *
 * `docker info`'s own exit code cannot be trusted either: the CLI shipped in docker-ce/docker.io/
 * moby-engine through roughly 28.2 (which is what Debian, Ubuntu and Fedora's recipe-qualified
 * releases carry) still exits `0` and prints a fully-formed JSON document when the daemon call
 * itself failed — `ServerErrors` holds the real error and every other field is the Go zero value
 * (`""`/`0`/`null`). 28.3 and later exit non-zero instead. `parseDockerInfo` treats the former the
 * same as the latter (task 2.4 fix round 2, item 1) — the alternative, trusting `code === 0`, was
 * reading a `docker.io`/`moby-engine` host that plainly refused a connection as reachable, which
 * broke both relogin detection and runtime-config planning downstream.
 *
 * The installed *engine version* (round 3, ruling 5) is a separate signal from any of the above: it
 * comes from the package database alone (`dpkg-query`'s `${Version}` field, `rpm -q`'s own
 * name-version-release string, or `pacman -Q docker`), so it is available even when the daemon
 * cannot be reached at all — which is exactly when it is needed, to decide whether CDI is on by
 * Docker's own default (28.2+) without daemon.json saying so explicitly.
 */

import type { CommandOutput } from './linux-probe.js'
import type { LinuxDockerInstallMethod } from '../../contracts/index.js'

/**
 * Parsed `docker info --format '{{json .}}'`, plus the signals `docker info` alone cannot settle
 * (`rootless`, `desktop`) that feed into {@link detectDockerInstallMethod}.
 */
export interface DockerInfoFacts {
  daemon_reachable: boolean
  engine_identity: string | null
  version: string | null
  /** A runtime named `nvidia`, or an NVIDIA CDI spec: either can carry `--gpus`. */
  gpu_runtime: boolean
  /**
   * `SecurityOptions` names `selinux`. Docker is enforcing for containers, so a mount of our own
   * directories (model, engine cache, entrypoint, heartbeat) needs the shared `:z` label — never
   * `:Z`, which would take exclusive ownership and break the next container of the same model
   * (design D15).
   */
  selinux: boolean
  docker_root_dir: string | null
  containers_running: number
  /** `SecurityOptions` names `rootless` on the daemon that actually answered this query. */
  rootless: boolean
  /** `Name`/`OperatingSystem` names Docker Desktop. */
  desktop: boolean
  /**
   * `ServerErrors`: partial failures (a plugin, a storage-driver problem) the daemon reports even
   * though `info` itself returned successfully. Surfaced for diagnostics; a populated payload next
   * to a real `ServerVersion` is still read as reachable — only an *empty* payload (round 2, item 1)
   * is read as a failed call.
   */
  server_errors: string[]
}

const ABSENT: DockerInfoFacts = {
  daemon_reachable: false,
  engine_identity: null,
  version: null,
  gpu_runtime: false,
  selinux: false,
  docker_root_dir: null,
  containers_running: 0,
  rootless: false,
  desktop: false,
  server_errors: [],
}

/** `nvidia-ctk cdi list`: read-only, and the only way this probe confirms an NVIDIA CDI device actually exists. */
export function cdiListsNvidiaGpu(cdiList: CommandOutput | null): boolean {
  return cdiList !== null && cdiList.code === 0 && /nvidia\.com\/gpu/i.test(cdiList.stdout)
}

/**
 * Whether `/etc/docker/daemon.json`'s own `runtimes` map names `nvidia` — read-only evidence the
 * GPU runtime is configured that does not require the daemon to answer at all, used when the system
 * socket could not be reached (item 3: never plan a runtime reconfigure without real evidence).
 *
 * Three-way rather than boolean (round 2, item 6): a file that does not exist yet is a real fact
 * ("not configured"), but one that exists and fails to parse is not — planning `nvidia-ctk runtime
 * configure` against a daemon.json this probe cannot even read risks corrupting it further, so that
 * case is surfaced separately as `'unreadable'` and `assessLinux` blocks instead of guessing.
 *
 * `read` distinguishes the file genuinely not existing (`{ text: null, unreadable: false }`, e.g.
 * `readFile` resolving `null` for `ENOENT`) from a real read failure such as `EACCES` on a `0600`
 * file (`{ text: null, unreadable: true }`, e.g. `readFile` rejecting) — round 3, item 2: a caller
 * that collapsed both into `null` would read "permission denied" as "nothing configured yet" and
 * plan a runtime reconfigure against a file it was never able to look at in the first place.
 */
export type DaemonJsonEvidence = 'configured' | 'not-configured' | 'unreadable'

export function daemonJsonNvidiaRuntimeEvidence(read: {
  text: string | null
  unreadable: boolean
}): DaemonJsonEvidence {
  if (read.unreadable) return 'unreadable'
  if (read.text === null) return 'not-configured'
  try {
    const parsed = JSON.parse(read.text) as { runtimes?: Record<string, unknown> }
    return Object.keys(parsed.runtimes ?? {}).includes('nvidia') ? 'configured' : 'not-configured'
  } catch {
    return 'unreadable'
  }
}

/**
 * `/etc/docker/daemon.json`'s `features.cdi`, three-way: `true`/`false` when the file says so
 * explicitly, `undefined` when it does not (absent, unset, or the file could not be read/parsed at
 * all) — the "unset" case is what lets {@link cdiEnabledByDefault} fall back to Docker's own
 * version-based default instead (round 3, ruling 5).
 */
export function daemonJsonFeaturesCdi(read: {
  text: string | null
  unreadable: boolean
}): boolean | undefined {
  if (read.unreadable || read.text === null) return undefined
  try {
    const parsed = JSON.parse(read.text) as { features?: { cdi?: unknown } }
    const value = parsed.features?.cdi
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

/** First `X.Y.Z` substring, ignoring any epoch prefix (`5:`) or distro suffix (`-1~noble1`, `.fc41`). */
function firstSemverLike(text: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(text)
  return match === null ? null : (match[1] as string)
}

/** Segment-by-segment numeric comparison, duplicated from `linux-plan.ts`'s `compareDottedVersions`
 *  rather than imported, so this module stays independent of the assessment layer that consumes it. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((segment) => Number(segment) || 0)
  const right = b.split('.').map((segment) => Number(segment) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1
  }
  return 0
}

const ENGINE_PACKAGE_NAMES = ['docker-ce', 'docker.io', 'moby-engine']

/** `dpkg-query -W -f '${db:Status-Abbrev} ${Package} ${Version}\n' <candidates>`'s third column, for
 *  whichever recognised engine package is `ii` (installed). */
export function dpkgEngineVersion(output: CommandOutput | null): string | null {
  if (output === null) return null
  for (const raw of output.stdout.split('\n')) {
    const match = /^ii\s+(\S+)\s+(.+)$/.exec(raw.trim())
    if (match === null) continue
    if (!ENGINE_PACKAGE_NAMES.includes(match[1] as string)) continue
    const version = firstSemverLike(match[2] as string)
    if (version !== null) return version
  }
  return null
}

/** `rpm -q <candidates>`'s name-version-release line for whichever recognised engine package hit. */
export function rpmEngineVersion(output: CommandOutput | null): string | null {
  if (output === null) return null
  for (const raw of output.stdout.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.includes('is not installed')) continue
    if (!ENGINE_PACKAGE_NAMES.some((name) => line.startsWith(`${name}-`))) continue
    const version = firstSemverLike(line)
    if (version !== null) return version
  }
  return null
}

/** `pacman -Q docker`: `docker 28.2.0-1\n` on a hit, non-zero exit (or nothing on stdout) otherwise. */
export function pacmanEngineVersion(output: CommandOutput | null): string | null {
  if (output === null || output.code !== 0) return null
  const match = /^docker\s+(\S+)/m.exec(output.stdout)
  return match === null ? null : firstSemverLike(match[1] as string)
}

/** The first engine version any of the three package managers can confirm, or null (round 3, ruling 5). */
export function detectEngineVersion(
  dpkgQuery: CommandOutput | null,
  rpmQuery: CommandOutput | null,
  pacmanQuery: CommandOutput | null
): string | null {
  return dpkgEngineVersion(dpkgQuery) ?? rpmEngineVersion(rpmQuery) ?? pacmanEngineVersion(pacmanQuery)
}

const CDI_DEFAULT_SINCE = '28.2.0'

/**
 * Whether CDI counts as enabled: `daemon.json`'s own `features.cdi` when it says so explicitly
 * (`false` always wins, even on a new-enough engine — an explicit opt-out is not overridden by a
 * default); otherwise, Docker Engine 28.2+ turns CDI on by default, so a *known* engine version at
 * or above that counts as enabled on its own. An engine version this probe could not determine keeps
 * requiring the explicit `daemon.json` setting — silence is never read as "recent enough" (round 3,
 * ruling 5).
 */
export function cdiEnabledByDefault(
  engineVersion: string | null,
  explicitFeaturesCdi: boolean | undefined
): boolean {
  if (explicitFeaturesCdi !== undefined) return explicitFeaturesCdi
  if (engineVersion === null) return false
  return compareVersions(engineVersion, CDI_DEFAULT_SINCE) >= 0
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * `docker -H unix:///var/run/docker.sock info --format '{{json .}}'`. The `-H` flag pins the
 * query to the system socket under the current user and overrides both `DOCKER_HOST` and an
 * active `DOCKER_CONTEXT`, so this reads the same daemon a `docker` group member would reach —
 * never a user's own rootless daemon or a context pointed elsewhere (spec: "Доступ к Docker MUST
 * определяться фактическим вызовом daemon по системному сокету... а не пользовательским Docker
 * context").
 *
 * `cdiList` is {@link cdiListsNvidiaGpu}'s source command.
 */
export function parseDockerInfo(
  output: CommandOutput | null,
  cdiList: CommandOutput | null
): DockerInfoFacts {
  if (output === null || output.code !== 0) return ABSENT
  try {
    const info = JSON.parse(output.stdout) as {
      ID?: unknown
      ServerVersion?: unknown
      Runtimes?: Record<string, unknown>
      CDISpecDirs?: unknown[]
      SecurityOptions?: unknown[]
      DockerRootDir?: unknown
      ContainersRunning?: unknown
      Name?: unknown
      OperatingSystem?: unknown
      ServerErrors?: unknown[]
    }
    const serverErrors = Array.isArray(info.ServerErrors)
      ? info.ServerErrors.filter((entry): entry is string => typeof entry === 'string')
      : []
    const serverVersion = isNonEmptyString(info.ServerVersion) ? info.ServerVersion : null

    // docker CLI ≤28.2 (docker.io, moby-engine, and older docker-ce — all on the recipe list) exits
    // 0 and prints a fully-templated JSON document even when Info() itself failed: ServerErrors
    // carries the real error, and every other field is the Go zero value. That is a failed call,
    // not a reachable daemon with an empty version string (round 2, item 1).
    if (serverErrors.length > 0 && serverVersion === null) {
      return { ...ABSENT, server_errors: serverErrors }
    }

    const runtimes = Object.keys(info.Runtimes ?? {})
    const specDirs = Array.isArray(info.CDISpecDirs) ? info.CDISpecDirs : []
    const hasCdiGpu = specDirs.length > 0 && cdiListsNvidiaGpu(cdiList)
    const securityOptions = Array.isArray(info.SecurityOptions)
      ? info.SecurityOptions.filter((entry): entry is string => typeof entry === 'string')
      : []
    const nameAndOs = `${typeof info.Name === 'string' ? info.Name : ''} ${
      typeof info.OperatingSystem === 'string' ? info.OperatingSystem : ''
    }`.toLowerCase()
    return {
      daemon_reachable: true,
      engine_identity: isNonEmptyString(info.ID) ? info.ID : null,
      version: serverVersion,
      gpu_runtime: runtimes.includes('nvidia') || hasCdiGpu,
      selinux: securityOptions.some(
        (option) => option === 'name=selinux' || option.startsWith('name=selinux')
      ),
      // An empty string is not a path (round 2, item 1): a probe that read '' and fell back to it
      // literally, instead of to the default install location, would check free space at "".
      docker_root_dir: isNonEmptyString(info.DockerRootDir) ? info.DockerRootDir : null,
      containers_running: typeof info.ContainersRunning === 'number' ? info.ContainersRunning : 0,
      rootless: securityOptions.some((option) => option === 'rootless' || option.startsWith('name=rootless')),
      desktop: /docker[ -]desktop/.test(nameAndOs),
      server_errors: serverErrors,
    }
  } catch {
    return ABSENT
  }
}

/**
 * `dpkg-query -W -f '${db:Status-Abbrev} ${Package} ${Version}\n' <candidates>`: one line per
 * package dpkg has ever heard of, prefixed with its status (`ii` installed, `rc` removed with
 * config left behind, `un` unknown/never installed, ...). Only `ii` counts as actually installed —
 * `-W` alone (without the status prefix) would also print a `rc` package's name, which is exactly a
 * package that `apt remove` (not `purge`) took out, and treating that as present would leave a
 * stale install undetected. A package dpkg has never heard of at all prints nothing to stdout (and
 * "no packages found matching ..." to stderr instead), which this simply never matches. The
 * trailing `${Version}` column (round 3, ruling 5) is read by {@link dpkgEngineVersion}; this
 * function only ever reads the first two.
 */
export function installedDpkgPackages(output: CommandOutput | null, candidates: string[]): string[] {
  if (output === null) return []
  const installed = new Set<string>()
  for (const raw of output.stdout.split('\n')) {
    const match = /^ii\s+(\S+)/.exec(raw.trim())
    if (match !== null) installed.add(match[1] as string)
  }
  return candidates.filter((name) => installed.has(name))
}

/**
 * `rpm -q <candidates>`: a hit prints the full name-version-release (`docker-ce-3:28.3.0-1.fc41...`)
 * on its own line; a miss prints `package <name> is not installed` (to stdout, with a non-zero exit
 * code this parser does not need to check), which this only has to avoid matching.
 */
export function installedRpmPackages(output: CommandOutput | null, candidates: string[]): string[] {
  if (output === null) return []
  const found: string[] = []
  for (const raw of output.stdout.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.includes('is not installed')) continue
    const match = candidates.find((name) => line === name || line.startsWith(`${name}-`))
    if (match !== undefined && !found.includes(match)) found.push(match)
  }
  return found
}

/** The read-only lookups {@link detectDockerInstallMethod} needs beyond `docker info` itself. */
export interface DockerPackageSignals {
  /** `docker --version`: podman-docker's shim prints Podman's own banner here, not Docker's. */
  dockerVersion: CommandOutput | null
  dpkgQuery: CommandOutput | null
  rpmQuery: CommandOutput | null
  /** `snap list docker`. */
  snapList: CommandOutput | null
}

/** `docker-desktop` is Docker Desktop for Linux's own `.deb`/`.rpm` package name (item 5). */
export const DOCKER_PACKAGE_CANDIDATES = [
  'docker-ce',
  'docker.io',
  'moby-engine',
  'podman-docker',
  'docker-desktop',
]

/**
 * How Docker got onto this machine, or null when none of the signals recognise an install.
 *
 * Order matters: a `podman-docker` shim or a snap package is decided before anything from `docker
 * info` (their `docker` command may not even resolve to a real Engine, so `info`'s own answer is
 * not trusted over the package database for these).
 *
 * Desktop is decided next, but only two ways (round 2, item 4 — the previous order blocked a
 * working Desktop+Engine host that also happened to have the `docker-desktop` package installed
 * alongside a real, reachable `docker-ce`): `info.desktop` when the daemon that actually answered
 * says so directly, or the `docker-desktop` package **only when the system socket did not answer at
 * all and no recognised engine package is also present** — a reachable `docker-ce`/`moby-engine`/
 * `docker.io` always wins over a Desktop package that merely happens to be installed alongside it.
 *
 * `rootlessSocketPresent` (a leftover `$XDG_RUNTIME_DIR/docker.sock`) only counts when the system
 * socket itself did not answer *and* `docker.service` is not active either (round 2, item 8) — a
 * working rootful engine, or one that is simply unreachable for some other reason while the service
 * is confirmed running, takes priority over a stray rootless socket file from an earlier, abandoned
 * setup.
 *
 * Arch and its derivatives are not resolved here at all: `docker` there is Arch's own package, not
 * one of `DOCKER_PACKAGE_CANDIDATES` (there is exactly one common source, nothing to disambiguate
 * against the way Debian/Fedora need) — `assessLinux` (`linux-plan.ts`) special-cases
 * `distribution.family === 'pacman' && docker.cli` in the one place that needs it instead of
 * teaching this distribution-agnostic function about `pacman -Q` (round 3, item 1/ruling 1).
 */
export function detectDockerInstallMethod(
  info: DockerInfoFacts,
  packages: DockerPackageSignals,
  rootlessSocketPresent: boolean,
  serviceActive: boolean | 'unknown'
): LinuxDockerInstallMethod | null {
  if (
    packages.dockerVersion !== null &&
    packages.dockerVersion.code === 0 &&
    /podman/i.test(packages.dockerVersion.stdout)
  ) {
    return 'podman-docker'
  }
  const found = new Set([
    ...installedDpkgPackages(packages.dpkgQuery, DOCKER_PACKAGE_CANDIDATES),
    ...installedRpmPackages(packages.rpmQuery, DOCKER_PACKAGE_CANDIDATES),
  ])
  if (found.has('podman-docker')) return 'podman-docker'
  if (packages.snapList !== null && packages.snapList.code === 0 && /docker/.test(packages.snapList.stdout)) {
    return 'snap'
  }
  const engineInstalled = found.has('docker-ce') || found.has('moby-engine') || found.has('docker.io')
  if (info.desktop) return 'docker-desktop'
  if (found.has('docker-desktop') && !info.daemon_reachable && !engineInstalled) return 'docker-desktop'
  if (info.rootless || (!info.daemon_reachable && rootlessSocketPresent && serviceActive !== true)) {
    return 'rootless'
  }
  if (found.has('docker-ce')) return 'docker-ce'
  if (found.has('moby-engine')) return 'moby-engine'
  if (found.has('docker.io')) return 'docker.io'
  return null
}
