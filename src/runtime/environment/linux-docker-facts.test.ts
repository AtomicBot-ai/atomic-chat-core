import { describe, expect, it } from 'vitest'
import {
  DOCKER_PACKAGE_CANDIDATES,
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
    ...over,
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

  it('reports nothing reachable when the daemon does not answer or answers garbage', () => {
    expect(parseDockerInfo(failed('Cannot connect to the Docker daemon'), null)).toEqual(NO_INFO)
    expect(parseDockerInfo(ok('not json'), null)).toEqual(NO_INFO)
    expect(parseDockerInfo(missing(), null)).toEqual(NO_INFO)
    expect(parseDockerInfo(null, null)).toEqual(NO_INFO)
  })
})

describe('package-database install-method detection', () => {
  it('reads only the packages dpkg-query actually confirms as installed', () => {
    expect(installedDpkgPackages(ok('docker-ce\n'), DOCKER_PACKAGE_CANDIDATES)).toEqual(['docker-ce'])
    expect(installedDpkgPackages(missing(), DOCKER_PACKAGE_CANDIDATES)).toEqual([])
    expect(installedDpkgPackages(ok(''), DOCKER_PACKAGE_CANDIDATES)).toEqual([])
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
      false
    )
    expect(method).toBe('podman-docker')
  })

  it('recognises snap, rootless and Docker Desktop ahead of a plain package match', () => {
    const packages = {
      dockerVersion: ok('Docker version 28.3.0'),
      dpkgQuery: null,
      rpmQuery: null,
      snapList: null,
    }
    expect(
      detectDockerInstallMethod(
        NO_INFO,
        { ...packages, snapList: ok('docker  28.3.0  stable  canonical') },
        false
      )
    ).toBe('snap')
    expect(detectDockerInstallMethod({ ...NO_INFO, rootless: true }, packages, false)).toBe('rootless')
    // The system-socket query never reached a rootless daemon, but its own socket exists.
    expect(detectDockerInstallMethod(NO_INFO, packages, true)).toBe('rootless')
    expect(detectDockerInstallMethod({ ...NO_INFO, desktop: true }, packages, false)).toBe('docker-desktop')
  })

  it('falls back to the distro package that is actually installed, in docker-ce/moby-engine/docker.io order', () => {
    const base = { dockerVersion: ok('Docker version 28.3.0'), snapList: null }
    expect(
      detectDockerInstallMethod(
        NO_INFO,
        { ...base, dpkgQuery: ok('docker-ce\nmoby-engine\n'), rpmQuery: null },
        false
      )
    ).toBe('docker-ce')
    expect(
      detectDockerInstallMethod(NO_INFO, { ...base, dpkgQuery: ok('moby-engine\n'), rpmQuery: null }, false)
    ).toBe('moby-engine')
    expect(
      detectDockerInstallMethod(NO_INFO, { ...base, dpkgQuery: ok('docker.io\n'), rpmQuery: null }, false)
    ).toBe('docker.io')
  })

  it('answers null when nothing recognises an install', () => {
    const packages = {
      dockerVersion: missing(),
      dpkgQuery: missing(),
      rpmQuery: missing(),
      snapList: missing(),
    }
    expect(detectDockerInstallMethod(NO_INFO, packages, false)).toBeNull()
  })
})
