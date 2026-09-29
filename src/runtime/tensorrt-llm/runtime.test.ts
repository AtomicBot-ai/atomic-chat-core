/**
 * The `tensorrt-llm` LocalRuntime over the real managed-text lifecycle and the real TensorRT-LLM
 * adapter, with an in-process fake `docker` (`test/helpers/fake-docker-exec.ts`), a fake readiness
 * probe and a fake clock. What is under test here is the provider's own part: which card a load gets,
 * what refuses a load before any container exists, one session at a time, cancel, logs and
 * capabilities — the lifecycle's own behaviour is `../managed-text/lifecycle.test.ts`'s.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { CoreEvents, GpuFacts } from '../../contracts/index.js'
import { ExecutionJournal, startHeartbeatTicker } from '../container/index.js'
import { parseRuntimeDescriptor } from '../environment/index.js'
import {
  ManagedTextAdapterRegistry,
  ManagedTextLifecycle,
  createDesktopManagedDeployment,
} from '../managed-text/index.js'
import { FakeDocker } from '../../../test/helpers/fake-docker-exec.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { tensorrtLlmAdapter } from './adapter.js'
import type { TensorrtLlmHostFacts } from './host-facts.js'
import type { ReadyInstallation } from './installation.js'
import { readTensorrtLlmModel } from './model-dir.js'
import { TensorrtLlmRuntime } from './runtime.js'
import type { TensorrtLlmRuntimeDeps } from './runtime.js'
import type { GpuClaim } from '../shared/index.js'

const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))
const MiB = 1024 * 1024
const SMALL: GpuFacts = {
  gpu_id: 'GPU-11111111-aaaa-bbbb-cccc-000000000001',
  name: 'NVIDIA RTX 4090',
  compute_capability: '8.9',
  total_vram_bytes: 24_564 * MiB,
  free_vram_bytes: 24_000 * MiB,
  driver_version: '581.42',
}
const LARGE: GpuFacts = {
  ...SMALL,
  gpu_id: 'GPU-22222222-aaaa-bbbb-cccc-000000000002',
  name: 'NVIDIA RTX PRO 6000',
  compute_capability: '12.0',
  total_vram_bytes: 97_887 * MiB,
}

type Emitted = { name: keyof CoreEvents; payload: unknown }

let data: TmpDataFolder
let docker: FakeDocker
let clock: number
let emitted: Emitted[]
let readyAt: number | null
let onProbe: ((now: number) => void) | undefined
let runtime: TensorrtLlmRuntime
let stored: Record<string, unknown>
let facts: TensorrtLlmHostFacts
let installation: () => Promise<ReadyInstallation>
/** The lifecycle the last `build()` made over the fake Docker. */
let lastLifecycle: Promise<ManagedTextLifecycle>

const ready = (): Promise<ReadyInstallation> =>
  Promise.resolve({
    installation: {
      installation_id: 'trt-1',
      engine_id: 'tensorrt-llm',
      environment_id: 'default',
      active_descriptor_id: descriptor.descriptor_id,
      candidate_descriptor_id: null,
      availability: 'supported',
      status: 'ready',
    },
    descriptor,
    image: descriptor.image['linux/amd64'],
  })

/**
 * A model with a real `config.json` and an actually-present weight file at its declared size: the
 * pre-launch check (task 2.16) re-verifies both before any container is created, so a model that
 * fails either would make every "loads fine" test below fail for a reason unrelated to what it is
 * testing. `bfloat16` picks the fixture's `bf16` format, whose minimum compute capability (`8.0`,
 * no exclusions) both `SMALL` (`8.9`) and `LARGE` (`12.0`) clear.
 */
async function installModel(id: string, architecture: string): Promise<void> {
  const dir = join(data.layout.provider('tensorrt-llm').modelsDir, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ architectures: [architecture], dtype: 'bfloat16' })
  )
  await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(20, 1))
  await writeFile(
    join(dir, 'model.yml'),
    `name: ${id}\nrepository: acme/${id}\nrevision: deadbeef\narchitectures: [${architecture}]\nquantization: bf16\nfiles:\n  - path: model.safetensors\n    size: 20\n    sha256: null\n`
  )
}

function build(
  over: Partial<TensorrtLlmRuntimeDeps> = {},
  withDocker: boolean | Error = true
): TensorrtLlmRuntime {
  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(tensorrtLlmAdapter)
  let port = 43_000
  let generation = 0
  const fakeFetch = (async () => {
    onProbe?.(clock)
    return new Response('', { status: readyAt !== null && clock >= readyAt ? 200 : 503 })
  }) as unknown as typeof fetch
  const journal = ExecutionJournal.open(data.layout)
  const made = (lastLifecycle = journal.then(
    (j) =>
      new ManagedTextLifecycle({
        provider: 'tensorrt-llm',
        adapters,
        exec: docker.exec,
        deployment: createDesktopManagedDeployment({ allocateHostPort: async () => port++ }),
        journal: j,
        paths: data.layout.managed,
        instanceId: 'core-1',
        scope: 'app',
        allowedHosts: [],
        selinuxDataRoot: data.root,
        emit: (name, payload) => emitted.push({ name, payload }),
        fetch: fakeFetch,
        now: () => clock,
        sleep: async (ms, signal) => {
          if (signal?.aborted) throw signal.reason
          clock += ms
          await new Promise((resolve) => setImmediate(resolve))
          if (signal?.aborted) throw signal.reason
        },
        newGeneration: () => `gen-${++generation}`,
        startHeartbeat: (options) => startHeartbeatTicker({ ...options, intervalMs: 60_000 }),
        timings: { pollIntervalMs: 1_000, monitorIntervalMs: 60_000, heartbeatReadyTimeoutMs: 2_000 },
      })
  ))
  runtime = new TensorrtLlmRuntime({
    lifecycle: () =>
      withDocker instanceof Error ? Promise.reject(withDocker) : withDocker ? made : Promise.resolve(null),
    readyInstallation: () => installation(),
    hostFacts: async () => facts,
    model: (id) => readTensorrtLlmModel(data.layout.provider('tensorrt-llm').modelsDir, id),
    settings: () => stored,
    ...over,
  })
  return runtime
}

async function rejection(promise: Promise<unknown>): Promise<AtomicCoreError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AtomicCoreError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

const progress = () =>
  emitted
    .filter((e) => e.name === 'session:load-progress')
    .map((e) => e.payload as CoreEvents['session:load-progress'])

const gpusArg = (argv: string[]) => argv[argv.indexOf('--gpus') + 1]

beforeEach(async () => {
  data = await makeTmpDataFolder('trt-runtime-')
  docker = new FakeDocker()
  clock = 0
  emitted = []
  readyAt = 0
  onProbe = undefined
  stored = {
    gpu_id: '',
    context_length: 8192,
    max_output_tokens: 4096,
    kv_cache_free_gpu_memory_fraction: 0.9,
    load_timeout_seconds: 0,
  }
  facts = { gpus: [SMALL, LARGE], selinux: false, memAvailableBytes: 0 }
  installation = ready
  await installModel('qwen3', 'Qwen3ForCausalLM')
  await installModel('llama', 'LlamaForCausalLM')
})

afterEach(async () => {
  await runtime?.shutdown()
  await data.cleanup()
})

describe('TensorrtLlmRuntime: which card', () => {
  it('runs on the saved card when the probe still finds it', async () => {
    build()
    stored.gpu_id = SMALL.gpu_id
    await runtime.load('qwen3')
    expect(gpusArg(docker.last().createArgv)).toBe(`device=${SMALL.gpu_id}`)
    expect(progress().every((p) => p.gpu_substituted === undefined)).toBe(true)
  })

  it('runs on the card with the most memory when none is saved', async () => {
    build()
    await runtime.load('qwen3')
    expect(gpusArg(docker.last().createArgv)).toBe(`device=${LARGE.gpu_id}`)
    expect(progress().every((p) => p.gpu_substituted === undefined)).toBe(true)
  })

  it('falls back to the card with the most memory when the saved one is gone, and says so in the load events', async () => {
    build()
    stored.gpu_id = 'GPU-99999999-aaaa-bbbb-cccc-000000000009'
    await runtime.load('qwen3')
    expect(gpusArg(docker.last().createArgv)).toBe(`device=${LARGE.gpu_id}`)
    expect(progress().length).toBeGreaterThan(0)
    for (const event of progress()) {
      expect(event.gpu_substituted).toEqual({
        requested_gpu_id: 'GPU-99999999-aaaa-bbbb-cccc-000000000009',
        gpu_id: LARGE.gpu_id,
      })
    }
  })

  it('refuses with MANAGED_PREREQUISITE_BLOCKED on a host with no NVIDIA card, before any container', async () => {
    build()
    facts = { gpus: [], selinux: false, memAvailableBytes: 0 }
    expect((await rejection(runtime.load('qwen3'))).code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(docker.calls).toEqual([])
  })

  it('mounts under SELinux with the shared label when the probe says Docker enforces it', async () => {
    build()
    facts = { gpus: [LARGE], selinux: true, memAvailableBytes: 0 }
    await runtime.load('qwen3')
    expect(docker.last().createArgv.join(' ')).toMatch(/,z\b|:z\b/)
  })
})

describe('TensorrtLlmRuntime: refused before a container exists', () => {
  it('answers MANAGED_ADAPTER_UNAVAILABLE when the engine installation is not ready', async () => {
    build()
    installation = () =>
      Promise.reject(
        new AtomicCoreError('MANAGED_ADAPTER_UNAVAILABLE', 'The TensorRT-LLM engine is not ready.')
      )
    expect((await rejection(runtime.load('qwen3'))).code).toBe('MANAGED_ADAPTER_UNAVAILABLE')
    expect(docker.calls).toEqual([])
  })

  it('answers MANAGED_ADAPTER_UNAVAILABLE on a host with no docker CLI', async () => {
    build({}, false)
    expect((await rejection(runtime.load('qwen3'))).code).toBe('MANAGED_ADAPTER_UNAVAILABLE')
  })

  it('finds Docker at the next load once a setup has installed it, with no restart', async () => {
    let dockerInstalled = false
    build({ lifecycle: () => (dockerInstalled ? lastLifecycle : Promise.resolve(null)) })
    expect((await rejection(runtime.load('qwen3'))).code).toBe('MANAGED_ADAPTER_UNAVAILABLE')
    expect(await runtime.unloadAll()).toEqual({ unloaded: 0 })
    dockerInstalled = true
    await runtime.load('qwen3')
    expect(runtime.getLoadedModels()).toEqual(['qwen3'])
  })

  it('says the managed container runtime failed to initialise, with the cause, when core startup could not wire it', async () => {
    build({}, new Error('docker reconcile timed out'))
    const error = await rejection(runtime.load('qwen3'))
    expect(error.code).toBe('MANAGED_ADAPTER_UNAVAILABLE')
    expect(error.message).toMatch(/failed to initialise/)
    expect(error.message).not.toMatch(/not installed/)
    expect(error.details).toContain('docker reconcile timed out')
    expect(runtime.list()).toEqual([])
  })

  it.each<[string, Record<string, unknown>]>([
    ['an output limit as large as the context', { max_output_tokens: 8192 }],
    ['a context that is not a number', { context_length: 'long' }],
  ])('answers INVALID_ARGUMENT for %s', async (_label, patch) => {
    build()
    Object.assign(stored, patch)
    expect((await rejection(runtime.load('qwen3'))).code).toBe('INVALID_ARGUMENT')
    expect(docker.calls).toEqual([])
  })

  it('answers MODEL_NOT_FOUND for a model that is not installed', async () => {
    build()
    expect((await rejection(runtime.load('nope'))).code).toBe('MODEL_NOT_FOUND')
  })

  it('refuses to serve a model as an embedding model', async () => {
    build()
    expect((await rejection(runtime.load('qwen3', { isEmbedding: true }))).code).toBe('INVALID_ARGUMENT')
    expect(docker.calls).toEqual([])
  })
})

describe('TensorrtLlmRuntime: pre-launch check (task 2.16, spec "Проверка файлов при загрузке")', () => {
  const modelDir = () => join(data.layout.provider('tensorrt-llm').modelsDir, 'qwen3')

  it('refuses with MODEL_FILE_NOT_FOUND, naming the file, when a shard was deleted after download; no container is created', async () => {
    build()
    await rm(join(modelDir(), 'model.safetensors'))
    const error = await rejection(runtime.load('qwen3'))
    expect(error.code).toBe('MODEL_FILE_NOT_FOUND')
    expect(error.message).toContain('model.safetensors')
    expect(docker.calls).toEqual([])
  })

  it('refuses with MODEL_FILE_CORRUPT when a file on disk no longer matches the size model.yml recorded; no container is created', async () => {
    build()
    await writeFile(join(modelDir(), 'model.safetensors'), Buffer.alloc(5, 1))
    expect((await rejection(runtime.load('qwen3'))).code).toBe('MODEL_FILE_CORRUPT')
    expect(docker.calls).toEqual([])
  })

  it('refuses with MODEL_INCOMPATIBLE when config.json on disk no longer matches what model.yml recorded; no container is created', async () => {
    build()
    await writeFile(
      join(modelDir(), 'config.json'),
      JSON.stringify({ architectures: ['SomeOtherForCausalLM'] })
    )
    const error = await rejection(runtime.load('qwen3'))
    expect(error.code).toBe('MODEL_INCOMPATIBLE')
    expect(docker.calls).toEqual([])
  })
})

describe('TensorrtLlmRuntime: the memory check runs after eviction, not before (task 2.16w round 1, finding 1, Critical)', () => {
  // needed = weights (2,000) + the 10% weight-fraction fallback reserve (200) = 2,200 bytes.
  const WEIGHT_BYTES = 2_000

  async function installBigModel(id: string): Promise<void> {
    const dir = join(data.layout.provider('tensorrt-llm').modelsDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ architectures: ['LlamaForCausalLM'], dtype: 'bfloat16' })
    )
    await writeFile(join(dir, 'model.safetensors'), Buffer.alloc(WEIGHT_BYTES, 1))
    await writeFile(
      join(dir, 'model.yml'),
      `name: ${id}\nrepository: acme/${id}\nrevision: deadbeef\narchitectures: [LlamaForCausalLM]\nquantization: bf16\nfiles:\n  - path: model.safetensors\n    size: ${WEIGHT_BYTES}\n    sha256: null\n`
    )
  }

  it("loads B on the single GPU A still holds: A is stopped first, and B's memory check reads the freed card, not the stale pre-eviction snapshot", async () => {
    await installBigModel('big-a')
    await installBigModel('big-b')
    // While `big-a`'s container exists, the card reports too little free memory for `big-b`
    // (1,000 < 2,200 needed); once stopPrevious has actually stopped it, a fresh probe reports
    // plenty. A stale, pre-eviction snapshot re-used for the memory gate would refuse `big-b`
    // outright on this single-GPU host — exactly the bug this split fixes.
    build({
      hostFacts: async () => ({
        gpus: [{ ...SMALL, free_vram_bytes: docker.containers.size > 0 ? 1_000 : 1_000_000_000 }],
        selinux: false,
        memAvailableBytes: 0,
      }),
    })

    await runtime.load('big-a')
    expect(runtime.getLoadedModels()).toEqual(['big-a'])
    expect(docker.containers.size).toBe(1)

    await runtime.load('big-b')
    expect(runtime.getLoadedModels()).toEqual(['big-b'])
    expect(docker.containers.size).toBe(1)
  })

  it('with core’s GPU residency, the memory check waits for the claim’s eviction to finish: eviction done → beforeCreate → docker create', async () => {
    await installBigModel('big-a')
    await installBigModel('big-b')
    const order: string[] = []
    const creates = () => docker.calls.filter((argv) => argv[0] === 'create').length
    build({
      // The card only has room for `big-b` once `big-a`'s container is gone (as in the test above).
      hostFacts: async () => {
        order.push(`probe: ${docker.containers.size} containers, ${creates()} creates`)
        return {
          gpus: [{ ...SMALL, free_vram_bytes: docker.containers.size > 0 ? 1_000 : 1_000_000_000 }],
          selinux: false,
          memAvailableBytes: 0,
        }
      },
      // A stand-in for core's `GpuResidency.claim` (task 2.15): evict every other occupant of the
      // card and wait for its confirmed exit — made slow here, so a `beforeCreate` that did not wait
      // for the claim would probe while `big-a` still runs — then grant inside the turn.
      claimGpu: async (claim, _signal, granted) => {
        order.push(`claim ${claim.model_id}`)
        for (const other of runtime.gpuOccupancy()) {
          if (other.model_id === claim.model_id) continue
          for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve))
          expect(await runtime.unload(other.model_id)).toEqual({ success: true })
          order.push(`evicted ${other.model_id}`)
        }
        granted?.()
      },
    })

    await runtime.load('big-a')
    order.length = 0
    await runtime.load('big-b')

    expect(runtime.getLoadedModels()).toEqual(['big-b'])
    expect(creates()).toBe(2)
    // load()'s own probe(s) run before the claim, while big-a still holds the card; the one
    // `beforeCreate` probe runs strictly after the eviction and strictly before big-b's create.
    const claimAt = order.indexOf('claim big-b')
    expect(order.slice(0, claimAt).every((step) => step === 'probe: 1 containers, 1 creates')).toBe(true)
    expect(order.slice(claimAt)).toEqual(['claim big-b', 'evicted big-a', 'probe: 0 containers, 1 creates'])
  })

  it('a genuinely-too-big model still fails before create, even once eviction has freed the card', async () => {
    await installModel('small', 'LlamaForCausalLM') // weight 20 bytes: fits easily
    await installBigModel('big-b') // needs 2,200 bytes
    build({
      // A fixed, small card throughout: enough for `small` (needed 22 bytes), never enough for
      // `big-b` (needed 2,200) — whether or not anything else currently holds it.
      hostFacts: async () => ({
        gpus: [{ ...SMALL, free_vram_bytes: 2_000 }],
        selinux: false,
        memAvailableBytes: 0,
      }),
    })

    await runtime.load('small')
    expect(docker.containers.size).toBe(1)
    const callsBeforeBigB = docker.calls.length

    const error = await rejection(runtime.load('big-b'))
    expect(error.code).toBe('MODEL_INCOMPATIBLE')
    // `small` was still evicted by stopPrevious (it runs before the memory check), but no new
    // container was ever created for big-b.
    expect(docker.containers.size).toBe(0)
    expect(docker.calls.slice(callsBeforeBigB).some((argv) => argv[0] === 'create')).toBe(false)
    expect(runtime.getLoadedModels()).toEqual([])
  })

  it('refuses with MANAGED_PREREQUISITE_BLOCKED when the selected card is no longer on the host by the time beforeCreate re-probes it', async () => {
    await installModel('vanishing', 'LlamaForCausalLM')
    let calls = 0
    build({
      hostFacts: async () => {
        calls += 1
        // The card is there for load()'s own selection and the phase-1 check (call 1), but gone by
        // the time the beforeCreate hook re-probes it (call 2, after stopPrevious — nothing to stop
        // here, but the hook still runs).
        return calls === 1
          ? { gpus: [SMALL], selinux: false, memAvailableBytes: 0 }
          : { gpus: [], selinux: false, memAvailableBytes: 0 }
      },
    })

    const error = await rejection(runtime.load('vanishing'))
    expect(error.code).toBe('MANAGED_PREREQUISITE_BLOCKED')
    expect(error.message).toContain('disappeared')
    expect(docker.calls).toEqual([])
  })
})

describe('TensorrtLlmRuntime: sessions', () => {
  it('publishes a container session: null pid, a generation, the gateway port and key', async () => {
    build()
    const session = await runtime.load('qwen3')
    expect(session).toMatchObject({
      pid: null,
      execution: 'container',
      generation: 'gen-1',
      model_id: 'qwen3',
    })
    expect(session.api_key).not.toBe('')
    expect(runtime.list()).toEqual([session])
    expect(runtime.findSession('qwen3')).toBe(session)
    expect(runtime.getLoadedModels()).toEqual(['qwen3'])
  })

  it('keeps one session: loading a second model stops the first with a confirmed stop before starting the second', async () => {
    build()
    await runtime.load('qwen3')
    const first = docker.last().id
    await runtime.load('llama')
    const order = docker.calls.map(
      (argv) => `${argv[0]}${argv[0] === 'stop' ? ` ${argv[argv.length - 1]}` : ''}`
    )
    expect(order.indexOf(`stop ${first}`)).toBeGreaterThan(-1)
    expect(order.indexOf(`stop ${first}`)).toBeLessThan(order.lastIndexOf('create'))
    expect(runtime.getLoadedModels()).toEqual(['llama'])
    expect(emitted.filter((e) => e.name === 'session:unloaded').map((e) => e.payload)).toEqual([
      { provider: 'tensorrt-llm', model_id: 'qwen3', pid: null },
    ])
    expect(progress().filter((p) => p.model_id === 'llama')[0]?.stage).toBe('stopping-previous')
  })

  it('a second model that arrives while the first is still loading cancels that load', async () => {
    build()
    readyAt = null
    const first = runtime.load('qwen3')
    for (let i = 0; i < 200 && !runtime.isLoading('qwen3'); i++) await new Promise((r) => setImmediate(r))
    readyAt = Number.MAX_SAFE_INTEGER
    const second = runtime.load('llama')
    readyAt = 0
    expect((await rejection(first)).code).toBe('MODEL_LOAD_CANCELLED')
    await second
    expect(runtime.getLoadedModels()).toEqual(['llama'])
  })

  it('cancel stops the container and answers MODEL_LOAD_CANCELLED with no session', async () => {
    build()
    readyAt = null
    const controller = new AbortController()
    onProbe = (now) => {
      if (now >= 2_000) controller.abort()
    }
    expect((await rejection(runtime.load('qwen3', { signal: controller.signal }))).code).toBe(
      'MODEL_LOAD_CANCELLED'
    )
    expect(docker.containers.size).toBe(0)
    expect(runtime.list()).toEqual([])
  })

  it('an already-cancelled load never reaches docker', async () => {
    build()
    const controller = new AbortController()
    controller.abort()
    expect((await rejection(runtime.load('qwen3', { signal: controller.signal }))).code).toBe(
      'MODEL_LOAD_CANCELLED'
    )
    expect(docker.calls).toEqual([])
  })

  it('unloads with a confirmed stop, and reports MANAGED_STOP_UNCONFIRMED when docker will not confirm', async () => {
    build()
    await runtime.load('qwen3')
    expect(await runtime.unload('qwen3')).toEqual({ success: true })
    expect(runtime.list()).toEqual([])
    await runtime.load('llama')
    docker.stopConfirms = false
    expect((await rejection(runtime.unload('llama'))).code).toBe('MANAGED_STOP_UNCONFIRMED')
    docker.stopConfirms = true
    expect(await runtime.unloadAll()).toEqual({ unloaded: 1 })
  })

  it('asks core for its card, as the provider’s only session, before any container exists — and holds it from then on', async () => {
    const claims: Array<{ claim: GpuClaim; signal: AbortSignal | undefined; containers: number }> = []
    build({
      claimGpu: async (claim, signal, granted) => {
        // Not an occupant while its claim is pending: nothing of this load has started.
        expect(runtime.gpuOccupancy()).toEqual([])
        claims.push({ claim, signal, containers: docker.containers.size })
        // Granted inside core's turn: from that moment it holds its card, still before any container.
        granted?.()
        expect(runtime.gpuOccupancy()).toEqual([
          { model_id: 'qwen3', cards: [LARGE.gpu_id], auxiliary: false, state: 'loading' },
        ])
      },
    })
    await runtime.load('qwen3')
    expect(claims).toEqual([
      {
        claim: { model_id: 'qwen3', cards: [LARGE.gpu_id], auxiliary: false, soleSessionOfProvider: true },
        signal: expect.any(AbortSignal),
        containers: 0,
      },
    ])
    expect(runtime.gpuOccupancy()).toEqual([
      { model_id: 'qwen3', cards: [LARGE.gpu_id], auxiliary: false, state: 'ready' },
    ])
    expect(progress()[0]?.stage).toBe('stopping-previous')
  })

  it('with core’s residency, leaves stopping its other session to core rather than stopping it itself', async () => {
    let stopOthers = false
    build({
      claimGpu: async (claim) => {
        if (claim.model_id === 'llama') stopOthers = true
      },
    })
    await runtime.load('qwen3')
    await runtime.load('llama')
    expect(stopOthers).toBe(true)
    // Core decided nothing had to go (a test double), so the runtime did not stop qwen3 behind its back.
    expect(runtime.getLoadedModels().sort()).toEqual(['llama', 'qwen3'])
  })

  it('refuses the load with what core answered, starting no container', async () => {
    build({
      claimGpu: async () => {
        throw new AtomicCoreError('GPU_BUSY', 'busy', 'holder=llamacpp-upstream/chat')
      },
    })
    const error = await rejection(runtime.load('qwen3'))
    expect(error.code).toBe('GPU_BUSY')
    expect(docker.calls.filter((argv) => argv[0] === 'create')).toEqual([])
    expect(runtime.gpuOccupancy()).toEqual([])
  })

  it('keeps reporting a session whose stop docker would not confirm: its card is still held', async () => {
    build()
    await runtime.load('llama')
    docker.stopConfirms = false
    await rejection(runtime.unload('llama'))
    const container = docker.last().id
    expect(runtime.gpuOccupancy()).toEqual([
      {
        model_id: 'llama',
        cards: [LARGE.gpu_id],
        auxiliary: false,
        state: 'stop-unconfirmed',
        remedy:
          `Loading again retries the stop; if Docker keeps failing, restart Docker or remove ` +
          `container ${container} (docker rm -f ${container}).`,
      },
    ])
    docker.stopConfirms = true
  })

  it('never grows the context and never recreates a session in place', async () => {
    build()
    await runtime.load('qwen3')
    const calls = docker.calls.length
    expect(await runtime.autoIncreaseCtx('qwen3')).toEqual({ ok: false, reason: 'unsupported' })
    expect((await rejection(runtime.recreateSession('qwen3'))).code).toBe('INVALID_ARGUMENT')
    expect(docker.calls.length).toBe(calls)
  })

  it('refuses new loads once shut down', async () => {
    build()
    await runtime.load('qwen3')
    await runtime.shutdown()
    expect(runtime.list()).toEqual([])
    expect((await rejection(runtime.load('qwen3'))).code).toBe('CORE_NOT_RUNNING')
  })
})

describe('TensorrtLlmRuntime: what a session can do', () => {
  it("gates tools on the descriptor's parser for the model's family", async () => {
    build()
    await runtime.load('qwen3')
    expect(runtime.routePolicy('qwen3')).toMatchObject({
      tools: true,
      structuredOutput: true,
      contextLength: 8192,
      maxOutputTokens: 4096,
    })
    await runtime.load('llama')
    expect(runtime.routePolicy('llama')).toMatchObject({ tools: false })
    expect(runtime.routePolicy('qwen3')).toBeUndefined()
  })

  it('answers capabilities from the pinned descriptor, loaded or not', async () => {
    build()
    expect(await runtime.capabilities('qwen3')).toMatchObject({
      modelId: 'qwen3',
      architecture: 'Qwen3ForCausalLM',
      tools: true,
      reasoning: true,
      structured_output: true,
      vision: false,
      embeddings: false,
      responses: false,
      isEmbedding: false,
    })
    expect(await runtime.capabilities('llama')).toMatchObject({ tools: false, reasoning: false })
  })

  it('answers every capability false when the engine is not installed, rather than failing', async () => {
    build()
    installation = () => Promise.reject(new AtomicCoreError('MANAGED_ADAPTER_UNAVAILABLE', 'not ready'))
    expect(await runtime.capabilities('qwen3')).toMatchObject({
      tools: false,
      reasoning: false,
      architecture: null,
    })
  })
})

describe('TensorrtLlmRuntime: logs', () => {
  it("serves the loaded container's log, then a failed attempt's log until the next load", async () => {
    build()
    expect(await runtime.logs('qwen3')).toEqual({ model_id: 'qwen3', source: null, log_tail: '' })
    docker.bootLog = ['[TRT-LLM] loading']
    await runtime.load('qwen3')
    expect(await runtime.logs('qwen3')).toMatchObject({
      source: 'session',
      generation: 'gen-1',
      log_tail: expect.stringContaining('[TRT-LLM] loading'),
    })
    await runtime.unload('qwen3')

    readyAt = null
    let crashed = false
    onProbe = () => {
      if (crashed) return
      crashed = true
      docker.exit(docker.last().id, 1, ['torch.OutOfMemoryError: CUDA out of memory.'])
    }
    expect((await rejection(runtime.load('qwen3'))).code).toBe('OUT_OF_MEMORY')
    expect(await runtime.logs('qwen3')).toMatchObject({
      source: 'last-attempt',
      generation: 'gen-2',
      log_tail: expect.stringContaining('CUDA out of memory'),
      error: { code: 'OUT_OF_MEMORY' },
    })
  })
})
