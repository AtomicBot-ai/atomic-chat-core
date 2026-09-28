import { describe, expect, it } from 'vitest'
import {
  nearestExistingAncestor,
  normalizeArchitecture,
  parseDockerGroup,
  parseNvidiaSmi,
  parseOsRelease,
  parseServiceActive,
  probeLinux,
  type CommandOutput,
  type LinuxProbeDeps,
} from './linux-probe.js'
import { DAEMON_DOWN_28_3, UNREACHABLE_28_3 } from '../../../test/helpers/linux-probe-fixtures.js'

const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' })
const missing = (): CommandOutput => ({ code: null, stdout: '', stderr: '' })
const failed = (stderr: string, code = 1): CommandOutput => ({ code, stdout: '', stderr })

const SMI = 'GPU-1c6a, NVIDIA GeForce RTX 4070, 8.9, 12282, 11000, 590.44.01\n'
const DOCKER_INFO = JSON.stringify({
  ID: 'X4RT:AAAA',
  ServerVersion: '28.3.0',
  Runtimes: { runc: {}, nvidia: {} },
  CDISpecDirs: [],
  SecurityOptions: ['name=seccomp,profile=default'],
  DockerRootDir: '/var/lib/docker',
  ContainersRunning: 0,
  ServerErrors: [],
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
    // A file that is there but says nothing useful is no answer at all.
    expect(parseOsRelease('NAME="Something"\n')).toBeNull()
    expect(parseOsRelease(null)).toBeNull()
  })

  it('falls back to BUILD_ID, then to "", when there is no VERSION_ID (item 1: real Arch/Debian sid)', () => {
    // Verbatim shape of Arch's own /etc/os-release: no VERSION_ID at all.
    expect(parseOsRelease('NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n')).toEqual({
      id: 'arch',
      version_id: 'rolling',
      id_like: [],
      family: 'pacman',
    })
    // Neither VERSION_ID nor BUILD_ID: distribution is still read, just matches no recipe.
    expect(parseOsRelease('NAME="Debian GNU/Linux"\nID=debian\n')).toEqual({
      id: 'debian',
      version_id: '',
      id_like: [],
      family: 'apt',
    })
  })

  it('normalises the one architecture alias uname would not print on Linux itself', () => {
    expect(normalizeArchitecture('x86_64\n')).toBe('x86_64')
    expect(normalizeArchitecture('aarch64\n')).toBe('aarch64')
    expect(normalizeArchitecture('arm64\n')).toBe('aarch64')
    expect(normalizeArchitecture('armv7l\n')).toBe('armv7l')
  })

  it('reads every card nvidia-smi lists, converting its megabytes to bytes', () => {
    const answer = parseNvidiaSmi(
      ok(SMI + 'GPU-9f, NVIDIA GeForce RTX 5090, 12.0, 32607, 32000, 590.44.01\n')
    )
    expect(answer.driver_version).toBe('590.44.01')
    expect(answer.gpus).toHaveLength(2)
    expect(answer.gpus[0]?.compute_capability).toBe('8.9')
    expect(answer.gpus[0]?.total_vram_bytes).toBe(12_282 * 1024 * 1024)
    expect(answer.gpus[1]?.compute_capability).toBe('12.0')
  })

  it('reports a unified-memory card (GB10/DGX Spark) with null vram instead of a bogus number', () => {
    const answer = parseNvidiaSmi(ok('GPU-gb10, NVIDIA GB10, 12.1, [N/A], [N/A], 590.44.01\n'))
    expect(answer.gpus).toEqual([
      {
        gpu_id: 'GPU-gb10',
        name: 'NVIDIA GB10',
        compute_capability: '12.1',
        total_vram_bytes: null,
        free_vram_bytes: null,
        driver_version: '590.44.01',
      },
    ])
  })

  it('reports no driver rather than an empty one when nvidia-smi is not there', () => {
    expect(parseNvidiaSmi(missing())).toEqual({ driver_version: null, gpus: [] })
    expect(parseNvidiaSmi(failed('NVIDIA-SMI has failed'))).toEqual({ driver_version: null, gpus: [] })
  })

  it('tells a group this session has from one the account merely belongs to (diagnostic only, item 2)', () => {
    expect(parseDockerGroup(ok('u docker sudo'), ok('docker:x:999:u'), 'u')).toEqual({
      configured: true,
      effective: true,
    })
    // Added to the group, but this login predates it: it counts from the next sign-in.
    expect(parseDockerGroup(ok('u sudo'), ok('docker:x:999:u'), 'u')).toEqual({
      configured: true,
      effective: false,
    })
    expect(parseDockerGroup(ok('u sudo'), ok('docker:x:999:'), 'u')).toEqual({
      configured: false,
      effective: false,
    })
  })

  it('reports configured as unknown, never a confident false, when getent itself could not answer (round 2, item 9)', () => {
    expect(parseDockerGroup(ok('u sudo'), missing(), 'u')).toEqual({
      configured: 'unknown',
      effective: false,
    })
    expect(parseDockerGroup(ok('u sudo'), failed('getent: invalid argument', 1), 'u')).toEqual({
      configured: 'unknown',
      effective: false,
    })
    // This session's own groups are a real answer on their own: 'docker' showing there proves
    // membership even without getent confirming it independently.
    expect(parseDockerGroup(ok('u docker sudo'), missing(), 'u')).toEqual({
      configured: true,
      effective: true,
    })
  })

  it('reads getent exit 2 ("no such key") as a definitive false, not unknown (round 3, ruling 7)', () => {
    // The docker group does not exist on this system at all — a real answer, not a failure to read one.
    expect(parseDockerGroup(ok('u sudo'), failed('getent: docker: no such key', 2), 'u')).toEqual({
      configured: false,
      effective: false,
    })
    // A contradictory machine (session already shows it despite getent disagreeing) trusts the
    // session's own, always-real answer.
    expect(parseDockerGroup(ok('u docker sudo'), failed('getent: docker: no such key', 2), 'u')).toEqual({
      configured: true,
      effective: true,
    })
  })

  it('reads systemctl is-active strictly: only a real "active" counts', () => {
    expect(parseServiceActive(ok('active\n'))).toBe(true)
    expect(parseServiceActive(failed('', 3))).toBe(false) // real is-active exit for "inactive"
    expect(parseServiceActive(ok('failed\n'))).toBe(false)
    expect(parseServiceActive(missing())).toBe('unknown') // systemctl itself is not on this machine
    expect(parseServiceActive(null)).toBe('unknown')
  })

  it('walks up to the nearest existing ancestor instead of failing on a path that does not exist yet (item 7)', async () => {
    const missingPaths = new Set(['/var/lib/docker'])
    const pathExists = async (path: string) => !missingPaths.has(path)
    expect(await nearestExistingAncestor(pathExists, '/var/lib/docker')).toBe('/var/lib')
    // Already there: no walking needed.
    expect(await nearestExistingAncestor(async () => true, '/var/lib/docker')).toBe('/var/lib/docker')
    // Nothing exists at all: falls all the way back to root rather than throwing.
    expect(await nearestExistingAncestor(async () => false, '/var/lib/docker')).toBe('/')
  })

  it('runs only read-only commands and records every answer it could not get', async () => {
    const calls: string[] = []
    const probed = await probeLinux(
      {
        exec: async (command, args, env) => {
          calls.push([command, ...args].join(' '))
          if (command === 'docker' && args.includes('info')) {
            // Item 17: the forced system-socket call strips a remote/TLS context explicitly.
            expect(env).toEqual({
              DOCKER_HOST: undefined,
              DOCKER_CONTEXT: undefined,
              DOCKER_TLS_VERIFY: undefined,
              DOCKER_CERT_PATH: undefined,
            })
          }
          if (command === 'uname') return ok('x86_64\n')
          if (command === 'nvidia-smi') return ok(SMI)
          if (command === 'docker' && args.includes('--version')) return ok('Docker version 28.3.0')
          if (command === 'docker') return ok(DOCKER_INFO)
          if (command === 'nvidia-ctk' && args.includes('cdi')) return ok('')
          if (command === 'id') return ok('u docker')
          if (command === 'getent') return ok('docker:x:999:u')
          if (command === 'systemctl') return ok('active\n')
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
    expect(probed.docker_group).toEqual({ configured: true, effective: true })
    expect(probed.docker.service_active).toBe(true)
    // `nvidia-ctk --version` was not found, so the toolkit is reported absent, not assumed.
    expect(probed.toolkit_installed).toBe(false)
    expect(probed.unknown).toEqual([])
    // Nothing that could change the machine: no run, no pull, no install, no service enable/start,
    // no apt/pacman mutation. (The docker socket path legitimately contains "run" as a path
    // segment, so this checks subcommands, not a bare substring match against the whole call.)
    expect(
      calls.some(
        (call) =>
          /(^| )(run|pull|install|apt-get|usermod)( |$)/.test(call) ||
          /systemctl (enable|start|restart)/.test(call) ||
          /pacman -S/.test(call)
      )
    ).toBe(false)
    // systemctl was only ever asked, never told to do anything.
    expect(calls.some((call) => call.startsWith('systemctl') && !call.includes('is-active'))).toBe(false)
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

  it('lands architecture in unknown on a non-zero uname exit, not just a missing binary (item 16)', async () => {
    const probed = await probeLinux(
      {
        exec: async (command) => (command === 'uname' ? failed('uname: unrecognized option', 1) : missing()),
        readFile: async () => null,
        pathExists: async () => false,
        freeDiskBytes: async () => null,
      },
      { user: 'u', xdgRuntimeDir: null }
    )
    expect(probed.architecture).toBeNull()
    expect(probed.unknown).toContain('architecture')
  })

  it('reads a docker CLI ≤28.2 false-success (exit 0, ServerErrors, empty fields) as unreachable end to end (round 2, item 1)', async () => {
    const legacyFailure = JSON.stringify({
      ID: '',
      ServerVersion: '',
      DockerRootDir: '',
      Runtimes: null,
      CDISpecDirs: null,
      SecurityOptions: null,
      ServerErrors: ['permission denied while trying to connect to the Docker daemon socket'],
    })
    const probed = await probeLinux(
      {
        exec: async (command, args) => {
          if (command === 'uname') return ok('x86_64\n')
          if (command === 'docker' && args.includes('--version')) return ok('Docker version 26.1.3')
          if (command === 'docker') return ok(legacyFailure) // exit 0, but a failed call
          return missing()
        },
        readFile: async () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
        pathExists: async () => true,
        freeDiskBytes: async () => 200_000_000_000,
      },
      { user: 'u', xdgRuntimeDir: null }
    )
    expect(probed.docker.daemon_reachable).toBe(false)
    expect(probed.docker.engine_identity).toBeNull()
    expect(probed.docker.docker_root_dir).toBeNull()
    expect(probed.docker.server_errors).toEqual([
      'permission denied while trying to connect to the Docker daemon socket',
    ])
  })

  it('reports gpu_runtime_from_config and daemon_json_unreadable from the offline daemon.json evidence (round 2, items 6/7)', async () => {
    const deps: LinuxProbeDeps = {
      exec: async (command, args) => {
        if (command === 'uname') return ok('x86_64\n')
        if (command === 'docker' && args.includes('--version')) return ok('Docker version 28.3.0')
        if (command === 'docker') return DAEMON_DOWN_28_3
        if (command === 'nvidia-ctk' && args.includes('cdi')) return ok('nvidia.com/gpu=all\n')
        return missing()
      },
      readFile: async (path) => {
        if (path === '/etc/os-release') return 'ID=ubuntu\nVERSION_ID="24.04"\n'
        if (path === '/etc/docker/daemon.json') return '{ not valid json'
        return null
      },
      pathExists: async () => true,
      freeDiskBytes: async () => 200_000_000_000,
    }
    const unreadable = await probeLinux(deps, { user: 'u', xdgRuntimeDir: null })
    expect(unreadable.docker.daemon_json_unreadable).toBe(true)
    expect(unreadable.docker.gpu_runtime_from_config).toBe(false)

    const configured = await probeLinux(
      {
        ...deps,
        readFile: async (path) => {
          if (path === '/etc/os-release') return 'ID=ubuntu\nVERSION_ID="24.04"\n'
          if (path === '/etc/docker/daemon.json') return JSON.stringify({ features: { cdi: true } })
          return null
        },
      },
      { user: 'u', xdgRuntimeDir: null }
    )
    expect(configured.docker.daemon_json_unreadable).toBe(false)
    // features.cdi: true, plus nvidia-ctk cdi list showing a device: counts as configured.
    expect(configured.docker.gpu_runtime_from_config).toBe(true)
  })

  it('reads a daemon.json read error (readFile rejecting, e.g. EACCES) as unreadable, not as absent, and assumes no CDI default behind it (round 3 item 2; round 4 item A)', async () => {
    const deps: LinuxProbeDeps = {
      exec: async (command, args) => {
        if (command === 'uname') return ok('x86_64\n')
        if (command === 'docker' && args.includes('--version')) return ok('Docker version 28.3.0')
        if (command === 'docker') return UNREACHABLE_28_3
        // A 28.2+ engine with a listed CDI device: were daemon.json readable and silent, CDI would
        // count as on by Docker's own default. Unreadable, it may say features.cdi: false, so the
        // default must stay unknown (round 4, item A).
        if (command === 'dpkg-query')
          return { code: 1, stdout: 'ii  docker-ce 5:28.3.0-1~ubuntu.24.04~noble\n', stderr: '' }
        if (command === 'nvidia-ctk' && args.includes('cdi')) return ok('nvidia.com/gpu=all\n')
        return missing()
      },
      readFile: async (path) => {
        if (path === '/etc/os-release') return 'ID=ubuntu\nVERSION_ID="24.04"\n'
        if (path === '/etc/docker/daemon.json') throw new Error('EACCES: permission denied')
        return null
      },
      pathExists: async () => true,
      freeDiskBytes: async () => 200_000_000_000,
    }
    const probed = await probeLinux(deps, { user: 'u', xdgRuntimeDir: null })
    expect(probed.docker.daemon_json_unreadable).toBe(true)
    expect(probed.docker.gpu_runtime_from_config).toBe(false)

    // Contrast: a daemon.json that genuinely does not exist (readFile resolving null) is a real
    // "not configured" fact, not an unreadable one — probeLinux must not conflate the two.
    const absent = await probeLinux(
      {
        ...deps,
        readFile: async (path) => (path === '/etc/os-release' ? 'ID=ubuntu\nVERSION_ID="24.04"\n' : null),
      },
      { user: 'u', xdgRuntimeDir: null }
    )
    expect(absent.docker.daemon_json_unreadable).toBe(false)
    // ...and with no file at all, the 28.2+ default does apply: the listed device counts.
    expect(absent.docker.gpu_runtime_from_config).toBe(true)
  })

  it('reads the installed engine version from whichever package manager answers, end to end (round 3, ruling 5)', async () => {
    const deps: LinuxProbeDeps = {
      exec: async (command, args) => {
        if (command === 'uname') return ok('x86_64\n')
        if (command === 'docker' && args.includes('--version')) return ok('Docker version 28.2.0')
        if (command === 'docker') return DAEMON_DOWN_28_3
        if (command === 'dpkg-query') return ok('ii  docker-ce 5:28.2.0-1~ubuntu.24.04~noble\n')
        return missing()
      },
      readFile: async (path) => (path === '/etc/os-release' ? 'ID=ubuntu\nVERSION_ID="24.04"\n' : null),
      pathExists: async () => true,
      freeDiskBytes: async () => 200_000_000_000,
    }
    const probed = await probeLinux(deps, { user: 'u', xdgRuntimeDir: null })
    expect(probed.docker.engine_version).toBe('28.2.0')
    // 28.2+, daemon.json silent: CDI counts as enabled by Docker's own default, so a listed CDI
    // device is enough evidence, with no explicit features.cdi needed.
  })

  it('checks free space at DockerRootDir once Docker answers, and at the nearest existing ancestor before it does', async () => {
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
      pathExists: async () => true,
      freeDiskBytes: async (path) => {
        paths.push(path)
        return 1
      },
    }
    await probeLinux(deps, { user: 'u', xdgRuntimeDir: null })
    expect(paths).toEqual(['/mnt/docker-data'])

    // No Docker at all, and /var/lib/docker itself does not exist yet: walks up to /var/lib.
    paths.length = 0
    await probeLinux(
      {
        ...deps,
        exec: async () => missing(),
        pathExists: async (path) => path !== '/var/lib/docker',
      },
      { user: 'u', xdgRuntimeDir: null }
    )
    expect(paths).toEqual(['/var/lib'])
  })
})
