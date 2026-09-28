import { describe, expect, it } from 'vitest'
import {
  normalizeArchitecture,
  parseNvidiaSmi,
  parseOsRelease,
  probeLinux,
  type CommandOutput,
  type LinuxProbeDeps,
} from './linux-probe.js'

const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' })
const missing = (): CommandOutput => ({ code: null, stdout: '', stderr: '' })
const failed = (stderr: string): CommandOutput => ({ code: 1, stdout: '', stderr })

const SMI = 'GPU-1c6a, NVIDIA GeForce RTX 4070, 8.9, 12282, 11000, 551.23\n'
const DOCKER_INFO = JSON.stringify({
  ID: 'X4RT:AAAA',
  ServerVersion: '28.3.0',
  Runtimes: { runc: {}, nvidia: {} },
  CDISpecDirs: [],
  SecurityOptions: ['name=seccomp,profile=default'],
  DockerRootDir: '/var/lib/docker',
  ContainersRunning: 0,
})

describe('reading the machine', () => {
  it('takes the distribution, ID_LIKE and package family from os-release, quotes and all', () => {
    expect(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nNAME="Ubuntu"\n')).toEqual({
      id: 'ubuntu',
      version_id: '24.04',
      id_like: [],
      family: 'apt',
    })
    expect(parseOsRelease("ID='fedora'\nVERSION_ID=41\n")).toEqual({
      id: 'fedora',
      version_id: '41',
      id_like: [],
      family: 'dnf',
    })
    // A derivative distribution qualifies its family through ID_LIKE, not ID.
    expect(parseOsRelease('ID=linuxmint\nVERSION_ID="22"\nID_LIKE="ubuntu debian"\n')).toEqual({
      id: 'linuxmint',
      version_id: '22',
      id_like: ['ubuntu', 'debian'],
      family: 'apt',
    })
    expect(parseOsRelease('ID=arch\nVERSION_ID="rolling"\n')?.family).toBe('pacman')
    expect(parseOsRelease('ID=nixos\nVERSION_ID="24.05"\n')?.family).toBe('other')
    // A file that is there but says nothing useful is no answer at all.
    expect(parseOsRelease('NAME="Something"\n')).toBeNull()
    expect(parseOsRelease(null)).toBeNull()
  })

  it('normalises the one architecture alias uname would not print on Linux itself', () => {
    expect(normalizeArchitecture('x86_64\n')).toBe('x86_64')
    expect(normalizeArchitecture('aarch64\n')).toBe('aarch64')
    expect(normalizeArchitecture('arm64\n')).toBe('aarch64')
    expect(normalizeArchitecture('armv7l\n')).toBe('armv7l')
  })

  it('reads every card nvidia-smi lists, converting its megabytes to bytes', () => {
    const answer = parseNvidiaSmi(ok(SMI + 'GPU-9f, NVIDIA GeForce RTX 5090, 12.0, 32607, 32000, 551.23\n'))
    expect(answer.driver_version).toBe('551.23')
    expect(answer.gpus).toHaveLength(2)
    expect(answer.gpus[0]?.compute_capability).toBe('8.9')
    expect(answer.gpus[0]?.total_vram_bytes).toBe(12_282 * 1024 * 1024)
    expect(answer.gpus[1]?.compute_capability).toBe('12.0')
  })

  it('reports a unified-memory card (GB10/DGX Spark) with null vram instead of a bogus number', () => {
    const answer = parseNvidiaSmi(ok('GPU-gb10, NVIDIA GB10, 12.1, [N/A], [N/A], 580.65.06\n'))
    expect(answer.gpus).toEqual([
      {
        gpu_id: 'GPU-gb10',
        name: 'NVIDIA GB10',
        compute_capability: '12.1',
        total_vram_bytes: null,
        free_vram_bytes: null,
        driver_version: '580.65.06',
      },
    ])
  })

  it('reports no driver rather than an empty one when nvidia-smi is not there', () => {
    expect(parseNvidiaSmi(missing())).toEqual({ driver_version: null, gpus: [] })
    expect(parseNvidiaSmi(failed('NVIDIA-SMI has failed'))).toEqual({ driver_version: null, gpus: [] })
  })

  it('runs only read-only commands and records every answer it could not get', async () => {
    const calls: string[] = []
    const probed = await probeLinux(
      {
        exec: async (command, args) => {
          calls.push([command, ...args].join(' '))
          if (command === 'uname') return ok('x86_64\n')
          if (command === 'nvidia-smi') return ok(SMI)
          if (command === 'docker' && args.includes('--version')) return ok('Docker version 28.3.0')
          if (command === 'docker') return ok(DOCKER_INFO)
          if (command === 'nvidia-ctk' && args[0] === 'cdi') return ok('')
          return missing()
        },
        readFile: async () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
        pathExists: async () => false,
        freeDiskBytes: async () => 200_000_000_000,
      },
      { user: 'u', xdgRuntimeDir: null }
    )

    expect(probed.distribution).toEqual({ id: 'ubuntu', version_id: '24.04', id_like: [], family: 'apt' })
    expect(probed.architecture).toBe('x86_64')
    expect(probed.docker.daemon_reachable).toBe(true)
    // `nvidia-ctk --version` was not found, so the toolkit is reported absent, not assumed.
    expect(probed.toolkit_installed).toBe(false)
    expect(probed.unknown).toEqual([])
    // Nothing that could change the machine: no run, no pull, no install, no service, no systemctl.
    // (The docker socket path legitimately contains "run" as a path segment, so this checks
    // subcommands, not a bare substring match against the whole call.)
    expect(
      calls.some(
        (call) =>
          /(^| )(run|pull|install|systemctl|apt-get|usermod)( |$)/.test(call) || /pacman -S/.test(call)
      )
    ).toBe(false)
  })

  it('records a probe that could not run as unknown instead of as a no', async () => {
    const probed = await probeLinux(
      {
        exec: async () => missing(),
        readFile: async () => null,
        pathExists: async () => false,
        freeDiskBytes: async () => null,
      },
      { user: 'u', xdgRuntimeDir: null }
    )
    expect(probed.unknown).toEqual(['distribution', 'architecture', 'nvidia-driver', 'free-disk'])
  })

  it('checks free space at DockerRootDir once Docker answers, and at the default install path before it does', async () => {
    const customRootDir = JSON.stringify({ ...JSON.parse(DOCKER_INFO), DockerRootDir: '/mnt/docker-data' })
    const paths: string[] = []
    const deps: LinuxProbeDeps = {
      exec: async (command, args) => {
        if (command === 'uname') return ok('x86_64\n')
        if (command === 'docker' && args.includes('--version')) return ok('Docker version 28.3.0')
        if (command === 'docker') return ok(customRootDir)
        return missing()
      },
      readFile: async () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
      pathExists: async () => false,
      freeDiskBytes: async (path) => {
        paths.push(path)
        return 1
      },
    }
    await probeLinux(deps, { user: 'u', xdgRuntimeDir: null })
    expect(paths).toEqual(['/mnt/docker-data'])

    // No Docker at all: nothing to read DockerRootDir from, so the default install path is used.
    paths.length = 0
    await probeLinux({ ...deps, exec: async () => missing() }, { user: 'u', xdgRuntimeDir: null })
    expect(paths).toEqual(['/var/lib/docker'])
  })
})
