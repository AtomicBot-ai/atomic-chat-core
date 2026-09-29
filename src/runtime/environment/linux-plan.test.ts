/**
 * Scenario tests, one per brief case, driven through `probeLinux` and then `assessLinux` together —
 * a fake `exec`/`readFile`/`pathExists` stands in for the machine, but the parsers in between run
 * for real, on realistic command output (`test/fixtures/linux-probe/`), the same way the review
 * round asked for (task 2.4 fix round 1, item 9): this catches a probe-layer bug (e.g. round 1's
 * item 1, a `VERSION_ID`-less Arch, or round 2's item 1, a docker CLI that exits 0 on a failed call)
 * that a test built from a hand-written `LinuxFacts` object would never see. Every test in this file
 * goes through the real probe this way, including the ones in the last `describe` block below —
 * there is no hand-built-`LinuxFacts` shortcut left anywhere in it (round 2, item 12; round 3 adds
 * one more `describe` block at the bottom, same rule).
 */
import { describe, expect, it } from 'vitest'
import {
  assessLinux,
  compareDottedVersions,
  type LinuxAssessment,
  type LinuxAssessmentOptions,
} from './linux-plan.js'
import { initNotSystemdBlocker } from './linux-blockers.js'
import { probeLinux, type CommandOutput, type LinuxProbeDeps, type LinuxProbeOptions } from './linux-probe.js'
import type { RecipeDistribution } from '../../contracts/index.js'
import {
  DAEMON_DOWN_28_3,
  readLinuxProbeFixture,
  UNREACHABLE_28_3,
} from '../../../test/helpers/linux-probe-fixtures.js'

const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' })
const missing = (): CommandOutput => ({ code: null, stdout: '', stderr: '' })
const failed = (stderr: string, code = 1): CommandOutput => ({ code, stdout: '', stderr })

// `dpkg-query`/`rpm -q` exit non-zero whenever any of the several package names queried in one call
// did not match (round 2, item 11) — real even when some names in the same call did match, which is
// every fixture below. `dpkg-query` prints nothing to stdout for a name it has no record of at all
// (a "no packages found matching ..." line to stderr instead); `rpm -q` prints "package ... is not
// installed" to stdout for the same case, which the existing rpm fixtures already show.
const dpkgFound = (fixture: string): CommandOutput => ({
  code: 1,
  stdout: readLinuxProbeFixture(fixture),
  stderr: '',
})
const dpkgNoneFound = (): CommandOutput => ({
  code: 1,
  stdout: '',
  stderr: readLinuxProbeFixture('dpkg/none-installed.txt'),
})
const rpmFound = (fixture: string): CommandOutput => ({
  code: 1,
  stdout: readLinuxProbeFixture(fixture),
  stderr: '',
})
const rpmNoneFound = (): CommandOutput => ({
  code: 1,
  stdout: readLinuxProbeFixture('rpm/none-installed.txt'),
  stderr: '',
})

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
  pacmanQuery?: CommandOutput
  /** Installed pacman packages (name → version). When set, `pacman -Q <names...>` answers the way the
   *  real one does for exactly the names asked: a `name version` line on stdout per hit, an
   *  `error: package '<name>' was not found` line on stderr per miss, exit 1 if any name missed. */
  pacmanPackages?: Record<string, string>
  snapList?: CommandOutput
  idNG?: CommandOutput
  getentGroup?: CommandOutput
  systemctlIsActive?: CommandOutput
  ostreeBooted?: boolean
  daemonJson?: string | null
  /** Simulates `readFile` rejecting (e.g. `EACCES` on a `0600` daemon.json) rather than resolving
   *  `null` — the "genuinely unreadable" case `daemonJson: null` cannot express (round 3, item 2). */
  daemonJsonUnreadable?: boolean
  freeDiskBytesByPath?: Record<string, number>
  pathMissing?: Set<string>
  /** Paths whose `pathExists` rejects (the check itself failed), rather than answering false. */
  pathUnreadable?: Set<string>
}

function pacmanQ(installed: Record<string, string>, args: string[]): CommandOutput {
  const names = args.filter((arg) => !arg.startsWith('-'))
  const hits = names.filter((name) => installed[name] !== undefined)
  const misses = names.filter((name) => installed[name] === undefined)
  return {
    code: misses.length > 0 ? 1 : 0,
    stdout: hits.map((name) => `${name} ${installed[name]}\n`).join(''),
    stderr: misses.map((name) => `error: package '${name}' was not found\n`).join(''),
  }
}

function depsFor(machine: Machine): LinuxProbeDeps {
  const exec: LinuxProbeDeps['exec'] = async (command, args) => {
    if (command === 'uname') return machine.uname ?? ok('x86_64\n')
    if (command === 'nvidia-smi') {
      return machine.nvidiaSmi ?? ok(readLinuxProbeFixture('nvidia-smi/rtx4070-driver590.csv'))
    }
    if (command === 'docker' && args.includes('--version')) return machine.dockerVersion ?? missing()
    if (command === 'docker') return machine.dockerInfo ?? UNREACHABLE_28_3
    if (command === 'nvidia-ctk' && args.includes('cdi')) {
      return machine.cdiList ?? ok(readLinuxProbeFixture('nvidia-ctk/cdi-list-empty.txt'))
    }
    if (command === 'nvidia-ctk') return machine.nvidiaCtkVersion ?? missing()
    if (command === 'dpkg-query') return machine.dpkgQuery ?? missing()
    if (command === 'rpm') return machine.rpmQuery ?? missing()
    if (command === 'pacman') {
      if (machine.pacmanPackages === undefined) return machine.pacmanQuery ?? missing()
      return pacmanQ(machine.pacmanPackages, args)
    }
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
      if (path === '/etc/docker/daemon.json') {
        if (machine.daemonJsonUnreadable === true) throw new Error('EACCES: permission denied')
        return machine.daemonJson ?? null
      }
      return null
    },
    pathExists: async (path) => {
      if (path === '/run/ostree-booted') return machine.ostreeBooted ?? false
      if (machine.pathUnreadable?.has(path)) throw new Error('EIO: i/o error')
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
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      idNG: ok('root\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.blockers).toEqual([])
    // getent exit 2 ("no such key") is a real, definitive answer (round 3, ruling 7): the docker
    // group does not exist at all — root is not a member, and it does not matter either way: root's
    // access is never decided by group membership (round 2, item 9).
    expect(facts.docker_group.configured).toBe(false)
  })

  it('a refused socket, group never configured, everything else ready: plans only the group add (items 2/3/5)', async () => {
    const { assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
      // Read-only evidence the runtime is already configured, since the daemon cannot be asked
      // directly — without this, "everything else ready" is not actually true, and the plan must
      // surface the missing runtime configuration instead (see the next test).
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    expect(assessment.availability).toBe('setup-required')
    expect(changeCodes(assessment)).toEqual(['add-user-to-docker-group'])
    expect(assessment.install_plan?.requires_elevation).toBe(true)
    expect(assessment.install_plan?.may_require_relogin).toBe(true)
  })

  it('a refused socket, group never configured, toolkit missing: never hides the missing toolkit behind a relogin wait (round 2, item 5)', async () => {
    const { assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' }, // definitively not configured (ruling 7)
      // nvidiaCtkVersion left missing(): the toolkit is not installed. The old access-only branch
      // used to short-circuit here on daemon-unreachable + service-active alone and never mention
      // this at all — now it only takes that shortcut once every other signal is also ready.
    })
    expect(assessment.availability).toBe('setup-required')
    expect(changeCodes(assessment)).toContain('install-packages')
    expect(
      assessment.install_plan?.system_changes.find((c) => c.code === 'install-packages')?.params?.packages
    ).toBe('nvidia-container-toolkit')
  })

  it('Ubuntu, group configured but not effective, toolkit missing: relogin-required plus one blocker per missing component, never a plan (round 4, item 1)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      systemctlIsActive: ok('active\n'),
      getentGroup: ok('docker:x:999:ana\n'),
      idNG: ok('ana sudo\n'), // this session's own groups do not have it yet
      // nvidiaCtkVersion left missing(): the toolkit is not installed, and no daemon.json exists, so
      // the runtime is not configured either. Both must be named now, not after the relogin.
    })
    expect(facts.docker_group).toEqual({ configured: true, effective: false })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual([
      'relogin-required',
      'toolkit-missing',
      'gpu-runtime-not-configured',
    ])
    expect(assessment.blockers[0]?.commands).toEqual([])
    // A recipe distribution: setup itself does these after the relogin, so nothing to run by hand.
    for (const component of assessment.blockers.slice(1)) {
      expect(component.message).toMatch(/after you log back in/i)
      expect(component.commands).toEqual([])
    }
  })

  it('Ubuntu, group configured but not effective, nothing else missing: relogin-required alone (round 4, item 1)', async () => {
    const { assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: ok('docker:x:999:ana\n'),
      idNG: ok('ana sudo\n'),
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['relogin-required'])
  })

  it('Ubuntu, Docker gone but the docker group left behind: relogin-required plus every missing component (round 4, item 1)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/ubuntu-26.04.txt'),
      dpkgQuery: dpkgNoneFound(),
      dockerInfo: DAEMON_DOWN_28_3,
      getentGroup: ok('docker:x:999:ana\n'),
      idNG: ok('ana sudo\n'),
    })
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual([
      'relogin-required',
      'docker-cli-missing',
      'toolkit-missing',
      'gpu-runtime-not-configured',
      'docker-service-inactive',
    ])
  })

  it('an out-of-recipe distro, group configured but not effective, toolkit missing: relogin plus components plus the recipe gate (round 4, item 1)', async () => {
    const { assessment } = await run({
      osRelease: 'ID=opensuse-tumbleweed\nVERSION_ID="20260101"\n',
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: UNREACHABLE_28_3,
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
      systemctlIsActive: ok('active\n'),
      getentGroup: ok('docker:x:999:ana\n'),
      idNG: ok('ana sudo\n'),
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual([
      'relogin-required',
      'toolkit-missing',
      'distribution-not-in-recipe',
    ])
    // Not a recipe distribution: nothing may promise that setup will install it later.
    expect(assessment.blockers[1]?.message).not.toMatch(/after you log back in/i)
  })

  it('group configured but not effective with an unreadable daemon.json: the unreadable blocker stands in for the runtime (round 4, item 1)', async () => {
    const { assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: ok('docker:x:999:ana\n'),
      idNG: ok('ana sudo\n'),
      daemonJsonUnreadable: true,
    })
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['relogin-required', 'daemon-json-unreadable'])
  })

  it('root listed in the docker group but not in its session is never told to relogin (round 4, item B; design D4)', async () => {
    const { facts, assessment } = await run(
      {
        user: 'root',
        dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
        dockerInfo: UNREACHABLE_28_3,
        dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
        nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
        systemctlIsActive: ok('active\n'),
        getentGroup: ok('docker:x:999:root\n'),
        idNG: ok('root\n'),
        daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
      },
      { currentUser: 'root' }
    )
    expect(facts.docker_group).toEqual({ configured: true, effective: false })
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['docker-access-unexplained'])
    expect(assessment.install_plan).toBeNull()
  })

  it('a refused socket, group already configured AND effective, everything else ready: unexplained, not an endless relogin (round 2, item 2)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: ok('docker:x:999:ana\n'),
      idNG: ok('ana docker sudo\n'), // this session already has it too
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    expect(facts.docker_group).toEqual({ configured: true, effective: true })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-access-unexplained')
    expect(assessment.install_plan).toBeNull()
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
    // The probed account, never the literal $USER (round 3, ruling 8).
    expect(assessment.blockers[0]?.commands).toEqual([
      'sudo pacman -Syu --needed docker nvidia-container-toolkit',
      'sudo nvidia-ctk runtime configure --runtime=docker',
      'sudo systemctl restart docker',
      'sudo systemctl enable --now docker',
      'sudo usermod -aG docker ana',
    ])
  })

  it('a clean Ubuntu 26.04 with a driver gets a full apt plan: repos, only-missing packages, group warning', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/ubuntu-26.04.txt'),
      dpkgQuery: dpkgNoneFound(),
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
      rpmQuery: rpmNoneFound(),
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
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
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
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
    })
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(facts.docker.selinux).toBe(true)
  })

  it('a podman-docker shim is blocked outright: never adopted, never installed over', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-43.txt'),
      dockerVersion: ok('podman version 5.2.2\n'),
      rpmQuery: rpmFound('rpm/podman-docker-installed.txt'),
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
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
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

  it('a running Docker this user cannot reach yet, without the toolkit, plans the restart up front (task 2.6)', async () => {
    // The daemon is active, so the runtime nvidia-ctk registers would only load at Docker's next
    // start; without the restart in the consented plan, the setup would need a second elevation
    // just to restart Docker after the sign-in (task 2.5 report, concern 2).
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(facts.docker.daemon_reachable).toBe(false)
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'add-user-to-docker-group',
      'restart-docker',
    ])
    const restart = assessment.install_plan?.system_changes.find((c) => c.code === 'restart-docker')
    // How many containers would stop is not something this user can ask the daemon yet.
    expect(restart?.params?.running_containers).toBe('unknown')
    expect(restart?.text).toMatch(/running containers will stop/)
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
      dpkgQuery: dpkgNoneFound(),
    })
    expect(facts.architecture).toBe('aarch64')
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.install_plan).not.toBeNull()
  })

  it('a GB10 with no reported memory still adopts: compute capability, not vram, decides this check', async () => {
    const { facts, assessment } = await run({
      uname: ok('aarch64\n'),
      nvidiaSmi: ok(readLinuxProbeFixture('nvidia-smi/gb10-driver595-captured.csv')),
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
    })
    expect(facts.gpus[0]?.total_vram_bytes).toBeNull()
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.blockers).toEqual([])
  })

  // GB10 captured on a DGX Spark-class host (driver 595.71.05); GH200 and RTX 5090 documented.
  it.each([
    ['GB10', 'aarch64\n', 'nvidia-smi/gb10-driver595-captured.csv'],
    ['GH200', 'aarch64\n', 'nvidia-smi/gh200-documented.csv'],
    ['RTX 5090', 'x86_64\n', 'nvidia-smi/rtx5090-documented.csv'],
  ])(
    'a ready %s host adopts with no blocker: driver and compute capability pass, memory is never asked',
    async (_label, arch, smi) => {
      const { assessment } = await run({
        uname: ok(arch),
        nvidiaSmi: ok(readLinuxProbeFixture(smi)),
        dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
        dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
        nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      })
      expect(assessment.blockers).toEqual([])
      expect(assessment.adopts_existing_engine).toBe(true)
    }
  )
})

describe('review-round fixes (task 2.4 fix round 1)', () => {
  it('a Docker install nothing recognises is blocked, never installed over (item 15)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'), // cli answers
      dockerInfo: DAEMON_DOWN_28_3,
      dpkgQuery: dpkgNoneFound(),
      rpmQuery: rpmNoneFound(),
    })
    expect(facts.docker.install_method).toBeNull()
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-unrecognised')
    expect(assessment.install_plan).toBeNull()
  })

  it('Docker Desktop without a system Engine is detected from the package database alone, and blocked (item 5)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: DAEMON_DOWN_28_3, // Desktop's own socket, not the system one
      dpkgQuery: { code: 1, stdout: 'ii  docker-desktop\n', stderr: '' },
    })
    expect(facts.docker.install_method).toBe('docker-desktop')
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-desktop-only')
  })

  it('a stray rootless socket next to a working rootful daemon does not get misread as rootless (item 6)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      xdgRuntimeDir: '/run/user/1000',
      rootlessSocketExists: true, // leftover from an earlier, abandoned rootless attempt
    })
    expect(facts.docker.install_method).toBe('docker-ce')
    expect(assessment.adopts_existing_engine).toBe(true)
  })

  it('a package dpkg-query lists as merely removed (rc) is not counted as installed (item 4)', async () => {
    const { facts } = await run({
      dockerVersion: missing(),
      dpkgQuery: dpkgFound('dpkg/removed-config-remains.txt'),
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
      dpkgQuery: dpkgNoneFound(),
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

describe('review-round fixes (task 2.4 fix round 2)', () => {
  it('a docker CLI ≤28.2 permission failure (exit 0, ServerErrors, empty ServerVersion) is read as unreachable, never as ready (item 1)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 26.1.3, build 26e224e\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/legacy-cli-permission-denied-exit0.json')),
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
    })
    expect(facts.docker.daemon_reachable).toBe(false)
    expect(facts.docker.server_errors).toHaveLength(1)
    // Not adopted, not "ready except access" either (toolkit/runtime evidence is still missing) —
    // just an ordinary "Docker is there but unreachable, and the service is not even active" plan.
    expect(assessment.adopts_existing_engine).toBe(false)
    expect(assessment.availability).toBe('setup-required')
  })

  it('a docker CLI ≤28.2 permission failure with daemon.json already runtimes.nvidia plans no runtime change or restart (item 3)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 26.1.3, build 26e224e\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/legacy-cli-permission-denied-exit0.json')),
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    expect(facts.docker.daemon_reachable).toBe(false)
    // "Ready except access": the only step is the group add, never configure-nvidia-runtime or
    // restart-docker — there is nothing live to restart, and the offline evidence already says the
    // runtime is configured.
    expect(changeCodes(assessment)).toEqual(['add-user-to-docker-group'])
  })

  it('Docker Desktop alongside a reachable, working docker-ce is never blocked as Desktop-only (round 2, item 4)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      dpkgQuery: { code: 0, stdout: 'ii  docker-desktop\nii  docker-ce\n', stderr: '' },
    })
    expect(facts.docker.install_method).toBe('docker-ce')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.blockers).toEqual([])
  })

  it("Arch, ready except this session's group membership: a targeted usermod blocker, not the full arch-manual-install wall of text (round 3, item 1/ruling 1)", async () => {
    const { facts, assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/arch.txt'),
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: missing(),
      rpmQuery: missing(),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' }, // "no such key": not configured (ruling 7)
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    // Arch's own docker package is not one of DOCKER_PACKAGE_CANDIDATES — dpkg-query/rpm -q never
    // see it — so `install_method` stays null; `dockerInstallRecognised` (linux-plan.ts) accepts
    // `family === 'pacman' && docker.cli` as recognition instead, which is what lets this reach
    // `readyExceptAccess` at all (round 2's regression: this used to fall through to the full
    // `arch-manual-install` blocker even though nothing but group access was actually missing).
    expect(facts.docker.install_method).toBeNull()
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-group-manual')
    expect(assessment.blockers[0]?.commands).toEqual(['sudo usermod -aG docker ana'])
    expect(assessment.install_plan).toBeNull()
  })

  it('Arch, root, Docker genuinely absent: the manual commands omit usermod entirely (round 3, ruling 8)', async () => {
    const { assessment } = await run(
      {
        user: 'root',
        osRelease: readLinuxProbeFixture('os-release/arch.txt'),
        idNG: ok('root\n'),
        getentGroup: { code: 2, stdout: '', stderr: '' },
      },
      { currentUser: 'root' }
    )
    expect(assessment.blockers[0]?.reason).toBe('arch-manual-install')
    expect(assessment.blockers[0]?.commands).toEqual([
      'sudo pacman -Syu --needed docker nvidia-container-toolkit',
      'sudo nvidia-ctk runtime configure --runtime=docker',
      'sudo systemctl restart docker',
      'sudo systemctl enable --now docker',
    ])
    expect(assessment.blockers[0]?.commands?.some((c) => c.includes('usermod'))).toBe(false)
  })

  it("Silverblue, ready except this session's group membership: copies the group line first, then usermod (round 3, ruling 6)", async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-silverblue-43.txt'),
      ostreeBooted: true,
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: UNREACHABLE_28_3,
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-group-manual')
    // rpm-ostree's package layering puts the docker group in /usr/lib/group, which /etc/group does
    // not automatically inherit — usermod alone would fail with "group 'docker' does not exist".
    // Idempotent (round 4, item F): a second run must not append a duplicate docker line.
    expect(assessment.blockers[0]?.commands).toEqual([
      "grep -q '^docker:' /etc/group || grep -E '^docker:' /usr/lib/group | sudo tee -a /etc/group",
      'sudo usermod -aG docker ana',
    ])
    expect(assessment.install_plan).toBeNull()
  })

  it("an out-of-recipe distro, ready except this session's group membership: usermod blocker, not silently elevated (round 2, item 5)", async () => {
    const { assessment } = await run({
      osRelease: 'ID=opensuse-tumbleweed\nVERSION_ID="20260101"\n',
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: UNREACHABLE_28_3,
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-group-manual')
    expect(assessment.install_plan).toBeNull()
  })

  it('a daemon.json that will not parse blocks with an instruction instead of planning a blind runtime configure (round 2, item 6)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: DAEMON_DOWN_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      daemonJson: '{ this is not valid json',
    })
    expect(facts.docker.daemon_json_unreadable).toBe(true)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('daemon-json-unreadable')
    expect(assessment.install_plan).toBeNull()
  })

  it('offline CDI evidence requires features.cdi as well as a listed device, mirroring the live path (round 2, item 7)', async () => {
    // A device nvidia-ctk can see, but Docker itself is not configured to consume CDI specs: not
    // enough evidence on its own.
    const notEnabled = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: DAEMON_DOWN_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      cdiList: ok(readLinuxProbeFixture('nvidia-ctk/cdi-list-nvidia-gpu.txt')),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(notEnabled.facts.docker.gpu_runtime_from_config).toBe(false)
    expect(changeCodes(notEnabled.assessment)).toContain('configure-nvidia-runtime')

    // The same device, but daemon.json also turns CDI on: now it counts.
    const enabled = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: DAEMON_DOWN_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      cdiList: ok(readLinuxProbeFixture('nvidia-ctk/cdi-list-nvidia-gpu.txt')),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
      daemonJson: JSON.stringify({ features: { cdi: true } }),
    })
    expect(enabled.facts.docker.gpu_runtime_from_config).toBe(true)
    expect(changeCodes(enabled.assessment)).toEqual(['add-user-to-docker-group'])
  })

  it('root with an active but unreachable daemon is never told to join the docker group (design D4, round 2 item 9)', async () => {
    const { assessment } = await run(
      {
        user: 'root',
        dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
        dockerInfo: DAEMON_DOWN_28_3,
        dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
        nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
        systemctlIsActive: ok('active\n'),
        idNG: ok('root\n'),
        getentGroup: { code: 2, stdout: '', stderr: '' },
        daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
      },
      { currentUser: 'root' }
    )
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('docker-access-unexplained')
    expect(assessment.blockers.every((b) => b.reason !== 'docker-group-manual')).toBe(true)
    expect(assessment.install_plan).toBeNull()
  })
})

describe('review-round fixes (task 2.4 fix round 3)', () => {
  // Ruling 4: configured && !effective is a relogin-required blocker, on every distribution — not
  // conditioned on readyExceptAccess, not an install plan. Ubuntu is covered by the renamed test in
  // the round-1/round-2 "brief scenarios" block above ("a refused socket, group configured but not
  // effective"); Arch and Silverblue are here, since ruling 4 explicitly asks for all three.
  it('Arch, group configured but not effective: relogin-required plus each missing component with its exact commands (ruling 4, refined in round 4 item 1)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/arch.txt'),
      dockerVersion: ok('Docker version 28.3.3, build 980b856\n'),
      dockerInfo: UNREACHABLE_28_3,
      pacmanPackages: { docker: '1:28.3.3-1' },
      getentGroup: ok('docker:x:959:ana\n'),
      idNG: ok('ana wheel\n'), // this session's own groups do not have it yet
      // toolkit missing, no daemon.json, docker.service inactive (the harness default).
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers).toEqual([
      expect.objectContaining({ reason: 'relogin-required', commands: [] }),
      expect.objectContaining({
        reason: 'toolkit-missing',
        commands: ['sudo pacman -Syu --needed nvidia-container-toolkit'],
      }),
      expect.objectContaining({
        reason: 'gpu-runtime-not-configured',
        commands: ['sudo nvidia-ctk runtime configure --runtime=docker', 'sudo systemctl restart docker'],
      }),
      expect.objectContaining({
        reason: 'docker-service-inactive',
        commands: ['sudo systemctl enable --now docker'],
      }),
    ])
  })

  it('Silverblue, group configured but not effective: relogin-required plus each missing component and the immutable-os gate (ruling 4, refined in round 4 item 1)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-silverblue-43.txt'),
      ostreeBooted: true,
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: UNREACHABLE_28_3,
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
      getentGroup: ok('docker:x:981:ana\n'),
      idNG: ok('ana wheel\n'),
    })
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual([
      'relogin-required',
      'toolkit-missing',
      'gpu-runtime-not-configured',
      'docker-service-inactive',
      'immutable-os',
    ])
    // Layering a package is not something this integration writes commands for (design D2).
    expect(assessment.blockers[1]?.commands).toEqual([])
  })

  // Ruling 5: Docker Engine 28.2+ turns CDI on by default; below that, or when the version cannot
  // be determined, daemon.json's explicit features.cdi is still required.
  it('engine 28.1 (below the CDI default threshold): a listed CDI device is not enough on its own (ruling 5)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.1.1, build afdd53b\n'),
      dpkgQuery: { code: 1, stdout: 'ii  docker-ce 28.1.1-1\n', stderr: '' },
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      cdiList: ok(readLinuxProbeFixture('nvidia-ctk/cdi-list-nvidia-gpu.txt')),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(facts.docker.engine_version).toBe('28.1.1')
    expect(facts.docker.gpu_runtime_from_config).toBe(false)
    expect(changeCodes(assessment)).toContain('configure-nvidia-runtime')
  })

  it('engine 28.2 (at the CDI default threshold): a listed CDI device is enough, daemon.json silent (ruling 5)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.2.0, build afdd53b\n'),
      dpkgQuery: { code: 1, stdout: 'ii  docker-ce 28.2.0-1\n', stderr: '' },
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      cdiList: ok(readLinuxProbeFixture('nvidia-ctk/cdi-list-nvidia-gpu.txt')),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(facts.docker.engine_version).toBe('28.2.0')
    expect(facts.docker.gpu_runtime_from_config).toBe(true)
    // "Ready except access": the only step left is the group add.
    expect(changeCodes(assessment)).toEqual(['add-user-to-docker-group'])
  })

  it('engine version unknown: keeps requiring the explicit daemon.json setting rather than assuming recent (ruling 5)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      // install_method is recognised (so this reaches buildInstallPlan at all), but its *version*
      // is not: the dpkg-query fixture here has no trailing ${Version} column, e.g. an older probe
      // run's cached fixture shape — detectEngineVersion must not guess from that.
      dpkgQuery: { code: 1, stdout: 'ii  docker-ce\n', stderr: '' },
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      cdiList: ok(readLinuxProbeFixture('nvidia-ctk/cdi-list-nvidia-gpu.txt')),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(facts.docker.install_method).toBe('docker-ce')
    expect(facts.docker.engine_version).toBeNull()
    expect(facts.docker.gpu_runtime_from_config).toBe(false)
    expect(changeCodes(assessment)).toContain('configure-nvidia-runtime')
  })

  // Item 2: a daemon.json EACCES read error must block, even when the daemon is directly reachable
  // and docker info itself already says the runtime is unconfigured.
  it('a reachable daemon whose daemon.json is unreadable (EACCES) still blocks instead of planning a blind reconfigure (item 2)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/docker-ce-no-toolkit-3-containers.json')),
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      daemonJsonUnreadable: true,
    })
    expect(facts.docker.daemon_reachable).toBe(true)
    expect(facts.docker.gpu_runtime).toBe(false)
    expect(facts.docker.daemon_json_unreadable).toBe(true)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.reason).toBe('daemon-json-unreadable')
    expect(assessment.install_plan).toBeNull()
  })

  // Item 3: a ≥28.3 unreachable docker info is realistically JSON-on-stdout + exit 1, not empty
  // stdout — every scenario in this file already uses that shape by default (UNREACHABLE_28_3); this
  // just pins the behavior explicitly.
  it('a realistic ≥28.3 unreachable docker info (JSON body, exit 1) is still read as unreachable (item 3)', async () => {
    const { facts, assessment } = await run({
      dpkgQuery: dpkgNoneFound(),
    })
    expect(facts.docker.daemon_reachable).toBe(false)
    expect(assessment.adopts_existing_engine).toBe(false)
  })
})

describe('review-round fixes (task 2.4 fix round 4)', () => {
  it('a daemon.json that cannot be read leaves the CDI default unknown: no group-only plan on a 28.2+ engine (item A)', async () => {
    const { facts, assessment } = await run({
      dockerVersion: ok('Docker version 28.2.0, build afdd53b\n'),
      dockerInfo: UNREACHABLE_28_3,
      dpkgQuery: { code: 1, stdout: 'ii  docker-ce 5:28.2.0-1~ubuntu.24.04~noble\n', stderr: '' },
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      cdiList: ok(readLinuxProbeFixture('nvidia-ctk/cdi-list-nvidia-gpu.txt')),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
      daemonJsonUnreadable: true, // it may say features.cdi: false; this probe cannot tell
    })
    expect(facts.docker.engine_version).toBe('28.2.0')
    expect(facts.docker.gpu_runtime_from_config).toBe(false)
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['daemon-json-unreadable'])
  })

  it('Docker Desktop alone on Arch is detected from pacman -Q and gets the Desktop blocker, not arch-manual-install (item E)', async () => {
    const { facts, assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/arch.txt'),
      dockerVersion: ok('Docker version 28.3.2, build 578ccf6\n'),
      dockerInfo: DAEMON_DOWN_28_3, // Desktop listens on its own socket, not the system one
      pacmanPackages: { 'docker-desktop': '4.43.2-1' },
    })
    expect(facts.docker.install_method).toBe('docker-desktop')
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['docker-desktop-only'])
  })

  it("Docker Desktop next to Arch's own docker package does not shadow the engine, even with the socket refused (item E)", async () => {
    const { facts, assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/arch.txt'),
      dockerVersion: ok('Docker version 28.3.3, build 980b856\n'),
      dockerInfo: UNREACHABLE_28_3,
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      pacmanPackages: { 'docker': '1:28.3.3-1', 'docker-desktop': '4.43.2-1' },
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
      daemonJson: JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } }),
    })
    expect(facts.docker.install_method).toBeNull()
    expect(facts.docker.engine_version).toBe('28.3.3')
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['docker-group-manual'])
  })

  it('a ≥28.3 unreachable docker info keeps its ServerErrors for diagnostics, like the ≤28.2 shape (item 2)', async () => {
    const { facts } = await run({ dockerVersion: ok('Docker version 28.3.0, build afdd53b\n') })
    expect(facts.docker.daemon_reachable).toBe(false)
    expect(facts.docker.server_errors).toHaveLength(1)
    expect(facts.docker.server_errors[0]).toMatch(/permission denied/)
  })
})

describe('review-round fixes (task 2.4 fix round 5)', () => {
  const EFFECTIVE = { getentGroup: ok('docker:x:999:ana\n'), idNG: ok('ana docker sudo\n') }
  const NVIDIA_DAEMON_JSON = JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } })

  it('Ubuntu, Docker gone, group configured and effective: the apt plan, not docker-access-unexplained (item 1)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/ubuntu-26.04.txt'),
      dpkgQuery: dpkgNoneFound(),
      dockerInfo: DAEMON_DOWN_28_3,
      ...EFFECTIVE,
    })
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.blockers).toEqual([])
    // Already a member: no group step, and so no second relogin.
    expect(changeCodes(assessment)).toEqual([
      'add-repository',
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'enable-docker-service',
    ])
  })

  it('Ubuntu, docker.service stopped, everything else present, group effective: a plan that starts the service (item 1)', async () => {
    const { assessment } = await run({
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: DAEMON_DOWN_28_3,
      dpkgQuery: dpkgFound('dpkg/docker-ce-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      daemonJson: NVIDIA_DAEMON_JSON,
      ...EFFECTIVE, // systemctl is-active: the harness default, inactive (exit 3)
    })
    expect(assessment.blockers).toEqual([])
    expect(changeCodes(assessment)).toEqual(['enable-docker-service'])
  })

  it('the relogin promise holds: what the relogin blockers name, the next probe after the relogin plans (item 1)', async () => {
    const host: Machine = {
      osRelease: readLinuxProbeFixture('os-release/ubuntu-26.04.txt'),
      dpkgQuery: dpkgNoneFound(),
      dockerInfo: DAEMON_DOWN_28_3,
      getentGroup: ok('docker:x:999:ana\n'),
      idNG: ok('ana sudo\n'), // before: the session predates the membership
    }
    const before = await run(host)
    expect(before.assessment.blockers[0]?.reason).toBe('relogin-required')
    const promised = before.assessment.blockers.slice(1)
    for (const component of promised) expect(component.message).toMatch(/after you log back in, setup will/i)

    const after = await run({ ...host, idNG: ok('ana docker sudo\n') }) // same host, new session
    expect(after.assessment.availability).toBe('setup-required')
    const steps = changeCodes(after.assessment)
    const packages =
      after.assessment.install_plan?.system_changes.find((c) => c.code === 'install-packages')?.params
        ?.packages ?? ''
    const delivers: Record<string, () => boolean> = {
      'docker-cli-missing': () => packages.includes('docker-ce'),
      'toolkit-missing': () => packages.includes('nvidia-container-toolkit'),
      'gpu-runtime-not-configured': () => steps.includes('configure-nvidia-runtime'),
      'docker-service-inactive': () => steps.includes('enable-docker-service'),
    }
    expect(promised.map((b) => b.reason)).toEqual(Object.keys(delivers))
    for (const component of promised) expect(delivers[component.reason]?.()).toBe(true)
  })

  it('Arch, Docker gone, group effective: the pacman commands, without a usermod the account does not need (item 1)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/arch.txt'),
      pacmanPackages: {},
      dockerInfo: DAEMON_DOWN_28_3,
      getentGroup: ok('docker:x:959:ana\n'),
      idNG: ok('ana docker wheel\n'),
    })
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['arch-manual-install'])
    expect(assessment.blockers[0]?.commands).toEqual([
      'sudo pacman -Syu --needed docker nvidia-container-toolkit',
      'sudo nvidia-ctk runtime configure --runtime=docker',
      'sudo systemctl restart docker',
      'sudo systemctl enable --now docker',
    ])
    expect(assessment.blockers[0]?.message).not.toMatch(/new docker group membership/)
  })

  it('Silverblue, Docker gone, group effective: immutable-os naming both missing packages, not access-unexplained (items 1, 2)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-silverblue-43.txt'),
      ostreeBooted: true,
      rpmQuery: rpmNoneFound(),
      dockerInfo: DAEMON_DOWN_28_3,
      getentGroup: ok('docker:x:981:ana\n'),
      idNG: ok('ana docker wheel\n'),
    })
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['immutable-os'])
    expect(assessment.blockers[0]?.params).toEqual({ missing: 'docker,nvidia-container-toolkit' })
  })

  it('Silverblue with moby-engine but no toolkit: immutable-os names only the toolkit, never "install docker-ce" (item 2)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-silverblue-43.txt'),
      ostreeBooted: true,
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/moby-engine-no-toolkit.json')),
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
    })
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['immutable-os'])
    expect(assessment.blockers[0]?.params).toEqual({ missing: 'nvidia-container-toolkit' })
    expect(assessment.blockers[0]?.message).not.toMatch(/docker-ce|Docker Engine/)
  })

  it('Silverblue with Docker and the toolkit installed, only runtime and service missing: those steps, not immutable-os (item 2)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-silverblue-43.txt'),
      ostreeBooted: true,
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: DAEMON_DOWN_28_3,
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      ...EFFECTIVE,
    })
    expect(assessment.install_plan).toBeNull()
    expect(assessment.blockers).toEqual([
      expect.objectContaining({
        reason: 'gpu-runtime-not-configured',
        commands: ['sudo nvidia-ctk runtime configure --runtime=docker', 'sudo systemctl restart docker'],
      }),
      expect.objectContaining({
        reason: 'docker-service-inactive',
        commands: ['sudo systemctl enable --now docker'],
      }),
    ])
  })

  it('Silverblue, only runtime missing, account not in the group: the runtime steps plus the idempotent group commands (item 2)', async () => {
    const { assessment } = await run({
      osRelease: readLinuxProbeFixture('os-release/fedora-silverblue-43.txt'),
      ostreeBooted: true,
      dockerVersion: ok('Docker version 27.1.1, build 30da79c\n'),
      dockerInfo: UNREACHABLE_28_3,
      rpmQuery: rpmFound('rpm/moby-engine-installed.txt'),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
      systemctlIsActive: ok('active\n'),
      getentGroup: { code: 2, stdout: '', stderr: '' },
    })
    expect(assessment.blockers.map((b) => b.reason)).toEqual([
      'gpu-runtime-not-configured',
      'docker-group-manual',
    ])
    expect(assessment.blockers[1]?.commands).toEqual([
      "grep -q '^docker:' /etc/group || grep -E '^docker:' /usr/lib/group | sudo tee -a /etc/group",
      'sudo usermod -aG docker ana',
    ])
    expect(assessment.blockers[1]?.message).not.toMatch(/everything else is ready/i)
  })

  it('pacman is only asked on a pacman-family distribution (item 3)', async () => {
    const asked: string[] = []
    const deps = depsFor({ dpkgQuery: dpkgNoneFound() })
    const tracked: LinuxProbeDeps = {
      ...deps,
      exec: async (command, args, env) => {
        asked.push(command)
        return deps.exec(command, args, env)
      },
    }
    await probeLinux(tracked, { user: 'ana', xdgRuntimeDir: null })
    expect(asked).not.toContain('pacman')

    asked.length = 0
    const arch = depsFor({ osRelease: readLinuxProbeFixture('os-release/arch.txt'), pacmanPackages: {} })
    await probeLinux(
      { ...arch, exec: async (c, a, e) => (asked.push(c), arch.exec(c, a, e)) },
      { user: 'ana', xdgRuntimeDir: null }
    )
    expect(asked).toContain('pacman')
  })
})

describe('a host that does not run systemd (the GB10 vast.ai container: PID 1 is bash, no /run/systemd/system)', () => {
  const NO_SYSTEMD = new Set(['/run/systemd/system'])
  // `systemctl is-active docker` on such a host: the binary may exist, systemd is not running.
  const OFFLINE = {
    code: 1,
    stdout: 'offline\n',
    stderr: 'System has not been booted with systemd as init system (PID 1).\n',
  }

  it('reads the init system from /run/systemd/system, the sd_booted() test', async () => {
    expect((await run({})).facts.systemd).toBe(true)
    expect((await run({ pathMissing: NO_SYSTEMD })).facts.systemd).toBe(false)
    const unread = (await run({ pathUnreadable: NO_SYSTEMD })).facts
    expect(unread.systemd).toBeNull()
    expect(unread.unknown).toContain('init-system')
  })

  it.each<[string, Machine]>([
    ['a clean Ubuntu (full install plan)', { dpkgQuery: dpkgNoneFound() }],
    [
      'the GB10 container: aarch64, captured nvidia-smi, clean Ubuntu 24.04',
      {
        uname: ok('aarch64\n'),
        nvidiaSmi: ok(readLinuxProbeFixture('nvidia-smi/gb10-driver595-captured.csv')),
        dpkgQuery: dpkgNoneFound(),
      },
    ],
  ])(
    '%s: blocked with init-not-systemd instead of a plan whose service steps would fail after consent',
    async (_label, machine) => {
      const { assessment } = await run({ ...machine, pathMissing: NO_SYSTEMD, systemctlIsActive: OFFLINE })
      expect(assessment).toEqual({
        availability: 'prerequisite-blocked',
        adopts_existing_engine: false,
        install_plan: null,
        blockers: [initNotSystemdBlocker()],
      })
      expect(assessment.blockers[0]?.message).toBe(
        'This system does not run systemd, which the Docker install needs.'
      )
    }
  )

  it('an init system that could not be read is an unknown fact, like every other unread fact: blocked, adopt or not', async () => {
    const unknownFact = {
      reason: 'unknown-fact',
      message: 'Could not determine init-system on this system.',
      params: { fact: 'init-system' },
    }
    const clean = await run({ dpkgQuery: dpkgNoneFound(), pathUnreadable: NO_SYSTEMD })
    expect(clean.assessment.install_plan).toBeNull()
    expect(clean.assessment.blockers).toEqual([unknownFact])
    const ready = await run({
      pathUnreadable: NO_SYSTEMD,
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
    })
    expect(ready.assessment.adopts_existing_engine).toBe(false)
    expect(ready.assessment.blockers).toEqual([unknownFact])
  })

  it('still adopts a host whose Docker already answers with a GPU runtime: nothing needs systemd then', async () => {
    const { assessment } = await run({
      pathMissing: NO_SYSTEMD,
      systemctlIsActive: OFFLINE,
      dockerVersion: ok('Docker version 28.3.0, build afdd53b\n'),
      dockerInfo: ok(readLinuxProbeFixture('docker-info/ready-nvidia-runtime.json')),
      nvidiaCtkVersion: ok('NVIDIA Container Toolkit CLI version 1.17.4\n'),
    })
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.blockers).toEqual([])
  })

  it('a universal blocker still comes first: an old driver is named, not the init system', async () => {
    const { assessment } = await run({
      pathMissing: NO_SYSTEMD,
      nvidiaSmi: ok(readLinuxProbeFixture('nvidia-smi/rtx4070-driver580.csv')),
    })
    expect(assessment.blockers.map((b) => b.reason)).toEqual(['driver-too-old'])
  })
})

describe('generic prerequisite blockers, also driven through probeLinux like everything else above', () => {
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
