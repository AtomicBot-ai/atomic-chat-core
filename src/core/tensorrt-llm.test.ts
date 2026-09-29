import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { RuntimeDescriptor, SessionInfo } from '../contracts/index.js'
import { ExecutionJournal, reconcileExecutions } from '../runtime/container/index.js'
import type { DockerExec, ManagedContainers, ManagedContainersHandle } from '../runtime/container/index.js'
import { InstallationStore, parseRuntimeDescriptor } from '../runtime/environment/index.js'
import type { LinuxProbeDeps } from '../runtime/environment/index.js'
import type { ManagedTextLifecycle } from '../runtime/managed-text/index.js'
import type { LocalRuntime } from '../runtime/shared/index.js'
import { NVIDIA_SMI_GPU_QUERY, TensorrtLlmRuntime } from '../runtime/tensorrt-llm/index.js'
import { FakeDocker } from '../../test/helpers/fake-docker-exec.js'
import { readRuntimeFixture } from '../../test/helpers/runtime-fixtures.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { leftoverContainers, tensorrtLlmSessionUnloader, wireTensorrtLlm } from './tensorrt-llm.js'
import type { WireTensorrtLlmOptions } from './tensorrt-llm.js'

const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json')) as RuntimeDescriptor

let data: TmpDataFolder
let hostCalls: string[][]
beforeEach(async () => {
  data = await makeTmpDataFolder('core-trt-wiring-')
  hostCalls = []
})
afterEach(() => data.cleanup())

/** A Linux machine whose `nvidia-smi` finds no card: a load stops right before any container. */
const cardless: Pick<{ probeDeps: Pick<LinuxProbeDeps, 'exec'> }, 'probeDeps'> = {
  probeDeps: {
    exec: async (command, args) => {
      hostCalls.push([command, ...args])
      return { code: 127, stdout: '', stderr: `${command}: command not found` }
    },
  },
}

/** A handle as `createManagedContainersHandle` gives one: `wired` answers every `resolve()`. */
function handle(wired: () => Promise<ManagedContainers | null>): ManagedContainersHandle {
  let current: ManagedContainers | null = null
  return {
    current: () => current,
    resolve: async () => (current = await wired()),
  }
}

const noDocker = handle(async () => null)

const options = (over: Partial<WireTensorrtLlmOptions> = {}): WireTensorrtLlmOptions => ({
  platform: 'linux',
  arch: 'x64',
  layout: data.layout,
  instanceId: 'core-1',
  scope: 'app',
  descriptors: {
    forInstallation: async (id) => ({
      kind: 'unsupported',
      error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'not cached', id),
    }),
  },
  installations: new InstallationStore(join(data.root, 'managed')),
  containers: noDocker,
  host: cardless as WireTensorrtLlmOptions['host'],
  trustedHosts: [],
  settings: () => ({}),
  emit: () => {},
  log: () => {},
  ...over,
})

/** What `docker info` answers on a daemon without SELinux; everything else goes to the fake. */
const withInfo =
  (docker: FakeDocker): DockerExec =>
  async (args, callOptions) =>
    args[2] === 'info'
      ? { code: 0, stdout: JSON.stringify({ ServerVersion: '28.1.1', SecurityOptions: [] }), stderr: '' }
      : docker.exec(args, callOptions)

async function readyInstallation(store: InstallationStore): Promise<void> {
  await store.write({
    schema_version: 1,
    installation: {
      installation_id: 'trt-1',
      engine_id: 'tensorrt-llm',
      environment_id: 'default',
      active_descriptor_id: descriptor.descriptor_id,
      candidate_descriptor_id: null,
      availability: 'supported',
      status: 'ready',
    },
    image: descriptor.image['linux/amd64'],
    platform: 'linux/amd64',
    installed_at: '2026-09-29T00:00:00.000Z',
  })
}

async function installModel(id: string): Promise<void> {
  const dir = join(data.layout.provider('tensorrt-llm').modelsDir, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.yml'), 'architectures: [LlamaForCausalLM]\n')
}

describe('wireTensorrtLlm', () => {
  it.each<NodeJS.Platform>(['darwin', 'win32', 'freebsd'])('offers no provider on %s', (platform) => {
    expect(wireTensorrtLlm(options({ platform }))).toBeNull()
  })

  it('offers the provider on Linux', async () => {
    const runtime = wireTensorrtLlm(options())
    expect(runtime).toBeInstanceOf(TensorrtLlmRuntime)
    await runtime?.shutdown()
  })

  it('refuses a load with MANAGED_ADAPTER_UNAVAILABLE on a Linux host with no docker CLI', async () => {
    const runtime = wireTensorrtLlm(options()) as TensorrtLlmRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })

  it("with the setup's ready installation, looks the model up in <data>/tensorrt-llm/models and asks the environment's machine for its cards", async () => {
    const installations = new InstallationStore(join(data.root, 'managed'))
    await readyInstallation(installations)
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    const runtime = wireTensorrtLlm(
      options({
        installations,
        descriptors: { forInstallation: async () => ({ kind: 'available', descriptor }) },
        containers: handle(async () => ({
          exec: withInfo(docker),
          journal,
          dockerPath: '/usr/bin/docker',
          socketPath: '/var/run/docker.sock',
          reconciled: { stopped: [], removed: [], kept: [] } as unknown as ManagedContainers['reconciled'],
        })),
      })
    ) as TensorrtLlmRuntime
    await expect(runtime.load('not-installed')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })

    await installModel('m')
    // No nvidia-smi answers on this host: no card, so nothing is created.
    await expect(runtime.load('m')).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message: expect.stringContaining('No NVIDIA GPU'),
    })
    expect(hostCalls).toEqual([['nvidia-smi', ...NVIDIA_SMI_GPU_QUERY]])
    expect(docker.calls).toEqual([])
    await runtime.shutdown()
  })

  it('asks the handle again at the next load: Docker a setup installed after startup is found without a restart', async () => {
    const installations = new InstallationStore(join(data.root, 'managed'))
    await readyInstallation(installations)
    await installModel('m')
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    let installed = false
    let wirings = 0
    const runtime = wireTensorrtLlm(
      options({
        installations,
        descriptors: { forInstallation: async () => ({ kind: 'available', descriptor }) },
        containers: handle(async () => {
          wirings += 1
          return installed ? ({ exec: withInfo(docker), journal } as unknown as ManagedContainers) : null
        }),
      })
    ) as TensorrtLlmRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({
      code: 'MANAGED_ADAPTER_UNAVAILABLE',
      message: expect.stringContaining('Docker is not installed'),
    })
    installed = true
    // Past the Docker check now: it stops at the card, which this host does not have.
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_PREREQUISITE_BLOCKED' })
    // The lifecycle is built once and kept: a third load does not wire again.
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_PREREQUISITE_BLOCKED' })
    expect(wirings).toBe(2)
    await runtime.shutdown()
  })

  it('refuses the load when docker info cannot answer: whether SELinux needs `:z` is then unknown', async () => {
    const installations = new InstallationStore(join(data.root, 'managed'))
    await readyInstallation(installations)
    await installModel('m')
    const journal = await ExecutionJournal.open(data.layout)
    const docker = new FakeDocker()
    const runtime = wireTensorrtLlm(
      options({
        installations,
        descriptors: { forInstallation: async () => ({ kind: 'available', descriptor }) },
        // An executor the handle no longer reports: the probe gets no `docker info` answer at all.
        containers: {
          resolve: async () => ({ exec: docker.exec, journal }) as unknown as ManagedContainers,
          current: () => null,
        },
      })
    ) as TensorrtLlmRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message: expect.stringContaining('docker info'),
    })
    expect(docker.calls).toEqual([])
    await runtime.shutdown()
  })

  it('reads installations from the shared root: none there refuses the load before any docker call', async () => {
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    const runtime = wireTensorrtLlm(
      options({
        containers: handle(async () => ({ exec: docker.exec, journal }) as unknown as ManagedContainers),
      })
    ) as TensorrtLlmRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
    expect(docker.calls).toEqual([])
    await runtime.shutdown()
  })
})

describe('wireTensorrtLlm: a container runtime that failed to initialise', () => {
  it('refuses a load naming the failure and its cause, not a missing docker CLI', async () => {
    const runtime = wireTensorrtLlm(
      options({
        containers: handle(() => Promise.reject(new Error('journal unreadable'))),
      })
    ) as TensorrtLlmRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({
      code: 'MANAGED_ADAPTER_UNAVAILABLE',
      message: expect.stringContaining('failed to initialise'),
      details: 'journal unreadable',
    })
    await runtime.shutdown()
  })
})

describe('tensorrtLlmSessionUnloader', () => {
  /**
   * A provider over a lifecycle that loads instantly and whose stop Docker confirms unless told not
   * to: the real lifecycle's confirmed stop is `runtime.test.ts`'s and `lifecycle.test.ts`'s.
   */
  function provider(stopConfirms: () => boolean) {
    const loaded = new Set<string>()
    const events: string[] = []
    const lifecycle = {
      load: async ({ modelId }: { modelId: string }) => {
        loaded.add(modelId)
        return { model_id: modelId, generation: 'gen-1' } as unknown as SessionInfo
      },
      reservations: () => [...loaded].map((model_id) => ({ model_id })),
      list: () => [...loaded].map((model_id) => ({ model_id }) as unknown as SessionInfo),
      findSession: (modelId: string) =>
        loaded.has(modelId) ? ({ model_id: modelId } as unknown as SessionInfo) : undefined,
      unload: async (modelId: string) => {
        if (!stopConfirms()) {
          throw new AtomicCoreError('MANAGED_STOP_UNCONFIRMED', 'Docker did not confirm the stop.', modelId)
        }
        events.push(`stopped:${modelId}`)
        loaded.delete(modelId)
      },
      shutdown: async () => undefined,
    } as unknown as ManagedTextLifecycle
    const runtime = new TensorrtLlmRuntime({
      lifecycle: async () => lifecycle,
      readyInstallation: async () => ({
        installation: {} as never,
        descriptor,
        image: descriptor.image['linux/amd64'],
      }),
      hostFacts: async () => ({
        gpus: [
          {
            gpu_id: 'GPU-0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
            name: 'RTX 4090',
            compute_capability: '8.9',
            total_vram_bytes: 24 * 1024 ** 3,
            free_vram_bytes: 24 * 1024 ** 3,
            driver_version: '590.44.01',
          },
        ],
        selinux: false,
      }),
      model: async (modelId) => ({ id: modelId, dir: '/m', architecture: null, weightBytes: 1 }) as never,
      settings: () => ({}),
    })
    return { runtime, events }
  }

  it('unloads the loaded tensorrt-llm model with its stop confirmed, before a removal goes on', async () => {
    const { runtime, events } = provider(() => true)
    await runtime.load('m')
    const unload = tensorrtLlmSessionUnloader(() => runtime)
    expect(await unload('tensorrt-llm')).toEqual({ unloaded: 1 })
    expect(events).toEqual(['stopped:m'])
    expect(runtime.getLoadedModels()).toEqual([])
    expect(await unload('tensorrt-llm')).toEqual({ unloaded: 0 })
  })

  it('fails the removal with MANAGED_STOP_UNCONFIRMED when Docker will not confirm the stop', async () => {
    let confirms = false
    const { runtime } = provider(() => confirms)
    await runtime.load('m')
    const unload = tensorrtLlmSessionUnloader(() => runtime)
    await expect(unload('tensorrt-llm')).rejects.toMatchObject({ code: 'MANAGED_STOP_UNCONFIRMED' })
    expect(runtime.getLoadedModels()).toEqual(['m'])
    confirms = true
    expect(await unload('tensorrt-llm')).toEqual({ unloaded: 1 })
  })

  it.each<[string, string, () => LocalRuntime | undefined]>([
    ['another engine', 'vllm', () => provider(() => true).runtime],
    ['a core that offers no tensorrt-llm provider', 'tensorrt-llm', () => undefined],
    ['a provider that is not the tensorrt-llm one', 'tensorrt-llm', () => ({}) as LocalRuntime],
  ])('reports nothing unloaded for %s', async (_label, engineId, runtime) => {
    expect(await tensorrtLlmSessionUnloader(runtime)(engineId)).toEqual({ unloaded: 0 })
  })
})

describe('leftoverContainers', () => {
  it('holds every card for a container a previous core left that startup could not stop, until a retried stop is confirmed', async () => {
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    docker.containers.set('oldctr', {
      id: 'oldctr',
      createArgv: [],
      status: 'running',
      exitCode: null,
      logs: [],
    })
    await journal.add({
      container_id: 'oldctr',
      engine_id: 'tensorrt-llm',
      image_digest: 'sha256:0',
      scope: 'app',
      instance_id: 'core-0',
      created_at: '2026-09-29T00:00:00.000Z',
    })
    docker.stopConfirms = false
    const reconciled = await reconcileExecutions(journal, 'core-1', docker.exec, () => {})
    expect(reconciled.unconfirmed.map((r) => r.container_id)).toEqual(['oldctr'])
    const wired: ManagedContainers = {
      exec: docker.exec,
      journal,
      dockerPath: '/usr/bin/docker',
      socketPath: '/var/run/docker.sock',
      reconciled,
    }
    const leftovers = leftoverContainers({
      containers: { current: () => wired },
      instanceId: 'core-1',
      log: () => {},
    })

    const [held] = leftovers()
    expect(held).toMatchObject({
      provider: 'tensorrt-llm',
      model_id: 'oldctr',
      cards: 'all',
      auxiliary: false,
      state: 'stop-unconfirmed',
    })
    // Still no confirmation: still held, and the eviction says why.
    await expect(held?.evict()).rejects.toThrow('Docker did not confirm container oldctr stopped')
    expect(leftovers().map((o) => o.model_id)).toEqual(['oldctr'])

    docker.stopConfirms = true
    await leftovers()[0]?.evict()
    expect(leftovers()).toEqual([])
    expect(journal.list()).toEqual([])
    expect(docker.containers.has('oldctr')).toBe(false)
  })

  it('holds nothing while no Docker executor is wired', () => {
    expect(
      leftoverContainers({ containers: { current: () => null }, instanceId: 'core-1', log: () => {} })()
    ).toEqual([])
  })
})
