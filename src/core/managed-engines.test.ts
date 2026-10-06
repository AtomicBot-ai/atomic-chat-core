import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type { LocalProviderId, RuntimeDescriptor, SessionInfo } from '../contracts/index.js'
import { acquireModelClaim } from '../lock/index.js'
import { ExecutionJournal, reconcileExecutions } from '../runtime/container/index.js'
import type { DockerExec, ManagedContainers, ManagedContainersHandle } from '../runtime/container/index.js'
import { InstallationStore, parseRuntimeDescriptor } from '../runtime/environment/index.js'
import type { LinuxProbeDeps } from '../runtime/environment/index.js'
import type { ManagedTextLifecycle } from '../runtime/managed-text/index.js'
import { raceLoadCancel } from '../runtime/shared/index.js'
import type { ExternalSessions, LocalRuntime } from '../runtime/shared/index.js'
import { ManagedTextRuntime } from '../runtime/managed-engines/index.js'
import type { ManagedEngineSpec } from '../runtime/managed-engines/index.js'
import {
  NVIDIA_SMI_GPU_QUERY,
  TENSORRT_LLM_ENGINE,
  TensorrtLlmModelRegistry,
} from '../runtime/tensorrt-llm/index.js'
import { FakeDocker } from '../../test/helpers/fake-docker-exec.js'
import { readRuntimeFixture } from '../../test/helpers/runtime-fixtures.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import {
  leftoverContainers,
  managedModelDeleter,
  managedSessionUnloader,
  tensorrtLlmModelLocation,
  tensorrtLlmModelRegistry,
  windowsDeployment,
  windowsModelFiles,
  windowsModelFilesFor,
  wiredExec,
  wireManagedEngine,
  wireManagedModelCheck,
} from './managed-engines.js'
import type {
  WindowsManagedContext,
  WireManagedModelCheckOptions,
  WireManagedEngineOptions,
} from './managed-engines.js'
import { fakeWindows } from '../../test/helpers/fake-windows-host.js'
import { createDistributionKeeper, directoryGuestMount } from '../runtime/wsl/index.js'
import { LocalSessions } from './sessions.js'

const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json')) as RuntimeDescriptor

let data: TmpDataFolder
let hostCalls: string[][]
beforeEach(async () => {
  data = await makeTmpDataFolder('core-trt-wiring-')
  hostCalls = []
})
afterEach(() => data.cleanup())

/** A Linux machine whose `nvidia-smi` finds no card: a load stops right before any container. */
const cardless: Pick<{ probeDeps: Pick<LinuxProbeDeps, 'exec' | 'readFile'> }, 'probeDeps'> = {
  probeDeps: {
    exec: async (command, args) => {
      hostCalls.push([command, ...args])
      return { code: 127, stdout: '', stderr: `${command}: command not found` }
    },
    readFile: async () => null,
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

const options = (over: Partial<WireManagedEngineOptions> = {}): WireManagedEngineOptions => ({
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
  host: cardless as WireManagedEngineOptions['host'],
  trustedHosts: [],
  settings: () => ({}),
  emit: () => {},
  log: () => {},
  containerUser: null,
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

describe('wireManagedEngine (tensorrt-llm)', () => {
  it.each<NodeJS.Platform>(['darwin', 'win32', 'freebsd'])('offers no provider on %s', (platform) => {
    expect(wireManagedEngine(TENSORRT_LLM_ENGINE, options({ platform }))).toBeNull()
  })

  it('offers the provider on Linux', async () => {
    const runtime = wireManagedEngine(TENSORRT_LLM_ENGINE, options())
    expect(runtime).toBeInstanceOf(ManagedTextRuntime)
    await runtime?.shutdown()
  })

  it('refuses a load with MANAGED_ADAPTER_UNAVAILABLE on a Linux host with no docker CLI', async () => {
    const runtime = wireManagedEngine(TENSORRT_LLM_ENGINE, options()) as ManagedTextRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })

  it("with the setup's ready installation, looks the model up in <data>/tensorrt-llm/models and asks the environment's machine for its cards", async () => {
    const installations = new InstallationStore(join(data.root, 'managed'))
    await readyInstallation(installations)
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    const runtime = wireManagedEngine(
      TENSORRT_LLM_ENGINE,
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
    ) as ManagedTextRuntime
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
    const runtime = wireManagedEngine(
      TENSORRT_LLM_ENGINE,
      options({
        installations,
        descriptors: { forInstallation: async () => ({ kind: 'available', descriptor }) },
        containers: handle(async () => {
          wirings += 1
          return installed ? ({ exec: withInfo(docker), journal } as unknown as ManagedContainers) : null
        }),
      })
    ) as ManagedTextRuntime
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
    const runtime = wireManagedEngine(
      TENSORRT_LLM_ENGINE,
      options({
        installations,
        descriptors: { forInstallation: async () => ({ kind: 'available', descriptor }) },
        // The lifecycle's own executor, which answers nothing to `docker info` (final review T-288:
        // the probe asks the executor the lifecycle was built over, never a second lookup).
        containers: handle(async () => ({ exec: docker.exec, journal }) as unknown as ManagedContainers),
      })
    ) as ManagedTextRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      message: expect.stringContaining('docker info'),
    })
    // `docker info` was asked, and nothing was ever created.
    expect(docker.calls.map((args) => args[0])).toEqual(['info'])
    await runtime.shutdown()
  })

  it('reads installations from the shared root: none there refuses the load before any docker call', async () => {
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    const runtime = wireManagedEngine(
      TENSORRT_LLM_ENGINE,
      options({
        containers: handle(async () => ({ exec: docker.exec, journal }) as unknown as ManagedContainers),
      })
    ) as ManagedTextRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
    expect(docker.calls).toEqual([])
    await runtime.shutdown()
  })
})

describe('wireManagedEngine: a container runtime that failed to initialise', () => {
  it('refuses a load naming the failure and its cause, not a missing docker CLI', async () => {
    const runtime = wireManagedEngine(
      TENSORRT_LLM_ENGINE,
      options({
        containers: handle(() => Promise.reject(new Error('journal unreadable'))),
      })
    ) as ManagedTextRuntime
    await expect(runtime.load('m')).rejects.toMatchObject({
      code: 'MANAGED_ADAPTER_UNAVAILABLE',
      message: expect.stringContaining('failed to initialise'),
      details: 'journal unreadable',
    })
    await runtime.shutdown()
  })
})

/**
 * A real, on-disk model directory for `provider()`'s fake `model:` dep: `ManagedTextRuntime.load`
 * now runs the pre-launch check (task 2.16) before `lifecycle.load`, which re-reads `config.json`
 * and re-verifies the file listing from real disk — a `dir` that does not exist would refuse every
 * `runtime.load('m')` call below with `MODEL_FILE_NOT_FOUND` before it ever reached the fake
 * lifecycle these tests are actually about.
 */
let modelDir: string
beforeEach(async () => {
  modelDir = join(data.root, 'fake-model')
  await mkdir(modelDir, { recursive: true })
  await writeFile(
    join(modelDir, 'config.json'),
    JSON.stringify({ architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' })
  )
  await writeFile(join(modelDir, 'model.safetensors'), Buffer.alloc(20, 1))
})

/**
 * A provider over a lifecycle that loads instantly and whose stop Docker confirms unless told not
 * to: the real lifecycle's confirmed stop is `runtime.test.ts`'s and `lifecycle.test.ts`'s.
 */
function provider(stopConfirms: () => boolean, engine: ManagedEngineSpec = TENSORRT_LLM_ENGINE as never) {
  const loaded = new Set<string>()
  const loading = new Set<string>()
  const events: string[] = []
  /** While set, a load waits for it (or for its own cancel) before it counts as loaded. */
  const hold: { gate: Promise<void> | null } = { gate: null }
  const lifecycle = {
    load: async ({ modelId, signal }: { modelId: string; signal?: AbortSignal }) => {
      if (hold.gate !== null) {
        loading.add(modelId)
        try {
          await raceLoadCancel(hold.gate, signal ?? new AbortController().signal)
        } finally {
          loading.delete(modelId)
        }
      }
      loaded.add(modelId)
      return { model_id: modelId, generation: 'gen-1' } as unknown as SessionInfo
    },
    reservations: () => [...loaded, ...loading].map((model_id) => ({ model_id })),
    list: () => [...loaded].map((model_id) => ({ model_id }) as unknown as SessionInfo),
    findSession: (modelId: string) =>
      loaded.has(modelId) ? ({ model_id: modelId } as unknown as SessionInfo) : undefined,
    isLoading: (modelId: string) => loading.has(modelId),
    unload: async (modelId: string) => {
      if (!loaded.has(modelId)) return
      if (!stopConfirms()) {
        throw new AtomicCoreError('MANAGED_STOP_UNCONFIRMED', 'Docker did not confirm the stop.', modelId)
      }
      events.push(`stopped:${modelId}`)
      loaded.delete(modelId)
    },
    shutdown: async () => undefined,
  } as unknown as ManagedTextLifecycle
  const runtime = new ManagedTextRuntime(engine, {
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
      memory: { availableBytes: 0, totalBytes: 0 },
    }),
    model: async (modelId) => ({
      id: modelId,
      dir: modelDir,
      repository: 'acme/model',
      revision: 'deadbeef',
      architecture: 'LlamaForCausalLM',
      quantization: 'bf16',
      files: [{ path: 'model.safetensors', size: 20, sha256: null }],
      weightBytes: 20,
    }),
    settings: () => ({}),
  })
  // The facade's own per-model transitions and cross-process model claims, over this runtime.
  const runtimes = new Map<LocalProviderId, LocalRuntime>([[engine.provider as LocalProviderId, runtime]])
  const sessions = new LocalSessions({
    layout: data.layout,
    instanceId: 'core-1',
    runtimes,
    externalSessions: {} as ExternalSessions,
    runtime: (id) => runtimes.get(id) as LocalRuntime,
    assertRunning: () => {},
    increaseCtx: async () => ({ ok: false, reason: 'unsupported' }),
    recreateSession: async () => ({ ok: false, reason: 'not-loaded' }),
  })
  return { runtime, events, sessions, hold }
}

/** The managed runtimes of a core that offers only this one. */
const only = (runtime: ManagedTextRuntime): ReadonlyMap<string, ManagedTextRuntime> =>
  new Map([[runtime.engine.provider, runtime]])

/** A second managed engine: TensorRT-LLM's spec under another provider id (change `add-vllm-runtime`). */
const SECOND_ENGINE = {
  ...TENSORRT_LLM_ENGINE,
  engine_id: 'test-engine',
  provider: 'test-engine',
  label: 'Test engine',
  descriptor: { engine_id: 'test-engine', label: 'Test engine', url: 'https://conf/test-engine.json' },
} as unknown as ManagedEngineSpec

/** Whether another core instance could claim model `m` now: only once this one released it. */
const otherCoreCanClaim = async (modelId: string): Promise<boolean> =>
  acquireModelClaim(data.layout, 'tensorrt-llm', modelId, 'core-2').then(
    async (claim) => {
      await claim.release()
      return true
    },
    () => false
  )

describe('managedSessionUnloader', () => {
  it('unloads through the facade — stop confirmed, cross-process claim released — and holds loads off until released (final review M-1)', async () => {
    const { runtime, events, sessions } = provider(() => true)
    await sessions.acquire('tensorrt-llm', 'm', {})
    expect(await otherCoreCanClaim('m')).toBe(false)
    const unload = managedSessionUnloader(
      () => only(runtime),
      () => sessions
    )
    const removal = await unload('tensorrt-llm')
    expect(removal.unloaded).toBe(1)
    expect(events).toEqual(['stopped:m'])
    expect(runtime.getLoadedModels()).toEqual([])
    expect(await otherCoreCanClaim('m')).toBe(true)
    await expect(sessions.acquire('tensorrt-llm', 'm', {})).rejects.toMatchObject({
      code: 'MANAGED_OPERATION_CONFLICT',
    })
    removal.release?.()
    await expect(sessions.acquire('tensorrt-llm', 'm', {})).resolves.toMatchObject({ created: true })
  })

  it('cancels a load still in flight rather than queue behind it (final review M-1)', async () => {
    const { runtime, sessions, hold } = provider(() => true)
    hold.gate = new Promise(() => {})
    const pending = sessions.acquire('tensorrt-llm', 'slow', {}).catch((e: unknown) => e)
    await vi.waitFor(() => expect(runtime.isLoading('slow')).toBe(true))
    const removal = await managedSessionUnloader(
      () => only(runtime),
      () => sessions
    )('tensorrt-llm')
    expect(await pending).toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(runtime.residentModels()).toEqual([])
    expect(await otherCoreCanClaim('slow')).toBe(true)
    removal.release?.()
  })

  it('fails the removal with MANAGED_STOP_UNCONFIRMED when Docker will not confirm the stop, and lifts its hold', async () => {
    let confirms = false
    const { runtime, sessions } = provider(() => confirms)
    await sessions.acquire('tensorrt-llm', 'm', {})
    const unload = managedSessionUnloader(
      () => only(runtime),
      () => sessions
    )
    await expect(unload('tensorrt-llm')).rejects.toMatchObject({ code: 'MANAGED_STOP_UNCONFIRMED' })
    expect(runtime.getLoadedModels()).toEqual(['m'])
    // Never released over a container that may still run.
    expect(await otherCoreCanClaim('m')).toBe(false)
    // The failed removal holds nothing off.
    await expect(sessions.acquire('tensorrt-llm', 'm', {})).resolves.toMatchObject({ created: false })
    confirms = true
    const removal = await unload('tensorrt-llm')
    expect(removal.unloaded).toBe(1)
    removal.release?.()
  })

  it('fails the removal, and lifts its hold, when the facade answers an unload that did not succeed', async () => {
    const { runtime, sessions } = provider(() => true)
    await sessions.acquire('tensorrt-llm', 'm', {})
    const refusing = {
      cancelLoad: () => false,
      unload: async () => ({ success: false, error: 'the container would not stop' }),
    }
    await expect(
      managedSessionUnloader(
        () => only(runtime),
        () => refusing
      )('tensorrt-llm')
    ).rejects.toMatchObject({ code: 'MANAGED_STOP_UNCONFIRMED', message: 'the container would not stop' })
    await expect(sessions.acquire('tensorrt-llm', 'm', {})).resolves.toMatchObject({ created: false })
  })

  it.each<[string, string, () => ReadonlyMap<string, ManagedTextRuntime>]>([
    ['another engine', 'vllm', () => only(provider(() => true).runtime)],
    ['a core that offers no managed provider', 'tensorrt-llm', () => new Map()],
  ])('reports nothing unloaded for %s', async (_label, engineId, runtimes) => {
    const facade = () => {
      throw new Error('never asked')
    }
    expect(await managedSessionUnloader(runtimes, facade)(engineId)).toEqual({ unloaded: 0 })
  })

  it('unloads the engine being removed and only it, whichever managed engine that is (change add-vllm-runtime, task 2.4)', async () => {
    const trt = provider(() => true)
    const second = provider(() => true, SECOND_ENGINE)
    await trt.sessions.acquire('tensorrt-llm', 'a', {})
    await second.sessions.acquire('test-engine' as LocalProviderId, 'b', {})
    const runtimes = new Map<string, ManagedTextRuntime>([
      ['tensorrt-llm', trt.runtime],
      ['test-engine', second.runtime],
    ])
    const facade = {
      cancelLoad: (provider: string, modelId: string) =>
        (provider === 'test-engine' ? second : trt).sessions.cancelLoad(provider as LocalProviderId, modelId),
      unload: (provider: string, modelId: string) =>
        (provider === 'test-engine' ? second : trt).sessions.unload(provider as LocalProviderId, modelId),
    }

    const removal = await managedSessionUnloader(
      () => runtimes,
      () => facade as never
    )('test-engine')
    expect(removal.unloaded).toBe(1)
    expect(second.events).toEqual(['stopped:b'])
    expect(trt.runtime.getLoadedModels()).toEqual(['a'])
    removal.release?.()
  })
})

describe('managedModelDeleter', () => {
  const MODEL = 'acme/m'
  const modelFolder = () => join(data.layout.provider('tensorrt-llm').modelsDir, 'acme', 'm')

  /** A downloaded model as the registry lists it: `model.yml` plus 1000 bytes of weights. */
  async function installModel(id: string): Promise<string> {
    const dir = join(data.layout.provider('tensorrt-llm').modelsDir, ...id.split('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(1000, 1))
    await writeFile(
      join(dir, 'model.yml'),
      `name: ${id}\nrepository: ${id}\nrevision: deadbeef\narchitectures:\n  - LlamaForCausalLM\n` +
        `quantization: bf16\nfiles:\n  - path: model.safetensors\n    size: 1000\n    sha256: null\n`
    )
    return dir
  }

  /** An engine cache of `id` under `descriptorId` holding `bytes` bytes. */
  async function writeCache(descriptorId: string, id: string, bytes: number): Promise<string> {
    const dir = data.layout.managed.engineCacheDir(descriptorId, id)
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'nested', 'engine.bin'), Buffer.alloc(bytes, 2))
    return dir
  }

  function deleter(
    runtime: () => ManagedTextRuntime | undefined,
    sessions: () => Pick<LocalSessions, 'cancelLoad' | 'unload'>
  ) {
    return managedModelDeleter({
      runtimes: () => {
        const found = runtime()
        return found === undefined ? new Map() : only(found)
      },
      sessions: sessions as never,
      registry: new TensorrtLlmModelRegistry(data.layout.provider('tensorrt-llm').modelsDir),
      paths: data.layout.managed,
    })
  }

  it('stops a loaded model with a confirmed stop, then removes every engine cache of it and its folder', async () => {
    const { runtime, events, sessions } = provider(() => true)
    await installModel(MODEL)
    await installModel('acme/other')
    const first = await writeCache('tensorrt-llm-1.2.1-r1', MODEL, 300)
    const second = await writeCache('tensorrt-llm-1.2.1-r2', MODEL, 200)
    const other = await writeCache('tensorrt-llm-1.2.1-r1', 'acme/other', 50)
    await sessions.acquire('tensorrt-llm', MODEL, {})

    const deleted = await deleter(
      () => runtime,
      () => sessions
    )(MODEL)

    expect(deleted).toEqual({
      model_id: MODEL,
      was_loaded: true,
      // weights 1000 + model.yml + both caches (300 + 200)
      freed_bytes: expect.any(Number),
      engine_caches_removed: 2,
    })
    expect(deleted.freed_bytes).toBeGreaterThan(1500)
    expect(deleted.freed_bytes).toBeLessThan(1500 + 1000)
    expect(events).toEqual([`stopped:${MODEL}`])
    expect(runtime.residentModels()).toEqual([])
    expect(await otherCoreCanClaim(MODEL)).toBe(true)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(false)
    expect(existsSync(modelFolder())).toBe(false)
    // Another model's cache and folder stay.
    expect(existsSync(other)).toBe(true)
    expect(await new TensorrtLlmModelRegistry(data.layout.provider('tensorrt-llm').modelsDir).list()).toEqual(
      [expect.objectContaining({ id: 'acme/other' })]
    )
    // The hold is lifted: the id can be downloaded and loaded again.
    await installModel(MODEL)
    await expect(sessions.acquire('tensorrt-llm', MODEL, {})).resolves.toMatchObject({ created: true })
  })

  it('stops the model in whichever managed provider holds it, before any file goes (change add-vllm-runtime, task 2.4)', async () => {
    const trt = provider(() => true)
    const second = provider(() => true, SECOND_ENGINE)
    await installModel(MODEL)
    await second.sessions.acquire('test-engine' as LocalProviderId, MODEL, {})
    const facade = {
      cancelLoad: (provider: string, modelId: string) =>
        (provider === 'test-engine' ? second : trt).sessions.cancelLoad(provider as LocalProviderId, modelId),
      unload: (provider: string, modelId: string) =>
        (provider === 'test-engine' ? second : trt).sessions.unload(provider as LocalProviderId, modelId),
    }
    const deleted = await managedModelDeleter({
      runtimes: () =>
        new Map<string, ManagedTextRuntime>([
          ['tensorrt-llm', trt.runtime],
          ['test-engine', second.runtime],
        ]),
      sessions: (() => facade) as never,
      registry: new TensorrtLlmModelRegistry(data.layout.provider('tensorrt-llm').modelsDir),
      paths: data.layout.managed,
    })(MODEL)

    expect(deleted).toMatchObject({ model_id: MODEL, was_loaded: true })
    expect(second.events).toEqual([`stopped:${MODEL}`])
    expect(trt.events).toEqual([])
    expect(existsSync(modelFolder())).toBe(false)
  })

  it('deletes a model that is not loaded, with was_loaded false and no cache to remove', async () => {
    const { runtime, events, sessions } = provider(() => true)
    await installModel(MODEL)
    const deleted = await deleter(
      () => runtime,
      () => sessions
    )(MODEL)
    expect(deleted).toMatchObject({ model_id: MODEL, was_loaded: false, engine_caches_removed: 0 })
    expect(deleted.freed_bytes).toBeGreaterThanOrEqual(1000)
    expect(events).toEqual([])
    expect(existsSync(modelFolder())).toBe(false)
  })

  it('on Windows sizes and removes the model and its caches with the guest’s files, not by walking them', async () => {
    const { runtime, sessions } = provider(() => true)
    await installModel(MODEL)
    const calls: string[] = []
    const deleted = await managedModelDeleter({
      runtimes: () => only(runtime),
      sessions: (() => sessions) as never,
      registry: new TensorrtLlmModelRegistry(data.layout.provider('tensorrt-llm').modelsDir),
      paths: data.layout.managed,
      windowsFiles: async () => ({
        paths: data.layout.managed,
        files: {
          sizes: async (paths) => {
            calls.push(`sizes:${paths.length}`)
            return new Map(paths.map((path) => [path, 700]))
          },
          remove: async (paths) => {
            calls.push(`remove:${paths.length}`)
          },
        },
      }),
    })(MODEL)
    expect(deleted).toMatchObject({ model_id: MODEL, freed_bytes: 700, engine_caches_removed: 0 })
    expect(calls).toEqual(['sizes:1', 'remove:1'])
  })

  it('cancels a load still in flight, then deletes, reporting the model as loaded', async () => {
    const { runtime, sessions, hold } = provider(() => true)
    await installModel(MODEL)
    hold.gate = new Promise(() => {})
    const pending = sessions.acquire('tensorrt-llm', MODEL, {}).catch((e: unknown) => e)
    await vi.waitFor(() => expect(runtime.isLoading(MODEL)).toBe(true))
    const deleted = await deleter(
      () => runtime,
      () => sessions
    )(MODEL)
    expect(await pending).toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(deleted.was_loaded).toBe(true)
    expect(existsSync(modelFolder())).toBe(false)
  })

  it('removes nothing and answers MANAGED_STOP_UNCONFIRMED when Docker will not confirm the stop', async () => {
    let confirms = false
    const { runtime, sessions } = provider(() => confirms)
    await installModel(MODEL)
    const cache = await writeCache('tensorrt-llm-1.2.1-r1', MODEL, 300)
    await sessions.acquire('tensorrt-llm', MODEL, {})
    const remove = deleter(
      () => runtime,
      () => sessions
    )
    await expect(remove(MODEL)).rejects.toMatchObject({ code: 'MANAGED_STOP_UNCONFIRMED' })
    expect(existsSync(cache)).toBe(true)
    expect(await readdir(modelFolder())).toEqual(expect.arrayContaining(['model.yml', 'model.safetensors']))
    expect(runtime.getLoadedModels()).toEqual([MODEL])
    // The failed deletion holds nothing off; a retry once the stop is confirmed goes through.
    await expect(sessions.acquire('tensorrt-llm', MODEL, {})).resolves.toMatchObject({ created: false })
    confirms = true
    await expect(remove(MODEL)).resolves.toMatchObject({ was_loaded: true, engine_caches_removed: 1 })
  })

  it('removes nothing when the facade answers an unload that did not succeed', async () => {
    const { runtime } = provider(() => true)
    await installModel(MODEL)
    const refusing = {
      cancelLoad: () => false,
      unload: async () => ({ success: false, error: 'the container would not stop' }),
    }
    await expect(
      deleter(
        () => runtime,
        () => refusing
      )(MODEL)
    ).rejects.toMatchObject({ code: 'MANAGED_STOP_UNCONFIRMED', message: 'the container would not stop' })
    expect(existsSync(modelFolder())).toBe(true)
  })

  it('refuses loads of the model being deleted, and only of it, while the deletion runs', async () => {
    const { runtime, sessions } = provider(() => true)
    await installModel(MODEL)
    let finishUnload!: () => void
    const slowFacade = {
      cancelLoad: () => false,
      unload: () =>
        new Promise<{ success: boolean }>((resolve) => {
          finishUnload = () => resolve({ success: true })
        }),
    }
    const deletion = deleter(
      () => runtime,
      () => slowFacade
    )(MODEL)
    await vi.waitFor(() => expect(finishUnload).toBeTypeOf('function'))
    await expect(sessions.acquire('tensorrt-llm', MODEL, {})).rejects.toMatchObject({
      code: 'MANAGED_OPERATION_CONFLICT',
      message: 'The model is being deleted.',
    })
    await expect(sessions.acquire('tensorrt-llm', 'acme/other', {})).resolves.toMatchObject({ created: true })
    finishUnload()
    await deletion
  })

  it.each([
    ['a percent-encoded slash', 'acme%2Fm'],
    ['a name without its owner', 'm'],
    ['a folder that is not a model (no model.yml)', 'acme'],
    ['an id that climbs out of the models folder', 'acme/../../x'],
  ])('answers MODEL_NOT_FOUND for %s and deletes nothing', async (_label, id) => {
    const { runtime, sessions } = provider(() => true)
    await installModel(MODEL)
    await expect(
      deleter(
        () => runtime,
        () => sessions
      )(id)
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
    expect(existsSync(join(modelFolder(), 'model.yml'))).toBe(true)
  })

  it('answers PROVIDER_NOT_FOUND where the core offers no managed provider', async () => {
    await installModel(MODEL)
    const facade = () => {
      throw new Error('never asked')
    }
    await expect(deleter(() => undefined, facade)(MODEL)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    })
    expect(existsSync(modelFolder())).toBe(true)
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
      dockerConfigDir: data.layout.managed.dockerConfigDir,
      exec: () => docker.exec,
    })

    const [held] = leftovers()
    expect(held).toMatchObject({
      provider: 'tensorrt-llm',
      model_id: 'oldctr',
      cards: 'all',
      auxiliary: false,
      state: 'stop-unconfirmed',
      remedy:
        'Start Docker, or remove container oldctr yourself (docker rm -f oldctr); the next load retries the stop.',
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

  it('retries within the startup reconcile’s time budget: out of time, the container stays held', async () => {
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
    const wired: ManagedContainers = {
      exec: docker.exec,
      journal,
      dockerPath: '/usr/bin/docker',
      socketPath: '/var/run/docker.sock',
      reconciled: { stopped: [], absent: [], unconfirmed: [], failed: [], skipped: journal.list() },
    }
    const leftovers = leftoverContainers({
      containers: { current: () => wired },
      instanceId: 'core-1',
      log: () => {},
      dockerConfigDir: data.layout.managed.dockerConfigDir,
      exec: () => docker.exec,
      budgetMs: 0,
    })
    await expect(leftovers()[0]?.evict()).rejects.toThrow('Docker did not confirm container oldctr stopped')
    expect(docker.calls).toEqual([])
    expect(leftovers().map((o) => o.model_id)).toEqual(['oldctr'])
  })

  it('retries through its own short-deadline docker executor by default: no docker there, the container stays held', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add({
      container_id: 'oldctr',
      engine_id: 'tensorrt-llm',
      image_digest: 'sha256:0',
      scope: 'app',
      instance_id: 'core-0',
      created_at: '2026-09-29T00:00:00.000Z',
    })
    const unusable: DockerExec = async () => {
      throw new Error('must not use the long-deadline executor')
    }
    const wired: ManagedContainers = {
      exec: unusable,
      journal,
      dockerPath: join(data.root, 'no-such-docker'),
      socketPath: '/var/run/docker.sock',
      reconciled: { stopped: [], absent: [], unconfirmed: [], failed: journal.list(), skipped: [] },
    }
    const leftovers = leftoverContainers({
      containers: { current: () => wired },
      instanceId: 'core-1',
      log: () => {},
      dockerConfigDir: data.layout.managed.dockerConfigDir,
    })
    await expect(leftovers()[0]?.evict()).rejects.toThrow('Docker did not confirm container oldctr stopped')
    expect(leftovers().map((o) => o.model_id)).toEqual(['oldctr'])
    expect(journal.list().map((r) => r.container_id)).toEqual(['oldctr'])
  })

  it('holds nothing while no Docker executor is wired', () => {
    const leftovers = leftoverContainers({
      containers: { current: () => null },
      instanceId: 'core-1',
      log: () => {},
      dockerConfigDir: data.layout.managed.dockerConfigDir,
    })
    expect(leftovers()).toEqual([])
  })
})

describe('wireManagedModelCheck (tensorrt-llm)', () => {
  const SMI = 'GPU-aaaa, NVIDIA RTX 4090, 8.9, 24564, 24000, 581.42\n'
  const MEMINFO = 'MemAvailable: 65536000 kB\n'

  function checkOptions(over: Partial<WireManagedModelCheckOptions> = {}): WireManagedModelCheckOptions {
    return {
      descriptors: {
        forInstallation: async () => ({ kind: 'available', descriptor }),
        cachedForNewSetup: async () => ({ kind: 'available', descriptor }),
      },
      installations: { list: async () => [] },
      host: {
        probeDeps: {
          exec: async (command, args) => {
            hostCalls.push([command, ...args])
            return { code: 0, stdout: SMI, stderr: '' }
          },
          readFile: async () => MEMINFO,
          pathExists: async () => false,
          freeDiskBytes: async () => 0,
        },
      },
      settings: () => ({}),
      ...over,
    }
  }

  const checkBody = (overrides: Record<string, unknown> = {}) => ({
    repository: 'acme/model',
    revision: 'deadbeef',
    config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
    hf_quant_config_json: null,
    files: [{ path: 'model.safetensors', size: 20, sha256: null }],
    ...overrides,
  })

  it.each<NodeJS.Platform>(['darwin', 'win32', 'freebsd'])('offers no check on %s', (platform) => {
    expect(wireManagedModelCheck(platform, TENSORRT_LLM_ENGINE, checkOptions())).toBeNull()
  })

  it('checks against the latest cached descriptor when nothing is installed, using only nvidia-smi and /proc/meminfo', async () => {
    const check = wireManagedModelCheck('linux', TENSORRT_LLM_ENGINE, checkOptions())
    const result = await check?.(checkBody())
    expect(result?.verdict).toEqual({ ok: true })
    expect(result?.checked_gpu_id).toBe('GPU-aaaa')
    // Never Docker: only the nvidia-smi exec call went through the injected host.
    expect(hostCalls).toEqual([['nvidia-smi', ...NVIDIA_SMI_GPU_QUERY]])
  })

  it('checks against the pinned descriptor of a ready installation', async () => {
    const installations = new InstallationStore(join(data.root, 'managed'))
    await installations.write({
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
    const check = wireManagedModelCheck('linux', TENSORRT_LLM_ENGINE, checkOptions({ installations }))
    const result = await check?.(checkBody())
    expect(result?.verdict).toEqual({ ok: true })
  })

  it('reads kv_cache_free_gpu_memory_fraction from stored settings', async () => {
    const bigWeights = checkBody({
      hf_quant_config_json: { quantization: { quant_algo: 'FP8' } },
      config_json: { architectures: ['LlamaForCausalLM'] },
      // 19 GB + the 20% reserve + the engine's 1.5 GiB runtime overhead fits 24000 MiB free.
      files: [{ path: 'model.safetensors', size: 19_000_000_000, sha256: null }],
    })
    const atDefault = wireManagedModelCheck('linux', TENSORRT_LLM_ENGINE, checkOptions())
    expect((await atDefault?.(bigWeights))?.verdict).toEqual({ ok: true })

    const atLowerFraction = wireManagedModelCheck(
      'linux',
      TENSORRT_LLM_ENGINE,
      checkOptions({ settings: () => ({ kv_cache_free_gpu_memory_fraction: 0.1 }) })
    )
    expect((await atLowerFraction?.(bigWeights))?.verdict.ok).toBe(false)
  })

  it('refuses a malformed body with INVALID_ARGUMENT before ever asking the host anything', async () => {
    const check = wireManagedModelCheck('linux', TENSORRT_LLM_ENGINE, checkOptions())
    await expect(check?.({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(hostCalls).toEqual([])
  })

  it("answers the descriptor provider's own error when nothing is installed and nothing was ever cached", async () => {
    const check = wireManagedModelCheck(
      'linux',
      TENSORRT_LLM_ENGINE,
      checkOptions({
        descriptors: {
          forInstallation: async () => ({ kind: 'available', descriptor }),
          cachedForNewSetup: async () => ({
            kind: 'unsupported',
            error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'nothing cached'),
          }),
        },
      })
    )
    await expect(check?.(checkBody())).rejects.toMatchObject({ code: 'MANAGED_METADATA_INVALID' })
  })
})

describe('tensorrt-llm on Windows x64 (change add-tensorrt-llm-windows, task 2.8)', () => {
  const RECORD = {
    schema_version: 1 as const,
    executor: 'wsl-docker' as const,
    distribution: { name: 'AtomicChat', path: 'C:\\Users\\ada\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat' },
    manifest_id: 'windows-r1',
    imported_at: '2026-10-01T00:00:00.000Z',
    marker: 'marker-0001',
  }
  const GUEST = '/var/lib/atomic-chat/scopes/k1'

  /** A Windows machine with Atomic Chat's distribution (or none yet), in memory. */
  const windowsContext = (
    imported: boolean,
    meminfo = 'MemTotal: 16000000 kB\nMemAvailable: 15000000 kB\n'
  ) => {
    const machine = fakeWindows({
      wsl: {
        installed: true,
        ready: true,
        distributions: imported
          ? [{ name: 'AtomicChat', state: 'Running', version: 2, is_default: false }]
          : [],
        guests: imported
          ? {
              AtomicChat: {
                files: { '/proc/meminfo': meminfo, [`${GUEST}/models/tensorrt-llm/acme/m/model.yml`]: 'x' },
                dirs: [],
                free_disk_bytes: 900_000_000_000,
                nvml_version: '590.48.01',
                host: {
                  driver: '591.44',
                  gpus: [
                    {
                      uuid: 'GPU-aaaa',
                      name: 'NVIDIA RTX 4090',
                      cc: '8.9',
                      total_mib: 24564,
                      free_mib: 24000,
                    },
                  ],
                  docker: { installed: true, reachable: true, service_active: true, gpu_runtime: true },
                },
              },
            }
          : {},
      },
      machine: 'x86_64',
      release: '10.0.22631',
      elevated: false,
      virtualization: { firmware: true, hypervisor: true },
      nvidia: {
        driver: '591.44',
        gpus: [{ uuid: 'GPU-aaaa', name: 'NVIDIA RTX 4090', cc: '8.9', total_mib: 24564, free_mib: 24000 }],
      },
      wslconfig: '[wsl2]\nmemory=16GB\n',
      volume_free_bytes: 400_000_000_000,
      vhdx_bytes: null,
    })
    const context: WindowsManagedContext = {
      records: { read: async () => (imported ? RECORD : null) },
      wsl: machine.wsl,
      keeper: (name) => createDistributionKeeper(machine.wsl.distribution(name)),
      scopeKey: async () => 'k1',
      host: machine.host,
    }
    return { machine, context }
  }

  it('offers the provider on Windows x64 and on Windows on Arm with its WSL context, none without it or on another CPU', async () => {
    const { context } = windowsContext(true)
    for (const arch of ['x64', 'arm64']) {
      // Windows on Arm (NVIDIA RTX Spark N1X, 2026-10-06): its own manifest and the linux/arm64 images.
      const runtime = wireManagedEngine(
        TENSORRT_LLM_ENGINE,
        options({ platform: 'win32', arch, windows: context })
      )
      expect(runtime).toBeInstanceOf(ManagedTextRuntime)
      await runtime?.shutdown()
    }
    expect(
      wireManagedEngine(TENSORRT_LLM_ENGINE, options({ platform: 'win32', arch: 'ia32', windows: context }))
    ).toBeNull()
    expect(wireManagedEngine(TENSORRT_LLM_ENGINE, options({ platform: 'win32' }))).toBeNull()
  })

  it('refuses a load before the distribution exists, without a docker call', async () => {
    const { context, machine } = windowsContext(false)
    const runtime = wireManagedEngine(
      TENSORRT_LLM_ENGINE,
      options({ platform: 'win32', windows: context })
    ) as ManagedTextRuntime
    await expect(runtime.load('acme/m')).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
    expect(machine.wslCalls.some((argv) => argv.includes('/usr/bin/docker'))).toBe(false)
  })

  it('answers the models root in the guest and the smaller free space, and MANAGED_ADAPTER_UNAVAILABLE before the import', async () => {
    expect(await tensorrtLlmModelLocation('win32', data.layout, windowsContext(true).context)()).toEqual({
      root: `\\\\wsl.localhost\\AtomicChat${GUEST.replaceAll('/', '\\')}\\models\\tensorrt-llm`,
      free_bytes: 400_000_000_000,
    })
    await expect(
      tensorrtLlmModelLocation('win32', data.layout, windowsContext(false).context)()
    ).rejects.toMatchObject({
      code: 'MANAGED_ADAPTER_UNAVAILABLE',
    })
  })

  it('on Linux the location is <data>/tensorrt-llm/models, as before', async () => {
    const location = await tensorrtLlmModelLocation('linux', data.layout)()
    expect(location.root).toBe(data.layout.provider('tensorrt-llm').modelsDir)
  })

  it('checks a model against the VM’s memory, warning when the weights do not fit (spec "Памяти VM меньше, чем весов")', async () => {
    const { context } = windowsContext(true)
    const check = wireManagedModelCheck('win32', TENSORRT_LLM_ENGINE, {
      descriptors: {
        forInstallation: async () => ({ kind: 'available', descriptor }),
        cachedForNewSetup: async () => ({ kind: 'available', descriptor }),
      },
      installations: { list: async () => [] },
      host: cardless as WireManagedModelCheckOptions['host'],
      settings: () => ({}),
      windows: context,
    })
    const result = await check?.({
      repository: 'acme/model',
      revision: 'deadbeef',
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
      hf_quant_config_json: null,
      // Fits the card with the engine overhead, and is still more than the VM's 16 GiB.
      files: [{ path: 'model.safetensors', size: 19_000_000_000, sha256: null }],
    })
    expect(result?.checked_gpu_id).toBe('GPU-aaaa')
    expect(result?.warnings?.[0]).toMatchObject({
      code: 'wsl-vm-memory',
      params: { vm_memory_bytes: String(16_000_000 * 1024), wslconfig_memory: '16GB' },
    })
  })

  it('checks models on Windows on Arm too, and on no CPU the descriptor has no image for', async () => {
    const { context } = windowsContext(true)
    const on = (arch: string) =>
      wireManagedModelCheck('win32', TENSORRT_LLM_ENGINE, {
        descriptors: {
          forInstallation: async () => ({ kind: 'available', descriptor }),
          cachedForNewSetup: async () => ({ kind: 'available', descriptor }),
        },
        installations: { list: async () => [] },
        host: cardless as WireManagedModelCheckOptions['host'],
        settings: () => ({}),
        arch,
        windows: context,
      })
    expect(on('ia32')).toBeNull()
    const result = await on('arm64')?.({
      repository: 'acme/model',
      revision: 'deadbeef',
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
      hf_quant_config_json: null,
      files: [{ path: 'model.safetensors', size: 2_000_000_000, sha256: null }],
    })
    expect(result?.checked_gpu_id).toBe('GPU-aaaa')
    expect(result?.verdict.ok).toBe(true)
  })

  it('checks a model before the import against the cards Windows sees, with no VM to warn about', async () => {
    const { context, machine: windows } = windowsContext(false)
    const check = wireManagedModelCheck('win32', TENSORRT_LLM_ENGINE, {
      descriptors: {
        forInstallation: async () => ({ kind: 'available', descriptor }),
        cachedForNewSetup: async () => ({ kind: 'available', descriptor }),
      },
      installations: { list: async () => [] },
      host: cardless as WireManagedModelCheckOptions['host'],
      settings: () => ({}),
      windows: context,
    })
    const result = await check?.({
      repository: 'acme/model',
      revision: 'deadbeef',
      config_json: { architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' },
      hf_quant_config_json: null,
      files: [{ path: 'model.safetensors', size: 20_000_000_000, sha256: null }],
    })
    expect(result?.checked_gpu_id).toBe('GPU-aaaa')
    expect(result?.warnings).toBeUndefined()
    expect(windows.execCalls.some((call) => call[0]?.endsWith('nvidia-smi.exe'))).toBe(true)
  })

  it('a load on Windows reads the model under the guest root and the cards in the guest, then starts its container there', async () => {
    const { context, machine: windows } = windowsContext(true)
    const mounted = { ...context, mount: directoryGuestMount(join(data.root, 'guest-fs')) }
    const root = mounted.mount.hostPath('AtomicChat', `${GUEST}/models/tensorrt-llm/acme/m`)
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({ architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' })
    )
    await writeFile(join(root, 'model.safetensors'), Buffer.alloc(20, 1))
    await writeFile(
      join(root, 'model.yml'),
      'repository: acme/m\nrevision: deadbeef\narchitectures:\n  - LlamaForCausalLM\nquantization: bf16\nfiles:\n  - path: model.safetensors\n    size: 20\n    sha256: null\n'
    )
    const store = new InstallationStore(join(data.root, 'managed'))
    await readyInstallation(store)
    const docker = new FakeDocker()
    const journal = await ExecutionJournal.open(data.layout)
    const runtime = wireManagedEngine(
      TENSORRT_LLM_ENGINE,
      options({
        platform: 'win32',
        windows: mounted,
        installations: store,
        descriptors: { forInstallation: async () => ({ kind: 'available', descriptor }) },
        containers: handle(async () => ({
          exec: withInfo(docker),
          journal,
          dockerPath: '/usr/bin/docker',
          socketPath: '/var/run/docker.sock',
          reconciled: { removed: [], unconfirmed: [], failed: [], skipped: [] } as never,
        })),
      })
    ) as ManagedTextRuntime
    // The fake docker has no `docker port`: the load stops right after its container started.
    await expect(runtime.load('acme/m')).rejects.toBeDefined()
    expect(docker.calls.some((argv) => argv[0] === 'create')).toBe(true)
    expect(windows.wslCalls.some((argv) => argv.includes('nvidia-smi'))).toBe(true)
    await runtime.shutdown()
  })

  it('the WSL deployment probes inside the guest as root and explains a broken forwarding from .wslconfig', async () => {
    const { context, machine: windows } = windowsContext(true)
    const deployment = windowsDeployment(
      context,
      { record: RECORD, transport: windows.wsl.distribution('AtomicChat') },
      async () => ({ code: 0, stdout: '', stderr: '' })
    )
    await deployment.probeInGuest?.(
      { base_url: 'http://127.0.0.1:41000' },
      { path: '/health', expectedStatus: 200 }
    )
    expect(windows.wslCalls.at(-1)?.slice(0, 5)).toEqual(['-d', 'AtomicChat', '-u', 'root', '--exec'])
    expect((await deployment.forwardingError?.())?.details).toBe('wsl-localhost-forwarding')
  })

  it('names the guest’s files for a deletion once the distribution exists, and refuses before', async () => {
    expect((await windowsModelFiles(windowsContext(true).context, data.layout)).paths.root).toContain(
      'AtomicChat'
    )
    expect((await windowsModelFilesFor(windowsContext(true).context, data.layout)()).paths.root).toContain(
      'AtomicChat'
    )
    await expect(windowsModelFiles(windowsContext(false).context, data.layout)).rejects.toMatchObject({
      code: 'MANAGED_ADAPTER_UNAVAILABLE',
    })
    const exec: DockerExec = async () => ({ code: 0, stdout: '', stderr: '' })
    expect(wiredExec({ exec })).toBe(exec)
  })

  it('lists models from the guest root once the distribution exists, nothing before', async () => {
    const registry = tensorrtLlmModelRegistry('win32', data.layout, windowsContext(false).context)
    expect(await registry.list()).toEqual([])
  })
})
