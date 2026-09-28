/**
 * Scenario tests, one per brief case, driven through `probeLinux` and then `assessLinux` together —
 * a fake `exec`/`readFile`/`pathExists` stands in for the machine, but the parsers in between run
 * for real, on realistic command output (`test/fixtures/linux-probe/`), the same way the review
 * round asked for (task 2.4 fix round 1, item 9): this catches a probe-layer bug (e.g. item 1's
 * `VERSION_ID`-less Arch) that a test built from a hand-written `LinuxFacts` object would never see.
 */
import { describe, expect, it } from 'vitest'
import {
  assessLinux,
  compareDottedVersions,
  type LinuxAssessment,
  type LinuxAssessmentOptions,
} from './linux-plan.js'
import { probeLinux, type CommandOutput, type LinuxProbeDeps, type LinuxProbeOptions } from './linux-probe.js'
import type { RecipeDistribution } from '../../contracts/index.js'
import { readLinuxProbeFixture } from '../../../test/helpers/linux-probe-fixtures.js'

const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' })
const missing = (): CommandOutput => ({ code: null, stdout: '', stderr: '' })
const failed = (stderr: string, code = 1): CommandOutput => ({ code, stdout: '', stderr })

const RECIPE_DISTRIBUTIONS: RecipeDistribution[] = [
  { id: 'ubuntu', version_id: '24.04', arch: 'x86_64' },
  { id: 'ubuntu', version_id: '24.04', arch: 'aarch64' },
  { id: 'ubuntu', version_id: '26.04', arch: 'x86_64' },
  { id: 'ubuntu', version_id: '26.04', arch: 'aarch64' },
  { id: 'fedora', version_id: '43', arch: 'x86_64' },
  { id: 'fedora', version_id: '43', arch: 'aarch64' },
]

const ASSESS_OPTIONS: LinuxAssessmentOptions = {
  recipeId: 'linux.install-container-runtime',
  recipeDistributions: RECIPE_DISTRIBUTIONS,
  minimumDriverVersion: '590.44.01',
  minimumComputeCapability: '8.0',
  requiredDiskBytes: 60_000_000_000,
  currentUser: 'ana',
}

/**
 * A machine, described the way the review asked for: realistic per-command answers, defaulting to
 * "clean Ubuntu 24.04 x86_64, healthy driver, nothing Docker-related installed" so each scenario
 * only overrides what actually distinguishes it.
 */
interface Machine {
  user?: string
  xdgRuntimeDir?: string | null
  rootlessSocketExists?: boolean
  osRelease?: string | null
  uname?: CommandOutput
  nvidiaSmi?: CommandOutput
  dockerVersion?: CommandOutput
  dockerInfo?: CommandOutput
  nvidiaCtkVersion?: CommandOutput
  cdiList?: CommandOutput
  dpkgQuery?: CommandOutput
  rpmQuery?: CommandOutput
  snapList?: CommandOutput
  idNG?: CommandOutput
  getentGroup?: CommandOutput
  systemctlIsActive?: CommandOutput
  ostreeBooted?: boolean
  daemonJson?: string | null
  freeDiskBytesByPath?: Record<string, number>
  pathMissing?: Set<string>
}

function depsFor(machine: Machine): LinuxProbeDeps {
  const exec: LinuxProbeDeps['exec'] = async (command, args) => {
    if (command === 'uname') return machine.uname ?? ok('x86_64\n')
    if (command === 'nvidia-smi') {
      return machine.nvidiaSmi ?? ok(readLinuxProbeFixture('nvidia-smi/rtx4070-driver590.csv'))
    }
    if (command === 'docker' && args.includes('--version')) return machine.dockerVersion ?? missing()
    if (command === 'docker') {
      return (
        machine.dockerInfo ??
        failed(
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
        )
      )
    }
    if (command === 'nvidia-ctk' && args.includes('cdi')) {
      return machine.cdiList ?? ok(readLinuxProbeFixture('nvidia-ctk/cdi-list-empty.txt'))
    }
    if (command === 'nvidia-ctk') return machine.nvidiaCtkVersion ?? missing()
    if (command === 'dpkg-query') return machine.dpkgQuery ?? missing()
    if (command === 'rpm') return machine.rpmQuery ?? missing()
    if (command === 'snap') return machine.snapList ?? failed('error: no matching snaps installed')
    if (command === 'id') return machine.idNG ?? ok(`${machine.user ?? 'ana'} sudo\n`)
    if (command === 'getent') return machine.getentGroup ?? { code: 2, stdout: '', stderr: '' }
    if (command === 'systemctl')
      return machine.systemctlIsActive ?? { code: 3, stdout: 'inactive\n', stderr: '' }
    return missing()
  }
  return {
    exec,
    readFile: async (path) => {
      if (path === '/etc/os-release') {
        return machine.osRelease === undefined
          ? readLinuxProbeFixture('os-release/ubuntu-24.04.txt')
          : machine.osRelease
      }
      if (path === '/etc/docker/daemon.json') return machine.daemonJson ?? null
      return null
    },
    pathExists: async (path) => {
      if (path === '/run/ostree-booted') return machine.ostreeBooted ?? false
      if (machine.pathMissing?.has(path)) return false
      const xdg = machine.xdgRuntimeDir
      if (xdg !== undefined && xdg !== null && path === `${xdg}/docker.sock`) {
        return machine.rootlessSocketExists ?? false
      }
      // Ancestor-walk targets for the free-disk check: present by default so a scenario that does
      // not care about disk space does not have to say so.
      return true
    },
    freeDiskBytes: async (path) => machine.freeDiskBytesByPath?.[path] ?? 200_000_000_000,
  }
}

async function run(
  machine: Machine,
  assessOverrides: Partial<LinuxAssessmentOptions> = {},
  probeOverrides: Partial<LinuxProbeOptions> = {}
) {
  const deps = depsFor(machine)
  const facts = await probeLinux(deps, {
    user: machine.user ?? 'ana',
    xdgRuntimeDir: machine.xdgRuntimeDir ?? null,
    ...probeOverrides,
  })
  const assessment: LinuxAssessment = assessLinux(facts, { ...ASSESS_OPTIONS, ...assessOverrides })
  return { facts, assessment }
}

const changeCodes = (assessment: LinuxAssessment): string[] =>
  (assessment.install_plan?.system_changes ?? []).map((change) => change.code)

describe('compareDottedVersions', () => {
  it('compares dotted versions numerically, not lexicographically', () => {
    expect(compareDottedVersions('580.65.06', '590.44.01')).toBe(-1)
    expect(compareDottedVersions('9.0', '10.0')).toBe(-1) // lexicographic would say the opposite
    expect(compareDottedVersions('8.0', '8')).toBe(0)
    expect(compareDottedVersions('8.9', '8.0')).toBe(1)
  })
})

describe('brief scenarios (task 2.4), driven through probeLinux then assessLinux', () => {
  it('driver 580 with a 590 minimum: blocked with both versions, before any distro or Docker question', async () => {
    const { assessment } = await run({
      nvidiaSmi: ok(readLinuxProbeFixture('nvidia-smi/rtx4070-driver580.csv')),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers[0]?.reason).toBe('driver-too-old')
    expect(assessment.blockers[0]?.params).toEqual({ required: '590.44.01', actual: '580.65.06' })
  })

  it('root reaching the daemon directly adopts: docker_group is diagnostic and never gates it', async () => {
    const { facts, assessment } = await run({
      user: 'root',
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/docker-ce-installed.txt')),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      idNG: ok('root\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.blockers).toEqual([])
    // root is not a member of the docker group at all — and it does not matter.
    expect(facts.docker_group.configured).toBe(false)
  })

  it('a refused socket, group never configured: plans only the group add, nothing else', async () => {
    const { assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: failed(
        'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'
      ),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/docker-ce-installed.txt')),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(assessment.availability).toBe('setup-required')
    expect(changeCodes(assessment)).toEqual(['add-user-to-docker-group'])
    expect(assessment.install_plan?.requires_elevation).toBe(true)
    expect(assessment.install_plan?.may_require_relogin).toBe(true)
  })

  it('a refused socket, group already configured: relogin only, no elevation, no runtime change (item 2/3)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: failed(
        'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'
      ),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/docker-ce-installed.txt')),
      systemctlIsActive: ok('active\n'),
      getentGroup: ok('docker:x:999:ana\n'),
      idNG: ok('ana sudo\n'), // this session's own groups do not have it yet
    })
    expect(facts.docker_group).toEqual({ configured: true, effective: false })
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.install_plan?.system_changes).toEqual([])
    expect(assessment.install_plan?.requires_elevation).toBe(false)
    expect(assessment.install_plan?.may_require_relogin).toBe(true)
  })

  it('Arch with a working Docker adopts exactly like any other distribution, despite no VERSION_ID', async () => {
    const { facts, assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/arch.txt'),
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
    })
    expect(facts.distribution).toEqual({ id: 'arch', version_id: 'rolling', id_like: [], family: 'pacman' })
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.adopts_existing_engine).toBe(true)
  })

  it('Arch without Docker is blocked with the exact pacman commands, never an automatic plan (item 1/12)', async () => {
    const { assessment } = await run({ osRelease: readLinuxProbeFixture('os-release/arch.txt') })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers[0]?.reason).toBe('arch-manual-install')
    expect(assessment.blockers[0]?.commands).toEqual([
      'sudo pacman -Syu --needed docker nvidia-container-toolkit',
      'sudo nvidia-ctk runtime configure --runtime=docker',
      'sudo systemctl restart docker',
      'sudo systemctl enable --now docker',
      'sudo usermod -aG docker $USER',
    ])
  })

  it('a clean Ubuntu 26.04 with a driver gets a full apt plan: repos, only-missing packages, group warning', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/ubuntu-26.04.txt'),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/none-installed.txt')),
    })
    expect(assessment.availability).toBe('setup-required')
    const plan = assessment.install_plan
    expect(plan?.requires_elevation).toBe(true)
    expect(plan?.may_require_relogin).toBe(true)
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'enable-docker-service',
      'add-user-to-docker-group',
    ])
    const packages = plan?.system_changes.find((c) => c.code === 'install-packages')
    expect(packages?.params?.packages).toBe('docker-ce,docker-ce-cli,containerd.io,nvidia-container-toolkit')
    const group = plan?.system_changes.find((c) => c.code === 'add-user-to-docker-group')
    expect(group?.text).toContain('root')
  })

  it('a clean Fedora gets a dnf plan the same shape as the apt one', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-43.txt'),
      rpmQuery: ok(readLinuxProbeFixture('rpm/none-installed.txt')),
    })
    expect(assessment.availability).toBe('setup-required')
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'enable-docker-service',
      'add-user-to-docker-group',
    ])
    expect(assessment.install_plan?.system_changes[0]?.params?.family).toBe('dnf')
  })

  it('Fedora running moby-engine without the toolkit gets a toolkit-only plan, never docker-ce over it', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-43.txt'),
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/moby-engine-no-toolkit.json')),
      rpmQuery: ok(readLinuxProbeFixture('rpm/moby-engine-installed.txt')),
    })
    expect(assessment.availability).toBe('setup-required')
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'restart-docker',
    ])
    const packages = assessment.install_plan?.system_changes.find((c) => c.code === 'install-packages')
    expect(packages?.params?.packages).toBe('nvidia-container-toolkit')
    // moby-engine is already running and reachable: no group, no service-enable step — but the
    // ruling still applies may_require_relogin unconditionally (item 10).
    expect(assessment.install_plan?.may_require_relogin).toBe(true)
    expect(assessment.install_plan?.system_changes.some((c) => c.code === 'add-user-to-docker-group')).toBe(
      false
    )
  })

  it('Fedora with SELinux enforcing and a working moby-engine still adopts; the flag rides along in the facts', async () => {
    const { facts, assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-43.txt'),
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/moby-engine-selinux-ready.json')),
      rpmQuery: ok(readLinuxProbeFixture('rpm/moby-engine-installed.txt')),
    })
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(facts.docker.selinux).toBe(true)
  })

  it('a podman-docker shim is blocked outright: never adopted, never installed over', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-43.txt'),
      dockerVersion: ok('podman version 5.2.2\n'),
      rpmQuery: ok(readLinuxProbeFixture('rpm/podman-docker-installed.txt')),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('podman-docker')
    expect(assessment.blockers[0]?.message).toMatch(/removed first/i)
    expect(assessment.install_plan).toBeNull()
  })

  it('an immutable rpm-ostree host (Silverblue) without Docker is blocked, not offered a layering plan', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-silverblue-43.txt'),
      ostreeBooted: true,
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('immutable-os')
    expect(assessment.install_plan).toBeNull()
  })

  it('a running Docker with 3 containers and no toolkit plans a restart that says so', async () => {
    const { assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/docker-ce-no-toolkit-3-containers.json')),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/docker-ce-installed.txt')),
    })
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'restart-docker',
    ])
    const restart = assessment.install_plan?.system_changes.find((c) => c.code === 'restart-docker')
    expect(restart?.text).toContain('3 running container')
    expect(restart?.params?.running_containers).toBe('3')
  })

  it('snap Docker is blocked outright, explaining why and that nothing is removed', async () => {
    const { assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      snapList: ok(
        'Name    Version  Rev   Tracking       Publisher   Notes\ndocker  28.3.0   123   latest/stable  canonical✓  -\n'
      ),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-snap')
    expect(assessment.install_plan).toBeNull()
  })

  it('an RTX 2080 (compute capability 7.5) is blocked with the required and actual capability', async () => {
    const { assessment } = await run({
      nvidiaSmi: ok(readLinuxProbeFixture('nvidia-smi/rtx2080-driver590.csv')),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('compute-capability-too-low')
    expect(assessment.blockers[0]?.params).toEqual({ required: '8.0', actual: '7.5' })
  })

  it('aarch64 is a supported architecture and matches the recipe like any other', async () => {
    const { facts, assessment } = await run({
      uname: ok('aarch64\n'),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/none-installed.txt')),
    })
    expect(facts.architecture).toBe('aarch64')
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.install_plan).not.toBeNull()
  })

  it('a GB10 with no reported memory still adopts: compute capability, not vram, decides this check', async () => {
    const { facts, assessment } = await run({
      uname: ok('aarch64\n'),
      nvidiaSmi: ok(readLinuxProbeFixture('nvidia-smi/gb10-driver590.csv')),
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
    })
    expect(facts.gpus[0]?.total_vram_bytes).toBeNull()
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.blockers).toEqual([])
  })
})

describe('review-round fixes (task 2.4 fix round 1)', () => {
  it('a Docker install nothing recognises is blocked, never installed over (item 15)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'), // cli answers
      dockerInfo: failed('Cannot connect to the Docker daemon'),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/none-installed.txt')),
      rpmQuery: ok(readLinuxProbeFixture('rpm/none-installed.txt')),
    })
    expect(facts.docker.install_method).toBeNull()
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-unrecognised')
    expect(assessment.install_plan).toBeNull()
  })

  it('Docker Desktop without a system Engine is detected from the package database alone, and blocked (item 5)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: failed('Cannot connect to the Docker daemon'), // Desktop's own socket, not the system one
      dpkgQuery: ok('ii docker-desktop\nun docker-ce\nun docker.io\nun moby-engine\nun podman-docker\n'),
    })
    expect(facts.docker.install_method).toBe('docker-desktop')
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-desktop-only')
  })

  it('a stray rootless socket next to a working rootful daemon does not get misread as rootless (item 6)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/docker-ce-installed.txt')),
      xdgRuntimeDir: '/run/user/1000',
      rootlessSocketExists: true, // leftover from an earlier, abandoned rootless attempt
    })
    expect(facts.docker.install_method).toBe('docker-ce')
    expect(assessment.adopts_existing_engine).toBe(true)
  })

  it('a package dpkg-query lists as merely removed (rc) is not counted as installed (item 4)', async () => {
    const { facts } = await run({
      dockerVersion: missing(),
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/removed-config-remains.txt')),
    })
    expect(facts.docker.install_method).toBeNull()
  })

  it('uname failing non-zero (not just a missing binary) still lands architecture in unknown (item 16)', async () => {
    const { facts, assessment } = await run({ uname: failed('uname: unrecognized option', 1) })
    expect(facts.architecture).toBeNull()
    expect(facts.unknown).toContain('architecture')
    expect(
      assessment.blockers.some((b) => b.reason === 'unknown-fact' && b.params?.fact === 'architecture')
    ).toBe(true)
  })

  it('a clean machine with no /var/lib/docker yet still gets a free-space answer (item 7)', async () => {
    const paths: string[] = []
    const machine: Machine = {
      dpkgQuery: ok(readLinuxProbeFixture('dpkg/none-installed.txt')),
      pathMissing: new Set(['/var/lib/docker']),
      freeDiskBytesByPath: {},
    }
    const deps = depsFor(machine)
    const wrapped: LinuxProbeDeps = {
      ...deps,
      freeDiskBytes: async (path) => {
        paths.push(path)
        return 200_000_000_000
      },
    }
    const facts = await probeLinux(wrapped, { user: 'ana', xdgRuntimeDir: null })
    expect(paths).toEqual(['/var/lib'])
    expect(facts.free_disk_bytes).toBe(200_000_000_000)
    expect(facts.unknown).not.toContain('free-disk')
  })
})

describe('defensive checks (facts a real probe cannot produce today, but assessLinux must not mishandle)', () => {
  it('blocks on a fact it could not read rather than assuming the answer it prefers', async () => {
    const { assessment } = await run({ osRelease: null })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(
      assessment.blockers.some((b) => b.reason === 'unknown-fact' && b.params?.fact === 'distribution')
    ).toBe(true)
  })

  it('reports a missing driver as something the user installs, not something setup can fix', async () => {
    const { assessment } = await run({
      nvidiaSmi: failed("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver", 9),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers.some((b) => b.reason === 'driver-missing')).toBe(true)
  })

  it('refuses when the image would not fit, and says by how much, even on an otherwise-ready host', async () => {
    const { assessment } = await run({ freeDiskBytesByPath: { '/var/lib/docker': 10_000_000_000 } })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('insufficient-disk')
    expect(assessment.blockers[0]?.params).toEqual({ free: '10000000000', required: '60000000000' })
  })

  it('rejects an unsupported architecture outright', async () => {
    const { assessment } = await run({ uname: ok('armv7l\n') })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('unsupported-architecture')
    expect(assessment.blockers[0]?.params).toEqual({ actual: 'armv7l' })
  })

  it('will not offer a one-click install on a distribution nobody has qualified', async () => {
    const { assessment } = await run({
      osRelease: 'ID=opensuse-tumbleweed\nVERSION_ID="20260101"\n',
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('distribution-not-in-recipe')
    expect(assessment.blockers[0]?.params?.id).toBe('opensuse-tumbleweed')
    expect(assessment.install_plan).toBeNull()
  })

  it('blocks a rootless or Docker Desktop install the same way as snap and podman', async () => {
    const rootless = await run({
      dockerVersion: ok('Docker version 28.3.0\n'),
      dockerInfo: ok(
        JSON.stringify({
          ID: 'a',
          ServerVersion: '28.3.0',
          Runtimes: { runc: {} },
          SecurityOptions: ['rootless'],
        })
      ),
    })
    expect(rootless.assessment.blockers[0]?.reason).toBe('docker-rootless')

    const desktop = await run({
      dockerVersion: ok('Docker version 28.3.0\n'),
      dockerInfo: ok(
        JSON.stringify({
          ID: 'a',
          ServerVersion: '28.3.0',
          Runtimes: { runc: {} },
          Name: 'docker-desktop',
          OperatingSystem: 'Docker Desktop',
        })
      ),
    })
    expect(desktop.assessment.blockers[0]?.reason).toBe('docker-desktop-only')
  })
})
