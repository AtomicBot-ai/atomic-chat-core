import { describe, expect, it } from 'vitest'
import {
  assessLinux,
  parseDockerGroup,
  parseDockerInfo,
  parseNvidiaSmi,
  parseOsRelease,
  probeLinux,
  type CommandOutput,
  type LinuxFacts,
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
})

const OPTIONS = {
  supportedDistributions: [{ id: 'ubuntu', versions: ['24.04'] }],
  requiredDiskBytes: 60_000_000_000,
}

const facts = (over: Partial<LinuxFacts> = {}): LinuxFacts => ({
  distribution: { id: 'ubuntu', version: '24.04' },
  driver_version: '551.23',
  gpus: [
    {
      gpu_id: 'GPU-1c6a',
      name: 'NVIDIA GeForce RTX 4070',
      compute_capability: '8.9',
      total_vram_bytes: 12_282 * 1024 * 1024,
      free_vram_bytes: 11_000 * 1024 * 1024,
      driver_version: '551.23',
    },
  ],
  docker: {
    cli: true,
    daemon_reachable: true,
    engine_identity: 'X4RT:AAAA',
    version: '28.3.0',
    gpu_runtime: true,
  },
  docker_group: { configured: true, effective: true },
  toolkit_installed: true,
  free_disk_bytes: 200_000_000_000,
  unknown: [],
  ...over,
})

describe('reading the machine', () => {
  it('takes the distribution from os-release, quotes and all', () => {
    expect(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nNAME="Ubuntu"\n')).toEqual({
      id: 'ubuntu',
      version: '24.04',
    })
    expect(parseOsRelease("ID='fedora'\nVERSION_ID=41\n")).toEqual({ id: 'fedora', version: '41' })
    // A file that is there but says nothing useful is no answer at all.
    expect(parseOsRelease('NAME="Something"\n')).toBeNull()
    expect(parseOsRelease(null)).toBeNull()
  })

  it('reads every card nvidia-smi lists, converting its megabytes to bytes', () => {
    const answer = parseNvidiaSmi(ok(SMI + 'GPU-9f, NVIDIA GeForce RTX 5090, 12.0, 32607, 32000, 551.23\n'))
    expect(answer.driver_version).toBe('551.23')
    expect(answer.gpus).toHaveLength(2)
    expect(answer.gpus[0]?.compute_capability).toBe('8.9')
    expect(answer.gpus[0]?.total_vram_bytes).toBe(12_282 * 1024 * 1024)
    expect(answer.gpus[1]?.compute_capability).toBe('12.0')
  })

  it('reports no driver rather than an empty one when nvidia-smi is not there', () => {
    expect(parseNvidiaSmi(missing())).toEqual({ driver_version: null, gpus: [] })
    expect(parseNvidiaSmi(failed('NVIDIA-SMI has failed'))).toEqual({ driver_version: null, gpus: [] })
  })

  it('counts either road to --gpus, and neither when the daemon does not answer', () => {
    expect(parseDockerInfo(ok(DOCKER_INFO)).gpu_runtime).toBe(true)
    expect(
      parseDockerInfo(ok(JSON.stringify({ ID: 'a', Runtimes: { runc: {} }, CDISpecDirs: ['/etc/cdi'] })))
        .gpu_runtime
    ).toBe(true)
    expect(
      parseDockerInfo(ok(JSON.stringify({ ID: 'a', Runtimes: { runc: {} }, CDISpecDirs: [] }))).gpu_runtime
    ).toBe(false)
    // A daemon that is not running answers nothing; that is not the same as answering "no GPU".
    expect(parseDockerInfo(failed('Cannot connect to the Docker daemon'))).toEqual({
      daemon_reachable: false,
      engine_identity: null,
      version: null,
      gpu_runtime: false,
    })
    expect(parseDockerInfo(ok('not json')).daemon_reachable).toBe(false)
  })

  it('tells a group this session has from one the account merely belongs to', () => {
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

  it('runs only read-only commands and records every answer it could not get', async () => {
    const calls: string[] = []
    const probed = await probeLinux(
      {
        exec: async (command, args) => {
          calls.push([command, ...args].join(' '))
          if (command === 'nvidia-smi') return ok(SMI)
          if (command === 'docker' && args[0] === '--version') return ok('Docker version 28.3.0')
          if (command === 'docker') return ok(DOCKER_INFO)
          if (command === 'id') return ok('u docker')
          if (command === 'getent') return ok('docker:x:999:u')
          return missing()
        },
        readFile: async () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
        freeDiskBytes: async () => 200_000_000_000,
      },
      'u'
    )

    expect(probed.distribution).toEqual({ id: 'ubuntu', version: '24.04' })
    expect(probed.docker.daemon_reachable).toBe(true)
    // `nvidia-ctk --version` was not found, so the toolkit is reported absent, not assumed.
    expect(probed.toolkit_installed).toBe(false)
    expect(probed.unknown).toEqual([])
    // Nothing that could change the machine: no run, no pull, no install, no service.
    expect(calls.some((call) => /run|pull|install|systemctl|apt/.test(call))).toBe(false)
  })

  it('records a probe that could not run as unknown instead of as a no', async () => {
    const probed = await probeLinux(
      {
        exec: async () => missing(),
        readFile: async () => null,
        freeDiskBytes: async () => null,
      },
      'u'
    )
    expect(probed.unknown).toEqual(['distribution', 'nvidia-driver', 'docker-group', 'free-disk'])
  })
})

describe('what the machine needs', () => {
  it('adopts a host that already runs containers on its GPU, asking for nothing', () => {
    const assessment = assessLinux(facts(), OPTIONS)
    expect(assessment.availability).toBe('supported')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.missing).toEqual([])
    expect(assessment.blockers).toEqual([])
    expect(assessment.needs_relogin).toBe(false)
  })

  it('lists what a clean machine is missing, in the order an install would add it', () => {
    const assessment = assessLinux(
      facts({
        docker: {
          cli: false,
          daemon_reachable: false,
          engine_identity: null,
          version: null,
          gpu_runtime: false,
        },
        docker_group: { configured: false, effective: false },
        toolkit_installed: false,
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.adopts_existing_engine).toBe(false)
    expect(assessment.missing).toEqual(['docker-engine', 'nvidia-container-toolkit', 'docker-group'])
  })

  it('asks only for the toolkit when Docker is there but cannot reach the GPU', () => {
    const assessment = assessLinux(
      facts({
        docker: {
          cli: true,
          daemon_reachable: true,
          engine_identity: 'X',
          version: '28.3.0',
          gpu_runtime: false,
        },
        toolkit_installed: false,
      }),
      OPTIONS
    )
    expect(assessment.missing).toEqual(['nvidia-container-toolkit'])
    expect(assessment.adopts_existing_engine).toBe(false)
  })

  it('says a sign-out is needed when the group is granted but this session predates it', () => {
    const assessment = assessLinux(facts({ docker_group: { configured: true, effective: false } }), OPTIONS)
    expect(assessment.needs_relogin).toBe(true)
    // Everything is installed, so it is not adoptable yet only because of the session.
    expect(assessment.missing).toEqual([])
    expect(assessment.adopts_existing_engine).toBe(false)
  })

  it('will not offer a one-click install on a distribution nobody has qualified', () => {
    const assessment = assessLinux(facts({ distribution: { id: 'arch', version: 'rolling' } }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.details).toContain('arch')
  })

  it('reports a missing driver as something the user installs, not something setup can fix', () => {
    const assessment = assessLinux(facts({ driver_version: null, gpus: [] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.missing).toContain('nvidia-driver')
    expect(assessment.blockers.some((b) => b.message.includes('NVIDIA driver'))).toBe(true)
  })

  it('reports a driver that sees no card, which no install will change either', () => {
    const assessment = assessLinux(facts({ gpus: [] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers.some((b) => b.message.includes('no usable GPU'))).toBe(true)
  })

  it('blocks on a fact it could not read rather than assuming the answer it prefers', () => {
    const assessment = assessLinux(facts({ unknown: ['docker-group'] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.details).toBe('docker-group')
    expect(assessment.adopts_existing_engine).toBe(false)
  })

  it('refuses when the image would not fit, and says by how much', () => {
    const assessment = assessLinux(facts({ free_disk_bytes: 10_000_000_000 }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.details).toContain('required=60000000000')
  })
})
