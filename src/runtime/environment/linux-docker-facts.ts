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
 */

import type { CommandOutput } from './linux-probe.js'
import type { LinuxDockerInstallMethod } from '../../contracts/index.js'

/**
 * Parsed `docker info --format '{{json .}}'`, plus the two signals `docker info` alone cannot
 * settle (`rootless`, `desktop`) that feed into {@link detectDockerInstallMethod}.
 */
export interface DockerInfoFacts {
  daemon_reachable: boolean
  engine_identity: string | null
  version: string | null
  /** A runtime named `nvidia`, or an NVIDIA CDI spec: either can carry `--gpus`. */
  gpu_runtime: boolean
  /** `SecurityOptions` names `selinux`: containers need the `:z`/`:Z` mount label (design D15). */
  selinux: boolean
  docker_root_dir: string | null
  containers_running: number
  /** `SecurityOptions` names `rootless`. */
  rootless: boolean
  /** `Name`/`OperatingSystem` names Docker Desktop. */
  desktop: boolean
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
}

/**
 * `docker -H unix:///var/run/docker.sock info --format '{{json .}}'`. The `-H` flag pins the
 * query to the system socket under the current user and overrides both `DOCKER_HOST` and an
 * active `DOCKER_CONTEXT`, so this reads the same daemon a `docker` group member would reach —
 * never a user's own rootless daemon or a context pointed elsewhere (spec: "Доступ к Docker MUST
 * определяться фактическим вызовом daemon по системному сокету... а не пользовательским Docker
 * context").
 *
 * `cdiList` is `nvidia-ctk cdi list`: read-only, and the only way this probe confirms an NVIDIA
 * CDI device actually exists rather than just an empty spec directory.
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
    }
    const runtimes = Object.keys(info.Runtimes ?? {})
    const specDirs = Array.isArray(info.CDISpecDirs) ? info.CDISpecDirs : []
    const hasCdiGpu =
      specDirs.length > 0 &&
      cdiList !== null &&
      cdiList.code === 0 &&
      /nvidia\.com\/gpu/i.test(cdiList.stdout)
    const securityOptions = Array.isArray(info.SecurityOptions)
      ? info.SecurityOptions.filter((entry): entry is string => typeof entry === 'string')
      : []
    const nameAndOs = `${typeof info.Name === 'string' ? info.Name : ''} ${
      typeof info.OperatingSystem === 'string' ? info.OperatingSystem : ''
    }`.toLowerCase()
    return {
      daemon_reachable: true,
      engine_identity: typeof info.ID === 'string' ? info.ID : null,
      version: typeof info.ServerVersion === 'string' ? info.ServerVersion : null,
      gpu_runtime: runtimes.includes('nvidia') || hasCdiGpu,
      selinux: securityOptions.some(
        (option) => option === 'name=selinux' || option.startsWith('name=selinux')
      ),
      docker_root_dir: typeof info.DockerRootDir === 'string' ? info.DockerRootDir : null,
      containers_running: typeof info.ContainersRunning === 'number' ? info.ContainersRunning : 0,
      rootless: securityOptions.some((option) => option === 'rootless' || option.startsWith('name=rootless')),
      desktop: /docker[ -]desktop/.test(nameAndOs),
    }
  } catch {
    return ABSENT
  }
}

/** `dpkg-query -W -f '${Package}\n' <candidates>`: one line per package that is actually installed. */
export function installedDpkgPackages(output: CommandOutput | null, candidates: string[]): string[] {
  if (output === null) return []
  const lines = new Set(
    output.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  )
  return candidates.filter((name) => lines.has(name))
}

/**
 * `rpm -q <candidates>`: a hit prints the full name-version-release (`docker-ce-3:28.3.0-1.fc41...`)
 * on its own line; a miss prints `package <name> is not installed`, which this only has to avoid
 * matching.
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

export const DOCKER_PACKAGE_CANDIDATES = ['docker-ce', 'docker.io', 'moby-engine', 'podman-docker']

/**
 * How Docker got onto this machine, or null when none of the signals recognise an install.
 *
 * Order matters: a `podman-docker` shim or a snap package is decided before anything from `docker
 * info` (their `docker` command may not even resolve to a real Engine, so `info`'s own answer is
 * not trusted over the package database for these); rootless and Desktop come next because
 * `docker-ce`/`moby-engine`/`docker.io` packages can be present on a machine that also runs one of
 * those without actually being what answered the socket; the plain distro packages are last.
 */
export function detectDockerInstallMethod(
  info: DockerInfoFacts,
  packages: DockerPackageSignals,
  rootlessSocketPresent: boolean
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
  if (info.rootless || rootlessSocketPresent) return 'rootless'
  if (info.desktop) return 'docker-desktop'
  if (found.has('docker-ce')) return 'docker-ce'
  if (found.has('moby-engine')) return 'moby-engine'
  if (found.has('docker.io')) return 'docker.io'
  return null
}
