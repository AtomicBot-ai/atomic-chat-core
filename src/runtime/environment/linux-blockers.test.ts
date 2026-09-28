import { describe, expect, it } from 'vitest'
import {
  archCommands,
  blocker,
  effectiveGpuRuntime,
  groupOnlyCommands,
  installMethodBlocker,
} from './linux-blockers.js'
import type { LinuxFacts } from './linux-probe.js'

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

  it('copies the group line from /usr/lib/group first on an rpm-ostree host (ruling 6)', () => {
    expect(groupOnlyCommands(true, 'ana')).toEqual([
      "grep -E '^docker:' /usr/lib/group | sudo tee -a /etc/group",
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
