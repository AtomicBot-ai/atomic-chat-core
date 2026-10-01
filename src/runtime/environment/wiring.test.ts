import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  CoreEvents,
  ManagedHostStep,
  RequirementPlan,
  RuntimeDescriptor,
  RuntimeInstallation,
  Sha256Digest,
} from '../../contracts/index.js'
import type { DataFolderEnv } from '../../config/index.js'
import { RUNTIME_DESCRIPTOR_URL_ENV } from './descriptor-provider.js'
import { ENVIRONMENT_MANIFEST_URL_ENV } from './environment-manifest-provider.js'
import { fakeWindows } from '../../../test/helpers/fake-windows-host.js'
import type { DescriptorProviderResult, RuntimeDescriptorProvider } from './descriptor-provider.js'
import type { EnvironmentProvisioner } from './service.js'
import {
  environmentAvailability,
  executorFor,
  provisionerFor,
  resolveMinimumAppVersion,
  wireManagedRuntimes,
} from './wiring.js'
import type { ManagedRuntimes } from './wiring.js'
import { answer, type FakeLinuxHostState } from '../../../test/helpers/fake-linux-host.mjs'
import { readLinuxProbeFixture } from '../../../test/helpers/linux-probe-fixtures.js'
import {
  INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  installContainerRuntimeParametersDigest,
  parametersFromPlan,
  type InstallContainerRuntimeParameters,
} from '../../host/recipes/index.js'
import type { LinuxProvisionerParts } from './wiring.js'

/** A pid that existed and is now gone: what a crashed core's process leaves behind (finding 1). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true })
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid as number
}

const DIGEST = `sha256:${'a'.repeat(64)}` as Sha256Digest

let root: string
/** Every service a test built, so none is still writing when the directory goes away. */
let wired: ManagedRuntimes[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-managed-'))
  wired = []
})
afterEach(async () => {
  for (const managed of wired) await managed.shutdown(AbortSignal.timeout(1_000)).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

/** A machine environment pointed at a scratch directory, never at the real per-user one. */
const env = (platform: NodeJS.Platform, extraEnv: Record<string, string> = {}): DataFolderEnv => ({
  platform,
  env: { ATOMIC_CORE_MANAGED_ROOT: root, ...extraEnv },
  homedir: '/home/u',
  exists: () => false,
  readFile: () => undefined,
})

const plan: RequirementPlan = {
  plan_digest: DIGEST,
  environment_id: 'default',
  target: { kind: 'environment' },
  availability: 'setup-required',
  recipe_id: 'ubuntu-24.04-docker-ce',
  recipe_digest: DIGEST,
  descriptor_id: null,
  environment_manifest_id: null,
  image_digest: null,
  adopts_existing_engine: true,
  system_changes: [],
  download_bytes: null,
  required_disk_bytes: null,
  docker_root_dir: null,
  free_disk_bytes: null,
  warnings: [],
  requires_elevation: false,
  may_require_relogin: false,
  may_require_reboot: false,
  blockers: [],
}

/** Enough of a recipe to let an operation run to the end, so the view can be watched changing. */
const fakeProvisioner = (hostStep: ManagedHostStep | null = null): EnvironmentProvisioner => ({
  probe: async () => ({ plan, host_step: hostStep }),
  verifyHostStep: async () => ({ prerequisites_met: true, needs_relogin: false, error: null }),
  prepare: async () => undefined,
  pull: async () => undefined,
  verify: async () => undefined,
  unloadResident: async () => undefined,
  activate: async () => undefined,
  remove: async () => undefined,
  cleanup: async () => undefined,
  inventory: {
    inspect: async () => ({ kind: 'absent' }) as const,
    needsRelogin: async () => false,
    needsReboot: async () => false,
    verifyCompletedSteps: async () => [],
    currentPlanDigest: async () => DIGEST,
  },
})

const wire = (platform: NodeJS.Platform, provisioner?: EnvironmentProvisioner | null, ownerPid?: number) => {
  const events: { name: string; phase: string }[] = []
  let serial = 0
  const managed = wireManagedRuntimes({
    env: env(platform),
    instanceId: 'core-1',
    platform,
    emit: ((name: string, payload: CoreEvents['environment:operation']) => {
      events.push({ name, phase: payload.phase })
    }) as never,
    newId: () => `id-${(serial += 1)}`,
    ...(provisioner === undefined ? {} : { provisioner }),
    ...(ownerPid === undefined ? {} : { ownerPid }),
  })
  wired.push(managed)
  return { managed, events }
}

describe('which machines can carry a managed runtime', () => {
  it('names the container engine each platform drives: Docker on Linux, Docker in WSL on Windows, none elsewhere', () => {
    // Windows (change `add-tensorrt-llm-windows`): Docker in Atomic Chat's own WSL distribution.
    expect(executorFor('linux')).toBe('linux-docker')
    expect(executorFor('win32')).toBe('wsl-docker')
    expect(executorFor('darwin')).toBeNull()
    expect(executorFor('freebsd')).toBeNull()
  })

  it('offers no environment at all where no engine applies', () => {
    const { managed } = wire('darwin')
    // Not an environment that cannot be set up: there is nothing here to set up.
    expect(managed.environments()).toEqual([])
  })

  it('offers the WSL environment on Windows, unsupported until its host parts are supplied', () => {
    const environment = wire('win32').managed.environments()[0]
    expect(environment?.executor).toBe('wsl-docker')
    expect(environment?.availability).toBe('unsupported')
    expect(environment?.distribution).toBeNull()
  })

  it('offers one environment per user on a platform that could carry it', () => {
    const { managed } = wire('linux')
    expect(managed.environments()).toHaveLength(1)
    expect(managed.environments()[0]?.executor).toBe('linux-docker')
    expect(managed.environments()[0]?.environment_id).toBe('default')
  })

  it('says unsupported while no host recipe exists, rather than inviting a setup that cannot run', () => {
    // Without the host-side parts the owner supplies, even Linux has no recipe.
    expect(provisionerFor('linux')).toBeNull()
    expect(provisionerFor('win32')).toBeNull()
    expect(wire('linux').managed.environments()[0]?.availability).toBe('unsupported')
    expect(wire('linux', fakeProvisioner()).managed.environments()[0]?.availability).toBe('setup-required')
  })
})

describe('what a snapshot shows', () => {
  it('starts with nothing in flight', () => {
    const { managed } = wire('linux', fakeProvisioner())
    expect(managed.operations()).toEqual([])
    expect(managed.environments()[0]?.active_operation_id).toBeNull()
  })

  it('carries the operation while it runs and lets go of it once it is over', async () => {
    const { managed, events } = wire('linux', fakeProvisioner())
    const started = await managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
      approved_plan_digest: DIGEST,
    })
    await managed.service.idle()

    const operations = managed.operations()
    expect(operations).toHaveLength(1)
    expect(operations[0]?.operation_id).toBe(started.operation_id)
    expect(operations[0]?.phase).toBe('ready')
    // Finished: nothing is in flight on the environment any more.
    expect(managed.environments()[0]?.active_operation_id).toBeNull()
    // And every state it passed through was announced, so a client can follow from the snapshot.
    expect(events.map((event) => event.phase)).toEqual([
      'checking',
      'preparing-environment',
      'verifying',
      'ready',
    ])
    expect(events.every((event) => event.name === 'environment:operation')).toBe(true)
  })

  it('points at the operation that is still waiting on the user', async () => {
    const step: ManagedHostStep = {
      step_id: 'step-1',
      action: 'linux.install-container-runtime',
      recipe_id: 'ubuntu-24.04-docker-ce',
      recipe_digest: DIGEST,
      parameters_digest: DIGEST,
      parameters: {
        user: 'ada',
        arch: 'x86_64',
        family: 'apt',
        distro_id: 'ubuntu',
        version_id: '24.04',
        components: ['docker-engine'],
      },
      nonce: 'once-1',
      expected_operation_revision: 1,
    }
    const { managed } = wire('linux', fakeProvisioner(step))
    const started = await managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
      approved_plan_digest: DIGEST,
    })
    await managed.service.idle()

    expect(managed.environments()[0]?.active_operation_id).toBe(started.operation_id)
    expect(managed.operations()[0]?.phase).toBe('preparing-host')
  })
})

describe('coming back to what a previous core left', () => {
  it('reads an unfinished operation back before anything is served', async () => {
    const first = wire('linux', fakeProvisioner())
    await first.managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
      // No approval, so it stops at awaiting-consent and is still unfinished.
    })
    await first.managed.service.idle()
    expect(first.managed.operations()[0]?.phase).toBe('awaiting-consent')

    // A new core over the same shared root, as a restart really is.
    const second = wire('linux', fakeProvisioner())
    expect(second.managed.operations()).toEqual([])
    await second.managed.recover()

    const recovered = second.managed.operations()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.request_id).toBe('req-1')
  })

  it('reconciles an operation whose recorded owner is a process that no longer exists', async () => {
    const dead = await deadPid()
    const first = wire('linux', fakeProvisioner(), dead)
    await first.managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
    })
    await first.managed.service.idle()
    const before = first.managed.operations()[0]
    expect(before?.phase).toBe('awaiting-consent')

    // A genuinely different core: not a restart replaying the same pid, but the real dead-owner
    // case this fix exists for (finding 1).
    const second = wire('linux', fakeProvisioner())
    await second.managed.recover()
    await second.managed.service.idle()

    const after = second.managed.operations()[0]
    expect(after?.phase).toBe('awaiting-consent')
    // Reconciled, not merely made visible from disk: the machine was actually looked at again.
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0)
  })

  it('leaves an operation alone whose recorded owner is this very process', async () => {
    const first = wire('linux', fakeProvisioner())
    await first.managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
    })
    await first.managed.service.idle()
    const before = first.managed.operations()[0]

    // Another core wired in the same test process is, in truth, exactly as alive as the first —
    // real app and CLI cores sharing this store are two different processes, but never two cores
    // that are each other's ghost the moment one starts.
    const second = wire('linux', fakeProvisioner())
    await second.managed.recover()

    const after = second.managed.operations()[0]
    expect(after?.revision).toBe(before?.revision)
    expect(after?.phase).toBe('awaiting-consent')
  })

  it('has nothing to recover on a machine that cannot carry one', async () => {
    const { managed } = wire('darwin')
    await managed.recover()
    expect(managed.operations()).toEqual([])
  })

  it('stops what is in flight on shutdown and leaves the record behind', async () => {
    const { managed } = wire('linux', fakeProvisioner())
    await managed.service.begin('default', {
      request_id: 'req-1',
      target: { kind: 'environment' },
      kind: 'setup',
      descriptor_id: 'trtllm',
    })
    await managed.shutdown(AbortSignal.timeout(1_000))

    const next = wire('linux', fakeProvisioner())
    await next.managed.recover()
    expect(next.managed.operations()).toHaveLength(1)
  })
})

describe('the descriptor provider this wiring builds (task 2.3)', () => {
  /** The real fixture (`descriptor_id` `tensorrt-llm-1.2.1-r2`, `minimum_core_version` `0.7.5`). */
  const fixtureUrl = new URL('../../../test/fixtures/runtimes/tensorrt-llm.json', import.meta.url).href

  it('reads a file:// override end to end and caches it under the wired managed root', async () => {
    const managed = wireManagedRuntimes({
      env: env('linux', { [RUNTIME_DESCRIPTOR_URL_ENV]: fixtureUrl }),
      instanceId: 'core-1',
      platform: 'linux',
      emit: () => undefined,
      newId: () => 'id-1',
    })
    wired.push(managed)

    const result = await managed.descriptors.forNewSetup()
    expect(result.kind).toBe('available')
    if (result.kind === 'available') {
      expect(result.descriptor.descriptor_id).toBe('tensorrt-llm-1.2.1-r2')
    }

    // A later installation pinned to this id resolves from the cache this wiring just wrote,
    // with no further reads of the file:// source.
    const pinned = await managed.descriptors.forInstallation('tensorrt-llm-1.2.1-r2')
    expect(pinned).toEqual(result)
  })

  it('has nothing cached and no network by default: forNewSetup is honestly unsupported', async () => {
    const managed = wireManagedRuntimes({
      env: env('linux'),
      instanceId: 'core-1',
      platform: 'linux',
      emit: () => undefined,
      newId: () => 'id-1',
      // No real network in a unit test: an unresolvable host makes the one fetch attempt fail
      // fast instead of hitting the timeout, so this stays quick without stubbing global fetch.
      fetch: (() => Promise.reject(new Error('no network in this test'))) as typeof fetch,
    })
    wired.push(managed)

    const result = await managed.descriptors.forNewSetup()
    expect(result.kind).toBe('unsupported')
  })

  it('minimum_app_version stays null before the first recover(), and after it with nothing cached', async () => {
    const { managed } = wire('linux', fakeProvisioner())
    expect(managed.environments()[0]?.minimum_app_version).toBeNull()
    await managed.recover()
    expect(managed.environments()[0]?.minimum_app_version).toBeNull()
  })

  it('recover() fills minimum_app_version from the latest accepted cache once one exists', async () => {
    const managed = wireManagedRuntimes({
      env: env('linux', { [RUNTIME_DESCRIPTOR_URL_ENV]: fixtureUrl }),
      instanceId: 'core-1',
      platform: 'linux',
      emit: () => undefined,
      newId: () => 'id-1',
    })
    wired.push(managed)
    // Seeds the cache the way a real setup probe eventually will (task 2.4); recover() itself
    // never fetches, so this is what makes "latest accepted" non-empty for it to read.
    await managed.descriptors.forNewSetup()

    await managed.recover()

    expect(managed.environments()[0]?.minimum_app_version).toBe('2.0.49')
  })

  it('lets the service read a cached descriptor back by id (task 2.22), and nothing it has not cached', async () => {
    const managed = wireManagedRuntimes({
      env: env('linux', { [RUNTIME_DESCRIPTOR_URL_ENV]: fixtureUrl }),
      instanceId: 'core-1',
      platform: 'linux',
      emit: () => undefined,
      newId: () => 'id-1',
      provisioner: fakeProvisioner(),
    })
    wired.push(managed)
    await expect(managed.service.descriptor('tensorrt-llm-1.2.1-r2')).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
    await managed.descriptors.forNewSetup()
    const summary = await managed.service.descriptor('tensorrt-llm-1.2.1-r2')
    expect(summary.descriptor_id).toBe('tensorrt-llm-1.2.1-r2')
    expect(summary.notices.length).toBeGreaterThan(0)
  })
})

describe('resolveMinimumAppVersion', () => {
  const installation = (activeDescriptorId: string | null): RuntimeInstallation => ({
    installation_id: 'inst-1',
    engine_id: 'tensorrt-llm',
    environment_id: 'default',
    active_descriptor_id: activeDescriptorId,
    candidate_descriptor_id: null,
    availability: 'supported',
    status: 'ready',
  })

  const unsupported = (): DescriptorProviderResult => ({
    kind: 'unsupported',
    error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'nothing here'),
  })
  // resolveMinimumAppVersion only ever reads `.descriptor.minimum_app_version`; a full RuntimeDescriptor
  // is real product data this unit test has no business fabricating field-by-field.
  const available = (minimum_app_version: string): DescriptorProviderResult => ({
    kind: 'available',
    descriptor: { minimum_app_version } as unknown as RuntimeDescriptor,
  })

  const fakeDescriptors = (opts: {
    forInstallation?: RuntimeDescriptorProvider['forInstallation']
    cachedForNewSetup?: RuntimeDescriptorProvider['cachedForNewSetup']
  }): RuntimeDescriptorProvider => ({
    forNewSetup: () => {
      throw new Error('resolveMinimumAppVersion must never call forNewSetup (it would reach the network)')
    },
    forInstallation: opts.forInstallation ?? (async () => unsupported()),
    cachedForNewSetup: opts.cachedForNewSetup ?? (async () => unsupported()),
  })

  it('pinned: a pinned installation wins, resolved without ever reaching the network fallback', async () => {
    const forInstallation = vi.fn(async (id: string) => {
      expect(id).toBe('tensorrt-llm-1.2.1-r2')
      return available('2.0.49')
    })
    const cachedForNewSetup = vi.fn(async () => available('9.9.9'))
    const descriptors = fakeDescriptors({ forInstallation, cachedForNewSetup })

    const result = await resolveMinimumAppVersion(descriptors, [installation('tensorrt-llm-1.2.1-r2')])

    expect(result).toBe('2.0.49')
    expect(cachedForNewSetup).not.toHaveBeenCalled()
  })

  it('latest-only: no pinned installation falls back to the latest accepted cache', async () => {
    const descriptors = fakeDescriptors({ cachedForNewSetup: async () => available('2.0.49') })

    // An installation that exists but has not pinned anything yet (still installing) does not count.
    const result = await resolveMinimumAppVersion(descriptors, [installation(null)])

    expect(result).toBe('2.0.49')
  })

  it('none: no installation and nothing cached resolves null', async () => {
    const descriptors = fakeDescriptors({})

    expect(await resolveMinimumAppVersion(descriptors, [])).toBeNull()
  })
})

describe('resolveMinimumAppVersion picks the provider engine’s own installation (carry item 4)', () => {
  it('ignores a pinned installation of another engine', async () => {
    const forInstallation = vi.fn(async () => ({
      kind: 'available' as const,
      descriptor: { minimum_app_version: '1.0.0' } as unknown as RuntimeDescriptor,
    }))
    const descriptors: RuntimeDescriptorProvider = {
      forNewSetup: async () => {
        throw new Error('never')
      },
      forInstallation,
      cachedForNewSetup: async () => ({
        kind: 'available',
        descriptor: { minimum_app_version: '2.0.49' } as unknown as RuntimeDescriptor,
      }),
    }
    const other: RuntimeInstallation = {
      installation_id: 'vllm',
      engine_id: 'vllm',
      environment_id: 'default',
      active_descriptor_id: 'vllm-1',
      candidate_descriptor_id: null,
      availability: 'supported',
      status: 'ready',
    }
    expect(await resolveMinimumAppVersion(descriptors, [other])).toBe('2.0.49')
    expect(forInstallation).not.toHaveBeenCalled()
  })
})

describe('environmentAvailability', () => {
  const ready = { status: 'ready' } as RuntimeInstallation
  it('is unsupported without a recipe, the probe’s verdict otherwise, supported once installed', () => {
    expect(environmentAvailability(false, 'setup-required', [ready])).toBe('unsupported')
    expect(environmentAvailability(true, null, [])).toBe('setup-required')
    expect(environmentAvailability(true, 'setup-required', [ready])).toBe('supported')
    expect(environmentAvailability(true, 'prerequisite-blocked', [ready])).toBe('prerequisite-blocked')
  })
})

describe('the Linux recipe wired end to end over a fake machine (task 2.6)', () => {
  const fixtureUrl = new URL('../../../test/fixtures/runtimes/tensorrt-llm.json', import.meta.url).href
  const manifestUrl = new URL('../../../test/fixtures/runtimes/environments/linux.json', import.meta.url).href

  it('probes, sets up, and shows the ready installation and the GPUs in the snapshot', async () => {
    let state: FakeLinuxHostState = {
      user: 'ada',
      driver: '590.44.01',
      gpus: [
        { uuid: 'GPU-1', name: 'NVIDIA GeForce RTX 4090', cc: '8.9', total_mib: 24564, free_mib: 24000 },
      ],
      docker: { installed: true, reachable: true, service_active: true, gpu_runtime: true },
      toolkit: true,
      group: { configured: true, effective: true },
      gpu_visible_in_container: true,
      images: [],
    }
    const run = (command: string, args: string[]) => {
      const result = answer(state, command, args)
      if (result.next !== undefined) state = result.next
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    }
    const linux: LinuxProvisionerParts = {
      host: {
        probeDeps: {
          exec: async (command, args) => run(command, args),
          readFile: async (path) =>
            path === '/etc/os-release' ? readLinuxProbeFixture('os-release/ubuntu-24.04.txt') : null,
          pathExists: async (path) => ['/', '/var', '/var/lib'].includes(path),
          freeDiskBytes: async () => 500 * 1024 ** 3,
        },
        options: () => ({ user: 'ada', xdgRuntimeDir: null }),
      },
      recipe: {
        recipe_id: INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
        recipe_digest: INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
        parameters: (p, host) => parametersFromPlan(p, host),
        parametersDigest: (p) =>
          installContainerRuntimeParametersDigest(p as InstallContainerRuntimeParameters),
      },
      docker: async () => ({
        exec: async (args) => run('docker', args),
        socketPath: '/fake.sock',
        journal: { list: () => [], remove: async () => undefined },
      }),
      removeEngineCaches: async () => undefined,
      removeModels: async () => undefined,
      pull: async (image) => {
        state = { ...state, images: [...(state.images ?? []), `${image.repository}@${image.digest}`] }
      },
    }
    const changed: EnvironmentSnapshotLike[] = []
    const managed = wireManagedRuntimes({
      env: env('linux', {
        [RUNTIME_DESCRIPTOR_URL_ENV]: fixtureUrl,
        [ENVIRONMENT_MANIFEST_URL_ENV]: manifestUrl,
      }),
      instanceId: 'core-1',
      platform: 'linux',
      emit: ((name: string, payload: EnvironmentSnapshotLike) => {
        if (name === 'environment:changed') changed.push(payload)
      }) as never,
      newId: (() => {
        let n = 0
        return () => `id-${(n += 1)}`
      })(),
      linux,
    })
    wired.push(managed)
    await managed.recover()
    expect(managed.environments()[0]?.availability).toBe('setup-required')

    const target = { kind: 'runtime' as const, installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' }
    // The other scope's core finished a setup of its own meanwhile; a probe here picks it up.
    await managed.installations.write({
      schema_version: 1,
      installation: {
        installation_id: 'from-the-cli',
        engine_id: 'other-engine',
        environment_id: 'default',
        active_descriptor_id: 'other-1',
        candidate_descriptor_id: null,
        availability: 'supported',
        status: 'ready',
      },
      image: { repository: 'example/other', digest: `sha256:${'e'.repeat(64)}` },
      platform: 'linux/amd64',
      installed_at: '2026-09-29T00:00:00.000Z',
    })
    const plan = await managed.service.probe({ descriptor_id: 'tensorrt-llm-1.2.1-r2', target })
    // The wired manifest provider read the override, and the plan names the manifest it was judged by.
    expect(plan.environment_manifest_id).toBe('linux-r1')
    expect(managed.environments()[0]?.gpus.map((gpu) => gpu.gpu_id)).toEqual(['GPU-1'])
    for (let i = 0; i < 50 && managed.environments()[0]?.installations.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(managed.environments()[0]?.installations.map((entry) => entry.installation_id)).toEqual([
      'from-the-cli',
    ])
    await managed.installations.remove('from-the-cli')
    expect(changed.length).toBeGreaterThan(0)

    await managed.service.begin('default', {
      request_id: 'req-1',
      target,
      kind: 'setup',
      descriptor_id: 'tensorrt-llm-1.2.1-r2',
      approved_plan_digest: plan.plan_digest,
    })
    await managed.service.idle()
    for (let i = 0; i < 50 && managed.environments()[0]?.availability !== 'supported'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const environment = managed.environments()[0]
    expect(managed.operations()[0]?.phase).toBe('ready')
    expect(environment?.availability).toBe('supported')
    expect(environment?.installations.map((entry) => entry.active_descriptor_id)).toEqual([
      'tensorrt-llm-1.2.1-r2',
    ])
    expect(environment?.minimum_app_version).toBe('2.0.49')
    expect(changed.at(-1)?.revision).toBe(environment?.revision)
  })
})

type EnvironmentSnapshotLike = { revision: number }

describe('the Windows recipe wired (change add-tensorrt-llm-windows, task 2.10)', () => {
  it('drives the Windows provisioner with its own manifest, and shows the distribution a probe saw', async () => {
    const descriptorUrl = new URL('../../../test/fixtures/runtimes/tensorrt-llm.json', import.meta.url).href
    const manifestUrl = new URL('../../../test/fixtures/runtimes/environments/windows.json', import.meta.url)
      .href
    const windows = fakeWindows({
      wsl: {
        installed: true,
        wsl_version: '2.4.4.0',
        ready: true,
        distributions: [{ name: 'AtomicChat', state: 'Running', version: 2, is_default: false }],
        guests: {
          AtomicChat: {
            files: {},
            host: {
              docker: { installed: false, reachable: false, service_active: false, gpu_runtime: false },
            },
          },
        },
      },
      machine: 'x86_64',
      release: '10.0.22631',
      elevated: false,
      virtualization: { firmware: true, hypervisor: true },
      nvidia: { driver: '591.44', gpus: [] },
      wslconfig: null,
      volume_free_bytes: 1,
      vhdx_bytes: 7,
    })
    const record = {
      schema_version: 1 as const,
      executor: 'wsl-docker' as const,
      distribution: { name: 'AtomicChat', path: 'C:\\AtomicChat' },
      manifest_id: 'windows-r1',
      imported_at: '2026-10-01T00:00:00.000Z',
      marker: 'marker-0001',
    }
    const never = async (): Promise<never> => {
      throw new Error('not in a probe')
    }
    const managed = wireManagedRuntimes({
      env: env('win32', {
        [RUNTIME_DESCRIPTOR_URL_ENV]: descriptorUrl,
        [ENVIRONMENT_MANIFEST_URL_ENV]: manifestUrl,
      }),
      instanceId: 'core-1',
      platform: 'win32',
      emit: () => undefined,
      newId: () => 'id',
      windows: {
        host: windows.host,
        records: { read: async () => record, write: never, remove: never },
        guestRecipe: {
          recipe_id: 'linux.install-container-runtime',
          recipe_digest: `sha256:${'0'.repeat(64)}`,
          parameters: never,
          parametersDigest: never,
        } as never,
        enableWsl: {
          recipe_id: 'windows.enable-wsl',
          recipe_digest: `sha256:${'1'.repeat(64)}`,
          parameters_digest: `sha256:${'2'.repeat(64)}`,
        },
        downloadRootfs: never,
        removeFile: never,
        runGuestRecipe: never,
        journal: { list: () => [], remove: never },
        removeEngineCaches: never,
        removeModels: never,
      },
    })
    wired.push(managed)
    const plan = await managed.service.probe({ descriptor_id: 'none', target: { kind: 'environment' } })
    expect(plan.environment_manifest_id).toBe('windows-r1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(managed.environments()[0]?.distribution).toEqual({
      name: 'AtomicChat',
      path: 'C:\\AtomicChat',
      size_bytes: 7,
    })
  })
})

describe('environmentAvailability before a probe', () => {
  const ready = [
    {
      installation_id: 'i',
      engine_id: 'tensorrt-llm',
      environment_id: 'default',
      active_descriptor_id: 'd',
      candidate_descriptor_id: null,
      availability: 'supported' as const,
      status: 'ready' as const,
    },
  ]
  it('is what the platform says before a probe (unsupported on Windows), supported once an engine is installed', () => {
    expect(environmentAvailability(true, null, [], 'unsupported')).toBe('unsupported')
    expect(environmentAvailability(true, null, ready, 'unsupported')).toBe('supported')
    expect(environmentAvailability(true, 'prerequisite-blocked', ready, 'unsupported')).toBe(
      'prerequisite-blocked'
    )
    expect(environmentAvailability(true, null, [])).toBe('setup-required')
  })
})
