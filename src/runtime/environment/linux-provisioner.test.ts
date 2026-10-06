import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  BeginOperation,
  LinuxEnvironmentManifest,
  GpuFacts,
  RuntimeDescriptor,
} from '../../contracts/index.js'
import {
  INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  installContainerRuntimeParametersDigest,
  parametersFromPlan,
  type InstallContainerRuntimeParameters,
} from '../../host/recipes/index.js'
import { answer, type FakeLinuxHostState } from '../../../test/helpers/fake-linux-host.mjs'
import { readLinuxProbeFixture } from '../../../test/helpers/linux-probe-fixtures.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { dataLayout } from '../../config/index.js'
import type { ExecutionRecord } from '../container/index.js'
import { removeEngineCaches } from '../managed-text/index.js'
import { parseRuntimeDescriptor } from './descriptor.js'
import { TENSORRT_LLM_DESCRIPTOR_SOURCE, type RuntimeDescriptorProvider } from './descriptor-provider.js'
import { parseLinuxEnvironmentManifest } from './environment-manifest.js'
import type { EnvironmentManifestProvider } from './environment-manifest-provider.js'
import { InstallationStore } from './installations.js'
import type { LinuxHost } from './linux-host.js'
import {
  createLinuxProvisioner,
  imageMatchesDigest,
  ownedImageId,
  pickGpu,
  toManagedBlocker,
  type HostRecipeBinding,
  type HostView,
  type LinuxProvisionerDeps,
} from './linux-provisioner.js'
import { parseNvidiaSmi } from './linux-probe.js'
import { startOperation } from './state.js'
import type { PersistedOperation } from './store.js'

const DESCRIPTOR = parseRuntimeDescriptor(
  readRuntimeFixture('tensorrt-llm-1.2.1-r2.json')
) as RuntimeDescriptor
const IMAGE = DESCRIPTOR.image['linux/amd64']
const IMAGE_REF = `${IMAGE.repository}@${IMAGE.digest}`
const PROBE_IMAGE = DESCRIPTOR.probe_image['linux/amd64']
const PROBE_REF = `${PROBE_IMAGE.repository}@${PROBE_IMAGE.digest}`
const MANIFEST = parseLinuxEnvironmentManifest(readRuntimeFixture('environments/linux.json'))
const GPU = 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11'
const GIB = 1024 ** 3

const RECIPE: HostRecipeBinding = {
  recipe_id: INSTALL_CONTAINER_RUNTIME_RECIPE_ID,
  recipe_digest: INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST,
  parameters: (plan, host) => parametersFromPlan(plan, host),
  parametersDigest: (parameters) =>
    installContainerRuntimeParametersDigest(parameters as InstallContainerRuntimeParameters),
}

/** A ready Ubuntu 24.04 desktop: driver, an RTX 4090, Docker with the NVIDIA runtime, ada in docker. */
const readyHost = (): FakeLinuxHostState => ({
  user: 'ada',
  driver: '590.44.01',
  gpus: [{ uuid: GPU, name: 'NVIDIA GeForce RTX 4090', cc: '8.9', total_mib: 24564, free_mib: 24000 }],
  docker: { installed: true, reachable: true, service_active: true, gpu_runtime: true },
  toolkit: true,
  group: { configured: true, effective: true },
  gpu_visible_in_container: true,
  images: [],
  containers: [],
})

/** The same machine before anything: no Docker, no toolkit, no group. */
const cleanHost = (): FakeLinuxHostState => ({
  ...readyHost(),
  docker: { installed: false, reachable: false, service_active: false, gpu_runtime: false },
  toolkit: false,
  group: { configured: false, effective: false },
})

let root: string
let data: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'provisioner-root-'))
  data = await mkdtemp(join(tmpdir(), 'provisioner-data-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(data, { recursive: true, force: true })
})

interface Harness {
  machine: { state: FakeLinuxHostState; free: number }
  deps: LinuxProvisionerDeps
  pulls: { ref: string; knownTotalBytes: number | undefined }[]
  dockerCalls: string[][]
  journal: ExecutionRecord[]
  views: HostView[]
  calls: string[]
  installations: InstallationStore
}

const harness = (state: FakeLinuxHostState, over: Partial<LinuxProvisionerDeps> = {}): Harness => {
  const machine = { state, free: 500 * GIB }
  const run = (command: string, args: string[]) => {
    const result = answer(machine.state, command, args)
    if (result.next !== undefined) machine.state = result.next
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const files: Record<string, string> = {
    '/etc/os-release': readLinuxProbeFixture('os-release/ubuntu-24.04.txt'),
  }
  const host: LinuxHost = {
    probeDeps: {
      exec: async (command, args) => run(command, args),
      // `nvidia-ctk runtime configure` leaves this behind; the only evidence while the daemon is out of reach.
      readFile: async (path) =>
        path === '/etc/docker/daemon.json' && machine.state.docker.gpu_runtime
          ? JSON.stringify({ runtimes: { nvidia: { path: 'nvidia-container-runtime' } } })
          : path === '/proc/net/route'
            ? (machine.state.proc_net_route ?? null)
            : (files[path] ?? null),
      // An ordinary systemd host: `/run/systemd/system` is the `sd_booted()` test.
      pathExists: async (path) =>
        path in files || ['/', '/var', '/var/lib', '/run/systemd/system'].includes(path),
      freeDiskBytes: async () => machine.free,
    },
    options: () => ({ user: 'ada', xdgRuntimeDir: null }),
  }
  const dockerCalls: string[][] = []
  const journal: ExecutionRecord[] = []
  const pulls: Harness['pulls'] = []
  const views: HostView[] = []
  const calls: string[] = []
  const installations = new InstallationStore(root)
  const descriptors: RuntimeDescriptorProvider = {
    engines: [TENSORRT_LLM_DESCRIPTOR_SOURCE],
    forNewSetup: async () => ({ kind: 'available', descriptor: DESCRIPTOR }),
    forInstallation: async (id) =>
      id === DESCRIPTOR.descriptor_id
        ? { kind: 'available', descriptor: DESCRIPTOR }
        : { kind: 'unsupported', error: new Error('not cached') as never },
    cachedForNewSetup: async () => ({ kind: 'available', descriptor: DESCRIPTOR }),
  }
  const environmentManifests: EnvironmentManifestProvider = manifestsOf(MANIFEST)
  const deps: LinuxProvisionerDeps = {
    host,
    descriptors,
    environmentManifests,
    recipe: RECIPE,
    docker: async () =>
      machine.state.docker.installed
        ? {
            exec: async (args) => {
              dockerCalls.push(args)
              return run('docker', args)
            },
            socketPath: '/fake.sock',
            journal: {
              list: () => [...journal],
              remove: async (id) => {
                calls.push(`journal-remove:${id}`)
                journal.splice(
                  journal.findIndex((entry) => entry.container_id === id),
                  1
                )
              },
            },
          }
        : null,
    installations,
    environmentId: 'default',
    removeEngineCaches: async (descriptorId) => {
      calls.push(`caches:${descriptorId}`)
    },
    removeModels: async (engineId) => {
      calls.push(`models:${engineId}`)
    },
    unloadEngineSessions: async (engineId) => {
      calls.push(`unload:${engineId}`)
      return { unloaded: 1 }
    },
    onAssessment: (view) => views.push(view),
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1)}`
    })(),
    now: () => new Date('2026-09-29T00:00:00.000Z'),
    pull: vi.fn(async (image, options) => {
      pulls.push({ ref: `${image.repository}@${image.digest}`, knownTotalBytes: options?.knownTotalBytes })
      options?.onProgress?.({ current: 5, total: 10 })
      machine.state = {
        ...machine.state,
        images: [...(machine.state.images ?? []), `${image.repository}@${image.digest}`],
      }
    }),
    ...over,
  }
  return { machine, deps, pulls, dockerCalls, journal, views, calls, installations }
}

/**
 * A manifest provider whose latest is `latest` (null: none to be had) and whose cache holds `latest`
 * plus `cached`. `latest` and `pinned` are spies, so a test can tell which one a probe asked.
 */
function manifestsOf(
  latest: LinuxEnvironmentManifest | null,
  cached: LinuxEnvironmentManifest[] = []
): EnvironmentManifestProvider & { latest: ReturnType<typeof vi.fn>; pinned: ReturnType<typeof vi.fn> } {
  const store = [...(latest === null ? [] : [latest]), ...cached]
  const missing = (details?: string) => ({
    kind: 'unavailable' as const,
    error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'No environment manifest is available.', details),
  })
  return {
    latest: vi.fn(async () =>
      latest === null ? missing() : { kind: 'available' as const, manifest: latest }
    ),
    pinned: vi.fn(async (id: string) => {
      const found = store.find((manifest) => manifest.manifest_id === id)
      return found === undefined ? missing(id) : { kind: 'available' as const, manifest: found }
    }),
  }
}

/** The fixture manifest under another id with the recipe's distributions replaced. */
const manifestWith = (
  manifestId: string,
  distributions: LinuxEnvironmentManifest['recipes'][number]['distributions']
) => ({
  ...MANIFEST,
  manifest_id: manifestId,
  recipes: [{ recipe_id: INSTALL_CONTAINER_RUNTIME_RECIPE_ID, distributions }],
})

const TARGET = { kind: 'runtime' as const, installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' }

const record = (
  request: Partial<BeginOperation> = {},
  over: Partial<PersistedOperation> = {}
): PersistedOperation => {
  const input: BeginOperation = {
    request_id: 'req-1',
    target: TARGET,
    kind: 'setup',
    descriptor_id: DESCRIPTOR.descriptor_id,
    ...request,
  }
  const started = startOperation(
    {
      operation_id: 'op-1',
      request_id: input.request_id,
      environment_id: 'default',
      instance_id: 'core-1',
      target: input.target,
      kind: input.kind,
    },
    { next_effect_id: 'effect-1' }
  )
  return {
    // As every effect sees it: work started under a consent to this descriptor, image, environment
    // manifest and target.
    machine: {
      ...started.state,
      consented: {
        plan_digest: `sha256:${'c'.repeat(64)}`,
        descriptor_id: DESCRIPTOR.descriptor_id,
        image_digest: IMAGE.digest,
        environment_manifest_id: MANIFEST.manifest_id,
        target: input.target,
      },
    },
    request_digest: `sha256:${'a'.repeat(64)}`,
    request: input,
    requirement_plan: null,
    accepted_receipt_digests: {},
    completed_effect_ids: [],
    owned_resource_ids: [],
    owner_pid: null,
    owner_process_start_id: null,
    ...over,
  }
}

/** An operation nobody has consented to yet: what the probe route and a fresh begin see. */
const fresh = (request: Partial<BeginOperation> = {}): PersistedOperation => {
  const base = record(request)
  return { ...base, machine: { ...base.machine, consented: null } }
}

const signal = new AbortController().signal
const noOwn = async (): Promise<void> => undefined

describe('probing a Linux host for a setup', () => {
  it('adopts a ready host: nothing to change, no privileged step, the pinned descriptor named', async () => {
    const h = harness(readyHost())
    const answer = await createLinuxProvisioner(h.deps).probe(record(), signal)
    expect(answer.host_step).toBeNull()
    expect(answer.plan.adopts_existing_engine).toBe(true)
    expect(answer.plan.system_changes).toEqual([])
    expect(answer.plan.blockers).toEqual([])
    expect(answer.plan.availability).toBe('setup-required')
    expect(answer.plan.descriptor_id).toBe(DESCRIPTOR.descriptor_id)
    expect(answer.plan.download_bytes).toBe(DESCRIPTOR.download_bytes)
    expect(answer.image_present).toBe(false)
    // The snapshot learns the GPUs and the verdict from the same probe.
    expect(h.views.at(-1)?.gpus.map((gpu) => gpu.gpu_id)).toEqual([GPU])
    expect(h.views.at(-1)?.selinux).toBe(false)
  })

  it('plans the install on a clean Ubuntu and hands out a step with the recipe’s validated parameters', async () => {
    const h = harness(cleanHost())
    const answer = await createLinuxProvisioner(h.deps).probe(record(), signal)
    expect(answer.plan.requires_elevation).toBe(true)
    expect(answer.plan.system_changes.map((change) => change.code)).toEqual([
      'add-repository',
      'add-repository',
      'install-packages',
      'configure-nvidia-runtime',
      'generate-cdi-spec',
      'enable-docker-service',
      'add-user-to-docker-group',
    ])
    const step = answer.host_step
    expect(step?.action).toBe('linux.install-container-runtime')
    expect(step?.recipe_digest).toBe(INSTALL_CONTAINER_RUNTIME_RECIPE_DIGEST)
    expect(step?.parameters).toEqual({
      user: 'ada',
      arch: 'x86_64',
      family: 'apt',
      distro_id: 'ubuntu',
      version_id: '24.04',
      components: [
        'docker-engine',
        'nvidia-container-toolkit',
        'nvidia-runtime',
        'nvidia-cdi',
        'docker-service',
        'docker-group',
      ],
    })
    expect(step?.parameters_digest).toBe(
      installContainerRuntimeParametersDigest(step?.parameters as InstallContainerRuntimeParameters)
    )
    // A fresh single-use nonce per step.
    const again = await createLinuxProvisioner(h.deps).probe(record(), signal)
    expect(again.host_step?.nonce).not.toBe(step?.nonce)
    expect(again.plan.plan_digest).toBe(answer.plan.plan_digest)
  })

  it('binds the plan digest to the GPU set and to whether the free space suffices (carry item 1, r1 item 3)', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    const first = (await provisioner.probe(fresh(), signal)).plan.plan_digest
    // Space moving while it still covers the image is not a new plan, however much it moves.
    h.machine.free -= 300 * GIB
    expect((await provisioner.probe(fresh(), signal)).plan.plan_digest).toBe(first)
    h.machine.state = {
      ...h.machine.state,
      gpus: [
        ...(h.machine.state.gpus ?? []),
        { uuid: 'GPU-second', name: 'NVIDIA RTX A6000', cc: '8.6', total_mib: 49140, free_mib: 49000 },
      ],
    }
    expect((await provisioner.probe(fresh(), signal)).plan.plan_digest).not.toBe(first)
    // Below what the image needs, the plan is blocked outright.
    h.machine.free = DESCRIPTOR.required_disk_bytes - 1
    const tight = (await provisioner.probe(fresh(), signal)).plan
    expect(tight.blockers.map((blocker) => blocker.reason)).toEqual(['insufficient-disk'])
  })

  it('checks free space only against what the image still needs (review r1, item 1)', async () => {
    const full = { ...readyHost() }
    // Image already there: nothing more to fit.
    const present = harness({ ...full, images: [IMAGE_REF] })
    present.machine.free = 1 * GIB
    const withImage = await createLinuxProvisioner(present.deps).probe(fresh(), signal)
    expect(withImage.plan.blockers).toEqual([])
    expect(withImage.image_present).toBe(true)

    // A pull already under way: its layers are on the disk already, so the rest is not checked.
    const midPull = harness(full)
    midPull.machine.free = 10 * GIB
    const restarted = record()
    restarted.machine.checkpoint = 'pulling-image'
    expect((await createLinuxProvisioner(midPull.deps).probe(restarted, signal)).plan.blockers).toEqual([])
    // Before the pull began, the same space blocks.
    expect(
      (await createLinuxProvisioner(midPull.deps).probe(fresh(), signal)).plan.blockers.map((b) => b.reason)
    ).toEqual(['insufficient-disk'])

    // A ready installation, its image there, on a nearly full disk stays supported.
    const installed = harness({ ...full, images: [IMAGE_REF] })
    const provisioner = createLinuxProvisioner(installed.deps)
    await provisioner.activate(record(), signal)
    installed.machine.free = 1 * GIB
    const answer = await provisioner.probe(fresh(), signal)
    expect(answer.plan.availability).toBe('supported')
    expect(answer.plan.blockers).toEqual([])
    expect(installed.views.at(-1)?.availability).toBe('supported')
  })

  it('raises no disk blocker for a ready installation while Docker cannot be asked (review r3, N4)', async () => {
    const h = harness({
      ...readyHost(),
      docker: { installed: true, reachable: false, service_active: true, gpu_runtime: true },
      group: { configured: true, effective: false },
    })
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.activate(record(), signal)
    h.machine.free = 1 * GIB
    const answer = await provisioner.probe(fresh(), signal)
    // Whether the image is there is unknown, not "absent": only the sign-in is reported.
    expect(answer.plan.blockers.map((blocker) => blocker.reason)).toEqual(['relogin-required'])
  })

  it('checks the space again for an installed image deleted outside the app (review r2, item D)', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.activate(record(), signal)
    h.machine.free = 1 * GIB
    const answer = await provisioner.probe(fresh(), signal)
    expect(answer.image_present).toBe(false)
    expect(answer.plan.blockers.map((blocker) => blocker.reason)).toEqual(['insufficient-disk'])
  })

  it('reports the path and free space it measured, the same numbers its disk blocker uses (task 2.22, R-core-6)', async () => {
    // Docker answers: its own DockerRootDir, and the free space there.
    const custom = harness({ ...readyHost(), docker: { ...readyHost().docker, root_dir: '/srv/docker' } })
    custom.machine.free = 321 * GIB
    const answered = (await createLinuxProvisioner(custom.deps).probe(fresh(), signal)).plan
    expect(answered.docker_root_dir).toBe('/srv/docker')
    expect(answered.free_disk_bytes).toBe(321 * GIB)

    // A clean host (no docker info at all): the path core measured for, /var/lib/docker, where
    // Docker will put the image by default — not null, although Docker has not said so yet.
    const clean = harness(cleanHost())
    clean.machine.free = 123 * GIB
    const cleanPlan = (await createLinuxProvisioner(clean.deps).probe(fresh(), signal)).plan
    expect(cleanPlan.docker_root_dir).toBe('/var/lib/docker')
    expect(cleanPlan.free_disk_bytes).toBe(123 * GIB)

    // Not enough room: the blocker's `free` is exactly the plan's `free_disk_bytes`.
    const tight = harness(readyHost())
    tight.machine.free = DESCRIPTOR.required_disk_bytes - 1
    const tightPlan = (await createLinuxProvisioner(tight.deps).probe(fresh(), signal)).plan
    const disk = tightPlan.blockers.find((blocker) => blocker.reason === 'insufficient-disk')
    expect(disk?.params).toEqual({
      free: String(tightPlan.free_disk_bytes),
      required: String(DESCRIPTOR.required_disk_bytes),
    })
    expect(tightPlan.docker_root_dir).toBe('/var/lib/docker')

    // The free-space read failed: core measured nothing, so neither is reported — both null
    // together, never a path without its number — and no disk blocker claims a number either.
    const unread = harness(readyHost())
    unread.deps.host = {
      ...unread.deps.host,
      probeDeps: {
        ...unread.deps.host.probeDeps,
        freeDiskBytes: async () => Promise.reject(new Error('EIO')),
      },
    }
    const unreadPlan = (await createLinuxProvisioner(unread.deps).probe(fresh(), signal)).plan
    expect(unreadPlan.docker_root_dir).toBeNull()
    expect(unreadPlan.free_disk_bytes).toBeNull()
    expect(unreadPlan.blockers.some((blocker) => blocker.reason === 'insufficient-disk')).toBe(false)
  })

  it('reports no measured path or free space on a plan that never read the machine', async () => {
    // No descriptor to be had: blocked before the probe.
    const h = harness(readyHost())
    h.deps.descriptors = {
      ...h.deps.descriptors,
      forInstallation: async () => ({ kind: 'unsupported', error: new Error('x') as never }),
      forNewSetup: async () => ({ kind: 'unsupported', error: new Error('none') as never }),
    }
    const blocked = (await createLinuxProvisioner(h.deps).probe(record(), signal)).plan
    expect(blocked.docker_root_dir).toBeNull()
    expect(blocked.free_disk_bytes).toBeNull()
    // A removal plan asks nothing of the disk.
    const removal = (
      await createLinuxProvisioner(harness(readyHost()).deps).probe(
        record({ kind: 'remove', descriptor_id: undefined as never }),
        signal
      )
    ).plan
    expect(removal.docker_root_dir).toBeNull()
    expect(removal.free_disk_bytes).toBeNull()
  })

  it('plans with the consented descriptor only once the user consented, never a newer one (review r1, item 2)', async () => {
    const h = harness(readyHost())
    const forNewSetup = vi.fn(h.deps.descriptors.forNewSetup)
    h.deps.descriptors = {
      ...h.deps.descriptors,
      forNewSetup,
      forInstallation: async () => ({
        kind: 'unsupported',
        error: Object.assign(
          new Error('The runtime descriptor this installation was set up with is no longer cached.'),
          {
            code: 'MANAGED_METADATA_INVALID',
          }
        ) as never,
      }),
    }
    const provisioner = createLinuxProvisioner(h.deps)
    const answer = await provisioner.probe(record(), signal)
    expect(answer.plan.blockers[0]?.code).toBe('MANAGED_METADATA_INVALID')
    expect(answer.plan.blockers[0]?.details).toBe(DESCRIPTOR.descriptor_id)
    // Every effect after the consent refuses too, without looking for another descriptor.
    await expect(provisioner.prepare(record(), signal, noOwn)).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
    await expect(provisioner.pull(record(), () => undefined, signal)).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
    await expect(provisioner.verify(record(), signal)).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
    await expect(provisioner.activate(record(), signal)).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
    const noPlan = { ...fresh(), request: { ...fresh().request } }
    await expect(provisioner.prepare(noPlan, signal, noOwn)).rejects.toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
    })
    expect(forNewSetup).not.toHaveBeenCalled()
    expect(h.pulls).toEqual([])
  })

  it('names the descriptor and the engine image digest the plan would pull', async () => {
    const plan = (await createLinuxProvisioner(harness(readyHost()).deps).probe(fresh(), signal)).plan
    expect(plan.descriptor_id).toBe(DESCRIPTOR.descriptor_id)
    expect(plan.image_digest).toBe(IMAGE.digest)
    const env = (
      await createLinuxProvisioner(harness(readyHost()).deps).probe(
        fresh({ target: { kind: 'environment' } }),
        signal
      )
    ).plan
    expect(env.image_digest).toBeNull()
  })

  it('answers unsupported with the descriptor error when no descriptor can be had', async () => {
    const h = harness(readyHost())
    h.deps.descriptors = {
      ...h.deps.descriptors,
      forInstallation: async () => ({ kind: 'unsupported', error: new Error('x') as never }),
      forNewSetup: async () => ({
        kind: 'unsupported',
        error: Object.assign(new Error('No descriptor is available.'), {
          code: 'MANAGED_METADATA_INVALID',
        }) as never,
      }),
    }
    const answer = await createLinuxProvisioner(h.deps).probe(record(), signal)
    expect(answer.plan.availability).toBe('unsupported')
    expect(answer.plan.blockers[0]?.code).toBe('MANAGED_METADATA_INVALID')
    expect(h.views.at(-1)?.availability).toBe('unsupported')
  })

  it('refuses to set up over an installation pinned to another descriptor (design D7)', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.activate(record(), signal)
    const pinned = await h.installations.read('tensorrt-llm')
    await h.installations.write({
      ...pinned!,
      installation: { ...pinned!.installation, active_descriptor_id: 'tensorrt-llm-older' },
    })
    const answer = await provisioner.probe(record(), signal)
    expect(answer.plan.blockers.map((blocker) => blocker.reason)).toEqual(['installed-with-other-descriptor'])
    expect(answer.plan.availability).toBe('prerequisite-blocked')
  })

  it('refuses a descriptor for another engine than the target names', async () => {
    const h = harness(readyHost())
    const answer = await createLinuxProvisioner(h.deps).probe(
      record({ target: { ...TARGET, engine_id: 'vllm' } }),
      signal
    )
    expect(answer.plan.blockers.map((blocker) => blocker.reason)).toEqual(['engine-mismatch'])
  })

  it('says supported once the installation is ready, and reports the image already there', async () => {
    const h = harness({ ...readyHost(), images: [IMAGE_REF] })
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.activate(record(), signal)
    const answer = await provisioner.probe(record(), signal)
    expect(answer.plan.availability).toBe('supported')
    expect(answer.image_present).toBe(true)
  })

  it('turns a recipe refusal into a blocker instead of a step', async () => {
    const h = harness(cleanHost(), {
      recipe: {
        ...RECIPE,
        parameters: () => {
          throw new Error('the recipe does not install package foo')
        },
      },
    })
    const answer = await createLinuxProvisioner(h.deps).probe(record(), signal)
    expect(answer.host_step).toBeNull()
    expect(answer.plan.blockers[0]?.code).toBe('MANAGED_HOST_STEP_INVALID')
  })
})

describe('the environment manifest (change extract-environment-manifest)', () => {
  const UBUNTU_24_04 = { id: 'ubuntu', version_id: '24.04', arch: 'x86_64' } as const
  /** Conf before Ubuntu 24.04 was qualified, and the manifest that then added it. */
  const WITHOUT_24_04 = manifestWith('linux-r1', [{ id: 'debian', version_id: '12', arch: 'x86_64' }])
  const WITH_24_04 = manifestWith('linux-r2', [
    { id: 'debian', version_id: '12', arch: 'x86_64' },
    UBUNTU_24_04,
  ])

  it('names the manifest it judged the host against, read fresh before any consent', async () => {
    const manifests = manifestsOf(MANIFEST)
    const h = harness(cleanHost(), { environmentManifests: manifests })
    const answer = await createLinuxProvisioner(h.deps).probe(fresh(), signal)
    expect(answer.plan.environment_manifest_id).toBe('linux-r1')
    expect(answer.host_step).not.toBeNull()
    expect(manifests.latest).toHaveBeenCalled()
    expect(manifests.pinned).not.toHaveBeenCalled()
  })

  it('takes the distribution list from the manifest: a distribution added there is installable with the same descriptor', async () => {
    const before = await createLinuxProvisioner(
      harness(cleanHost(), { environmentManifests: manifestsOf(WITHOUT_24_04) }).deps
    ).probe(fresh(), signal)
    expect(before.plan.blockers.map((b) => b.reason)).toEqual(['distribution-not-in-recipe'])
    expect(before.host_step).toBeNull()

    const after = await createLinuxProvisioner(
      harness(cleanHost(), { environmentManifests: manifestsOf(WITH_24_04) }).deps
    ).probe(fresh(), signal)
    expect(after.plan.blockers).toEqual([])
    expect(after.host_step?.action).toBe('linux.install-container-runtime')
    expect(after.plan.environment_manifest_id).toBe('linux-r2')
    expect(after.plan.descriptor_id).toBe(before.plan.descriptor_id)
  })

  it('without a manifest, a host that needs the install is blocked with MANAGED_METADATA_INVALID and gets no step', async () => {
    const h = harness(cleanHost(), { environmentManifests: manifestsOf(null) })
    const answer = await createLinuxProvisioner(h.deps).probe(fresh(), signal)
    expect(answer.plan.availability).toBe('prerequisite-blocked')
    expect(answer.plan.blockers).toHaveLength(1)
    expect(answer.plan.blockers[0]).toMatchObject({
      code: 'MANAGED_METADATA_INVALID',
      reason: 'environment-manifest-unavailable',
    })
    expect(answer.host_step).toBeNull()
    expect(answer.plan.requires_elevation).toBe(false)
    expect(answer.plan.system_changes).toEqual([])
    expect(answer.plan.environment_manifest_id).toBeNull()
  })

  it('without a manifest, a ready host is adopted: no blocker, no step, no manifest named', async () => {
    const h = harness(readyHost(), { environmentManifests: manifestsOf(null) })
    const answer = await createLinuxProvisioner(h.deps).probe(fresh(), signal)
    expect(answer.plan.adopts_existing_engine).toBe(true)
    expect(answer.plan.blockers).toEqual([])
    expect(answer.host_step).toBeNull()
    expect(answer.plan.environment_manifest_id).toBeNull()
  })

  it('a manifest published between the probe and the consent changes the plan digest', async () => {
    const first = await createLinuxProvisioner(
      harness(readyHost(), { environmentManifests: manifestsOf(MANIFEST) }).deps
    ).probe(fresh(), signal)
    const second = await createLinuxProvisioner(
      harness(readyHost(), { environmentManifests: manifestsOf(WITH_24_04, [MANIFEST]) }).deps
    ).probe(fresh(), signal)
    expect(second.plan.environment_manifest_id).toBe('linux-r2')
    expect(second.plan.plan_digest).not.toBe(first.plan.plan_digest)
  })

  it('after the consent, only the consented manifest from the cache: a newer one in conf is never asked for', async () => {
    // Conf now says linux-r2 qualifies nothing for Ubuntu; the consent was given under linux-r1.
    const manifests = manifestsOf(manifestWith('linux-r2', []), [MANIFEST])
    const h = harness(cleanHost(), { environmentManifests: manifests })
    const provisioner = createLinuxProvisioner(h.deps)
    const answer = await provisioner.probe(record(), signal)
    expect(answer.plan.environment_manifest_id).toBe('linux-r1')
    expect(answer.host_step).not.toBeNull()
    expect(manifests.pinned).toHaveBeenCalledWith('linux-r1')
    expect(manifests.latest).not.toHaveBeenCalled()
    // The receipt check after the privileged step reads the same pinned manifest.
    await provisioner.verifyHostStep(record(), signal)
    expect(manifests.latest).not.toHaveBeenCalled()
  })

  it('a consent given with no manifest stays without one, even once a manifest can be had', async () => {
    const manifests = manifestsOf(MANIFEST)
    const h = harness(readyHost(), { environmentManifests: manifests })
    const base = record()
    const consentedWithout: PersistedOperation = {
      ...base,
      machine: {
        ...base.machine,
        consented: {
          ...(base.machine.consented as NonNullable<typeof base.machine.consented>),
          environment_manifest_id: null,
        },
      },
    }
    const answer = await createLinuxProvisioner(h.deps).probe(consentedWithout, signal)
    expect(answer.plan.environment_manifest_id).toBeNull()
    expect(answer.plan.adopts_existing_engine).toBe(true)
    expect(manifests.latest).not.toHaveBeenCalled()
  })

  it('reads an operation record written before the field existed: its consent names no manifest', async () => {
    const manifests = manifestsOf(MANIFEST)
    const h = harness(readyHost(), { environmentManifests: manifests })
    const base = record()
    const { environment_manifest_id: _dropped, ...legacy } = base.machine.consented as NonNullable<
      typeof base.machine.consented
    >
    const answer = await createLinuxProvisioner(h.deps).probe(
      { ...base, machine: { ...base.machine, consented: legacy } },
      signal
    )
    expect(answer.plan.environment_manifest_id).toBeNull()
    expect(manifests.latest).not.toHaveBeenCalled()
    expect(manifests.pinned).not.toHaveBeenCalled()
  })

  it('a consented manifest that left the cache is unavailable, not replaced by the newest one', async () => {
    const manifests = manifestsOf(WITH_24_04)
    const h = harness(cleanHost(), { environmentManifests: manifests })
    const answer = await createLinuxProvisioner(h.deps).probe(record(), signal)
    expect(manifests.pinned).toHaveBeenCalledWith('linux-r1')
    // conf is asked again, but it now serves linux-r2: never taken in place of the consented one.
    expect(manifests.latest).toHaveBeenCalled()
    expect(answer.plan.environment_manifest_id).toBeNull()
    expect(answer.plan.blockers.map((b) => b.reason)).toEqual(['environment-manifest-unavailable'])
    expect(answer.host_step).toBeNull()
  })

  it('a consented manifest whose cache write failed is fetched again when conf still serves that id (review)', async () => {
    // `latest()` accepted linux-r1 but could not cache it; the consent named it, so a later probe
    // takes conf's linux-r1 again — the same immutable content — instead of blocking the install.
    const manifests = manifestsOf(MANIFEST)
    manifests.pinned.mockImplementation(async (id: string) => ({
      kind: 'unavailable' as const,
      error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'not cached', id),
    }))
    const h = harness(cleanHost(), { environmentManifests: manifests })
    const answer = await createLinuxProvisioner(h.deps).probe(record(), signal)
    expect(answer.plan.environment_manifest_id).toBe('linux-r1')
    expect(answer.plan.blockers).toEqual([])
    expect(answer.host_step).not.toBeNull()
  })

  it('a removal reads no manifest and names none', async () => {
    const manifests = manifestsOf(MANIFEST)
    const h = harness(readyHost(), { environmentManifests: manifests })
    const answer = await createLinuxProvisioner(h.deps).probe(fresh({ kind: 'remove' }), signal)
    expect(answer.plan.environment_manifest_id).toBeNull()
    expect(manifests.latest).not.toHaveBeenCalled()
    expect(manifests.pinned).not.toHaveBeenCalled()
  })
})

describe('checking a host-step receipt against the machine', () => {
  it('sees the relogin when the group is granted, the daemon runs, and this session lacks it', async () => {
    const h = harness({
      ...readyHost(),
      docker: { installed: true, reachable: false, service_active: true, gpu_runtime: true },
      group: { configured: true, effective: false },
    })
    const provisioner = createLinuxProvisioner(h.deps)
    expect(await provisioner.verifyHostStep(record(), signal)).toEqual({
      prerequisites_met: false,
      needs_relogin: true,
      error: null,
    })
    expect(await provisioner.inventory.needsRelogin(record())).toBe(true)
  })

  it('fails with what the probe found when the helper says completed and Docker is not there', async () => {
    const h = harness(cleanHost())
    const verdict = await createLinuxProvisioner(h.deps).verifyHostStep(record(), signal)
    expect(verdict.prerequisites_met).toBe(false)
    expect(verdict.needs_relogin).toBe(false)
    expect(verdict.error?.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(verdict.error?.message).toMatch(/still needs: .*docker-ce/)
    expect(verdict.error?.details).toContain('install-packages')
  })

  it('reports a blocker the probe found as the failure, with every reason', async () => {
    const h = harness({ ...readyHost(), driver: '580.65.06' })
    const verdict = await createLinuxProvisioner(h.deps).verifyHostStep(record(), signal)
    expect(verdict.error?.details).toBe('driver-too-old')
  })

  it('lets the setup go on when the machine is ready', async () => {
    const h = harness(readyHost())
    expect((await createLinuxProvisioner(h.deps).verifyHostStep(record(), signal)).prerequisites_met).toBe(
      true
    )
  })

  it('never asks root to sign in again (design D4)', async () => {
    const h = harness({
      ...readyHost(),
      user: 'root',
      docker: { installed: true, reachable: false, service_active: true, gpu_runtime: false },
      group: { configured: true, effective: false },
    })
    h.deps.host = { ...h.deps.host, options: () => ({ user: 'root', xdgRuntimeDir: null }) }
    expect(await createLinuxProvisioner(h.deps).inventory.needsRelogin(record())).toBe(false)
  })
})

describe('explaining a failed Docker start (task 2.23, review round 1)', () => {
  it.each<[string, () => Promise<string | null>, boolean | 'unknown']>([
    ['no daemon.json', async () => null, false],
    ['only the NVIDIA runtime', async () => JSON.stringify({ runtimes: { nvidia: {} } }), false],
    [
      'default-address-pools set',
      async () => JSON.stringify({ 'default-address-pools': [{ base: '10.200.0.0/16', size: 24 }] }),
      true,
    ],
    ['a bip set', async () => JSON.stringify({ bip: '172.30.99.1/24' }), true],
    ['a daemon.json that cannot be read', async () => Promise.reject(new Error('EACCES')), 'unknown'],
  ])('reads whether daemon.json sets pools: %s', async (_label, daemonJson, expected) => {
    const h = harness(cleanHost())
    const readFile = h.deps.host.probeDeps.readFile
    const provisioner = createLinuxProvisioner({
      ...h.deps,
      host: {
        ...h.deps.host,
        probeDeps: {
          ...h.deps.host.probeDeps,
          readFile: (path) => (path === '/etc/docker/daemon.json' ? daemonJson() : readFile(path)),
        },
      },
    })
    expect(await provisioner.addressPoolsConfigured?.()).toBe(expected)
  })
})

describe('the GPU check, the pull and the verification', () => {
  it('records the GPU-check image as its own before pulling it, only when it was absent (review r2, item B)', async () => {
    const absent = harness(readyHost())
    const owned: string[][] = []
    const provisioner = createLinuxProvisioner(absent.deps)
    await provisioner.prepare(record(), signal, async (ids) => {
      // Recorded before the pull, not after it.
      expect(absent.pulls).toEqual([])
      owned.push(ids)
    })
    expect(owned).toEqual([[ownedImageId(PROBE_IMAGE)]])

    const already = harness({ ...readyHost(), images: [PROBE_REF] })
    const none: string[][] = []
    await createLinuxProvisioner(already.deps).prepare(record(), signal, async (ids) => {
      none.push(ids)
    })
    expect(none).toEqual([])

    // A failed inspect proves nothing: nothing is claimed.
    const unsure = harness(readyHost())
    const exec = unsure.deps.docker
    unsure.deps.docker = async () => {
      const docker = await exec()
      return docker === null
        ? null
        : {
            ...docker,
            exec: async (args) =>
              args[2] === 'image' && args[3] === 'inspect'
                ? { code: 1, stdout: '', stderr: 'permission denied' }
                : docker.exec(args),
          }
    }
    const claims: string[][] = []
    await createLinuxProvisioner(unsure.deps).prepare(record(), signal, async (ids) => {
      claims.push(ids)
    })
    expect(claims).toEqual([])
  })

  it('carries the GPU-check image forward on a repeat setup of the same installation (review r3, N3)', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.activate(record({}, { owned_resource_ids: [ownedImageId(PROBE_IMAGE)] }), signal)
    // The repeat setup found the image present and claimed nothing; the record still says it is ours.
    await provisioner.activate(record(), signal)
    expect((await h.installations.read('tensorrt-llm'))?.probe_image).toEqual(PROBE_IMAGE)
    // A record for another GPU-check image is not carried onto this one.
    const mine = await h.installations.read('tensorrt-llm')
    await h.installations.write({
      ...mine!,
      probe_image: { ...PROBE_IMAGE, digest: `sha256:${'f'.repeat(64)}` },
    })
    await provisioner.activate(record(), signal)
    expect((await h.installations.read('tensorrt-llm'))?.probe_image).toBeUndefined()
  })

  it('keeps the GPU-check image on the installation only when this operation pulled it', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.activate(record(), signal)
    expect((await h.installations.read('tensorrt-llm'))?.probe_image).toBeUndefined()
    await provisioner.activate(record({}, { owned_resource_ids: [ownedImageId(PROBE_IMAGE)] }), signal)
    expect((await h.installations.read('tensorrt-llm'))?.probe_image).toEqual(PROBE_IMAGE)
  })

  it('pulls the small probe image by digest and runs nvidia-smi on the chosen card', async () => {
    const h = harness(readyHost())
    await createLinuxProvisioner(h.deps).prepare(record(), signal, noOwn)
    expect(h.pulls.map((pull) => pull.ref)).toEqual([`${PROBE_IMAGE.repository}@${PROBE_IMAGE.digest}`])
    const run = h.dockerCalls.find((args) => args[2] === 'run')
    expect(run).toContain(`device=${GPU}`)
    expect(run).toContain('--pull=never')
    expect(run).toContain('nvidia-smi')
  })

  it('fails with toolkit diagnostics, and never touches the engine image, when the GPU is not visible', async () => {
    const h = harness({ ...readyHost(), gpu_visible_in_container: false })
    const failure = await createLinuxProvisioner(h.deps)
      .prepare(record(), signal, noOwn)
      .then(
        () => ({ code: 'none', details: '' }),
        (error: unknown) => error as { code: string; details: string }
      )
    expect(failure.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(failure.details).toContain(`gpu=${GPU}`)
    expect(failure.details).toContain('could not select device driver')
    expect(h.pulls.map((pull) => pull.ref)).not.toContain(IMAGE_REF)
  })

  it('fails before any docker call when no card is new enough, or no docker CLI exists', async () => {
    const old = harness({
      ...readyHost(),
      gpus: [{ uuid: GPU, name: 'RTX 2080', cc: '7.5', total_mib: 8000, free_mib: 8000 }],
    })
    await expect(createLinuxProvisioner(old.deps).prepare(record(), signal, noOwn)).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
    })
    const none = harness(cleanHost())
    await expect(createLinuxProvisioner(none.deps).prepare(record(), signal, noOwn)).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
    })
    expect(old.dockerCalls).toEqual([])
  })

  it('on an aarch64 GB10 (unified memory, captured shape) checks the arm64 probe image on the GB10 and pulls the arm64 engine image', async () => {
    const GB10 = 'GPU-d991dc71-7825-0bf8-3339-cb2e7ead6a32'
    const arm64 = DESCRIPTOR.image['linux/arm64']
    const arm64Probe = DESCRIPTOR.probe_image['linux/arm64']
    const h = harness({
      ...readyHost(),
      arch: 'aarch64',
      driver: '595.71.05',
      gpus: [{ uuid: GB10, name: 'NVIDIA GB10', cc: '12.1', total_mib: '[N/A]', free_mib: '[N/A]' }],
    })
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.prepare(record(), signal, noOwn)
    expect(h.pulls.map((pull) => pull.ref)).toEqual([`${arm64Probe.repository}@${arm64Probe.digest}`])
    expect(h.dockerCalls.find((args) => args[2] === 'run')).toContain(`device=${GB10}`)
    await provisioner.pull(record(), () => {}, signal)
    expect(h.pulls.map((pull) => pull.ref)).toContain(`${arm64.repository}@${arm64.digest}`)
    expect(h.pulls.map((pull) => pull.ref)).not.toContain(IMAGE_REF)
    expect(h.pulls.map((pull) => pull.ref)).not.toContain(PROBE_REF)
  })

  it('pulls the engine image by the digest for this platform with byte progress', async () => {
    const h = harness(readyHost())
    const progress: unknown[] = []
    await createLinuxProvisioner(h.deps).pull(record(), (tick) => progress.push(tick), signal)
    expect(h.pulls).toEqual([{ ref: IMAGE_REF, knownTotalBytes: DESCRIPTOR.download_bytes }])
    expect(progress[0]).toEqual({
      label: 'Downloading the engine image',
      completed: 0,
      total: DESCRIPTOR.download_bytes,
      unit: 'bytes',
    })
    expect(progress[1]).toMatchObject({ completed: 5, total: 10, unit: 'bytes' })
  })

  it('verifies the digest by inspection and refuses an image that is not there', async () => {
    const present = harness({ ...readyHost(), images: [IMAGE_REF] })
    await expect(createLinuxProvisioner(present.deps).verify(record(), signal)).resolves.toBeUndefined()
    const absent = harness(readyHost())
    await expect(createLinuxProvisioner(absent.deps).verify(record(), signal)).rejects.toMatchObject({
      code: 'MANAGED_IDENTITY_MISMATCH',
    })
  })

  it('verifies an environment-only setup by the daemon and its GPU runtime', async () => {
    const env = record({ target: { kind: 'environment' } })
    await expect(
      createLinuxProvisioner(harness(readyHost()).deps).verify(env, signal)
    ).resolves.toBeUndefined()
    const broken = harness({ ...readyHost(), docker: { ...readyHost().docker, gpu_runtime: false } })
    await expect(createLinuxProvisioner(broken.deps).verify(env, signal)).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
    })
  })

  it('activates by writing the installation pinned to its descriptor and image', async () => {
    const h = harness(readyHost())
    await createLinuxProvisioner(h.deps).activate(
      record({}, { owned_resource_ids: [ownedImageId(PROBE_IMAGE)] }),
      signal
    )
    expect(await h.installations.read('tensorrt-llm')).toEqual({
      schema_version: 1,
      installation: {
        installation_id: 'tensorrt-llm',
        engine_id: 'tensorrt-llm',
        environment_id: 'default',
        active_descriptor_id: DESCRIPTOR.descriptor_id,
        candidate_descriptor_id: null,
        availability: 'supported',
        status: 'ready',
      },
      image: IMAGE,
      probe_image: PROBE_IMAGE,
      platform: 'linux/amd64',
      installed_at: '2026-09-29T00:00:00.000Z',
    })
  })
})

describe('recovery questions', () => {
  it.each([
    // [what, docker, group, user, expected]
    [
      'granted, not in this session, daemon running',
      { reachable: false, service_active: true },
      { configured: true, effective: false },
      'ada',
      true,
    ],
    [
      'daemon not running: a sign-in would not help',
      { reachable: false, service_active: false },
      { configured: true, effective: false },
      'ada',
      false,
    ],
    [
      'root never needs a sign-in (design D4)',
      { reachable: false, service_active: true },
      { configured: true, effective: false },
      'root',
      false,
    ],
    [
      'not in the group at all',
      { reachable: false, service_active: true },
      { configured: false, effective: false },
      'ada',
      false,
    ],
    [
      'already in this session',
      { reachable: false, service_active: true },
      { configured: true, effective: true },
      'ada',
      false,
    ],
    [
      'the daemon answers: nothing to wait for',
      { reachable: true, service_active: true },
      { configured: true, effective: false },
      'ada',
      false,
    ],
  ] as const)('needsRelogin: %s', async (_what, docker, group, user, expected) => {
    const h = harness({
      ...readyHost(),
      user,
      docker: { installed: true, gpu_runtime: true, ...docker },
      group: { ...group },
    })
    h.deps.host = { ...h.deps.host, options: () => ({ user, xdgRuntimeDir: null }) }
    expect(await createLinuxProvisioner(h.deps).inventory.needsRelogin(record())).toBe(expected)
  })

  it('finds a committed activation by id even when its descriptor has left the cache (review r2, item C)', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.activate(record(), signal)
    h.deps.descriptors = {
      ...h.deps.descriptors,
      forInstallation: async () => ({ kind: 'unsupported', error: new Error('gone') as never }),
    }
    const effect = { effect_id: 'e', operation_id: 'op-1', expected_revision: 1, plan_digest: null }
    expect(
      (await createLinuxProvisioner(h.deps).inventory.inspect({ ...effect, kind: 'activate' }, record())).kind
    ).toBe('completed')
  })

  it('does not count a `removing` record as a completed activation, and resuming re-activates it to `ready` (N-1)', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    // A first setup completed activation...
    await provisioner.activate(record(), signal)
    const activated = await h.installations.read('tensorrt-llm')
    // ...then a removal started (writing `removing` first, final review I-1) and crashed partway,
    // before the record was ever deleted. The descriptor id on the record is untouched, so a check
    // that only compares ids would see this as an already-completed activation.
    await h.installations.write({
      ...activated!,
      installation: { ...activated!.installation, status: 'removing' },
    })
    const effect = { effect_id: 'e', operation_id: 'op-1', expected_revision: 1, plan_digest: null }
    expect((await provisioner.inventory.inspect({ ...effect, kind: 'activate' }, record())).kind).toBe(
      'absent'
    )
    // Resuming (a fresh setup of the same descriptor) must therefore re-run activation...
    await provisioner.activate(record(), signal)
    // ...and end with a `ready` record, not stuck `removing` forever.
    expect((await h.installations.read('tensorrt-llm'))?.installation.status).toBe('ready')
  })

  it('answers absent rather than throwing when the machine cannot even say its architecture', async () => {
    const h = harness({ ...readyHost(), arch: 'riscv64', images: [IMAGE_REF] })
    const effect = { effect_id: 'e', operation_id: 'op-1', expected_revision: 1, plan_digest: null }
    await expect(
      createLinuxProvisioner(h.deps).inventory.inspect({ ...effect, kind: 'pull-image' }, record())
    ).resolves.toEqual({ kind: 'absent' })
  })

  it('finds a pulled image as a completed pull, and an activation by its record', async () => {
    const h = harness({ ...readyHost(), images: [IMAGE_REF] })
    const provisioner = createLinuxProvisioner(h.deps)
    const effect = { effect_id: 'e', operation_id: 'op-1', expected_revision: 1, plan_digest: null }
    expect((await provisioner.inventory.inspect({ ...effect, kind: 'pull-image' }, record())).kind).toBe(
      'completed'
    )
    const planned = record({}, { requirement_plan: { descriptor_id: DESCRIPTOR.descriptor_id } as never })
    expect((await provisioner.inventory.inspect({ ...effect, kind: 'activate' }, planned)).kind).toBe(
      'absent'
    )
    await provisioner.activate(planned, signal)
    expect((await provisioner.inventory.inspect({ ...effect, kind: 'activate' }, planned)).kind).toBe(
      'completed'
    )
    expect(
      (await provisioner.inventory.inspect({ ...effect, kind: 'prepare-environment' }, planned)).kind
    ).toBe('absent')
    const empty = harness(readyHost())
    expect(
      (
        await createLinuxProvisioner(empty.deps).inventory.inspect(
          { ...effect, kind: 'pull-image' },
          record()
        )
      ).kind
    ).toBe('absent')
  })

  it('keeps completed steps only while what they installed is still there', async () => {
    const withStep = record()
    withStep.machine.operation.completed_step_ids = ['host-step-1']
    expect(
      await createLinuxProvisioner(harness(readyHost()).deps).inventory.verifyCompletedSteps(withStep)
    ).toEqual(['host-step-1'])
    expect(
      await createLinuxProvisioner(harness(cleanHost()).deps).inventory.verifyCompletedSteps(withStep)
    ).toEqual([])
    expect(
      await createLinuxProvisioner(harness(readyHost()).deps).inventory.verifyCompletedSteps(record())
    ).toEqual([])
  })

  it('computes the current plan digest, and never needs a reboot', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    expect(await provisioner.inventory.currentPlanDigest(record())).toBe(
      (await provisioner.probe(record(), signal)).plan.plan_digest
    )
    expect(await provisioner.inventory.needsReboot(record())).toBe(false)
  })

  it('shares one probe of the machine among questions asked at the same time', async () => {
    const h = harness(readyHost())
    let unames = 0
    const exec = h.deps.host.probeDeps.exec
    h.deps.host = {
      ...h.deps.host,
      probeDeps: {
        ...h.deps.host.probeDeps,
        exec: async (command, args, env) => {
          if (command === 'uname') unames += 1
          return exec(command, args, env)
        },
      },
    }
    const provisioner = createLinuxProvisioner(h.deps)
    await Promise.all([
      provisioner.inventory.needsRelogin(record()),
      provisioner.inventory.verifyCompletedSteps({
        ...record(),
        machine: {
          ...record().machine,
          operation: { ...record().machine.operation, completed_step_ids: ['s'] },
        },
      }),
    ])
    expect(unames).toBe(1)
    await provisioner.inventory.needsRelogin(record())
    expect(unames).toBe(2)
  })
})

describe('removing the installation', () => {
  const ours = (id: string): ExecutionRecord => ({
    container_id: id,
    engine_id: 'tensorrt-llm',
    image_digest: IMAGE.digest,
    scope: 'app',
    instance_id: 'core-0',
    created_at: '2026-09-28T00:00:00.000Z',
  })

  /** Installed by a setup that pulled the GPU-check image itself, unless `probePulled` says otherwise. */
  const installed = async (state: FakeLinuxHostState, probePulled = true) => {
    const h = harness({ ...state, images: [IMAGE_REF, PROBE_REF, 'docker.io/library/postgres@sha256:beef'] })
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.activate(
      record({}, { owned_resource_ids: probePulled ? [ownedImageId(PROBE_IMAGE)] : [] }),
      signal
    )
    return { h, provisioner }
  }

  it('never removes a GPU-check image the user already had before setup (review r2, item B)', async () => {
    const { h, provisioner } = await installed(readyHost(), false)
    expect((await provisioner.probe(removal(), signal)).plan.system_changes.map((c) => c.code)).not.toContain(
      'remove-probe-image'
    )
    await provisioner.remove(removal(), signal)
    expect(h.machine.state.images).toContain(PROBE_REF)
    expect(h.machine.state.images).not.toContain(IMAGE_REF)
  })

  const removal = (request: Partial<BeginOperation> = {}) =>
    record({ kind: 'remove', descriptor_id: undefined as never, ...request })

  it('plans what it deletes and asks nothing of the host', async () => {
    const { provisioner } = await installed(readyHost())
    const answer = await provisioner.probe(removal(), signal)
    expect(answer.plan.blockers).toEqual([])
    expect(answer.plan.requires_elevation).toBe(false)
    expect(answer.plan.system_changes.map((change) => change.code)).toEqual([
      'unload-sessions',
      'remove-containers',
      'remove-image',
      'remove-probe-image',
      'remove-engine-caches',
      'remove-installation',
    ])
    const dropModels = await provisioner.probe(removal({ retain_models: false }), signal)
    expect(dropModels.plan.system_changes.map((change) => change.code)).toContain('remove-models')
    expect(dropModels.plan.plan_digest).not.toBe(answer.plan.plan_digest)
  })

  it('unloads first, then removes our containers, the image, the caches and the record — models stay', async () => {
    const { h, provisioner } = await installed(readyHost())
    h.journal.push(ours('ours-1'), { ...ours('other-engine'), engine_id: 'vllm' })
    await provisioner.remove(removal(), signal)
    expect(h.calls).toEqual([
      'unload:tensorrt-llm',
      'journal-remove:ours-1',
      `caches:${DESCRIPTOR.descriptor_id}`,
    ])
    expect(h.machine.state.images).toEqual(['docker.io/library/postgres@sha256:beef'])
    expect(await h.installations.read('tensorrt-llm')).toBeNull()
    // Another engine's container, Docker itself and the rest of the host are not touched.
    const subcommands = h.dockerCalls.map((args) => args.slice(2, 4).join(' '))
    expect(subcommands).toEqual(['stop --time', 'rm ours-1', 'ps --all', 'image rm', 'ps --all', 'image rm'])
    expect(h.dockerCalls.at(-1)).toContain(PROBE_REF)
  })

  it('keeps the GPU-check image while another installation recorded it (review r1, item 7)', async () => {
    const { h, provisioner } = await installed(readyHost())
    const mine = await h.installations.read('tensorrt-llm')
    await h.installations.write({
      ...mine!,
      installation: { ...mine!.installation, installation_id: 'other-engine', engine_id: 'other' },
    })
    await provisioner.remove(removal(), signal)
    expect(h.machine.state.images).toContain(PROBE_REF)
    expect(h.machine.state.images).not.toContain(IMAGE_REF)
  })

  it('keeps the image when a container that is not ours still uses it', async () => {
    const { h, provisioner } = await installed({
      ...readyHost(),
      containers: [{ id: 'theirs', image: IMAGE_REF }],
    })
    h.machine.state = { ...h.machine.state, containers: [{ id: 'theirs', image: IMAGE_REF }] }
    await provisioner.remove(removal(), signal)
    expect(h.machine.state.images).toContain(IMAGE_REF)
    expect(await h.installations.read('tensorrt-llm')).toBeNull()
  })

  it('deletes the models only when asked to', async () => {
    const { h, provisioner } = await installed(readyHost())
    await provisioner.remove(removal({ retain_models: false }), signal)
    expect(h.calls).toContain('models:tensorrt-llm')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'never leaves a ready record behind a removal that failed part-way, and a retry finishes it (final review I-1)',
    async () => {
      const { h, provisioner } = await installed(readyHost())
      // A cache subtree the user cannot delete: what an engine running as root would leave behind.
      const paths = dataLayout(data).managed
      const stuck = join(paths.engineCacheDir(DESCRIPTOR.descriptor_id, 'org/model'), 'inductor')
      await mkdir(join(stuck, 'kernels'), { recursive: true })
      await writeFile(join(stuck, 'kernels', 'k.so'), 'x')
      await chmod(stuck, 0o555)
      h.deps.removeEngineCaches = async (descriptorId) => {
        await removeEngineCaches(paths, { descriptorId })
      }
      try {
        await expect(provisioner.remove(removal(), signal)).rejects.toMatchObject({ code: 'EACCES' })
        // The image is gone, so the record must not say `ready`: a load is refused as not ready,
        // never sent to `docker create` for an image that no longer exists.
        expect(h.machine.state.images).not.toContain(IMAGE_REF)
        expect((await h.installations.read('tensorrt-llm'))?.installation.status).toBe('removing')
      } finally {
        await chmod(stuck, 0o755)
      }
      await provisioner.remove(removal(), signal)
      expect(await h.installations.read('tensorrt-llm')).toBeNull()
      expect(existsSync(paths.descriptorCachesDir(DESCRIPTOR.descriptor_id))).toBe(false)
    }
  )

  it('keeps loads of the engine held off for the whole removal, and lifts the hold however it ends (final review M-1)', async () => {
    const { h } = await installed(readyHost())
    let released = 0
    let heldWhileRecordDeleted = false
    h.deps.unloadEngineSessions = async (engineId) => {
      h.calls.push(`unload:${engineId}`)
      return { unloaded: 0, release: () => (released += 1) }
    }
    const remove = h.installations.remove.bind(h.installations)
    h.installations.remove = async (id) => {
      heldWhileRecordDeleted = released === 0
      await remove(id)
    }
    // A provisioner reads its `unloadEngineSessions` once, when it is made.
    await createLinuxProvisioner(h.deps).remove(removal(), signal)
    expect(heldWhileRecordDeleted).toBe(true)
    expect(released).toBe(1)

    const again = await installed(readyHost())
    let releasedOnFailure = 0
    again.h.deps.unloadEngineSessions = async () => ({ unloaded: 0, release: () => (releasedOnFailure += 1) })
    again.h.deps.removeEngineCaches = async () => {
      throw new Error('disk gone')
    }
    await expect(createLinuxProvisioner(again.h.deps).remove(removal(), signal)).rejects.toThrow('disk gone')
    expect(releasedOnFailure).toBe(1)
  })

  it('stops when a loaded model cannot be confirmed stopped, and removes nothing', async () => {
    const { h, provisioner } = await installed(readyHost())
    h.deps.unloadEngineSessions = async () => {
      throw Object.assign(new Error('stop unconfirmed'), { code: 'MANAGED_STOP_UNCONFIRMED' })
    }
    await expect(createLinuxProvisioner(h.deps).remove(removal(), signal)).rejects.toThrow('stop unconfirmed')
    expect(h.machine.state.images).toContain(IMAGE_REF)
    expect(await h.installations.read('tensorrt-llm')).not.toBeNull()
    void provisioner
  })

  it('refuses to remove the environment itself', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    const env = removal({ target: { kind: 'environment' } })
    expect((await provisioner.probe(env, signal)).plan.blockers[0]?.reason).toBe('remove-environment')
    await expect(provisioner.remove(env, signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('is a no-op for an installation that is already gone, and needs no relogin', async () => {
    const h = harness(readyHost())
    const provisioner = createLinuxProvisioner(h.deps)
    await provisioner.remove(removal(), signal)
    expect(h.calls).toEqual(['unload:tensorrt-llm'])
    expect(await provisioner.inventory.needsRelogin(removal())).toBe(false)
    expect(
      (
        await provisioner.inventory.inspect(
          { effect_id: 'e', operation_id: 'op-1', expected_revision: 1, plan_digest: null, kind: 'remove' },
          removal()
        )
      ).kind
    ).toBe('absent')
  })

  it('leaves nothing to clean up on a cancelled setup, and updates are not this change', async () => {
    const provisioner = createLinuxProvisioner(harness(readyHost()).deps)
    await expect(provisioner.cleanup(record(), signal)).resolves.toBeUndefined()
    await expect(provisioner.unloadResident(record(), signal)).resolves.toBeUndefined()
  })
})

describe('helpers', () => {
  const gpu = (id: string, cc: string, total: number | null): GpuFacts => ({
    gpu_id: id,
    name: id,
    compute_capability: cc,
    total_vram_bytes: total,
    free_vram_bytes: total,
    driver_version: '590',
  })

  it('picks the largest eligible card, a unified-memory one when it is all there is', () => {
    expect(pickGpu([gpu('a', '8.6', 10), gpu('b', '8.9', 20), gpu('c', '7.5', 99)], '8.0')?.gpu_id).toBe('b')
    expect(pickGpu([gpu('spark', '12.1', null)], '8.0')?.gpu_id).toBe('spark')
    expect(pickGpu([gpu('old', '7.5', 8)], '8.0')).toBeNull()
  })

  // GB10 captured on a DGX Spark-class host; GH200 and RTX 5090 documented, not captured.
  it.each([
    ['GB10 (12.1, unified memory: no size at all)', 'nvidia-smi/gb10-driver595-captured.csv'],
    ['GH200 (9.0, 96 GB)', 'nvidia-smi/gh200-documented.csv'],
    ['RTX 5090 (12.0, 32 GB)', 'nvidia-smi/rtx5090-documented.csv'],
  ])('the %s qualifies for the 8.0 minimum, whatever its memory says', (_label, fixture) => {
    const { gpus } = parseNvidiaSmi({ code: 0, stdout: readLinuxProbeFixture(fixture), stderr: '' })
    expect(pickGpu(gpus, DESCRIPTOR.minimum_compute_capability)).toEqual(gpus[0])
  })

  it('matches an image by its repo digest only', () => {
    expect(imageMatchesDigest({ RepoDigests: [IMAGE_REF] }, IMAGE)).toBe(true)
    expect(imageMatchesDigest({ RepoDigests: ['other@sha256:1'] }, IMAGE)).toBe(false)
    expect(imageMatchesDigest(null, IMAGE)).toBe(false)
  })

  it('gives a relogin its own code and keeps the blocker structured', () => {
    expect(toManagedBlocker({ reason: 'relogin-required', message: 'm', commands: ['c'] })).toEqual({
      code: 'MANAGED_RELOGIN_REQUIRED',
      message: 'm',
      details: 'relogin-required',
      reason: 'relogin-required',
      commands: ['c'],
    })
    expect(toManagedBlocker({ reason: 'driver-too-old', message: 'm', params: { a: 'b' } }).code).toBe(
      'MANAGED_PREREQUISITE_BLOCKED'
    )
  })
})
