/**
 * The shared managed-text load lifecycle against two fake engines with different readiness paths,
 * log markers, timeouts and exit classifiers — nothing in the lifecycle may care which one it runs —
 * and an in-process fake `docker` (`test/helpers/fake-docker-exec.ts`). Time is a fake clock the
 * injected `sleep` advances, so a three-minute start takes milliseconds.
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import type { CoreEvents } from '../../contracts/index.js'
import { ExecutionJournal, startHeartbeatTicker } from '../container/index.js'
import type { HeartbeatTicker, HeartbeatTickerOptions } from '../container/index.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { FakeDocker } from '../../../test/helpers/fake-docker-exec.js'
import { MANAGED_TEXT_ADAPTER_CONTRACT_VERSION, ManagedTextAdapterRegistry } from './adapter.js'
import type { ManagedTextAdapter } from './adapter.js'
import { createDesktopManagedDeployment } from './deployment.js'
import { ManagedLoadError, ManagedTextLifecycle } from './lifecycle.js'
import type { ManagedLoadRequest, ManagedTextLifecycleDeps } from './lifecycle.js'

const GiB = 1024 ** 3
const DIGEST = `sha256:${'b'.repeat(64)}` as const
const GPU = 'GPU-11111111-2222-3333-4444-555555555555'
const capabilities = {
  tools: false,
  reasoning: false,
  structured_output: false,
  vision: false,
  embeddings: false,
  responses: false,
}

/** Engine one: `/health`, no log markers, base + per-GiB timeout, reads CUDA OOM numbers out of its log. */
const alpha: ManagedTextAdapter<{ ctx: number }> = {
  id: 'alpha-engine',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/health', expectedStatus: 200 },
  stageMarkers: [],
  validateSettings: (raw) => {
    const ctx = (raw as { ctx?: unknown } | undefined)?.ctx ?? 4096
    if (typeof ctx !== 'number') throw new AtomicCoreError('INVALID_ARGUMENT', 'ctx must be a number')
    return { ctx }
  },
  buildLaunch: (c) => ({
    engine: { container_port: 8000 },
    argv: ['alpha-serve', c.modelPath, '--cache', c.engineCachePath, '--ctx', String(c.settings.ctx)],
    env: { ALPHA_MODE: 'fast' },
  }),
  readinessTimeoutMs: (weightBytes) => 30_000 + (weightBytes / GiB) * 10_000,
  classifyExit: (tail, exitCode) => {
    const oom = /CUDA out of memory\. Tried to allocate ([\d.]+) GiB/.exec(tail)
    if (oom) {
      return {
        kind: 'out-of-memory',
        message: `The GPU ran out of memory (tried to allocate ${oom[1]} GiB).`,
        numbers: { requested_gib: Number(oom[1]) },
      }
    }
    return { kind: 'other', message: `alpha exited with ${String(exitCode)}` }
  },
  capabilities: () => capabilities,
}

/** Engine two: `/v1/models`, a log marker for initializing-engine, a flat five-minute timeout. */
const beta: ManagedTextAdapter<Record<string, never>> = {
  id: 'beta-engine',
  contractVersion: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  readiness: { path: '/v1/models', expectedStatus: 200 },
  stageMarkers: [{ stage: 'initializing-engine', pattern: /Loading checkpoint shards/ }],
  validateSettings: () => ({}),
  buildLaunch: () => ({ engine: { container_port: 9000 }, argv: ['beta', 'serve'] }),
  readinessTimeoutMs: () => 5 * 60_000,
  classifyExit: (tail) =>
    /unsupported architecture/.test(tail)
      ? { kind: 'unsupported-model', message: 'beta cannot run this architecture.' }
      : { kind: 'other', message: 'beta exited' },
  capabilities: () => capabilities,
}

type Emitted = { name: keyof CoreEvents; payload: unknown }

let data: TmpDataFolder
let docker: FakeDocker
let clock: number
let emitted: Emitted[]
let journal: ExecutionJournal
let lifecycle: ManagedTextLifecycle
let tickers: Array<{ stopped: boolean }>
let readyAt: number | null
let onProbe: ((now: number) => void) | undefined
let probed: string[]
let allowedHosts: string[]
let modelDir: string

async function build(over: Partial<ManagedTextLifecycleDeps> = {}): Promise<ManagedTextLifecycle> {
  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(alpha)
  adapters.register(beta)
  let port = 41_000
  let generation = 0
  const fakeFetch = (async (url: string | URL | Request) => {
    const href = String(url)
    probed.push(href)
    onProbe?.(clock)
    return new Response('', { status: readyAt !== null && clock >= readyAt ? 200 : 503 })
  }) as typeof fetch
  lifecycle = new ManagedTextLifecycle({
    provider: 'llamacpp-upstream',
    adapters,
    exec: docker.exec,
    deployment: createDesktopManagedDeployment({ allocateHostPort: async () => port++ }),
    journal,
    paths: data.layout.managed,
    instanceId: 'core-1',
    scope: 'app',
    allowedHosts,
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
    startHeartbeat: (options: HeartbeatTickerOptions): HeartbeatTicker => {
      const ticker = startHeartbeatTicker({ ...options, intervalMs: 60_000 })
      const record = { stopped: false }
      tickers.push(record)
      return {
        ready: ticker.ready,
        stop: () => {
          record.stopped = true
          ticker.stop()
        },
      }
    },
    timings: { pollIntervalMs: 1_000, monitorIntervalMs: 1_000, heartbeatReadyTimeoutMs: 2_000 },
    ...over,
  })
  return lifecycle
}

function request_(over: Partial<ManagedLoadRequest> = {}): ManagedLoadRequest {
  return {
    modelId: 'org/model-a',
    modelPath: modelDir,
    weightBytes: 2 * GiB,
    installation: {
      descriptor_id: 'engine-1.0-r1',
      engine_id: 'alpha',
      adapter_id: 'alpha-engine',
      adapter_contract_version: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
      image: { repository: 'registry.example/alpha', digest: DIGEST },
    },
    family: null,
    gpuUuid: GPU,
    selinux: false,
    settings: {},
    ...over,
  }
}

const betaInstallation = {
  descriptor_id: 'beta-2.0-r1',
  engine_id: 'beta',
  adapter_id: 'beta-engine',
  adapter_contract_version: MANAGED_TEXT_ADAPTER_CONTRACT_VERSION,
  image: { repository: 'registry.example/beta', digest: DIGEST },
}

function progress(): CoreEvents['session:load-progress'][] {
  return emitted
    .filter((e) => e.name === 'session:load-progress')
    .map((e) => e.payload as CoreEvents['session:load-progress'])
}

/** `createContainer` mounts real paths (`/var` is `/private/var` on macOS), so expectations do too. */
const real = (path: string) => realpathSync(path)

async function rejection(promise: Promise<unknown>): Promise<AtomicCoreError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AtomicCoreError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

/** A raw GET to the gateway, with a Host header fetch would not let us set. */
function gatewayGet(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET', headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  data = await makeTmpDataFolder('managed-lifecycle-')
  modelDir = join(data.root, 'fake-engine', 'models', 'model-a')
  await mkdir(modelDir, { recursive: true })
  await writeFile(join(modelDir, 'config.json'), '{}')
  docker = new FakeDocker()
  clock = 0
  emitted = []
  tickers = []
  readyAt = 0
  onProbe = undefined
  probed = []
  allowedHosts = []
  journal = await ExecutionJournal.open(data.layout)
})

afterEach(async () => {
  await lifecycle?.shutdown()
  await data.cleanup()
})

describe('ManagedTextLifecycle: stages and timeout', () => {
  it('a long start does not fail before the timeout, and reports initializing-engine with growing elapsed time', async () => {
    await build()
    readyAt = 180_000 // three minutes; alpha's timeout for 30 GiB is 330 s
    const info = await lifecycle.load(request_({ weightBytes: 30 * GiB }))
    expect(info).toMatchObject({
      pid: null,
      execution: 'container',
      generation: 'gen-1',
      model_id: 'org/model-a',
    })

    const stages = progress()
    expect(stages[0]).toMatchObject({
      stage: 'starting-container',
      provider: 'llamacpp-upstream',
      generation: 'gen-1',
    })
    const initializing = stages.filter((p) => p.stage === 'initializing-engine')
    expect(initializing.length).toBeGreaterThan(100)
    const elapsed = initializing.map((p) => p.elapsed_ms)
    expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b))
    expect(elapsed[elapsed.length - 1]).toBeGreaterThanOrEqual(179_000)
    expect(stages[stages.length - 1]).toMatchObject({ stage: 'ready' })
    expect(probed.every((url) => url === 'http://127.0.0.1:41000/health')).toBe(true)
  })

  it('fails with MODEL_LOAD_TIMED_OUT at the adapter timeout, and a setting overrides it', async () => {
    await build()
    readyAt = null
    const timedOut = await rejection(lifecycle.load(request_({ weightBytes: 0 })))
    expect(timedOut.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(clock).toBeGreaterThanOrEqual(30_000)
    expect(clock).toBeLessThan(33_000)

    clock = 0
    const overridden = await rejection(lifecycle.load(request_({ weightBytes: 0, timeoutMs: 5_000 })))
    expect(overridden.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(clock).toBeLessThan(8_000)
    expect(docker.containers.size).toBe(0)
    expect(journal.list()).toEqual([])
  })

  it("stays in starting-container until the adapter's log marker shows up, for an engine that has markers", async () => {
    await build()
    readyAt = 20_000
    onProbe = (now) => {
      if (now === 8_000) docker.log(docker.last().id, 'Loading checkpoint shards: 1/4')
    }
    await lifecycle.load(request_({ installation: betaInstallation }))
    const stages = progress().map((p) => [p.stage, p.elapsed_ms] as const)
    const firstInit = stages.find(([stage]) => stage === 'initializing-engine')
    expect(firstInit?.[1]).toBeGreaterThanOrEqual(8_000)
    expect(
      stages.filter(([s, t]) => s === 'starting-container' && t > 0 && t < 8_000).length
    ).toBeGreaterThan(3)
    expect(probed.every((url) => url.endsWith('/v1/models'))).toBe(true)
  })

  it('runs the stopping-previous callback first, before any container exists', async () => {
    await build()
    const order: string[] = []
    await lifecycle.load(
      request_({
        stopPrevious: async () => {
          order.push(`stop-previous with ${docker.containers.size} containers`)
        },
      })
    )
    expect(order).toEqual(['stop-previous with 0 containers'])
    expect(progress().map((p) => p.stage)[0]).toBe('stopping-previous')
  })
})

describe('ManagedTextLifecycle: early exit', () => {
  it('a container exit fails within seconds with the classification, its numbers and the log tail', async () => {
    await build()
    readyAt = null
    let exitedAt = -1
    onProbe = (now) => {
      if (now === 20_000) {
        exitedAt = now
        docker.exit(docker.last().id, 1, [
          'loading weights',
          'CUDA out of memory. Tried to allocate 2.00 GiB',
        ])
      }
    }
    const error = await rejection(lifecycle.load(request_({ weightBytes: 30 * GiB })))
    expect(error).toBeInstanceOf(ManagedLoadError)
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.message).toContain('2.00 GiB')
    expect(error.details).toBe('loading weights\nCUDA out of memory. Tried to allocate 2.00 GiB\n')
    expect((error as ManagedLoadError).classification?.numbers).toEqual({ requested_gib: 2 })
    expect(clock - exitedAt).toBeLessThanOrEqual(2_000)
    expect(docker.containers.size).toBe(0)
    expect(journal.list()).toEqual([])
  })

  it("classifies with the engine's own adapter: the second engine maps its exit to MODEL_INCOMPATIBLE", async () => {
    await build()
    readyAt = null
    onProbe = (now) => {
      if (now === 3_000) docker.exit(docker.last().id, 2, ['unsupported architecture FooForCausalLM'])
    }
    const error = await rejection(lifecycle.load(request_({ installation: betaInstallation })))
    expect(error.code).toBe('MODEL_INCOMPATIBLE')
    expect(error.details).toContain('unsupported architecture')
  })

  it('keeps the last attempt logs after a failure, until the next load of that model', async () => {
    await build()
    readyAt = null
    onProbe = (now) => {
      if (now === 2_000) docker.exit(docker.last().id, 1, ['boom'])
    }
    await rejection(lifecycle.load(request_()))
    expect(lifecycle.lastAttempt('org/model-a')).toMatchObject({
      generation: 'gen-1',
      log_tail: 'boom\n',
      error: { code: 'MODEL_LOAD_FAILED' },
    })
    expect(await lifecycle.logs('org/model-a')).toBe('boom\n')
    expect(lifecycle.lastAttempt('other-model')).toBeUndefined()

    onProbe = undefined
    readyAt = 0
    await lifecycle.load(request_())
    expect(lifecycle.lastAttempt('org/model-a')).toBeUndefined()
  })
})

describe('ManagedTextLifecycle: container, cache, journal, heartbeat', () => {
  it('reuses the engine cache directory on the second load, contents kept', async () => {
    await build()
    await lifecycle.load(request_())
    const cacheDir = data.layout.managed.engineCacheDir('engine-1.0-r1', 'org/model-a')
    const mountOf = (argv: string[]) => argv.find((a) => a.endsWith(':/atomic/engine-cache:rw'))
    expect(mountOf(docker.last().createArgv)).toBe(`${real(cacheDir)}:/atomic/engine-cache:rw`)
    await writeFile(join(cacheDir, 'engine.plan'), 'built on first start')
    await lifecycle.unload('org/model-a')

    await lifecycle.load(request_())
    expect(mountOf(docker.last().createArgv)).toBe(`${real(cacheDir)}:/atomic/engine-cache:rw`)
    expect(await readFile(join(cacheDir, 'engine.plan'), 'utf8')).toBe('built on first start')
  })

  it('runs the engine under the watchdog as PID 1 with the heartbeat dir mounted and the model read-only', async () => {
    await build()
    await lifecycle.load(request_())
    const argv = docker.last().createArgv
    const script = data.layout.managed.watchdogScript
    expect((await stat(script)).mode & 0o777).toBe(0o555)
    expect(argv).toContain(`${real(script)}:/atomic/entrypoint.sh:ro`)
    expect(argv).toContain(`${real(data.layout.managed.heartbeatDir('gen-1'))}:/atomic/heartbeat:ro`)
    expect(argv).toContain(`${real(modelDir)}:/atomic/model:ro`)
    expect(argv.slice(argv.indexOf('--entrypoint'), argv.indexOf('--entrypoint') + 2)).toEqual([
      '--entrypoint',
      '/atomic/entrypoint.sh',
    ])
    expect(argv).toContain('ATOMIC_WATCHDOG_HEARTBEAT_FILE=/atomic/heartbeat/heartbeat')
    expect(argv).toContain('ALPHA_MODE=fast')
    expect(argv).not.toContain('--pid=host')
    const image = argv.indexOf(`registry.example/alpha@${DIGEST}`)
    expect(argv.slice(image + 1)).toEqual([
      '--',
      'alpha-serve',
      '/atomic/model',
      '--cache',
      '/atomic/engine-cache',
      '--ctx',
      '4096',
    ])
    expect(existsSync(join(data.layout.managed.heartbeatDir('gen-1'), 'heartbeat'))).toBe(true)
  })

  it('journals the container right after create and drops the record only after a confirmed stop and rm', async () => {
    await build()
    await lifecycle.load(request_())
    const id = docker.last().id
    expect(journal.list()).toEqual([
      expect.objectContaining({
        container_id: id,
        engine_id: 'alpha',
        image_digest: DIGEST,
        scope: 'app',
        instance_id: 'core-1',
      }),
    ])
    await lifecycle.unload('org/model-a')
    expect(journal.list()).toEqual([])
    expect(docker.subcommands().slice(-2)).toEqual(['stop', 'rm'])
  })

  it('stops the heartbeat ticker on unload and removes that generation’s heartbeat dir', async () => {
    await build()
    await lifecycle.load(request_())
    expect(tickers).toEqual([{ stopped: false }])
    await lifecycle.unload('org/model-a')
    expect(tickers).toEqual([{ stopped: true }])
    expect(existsSync(data.layout.managed.heartbeatDir('gen-1'))).toBe(false)
    expect(emitted.find((e) => e.name === 'session:unloaded')?.payload).toEqual({
      provider: 'llamacpp-upstream',
      model_id: 'org/model-a',
      pid: null,
    })
  })

  it('fails before any docker call when the first heartbeat never lands', async () => {
    await build({
      startHeartbeat: () => ({ ready: new Promise(() => {}), stop: () => {} }),
      timings: { heartbeatReadyTimeoutMs: 20 },
    })
    const error = await rejection(lifecycle.load(request_()))
    expect(error.code).toBe('IO_ERROR')
    expect(docker.calls).toEqual([])
  })

  it('retries on a new host port when docker start loses the bind race, and journals only the survivor', async () => {
    await build()
    docker.startFailures = [
      'Error response from daemon: Bind for 127.0.0.1:41000 failed: port is already allocated',
    ]
    await lifecycle.load(request_())
    expect(docker.containers.size).toBe(1)
    expect(docker.last().createArgv).toContain('127.0.0.1:41001:8000')
    expect(journal.list().map((r) => r.container_id)).toEqual([docker.last().id])
    expect(probed.every((url) => url.startsWith('http://127.0.0.1:41001/'))).toBe(true)
  })

  it('refuses an adapter this core does not have with MANAGED_ADAPTER_UNAVAILABLE, before touching docker', async () => {
    await build()
    const error = await rejection(
      lifecycle.load(request_({ installation: { ...betaInstallation, adapter_id: 'gamma-engine' } }))
    )
    expect(error.code).toBe('MANAGED_ADAPTER_UNAVAILABLE')
    expect(docker.calls).toEqual([])
  })

  it('refuses settings the adapter rejects, before touching docker', async () => {
    await build()
    const error = await rejection(lifecycle.load(request_({ settings: { ctx: 'big' } })))
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(docker.calls).toEqual([])
  })

  it('refuses to remove an engine cache a container is using', async () => {
    await build()
    await lifecycle.load(request_())
    expect((await rejection(lifecycle.removeEngineCaches({ modelId: 'org/model-a' }))).code).toBe(
      'MANAGED_RESOURCE_IN_USE'
    )
    await lifecycle.unload('org/model-a')
    expect(await lifecycle.removeEngineCaches({ modelId: 'org/model-a' })).toEqual([
      data.layout.managed.engineCacheDir('engine-1.0-r1', 'org/model-a'),
    ])
  })
})

describe('ManagedTextLifecycle: cancel and stop', () => {
  it('cancel stops and removes the container, publishes no session, and answers MODEL_LOAD_CANCELLED', async () => {
    await build()
    readyAt = null
    const controller = new AbortController()
    onProbe = (now) => {
      if (now === 3_000) controller.abort()
    }
    const error = await rejection(lifecycle.load(request_({ signal: controller.signal })))
    expect(error.code).toBe('MODEL_LOAD_CANCELLED')
    expect(docker.subcommands()).toContain('stop')
    expect(docker.containers.size).toBe(0)
    expect(lifecycle.list()).toEqual([])
    expect(journal.list()).toEqual([])
    expect(progress().some((p) => p.stage === 'ready')).toBe(false)
    expect(tickers.every((t) => t.stopped)).toBe(true)
  })

  it('a cancel during stopping-previous never creates a container', async () => {
    await build()
    const controller = new AbortController()
    const error = await rejection(
      lifecycle.load(
        request_({
          signal: controller.signal,
          stopPrevious: () => {
            controller.abort()
            return new Promise(() => {})
          },
        })
      )
    )
    expect(error.code).toBe('MODEL_LOAD_CANCELLED')
    expect(docker.calls).toEqual([])
  })

  it('unloading a model that is still loading cancels that load', async () => {
    await build()
    readyAt = null
    onProbe = (now) => {
      if (now === 2_000) void lifecycle.unload('org/model-a')
    }
    expect((await rejection(lifecycle.load(request_()))).code).toBe('MODEL_LOAD_CANCELLED')
    expect(docker.containers.size).toBe(0)
  })

  it('an unconfirmed stop answers MANAGED_STOP_UNCONFIRMED and keeps the reservation until a confirmed retry', async () => {
    await build()
    await lifecycle.load(request_())
    const id = docker.last().id
    docker.stopConfirms = false
    expect((await rejection(lifecycle.unload('org/model-a'))).code).toBe('MANAGED_STOP_UNCONFIRMED')
    expect(lifecycle.list()).toEqual([])
    expect(lifecycle.reservations()).toEqual([
      {
        model_id: 'org/model-a',
        generation: 'gen-1',
        gpu_uuid: GPU,
        container_id: id,
        state: 'stop-unconfirmed',
      },
    ])
    expect(journal.list().map((r) => r.container_id)).toEqual([id])
    expect((await rejection(lifecycle.load(request_()))).code).toBe('MANAGED_STOP_UNCONFIRMED')

    docker.stopConfirms = true
    await lifecycle.unload('org/model-a')
    expect(lifecycle.reservations()).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('a failed load whose cleanup stop is unconfirmed keeps the reservation too', async () => {
    await build()
    readyAt = null
    docker.stopConfirms = false
    const error = await rejection(lifecycle.load(request_({ timeoutMs: 3_000 })))
    expect(error.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(lifecycle.reservations()).toEqual([expect.objectContaining({ state: 'stop-unconfirmed' })])
  })
})

describe('ManagedTextLifecycle: session gateway', () => {
  it('rotates the gateway key per generation: the old key gets 401 from the new session', async () => {
    await build()
    const first = await lifecycle.load(request_())
    expect(first.port).not.toBe(41_000) // the gateway port, never the container's published one
    const key1 = first.api_key
    expect(await gatewayGet(first.port, { host: '127.0.0.1', authorization: `Bearer ${key1}` })).toBe(502)
    await lifecycle.unload('org/model-a')
    await expect(
      gatewayGet(first.port, { host: '127.0.0.1', authorization: `Bearer ${key1}` })
    ).rejects.toThrow()

    const second = await lifecycle.load(request_())
    expect(second.generation).toBe('gen-2')
    expect(second.api_key).not.toBe(key1)
    expect(await gatewayGet(second.port, { host: '127.0.0.1', authorization: `Bearer ${key1}` })).toBe(401)
    expect(
      await gatewayGet(second.port, { host: '127.0.0.1', authorization: `Bearer ${second.api_key}` })
    ).toBe(502)
  })

  it("follows the public server's live trusted-hosts array, not a copy taken at load", async () => {
    await build()
    const info = await lifecycle.load(request_())
    const auth = { authorization: `Bearer ${info.api_key}` }
    expect(await gatewayGet(info.port, { host: 'my-box.lan', ...auth })).toBe(403)
    allowedHosts.push('my-box.lan')
    expect(await gatewayGet(info.port, { host: 'my-box.lan', ...auth })).toBe(502)
  })

  it('answers a second load of a loaded model with the same session', async () => {
    await build()
    const first = await lifecycle.load(request_())
    expect(await lifecycle.load(request_())).toBe(first)
    expect(lifecycle.findSession('org/model-a')).toBe(first)
    expect(lifecycle.isLoading('org/model-a')).toBe(false)
  })
})

describe('ManagedTextLifecycle: crash after ready', () => {
  it('reports session:died with a null pid, closes the gateway, stops the heartbeat and keeps the log tail', async () => {
    await build()
    const info = await lifecycle.load(request_())
    const id = docker.last().id
    docker.exit(id, 1, ['CUDA out of memory. Tried to allocate 1.00 GiB'])
    for (let i = 0; i < 500 && !emitted.some((e) => e.name === 'session:died'); i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(emitted.find((e) => e.name === 'session:died')?.payload).toEqual({
      provider: 'llamacpp-upstream',
      pid: null,
      model_id: 'org/model-a',
      exit_code: 1,
      signal: null,
      message: 'The GPU ran out of memory (tried to allocate 1.00 GiB).',
    })
    expect(lifecycle.list()).toEqual([])
    expect(tickers[0]?.stopped).toBe(true)
    expect(journal.list()).toEqual([])
    expect(await lifecycle.logs('org/model-a')).toContain('CUDA out of memory')
    await expect(gatewayGet(info.port, { host: '127.0.0.1' })).rejects.toThrow()
  })
})
