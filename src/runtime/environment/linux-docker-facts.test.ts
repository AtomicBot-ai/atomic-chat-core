import { describe, expect, it } from 'vitest'
import {
  DOCKER_PACKAGE_CANDIDATES,
  cdiListsNvidiaGpu,
  daemonJsonHasCdiEnabled,
  daemonJsonNvidiaRuntimeEvidence,
  detectDockerInstallMethod,
  installedDpkgPackages,
  installedRpmPackages,
  parseDockerInfo,
  type DockerInfoFacts,
} from './linux-docker-facts.js'
import type { CommandOutput } from './linux-probe.js'

const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' })
const missing = (): CommandOutput => ({ code: null, stdout: '', stderr: '' })
const failed = (stderr: string): CommandOutput => ({ code: 1, stdout: '', stderr })

const info = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ID: 'X4RT:AAAA',
    ServerVersion: '28.3.0',
    Runtimes: { runc: {} },
    CDISpecDirs: [],
    SecurityOptions: ['name=seccomp,profile=default'],
    DockerRootDir: '/var/lib/docker',
    ContainersRunning: 0,
    ServerErrors: [],
    ...over,
  })

/** The ≤28.2 CLI shape: exit 0, a fully-templated JSON document, real error in ServerErrors. */
const legacyFailure = (message: string): string =>
  JSON.stringify({
    ID: '',
    Containers: 0,
    ContainersRunning: 0,
    Images: 0,
    Driver: '',
    ServerVersion: '',
    OperatingSystem: '',
    Architecture: '',
    Name: '',
    DockerRootDir: '',
    Runtimes: null,
    CDISpecDirs: null,
    SecurityOptions: null,
    ServerErrors: [message],
  })

const NO_INFO: DockerInfoFacts = {
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

describe('parseDockerInfo', () => {
  it('counts the nvidia runtime as a GPU runtime', () => {
    const parsed = parseDockerInfo(ok(info({ Runtimes: { runc: {}, nvidia: {} } })), null)
    expect(parsed.gpu_runtime).toBe(true)
  })

  it('counts CDI only once nvidia-ctk cdi list actually lists an nvidia.com/gpu device', () => {
    const withSpecDir = info({ CDISpecDirs: ['/etc/cdi'] })
    expect(parseDockerInfo(ok(withSpecDir), ok('nvidia.com/gpu=all\n')).gpu_runtime).toBe(true)
    // A spec directory that is configured but empty is not a working runtime.
    expect(parseDockerInfo(ok(withSpecDir), ok('')).gpu_runtime).toBe(false)
    expect(parseDockerInfo(ok(withSpecDir), null).gpu_runtime).toBe(false)
    expect(parseDockerInfo(ok(info({ CDISpecDirs: [] })), ok('nvidia.com/gpu=all\n')).gpu_runtime).toBe(false)
  })

  it('reads SELinux, DockerRootDir and the running-container count', () => {
    const parsed = parseDockerInfo(
      ok(info({ SecurityOptions: ['name=seccomp,profile=default', 'name=selinux'], ContainersRunning: 3 })),
      null
    )
    expect(parsed.selinux).toBe(true)
    expect(parsed.docker_root_dir).toBe('/var/lib/docker')
    expect(parsed.containers_running).toBe(3)
  })

  it('flags rootless from SecurityOptions and Desktop from Name/OperatingSystem', () => {
    expect(parseDockerInfo(ok(info({ SecurityOptions: ['rootless'] })), null).rootless).toBe(true)
    expect(parseDockerInfo(ok(info({ Name: 'docker-desktop' })), null).desktop).toBe(true)
    expect(parseDockerInfo(ok(info({ OperatingSystem: 'Docker Desktop' })), null).desktop).toBe(true)
    expect(parseDockerInfo(ok(info()), null).rootless).toBe(false)
    expect(parseDockerInfo(ok(info()), null).desktop).toBe(false)
  })

  it('surfaces ServerErrors for diagnostics next to a real ServerVersion without treating them as unreachable', () => {
    const parsed = parseDockerInfo(ok(info({ ServerErrors: ['devmapper: Failed to remove device'] })), null)
    expect(parsed.daemon_reachable).toBe(true)
    expect(parsed.server_errors).toEqual(['devmapper: Failed to remove device'])
    expect(parseDockerInfo(ok(info()), null).server_errors).toEqual([])
  })

  it('reads a docker CLI ≤28.2 failed call (exit 0, empty ServerVersion, populated ServerErrors) as unreachable (round 2, item 1)', () => {
    const message =
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'
    const parsed = parseDockerInfo(ok(legacyFailure(message)), null)
    expect(parsed).toEqual({ ...NO_INFO, server_errors: [message] })
  })

  it('reads a docker CLI ≥28.3 failed call (non-zero exit) as unreachable, unchanged', () => {
    expect(
      parseDockerInfo(failed('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'), null)
    ).toEqual(NO_INFO)
  })

  it('treats an empty DockerRootDir as no answer, not as the path "" (round 2, item 1)', () => {
    expect(parseDockerInfo(ok(info({ DockerRootDir: '' })), null).docker_root_dir).toBeNull()
  })

  it('reports nothing reachable when the daemon does not answer or answers garbage', () => {
    expect(parseDockerInfo(failed('Cannot connect to the Docker daemon'), null)).toEqual(NO_INFO)
    expect(parseDockerInfo(ok('not json'), null)).toEqual(NO_INFO)
    expect(parseDockerInfo(missing(), null)).toEqual(NO_INFO)
    expect(parseDockerInfo(null, null)).toEqual(NO_INFO)
  })
})

describe('offline GPU-runtime evidence (item 3)', () => {
  it('reads /etc/docker/daemon.json for a configured nvidia runtime, three ways (round 2, item 6)', () => {
    expect(
      daemonJsonNvidiaRuntimeEvidence(
        JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } })
      )
    ).toBe('configured')
    expect(daemonJsonNvidiaRuntimeEvidence(JSON.stringify({ runtimes: { runc: {} } }))).toBe('not-configured')
    // No file at all is a real fact: nothing is configured yet.
    expect(daemonJsonNvidiaRuntimeEvidence(null)).toBe('not-configured')
    // A file that exists but will not parse is not the same as one that says "no": this probe does
    // not know, and must not guess.
    expect(daemonJsonNvidiaRuntimeEvidence('not json')).toBe('unreadable')
  })

  it('reads features.cdi from daemon.json as the offline mirror of the live CDISpecDirs check (item 7)', () => {
    expect(daemonJsonHasCdiEnabled(JSON.stringify({ features: { cdi: true } }))).toBe(true)
    expect(daemonJsonHasCdiEnabled(JSON.stringify({ features: { cdi: false } }))).toBe(false)
    expect(daemonJsonHasCdiEnabled(JSON.stringify({}))).toBe(false)
    expect(daemonJsonHasCdiEnabled(null)).toBe(false)
    expect(daemonJsonHasCdiEnabled('not json')).toBe(false)
  })

  it('reads nvidia-ctk cdi list the same way parseDockerInfo does', () => {
    expect(cdiListsNvidiaGpu(ok('nvidia.com/gpu=all\n'))).toBe(true)
    expect(cdiListsNvidiaGpu(ok('INFO[0000] Found 0 CDI devices\n'))).toBe(false)
    expect(cdiListsNvidiaGpu(null)).toBe(false)
    expect(cdiListsNvidiaGpu(failed('not found'))).toBe(false)
  })
})

const PACKAGES_NONE = {
  dockerVersion: missing(),
  dpkgQuery: missing(),
  rpmQuery: missing(),
  snapList: missing(),
}

describe('package-database install-method detection', () => {
  it('reads only packages dpkg-query\'s status column marks "ii" (installed) as installed (item 4)', () => {
    expect(installedDpkgPackages(ok('ii  docker-ce\n'), DOCKER_PACKAGE_CANDIDATES)).toEqual(['docker-ce'])
    expect(installedDpkgPackages(missing(), DOCKER_PACKAGE_CANDIDATES)).toEqual([])
    expect(installedDpkgPackages(ok(''), DOCKER_PACKAGE_CANDIDATES)).toEqual([])
  })

  it('does not count a package apt remove left in "rc" (config files remain) as installed (item 4)', () => {
    const output = ok(
      'rc  docker.io\nun  docker-ce\nun  moby-engine\nun  podman-docker\nun  docker-desktop\n'
    )
    expect(installedDpkgPackages(output, DOCKER_PACKAGE_CANDIDATES)).toEqual([])
  })

  it('reads rpm -q hits by their name-version-release line and ignores "is not installed" misses', () => {
    const output = ok(
      [
        'docker-ce-3:28.3.0-1.fc41.x86_64',
        'package docker.io is not installed',
        'package moby-engine is not installed',
        'podman-docker-5.2.2-1.fc41.noarch',
      ].join('\n')
    )
    expect(installedRpmPackages(output, DOCKER_PACKAGE_CANDIDATES)).toEqual(['docker-ce', 'podman-docker'])
    expect(installedRpmPackages(missing(), DOCKER_PACKAGE_CANDIDATES)).toEqual([])
  })

  it('recognises the podman-docker shim from docker --version before trusting anything else', () => {
    const method = detectDockerInstallMethod(
      NO_INFO,
      {
        dockerVersion: ok('podman version 5.2.2'),
        dpkgQuery: null,
        rpmQuery: ok('docker-ce-3:28.3.0-1.fc41.x86_64'),
        snapList: null,
      },
      false,
      'unknown'
    )
    expect(method).toBe('podman-docker')
  })

  it('recognises snap ahead of a plain package match', () => {
    const packages = { ...PACKAGES_NONE, dockerVersion: ok('Docker version 28.3.0') }
    expect(
      detectDockerInstallMethod(
        NO_INFO,
        { ...packages, snapList: ok('docker  28.3.0  stable  canonical') },
        false,
        'unknown'
      )
    ).toBe('snap')
  })

  it('reads Desktop from docker info directly, regardless of anything else (item 4)', () => {
    const packages = { ...PACKAGES_NONE, dockerVersion: ok('Docker version 28.3.0') }
    expect(detectDockerInstallMethod({ ...NO_INFO, desktop: true }, packages, false, 'unknown')).toBe(
      'docker-desktop'
    )
  })

  it('reads Desktop from the package database only when the system socket did not answer and no engine package is also installed (round 2, item 4)', () => {
    const packages = {
      dockerVersion: ok('Docker version 28.3.0'),
      dpkgQuery: ok('ii  docker-desktop\n'),
      rpmQuery: null,
      snapList: null,
    }
    // Unreachable, and nothing else installed: Desktop is the only explanation.
    expect(detectDockerInstallMethod(NO_INFO, packages, false, 'unknown')).toBe('docker-desktop')
    // The system socket answered a real, working docker-ce — the leftover Desktop package must not
    // shadow it (this was the round-2 bug: Desktop + working rootful docker-ce got blocked).
    const reachableDockerCe: DockerInfoFacts = { ...NO_INFO, daemon_reachable: true }
    const bothPackages = { ...packages, dpkgQuery: ok('ii  docker-desktop\nii  docker-ce\n') }
    expect(detectDockerInstallMethod(reachableDockerCe, bothPackages, false, 'unknown')).toBe('docker-ce')
    // Unreachable, but docker-ce is *also* installed (ambiguous): trust the recognised engine package.
    expect(detectDockerInstallMethod(NO_INFO, bothPackages, false, 'unknown')).toBe('docker-ce')
  })

  it('reads rootless from SecurityOptions on the daemon that actually answered', () => {
    const packages = { ...PACKAGES_NONE, dockerVersion: ok('Docker version 28.3.0') }
    expect(detectDockerInstallMethod({ ...NO_INFO, rootless: true }, packages, false, 'unknown')).toBe(
      'rootless'
    )
  })

  it('reads a leftover rootless socket as rootless only when the system socket is unreachable and the service is not active (round 2, item 8)', () => {
    const packages = { ...PACKAGES_NONE, dockerVersion: ok('Docker version 28.3.0') }
    // The system socket never reached a rootless daemon, its own leftover socket exists, and
    // nothing else (docker.service) explains the machine: rootless.
    expect(detectDockerInstallMethod(NO_INFO, packages, true, false)).toBe('rootless')
    expect(detectDockerInstallMethod(NO_INFO, packages, true, 'unknown')).toBe('rootless')
    // docker.service is confirmed active: a real rootful engine explains the unreachable socket
    // (e.g. the ≤28.2 false-success bug, or a permission issue) better than a stray socket file.
    expect(detectDockerInstallMethod(NO_INFO, packages, true, true)).toBeNull()
  })

  it('never reads a stray rootless socket as rootless once the system socket answers a working engine (item 6)', () => {
    const reachable: DockerInfoFacts = { ...NO_INFO, daemon_reachable: true, rootless: false }
    const packages = { ...PACKAGES_NONE, dockerVersion: ok('Docker version 28.3.0') }
    expect(detectDockerInstallMethod(reachable, packages, true, 'unknown')).not.toBe('rootless')
  })

  it('falls back to the distro package that is actually installed, in docker-ce/moby-engine/docker.io order', () => {
    const base = { dockerVersion: ok('Docker version 28.3.0'), snapList: null }
    expect(
      detectDockerInstallMethod(
        NO_INFO,
        { ...base, dpkgQuery: ok('ii  docker-ce\nii  moby-engine\n'), rpmQuery: null },
        false,
        'unknown'
      )
    ).toBe('docker-ce')
    expect(
      detectDockerInstallMethod(
        NO_INFO,
        { ...base, dpkgQuery: ok('ii  moby-engine\n'), rpmQuery: null },
        false,
        'unknown'
      )
    ).toBe('moby-engine')
    expect(
      detectDockerInstallMethod(
        NO_INFO,
        { ...base, dpkgQuery: ok('ii  docker.io\n'), rpmQuery: null },
        false,
        'unknown'
      )
    ).toBe('docker.io')
  })

  it('answers null when nothing recognises an install', () => {
    expect(detectDockerInstallMethod(NO_INFO, PACKAGES_NONE, false, 'unknown')).toBeNull()
  })
})
