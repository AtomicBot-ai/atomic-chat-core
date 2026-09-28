import { describe, expect, it } from 'vitest'
import {
  archCommands,
  blocker,
  effectiveGpuRuntime,
  gateBlocker,
  gateBlockerApplies,
  groupOnlyCommands,
  installMethodBlocker,
  missingComponentBlockers,
  reloginRequiredBlocker,
  type InstallGate,
} from './linux-blockers.js'
import type { LinuxDistribution, LinuxFacts } from './linux-probe.js'

describe('blocker', () => {
  it('omits params and commands when neither is given, rather than storing them as undefined', () => {
    expect(blocker('driver-missing', 'No NVIDIA driver was found.')).toEqual({
      reason: 'driver-missing',
      message: 'No NVIDIA driver was found.',
    })
  })

  it('carries params and commands through when given', () => {
    expect(
      blocker('driver-too-old', 'too old', { required: '590', actual: '580' }, ['do this', 'then this'])
    ).toEqual({
      reason: 'driver-too-old',
      message: 'too old',
      params: { required: '590', actual: '580' },
      commands: ['do this', 'then this'],
    })
  })
})

describe('installMethodBlocker', () => {
  it('blocks snap, rootless, Docker Desktop and podman-docker, each with its own reason', () => {
    expect(installMethodBlocker('snap')?.reason).toBe('docker-snap')
    expect(installMethodBlocker('rootless')?.reason).toBe('docker-rootless')
    expect(installMethodBlocker('docker-desktop')?.reason).toBe('docker-desktop-only')
    expect(installMethodBlocker('podman-docker')?.reason).toBe('podman-docker')
  })

  it('says podman-docker must be removed before docker-ce, and that core removes nothing itself', () => {
    const message = installMethodBlocker('podman-docker')?.message ?? ''
    expect(message).toMatch(/removed first/i)
    expect(message).toMatch(/nothing here removes/i)
  })

  it('does not block a recognised distro package or an install this probe never identified', () => {
    expect(installMethodBlocker('docker-ce')).toBeNull()
    expect(installMethodBlocker('moby-engine')).toBeNull()
    expect(installMethodBlocker('docker.io')).toBeNull()
    expect(installMethodBlocker(null)).toBeNull()
  })
})

const dockerFacts = (over: Partial<LinuxFacts['docker']> = {}): LinuxFacts['docker'] => ({
  cli: true,
  daemon_reachable: false,
  engine_identity: null,
  version: null,
  install_method: 'docker-ce',
  engine_version: null,
  gpu_runtime: false,
  gpu_runtime_from_config: false,
  daemon_json_unreadable: false,
  selinux: false,
  docker_root_dir: null,
  containers_running: 0,
  service_active: 'unknown',
  server_errors: [],
  ...over,
})

describe('effectiveGpuRuntime', () => {
  it('trusts live docker info when the daemon is reachable, ignoring offline evidence entirely', () => {
    const facts = {
      docker: dockerFacts({ daemon_reachable: true, gpu_runtime: true, gpu_runtime_from_config: false }),
    } as LinuxFacts
    expect(effectiveGpuRuntime(facts)).toBe(true)
  })

  it('falls back to offline evidence only when the daemon could not be reached', () => {
    const facts = {
      docker: dockerFacts({ daemon_reachable: false, gpu_runtime: true, gpu_runtime_from_config: false }),
    } as LinuxFacts
    // gpu_runtime here is stale/meaningless (ABSENT sets it false in practice, but even if it were
    // somehow true this must never be trusted without a live answer).
    expect(effectiveGpuRuntime(facts)).toBe(false)
  })
})

describe('groupOnlyCommands', () => {
  it('is a single usermod on an ordinary host', () => {
    expect(groupOnlyCommands(false, 'ana')).toEqual(['sudo usermod -aG docker ana'])
  })

  it('copies the group line from /usr/lib/group first on an rpm-ostree host, only if /etc/group lacks it (ruling 6; round 4 item F)', () => {
    expect(groupOnlyCommands(true, 'ana')).toEqual([
      "grep -q '^docker:' /etc/group || grep -E '^docker:' /usr/lib/group | sudo tee -a /etc/group",
      'sudo usermod -aG docker ana',
    ])
  })
})

describe('archCommands', () => {
  it('ends with usermod for the probed account, not the literal $USER (ruling 8)', () => {
    expect(archCommands('ana')).toEqual([
      'sudo pacman -Syu --needed docker nvidia-container-toolkit',
      'sudo nvidia-ctk runtime configure --runtime=docker',
      'sudo systemctl restart docker',
      'sudo systemctl enable --now docker',
      'sudo usermod -aG docker ana',
    ])
  })

  it('omits usermod entirely for root, which needs no group membership (ruling 8)', () => {
    const commands = archCommands('root')
    expect(commands.some((c) => c.includes('usermod'))).toBe(false)
    expect(commands).toHaveLength(4)
  })
})

describe('reloginRequiredBlocker', () => {
  it('has nothing to run by hand: the fix is a new login session', () => {
    expect(reloginRequiredBlocker()).toEqual(
      expect.objectContaining({ reason: 'relogin-required', commands: [] })
    )
  })
})

const UBUNTU: LinuxDistribution = { id: 'ubuntu', version_id: '24.04', id_like: [], family: 'apt' }

const hostFacts = (docker: Partial<LinuxFacts['docker']>, over: Partial<LinuxFacts> = {}): LinuxFacts =>
  ({
    architecture: 'x86_64',
    distribution: UBUNTU,
    immutable_os: false,
    toolkit_installed: true,
    docker_group: { configured: false, effective: false },
    docker: dockerFacts({ service_active: true, gpu_runtime_from_config: true, ...docker }),
    ...over,
  }) as LinuxFacts

describe('gateBlocker', () => {
  it('names the reason automatic install is not offered, one per gate', () => {
    const facts = hostFacts({})
    const reasons: Array<[Exclude<InstallGate, 'recipe'>, string]> = [
      ['immutable', 'immutable-os'],
      ['pacman', 'arch-manual-install'],
      ['unrecognised', 'docker-unrecognised'],
      ['unqualified', 'distribution-not-in-recipe'],
    ]
    for (const [gate, reason] of reasons) {
      expect(gateBlocker(gate, facts, UBUNTU, 'ana').reason).toBe(reason)
    }
    expect(gateBlocker('unqualified', facts, UBUNTU, 'ana').params).toEqual({
      id: 'ubuntu',
      version_id: '24.04',
      arch: 'x86_64',
    })
    expect(gateBlocker('pacman', facts, UBUNTU, 'ana').commands).toEqual(archCommands('ana'))
  })
})

describe('missingComponentBlockers (round 4, item 1)', () => {
  it('is empty when nothing but the session is missing', () => {
    expect(missingComponentBlockers(hostFacts({}), 'recipe')).toEqual([])
  })

  it('names each missing component once, in install order', () => {
    const facts = hostFacts(
      { cli: false, install_method: null, service_active: false, gpu_runtime_from_config: false },
      { toolkit_installed: false }
    )
    expect(missingComponentBlockers(facts, 'recipe').map((b) => b.reason)).toEqual([
      'docker-cli-missing',
      'toolkit-missing',
      'gpu-runtime-not-configured',
      'docker-service-inactive',
    ])
  })

  it('does not call an unknown service state inactive', () => {
    expect(missingComponentBlockers(hostFacts({ service_active: 'unknown' }), 'recipe')).toEqual([])
  })

  it('reports an unreadable daemon.json instead of an unconfigured runtime', () => {
    const facts = hostFacts({ gpu_runtime_from_config: false, daemon_json_unreadable: true })
    expect(missingComponentBlockers(facts, 'recipe').map((b) => b.reason)).toEqual(['daemon-json-unreadable'])
  })

  it('promises setup only on a recipe distribution; Arch gets pacman commands; elsewhere package steps are manual', () => {
    const facts = hostFacts(
      { gpu_runtime_from_config: false, service_active: false },
      { toolkit_installed: false }
    )
    const recipe = missingComponentBlockers(facts, 'recipe')
    expect(recipe.every((b) => /after you log back in/i.test(b.message) && b.commands?.length === 0)).toBe(
      true
    )

    expect(missingComponentBlockers(facts, 'pacman').map((b) => b.commands)).toEqual([
      ['sudo pacman -Syu --needed nvidia-container-toolkit'],
      ['sudo nvidia-ctk runtime configure --runtime=docker', 'sudo systemctl restart docker'],
      ['sudo systemctl enable --now docker'],
    ])

    const elsewhere = missingComponentBlockers(facts, 'unqualified')
    expect(elsewhere.map((b) => b.commands)).toEqual([
      [],
      ['sudo nvidia-ctk runtime configure --runtime=docker', 'sudo systemctl restart docker'],
      ['sudo systemctl enable --now docker'],
    ])
    expect(elsewhere.some((b) => /after you log back in/i.test(b.message))).toBe(false)
  })
})

describe('gateBlockerApplies (round 5, item 2)', () => {
  it('is one decision for both paths: never on recipe, on an immutable base only when a package is missing', () => {
    const ready = hostFacts({})
    const noToolkit = hostFacts({}, { toolkit_installed: false })
    const noDocker = hostFacts({ cli: false, install_method: null })
    expect(gateBlockerApplies('recipe', noDocker)).toBe(false)
    expect(gateBlockerApplies('immutable', ready)).toBe(false)
    expect(gateBlockerApplies('immutable', noToolkit)).toBe(true)
    expect(gateBlockerApplies('immutable', noDocker)).toBe(true)
    for (const gate of ['pacman', 'unrecognised', 'unqualified'] as const) {
      expect(gateBlockerApplies(gate, ready)).toBe(true)
    }
  })
})

describe('immutable-os wording (round 5, item 2)', () => {
  it('names exactly the missing packages, and never tells a host with an engine to install docker-ce', () => {
    const toolkitOnly = gateBlocker('immutable', hostFacts({}, { toolkit_installed: false }), UBUNTU, 'ana')
    expect(toolkitOnly.params).toEqual({ missing: 'nvidia-container-toolkit' })
    expect(toolkitOnly.message).toMatch(/NVIDIA Container Toolkit/)
    expect(toolkitOnly.message).not.toMatch(/docker-ce|Docker Engine/)

    const both = gateBlocker(
      'immutable',
      hostFacts({ cli: false, install_method: null }, { toolkit_installed: false }),
      UBUNTU,
      'ana'
    )
    expect(both.params).toEqual({ missing: 'docker,nvidia-container-toolkit' })
  })
})

describe('archCommands for an account already in the group (round 5, item 1)', () => {
  it('omits usermod when the group add is not needed', () => {
    expect(archCommands('ana', false).some((c) => c.includes('usermod'))).toBe(false)
    expect(archCommands('ana').at(-1)).toBe('sudo usermod -aG docker ana')
  })
})
